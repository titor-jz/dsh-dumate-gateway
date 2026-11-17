// Same-origin "try it" route: one small chat completion, run by the host on
// behalf of the sidebar panel.
//
// Why a host route instead of calling the loopback gateway from the page: the
// page may be served from another origin, and a POST with a JSON body is exactly
// the kind of request a page policy refuses. The host already holds the model
// catalog, so it can also measure first-token latency without exposing anything.
//
// This route deliberately spends quota (one short completion), which is why it is
// the only place in the plugin that does: the request has to be a human pressing
// a button, and the prompt is capped.
import { GatewayError } from '../failure.js'
import { readCatalog } from '../upstream/discovery.js'
import { streamChatCompletion } from '../upstream/openai-client.js'

export const TRY_PATH = '/api/dumate-gateway/try'

const MAX_PROMPT_CHARS = 2000
// A reasoning model can spend the whole budget thinking, so the default leaves
// room for a short visible answer after the thinking tokens.
const DEFAULT_MAX_TOKENS = 256
const HARD_MAX_TOKENS = 512
const TIMEOUT_MS = 60000

/**
 * @param {object} [options]
 * @param {typeof readCatalog} [options.catalog]
 * @param {typeof streamChatCompletion} [options.stream]
 * @param {'curated' | 'all'} [options.modelsMode]
 * @param {readonly string[]} [options.modelsExclude]
 * @param {number} [options.timeoutMs]
 */
export function createTryHandler({
  catalog = readCatalog,
  stream = streamChatCompletion,
  modelsMode = 'curated',
  modelsExclude = [],
  timeoutMs = TIMEOUT_MS,
} = {}) {
  return async function handleTry(request) {
    let body
    try {
      body = await request.json()
    } catch {
      return json(400, { error: 'invalid_json', message: 'The request body must be JSON.' })
    }

    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
    if (prompt === '') {
      return json(400, { error: 'invalid_request', message: '`prompt` must be a non-empty string.' })
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return json(400, { error: 'invalid_request', message: `Keep the prompt under ${MAX_PROMPT_CHARS} characters.` })
    }

    const maxTokens = clampTokens(body?.max_tokens)

    let snapshot
    try {
      snapshot = await catalog({ mode: modelsMode, exclude: modelsExclude })
    } catch (error) {
      return json(503, {
        error: 'upstream_unavailable',
        message: 'No DuMate state file was found. Start the DuMate desktop app and try again.',
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    const models = Array.isArray(snapshot?.models) ? snapshot.models : []
    if (models.length === 0 || typeof snapshot?.baseURL !== 'string') {
      return json(503, {
        error: 'upstream_unavailable',
        message: 'DuMate has not published a model table yet. Start the app and try again.',
      })
    }

    const requested = typeof body?.model === 'string' && body.model !== '' ? body.model : null
    const model = requested !== null && models.some(entry => entry.id === requested)
      ? requested
      : models[0].id

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const startedAt = Date.now()
    let firstTokenMs = null
    let text = ''
    let reasoning = ''
    let usage = null
    let finish = 'stop'

    try {
      for await (const event of stream({
        baseURL: snapshot.baseURL,
        apiKey: typeof snapshot.apiKey === 'string' ? snapshot.apiKey : null,
        model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens,
        signal: controller.signal,
        kind: 'try',
      })) {
        if (firstTokenMs === null && (event.kind === 'text' || event.kind === 'reasoning')) {
          firstTokenMs = Date.now() - startedAt
        }
        if (event.kind === 'text') text += event.text
        else if (event.kind === 'reasoning') reasoning += event.text
        else if (event.kind === 'usage') usage = event.usage
        else if (event.kind === 'finish') finish = event.reason?.kind ?? 'stop'
      }
    } catch (error) {
      const failure = error instanceof GatewayError
        ? error.failure
        : { code: 'TRANSPORT', message: error instanceof Error ? error.message : String(error) }
      return json(statusOf(failure.code), {
        error: failure.code,
        message: failure.message,
        model,
        first_token_ms: firstTokenMs,
        total_ms: Date.now() - startedAt,
      })
    } finally {
      clearTimeout(timer)
    }

    return json(200, {
      ok: true,
      model,
      text,
      ...(reasoning === '' ? {} : { reasoning }),
      usage,
      finish,
      first_token_ms: firstTokenMs,
      total_ms: Date.now() - startedAt,
    })
  }
}

function clampTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_MAX_TOKENS
  return Math.min(Math.floor(value), HARD_MAX_TOKENS)
}

function statusOf(code) {
  switch (code) {
    case 'UNKNOWN_MODEL':
      return 404
    case 'AUTH':
      return 401
    case 'QUOTA':
      return 402
    case 'RATE_LIMIT':
      return 429
    case 'INVALID_REQUEST':
      return 400
    case 'ABORTED':
      return 504
    default:
      return 502
  }
}

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
