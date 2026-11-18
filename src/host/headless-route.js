// Same-origin control route for headless mode.
//
// "Headless" means: start DuMate's two background binaries (`dumate-base-proxy`
// and `dumate-main-server`) without the Electron window, which is ~59 MB instead
// of ~1 GB. The panel's Start/Stop buttons call this route; nothing here runs
// unless a person presses one, and nothing here sends a chat request.
import { headlessBaseURL } from '../upstream/headless.js'
import { invalidateCatalog, setBaseURLOverride } from '../upstream/discovery.js'

export const HEADLESS_PATH = '/api/dumate-gateway/headless'

/**
 * @param {object} options
 * @param {ReturnType<import('../upstream/headless.js').createHeadless> | null} options.headless
 */
export function createHeadlessHandler({ headless = null } = {}) {
  return async function handleHeadless(request) {
    let body = null
    try {
      body = await request.json()
    } catch {
      // A bare POST means "what is the state"; only an explicit action changes it.
    }
    const action = typeof body?.action === 'string' ? body.action : 'status'

    if (headless === null) {
      return json(503, {
        ok: false,
        error: 'headless_disabled',
        message: 'Headless mode is off for this plugin row. Set `headless.enabled: true` in the plugin config first.',
      })
    }

    if (action === 'start') {
      const started = await headless.start()
      if (started.ok !== true) {
        return json(502, {
          ok: false,
          error: 'start_failed',
          message: started.error ?? 'DuMate did not start.',
          headless: await headless.status(),
        })
      }
      // Requests move to the instance we just started; the catalog still comes
      // from the state file, which is where the model table lives.
      setBaseURLOverride(started.baseURL ?? headlessBaseURL(headless.settings))
      invalidateCatalog()
      return json(200, { ok: true, action: 'start', baseURL: started.baseURL, headless: await headless.status() })
    }

    if (action === 'stop') {
      await headless.stop()
      setBaseURLOverride(null)
      invalidateCatalog()
      return json(200, { ok: true, action: 'stop', headless: await headless.status() })
    }

    return json(200, { ok: true, action: 'status', headless: await headless.status() })
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
