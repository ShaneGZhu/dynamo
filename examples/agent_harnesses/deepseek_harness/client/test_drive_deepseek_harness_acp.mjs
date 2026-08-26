// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./drive_deepseek_harness_acp.mjs', import.meta.url))
const SDK_URL = import.meta.resolve('@agentclientprotocol/sdk')
const temporaryDirectories = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-dynamo-acp-test-'))
  temporaryDirectories.push(directory)
  return directory
}

function fakeAcpServer(directory, mode = 'normal') {
  const path = join(directory, `fake-acp-${mode}.mjs`)
  writeFileSync(path, `
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from ${JSON.stringify(SDK_URL)}
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

const mode = ${JSON.stringify(mode)}
const statePath = join(process.env.DSH_HOME, 'fake-acp-state.json')
let prompts = 0
let sessions = 0
function state(extra = {}) {
  writeFileSync(statePath, JSON.stringify({ pid: process.pid, prompts, sessions, ...extra }))
}

class FakeAgent {
  constructor(client) {
    this.client = client
  }

  async initialize() {
    state({ initialized: true })
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false }, authMethods: [] }
  }

  async newSession() {
    if (mode === 'fail') process.exit(23)
    sessions += 1
    state()
    return { sessionId: 'acp-session-one' }
  }

  async prompt(params) {
    prompts += 1
    state({ lastPromptSession: params.sessionId })
    if (mode === 'hang') return new Promise(() => {})
    const headers = {
      authorization: 'Bearer ' + process.env.DEEPSEEK_API_KEY,
      'content-type': 'application/json',
      'x-deepseek-harness-session-id': 'native-dsh-session',
      'x-deepseek-harness-user-id': 'stable-user',
    }
    if (prompts === 2) headers['x-deepseek-harness-compact'] = '1'
    const response = await fetch(process.env.DEEPSEEK_BASE_URL + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'turn-' + prompts }], stream: true }),
    })
    if (!response.ok) throw new Error('mock Dynamo returned ' + response.status)
    await response.text()
    await this.client.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer-' + prompts } },
    })
    return { stopReason: 'end_turn' }
  }

  async cancel(params) {
    state({ cancelledSession: params.sessionId })
  }
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
new AgentSideConnection(client => new FakeAgent(client), stream)
process.stdin.on('end', () => process.exit(0))
`)
  return path
}

async function mockDynamo(finalStatus = 200) {
  const requests = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      requests.push({ body: Buffer.concat(chunks).toString('utf8'), headers: request.headers })
      if (request.headers['x-dynamo-session-final'] === 'true') {
        response.writeHead(finalStatus, { 'content-type': 'application/json' })
        response.end(JSON.stringify(finalStatus === 200 ? { ok: true } : { error: 'rejected' }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([
        'data: {"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
        'data: {"choices":[{"delta":{"content":"hello from mock Dynamo"}}]}',
        'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}',
        'data: [DONE]',
        '',
      ].join('\n\n'))
    })
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise(resolveClose => server.close(resolveClose)),
    requests,
  }
}

function runHost({ acpBin, baseUrl, capture, dshHome, environment = {}, extraArguments = [] }) {
  const arguments_ = [
    SCRIPT,
    '--base-url', baseUrl,
    '--model', 'test-model',
    '--prompt', 'first prompt',
    '--prompt', 'second prompt',
    '--capture', capture,
    '--acp-bin', acpBin,
    '--shutdown-timeout-ms', '500',
    ...extraArguments,
  ]
  if (dshHome !== undefined) arguments_.push('--dsh-home', dshHome)
  const child = spawn(process.execPath, arguments_, {
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: 'ambient-secret-must-not-win',
      DYNAMO_API_KEY: 'dynamo-secret',
      LEAK_TEST_SECRET: 'must-not-reach-child',
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  let stdout = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.on('data', chunk => { stdout += chunk })
  const completed = new Promise((resolveCompleted, rejectCompleted) => {
    child.once('error', rejectCompleted)
    child.once('close', code => resolveCompleted({ code, stderr, stdout }))
  })
  return { child, completed, stdout: () => stdout }
}

function evidence(path) {
  return readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
}

function outputRecords(stdout) {
  return stdout.trim().split('\n').map(line => JSON.parse(line))
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }
}

test('keeps one ACP connection and session for repeated prompts while preserving native metadata', async () => {
  const directory = temporaryDirectory()
  const upstream = await mockDynamo()
  try {
    const capture = join(directory, 'capture.jsonl')
    const dshHome = join(directory, 'dsh-home')
    mkdirSync(dshHome)
    const run = runHost({
      acpBin: fakeAcpServer(directory),
      baseUrl: upstream.baseUrl,
      capture,
      dshHome,
      extraArguments: ['--session-final', '--context-window', '8192'],
    })
    const result = await run.completed

    assert.equal(result.code, 0, result.stderr)
    const output = outputRecords(result.stdout)
    assert.deepEqual(output.map(record => record.kind), ['ready', 'turn', 'turn', 'closed'])
    assert.deepEqual(new Set(output.map(record => record.session_id)), new Set(['acp-session-one']))
    assert.equal(output[1].text, 'answer-1')
    assert.equal(output[2].text, 'answer-2')
    assert.deepEqual(output[3].native_session_ids, ['native-dsh-session'])

    const state = JSON.parse(readFileSync(join(dshHome, 'fake-acp-state.json'), 'utf8'))
    assert.equal(state.sessions, 1)
    assert.equal(state.prompts, 2)
    assert.equal(state.lastPromptSession, 'acp-session-one')

    const composition = JSON.parse(readFileSync(join(dshHome, 'cordis.yml'), 'utf8'))
    const modelConfig = composition.find(plugin => plugin.id === 'llm-deepseek').config.models[0]
    assert.equal(modelConfig.contextWindow, 8192)
    assert.equal(modelConfig.maxTokens, 4096)

    assert.equal(upstream.requests.length, 3)
    assert.equal(upstream.requests[0].headers.authorization, 'Bearer dynamo-secret')
    assert.equal(upstream.requests[0].headers['x-deepseek-harness-session-id'], 'native-dsh-session')
    assert.equal(upstream.requests[0].headers['x-deepseek-harness-compact'], undefined)
    assert.equal(upstream.requests[0].headers['x-dynamo-session-id'], undefined)
    assert.equal(upstream.requests[1].headers['x-deepseek-harness-session-id'], 'native-dsh-session')
    assert.equal(upstream.requests[1].headers['x-deepseek-harness-compact'], '1')
    assert.equal(upstream.requests[2].headers['x-dynamo-session-id'], 'native-dsh-session')
    assert.equal(upstream.requests[2].headers['x-dynamo-session-final'], 'true')

    const records = evidence(capture)
    const requests = records.filter(record => record.kind === 'request')
    assert.equal(requests.length, 2)
    assert.match(requests[0].headers['x-deepseek-harness-user-id'], /^sha256:/)
    assert.equal(requests[1].headers['x-deepseek-harness-compact'], '1')
    assert.equal(records.at(-1).forced_shutdown, false)
  } finally {
    await upstream.close()
  }
})

test('fails within the prompt deadline and cancels the active session', async () => {
  const directory = temporaryDirectory()
  const upstream = await mockDynamo()
  try {
    const capture = join(directory, 'timeout.jsonl')
    const dshHome = join(directory, 'dsh-home')
    mkdirSync(dshHome)
    const started = Date.now()
    const run = runHost({
      acpBin: fakeAcpServer(directory, 'hang'),
      baseUrl: upstream.baseUrl,
      capture,
      dshHome,
      extraArguments: ['--prompt-timeout-ms', '100'],
    })
    const result = await run.completed

    assert.equal(result.code, 1)
    assert.ok(Date.now() - started < 5_000, `timeout path took ${Date.now() - started}ms`)
    assert.match(result.stderr, /session\/prompt 1 exceeded 100ms/)
    const state = JSON.parse(readFileSync(join(dshHome, 'fake-acp-state.json'), 'utf8'))
    assert.equal(state.cancelledSession, 'acp-session-one')
    assert.equal(evidence(capture).some(record => record.kind === 'acp_error'), true)
  } finally {
    await upstream.close()
  }
})

test('reports an unexpected ACP child exit during session creation', async () => {
  const directory = temporaryDirectory()
  const upstream = await mockDynamo()
  try {
    const capture = join(directory, 'child-failure.jsonl')
    const run = runHost({
      acpBin: fakeAcpServer(directory, 'fail'),
      baseUrl: upstream.baseUrl,
      capture,
      extraArguments: ['--startup-timeout-ms', '500'],
    })
    const result = await run.completed

    assert.equal(result.code, 1)
    assert.match(result.stderr, /ACP connection closed|ACP session\/new exceeded/)
    assert.equal(evidence(capture).some(record => record.kind === 'acp_error'), true)
  } finally {
    await upstream.close()
  }
})

test('cancels and exits with the conventional code after SIGTERM', async () => {
  const directory = temporaryDirectory()
  const upstream = await mockDynamo()
  try {
    const capture = join(directory, 'signal.jsonl')
    const dshHome = join(directory, 'dsh-home')
    mkdirSync(dshHome)
    const run = runHost({
      acpBin: fakeAcpServer(directory, 'hang'),
      baseUrl: upstream.baseUrl,
      capture,
      dshHome,
      extraArguments: ['--prompt-timeout-ms', '10000'],
    })
    await waitFor(() => run.stdout().includes('"kind":"ready"'), 'ACP ready output')
    run.child.kill('SIGTERM')
    const result = await run.completed

    assert.equal(result.code, 143, result.stderr)
    assert.equal(evidence(capture).at(-1).received_signal, 'SIGTERM')
    const state = JSON.parse(readFileSync(join(dshHome, 'fake-acp-state.json'), 'utf8'))
    assert.equal(state.cancelledSession, 'acp-session-one')
  } finally {
    await upstream.close()
  }
})

test('rejects a one-prompt invocation before opening evidence or starting ACP', async () => {
  const directory = temporaryDirectory()
  const capture = join(directory, 'must-not-exist.jsonl')
  const child = spawn(process.execPath, [
    SCRIPT,
    '--base-url', 'http://127.0.0.1:9',
    '--model', 'test-model',
    '--prompt', 'only one',
    '--capture', capture,
    '--acp-bin', fakeAcpServer(directory),
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise(resolveClose => child.once('close', resolveClose))

  assert.equal(code, 1)
  assert.match(stderr, /repeat --prompt at least twice/)
  assert.throws(() => readFileSync(capture), /ENOENT/)
})

test('runs the published ACP server package for two prompts', { skip: process.env.DSH_ACP_PACKAGE_SMOKE !== '1' }, async () => {
  const directory = temporaryDirectory()
  const upstream = await mockDynamo()
  try {
    const capture = join(directory, 'package-smoke.jsonl')
    const publishedBin = fileURLToPath(new URL('./run_deepseek_harness_acp_server.mjs', import.meta.url))
    const run = runHost({ acpBin: publishedBin, baseUrl: upstream.baseUrl, capture })
    const result = await run.completed

    assert.equal(result.code, 0, result.stderr)
    const output = outputRecords(result.stdout)
    const turns = output.filter(record => record.kind === 'turn')
    assert.equal(turns.length, 2)
    assert.deepEqual(turns.map(turn => turn.text), ['hello from mock Dynamo', 'hello from mock Dynamo'])
    assert.equal(new Set(output.filter(record => record.session_id).map(record => record.session_id)).size, 1)
    const modelRequests = upstream.requests.filter(request => request.headers['x-dynamo-session-final'] !== 'true')
    assert.equal(modelRequests.length, 2)
    assert.equal(new Set(modelRequests.map(request => request.headers['x-deepseek-harness-session-id'])).size, 1)
    assert.equal(typeof modelRequests[0].headers['x-deepseek-harness-session-id'], 'string')
  } finally {
    await upstream.close()
  }
})
