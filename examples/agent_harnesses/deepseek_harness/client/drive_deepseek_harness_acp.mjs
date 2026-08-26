#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Drive repeated prompts through one published DeepSeek Harness ACP session. */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk'

import {
  assertProcessTreeSupport,
  childEnvironment,
  evidenceWriter,
  normalizeBaseUrl,
  sendSessionFinal,
  signalChildTree,
  signalExitCode,
  startRelay,
  trackChildTree,
  waitForChildTreeExit,
} from './deepseek_harness_support.mjs'

const DEFAULT_ACP_BIN = fileURLToPath(new URL('./run_deepseek_harness_acp_server.mjs', import.meta.url))
const PUBLISHED_PLUGINS = Object.fromEntries([
  '@deepseek-ai/dsh-acp-demo',
  '@deepseek-ai/dsh-bash-sandbox',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-fs-observation-policy',
  '@deepseek-ai/dsh-fs-sandbox',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-user-approval',
].map(name => [name, import.meta.resolve(name)]))

function publishedPlugin(name) {
  const resolved = PUBLISHED_PLUGINS[name]
  if (resolved === undefined) throw new Error(`unfrozen DSH plugin requested: ${name}`)
  return resolved
}

function usage() {
  return `Usage: drive_deepseek_harness_acp.mjs --base-url URL --model MODEL --prompt TEXT --prompt TEXT [options]

Options:
  --acp-bin PATH             ACP app launcher (default: Dynamo EOF wrapper)
  --api-key-env NAME         Explicit credential env var (default: DYNAMO_API_KEY)
  --canonicalize-dynamo-headers
                             Also send canonical identity headers to older Dynamo
  --capture PATH             Redacted JSONL evidence (default: dsh-acp-request-trace.jsonl)
  --context-window N         Served model context capacity (default: 32768)
  --cwd PATH                 ACP session workspace (default: current directory)
  --dsh-home PATH            Empty persistent DSH home (default: removed temporary directory)
  --final-timeout-ms N       ThunderAgent terminal request timeout (default: 5000)
  --max-tokens N             DSH output limit (default: 4096)
  --overwrite-capture        Replace an existing capture file
  --permission-mode MODE     Wider tool retries: reject or allow (default: reject)
  --prompt TEXT              Ordered prompt; repeat at least twice
  --prompt-timeout-ms N      Per-prompt timeout (default: 120000)
  --session-final            Drain observed sessions through ThunderAgent on exit
  --shutdown-timeout-ms N    Grace for ACP EOF, SIGTERM, and relay drain (default: 5000)
  --startup-timeout-ms N     ACP initialize/session timeout (default: 30000)
  --help                     Show this help
`
}

function valueAfter(argv, index, name) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

export function parseArgs(argv) {
  const options = {
    acpBin: DEFAULT_ACP_BIN,
    apiKeyEnv: 'DYNAMO_API_KEY',
    apiKeyEnvExplicit: false,
    baseUrl: undefined,
    canonicalizeDynamoHeaders: false,
    capture: resolve('dsh-acp-request-trace.jsonl'),
    contextWindow: 32_768,
    cwd: process.cwd(),
    dshHome: undefined,
    finalTimeoutMs: 5_000,
    maxTokens: 4_096,
    model: undefined,
    overwriteCapture: false,
    permissionMode: 'reject',
    prompts: [],
    promptTimeoutMs: 120_000,
    sessionFinal: false,
    shutdownTimeoutMs: 5_000,
    startupTimeoutMs: 30_000,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help') return { ...options, help: true }
    if (argument === '--canonicalize-dynamo-headers' || argument === '--overwrite-capture' || argument === '--session-final') {
      if (argument === '--canonicalize-dynamo-headers') options.canonicalizeDynamoHeaders = true
      if (argument === '--overwrite-capture') options.overwriteCapture = true
      if (argument === '--session-final') options.sessionFinal = true
      continue
    }
    const value = valueAfter(argv, index, argument)
    index += 1
    switch (argument) {
      case '--acp-bin': options.acpBin = resolve(value); break
      case '--api-key-env': options.apiKeyEnv = value; options.apiKeyEnvExplicit = true; break
      case '--base-url': options.baseUrl = value; break
      case '--capture': options.capture = resolve(value); break
      case '--context-window': options.contextWindow = Number(value); break
      case '--cwd': options.cwd = resolve(value); break
      case '--dsh-home': options.dshHome = resolve(value); break
      case '--final-timeout-ms': options.finalTimeoutMs = Number(value); break
      case '--max-tokens': options.maxTokens = Number(value); break
      case '--model': options.model = value; break
      case '--permission-mode': options.permissionMode = value; break
      case '--prompt': options.prompts.push(value); break
      case '--prompt-timeout-ms': options.promptTimeoutMs = Number(value); break
      case '--shutdown-timeout-ms': options.shutdownTimeoutMs = Number(value); break
      case '--startup-timeout-ms': options.startupTimeoutMs = Number(value); break
      default: throw new Error(`unknown argument: ${argument}`)
    }
  }
  if (!options.baseUrl) throw new Error('--base-url is required')
  if (!options.model?.trim()) throw new Error('--model is required')
  if (options.prompts.length < 2 || options.prompts.some(prompt => !prompt.trim())) throw new Error('repeat --prompt at least twice with non-empty text')
  if (!['allow', 'reject'].includes(options.permissionMode)) throw new Error('--permission-mode must be allow or reject')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.apiKeyEnv)) throw new Error('--api-key-env must be an environment variable name')
  for (const [name, value] of [
    ['--context-window', options.contextWindow],
    ['--final-timeout-ms', options.finalTimeoutMs],
    ['--max-tokens', options.maxTokens],
    ['--prompt-timeout-ms', options.promptTimeoutMs],
    ['--shutdown-timeout-ms', options.shutdownTimeoutMs],
    ['--startup-timeout-ms', options.startupTimeoutMs],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  }
  if (!existsSync(options.acpBin) || !statSync(options.acpBin).isFile()) throw new Error(`--acp-bin is not a file: ${options.acpBin}`)
  if (!existsSync(options.cwd) || !statSync(options.cwd).isDirectory()) throw new Error(`--cwd is not a directory: ${options.cwd}`)
  return options
}

function persistentComposition(options, proxyBaseUrl, home) {
  return [
    {
      id: 'llm-deepseek',
      name: publishedPlugin('@deepseek-ai/dsh-llm-deepseek'),
      config: {
        baseURL: proxyBaseUrl.toString().replace(/\/$/, ''),
        thinking: 'disabled',
        maxTokens: options.maxTokens,
        models: [{ id: options.model, name: options.model, contextWindow: options.contextWindow, maxTokens: options.maxTokens }],
      },
    },
    { id: 'sandbox', name: publishedPlugin('@deepseek-ai/dsh-sandbox-local') },
    {
      id: 'sandbox-policy',
      name: publishedPlugin('@deepseek-ai/dsh-sandbox-policy'),
      config: { mode: 'workspace-write', workspaceRoot: options.cwd },
    },
    { id: 'subprocess', name: publishedPlugin('@deepseek-ai/dsh-subprocess-local') },
    { id: 'bash', name: publishedPlugin('@deepseek-ai/dsh-bash-sandbox'), config: { timeoutMs: options.promptTimeoutMs } },
    { id: 'approval', name: publishedPlugin('@deepseek-ai/dsh-user-approval'), config: { policy: 'ask' } },
    {
      id: 'acp-agent',
      name: publishedPlugin('@deepseek-ai/dsh-acp-demo'),
      config: {
        provider: 'deepseek-official',
        model: options.model,
        dshHome: home,
        persistenceRoot: join(home, 'sessions'),
        persistenceCompression: 'none',
        workspaceContext: { maxBytes: 65_536 },
        persona: 'You are a coding assistant powered by {{model}}. Work only inside {{cwd}}. Verify results and answer briefly.',
      },
    },
    { id: 'token-meter', name: publishedPlugin('@deepseek-ai/dsh-token-meter') },
    {
      id: 'compaction-basic',
      name: publishedPlugin('@deepseek-ai/dsh-compaction-basic'),
      config: { thresholdRatio: 0.8, retainRatio: 0.08, maxTokens: Math.min(options.maxTokens, 8_192), compactionRetries: 1 },
    },
    { id: 'fs-sandbox', name: publishedPlugin('@deepseek-ai/dsh-fs-sandbox'), config: { cwd: options.cwd } },
    { id: 'fs-observation-policy', name: publishedPlugin('@deepseek-ai/dsh-fs-observation-policy') },
    { id: 'tool-fs', name: publishedPlugin('@deepseek-ai/dsh-tool-fs') },
  ]
}

function preparePersistentHome(options, proxyBaseUrl) {
  const temporary = options.dshHome === undefined
  const home = options.dshHome ?? mkdtempSync(join(tmpdir(), 'dsh-dynamo-acp-'))
  if (!temporary) {
    if (existsSync(home) && readdirSync(home).length > 0) throw new Error(`--dsh-home must be empty: ${home}`)
    mkdirSync(home, { recursive: true })
  }
  const configPath = join(home, 'cordis.yml')
  writeFileSync(configPath, `${JSON.stringify(persistentComposition(options, proxyBaseUrl, home), null, 2)}\n`, { mode: 0o600 })
  return { configPath, home, temporary }
}

class DeadlineError extends Error {}
class HostSignalError extends Error {
  constructor(signal) {
    super(`received ${signal}`)
    this.signal = signal
  }
}

function controlledWait(promise, timeoutMs, label, abortSignal) {
  return new Promise((resolveWait, rejectWait) => {
    let settled = false
    const finish = callback => value => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      abortSignal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => finish(rejectWait)(abortSignal.reason ?? new Error(`${label} aborted`))
    const timeout = setTimeout(() => finish(rejectWait)(new DeadlineError(`${label} exceeded ${timeoutMs}ms`)), timeoutMs)
    if (abortSignal?.aborted) {
      onAbort()
      return
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true })
    promise.then(finish(resolveWait), finish(rejectWait))
  })
}

function settleWithin(promise, timeoutMs) {
  return new Promise(resolveWait => {
    const timeout = setTimeout(() => resolveWait({ settled: false }), timeoutMs)
    promise.then(
      value => { clearTimeout(timeout); resolveWait({ settled: true, value }) },
      error => { clearTimeout(timeout); resolveWait({ error, settled: true }) },
    )
  })
}

class PersistentAcpClient {
  constructor(permissionMode, record) {
    this.permissionMode = permissionMode
    this.record = record
    this.active = null
    this.protocolError = null
  }

  beginTurn(sessionId, index) {
    this.active = { index, sessionId, text: [], images: 0, toolCalls: 0 }
  }

  endTurn() {
    const result = this.active
    this.active = null
    return result
  }

  async requestPermission(params) {
    const wanted = this.permissionMode === 'allow' ? 'allow_once' : 'reject_once'
    const selected = params.options.find(option => option.kind === wanted)
    this.record({
      kind: 'acp_permission',
      session_id: params.sessionId,
      decision: selected === undefined ? 'cancelled' : wanted,
      tool_call_id: params.toolCall.toolCallId,
    })
    return selected === undefined
      ? { outcome: { outcome: 'cancelled' } }
      : { outcome: { outcome: 'selected', optionId: selected.optionId } }
  }

  async sessionUpdate(params) {
    if (this.active === null || params.sessionId !== this.active.sessionId) {
      this.protocolError = new Error(`unexpected session/update for ${params.sessionId}`)
      return
    }
    const update = params.update
    if (update.sessionUpdate === 'agent_message_chunk') {
      if (update.content.type === 'text') this.active.text.push(update.content.text)
      else if (update.content.type === 'image') this.active.images += 1
    } else if (update.sessionUpdate === 'tool_call') {
      this.active.toolCalls += 1
    }
  }
}

function spawnAcpServer(options, preparedHome, environment) {
  const child = spawn(process.execPath, [options.acpBin, '--config', preparedHome.configPath], {
    cwd: options.cwd,
    detached: process.platform !== 'win32',
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.pipe(process.stderr, { end: false })
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('close', (code, signal) => resolveExit({ code, signal }))
  })
  return { child, exit }
}

async function stopAcpServer({ child, exit, record, timeoutMs, trackedProcessIds }) {
  trackChildTree(child, trackedProcessIds)
  child.stdin.end()
  let outcome = await settleWithin(exit, timeoutMs)
  let treeStopped = await waitForChildTreeExit(child, trackedProcessIds, timeoutMs)
  let forced = false
  if (!outcome.settled || !treeStopped) {
    forced = true
    record({ kind: 'acp_shutdown_signal', signal: 'SIGTERM', tracked_processes: trackedProcessIds.size })
    signalChildTree(child, 'SIGTERM', trackedProcessIds)
    outcome = await settleWithin(exit, timeoutMs)
    treeStopped = await waitForChildTreeExit(child, trackedProcessIds, timeoutMs)
  }
  if (!outcome.settled || !treeStopped) {
    record({ kind: 'acp_shutdown_signal', signal: 'SIGKILL', tracked_processes: trackedProcessIds.size })
    signalChildTree(child, 'SIGKILL', trackedProcessIds)
    outcome = await settleWithin(exit, timeoutMs)
    treeStopped = await waitForChildTreeExit(child, trackedProcessIds, timeoutMs)
  }
  if (!outcome.settled || !treeStopped) throw new Error('ACP process tree remained after SIGKILL grace period')
  if (outcome.error !== undefined) throw outcome.error
  return { ...outcome.value, forced }
}

export async function run(options) {
  assertProcessTreeSupport()
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const record = evidenceWriter(options.capture, options.overwriteCapture)
  const relay = await startRelay({ baseUrl, canonicalizeDynamoHeaders: options.canonicalizeDynamoHeaders, record })
  let preparedHome
  try {
    preparedHome = preparePersistentHome(options, relay.proxyBaseUrl)
  } catch (error) {
    await relay.close()
    throw error
  }
  const selectedApiKey = process.env[options.apiKeyEnv]
  if (options.apiKeyEnvExplicit && selectedApiKey === undefined) {
    await relay.close()
    if (preparedHome.temporary) rmSync(preparedHome.home, { force: true, recursive: true })
    throw new Error(`selected credential environment variable is unset: ${options.apiKeyEnv}`)
  }
  const apiKey = selectedApiKey ?? 'dummy'
  const environment = {
    ...childEnvironment({ apiKey, home: preparedHome.home, proxyBaseUrl: relay.proxyBaseUrl }),
    DSH_PERMISSION_MODE: 'workspace-write',
  }
  record({
    kind: 'run_start',
    acp_app: '@deepseek-ai/dsh-acp-demo@0.1.0-rc.8',
    acp_protocol: '@deepseek-ai/dsh-acp@0.1.0-rc.8',
    acp_sdk: '@agentclientprotocol/sdk@0.25.1',
    api_key_env: options.apiKeyEnv,
    canonicalize_dynamo_headers: options.canonicalizeDynamoHeaders,
    model: options.model,
    prompt_count: options.prompts.length,
    session_final: options.sessionFinal,
    upstream: baseUrl.toString().replace(/\/$/, ''),
  })

  const { child, exit } = spawnAcpServer(options, preparedHome, environment)
  const trackedProcessIds = new Set()
  const abortController = new AbortController()
  const handlers = new Map()
  let receivedSignal = null
  let connection = null
  let sessionId = null
  let promptInFlight = false
  let operationError = null
  let shutdown = { code: null, forced: false, signal: null }
  let finalFailed = false

  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      if (receivedSignal !== null) return
      receivedSignal = signal
      relay.abortRequests()
      abortController.abort(new HostSignalError(signal))
      if (connection !== null && sessionId !== null && promptInFlight) {
        void connection.cancel({ sessionId }).catch(error => record({ kind: 'acp_cancel_error', error: String(error) }))
      }
    }
    handlers.set(signal, handler)
    process.on(signal, handler)
  }

  try {
    const client = new PersistentAcpClient(options.permissionMode, record)
    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
    connection = new ClientSideConnection(() => client, stream)
    const initialized = await controlledWait(connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'dynamo-deepseek-harness-acp-host', version: '0.1.0' },
    }), options.startupTimeoutMs, 'ACP initialize', abortController.signal)
    const session = await controlledWait(connection.newSession({ cwd: options.cwd, mcpServers: [] }), options.startupTimeoutMs, 'ACP session/new', abortController.signal)
    sessionId = session.sessionId
    record({ kind: 'acp_ready', protocol_version: initialized.protocolVersion, session_id: sessionId })
    process.stdout.write(`${JSON.stringify({ kind: 'ready', protocol_version: initialized.protocolVersion, session_id: sessionId })}\n`)

    for (const [index, prompt] of options.prompts.entries()) {
      client.beginTurn(sessionId, index)
      promptInFlight = true
      const promptPromise = connection.prompt({ sessionId, prompt: [{ type: 'text', text: prompt }] })
      let response
      try {
        response = await controlledWait(promptPromise, options.promptTimeoutMs, `ACP session/prompt ${index + 1}`, abortController.signal)
      } catch (error) {
        await connection.cancel({ sessionId }).catch(cancelError => record({ kind: 'acp_cancel_error', error: String(cancelError) }))
        await settleWithin(promptPromise, Math.min(options.shutdownTimeoutMs, 1_000))
        throw error
      } finally {
        promptInFlight = false
      }
      if (client.protocolError !== null) throw client.protocolError
      const turn = client.endTurn()
      const result = {
        kind: 'turn',
        index: index + 1,
        session_id: sessionId,
        stop_reason: response.stopReason,
        text: turn.text.join(''),
        images: turn.images,
        tool_calls: turn.toolCalls,
      }
      record({ ...result, text: undefined, text_bytes: Buffer.byteLength(result.text) })
      process.stdout.write(`${JSON.stringify(result)}\n`)
    }
  } catch (error) {
    operationError = error
    record({ kind: 'acp_error', error: error instanceof Error ? error.message : String(error) })
  } finally {
    try {
      shutdown = await stopAcpServer({ child, exit, record, timeoutMs: options.shutdownTimeoutMs, trackedProcessIds })
    } catch (error) {
      operationError ??= error
      record({ kind: 'acp_shutdown_error', error: error instanceof Error ? error.message : String(error) })
    }
    relay.abortRequests()
    try {
      await controlledWait(relay.close(), options.shutdownTimeoutMs, 'relay shutdown')
    } catch (error) {
      operationError ??= error
      record({ kind: 'relay_shutdown_error', error: error instanceof Error ? error.message : String(error) })
    }
    if (options.sessionFinal) {
      const sessionIds = [...relay.sessions].sort()
      if (sessionIds.length === 0) {
        finalFailed = true
        record({ kind: 'session_final_error', error: 'session final requested but zero DSH sessions reached Dynamo' })
      }
      for (const nativeSessionId of sessionIds) {
        try {
          await sendSessionFinal({ apiKey, baseUrl, model: options.model, record, sessionId: nativeSessionId, timeoutMs: options.finalTimeoutMs })
        } catch (error) {
          finalFailed = true
          record({ kind: 'session_final_error', session_id: nativeSessionId, error: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    for (const [signal, handler] of handlers) process.off(signal, handler)
    if (preparedHome.temporary) rmSync(preparedHome.home, { force: true, recursive: true })
  }

  const cleanChildExit = shutdown.code === 0 && shutdown.signal === null && !shutdown.forced
  record({
    kind: 'run_end',
    acp_session_id: sessionId,
    child_code: shutdown.code,
    child_signal: shutdown.signal,
    final_failed: finalFailed,
    forced_shutdown: shutdown.forced,
    received_signal: receivedSignal,
  })
  if (receivedSignal !== null) return signalExitCode(receivedSignal)
  if (operationError !== null) {
    console.error(`persistent DSH ACP host: ${operationError instanceof Error ? operationError.message : String(operationError)}`)
    return 1
  }
  if (finalFailed) return 1
  if (!cleanChildExit) {
    console.error(`persistent DSH ACP host: ACP child did not shut down cleanly (code=${shutdown.code}, signal=${shutdown.signal}, forced=${shutdown.forced})`)
    return 1
  }
  process.stdout.write(`${JSON.stringify({ kind: 'closed', session_id: sessionId, native_session_ids: [...relay.sessions].sort() })}\n`)
  return 0
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv)
    if (options.help) {
      process.stdout.write(usage())
      return 0
    }
    return await run(options)
  } catch (error) {
    console.error(`drive_deepseek_harness_acp: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main()
}
