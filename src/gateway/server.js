/**
 * Loopback HTTP gateway: OpenAI and (minimal) Anthropic compatible endpoints.
 *
 * The plugin's LLM adapter already speaks to DuMate; this file re-exposes the
 * same upstream to ordinary clients (curl, Claude Code, scripts) without
 * duplicating any transport logic: it calls the same semantic-event stream and
 * re-serializes it in each protocol's wire shape.
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { failureFromResponse, llmFailure, GatewayError } from '../failure.js'
import { effortFromAnthropic, effortFromOpenAI, thinkingPayload } from '../reasoning.js'

const MAX_BODY_BYTES = 2 * 1024 * 1024
const HOST = '127.0.0.1'
const UPSTREAM_NAME = 'dumate'

/**
 * @param {{
 *   port?: number,
 *   token?: string | null,
 *   version?: string,
 *   readCatalog: () => null | {baseURL: string, models: Array<{id: string, name?: string, inputModalities?: string[], contextWindow?: number, maxTokens?: number}>},
 *   isReachable: (baseURL: string, timeoutMs?: number) => Promise<boolean>,
 *   streamChatCompletion: (options: any) => AsyncIterable<any>,
 *   logger?: {info?: Function, warn?: Function},
 * }} options
 */
export async function startGateway(options) {
  const {
    port = 7321,
    token = null,
    version = '0.0.0.0',
    readCatalog,
    isReachable,
    streamChatCompletion,
    logger = console,
  } = options

  const server = createServer((req, res) => {
    handle(req, res, { token, version, readCatalog, isReachable, streamChatCompletion }).catch(error => {
      logger.warn?.(`[dumate-gateway] unhandled request error: ${describe(error)}`)
      if (!res.headersSent) sendJson(req, res, 500, { error: { message: 'Internal gateway error.', type: 'server_error' } })
      else res.end()
    })
  })

  const boundPort = await listenWithFallback(server, port)
  logger.info?.(`[dumate-gateway] http gateway listening on http://${HOST}:${boundPort}`)

  return {
    host: HOST,
    port: boundPort,
    url: `http://${HOST}:${boundPort}`,
    async close() {
      await new Promise(resolve => server.close(() => resolve(undefined)))
    },
  }
}

async function handle(req, res, deps) {
  const url = new URL(req.url ?? '/', `http://${HOST}`)
  const path = url.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...cors(req), 'access-control-max-age': '600', 'content-length': '0' })
    res.end()
    return
  }

  if (!authorized(req, deps.token)) {
    sendJson(req, res, 401, { error: { message: 'Missing or invalid gateway token.', type: 'authentication_error' } })
    return
  }

  if (req.method === 'GET' && path === '/health') {
    await handleHealth(req, res, deps)
    return
  }

  if (req.method === 'GET' && path === '/v1/models') {
    handleModels(req, res, deps)
    return
  }

  if (req.method === 'POST' && path === '/v1/chat/completions') {
    await handleChatCompletions(req, res, deps)
    return
  }

  if (req.method === 'POST' && path === '/v1/messages') {
    await handleAnthropicMessages(req, res, deps)
    return
  }

  sendJson(req, res, 404, { error: { message: `No route for ${req.method} ${path}.`, type: 'not_found' } })
}

async function handleHealth(req, res, deps) {
  const catalog = deps.readCatalog()
  const online = catalog === null ? false : await deps.isReachable(catalog.baseURL)
  sendJson(req, res, 200, {
    ok: true,
    gateway: { version: deps.version, upstream: UPSTREAM_NAME },
    upstream: {
      name: UPSTREAM_NAME,
      baseURL: catalog?.baseURL ?? null,
      online,
      models: catalog?.models.length ?? 0,
    },
  })
}

function handleModels(req, res, deps) {
  const catalog = deps.readCatalog()
  const data = (catalog?.models ?? []).map(model => ({
    id: model.id,
    object: 'model',
    created: 0,
    owned_by: UPSTREAM_NAME,
    ...(model.name ? { name: model.name } : {}),
    ...(model.contextWindow ? { context_window: model.contextWindow } : {}),
    ...(model.maxTokens ? { max_tokens: model.maxTokens } : {}),
    ...(model.inputModalities ? { input_modalities: model.inputModalities } : {}),
  }))
  sendJson(req, res, 200, { object: 'list', data })
}

async function handleChatCompletions(req, res, deps) {
  let body
  try {
    body = await readJsonBody(req)
  } catch (error) {
    sendJson(req, res, 400, { error: { message: describe(error), type: 'invalid_request_error' } })
    return
  }

  const model = typeof body?.model === 'string' ? body.model : ''
  if (model === '') {
    sendJson(req, res, 400, { error: { message: '`model` is required.', type: 'invalid_request_error' } })
    return
  }
  const messages = Array.isArray(body?.messages) ? body.messages : null
  if (messages === null) {
    sendJson(req, res, 400, { error: { message: '`messages` must be an array.', type: 'invalid_request_error' } })
    return
  }

  const upstream = await resolveUpstream(deps, model)
  if ('error' in upstream) {
    sendJson(req, res, upstream.status, upstream.error)
    return
  }

  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) controller.abort()
  })

  const events = deps.streamChatCompletion({
    baseURL: upstream.catalog.baseURL,
    apiKey: upstream.catalog.apiKey ?? null,
    model,
    messages: toOpenAIMessages(body),
    tools: Array.isArray(body?.tools) ? body.tools : undefined,
    temperature: typeof body?.temperature === 'number' ? body.temperature : undefined,
    maxTokens: numberOr(body?.max_tokens ?? body?.max_completion_tokens),
    stop: Array.isArray(body?.stop) ? body.stop : typeof body?.stop === 'string' ? [body.stop] : undefined,
    thinking: thinkingPayload(effortFromOpenAI(body?.reasoning_effort)),
    signal: controller.signal,
    kind: 'http',
  })

  if (body?.stream === true) {
    await streamOpenAICompletions(req, res, { model, events })
  } else {
    await completeOpenAICompletions(req, res, { model, events })
  }
}

async function streamOpenAICompletions(req, res, { model, events }) {
  const iterator = events[Symbol.asyncIterator]()
  let first
  try {
    first = await iterator.next()
  } catch (error) {
    const failure = failureOf(error)
    sendJson(req, res, statusOf(failure), { error: { message: failure.message, type: 'upstream_error', code: failure.code } })
    return
  }

  res.writeHead(200, {
    ...cors(req),
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })

  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const ctx = { id, created, model, toolIndex: new Map() }

  try {
    if (!first.done) writeOpenAIEvent(res, ctx, first.value)
    while (true) {
      const next = await iterator.next()
      if (next.done) break
      writeOpenAIEvent(res, ctx, next.value)
    }
  } catch (error) {
    const failure = failureOf(error)
    writeSse(res, { error: { message: failure.message, type: 'upstream_error', code: failure.code } })
  }

  writeSse(res, '[DONE]')
  res.end()
}

function writeOpenAIEvent(res, ctx, event) {
  const base = { id: ctx.id, object: 'chat.completion.chunk', created: ctx.created, model: ctx.model }

  if (event.kind === 'text' || event.kind === 'reasoning') {
    const delta = event.kind === 'text' ? { content: event.text } : { reasoning_content: event.text }
    writeSse(res, { ...base, choices: [{ index: 0, delta, finish_reason: null }] })
    return
  }

  if (event.kind === 'tool-call') {
    const key = event.id || event.name || ''
    if (!ctx.toolIndex.has(key)) ctx.toolIndex.set(key, ctx.toolIndex.size)
    const index = ctx.toolIndex.get(key)
    writeSse(res, {
      ...base,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index,
            ...(event.id ? { id: event.id } : {}),
            type: 'function',
            function: { ...(event.name ? { name: event.name } : {}), arguments: event.argumentsDelta ?? '' },
          }],
        },
        finish_reason: null,
      }],
    })
    return
  }

  if (event.kind === 'usage') {
    writeSse(res, { ...base, choices: [], usage: toOpenAIUsage(event.usage) })
    return
  }

  if (event.kind === 'finish') {
    writeSse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: toOpenAIFinish(event.reason) }] })
  }
}

async function completeOpenAICompletions(req, res, { model, events }) {
  let reasoning = ''
  let text = ''
  const toolCalls = []
  let usage = null
  let finish = { kind: 'stop' }

  try {
    for await (const event of events) {
      if (event.kind === 'text') text += event.text
      else if (event.kind === 'reasoning') reasoning += event.text
      else if (event.kind === 'tool-call') toolCalls.push(event)
      else if (event.kind === 'usage') usage = event.usage
      else if (event.kind === 'finish') finish = event.reason
    }
  } catch (error) {
    const failure = failureOf(error)
    sendJson(req, res, statusOf(failure), { error: { message: failure.message, type: 'upstream_error', code: failure.code } })
    return
  }

  const message = { role: 'assistant', content: text }
  if (reasoning !== '') message.reasoning_content = reasoning
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((call, index) => ({
      index,
      id: call.id || `call_${index}`,
      type: 'function',
      function: { name: call.name ?? '', arguments: call.argumentsDelta ?? '' },
    }))
  }

  sendJson(req, res, 200, {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: toOpenAIFinish(finish) }],
    ...(usage ? { usage: toOpenAIUsage(usage) } : {}),
  })
}

async function handleAnthropicMessages(req, res, deps) {
  let body
  try {
    body = await readJsonBody(req)
  } catch (error) {
    sendJson(req, res, 400, { type: 'error', error: { type: 'invalid_request_error', message: describe(error) } })
    return
  }

  const model = typeof body?.model === 'string' ? body.model : ''
  if (model === '') {
    sendJson(req, res, 400, { type: 'error', error: { type: 'invalid_request_error', message: '`model` is required.' } })
    return
  }

  const upstream = await resolveUpstream(deps, model)
  if ('error' in upstream) {
    sendJson(req, res, upstream.status, { type: 'error', error: { type: 'invalid_request_error', message: upstream.error.error.message } })
    return
  }

  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) controller.abort()
  })

  const { messages, system } = fromAnthropicMessages(body)
  const events = deps.streamChatCompletion({
    baseURL: upstream.catalog.baseURL,
    apiKey: upstream.catalog.apiKey ?? null,
    model,
    messages,
    system,
    tools: Array.isArray(body?.tools) ? toOpenAITools(body.tools) : undefined,
    temperature: typeof body?.temperature === 'number' ? body.temperature : undefined,
    maxTokens: numberOr(body?.max_tokens),
    stop: Array.isArray(body?.stop_sequences) ? body.stop_sequences : undefined,
    // Anthropic clients send `thinking: {type: 'enabled'|'disabled'}`; it maps
    // onto the same two upstream levels, so a Claude client can turn thinking
    // off without a special case here.
    thinking: thinkingPayload(effortFromAnthropic(body?.thinking)),
    signal: controller.signal,
    kind: 'http',
  })

  if (body?.stream === true) {
    await streamAnthropicMessages(req, res, { model, events })
  } else {
    await completeAnthropicMessages(req, res, { model, events })
  }
}

async function streamAnthropicMessages(req, res, { model, events }) {
  const iterator = events[Symbol.asyncIterator]()
  let first
  try {
    first = await iterator.next()
  } catch (error) {
    const failure = failureOf(error)
    sendJson(req, res, statusOf(failure), { type: 'error', error: { type: 'api_error', message: failure.message } })
    return
  }

  res.writeHead(200, {
    ...cors(req),
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })

  const id = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`
  writeAnthropic(res, 'message_start', {
    type: 'message_start',
    message: {
      id, type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
    },
  })
  writeAnthropic(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })

  let outputTokens = 0
  let stopReason = 'end_turn'
  try {
    const consume = event => {
      if (event.kind === 'text') {
        writeAnthropic(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: event.text } })
      } else if (event.kind === 'usage') {
        outputTokens = numberOr(event.usage?.outputTokens) ?? outputTokens
      } else if (event.kind === 'finish') {
        stopReason = toAnthropicStop(event.reason)
      }
    }
    if (!first.done) consume(first.value)
    while (true) {
      const next = await iterator.next()
      if (next.done) break
      consume(next.value)
    }
  } catch (error) {
    const failure = failureOf(error)
    writeAnthropic(res, 'error', { type: 'error', error: { type: 'api_error', message: failure.message } })
  }

  writeAnthropic(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
  writeAnthropic(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } })
  writeAnthropic(res, 'message_stop', { type: 'message_stop' })
  res.end()
}

async function completeAnthropicMessages(req, res, { model, events }) {
  let text = ''
  let usage = null
  let finish = { kind: 'stop' }

  try {
    for await (const event of events) {
      if (event.kind === 'text') text += event.text
      else if (event.kind === 'usage') usage = event.usage
      else if (event.kind === 'finish') finish = event.reason
    }
  } catch (error) {
    const failure = failureOf(error)
    sendJson(req, res, statusOf(failure), { type: 'error', error: { type: 'api_error', message: failure.message } })
    return
  }

  sendJson(req, res, 200, {
    id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model,
    content: text === '' ? [] : [{ type: 'text', text }],
    stop_reason: toAnthropicStop(finish),
    stop_sequence: null,
    usage: {
      input_tokens: usage?.inputTokens ?? 0,
      output_tokens: usage?.outputTokens ?? 0,
    },
  })
}

/** Validate the requested model against the live catalog and pick the upstream. */
async function resolveUpstream(deps, model) {
  const catalog = deps.readCatalog()
  if (catalog === null) {
    return {
      status: 503,
      error: { error: { message: 'DuMate is not running; start the desktop app and retry.', type: 'upstream_unavailable', code: 'upstream_unavailable' } },
    }
  }
  if (!catalog.models.some(entry => entry.id === model)) {
    return {
      status: 404,
      error: { error: { message: `model \`${model}\` does not exist.`, type: 'invalid_request_error', code: 'model_not_found' } },
    }
  }
  return { catalog }
}

/** OpenAI chat request → the same request, with a top-level `system` merged in. */
function toOpenAIMessages(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const system = typeof body?.system === 'string' ? body.system : null
  if (system === null) return messages
  return [{ role: 'system', content: system }, ...messages]
}

/** Anthropic message content blocks → OpenAI messages, with placeholders for unsupported blocks. */
function fromAnthropicMessages(body) {
  const systemText = flattenAnthropicText(body?.system)
  const messages = (Array.isArray(body?.messages) ? body.messages : []).map(message => {
    const text = flattenAnthropicText(message?.content)
    return { role: message?.role === 'assistant' ? 'assistant' : 'user', content: text }
  })
  return { messages, system: systemText === '' ? undefined : systemText }
}

function flattenAnthropicText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text
    if (block?.type === 'image') return '[image]'
    if (block?.type === 'tool_use') return `[tool use: ${block.name ?? 'unknown'}]`
    if (block?.type === 'tool_result') return '[tool result]'
    return ''
  }).filter(Boolean).join('\n')
}

function toOpenAITools(tools) {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool?.name,
      ...(tool?.description ? { description: tool.description } : {}),
      parameters: tool?.input_schema ?? { type: 'object', properties: {} },
    },
  }))
}

function toOpenAIUsage(usage) {
  const cached = numberOr(usage?.cacheReadTokens) ?? 0
  const prompt = (numberOr(usage?.inputTokens) ?? 0) + cached
  const completion = numberOr(usage?.outputTokens) ?? 0
  const mapped = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: numberOr(usage?.totalTokens) ?? prompt + completion,
  }
  if (cached > 0) mapped.prompt_tokens_details = { cached_tokens: cached }
  const reasoning = numberOr(usage?.reasoningTokens) ?? 0
  if (reasoning > 0) mapped.completion_tokens_details = { reasoning_tokens: reasoning }
  return mapped
}

function toOpenAIFinish(reason) {
  if (reason?.kind === 'max-tokens') return 'length'
  if (reason?.kind === 'tool-calls') return 'tool_calls'
  return 'stop'
}

function toAnthropicStop(reason) {
  return reason?.kind === 'max-tokens' ? 'max_tokens' : 'end_turn'
}

function writeSse(res, payload) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
  res.write(`data: ${data}\n\n`)
}

function writeAnthropic(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
}

function sendJson(req, res, status, body) {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    ...cors(req),
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  })
  res.end(json)
}

/** Reflect the calling origin when it is loopback; browser pages are the only consumers. */
function cors(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || !isLoopbackOrigin(origin)) return { 'access-control-allow-origin': 'null' }
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-api-key, anthropic-version',
    vary: 'origin',
  }
}

function isLoopbackOrigin(origin) {
  try {
    const { protocol, hostname } = new URL(origin)
    if (protocol !== 'http:' && protocol !== 'https:') return false
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}

function authorized(req, token) {
  if (typeof token !== 'string' || token === '') return true
  const header = req.headers.authorization
  if (typeof header === 'string' && header === `Bearer ${token}`) return true
  return req.headers['x-api-key'] === token
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large.')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') throw new Error('Request body is empty.')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Request body is not valid JSON.')
  }
}

function failureOf(error) {
  if (error instanceof GatewayError) return error.failure
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return llmFailure('ABORTED', 'The request was cancelled.')
  if (typeof error?.status === 'number') return failureFromResponse(error.status, '')
  return llmFailure('TRANSPORT', describe(error))
}

function statusOf(failure) {
  if (typeof failure.status === 'number') return failure.status
  switch (failure.code) {
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
      return 499
    default:
      return 502
  }
}

async function listenWithFallback(server, preferredPort) {
  const attempts = preferredPort === 0 ? 1 : 20
  for (let index = 0; index < attempts; index += 1) {
    const candidate = preferredPort === 0 ? 0 : preferredPort + index
    try {
      await new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListening); reject(error) }
        const onListening = () => { server.off('error', onError); resolve(undefined) }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(candidate, HOST)
      })
      return server.address().port
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error
    }
  }
  throw new Error(`No free port between ${preferredPort} and ${preferredPort + attempts - 1}.`)
}

function numberOr(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
