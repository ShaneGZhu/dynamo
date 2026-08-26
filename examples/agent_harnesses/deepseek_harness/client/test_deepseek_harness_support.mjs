// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, test } from 'node:test'

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

const temporaryDirectories = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-dynamo-support-test-'))
  temporaryDirectories.push(directory)
  return directory
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }
}

test('normalizes Dynamo endpoints and builds an isolated DSH environment', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8000').toString(), 'http://127.0.0.1:8000/v1')
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8000/v1/').toString(), 'http://127.0.0.1:8000/v1')
  assert.throws(() => normalizeBaseUrl('file:///tmp/socket'), /must use HTTP\(S\)/)

  const environment = childEnvironment({
    apiKey: 'selected-secret',
    home: '/tmp/isolated-dsh-home',
    proxyBaseUrl: new URL('http://127.0.0.1:9000/v1'),
  })
  assert.equal(environment.DEEPSEEK_API_KEY, 'selected-secret')
  assert.equal(environment.DEEPSEEK_BASE_URL, 'http://127.0.0.1:9000/v1')
  assert.equal(environment.HOME, '/tmp/isolated-dsh-home')
  assert.equal(environment.DYNAMO_API_KEY, undefined)
  assert.equal(environment.COREPACK_HOME, undefined)
})

test('writes owner-only evidence and requires explicit overwrite', () => {
  const capture = join(temporaryDirectory(), 'nested', 'capture.jsonl')
  const record = evidenceWriter(capture, false)
  record({ kind: 'first' })
  assert.equal(statSync(capture).mode & 0o777, 0o600)
  assert.match(readFileSync(capture, 'utf8'), /"kind":"first"/)
  assert.throws(() => evidenceWriter(capture, false), /EEXIST/)
  evidenceWriter(capture, true)({ kind: 'replacement' })
  assert.doesNotMatch(readFileSync(capture, 'utf8'), /"kind":"first"/)
})

test('relays native metadata while redacting the local trace', async () => {
  const upstreamRequests = []
  const upstream = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      upstreamRequests.push({ body: Buffer.concat(chunks).toString('utf8'), headers: request.headers })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    })
  })
  await new Promise(resolveListen => upstream.listen(0, '127.0.0.1', resolveListen))
  const address = upstream.address()
  const records = []
  const relay = await startRelay({
    baseUrl: new URL(`http://127.0.0.1:${address.port}/v1`),
    canonicalizeDynamoHeaders: true,
    record: value => records.push(value),
  })
  try {
    const response = await fetch(new URL('chat/completions', `${relay.proxyBaseUrl.toString().replace(/\/$/, '')}/`), {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
        'x-deepseek-harness-compact': '1',
        'x-deepseek-harness-session-id': 'native-session',
        'x-deepseek-harness-user-id': 'stable-user',
      },
      body: '{"model":"test-model"}',
    })
    assert.equal(response.status, 200)
    await response.text()
    assert.equal(upstreamRequests[0].headers.authorization, 'Bearer secret')
    assert.equal(upstreamRequests[0].headers['x-dynamo-session-id'], 'native-session')
    assert.deepEqual([...relay.sessions], ['native-session'])
    const requestRecord = records.find(record => record.kind === 'request')
    assert.equal(requestRecord.headers.authorization, '<redacted>')
    assert.match(requestRecord.headers['x-deepseek-harness-user-id'], /^sha256:/)
    assert.equal(requestRecord.headers['x-deepseek-harness-compact'], '1')
  } finally {
    relay.abortRequests()
    await relay.close()
    await new Promise(resolveClose => upstream.close(resolveClose))
  }
})

test('sends a bounded model-hidden session-final request and surfaces rejection', async () => {
  const requests = []
  let status = 200
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      requests.push({ body: Buffer.concat(chunks).toString('utf8'), headers: request.headers })
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(status === 200 ? '{"ok":true}' : '{"error":"rejected"}')
    })
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  const records = []
  const parameters = {
    apiKey: 'test-secret',
    baseUrl: new URL(`http://127.0.0.1:${address.port}/v1`),
    model: 'test-model',
    record: value => records.push(value),
    sessionId: 'native-session',
    timeoutMs: 500,
  }
  try {
    await sendSessionFinal(parameters)
    assert.equal(requests[0].headers['x-dynamo-session-final'], 'true')
    assert.equal(requests[0].headers['x-dynamo-session-id'], 'native-session')
    assert.equal(JSON.parse(requests[0].body).max_tokens, 1)
    assert.equal(records[0].status, 200)
    status = 503
    await assert.rejects(sendSessionFinal(parameters), /returned 503/)
  } finally {
    await new Promise(resolveClose => server.close(resolveClose))
  }
})

test('tracks and terminates a detached POSIX process tree', { skip: process.platform === 'win32' }, async () => {
  assertProcessTreeSupport()
  const directory = temporaryDirectory()
  const childPidPath = join(directory, 'child-pid')
  const script = join(directory, 'process-tree.mjs')
  writeFileSync(script, `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const child = spawn('/bin/sh', ['-c', 'while :; do sleep 1; done'], { stdio: 'ignore' })
writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid))
setInterval(() => {}, 1_000)
`)
  const root = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' })
  const rootExit = new Promise(resolveExit => root.once('close', resolveExit))
  const tracked = new Set()
  try {
    await waitFor(() => {
      try { return readFileSync(childPidPath, 'utf8').trim() !== '' } catch { return false }
    }, 'process-tree child PID')
    const childPid = Number(readFileSync(childPidPath, 'utf8'))
    trackChildTree(root, tracked)
    assert.equal(tracked.has(root.pid), true)
    assert.equal(tracked.has(childPid), true)
    signalChildTree(root, 'SIGKILL', tracked)
    await rootExit
    assert.equal(await waitForChildTreeExit(root, tracked, 2_000), true)
    await waitFor(() => !processIsAlive(childPid), 'the tracked child to exit')
  } finally {
    signalChildTree(root, 'SIGKILL', tracked)
  }
  assert.equal(signalExitCode('SIGINT'), 130)
  assert.equal(signalExitCode('SIGTERM'), 143)
})
