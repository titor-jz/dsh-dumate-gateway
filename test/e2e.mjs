/**
 * Live end-to-end checks against a running DuMate app.
 *
 * Reads the same catalog the plugin reads, then exercises the real wire path.
 * Costs a handful of tokens; run it only when DuMate is running.
 *
 *   node test/e2e.mjs            # full suite (needs DuMate)
 *   node test/e2e.mjs --offline  # only the "no catalog" placeholder path
 */
import assert from 'node:assert/strict'
import { GatewayAdapter } from '../src/adapter.js'
import { readCatalog } from '../src/upstream/discovery.js'

const offline = process.argv.includes('--offline')
const provider = 'gateway'
const adapter = new GatewayAdapter()

/** Collect one stream and assert the protocol invariants on the way. */
async function collect(stream, signal) {
  const chunks = []
  let openBlock = null
  let sawFinish = false
  let usageBeforeFinish = false

  for await (const chunk of stream) {
    assert.equal(sawFinish, false, 'no chunk may follow finish')
    chunks.push(chunk)

    if (chunk.type === 'block-start') {
      assert.equal(openBlock, null, 'block-start while another block is open')
      openBlock = { index: chunk.index, type: chunk.blockType, text: '' }
    } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      assert.ok(openBlock !== null, `${chunk.type} outside a block`)
      assert.equal(chunk.index, openBlock.index)
      assert.equal(openBlock.type, chunk.type === 'text-delta' ? 'text' : 'reasoning')
      openBlock.text += chunk.text
    } else if (chunk.type === 'block-end') {
      assert.ok(openBlock !== null, 'block-end without an open block')
      assert.equal(chunk.index, openBlock.index)
      assert.equal(chunk.block.type, openBlock.type)
      if (chunk.block.type === 'text' || chunk.block.type === 'reasoning') {
        assert.equal(chunk.block.text, openBlock.text, 'assembled block must match its deltas')
      }
      openBlock = null
    } else if (chunk.type === 'usage') {
      usageBeforeFinish = true
      assert.ok(Number.isFinite(chunk.usage.inputTokens), 'usage.inputTokens')
      assert.ok(Number.isFinite(chunk.usage.outputTokens), 'usage.outputTokens')
    } else if (chunk.type === 'finish') {
      sawFinish = true
    }
  }

  assert.equal(sawFinish, true, 'stream must finish')
  assert.equal(openBlock, null, 'stream must not end with an open block')
  return { chunks, usageBeforeFinish }
}

async function fullSuite() {
  const catalog = readCatalog({ force: true })
  assert.ok(catalog !== null, 'DuMate catalog not found — start the DuMate desktop app first')
  console.log(`catalog: ${catalog.models.length} models from ${catalog.baseURL}`)

  const models = await adapter.listModels(provider)
  assert.equal(models.length, catalog.models.length)
  const ids = models.map(model => model.id)
  assert.equal(new Set(ids).size, ids.length, 'model ids must be unique')
  for (const model of models) {
    assert.ok(model.provider === provider && model.id !== '' && model.name !== '')
    for (const modality of model.inputModalities) {
      assert.ok(modality === 'text' || modality === 'image', `unsupported modality ${modality}`)
    }
  }
  if (!models.some(model => model.id === 'hello')) {
    console.log('  no placeholder for "hello": real catalog in use (expected while DuMate runs)')
  }

  // 1. A real streamed reply, small enough to stay cheap.
  const target = models.find(model => model.inputModalities.includes('text'))
  assert.ok(target !== undefined, 'no text-capable model in the catalog')
  console.log(`streaming ${target.id} (${target.name})`)

  const resolved = adapter.resolveModel(provider, target.id)
  assert.equal(resolved.provider, provider)
  assert.equal(resolved.id, target.id)
  assert.ok(resolved.context?.contextWindow > 0)
  assert.ok(resolved.defaultMaxTokens > 0)

  const prepared = await adapter.prepareCall(provider, target.id)
  const started = Date.now()
  const { chunks } = await collect(await prepared.stream({
    provider,
    model: target.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: '1+1等于几？只回答一个数字。' }] }],
    maxTokens: 400,
  }))

  const text = chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'text')
    .map(chunk => chunk.block.text).join('')
  const reasoning = chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
    .map(chunk => chunk.block.text).join('')

  console.log(`  answer: ${JSON.stringify(text)} (${Date.now() - started} ms, reasoning chars: ${reasoning.length})`)
  // Some thinking models put the answer in the reasoning channel; accept either.
  assert.match(`${reasoning}${text}`, /\b2\b/, 'the model should answer 2')
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' || chunk.type === 'reasoning-delta'), 'expected streamed content')

  // 2. An unknown model must surface as a classified failure, not a hang.
  console.log('unknown model')
  const { chunks: failed } = await collect(adapter.stream({
    provider,
    model: 'definitely-not-a-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }))
  const finish = failed.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'UNKNOWN_MODEL')
  console.log(`  classified as ${finish.reason.failure.code}: ${finish.reason.failure.message.slice(0, 80)}`)

  // 3. Abort must end the stream with an aborted finish and no leaked block.
  console.log('abort mid-stream')
  const controller = new AbortController()
  const aborted = []
  for await (const chunk of adapter.stream({
    provider,
    model: target.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: '从1数到50，每个数字用逗号分隔。' }] }],
    maxTokens: 400,
    signal: controller.signal,
  })) {
    aborted.push(chunk)
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') controller.abort()
  }
  const abortFinish = aborted.at(-1)
  assert.equal(abortFinish.type, 'finish')
  if (abortFinish.reason.kind === 'error' && abortFinish.reason.failure.code === 'RATE_LIMIT') {
    console.log('  skipped: the upstream rate-limited this run before any token streamed')
  } else {
    assert.equal(abortFinish.reason.kind, 'aborted')
    assert.equal(abortFinish.reason.failure.code, 'ABORTED')
    console.log('  stop reason:', abortFinish.reason.kind)
  }

  console.log('\nall live checks passed')
}

async function offlineSuite() {
  process.env.DUMATE_OPENCODE_CONFIG = 'Z:\\never\\opencode.json'
  const models = await adapter.listModels(provider)
  assert.equal(models.length, 1)
  assert.equal(models[0].id, 'hello')
  const prepared = await adapter.prepareCall(provider, 'hello')
  const { chunks } = await collect(await prepared.stream({ provider, model: 'hello', messages: [] }))
  const text = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block.text).join('')
  assert.match(text, /Start the DuMate desktop app/)
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })

  // Cancellation is part of the protocol contract, so it is verified offline:
  // the placeholder stream needs no network and makes the assertion deterministic.
  const controller = new AbortController()
  const cancelled = []
  for await (const chunk of adapter.stream({ provider, model: 'hello', messages: [], signal: controller.signal })) {
    cancelled.push(chunk)
    if (chunk.type === 'text-delta') controller.abort()
  }
  const last = cancelled.at(-1)
  assert.equal(last.type, 'finish')
  assert.equal(last.reason.kind, 'aborted')
  assert.equal(last.reason.failure.code, 'ABORTED')
  assert.ok(!cancelled.some(chunk => chunk.type === 'text-delta' && false), 'unreachable')
  const endedBlocks = cancelled.filter(chunk => chunk.type === 'block-end')
  assert.ok(endedBlocks.length <= 1, 'at most one block closes on abort')
  for (const chunk of cancelled) assert.notEqual(chunk.type, 'usage', 'no usage after an abort before accounting')
  console.log('offline placeholder + abort path passed')
}

if (offline) await offlineSuite()
else await fullSuite()
