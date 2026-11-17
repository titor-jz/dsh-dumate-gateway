// Host half: register the provider route and the loopback HTTP gateway.
import { readFileSync } from 'node:fs'
import { GatewayAdapter, PROVIDER } from './src/adapter.js'
import { startGateway } from './src/gateway/server.js'
import { readCatalog } from './src/upstream/discovery.js'
import { isReachable } from './src/upstream/health.js'
import { streamChatCompletion } from './src/upstream/openai-client.js'
import { createStatusReader, statusResponse, STATUS_PATH } from './src/host/status-route.js'
import { createTryHandler, TRY_PATH } from './src/host/try-route.js'

export const name = 'dsh-dumate-gateway'

// Route registration needs the provider-neutral model-call service.
export const inject = ['llm']

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

/**
 * @param {import('@deepseek-ai/dsh-llm').Context} ctx - host plugin context.
 * @param {Record<string, unknown> | undefined} config - the row's config.
 */
export function apply(ctx, config) {
  const settings = config ?? {}
  const adapter = new GatewayAdapter(settings)
  // The registration is owned by this plugin's fiber: unloading the plugin
  // releases the route.
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter), 'dumate-gateway: llm adapter')

  // The sidebar panel fetches its status from the page's own origin: a request
  // to 127.0.0.1:7321 is cross-origin and the page may refuse it, while the
  // shared `/api` channel only answers the owner peer. `connection` is an
  // optional service, so inject it instead of declaring it in `inject`.
  const status = createStatusReader({
    version: VERSION,
    modelsMode: adapter.modelsMode,
    modelsExclude: adapter.modelsExclude,
  })
  ctx.inject(['connection'], inner => {
    inner.effect(() => inner.connection.fetch.register({
      path: STATUS_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: statusResponse(status),
    }), 'dumate-gateway: status route')

    // One small completion on demand, for the panel's "try it" box. This is the
    // only route that spends quota, and it only runs when a person presses send.
    const tryHandler = createTryHandler({
      modelsMode: adapter.modelsMode,
      modelsExclude: adapter.modelsExclude,
    })
    inner.effect(() => inner.connection.fetch.register({
      path: TRY_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: tryHandler,
    }), 'dumate-gateway: try route')
  })

  const http = settings.http ?? {}
  if (http.enabled === false) return

  ctx.effect(() => {
    let closed = false
    let gateway = null

    startGateway({
      port: typeof http.port === 'number' ? http.port : 7321,
      token: typeof http.token === 'string' ? http.token : null,
      version: VERSION,
      readCatalog,
      isReachable,
      streamChatCompletion,
      logger: ctx.logger,
    })
      .then(handle => {
        if (closed) {
          handle.close()
          return
        }
        gateway = handle
        ctx.logger?.info?.(`[dumate-gateway] client gateway ready at ${handle.url}`)
      })
      .catch(error => {
        ctx.logger?.warn?.(`[dumate-gateway] http gateway failed to start: ${error instanceof Error ? error.message : String(error)}`)
      })

    return () => {
      closed = true
      gateway?.close()
    }
  }, 'dumate-gateway: http gateway')
}
