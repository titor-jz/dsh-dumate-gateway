/**
 * Usage accounting: every path through streamChatCompletion records one row,
 * the panel's status payload reads the snapshot, and nothing leaves the machine.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { record, snapshot, reset } from '../src/usage.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-gateway-usage-'))
process.env.DSH_HOME = home

reset()
const empty = snapshot()
assert.match(empty.today, /^\d{4}-\d{2}-\d{2}$/)
assert.equal(empty.requests, 0)
assert.equal(empty.input_tokens, 0)
assert.equal(empty.output_tokens, 0)
assert.equal(empty.errors, 0)
assert.deepEqual(empty.days, [])

record({ kind: 'dsh', model: 'model-text', usage: { inputTokens: 1200, outputTokens: 300, reasoningTokens: 80 }, ms: 900 })
record({ kind: 'http', model: 'qwen3.8-max', usage: { inputTokens: 40, outputTokens: 12 }, ms: 120 })
record({ kind: 'try', model: 'model-text', usage: null, ok: false, code: 'RATE_LIMIT', ms: 30 })

const one = snapshot()
assert.equal(one.requests, 3)
assert.equal(one.input_tokens, 1240)
assert.equal(one.output_tokens, 312)
assert.equal(one.errors, 1)
assert.equal(one.by_kind.dsh.requests, 1)
assert.equal(one.by_kind.http.input_tokens, 40)
assert.equal(one.by_kind.try.errors, 1)
assert.equal(one.days.length, 1)
assert.equal(one.days[0].date, one.today)
assert.equal(one.last.code, 'RATE_LIMIT')
assert.equal(one.last.model, 'model-text')

// The file is the contract: the panel and any later process read the same rows.
const file = path.join(home, 'dumate-gateway', 'usage.json')
const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
assert.equal(saved.version, 1)
assert.equal(saved.days[one.today].requests, 3)

// A malformed file is treated as empty, never as an error.
fs.writeFileSync(file, '{not json')
const reloaded = await import(`../src/usage.js?fresh=${Date.now()}`)
const afterGarbage = reloaded.snapshot()
assert.equal(afterGarbage.requests, 0)

// reset() wipes both memory and disk.
reset()
assert.equal(snapshot().requests, 0)
assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).days[snapshot().today], undefined)

console.log('usage checks passed')
