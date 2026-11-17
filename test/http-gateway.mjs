/**
 * Offline test for the loopback HTTP gateway.
 *
 * The gateway is started with injected fakes so every endpoint can be checked
 * without DuMate (or any network access at all).
 */
import assert from 'node:assert/strict'
import { startGateway } from '../src/gateway/server.js'

const MODEL = 'fake-model'

const catalog = {
  configPath: '<test>',
  baseURL: 'http://127.0.0.1:9/api/qianfanproxy/v1',
  apiKey: null,
  models: [{ id: MODEL, name: 'Fake Model', inputModalities: ['text'], contextWindow: 1000, maxTokens: 100 }],
}

/** Same semantic events the real upstream client yields. */
async function* fakeStream(options) {
  assert.equal(options.baseURL, catalog.baseURL, 'gateway must forward the catalog baseURL')
  assert.equal(options.model, MODEL)
  yield { kind: 'reasoning', text: 'thinking… ' }
  yield { kind: 'text', text: 'Hello' }
  yield { kind: 'text', text: ' world' }
  yield { kind: 'usage', usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8, reasoningTokens: 1 } }
  yield { kind: 'finish', reason: { kind: 'stop' } }
}

async function* fakeToolStream() {
  yield { kind: 'tool-call', id: 'call_1', name: 'lookup', argumentsDelta: '{"q":"x"}' }
  yield { kind: 'finish', reason: { kind: 'tool-calls' } }
}

const deps = {
  readCatalog: () => catalog,
  isReachable: async () => true,
  streamChatCompletion: fakeStream,
}

function parseSse(text) {
  return text
    .split('\n\n')
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join(''))
    .filter(Boolean)
}

function events(text) {
  return parseSse(text).filter(payload => payload !== '[DONE]').map(payload => JSON.parse(payload))
}

async function json(res) {
  return { status: res.status, body: await res.json() }
}

const gateway = await startGateway({ port: 0, version: 'test', ...deps })
const base = gateway.url
let checks = 0
try {
  // health
  {
    const { status, body } = await json(await fetch(`${base}/health`))
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.upstream.online, true)
    assert.equal(body.upstream.models, 1)
    assert.equal(body.gateway.version, 'test')
    checks += 1
  }

  // models
  {
    const { status, body } = await json(await fetch(`${base}/v1/models`))
    assert.equal(status, 200)
    assert.equal(body.object, 'list')
    assert.equal(body.data[0].id, MODEL)
    assert.equal(body.data[0].object, 'model')
    checks += 1
  }

  // chat, non-streaming
  {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
    })
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.object, 'chat.completion')
    assert.equal(body.choices[0].message.content, 'Hello world')
    assert.equal(body.choices[0].message.reasoning_content, 'thinking… ')
    assert.equal(body.choices[0].finish_reason, 'stop')
    assert.equal(body.usage.prompt_tokens, 5)
    assert.equal(body.usage.completion_tokens, 3)
    checks += 1
  }

  // chat, streaming
  {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
    const text = await res.text()
    const frames = events(text)
    const deltaText = frames.flatMap(frame => frame.choices?.[0]?.delta?.content ?? []).join('')
    const deltaReasoning = frames.flatMap(frame => frame.choices?.[0]?.delta?.reasoning_content ?? []).join('')
    assert.equal(deltaText, 'Hello world')
    assert.equal(deltaReasoning, 'thinking… ')
    assert.equal(frames.at(-2).usage.prompt_tokens, 5)
    assert.equal(frames.at(-1).choices[0].finish_reason, 'stop')
    assert.ok(parseSse(text).at(-1) === '[DONE]', 'stream must end with [DONE]')
    checks += 1
  }

  // unknown model
  {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nope', messages: [] }),
    })
    const body = await res.json()
    assert.equal(res.status, 404)
    assert.equal(body.error.code, 'model_not_found')
    checks += 1
  }

  // anthropic, non-streaming
  {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 32,
        system: [{ type: 'text', text: 'be brief' }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    })
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.type, 'message')
    assert.equal(body.content[0].text, 'Hello world')
    assert.equal(body.stop_reason, 'end_turn')
    assert.equal(body.usage.input_tokens, 5)
    assert.equal(body.usage.output_tokens, 3)
    checks += 1
  }

  // anthropic, streaming
  {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 32, messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    assert.equal(res.status, 200)
    const text = await res.text()
    const names = text.split('\n').filter(line => line.startsWith('event:')).map(line => line.slice(6).trim())
    assert.equal(names[0], 'message_start')
    assert.ok(names.includes('content_block_delta'))
    assert.equal(names.at(-1), 'message_stop')
    const deltas = text.split('\n\n')
      .filter(block => block.startsWith('event: content_block_delta'))
      .map(block => JSON.parse(block.split('data:')[1].trim()))
      .map(payload => payload.delta.text)
      .join('')
    assert.equal(deltas, 'Hello world')
    checks += 1
  }

  // CORS preflight from the local web UI
  {
    const res = await fetch(`${base}/health`, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:5123' } })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5123')
    checks += 1
  }
} finally {
  await gateway.close()
}

// auth: a configured token must gate every route
const guarded = await startGateway({ port: 0, token: 's3cret', version: 'test', ...deps })
try {
  const anonymous = await fetch(`${guarded.url}/v1/models`)
  assert.equal(anonymous.status, 401)
  const bearer = await fetch(`${guarded.url}/v1/models`, { headers: { authorization: 'Bearer s3cret' } })
  assert.equal(bearer.status, 200)
  const apiKey = await fetch(`${guarded.url}/v1/models`, { headers: { 'x-api-key': 's3cret' } })
  assert.equal(apiKey.status, 200)
  checks += 1
} finally {
  await guarded.close()
}

// tool calls stay visible to clients that asked for them
const toolGateway = await startGateway({
  port: 0,
  version: 'test',
  ...deps,
  streamChatCompletion: fakeToolStream,
})
try {
  const res = await fetch(`${toolGateway.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'go' }] }),
  })
  const body = await res.json()
  assert.equal(body.choices[0].finish_reason, 'tool_calls')
  assert.equal(body.choices[0].message.tool_calls[0].function.name, 'lookup')
  checks += 1
} finally {
  await toolGateway.close()
}

console.log(`http gateway: ${checks} checks passed`)
