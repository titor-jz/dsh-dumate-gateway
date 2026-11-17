/**
 * Same-origin status route: the sidebar panel reads this payload instead of
 * calling the loopback gateway across origins.
 *
 * No host and no DuMate needed — the reader takes injected catalog/reachability
 * probes, exactly like the route registered by index.js.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStatusReader, statusResponse, STATUS_PATH } from '../src/host/status-route.js'
import { record, reset as resetUsage } from '../src/usage.js'

// Keep the usage file out of the real home. usage.js loads lazily, so this is
// early enough even though the imports above are static.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-gateway-status-'))
resetUsage()

assert.equal(STATUS_PATH, '/api/dumate-gateway/status', 'the exact Fetch route keys the full request pathname')

const snapshot = {
  configPath: 'C:/tmp/opencode.json',
  baseURL: 'http://127.0.0.1:52912/api/qianfanproxy/v1',
  apiKey: 'nokey',
  models: [
    {
      id: 'model-text',
      name: 'GLM 5',
      inputModalities: ['text'],
      contextWindow: 1000000,
      maxTokens: 128000,
    },
    {
      id: 'qwen3.8-max',
      name: 'Qwen3.8 Max',
      inputModalities: ['text', 'image'],
      contextWindow: 983000,
    },
  ],
}

const read = createStatusReader({
  version: '0.0.1',
  catalog: async () => snapshot,
  reachable: async () => true,
})

const status = await read()
assert.equal(status.ok, true)
assert.equal(status.gateway.version, '0.0.1')
assert.equal(status.gateway.models_mode, 'curated', 'the panel shows which curation mode feeds it')
assert.equal(status.upstream.online, true)
assert.equal(status.upstream.baseURL, snapshot.baseURL)
assert.equal(status.upstream.config_path, 'C:/tmp/opencode.json', 'the panel shows the live state file it read')
assert.equal(status.upstream.models, 2, 'the panel renders this count')
assert.deepEqual(status.models.map(model => model.id), ['model-text', 'qwen3.8-max'])
assert.equal(status.models[0].object, 'model')
assert.equal(status.models[0].owned_by, 'dumate')
assert.equal(status.models[0].context_window, 1000000)
assert.equal(status.models[0].max_tokens, 128000)
assert.deepEqual(status.models[1].input_modalities, ['text', 'image'])
assert.equal('max_tokens' in status.models[1], false, 'missing limits stay absent, not undefined')
assert.equal(status.usage.requests, 0, 'a fresh usage file reports zero')
assert.match(status.usage.today, /^\d{4}-\d{2}-\d{2}$/)

// Usage rows recorded by any path show up in the same payload.
record({ kind: 'try', model: 'model-text', usage: { inputTokens: 10, outputTokens: 4 }, ok: true, ms: 120 })
record({ kind: 'dsh', model: 'model-text', usage: { inputTokens: 7, outputTokens: 2 }, ok: false, code: 'RATE_LIMIT', ms: 60 })
const withUsage = await read()
assert.equal(withUsage.usage.requests, 2)
assert.equal(withUsage.usage.input_tokens, 17)
assert.equal(withUsage.usage.output_tokens, 6)
assert.equal(withUsage.usage.errors, 1)
assert.equal(withUsage.usage.by_kind.try.requests, 1)
assert.equal(withUsage.usage.last.code, 'RATE_LIMIT')

// The curation options reach the catalog probe.
let seen = null
const curatedReader = createStatusReader({
  version: '0.0.1',
  modelsMode: 'all',
  modelsExclude: ['kimi'],
  catalog: async options => {
    seen = options
    return snapshot
  },
  reachable: async () => false,
})
const offline = await curatedReader()
assert.deepEqual(seen, { mode: 'all', exclude: ['kimi'] })
assert.equal(offline.upstream.online, false)
assert.equal(offline.upstream.models, 2, 'an offline upstream may still advertise its cached catalog')

// No DuMate state at all: well-formed empty payload with a reason, not a throw.
const missing = createStatusReader({
  version: '0.0.1',
  catalog: async () => {
    throw new Error('no DuMate state file found')
  },
  reachable: async () => true,
})
const empty = await missing()
assert.equal(empty.ok, true)
assert.equal(empty.upstream.online, false)
assert.equal(empty.upstream.baseURL, null)
assert.equal(empty.upstream.models, 0)
assert.equal('config_path' in empty.upstream, false, 'no state file means no path to show')
assert.deepEqual(empty.models, [])
assert.match(empty.reason, /no DuMate state file/)

// The Fetch route wrapper answers JSON and forbids caching.
const response = await statusResponse(read)()
assert.equal(response.status, 200)
assert.match(response.headers.get('content-type'), /application\/json/)
assert.equal(response.headers.get('cache-control'), 'no-store')
const parsed = await response.json()
assert.deepEqual(parsed.models.map(model => model.id), ['model-text', 'qwen3.8-max'])

// The exact Fetch route is keyed by the full request pathname on the shared API
// channel, and the host validates it with endpointFromPath('/api', path): the
// constant must therefore carry the prefix and end in URL-safe segments.
assert.ok(STATUS_PATH.startsWith('/api/'), 'route path must include the /api prefix')
for (const segment of STATUS_PATH.split('/').slice(2)) {
  assert.match(segment, /^[A-Za-z0-9._~-]+$/u, `invalid route segment ${segment}`)
}

console.log('status route checks passed')
