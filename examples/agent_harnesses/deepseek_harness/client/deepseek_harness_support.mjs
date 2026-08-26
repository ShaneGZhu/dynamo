// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Shared relay, redaction, process-tree, and lifecycle support for the persistent DSH ACP client. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { constants as osConstants } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

const CHILD_ENV_ALLOWLIST = [
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NO_COLOR',
  'PATH',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TERM',
  'TMP',
  'TMPDIR',
  'TEMP',
  'TZ',
]
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export function normalizeBaseUrl(value) {
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('--base-url must use HTTP(S)')
  parsed.search = ''
  parsed.hash = ''
  const pathname = parsed.pathname.replace(/\/+$/, '')
  parsed.pathname = pathname.endsWith('/v1') ? pathname : `${pathname}/v1`
  return parsed
}

function hashValue(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function redactedHeaders(headers) {
  const output = {}
  for (const [name, rawValue] of Object.entries(headers)) {
    const value = Array.isArray(rawValue) ? rawValue.join(', ') : rawValue
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (lower === 'authorization' || lower === 'x-api-key') output[lower] = '<redacted>'
    else if (lower === 'x-deepseek-harness-user-id') output[lower] = hashValue(value)
    else if (lower.startsWith('x-deepseek-harness-') || ['content-type', 'user-agent'].includes(lower)) output[lower] = value
  }
  return output
}

function parseBody(body) {
  if (body.length === 0) return null
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return { encoding: 'base64', data: body.toString('base64') }
  }
}

export function evidenceWriter(path, overwrite) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '', { flag: overwrite ? 'w' : 'wx', mode: 0o600 })
  return value => appendFileSync(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...value })}\n`)
}

function readRequest(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => resolveBody(Buffer.concat(chunks)))
    request.on('error', rejectBody)
  })
}

function forwardHeaders(headers, canonicalizeDynamoHeaders) {
  const output = new Headers()
  for (const [name, rawValue] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || rawValue === undefined) continue
    output.set(name, Array.isArray(rawValue) ? rawValue.join(', ') : rawValue)
  }
  if (canonicalizeDynamoHeaders) {
    const sessionId = headers['x-deepseek-harness-session-id']
    if (typeof sessionId === 'string' && sessionId.trim() !== '') output.set('x-dynamo-session-id', sessionId)
  }
  return output
}

function responseHeaders(headers) {
  const output = {}
  for (const [name, value] of headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) output[name] = value
  }
  return output
}

async function relayBody(upstream, downstream) {
  if (upstream.body === null) {
    downstream.end()
    return
  }
  const reader = upstream.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!downstream.write(value)) await new Promise(resolveDrain => downstream.once('drain', resolveDrain))
    }
  } finally {
    reader.releaseLock()
  }
  downstream.end()
}

export async function startRelay({ baseUrl, canonicalizeDynamoHeaders, record }) {
  const upstreamOrigin = baseUrl.origin
  const sessions = new Set()
  const controllers = new Set()
  const server = createServer((request, response) => {
    const controller = new AbortController()
    controllers.add(controller)
    void (async () => {
      const body = await readRequest(request)
      const sessionId = request.headers['x-deepseek-harness-session-id']
      if (typeof sessionId === 'string') sessions.add(sessionId)
      record({
        kind: 'request',
        method: request.method,
        path: request.url,
        headers: redactedHeaders(request.headers),
        body: parseBody(body),
      })
      const target = new URL(request.url ?? '/', upstreamOrigin)
      const upstream = await fetch(target, {
        method: request.method,
        headers: forwardHeaders(request.headers, canonicalizeDynamoHeaders),
        body: ['GET', 'HEAD'].includes(request.method ?? '') ? undefined : body,
        redirect: 'manual',
        signal: controller.signal,
      })
      record({ kind: 'response', path: request.url, status: upstream.status })
      response.writeHead(upstream.status, responseHeaders(upstream.headers))
      await relayBody(upstream, response)
    })().catch(error => {
      record({ kind: 'relay_error', path: request.url, error: error instanceof Error ? error.message : String(error) })
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'Dynamo relay failed' }))
    }).finally(() => controllers.delete(controller))
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('relay did not bind a TCP port')
  const proxyBaseUrl = new URL(baseUrl.pathname, `http://127.0.0.1:${address.port}`)
  return {
    abortRequests: () => { for (const controller of controllers) controller.abort() },
    close: () => new Promise(resolveClose => server.close(resolveClose)),
    proxyBaseUrl,
    sessions,
  }
}

export function childEnvironment({ apiKey, home, proxyBaseUrl }) {
  const environment = {}
  for (const name of CHILD_ENV_ALLOWLIST) {
    if (process.env[name] !== undefined) environment[name] = process.env[name]
  }
  return {
    ...environment,
    CI: '1',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    DEEPSEEK_API_KEY: apiKey,
    DEEPSEEK_BASE_URL: proxyBaseUrl.toString().replace(/\/$/, ''),
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    HOME: home,
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
  }
}

export function signalExitCode(signal) {
  const number = osConstants.signals[signal]
  return typeof number === 'number' ? 128 + number : 1
}

function processTable() {
  if (process.platform === 'linux' && existsSync('/proc')) {
    const rows = []
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
        const commandEnd = stat.lastIndexOf(')')
        const fields = stat.slice(commandEnd + 2).trim().split(/\s+/)
        const pid = Number(name)
        const parent = Number(fields[1])
        const session = Number(fields[3])
        if (Number.isSafeInteger(pid) && Number.isSafeInteger(parent) && Number.isSafeInteger(session)) rows.push({ parent, pid, session })
      } catch {
        // Processes can exit while /proc is being scanned.
      }
    }
    return rows
  }
  try {
    const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,sess='], { encoding: 'utf8' })
    return output.trim().split('\n').flatMap(row => {
      const [pidText, parentText, sessionText] = row.trim().split(/\s+/)
      const pid = Number(pidText)
      const parent = Number(parentText)
      const session = Number(sessionText)
      return Number.isSafeInteger(pid) && Number.isSafeInteger(parent) && Number.isSafeInteger(session)
        ? [{ parent, pid, session }]
        : []
    })
  } catch {
    return []
  }
}

function descendantProcessIds(rootProcessIds, sessionId) {
  const children = new Map()
  const sameSession = []
  for (const { parent, pid, session } of processTable()) {
    const values = children.get(parent) ?? []
    values.push(pid)
    children.set(parent, values)
    if (session === sessionId && pid !== sessionId) sameSession.push(pid)
  }
  const descendants = [...sameSession]
  const visited = new Set(rootProcessIds)
  for (const pid of sameSession) visited.add(pid)
  const pending = [...rootProcessIds, ...sameSession]
  while (pending.length > 0) {
    const parent = pending.pop()
    for (const pid of children.get(parent) ?? []) {
      if (visited.has(pid)) continue
      visited.add(pid)
      descendants.push(pid)
      pending.push(pid)
    }
  }
  return descendants
}

function processIdIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return true
    throw error
  }
}

export function assertProcessTreeSupport() {
  if (process.platform === 'win32') throw new Error('the DSH relay requires POSIX process-tree signaling')
  if (process.platform === 'linux' && existsSync('/proc/self/stat')) return
  if (!existsSync('/bin/ps')) throw new Error('the DSH relay requires /bin/ps from procps or the host operating system')
  try {
    execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,sess='], { stdio: 'ignore' })
  } catch {
    throw new Error('/bin/ps must support the pid, ppid, and sess output fields')
  }
}

export function trackChildTree(child, trackedProcessIds) {
  if (child === null || child.pid === undefined) return
  trackedProcessIds.add(child.pid)
  for (const pid of descendantProcessIds(trackedProcessIds, child.pid)) trackedProcessIds.add(pid)
}

export function signalChildTree(child, signal, trackedProcessIds) {
  if (child === null || child.pid === undefined) return
  trackChildTree(child, trackedProcessIds)
  if (process.platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  } else {
    for (const pid of [...trackedProcessIds].sort((left, right) => right - left)) {
      try {
        process.kill(pid, signal)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && ['EPERM', 'ESRCH'].includes(error.code))) throw error
      }
    }
  }
}

function childTreeIsAlive(child, trackedProcessIds) {
  if (child === null || child.pid === undefined) return false
  if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null
  return [...trackedProcessIds].some(processIdIsAlive)
}

export async function waitForChildTreeExit(child, trackedProcessIds, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (childTreeIsAlive(child, trackedProcessIds)) {
    if (Date.now() >= deadline) return false
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  return true
}

export async function sendSessionFinal({ apiKey, baseUrl, model, record, sessionId, timeoutMs }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const endpoint = new URL(`${baseUrl.pathname.replace(/\/$/, '')}/chat/completions`, baseUrl.origin)
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'x-dynamo-session-final': 'true',
        'x-dynamo-session-id': sessionId,
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: '.' }], max_tokens: 1, stream: false }),
      signal: controller.signal,
    })
    const text = await response.text()
    record({ kind: 'session_final', session_id: sessionId, status: response.status })
    if (!response.ok) throw new Error(`session final for ${sessionId} returned ${response.status}: ${text.slice(0, 300)}`)
  } finally {
    clearTimeout(timeout)
  }
}
