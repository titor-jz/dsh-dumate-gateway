/**
 * Host registration test: apply() must publish both the adapter route and the
 * same-origin status route, and dispose both when the plugin unloads.
 *
 * The host context is stubbed (no real cordis, no llm service, no HTTP listener),
 * so this checks the wiring contract only: which services are touched, with
 * which arguments, and that the disposers are handed back to `ctx.effect`.
 */
import assert from 'node:assert/strict'
import { apply, inject, name } from '../index.js'

assert.equal(name, 'dsh-dumate-gateway')
assert.deepEqual(inject, ['llm'], 'the required service stays explicit')

function makeContext() {
  const effects = []
  const registered = { adapters: [], routes: [] }

  const ctx = {
    logger: { info() {}, warn() {} },
    effect(factory, label) {
      effects.push({ label, dispose: factory() })
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['connection'], 'the status route needs the connection service')
      const inner = {
        effect(factory, label) {
          effects.push({ label, dispose: factory() })
        },
        connection: {
          fetch: {
            register(route) {
              registered.routes.push(route)
              return async () => {}
            },
          },
        },
      }
      callback(inner)
    },
    llm: {
      registerAdapter(providers, adapter) {
        registered.adapters.push({ providers, adapter })
        return () => {}
      },
    },
  }
  return { ctx, effects, registered }
}

const { ctx, effects, registered } = makeContext()
apply(ctx, { http: { enabled: false } })

assert.equal(registered.adapters.length, 1, 'one provider route')
assert.deepEqual(registered.adapters[0].providers, ['gateway'])
assert.equal(typeof registered.adapters[0].adapter.stream, 'function')

assert.equal(registered.routes.length, 2, 'one status route and one try route')
const [statusRoute, tryRoute] = registered.routes
assert.equal(statusRoute.path, '/api/dumate-gateway/status')
assert.deepEqual(statusRoute.methods, ['GET'])
assert.equal(statusRoute.requestBody, 'buffered')
assert.equal(typeof statusRoute.fetch, 'function')
assert.equal(tryRoute.path, '/api/dumate-gateway/try')
assert.deepEqual(tryRoute.methods, ['POST'])
assert.equal(tryRoute.requestBody, 'buffered')
assert.equal(typeof tryRoute.fetch, 'function')

assert.deepEqual(
  effects.map(entry => entry.label),
  ['dumate-gateway: llm adapter', 'dumate-gateway: status route', 'dumate-gateway: try route'],
)

// The route answers a well-formed JSON payload even without a DuMate install.
const response = await statusRoute.fetch(new Request('http://127.0.0.1/api/dumate-gateway/status'))
assert.equal(response.status, 200)
assert.match(response.headers.get('content-type'), /application\/json/)
const payload = await response.json()
assert.equal(payload.ok, true)
assert.equal(payload.gateway.version, JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8')).version)
assert.equal(typeof payload.upstream.online, 'boolean')
assert.ok(Array.isArray(payload.models))
assert.equal(typeof payload.upstream.models, 'number')

// http.enabled: false keeps the client gateway off while the status route works.
assert.equal(effects.some(entry => entry.label === 'dumate-gateway: http gateway'), false)

// Unloading disposes everything the plugin registered.
for (const entry of effects) await entry.dispose?.()

// A second apply with the HTTP gateway enabled must start an effect for it.
const second = makeContext()
apply(second.ctx, {})
assert.equal(second.effects.some(entry => entry.label === 'dumate-gateway: http gateway'), true)
for (const entry of second.effects) await entry.dispose?.()

console.log('host registration checks passed')
