/**
 * Tool calls through the DuMate proxy.
 *
 * DuMate splits one call over several SSE fragments and changes `index` for the
 * argument pieces (0 for the id/name, then 1, 1… for the JSON). Consumers key
 * calls by index/id, so before the merge the gateway emitted one nameless call
 * per fragment and DSH could never assemble a usable tool call. This test pins
 * the merge: one event with the id, the name and the whole argument string.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { streamChatCompletion } from '../src/upstream/openai-client.js'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-gateway-tools-'))

const sse = frames => frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')
const finish = reason => ({
  choices: [{ index: 0, delta: {}, finish_reason: reason }],
})

/** Fragments as DuMate sends them: id/name first, then broken indices for args. */
const BROKEN_FRAGMENTS = [
  {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_a',
          type: 'function',
          function: { name: 'get_weather', arguments: '' },
        }],
      },
      finish_reason: null,
    }],
  },
  {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{ index: 1, type: 'function', function: { arguments: '{' } }],
      },
      finish_reason: null,
    }],
  },
  {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{ index: 1, type: 'function', function: { arguments: '"city": "Beijing"}' } }],
      },
      finish_reason: null,
    }],
  },
  finish('tool_calls'),
]

/** Two real calls: each fragment opens a new call because it carries an id. */
const PARALLEL_FRAGMENTS = [
  {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0, id: 'call_a', type: 'function', function: { name: 'first', arguments: '{"x":1}' },
        }],
      },
      finish_reason: null,
    }],
  },
  {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 1, id: 'call_b', type: 'function', function: { name: 'second', arguments: '{"y":2}' },
        }],
      },
      finish_reason: null,
    }],
  },
  finish('tool_calls'),
]

let mode = 'broken'
const server = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    if (mode === 'json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '' } },
              { index: 1, type: 'function', function: { arguments: '{' } },
              { index: 2, type: 'function', function: { arguments: '"city": "Beijing"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
      }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`${sse(mode === 'parallel' ? PARALLEL_FRAGMENTS : BROKEN_FRAGMENTS)}data: [DONE]\n\n`)
  })
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseURL = `http://127.0.0.1:${server.address().port}/v1`

async function collect() {
  const events = []
  for await (const event of streamChatCompletion({
    baseURL,
    apiKey: 'nokey',
    model: 'model-text',
    messages: [{ role: 'user', content: 'weather?' }],
    tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
  })) {
    events.push(event)
  }
  return events
}

const callsOf = events => events.filter(event => event.kind === 'tool-call')

// 1. The broken index pattern still yields exactly one usable call.
{
  mode = 'broken'
  const calls = callsOf(await collect())
  assert.equal(calls.length, 1, 'one logical call, not one per fragment')
  assert.equal(calls[0].id, 'call_a', 'the id survives the merge')
  assert.equal(calls[0].name, 'get_weather', 'the name survives the merge')
  assert.equal(calls[0].argumentsDelta, '{"city": "Beijing"}', 'the argument pieces are joined')
}

// 2. A server that ignored stream:true is merged the same way.
{
  mode = 'json'
  const calls = callsOf(await collect())
  assert.equal(calls.length, 1, 'the non-stream body merges too')
  assert.equal(calls[0].argumentsDelta, '{"city": "Beijing"}')
}

// 3. Two genuinely separate calls stay separate.
{
  mode = 'parallel'
  const calls = callsOf(await collect())
  assert.equal(calls.length, 2, 'a fragment with its own id starts a new call')
  assert.deepEqual(calls.map(call => call.id), ['call_a', 'call_b'])
  assert.deepEqual(calls.map(call => call.argumentsDelta), ['{"x":1}', '{"y":2}'])
}

// 4. Tool calls are only merged with each other: text and finish stay in order.
{
  mode = 'broken'
  const kinds = (await collect()).map(event => event.kind)
  assert.equal(kinds.at(-1), 'finish', 'the finish event still comes last')
  assert.ok(kinds.includes('tool-call'), 'the call is present')
}

server.close()
console.log('tool-call checks passed')
