// Host half: register the provider route and the loopback HTTP gateway.
import { readFileSync } from 'node:fs'
import { GatewayAdapter, PROVIDER } from './src/adapter.js'
import { startGateway } from './src/gateway/server.js'
import { readCatalog, setBaseURLOverride } from './src/upstream/discovery.js'
import { createHeadless } from './src/upstream/headless.js'
import { isReachable } from './src/upstream/health.js'
import { streamChatCompletion } from './src/upstream/openai-client.js'
import { createHeadlessHandler, HEADLESS_PATH } from './src/host/headless-route.js'
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

  // Headless mode: run DuMate's two background binaries instead of the whole
  // Electron app. Opt-in, because it starts processes this plugin owns.
  const headlessConfig = settings.headless ?? {}
  const headless = headlessConfig.enabled === true
    ? createHeadless({ config: headlessConfig, logger: ctx.logger })
    : null

  // Images arrive as durable references: only the attachment service holds the
  // bytes. Without that service the block keeps its placeholder text.
  const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') ?? null : null
  const images = attachments === null ? null : imageResolver(attachments)

  const adapter = new GatewayAdapter(settings, { headless, images })
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
    headless,
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

    if (headless !== null) {
      const headlessHandler = createHeadlessHandler({ headless })
      inner.effect(() => inner.connection.fetch.register({
        path: HEADLESS_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: headlessHandler,
      }), 'dumate-gateway: headless route')
    }
  })

  // Reuse a headless backend that is still running (DSH restarted while it
  // served): adopting it starts nothing, it only points requests at ports that
  // already answer. The desktop app, when alive, still wins over it.
  if (headless !== null) {
    ctx.effect(() => {
      let closed = false
      headless.status()
        .then(async state => {
          if (closed || state.running !== true) return
          const catalog = readCatalog({ mode: 'all' })
          if (catalog !== null && await isReachable(catalog.baseURL)) return
          setBaseURLOverride(state.baseURL)
          invalidateCatalog()
          ctx.logger?.info?.('[dumate-gateway] adopted the headless backend at ' + state.baseURL)
        })
        .catch(() => {})
      return () => {
        closed = true
      }
    }, 'dumate-gateway: adopt running headless')
  }

  // Starting is opt-in: `headless.autoStart: true` is the only thing that lets
  // a page load launch the two binaries. Without it, only the panel button (or
  // an explicit route call) starts them.
  if (headless !== null) {
    ctx.effect(() => {
      let closed = false
      const autoStart = headlessConfig.autoStart === true
      if (autoStart) {
        headless.ensure()
          .then(baseURL => {
            if (closed) return
            if (typeof baseURL === 'string') {
              setBaseURLOverride(baseURL)
              ctx.logger?.info?.(`[dumate-gateway] headless DuMate is serving ${baseURL}`)
            } else {
              ctx.logger?.info?.('[dumate-gateway] headless mode is on; the desktop app answered first, so nothing was started')
            }
          })
          .catch(error => {
            ctx.logger?.warn?.(`[dumate-gateway] headless start failed: ${error instanceof Error ? error.message : String(error)}`)
          })
      }
      return () => {
        closed = true
        // Off by default: a DSH restart should not kill a backend the user is
        // using. `headless.stopOnUnload: true` opts into tying their lifetimes.
        if (headlessConfig.stopOnUnload === true) headless.stop()
      }
    }, 'dumate-gateway: headless mode')
  }

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

/** Longest image the proxy takes inline before the request turns into a timeout. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024

/**
 * Turn one harness image block into a `data:` URL for an OpenAI image part.
 * Returns null when the ref is unusable, the bytes are missing, or the image is
 * over the inline budget, which keeps the "[image attachment]" placeholder.
 *
 * @param {{readImage: (ref: any) => Promise<{ref?: any, data?: Uint8Array} | undefined>}} attachments
 */
function imageResolver(attachments) {
  return async block => {
    const ref = block?.attachment
    if (ref === null || typeof ref !== 'object' || typeof ref.attachmentId !== 'string') return null

    const stored = await attachments.readImage(ref)
    const bytes = stored?.data instanceof Uint8Array ? stored.data : null
    if (bytes === null || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null

    const mediaType = stored?.ref?.mediaType ?? ref.mediaType ?? 'image/png'
    return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`
  }
}
