/**
 * Minimal OpenAI-compatible chat client over the DuMate proxy.
 *
 * Yields semantic events instead of wire chunks so the adapter owns the
 * harness block protocol and this file stays a transport.
 */
import { GatewayError, failureFromResponse, llmFailure } from '../failure.js'
import { record } from '../usage.js'

/**
 * @param {{
 *   baseURL: string,
 *   apiKey?: string | null,
 *   model: string,
 *   messages: readonly any[],
 *   tools?: readonly any[],
 *   temperature?: number,
 *   maxTokens?: number,
 *   stop?: readonly string[],
 *   signal?: AbortSignal,
 *   kind?: 'dsh' | 'http' | 'try' | 'chat',
 * }} options
 */
export async function* streamChatCompletion(options) {
  const startedAt = Date.now()
  let usage = null
  let failureCode = null
  try {
    for await (const event of mergeToolCallFragments(streamUpstream(options))) {
      if (event.kind === 'usage') usage = event.usage
      yield event
    }
  } catch (error) {
    failureCode = error instanceof GatewayError ? error.failure.code : 'TRANSPORT'
    throw error
  } finally {
    // One row per call, whatever the caller does with the stream afterwards.
    record({
      kind: options.kind ?? 'chat',
      model: options.model,
      usage,
      ok: failureCode === null,
      code: failureCode,
      ms: Date.now() - startedAt,
    })
  }
}

/**
 * Fold one logical tool call back into one event.
 *
 * DuMate splits a call over several fragments whose `index` keeps changing: the
 * id/name arrives as index 0, then the argument JSON pieces arrive as index 1
 * (or 2, 3…) with no id and no name. Consumers key tool calls by index/id, so
 * the pieces would surface as extra nameless calls and the arguments would be
 * lost. Treat a fragment without an id and without a name as a continuation of
 * the call being assembled, and emit the call once, complete.
 */
async function* mergeToolCallFragments(events) {
  let pending = null

  function* flush() {
    if (pending === null) return
    yield { kind: 'tool-call', id: pending.id, name: pending.name, argumentsDelta: pending.args }
    pending = null
  }

  for await (const event of events) {
    if (event.kind !== 'tool-call') {
      yield* flush()
      yield event
      continue
    }

    const id = event.id ?? ''
    const name = typeof event.name === 'string' && event.name !== '' ? event.name : undefined
    if (pending !== null && (id !== '' || name !== undefined)) yield* flush()

    if (pending === null) pending = { id, name, args: '' }
    else {
      if (pending.id === '') pending.id = id
      if (pending.name === undefined) pending.name = name
    }
    pending.args += event.argumentsDelta ?? ''
  }

  yield* flush()
}

async function* streamUpstream(options) {
  const {
    baseURL, apiKey, model, messages, tools, temperature, maxTokens, stop, signal,
  } = options

  const body = { model, messages, stream: true, stream_options: { include_usage: true } }
  if (Array.isArray(tools) && tools.length > 0) body.tools = tools
  if (typeof temperature === 'number') body.temperature = temperature
  if (typeof maxTokens === 'number' && maxTokens > 0) body.max_tokens = maxTokens
  if (Array.isArray(stop) && stop.length > 0) body.stop = stop

  const headers = { 'content-type': 'application/json', accept: 'text/event-stream' }
  if (typeof apiKey === 'string' && apiKey !== '') headers.authorization = `Bearer ${apiKey}`

  let response
  try {
    response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (isAbort(error)) throw new GatewayError(llmFailure('ABORTED', 'The request was cancelled.'))
    throw new GatewayError(llmFailure('TRANSPORT', `Could not reach ${baseURL}: ${describe(error)}`))
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new GatewayError(failureFromResponse(response.status, text))
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream') || response.body === null) {
    yield* fromJsonBody(await response.text())
    return
  }

  yield* fromEventStream(response.body)
}

/** A server that ignored `stream: true` still returns one complete payload. */
function* fromJsonBody(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new GatewayError(llmFailure('MALFORMED_RESPONSE', 'The upstream replay was not valid JSON.'))
  }

  const choice = parsed?.choices?.[0]
  const message = choice?.message
  if (typeof message?.reasoning_content === 'string' && message.reasoning_content !== '') {
    yield { kind: 'reasoning', text: message.reasoning_content }
  }
  if (typeof message?.content === 'string' && message.content !== '') {
    yield { kind: 'text', text: message.content }
  }
  for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
    yield {
      kind: 'tool-call',
      id: String(call.id ?? ''),
      name: call.function?.name,
      argumentsDelta: call.function?.arguments ?? '',
    }
  }
  if (parsed?.usage) yield { kind: 'usage', usage: mapUsage(parsed.usage) }
  yield { kind: 'finish', reason: mapFinishReason(choice?.finish_reason) }
}

async function* fromEventStream(stream) {
  const decoder = new TextDecoder()
  let buffer = ''
  let pendingFinish = null
  let done = false

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    let boundary = findBoundary(buffer)
    while (boundary !== -1) {
      const record = buffer.slice(0, boundary.start)
      buffer = buffer.slice(boundary.end)
      const result = parseRecord(record)
      if (result.done) { done = true; break }
      for (const event of result.events) {
        if (event.kind === 'finish') pendingFinish = event
        else yield event
      }
      boundary = findBoundary(buffer)
    }
    if (done) break
  }

  if (!done && buffer.trim() !== '') {
    const result = parseRecord(buffer)
    for (const event of result.events) {
      if (event.kind === 'finish') pendingFinish = event
      else yield event
    }
  }

  yield pendingFinish ?? { kind: 'finish', reason: { kind: 'stop' } }
}

/** Turn one SSE record into events; the terminal flag marks a `[DONE]` sentinel. */
function parseRecord(record) {
  const payload = record
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .join('')
  if (payload === '') return { events: [] }
  if (payload === '[DONE]') return { events: [], done: true }

  let parsed
  try {
    parsed = JSON.parse(payload)
  } catch {
    return { events: [] }
  }

  const events = []
  const choice = parsed?.choices?.[0]
  const delta = choice?.delta
  if (delta) {
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
      events.push({ kind: 'reasoning', text: delta.reasoning_content })
    }
    if (typeof delta.content === 'string' && delta.content !== '') {
      events.push({ kind: 'text', text: delta.content })
    }
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      events.push({
        kind: 'tool-call',
        id: String(call.id ?? ''),
        name: call.function?.name,
        argumentsDelta: call.function?.arguments ?? '',
      })
    }
  }
  if (parsed?.usage) events.push({ kind: 'usage', usage: mapUsage(parsed.usage) })
  if (typeof choice?.finish_reason === 'string') {
    events.push({ kind: 'finish', reason: mapFinishReason(choice.finish_reason) })
  }
  return { events }
}

function findBoundary(text) {
  const lf = text.indexOf('\n\n')
  const crlf = text.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return -1
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { start: crlf, end: crlf + 4 }
  return { start: lf, end: lf + 2 }
}

export function mapFinishReason(reason) {
  switch (reason) {
    case 'length':
      return { kind: 'max-tokens' }
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    default:
      return { kind: 'stop' }
  }
}

export function mapUsage(usage) {
  const prompt = numberOr(usage?.prompt_tokens, 0)
  const cached = numberOr(usage?.prompt_tokens_details?.cached_tokens, 0)
  const completion = numberOr(usage?.completion_tokens, 0)
  const mapped = {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: completion,
  }
  if (cached > 0) mapped.cacheReadTokens = cached
  if (typeof usage?.total_tokens === 'number') mapped.totalTokens = usage.total_tokens
  const reasoning = numberOr(usage?.completion_tokens_details?.reasoning_tokens, 0)
  if (reasoning > 0) mapped.reasoningTokens = reasoning
  return mapped
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isAbort(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
