/**
 * The `gateway` provider route: advertises the models the local DuMate proxy
 * serves and forwards each call to it, projecting the reply into the harness
 * stream protocol.
 *
 * The class is a structural LlmAdapter. It deliberately imports nothing from
 * `@deepseek-ai/dsh-llm`: the harness validates the shape at registration time,
 * and staying dependency-free keeps the installed profile free of extra
 * resolution rules.
 */
import { GatewayError, llmFailure } from './failure.js'
import { toOpenAIMessages, toOpenAITools } from './messages.js'
import { invalidateCatalog, readCatalog, setBaseURLOverride } from './upstream/discovery.js'
import { isReachable } from './upstream/health.js'
import { streamChatCompletion } from './upstream/openai-client.js'

export const PROVIDER = 'gateway'

const DISPLAY_NAME = 'DuMate gateway'
const PLACEHOLDER_ID = 'hello'
const PLACEHOLDER_TEXT = [
  'The DuMate gateway has no live model catalog yet.',
  'Start the DuMate desktop app, or press Start headless in the DuMate panel (headless mode starts nothing by itself), and reopen the model selector; the gateway reads its catalog from the installed app.',
].join(' ')

export class GatewayAdapter {
  /**
   * @param {Record<string, any>} [config] - the plugin row's config.
   * @param {{
   *   headless?: {ensure: () => Promise<string | null>} | null,
   *   images?: ((block: any) => Promise<string | null>) | null,
   * }} [options]
   *   `headless` starts the two DuMate background binaries when the desktop app
   *   is not running; the adapter only asks it for a base URL, it never spawns.
   *   `images` turns one harness image block into a `data:` URL; when it is
   *   absent the block degrades to placeholder text.
   */
  constructor(config = {}, options = {}) {
    this.config = config
    this.headless = options.headless ?? null
    this.images = options.images ?? null
    const models = config.models ?? {}
    this.modelsMode = models.mode === 'all' ? 'all' : 'curated'
    this.modelsExclude = Array.isArray(models.exclude)
      ? models.exclude.filter(value => typeof value === 'string' && value !== '')
      : []
  }

  providerInfo(provider) {
    return { id: provider, name: DISPLAY_NAME }
  }

  /** No retry policy: the runtime's default is the honest choice until the route has evidence. */
  providerRetryPolicy() {
    return undefined
  }

  async listModels(provider) {
    const catalog = this.catalog()
    if (catalog === null || catalog.models.length === 0) {
      return [placeholderModel(provider)]
    }
    return catalog.models.map(model => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    }))
  }

  resolveModel(provider, model) {
    const catalog = this.catalog()
    const found = catalog?.models.find(entry => entry.id === model)

    if (found === undefined) {
      return { provider, id: model, name: model }
    }

    return {
      provider,
      id: found.id,
      name: found.name,
      inputModalities: found.inputModalities,
      ...(found.contextWindow === undefined ? {} : { context: { contextWindow: found.contextWindow } }),
      ...(found.maxTokens === undefined ? {} : { defaultMaxTokens: found.maxTokens }),
    }
  }

  async prepareCall(provider, model) {
    const resolved = this.resolveModel(provider, model)
    return {
      model: resolved,
      stream: options => this.stream({ ...options, provider, model, resolved }),
    }
  }

  async *stream(options) {
    const resolved = options.resolved ?? this.resolveModel(options.provider, options.model)

    if (resolved.id === PLACEHOLDER_ID) {
      yield* placeholderStream(options)
      return
    }

    const catalog = await this.reachableCatalog()
    if (catalog === null) {
      throw new GatewayError(llmFailure('DISCOVERY_FAILED', 'No DuMate catalog was found. Start the DuMate desktop app.'))
    }

    const events = streamChatCompletion({
      baseURL: catalog.baseURL,
      apiKey: catalog.apiKey,
      model: resolved.id,
      messages: await toOpenAIMessages({
        messages: options.messages,
        system: options.system,
        resolveImage: this.images,
      }),
      tools: toOpenAITools(options.tools),
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      stop: options.stop,
      signal: options.signal,
      kind: 'dsh',
    })

    yield* project(events, options.signal)
  }

  catalog() {
    return readCatalog({ mode: this.modelsMode, exclude: this.modelsExclude })
  }

  /**
   * The catalog, with one headless start attempted when the proxy is not there.
   *
   * A cold start takes a few seconds, which is exactly why it happens on a chat
   * request rather than on every listing: the model picker must stay instant.
   */
  async reachableCatalog() {
    let catalog = this.catalog()

    if (catalog === null) {
      await this.tryHeadless()
      return this.catalog()
    }

    if (this.config.requireReachable === false) return catalog
    if (await isReachable(catalog.baseURL)) return catalog

    await this.tryHeadless()
    const recovered = this.catalog()
    if (recovered !== null && await isReachable(recovered.baseURL)) return recovered

    const shown = recovered ?? catalog
    throw new GatewayError(llmFailure('TRANSPORT', `The DuMate proxy at ${shown.baseURL} is not accepting connections.`))
  }

  /** Ask headless mode for a base URL and point discovery at it. Never throws. */
  async tryHeadless() {
    if (this.headless === null) return null
    let baseURL = null
    try {
      baseURL = await this.headless.ensure()
    } catch {
      return null
    }
    if (baseURL === null) return null
    setBaseURLOverride(baseURL)
    invalidateCatalog()
    return baseURL
  }
}

/**
 * Project semantic upstream events onto harness chunks.
 *
 * Invariants enforced here: one `block-start` per block, `block-end` carries the
 * assembled block, `usage` precedes `finish`, and nothing follows `finish`.
 */
async function* project(events, signal) {
  let index = 0
  /** @type {null | {index: number, type: 'text' | 'reasoning' | 'tool-call', text: string, id?: string, name?: string, args?: string}} */
  let open = null
  let finished = false

  function* close() {
    if (open === null) return
    const block = open.type === 'tool-call'
      ? { type: 'tool-call', id: open.id ?? '', name: open.name ?? '', arguments: open.args ?? '' }
      : { type: open.type, text: open.text }
    yield { type: 'block-end', index: open.index, block }
    open = null
  }

  function* openBlock(type) {
    open = { index: index, type, text: '', ...(type === 'tool-call' ? { id: '', name: '', args: '' } : {}) }
    index += 1
    yield { type: 'block-start', index: open.index, blockType: type }
  }

  try {
    for await (const event of events) {
      if (signal?.aborted === true) {
        yield* close()
        yield {
          type: 'finish',
          reason: { kind: 'aborted', failure: llmFailure('ABORTED', 'The request was cancelled.') },
        }
        return
      }

      if (event.kind === 'usage') {
        yield* close()
        yield { type: 'usage', usage: event.usage }
        continue
      }

      if (event.kind === 'finish') {
        yield* close()
        finished = true
        yield { type: 'finish', reason: event.reason }
        return
      }

      if (event.kind === 'reasoning' || event.kind === 'text') {
        if (open === null || open.type !== event.kind) {
          yield* close()
          yield* openBlock(event.kind)
        }
        if (event.kind === 'reasoning') open.text += event.text
        else open.text += event.text
        yield event.kind === 'reasoning'
          ? { type: 'reasoning-delta', index: open.index, text: event.text }
          : { type: 'text-delta', index: open.index, text: event.text }
        continue
      }

      if (event.kind === 'tool-call') {
        if (open === null || open.type !== 'tool-call' || (open.id !== '' && event.id !== '' && open.id !== event.id)) {
          yield* close()
          yield* openBlock('tool-call')
          open.id = event.id
          open.name = event.name ?? ''
        } else if (event.name !== undefined && open.name === '') {
          open.name = event.name
        }
        open.args += event.argumentsDelta
        yield {
          type: 'tool-call-delta',
          index: open.index,
          id: event.id || open.id,
          ...(event.name === undefined ? {} : { name: event.name }),
          argumentsDelta: event.argumentsDelta,
        }
      }
    }
  } catch (error) {
    yield* close()
    if (finished) return
    const cancelled = signal?.aborted === true
      || (error instanceof GatewayError && error.failure.code === 'ABORTED')
    if (cancelled) {
      yield {
        type: 'finish',
        reason: { kind: 'aborted', failure: llmFailure('ABORTED', 'The request was cancelled.') },
      }
      return
    }
    const failure = error instanceof GatewayError
      ? error.failure
      : llmFailure('UNKNOWN', error instanceof Error ? error.message : String(error))
    yield { type: 'finish', reason: { kind: 'error', failure } }
    return
  }

  yield* close()
  if (!finished) {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function placeholderModel(provider) {
  return {
    provider,
    id: PLACEHOLDER_ID,
    name: 'Hello (no DuMate running)',
    description: 'Explains how to start the DuMate app. Sends no request anywhere.',
    inputModalities: ['text'],
    contextWindow: 131072,
    defaultMaxTokens: 8192,
  }
}

async function* placeholderStream(options = {}) {
  const signal = options.signal
  let text = ''
  yield { type: 'block-start', index: 0, blockType: 'text' }
  for (const part of splitIntoThirds(PLACEHOLDER_TEXT)) {
    if (signal?.aborted === true) {
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield {
        type: 'finish',
        reason: { kind: 'aborted', failure: llmFailure('ABORTED', 'The request was cancelled.') },
      }
      return
    }
    await new Promise(resolve => setTimeout(resolve, 40))
    text += part
    yield { type: 'text-delta', index: 0, text: part }
  }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: PLACEHOLDER_TEXT } }
  yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function splitIntoThirds(text) {
  const size = Math.ceil(text.length / 3)
  return [text.slice(0, size), text.slice(size, size * 2), text.slice(size * 2)]
}
