/**
 * Curation tests: the picker should show chat models, not DuMate's plumbing.
 *
 * Runs without a live DuMate instance — the synthetic table covers the alias and
 * hide rules, and the live section is skipped when no catalog file exists.
 */
import assert from 'node:assert/strict'
import { curateEntries, readCatalog } from '../src/upstream/discovery.js'

const entry = (key, id = key) => ({ key, model: { id }, preferred: id })

const synthetic = [
  entry('deepseek-v4-pro'),
  entry('glm-5', 'model-text'),
  entry('model-text'),
  entry('model-routing'),
  entry('dm-auto-model/text.L1'),
  entry('qwen3-embedding-4b'),
  entry('qianfan-ocr'),
  entry('llm-mock'),
  entry('kimi-k3'),
]

const curated = curateEntries(synthetic)
const curatedIds = curated.map(model => model.id).sort()
assert.deepEqual(curatedIds, ['deepseek-v4-pro', 'kimi-k3', 'model-text'])
assert.equal(curated.find(model => model.id === 'model-text').name, 'GLM 5', 'the alias should carry the friendly label')

const all = curateEntries(synthetic, { mode: 'all' })
assert.equal(all.length, 9)
assert.ok(all.some(model => model.id === 'model-text'), 'raw mode keeps the self-named key')
assert.ok(all.some(model => model.id === 'glm-5'), 'raw mode keeps the alias under its key')

const narrowed = curateEntries(synthetic, { exclude: ['KIMI'] }).map(model => model.id)
assert.ok(!narrowed.includes('kimi-k3'), 'exclude matches case-insensitively by substring')

const allHidden = curateEntries([entry('model-routing')])
assert.equal(allHidden.length, 1, 'curation never strands the picker')

const live = readCatalog()
if (live === null) {
  console.log('curation: synthetic checks passed (no live catalog file present)')
} else {
  const curatedLive = live.models.length
  const rawLive = readCatalog({ mode: 'all' }).models.length
  assert.ok(curatedLive > 0 && rawLive >= curatedLive, 'the live table must shrink under curation')
  const plumbing = live.models.filter(model => /^model-(?!text$)/.test(model.id)
    || /^dm-auto-model\//.test(model.id)
    || /embedding|rerank|ocr|mock/i.test(model.id))
  assert.equal(plumbing.length, 0, `curated view still contains plumbing: ${plumbing.map(model => model.id).join(', ')}`)
  console.log(`curation: synthetic checks passed; live ${curatedLive} of ${rawLive} models shown`)
}
