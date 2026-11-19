/**
 * Thinking control.
 *
 * DuMate exposes exactly one thinking switch — the `thinking` object in the
 * request body. `reasoning_effort`, `enable_thinking`, `thinking_budget`, and
 * every `budget_tokens` spelling were probed against the live proxy and left
 * reasoning tokens unchanged (256 vs 16384 both produced ~130 reasoning
 * tokens), so the adapter offers two levels instead of pretending to offer
 * more. This test pins the mapping in both directions and the wire shape.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  EFFORT_OFF,
  EFFORT_ON,
  effortFromAnthropic,
  effortFromOpenAI,
  reasoningInfoFor,
  thinkingPayload,
} from '../src/reasoning.js'
import { streamChatCompletion } from '../src/upstream/openai-client.js'
import { startGateway } from '../src/gateway/server.js'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-gateway-reasoning-'))

let checks = 0

// 1. Level ids resolve to exactly the two wire values DuMate understands.
{
  assert.deepEqual(thinkingPayload(EFFORT_OFF), { type: 'disabled' })
  assert.deepEqual(thinkingPayload(EFFORT_ON), { type: 'enabled' })
  assert.equal(thinkingPayload(undefined), null, 'no selection sends no field')
  assert.equal(thinkingPayload(''), null)
  assert.equal(thinkingPayload('bogus'), null, 'an unknown level must not invent a payload')
  checks += 4
}

// 2. Client protocols map onto those levels.
{
  for (const value of ['none', 'off', 'disabled', 'minimal', 'NONE', ' off ']) {
    assert.equal(effortFromOpenAI(value), EFFORT_OFF, `reasoning_effort "${value}" silences thinking`)
  }
  for (const value of ['low', 'medium', 'high', 'xhigh', 'HIGH']) {
    assert.equal(effortFromOpenAI(value), EFFORT_ON, `reasoning_effort "${value}" keeps thinking`)
  }
  assert.equal(effortFromOpenAI(undefined), undefined)
  assert.equal(effortFromOpenAI(42), undefined)

  assert.equal(effortFromAnthropic({ type: 'disabled' }), EFFORT_OFF)
  assert.equal(effortFromAnthropic({ type: 'enabled' }), EFFORT_ON)
  assert.equal(effortFromAnthropic(undefined), undefined)
  assert.equal(effortFromAnthropic({ type: 'auto' }), undefined)
  checks += 5
}

// 3. Capability lists: two levels normally, "on" alone where the upstream refuses "off".
{
  const both = reasoningInfoFor('deepseek-v41-flash')
  assert.equal(both.efforts.length, 2)
  assert.deepEqual(both.efforts.map(effort => effort.id), [EFFORT_OFF, EFFORT_ON])
  // No declared default: the harness would otherwise send `thinking` on calls
  // the user never configured.
  assert.equal(both.defaultEffort, undefined, 'no defaultEffort is declared')

  const partial = reasoningInfoFor('glm-53')
  assert.equal(partial.efforts.length, 2, 'partial models still offer both levels')
  assert.match(partial.efforts[0].description ?? '', /may still emit/i, 'and say so')

  const always = reasoningInfoFor('kimi-k3')
  assert.deepEqual(always.efforts.map(effort => effort.id), [EFFORT_ON], 'kimi-k3 rejects disabled')
  checks += 5
}

// 4. The transport puts the object in the body and nothing else.
{
  const seen = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      seen.push(JSON.parse(raw))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`
  const drain = async options => {
    for await (const _ of streamChatCompletion({
      baseURL, apiKey: 'nokey', model: 'model-text', messages: [{ role: 'user', content: 'hi' }], ...options,
    })) { /* consume */ }
  }

  await drain({ thinking: { type: 'disabled' } })
  assert.deepEqual(seen.at(-1).thinking, { type: 'disabled' })
  await drain({ thinking: null })
  assert.equal('thinking' in seen.at(-1), false, 'no selection omits the field entirely')
  await drain({ temperature: 0.3 })
  assert.equal('thinking' in seen.at(-1), false)
  assert.equal(seen.at(-1).temperature, 0.3, 'other fields still travel')

  await new Promise(resolve => server.close(resolve))
  checks += 4
}

// 5. Both HTTP protocols translate their client-side spelling.
{
  const calls = []
  const catalog = {
    configPath: '<test>',
    baseURL: 'http://127.0.0.1:9/api/qianfanproxy/v1',
    apiKey: null,
    models: [{ id: 'fake-model', name: 'Fake', inputModalities: ['text'], contextWindow: 1000, maxTokens: 100 }],
  }
  async function* fakeStream(options) {
    calls.push(options.thinking ?? null)
    yield { kind: 'text', text: 'ok' }
    yield { kind: 'finish', reason: { kind: 'stop' } }
  }
  const gateway = await startGateway({
    port: 0,
    version: 'test',
    readCatalog: () => catalog,
    isReachable: async () => true,
    streamChatCompletion: fakeStream,
  })

  const post = (pathname, body) => fetch(`${gateway.url}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  await (await post('/v1/chat/completions', {
    model: 'fake-model', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'none',
  })).text()
  assert.deepEqual(calls.at(-1), { type: 'disabled' }, 'OpenAI "none" reaches the upstream as disabled')

  await (await post('/v1/chat/completions', {
    model: 'fake-model', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high',
  })).text()
  assert.deepEqual(calls.at(-1), { type: 'enabled' })

  await (await post('/v1/chat/completions', {
    model: 'fake-model', messages: [{ role: 'user', content: 'hi' }],
  })).text()
  assert.equal(calls.at(-1), null, 'a request without the option sends nothing')

  await (await post('/v1/messages', {
    model: 'fake-model', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'disabled' },
  })).text()
  assert.deepEqual(calls.at(-1), { type: 'disabled' }, 'Anthropic thinking.disabled maps too')

  await (await post('/v1/messages', {
    model: 'fake-model', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'enabled', budget_tokens: 1024 },
  })).text()
  assert.deepEqual(calls.at(-1), { type: 'enabled' }, 'a budget is not forwarded as a level')

  await gateway.close()
  checks += 5
}

console.log(`reasoning: ${checks} checks passed`)