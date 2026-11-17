// Same-origin status channel for the sidebar panel.
//
// The panel runs inside the Web GUI page, so a fetch to http://127.0.0.1:7321
// is cross-origin and can be refused by the page's own policies (or by a GUI
// that is not actually served from loopback). The host registers one exact
// Fetch route on the shared `/api` channel instead: the browser calls
// `/api/dumate-gateway/status` on its own origin, which is always allowed and
// only answers the owner peer.
import { readCatalog } from '../upstream/discovery.js'
import { isReachable } from '../upstream/health.js'
import { snapshot as usageSnapshot } from '../usage.js'

// Path the browser fetches on its own origin. `connection.fetch` keys exact
// routes by the full request pathname (`fetchRoutes.get(url.pathname)`), so this
// constant must keep the `/api` prefix — chat-import registers
// '/api/deepseek-chat-import/archive' the same way.
export const STATUS_PATH = '/api/dumate-gateway/status'

/**
 * @param {object} options
 * @param {string} options.version - plugin version, echoed to the panel.
 * @param {'curated' | 'all'} [options.modelsMode]
 * @param {readonly string[]} [options.modelsExclude]
 * @param {typeof readCatalog} [options.catalog]
 * @param {typeof isReachable} [options.reachable]
 * @returns {() => Promise<object>} reads one status snapshot.
 */
export function createStatusReader({
  version,
  modelsMode = 'curated',
  modelsExclude = [],
  catalog = readCatalog,
  reachable = isReachable,
}) {
  return async function readStatus() {
    let snapshot
    try {
      snapshot = await catalog({ mode: modelsMode, exclude: modelsExclude })
    } catch (error) {
      // No DuMate state at all: the panel shows its "start the app" empty state
      // instead of an error, so report a well-formed offline payload.
      return offline(version, modelsMode, error instanceof Error ? error.message : String(error))
    }
    const baseURL = typeof snapshot?.baseURL === 'string' ? snapshot.baseURL : null
    if (baseURL === null) return offline(version, modelsMode, 'the DuMate state file has no base URL yet')
    const online = await reachable(baseURL)
    const models = Array.isArray(snapshot.models) ? snapshot.models : []
    const configPath = typeof snapshot.configPath === 'string' ? snapshot.configPath : undefined
    return {
      ok: true,
      gateway: { version, upstream: 'dumate', models_mode: modelsMode },
      upstream: {
        name: 'dumate',
        baseURL,
        online,
        models: models.length,
        ...(configPath === undefined ? {} : { config_path: configPath }),
      },
      models: models.map(toWireModel),
      usage: usageSnapshot(),
    }
  }
}

function offline(version, modelsMode, reason) {
  return {
    ok: true,
    gateway: { version, upstream: 'dumate', models_mode: modelsMode },
    upstream: { name: 'dumate', baseURL: null, online: false, models: 0 },
    models: [],
    ...(reason === undefined ? {} : { reason }),
  }
}

function toWireModel(model) {
  return {
    id: model.id,
    object: 'model',
    owned_by: 'dumate',
    name: model.name,
    ...(model.contextWindow === undefined ? {} : { context_window: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { max_tokens: model.maxTokens }),
    input_modalities: Array.isArray(model.inputModalities) && model.inputModalities.length > 0
      ? model.inputModalities
      : ['text'],
  }
}

/** Wrap a reader as the JSON response the Fetch route returns. */
export function statusResponse(readStatus) {
  return async function respond() {
    const body = await readStatus()
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  }
}
