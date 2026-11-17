/**
 * Provider-neutral failure facts for the gateway route.
 *
 * Codes come from the harness vocabulary (`LLM_FAILURE_CODES`); carrying the
 * literal strings keeps this package dependency-free while staying on the
 * vocabulary the runtime's retry policy and UI already understand.
 */

/** @param {string} code @param {string} message @param {number} [status] */
export function llmFailure(code, message, status) {
  const failure = { code, message }
  if (typeof status === 'number') failure.status = status
  return failure
}

/** A throwable wrapper so the adapter can distinguish route failures from bugs. */
export class GatewayError extends Error {
  /** @param {{code: string, message: string, status?: number}} failure */
  constructor(failure) {
    super(failure.message)
    this.name = 'GatewayError'
    this.failure = failure
  }
}

/** Classify a non-2xx response; the body may carry a DuMate error object. */
export function failureFromResponse(status, bodyText) {
  let message = bodyText.trim().slice(0, 400) || `HTTP ${status}`
  let code

  try {
    const parsed = JSON.parse(bodyText)
    const upstream = parsed?.error ?? parsed
    if (typeof upstream?.message === 'string' && upstream.message !== '') message = upstream.message
    const upstreamCode = typeof upstream?.code === 'string' ? upstream.code : undefined
    if (upstreamCode === 'invalid_model') code = 'UNKNOWN_MODEL'
    else if (upstreamCode === 'unauthorized' || upstreamCode === 'invalid_api_key') code = 'AUTH'
  } catch {
    // A non-JSON body stays as its truncated text.
  }

  if (code === undefined) {
    if (status === 400) code = 'INVALID_REQUEST'
    else if (status === 401 || status === 403) code = 'AUTH'
    else if (status === 402) code = 'QUOTA'
    else if (status === 404) code = 'UNKNOWN_MODEL'
    else if (status === 429) code = 'RATE_LIMIT'
    else if (status >= 500) code = 'SERVER'
    else code = `HTTP_${status}`
  }

  return llmFailure(code, message, status)
}
