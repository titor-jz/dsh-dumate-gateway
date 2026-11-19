/**
 * Headless mode: start DuMate's two background binaries without the app window.
 *
 * Nothing here launches a process: `spawn` and the port probe are injected, so
 * the test asserts the exact command lines and environment DuMate needs instead
 * of depending on an installed app.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createHeadless,
  headlessBaseURL,
  headlessEnv,
  headlessSettings,
  readIdentity,
} from '../src/upstream/headless.js'
import { createHeadlessHandler, HEADLESS_PATH } from '../src/host/headless-route.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-gateway-headless-'))
// Keep discovery away from a really installed app: this test asserts spawning,
// and a live desktop app would correctly take priority over it.
process.env.DUMATE_OPENCODE_CONFIG = path.join(root, 'no-such-opencode.json')
const appRoot = path.join(root, 'DuMate')
const appDataDir = path.join(root, 'qianfan-desktop-app')
const logDir = path.join(root, 'logs')
const statePath = path.join(root, 'headless.json')

fs.mkdirSync(path.join(appRoot, 'resources', 'extra-resource', 'base-proxy', 'bin'), { recursive: true })
fs.mkdirSync(path.join(appRoot, 'resources', 'extra-resource', 'backend', 'bin'), { recursive: true })
fs.mkdirSync(path.join(appRoot, 'resources', 'config', 'desktop-main'), { recursive: true })
fs.mkdirSync(appDataDir, { recursive: true })
fs.writeFileSync(path.join(appRoot, 'resources', 'extra-resource', 'base-proxy', 'bin', 'dumate-base-proxy.exe'), '')
fs.writeFileSync(path.join(appRoot, 'resources', 'extra-resource', 'backend', 'bin', 'dumate-main-server.exe'), '')
fs.writeFileSync(path.join(appRoot, 'resources', 'config', 'desktop-main', 'config.yml'), '')
fs.writeFileSync(path.join(appDataDir, 'app.json'), JSON.stringify({
  startupTracking: { launchedVersions: { '1.0.92': 1, '1.0.91': 1 } },
}))
fs.writeFileSync(path.join(appDataDir, 'auth.json'), JSON.stringify({
  activeProfileId: 'profile-1',
  accountProfiles: [
    { profileId: 'profile-0', bceUserId: 'stale', bceAccountId: 'stale' },
    { profileId: 'profile-1', bceUserId: 'user-1', bceAccountId: 'account-1', lastSuccessfulLoginAt: 1794710796220, loginType: 'bce' },
  ],
}))

// ------------------------------------------------------------------ settings
const options = {
  appRoot,
  appDataDir,
  baseProxyPort: 53231,
  mainServerPort: 53232,
  logDir,
  statePath,
}
const settings = headlessSettings(options, {})
assert.equal(settings.baseProxyPort, 53231)
assert.equal(settings.mainServerPort, 53232)
assert.equal(settings.authPath, path.join(appDataDir, 'auth.json'))
assert.equal(settings.configPath, path.join(appRoot, 'resources', 'config', 'desktop-main', 'config.yml'))
assert.equal(settings.autoStart, false, 'nothing starts unless the row opts in')
assert.equal(headlessSettings({ autoStart: true }, {}).autoStart, true)
assert.equal(headlessBaseURL(settings), 'http://127.0.0.1:53232/api/qianfanproxy/v1')

const defaults = headlessSettings({}, { APPDATA: path.join(root, 'roaming') })
assert.equal(defaults.appRoot, 'D:\\DuMate', 'the install path users actually have')
assert.equal(defaults.baseProxyPort, 53231)
assert.match(defaults.appDataDir, /roaming[\\/]qianfan-desktop-app$/)

// ------------------------------------------------------------------ identity
const identity = readIdentity(settings)
assert.equal(identity.userId, 'user-1', 'the active profile wins over stale ones')
assert.equal(identity.accountId, 'account-1')
assert.equal(identity.lastLoginAt, 1794710796220)
assert.equal(readIdentity(headlessSettings({ appDataDir: path.join(root, 'nope') }, {})), null, 'a machine that never signed in reports no identity')

const env = headlessEnv(identity, { appVersion: '1.0.92', env: {} })
assert.match(env.DUMATE_INAPP_KEY, /^[0-9a-f]{64}$/, 'a fresh 32-byte nonce per start')
assert.notEqual(env.DUMATE_INAPP_KEY, headlessEnv(identity, { env: {} }).DUMATE_INAPP_KEY, 'not reused between starts')
assert.equal(env.DUMATE_LOGIN_MODE, 'personal')
assert.equal(env.DUMATE_LOGIN_USER_ID, 'user-1')
assert.equal(env.DUMATE_LOGIN_BCE_ACCOUNT_ID, 'account-1')
assert.equal(env.DUMATE_ACCOUNT_ID, 'account-1')
assert.equal(env.DUMATE_USER_ID, 'user-1')
assert.equal(env.DUMATE_LAST_LOGIN_AT, '1794710796220')
assert.equal(env.DUMATE_APP_VER, '1.0.92')

// The desktop shell routes the backend's gateway calls through the base proxy
// and the proxy resolves the name. Without these the backend falls back to the
// machine's DNS, which is what produced `failed to forward request to upstream`.
const expectedProxy = `http://proxy:${env.DUMATE_INAPP_KEY}@127.0.0.1:53231`
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
  assert.equal(env[key], expectedProxy, `${key} points at the base proxy with the launch nonce`)
}
assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1')
assert.equal(env.no_proxy, env.NO_PROXY)
assert.equal(
  headlessEnv(identity, { env: {}, baseProxyPort: 60000 }).HTTPS_PROXY.replace(/[0-9a-f]{64}/, 'NONCE'),
  'http://proxy:NONCE@127.0.0.1:60000',
  'the proxy URL follows the configured base proxy port',
)
assert.ok(!JSON.stringify(env).includes('undefined'), 'an unknown app version is omitted, never written as undefined')

// -------------------------------------------------------------- start (fake)
const open = new Set()
const calls = []
let nextPid = 100

function fakeReachable(url) {
  const port = Number(new URL(url).port)
  // Both binaries answer only after their spawn was observed: the controller must
  // wait for the proxy before starting the backend.
  return Promise.resolve(open.has(port))
}

function fakeCreate({ exe, args, cwd }) {
  const port = Number((args.find(arg => arg.startsWith('--port=')) ?? '').slice('--port='.length))
  open.add(port)
  nextPid += 1
  const pid = nextPid
  calls.push({ exe, args, cwd, pid })
  return { pid }
}

const headless = createHeadless({
  config: options,
  env: {},
  logger: { info: () => {}, warn: () => {} },
  createProcess: fakeCreate,
  reachable: fakeReachable,
})

assert.deepEqual(await headless.status(), {
  enabled: true,
  running: false,
  baseURL: 'http://127.0.0.1:53232/api/qianfanproxy/v1',
  baseProxyPort: 53231,
  mainServerPort: 53232,
  signedIn: true,
  desktopBaseURL: null,
  last_error: null,
})

const started = await headless.start()
assert.equal(started.ok, true, started.error)
assert.equal(started.baseURL, 'http://127.0.0.1:53232/api/qianfanproxy/v1')
assert.equal(calls.length, 2, 'two processes, in order')

const [proxy, backend] = calls
assert.match(proxy.exe, /dumate-base-proxy\.exe$/)
assert.deepEqual(proxy.args, ['--host=127.0.0.1', '--port=53231'])
assert.equal(proxy.cwd, appDataDir, 'the backend resolves its data dir relative to cwd')

assert.match(backend.exe, /dumate-main-server\.exe$/)
const backendArgs = backend.args.join(' ')
assert.match(backendArgs, /--port=53232/)
assert.match(backendArgs, /-proxy-port=53231/)
assert.match(backendArgs, /-proxy-target-domain=https:\/\/console\.bce\.baidu\.com/)
assert.match(backendArgs, /--user-id=user-1/)
assert.match(backendArgs, /-opencode-cp-enable=false/, 'this plugin needs no opencode, and it is the memory hog')
assert.ok(!backendArgs.includes('--opencode-base-url'), 'omitting it worked on 1.0.92; do not invent a port')

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
assert.equal(state.baseProxyPid, proxy.pid ?? calls[0].pid)
assert.equal(state.mainServerPid, nextPid)
assert.equal(state.mainServerPort, 53232)

// The launcher scripts are the only place the environment reaches the backend,
// so the proxy variables have to be in the file, not just in the object.
for (const name of ['base proxy.cmd', 'backend.cmd']) {
  const script = fs.readFileSync(path.join(logDir, name), 'utf8')
  assert.match(script, /^set "HTTPS_PROXY=http:\/\/proxy:[0-9a-f]{64}@127\.0\.0\.1:53231"$/m, `${name} routes through the base proxy`)
  assert.match(script, /^set "NO_PROXY=localhost,127\.0\.0\.1,::1"$/m)
  assert.ok(!/set "[A-Za-z_]+=undefined"/.test(script), `${name} never writes a literal undefined`)
}
assert.match(fs.readFileSync(path.join(logDir, 'backend.cmd'), 'utf8'), /"-proxy-port=53231"/, 'the backend forwards to our proxy port')
assert.equal(
  fs.readFileSync(path.join(logDir, 'backend.cmd'), 'utf8').match(/DUMATE_INAPP_KEY=([0-9a-f]{64})/)[1],
  fs.readFileSync(path.join(logDir, 'base proxy.cmd'), 'utf8').match(/DUMATE_INAPP_KEY=([0-9a-f]{64})/)[1],
  'both processes share one launch nonce, which is also the proxy password',
)

const running = await headless.status()
assert.equal(running.running, true)
assert.equal(running.last_error, null)

// `ensure` is the auto path, and it is opt-in: a row that did not ask for it
// must never be started by a page load or a chat retry.
const before = calls.length
assert.equal(await headless.ensure(), null, 'auto-start is off unless configured')
assert.equal(calls.length, before, 'nothing was launched')

// With the ports open it still starts nothing, and reports where to point.
open.add(53231)
open.add(53232)
const optedIn = createHeadless({
  config: { ...options, autoStart: true },
  env: {},
  logger: { info: () => {}, warn: () => {} },
  createProcess: fakeCreate,
  reachable: fakeReachable,
})
const beforeSecond = calls.length
assert.equal(await optedIn.ensure(), 'http://127.0.0.1:53232/api/qianfanproxy/v1')
assert.equal(calls.length, beforeSecond, 'already running means no second launch')

// ------------------------------------------------------------- start failures
const missing = createHeadless({
  config: { ...options, appRoot: path.join(root, 'missing-app') },
  env: {},
  logger: { info: () => {}, warn: () => {} },
  createProcess: fakeCreate,
  reachable: async () => false,
})
const failed = await missing.start()
assert.equal(failed.ok, false)
assert.match(failed.error, /binaries were not found/)

const signedOut = createHeadless({
  config: { ...options, appDataDir: path.join(root, 'no-account') },
  env: {},
  logger: { info: () => {}, warn: () => {} },
  createProcess: fakeCreate,
  reachable: async () => false,
})
const noAccount = await signedOut.start()
assert.equal(noAccount.ok, false)
assert.match(noAccount.error, /never been signed in/)

// A failed auto-start is not retried inside its cooldown: a chat retry storm must
// not turn into a spawn storm.
assert.equal(await signedOut.ensure(), null)
assert.equal(await signedOut.ensure(), null)

// -------------------------------------------------------------- host route
assert.equal(HEADLESS_PATH, '/api/dumate-gateway/headless')
const route = createHeadlessHandler({ headless })
const statusResponseObject = await route(new Request('http://127.0.0.1/api', { method: 'POST' }))
assert.equal(statusResponseObject.status, 200)
assert.equal((await statusResponseObject.json()).headless.running, true)

const disabled = createHeadlessHandler({ headless: null })
const refused = await disabled(new Request('http://127.0.0.1/api', { method: 'POST', body: '{"action":"start"}' }))
assert.equal(refused.status, 503)
assert.equal((await refused.json()).error, 'headless_disabled')

fs.rmSync(root, { recursive: true, force: true })
console.log('headless checks passed')
