/**
 * Reachability probe for a discovered base URL.
 *
 * A TCP connect is enough: the DuMate proxy answers unauthenticated requests on
 * the loopback interface, and a chat request costs quota. Kept independent of
 * `node:http` so a stopped app resolves fast instead of waiting on a full
 * request timeout.
 */
import { connect } from 'node:net'

/** Resolve `true` when something accepts a TCP connection at the URL's port. */
export function isReachable(baseURL, timeoutMs = 600) {
  let parsed
  try {
    parsed = new URL(baseURL)
  } catch {
    return Promise.resolve(false)
  }
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port)

  return new Promise(resolve => {
    const socket = connect({ host: parsed.hostname, port })
    const done = reachable => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(reachable)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}
