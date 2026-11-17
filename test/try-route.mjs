/**
 * Try route: the panel's "send a test message" button, one small completion.
 *
 * Both the catalog and the upstream stream are injected, so this never touches
 * DuMate and never spends quota.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTryHandler, TRY_PATH } from '../src/host/try-route.js'
import { GatewayError } from '../src/failure.js'
import { reset as resetUsage } from '../src/usage.js'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-gateway-try-'))
resetUsage()

assert.equal(TRY_PATH, '/api/dumate-gateway/try')

const catalog = {
  configPath: 'C:/tmp/opencode.json',
  baseURL: 'http://127.0.0.1:52912/api/qianfanproxy/v1',
  apiKey: 'nokey',
  models: [
    { id: 'model-text', name: 'GLM 5', inputModalities: ['text'], contextWindow: 1000000, maxTokens: 128000 },
    { id: 'qwen3.8-max', name: 'Qwen3.8 Max', inputModalities: ['text', 'image'], contextWindow: 983000 },
  ],
}

function post(body) {
  return new Request('http://127.0.0.1/api/dumate-gateway/try', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function fakeStream(chunks, { fail } = {}) {
  return async function* stream() {
    for (const chunk of chunks) yield chunk
    if (fail !== undefined) throw fail
  }
}

// A successful probe reports the answer, the usage, and both timings.
const okChunks = [
  { kind: 'reasoning', text: 'thinking' },
  { kind: 'text', text: 'Hel' },
  { kind: 'text', text: 'lo' },
  { kind: 'usage', usage: { inputTokens: 9, outputTokens: 2, totalTokens: 11 } },
  { kind: 'finish', reason: { kind: 'stop' } },
]
const handler = createTryHandler({
  catalog: async () => catalog,
  stream: fakeStream(okChunks),
})
const response = await handler(post({ prompt: 'say hello' }))
assert.equal(response.status, 200)
assert.equal(response.headers.get('cache-control'), 'no-store')
const body = await response.json()
assert.equal(body.ok, true)
assert.equal(body.model, 'model-text', 'the first catalog model is the default')
assert.equal(body.text, 'Hello')
assert.equal(body.reasoning, 'thinking')
assert.equal(body.finish, 'stop')
assert.equal(body.usage.inputTokens, 9)
assert.equal(typeof body.first_token_ms, 'number')
assert.equal(typeof body.total_ms, 'number')

// The requested model wins when the catalog knows it, and the request options
// reach the stream (max_tokens is capped at 512, default 256).
let seen = null
const capturing = createTryHandler({
  catalog: async () => catalog,
  stream: async function* (options) {
    seen = options
    yield { kind: 'text', text: 'ok' }
    yield { kind: 'finish', reason: { kind: 'stop' } }
  },
})
await capturing(post({ prompt: 'hi', model: 'qwen3.8-max', max_tokens: 1000 }))
assert.equal(seen.model, 'qwen3.8-max')
assert.equal(seen.maxTokens, 512, 'the probe never asks for a long answer')
await capturing(post({ prompt: 'hi' }))
assert.equal(seen.maxTokens, 256)

// Validation failures are 400s with a readable message.
const noPrompt = await handler(post({ prompt: '   ' }))
assert.equal(noPrompt.status, 400)
assert.match((await noPrompt.json()).message, /prompt/)
const tooLong = await handler(post({ prompt: 'x'.repeat(2001) }))
assert.equal(tooLong.status, 400)
const badJson = await handler(new Request('http://127.0.0.1/api/dumate-gateway/try', {
  method: 'POST',
  body: 'not json',
}))
assert.equal(badJson.status, 400)

// No DuMate state: 503, not a crash.
const offline = createTryHandler({
  catalog: async () => {
    throw new Error('no DuMate state file found')
  },
  stream: fakeStream([]),
})
const offlineResponse = await offline(post({ prompt: 'hi' }))
assert.equal(offlineResponse.status, 503)
const offlineBody = await offlineResponse.json()
assert.match(offlineBody.message, /DuMate state file/)
assert.match(offlineBody.reason, /no DuMate state file found/)

// Upstream failures map to HTTP statuses the panel can explain.
for (const [code, status] of [
  ['UNKNOWN_MODEL', 404],
  ['AUTH', 401],
  ['QUOTA', 402],
  ['RATE_LIMIT', 429],
  ['INVALID_REQUEST', 400],
  ['ABORTED', 504],
  ['TRANSPORT', 502],
]) {
  const failing = createTryHandler({
    catalog: async () => catalog,
    stream: async function* () {
      throw new GatewayError({ code, message: `upstream said ${code}`, status: 500 })
    },
  })
  const failed = await failing(post({ prompt: 'hi' }))
  assert.equal(failed.status, status, `${code} maps to ${status}`)
  const payload = await failed.json()
  assert.equal(payload.ok, undefined)
  assert.equal(payload.error, code)
}

console.log('try route checks passed')
