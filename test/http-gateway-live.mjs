/**
 * Live check of the HTTP gateway against a running DuMate.
 *
 * Sends exactly one small completion (8 tokens) so it does not trip the app's
 * per-user rate limit; run it once, not on a loop.
 */
import { startGateway } from '../src/gateway/server.js'
import { readCatalog } from '../src/upstream/discovery.js'
import { isReachable } from '../src/upstream/health.js'
import { streamChatCompletion } from '../src/upstream/openai-client.js'

class SkipAfterRateLimit extends Error {}

const catalog = readCatalog({ force: true })
if (catalog === null) {
  console.log('live gateway: skipped (no DuMate config on this machine)')
  process.exit(0)
}

const model = catalog.models.find(entry => entry.id === 'deepseek-v4-flash-0731')?.id ?? catalog.models[0].id
const gateway = await startGateway({ port: 0, version: 'live', readCatalog, isReachable, streamChatCompletion, logger: { info() {} } })

let checks = 0
try {
  const health = await (await fetch(`${gateway.url}/health`)).json()
  if (health.upstream.online !== true) throw new Error('health did not report the upstream as online')
  checks += 1

  const models = await (await fetch(`${gateway.url}/v1/models`)).json()
  if (!models.data.some(entry => entry.id === model)) throw new Error(`/v1/models is missing ${model}`)
  checks += 1

  const started = Date.now()
  const response = await fetch(`${gateway.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with just the digit 3.' }], max_tokens: 8 }),
  })
  const body = await response.json()
  if (response.status === 429) {
    // The desktop app limits a user's request rate; that is a real answer, not a
    // gateway defect. Report it and stop instead of retrying.
    console.log(`live gateway: upstream rate limit hit (${body.error?.code}); not retrying`)
    process.exitCode = 0
    throw new SkipAfterRateLimit()
  }
  if (response.status !== 200) throw new Error(`chat failed: ${response.status} ${JSON.stringify(body)}`)
  const text = body.choices?.[0]?.message?.content ?? ''
  if (!text.includes('3')) throw new Error(`unexpected answer: ${JSON.stringify(text)}`)
  checks += 1
  console.log(`live gateway: model ${model} answered ${JSON.stringify(text.trim())} in ${Date.now() - started} ms`)
} catch (error) {
  if (!(error instanceof SkipAfterRateLimit)) throw error
} finally {
  await gateway.close()
}

console.log(`live gateway: ${checks} checks passed`)
