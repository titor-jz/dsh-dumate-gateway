/**
 * Run DuMate without its window.
 *
 * The desktop app is an Electron shell around two binaries that do the actual
 * work: `dumate-base-proxy.exe` (holds the account cookie and mints gateway
 * tokens) and `dumate-main-server.exe` (serves `/api/qianfanproxy/v1`). The
 * shell also starts a UI, a renderer, opencode, a router and a browser relay —
 * about a gigabyte of memory for what is, from this plugin's point of view, a
 * local model endpoint.
 *
 * Those two binaries can be started directly. Measured on DuMate 1.0.92: two
 * processes, ~59 MB, and both streaming and non-streaming completions answer
 * with the desktop app fully closed.
 *
 * Three details make a bare `spawn` fail, and all three are handled here:
 *
 *  1. The backend refuses to start without a login context
 *     (`runtime login context init failed: loginMode is required`). The values
 *     come from `auth.json`, which the desktop app writes and which needs no
 *     decryption to read.
 *  2. `DUMATE_INAPP_KEY` is not a secret from the app: it is a random 32-byte
 *     nonce the shell and the backend share for one launch, so generating a
 *     fresh one per start is correct rather than cheating.
 *  3. The backend resolves its database directory relative to the working
 *     directory, so it must be started with `%APPDATA%\qianfan-desktop-app` as
 *     CWD or it dies trying to create `C:\Windows\system32\desktop-main`.
 */
import { spawn as spawnChild, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readCatalog } from './discovery.js'
import { isReachable } from './health.js'

const DEFAULT_APP_ROOT = 'D:\\DuMate'
const DEFAULT_BASE_PROXY_PORT = 53231
const DEFAULT_MAIN_SERVER_PORT = 53232
/** How long to wait for each binary to bind its port before giving up. */
const START_TIMEOUT_MS = 30_000
const PROBE_INTERVAL_MS = 300
/** A failed auto-start is not retried more often than this. */
const RETRY_COOLDOWN_MS = 60_000
/** Non-`DUMATE_` environment keys the launcher must write too (see `headlessEnv`). */
const LAUNCHER_KEYS = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'])

/**
 * Paths and ports for one machine. Everything is overridable so the tests and
 * unusual installs (not on `D:`) do not need to edit this file.
 */
export function headlessSettings(config = {}, env = process.env) {
  const options = config ?? {}
  const appDataDir = options.appDataDir
    ?? env.DUMATE_APPDATA_DIR
    ?? join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'qianfan-desktop-app')
  const appRoot = options.appRoot ?? env.DUMATE_ROOT ?? DEFAULT_APP_ROOT
  return {
    appRoot,
    appDataDir,
    authPath: join(appDataDir, 'auth.json'),
    configPath: join(appRoot, 'resources', 'config', 'desktop-main', 'config.yml'),
    baseProxyExe: join(appRoot, 'resources', 'extra-resource', 'base-proxy', 'bin', 'dumate-base-proxy.exe'),
    mainServerExe: join(appRoot, 'resources', 'extra-resource', 'backend', 'bin', 'dumate-main-server.exe'),
    baseProxyPort: positiveInt(options.baseProxyPort) ?? DEFAULT_BASE_PROXY_PORT,
    mainServerPort: positiveInt(options.mainServerPort) ?? DEFAULT_MAIN_SERVER_PORT,
    // Opt-in: nothing is started at plugin load or on the first chat request
    // unless a person asks for it (panel button or CLI call).
    autoStart: options.autoStart === true,
    logDir: options.logDir ?? join(homedir(), '.dsh', 'dumate-gateway', 'logs'),
    statePath: options.statePath ?? join(homedir(), '.dsh', 'dumate-gateway', 'headless.json'),
  }
}

/** The OpenAI-compatible base URL the two binaries together expose. */
export function headlessBaseURL(settings) {
  return `http://127.0.0.1:${settings.mainServerPort}/api/qianfanproxy/v1`
}

/**
 * Read the login the desktop app already performed.
 *
 * `auth.json` is written on every successful sign-in and holds no encrypted
 * material, only identifiers and timestamps. Returning `null` means the user
 * has never signed in, which is the one case headless mode cannot handle.
 */
export function readIdentity(settings) {
  let json
  try {
    json = JSON.parse(readFileSync(settings.authPath, 'utf8'))
  } catch {
    return null
  }
  const profiles = Array.isArray(json?.accountProfiles) ? json.accountProfiles : []
  const profile = profiles.find(entry => entry?.profileId === json?.activeProfileId) ?? profiles[0]
  if (profile === undefined || profile === null) return null
  const userId = typeof profile.bceUserId === 'string' ? profile.bceUserId : ''
  const accountId = typeof profile.bceAccountId === 'string' ? profile.bceAccountId : ''
  if (userId === '' || accountId === '') return null
  return {
    userId,
    accountId,
    lastLoginAt: Number.isFinite(profile.lastSuccessfulLoginAt) ? profile.lastSuccessfulLoginAt : 0,
    loginType: typeof profile.loginType === 'string' ? profile.loginType : 'bce',
  }
}

/**
 * Environment the backend needs.
 *
 * Load bearing, each proven the hard way:
 *
 *  - the login context (`DUMATE_LOGIN_*`) without which the backend refuses to
 *    start;
 *  - the shared nonce `DUMATE_INAPP_KEY`;
 *  - the app version, for the telemetry header the gateway sees;
 *  - **the proxy variables**, which are not obvious and cost a real outage
 *    before they were found. When the desktop shell starts the backend it also
 *    sets `HTTP(S)_PROXY` to `http://proxy:<nonce>@127.0.0.1:<base proxy>`, so
 *    the backend sends every gateway call through the base proxy, which
 *    resolves the name itself. Started without them the backend resolves
 *    `dumate-svc.baidu.com` with the machine's own DNS, and an intermittent
 *    resolver then surfaces to the user as `failed to forward request to
 *    upstream` with `lookup … no such host` in the log.
 */
export function headlessEnv(identity, {
  appVersion = '1.0.92.512',
  baseProxyPort = DEFAULT_BASE_PROXY_PORT,
  inappKey = null,
  env = process.env,
} = {}) {
  // One nonce per *start*, not per process: the proxy accepts only the value the
  // backend sends as its password, so both launchers must carry the same string.
  const nonce = typeof inappKey === 'string' && inappKey !== '' ? inappKey : randomBytes(32).toString('hex')
  // The base proxy authenticates with the same nonce the shell and the backend
  // share; `proxy` is the user name the shell uses too.
  const proxyURL = `http://proxy:${nonce}@127.0.0.1:${baseProxyPort}`
  return {
    ...env,
    DUMATE_INAPP_KEY: nonce,
    DUMATE_LOGIN_MODE: 'personal',
    DUMATE_LOGIN_USER_ID: identity.userId,
    DUMATE_LOGIN_BCE_ACCOUNT_ID: identity.accountId,
    DUMATE_ACCOUNT_ID: identity.accountId,
    DUMATE_USER_ID: identity.userId,
    DUMATE_LAST_LOGIN_AT: String(identity.lastLoginAt),
    DUMATE_DEPLOYMENT_MODE: 'public',
    DUMATE_APP_VER: appVersion,
    DUMATE_EDITION: 'dumate',
    HTTP_PROXY: proxyURL,
    HTTPS_PROXY: proxyURL,
    http_proxy: proxyURL,
    https_proxy: proxyURL,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
  }
}

/**
 * Controller for the two background processes.
 *
 * `spawn` and `reachable` are injectable so the unit tests can assert the exact
 * command lines without launching anything.
 */
export function createHeadless({
  config = {},
  env = process.env,
  logger = console,
  spawn = spawnChild,
  createProcess = null,
  reachable = isReachable,
  settings = headlessSettings(config, env),
} = {}) {
  let starting = null
  let lastAttempt = 0
  let lastError = null

  function logPath(name) {
    return join(settings.logDir, name)
  }

  function launch(exe, args, name, inappKey) {
    const identity = readIdentity(settings)
    if (identity === null) return null
    // The child must outlive this process (DSH restarts, the plugin reloads) and
    // must carry a per-launch environment. Two `spawn` options cannot do both on
    // Windows: a plain detached child inherits the parent's job object and dies
    // with it, while `Win32_Process.Create` reaches a session-owned process but
    // does not take an environment. A one-file `.cmd` wrapper covers the env, and
    // WMI creates the process outside our job.
    const wrapper = join(settings.logDir, `${name}.cmd`)
    const lines = [
      '@echo off',
      `cd /d "${settings.appDataDir}"`,
      ...Object.entries(headlessEnv(identity, {
        appVersion: appVersion(settings),
        baseProxyPort: settings.baseProxyPort,
        inappKey,
        env,
      }))
        // The proxy variables are as load bearing as the `DUMATE_` ones: without
        // them the backend resolves the gateway host with the machine's DNS.
        .filter(([key, value]) => value !== undefined && (key.startsWith('DUMATE_') || LAUNCHER_KEYS.has(key)))
        .map(([key, value]) => `set "${key}=${value}"`),
      `"${exe}" ${args.map(argument => `"${argument}"`).join(' ')}`,
      '',
    ]
    try {
      mkdirSync(settings.logDir, { recursive: true })
      writeFileSync(wrapper, lines.join('\r\n'), 'utf8')
    } catch (error) {
      logger.warn?.(`[dumate-gateway] could not write ${name} launcher: ${describe(error)}`)
      return null
    }

    // Test seam: the unit tests assert the command lines without starting them.
    if (createProcess !== null) {
      return createProcess({ exe, args, wrapper, cwd: settings.appDataDir })
    }

    const created = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='cmd /c "${wrapper}"'}; if ($r.ProcessId) { $r.ProcessId } else { 0 }`,
    ], { encoding: 'utf8', timeout: 30_000, windowsHide: true })

    const pid = Number.parseInt(String(created.stdout ?? '').trim(), 10)
    if (Number.isInteger(pid) && pid > 0) return { pid }

    // No WMI (a locked-down machine, or a non-Windows host): fall back to a
    // detached spawn. The wrapper still sets cwd and the environment.
    logger.warn?.(`[dumate-gateway] WMI could not start ${name}; falling back to a direct spawn`)
    const child = spawn('cmd', ['/c', wrapper], { detached: true, windowsHide: true, stdio: 'ignore' })
    child.on?.('error', error => logger.warn?.(`[dumate-gateway] ${name} failed to spawn: ${describe(error)}`))
    child.unref?.()
    return child
  }

  async function waitForPort(port, timeoutMs = START_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await reachable(`http://127.0.0.1:${port}`)) return true
      await delay(PROBE_INTERVAL_MS)
    }
    return false
  }

  function readState() {
    try {
      return JSON.parse(readFileSync(settings.statePath, 'utf8'))
    } catch {
      return null
    }
  }

  function writeState(state) {
    try {
      mkdirSync(join(settings.statePath, '..'), { recursive: true })
      writeFileSync(settings.statePath, JSON.stringify(state, null, 2), 'utf8')
    } catch (error) {
      logger.warn?.(`[dumate-gateway] could not record headless state: ${describe(error)}`)
    }
  }

  /** `true` when the two binaries answer on their ports. */
  async function running() {
    const [proxy, server] = await Promise.all([
      reachable(`http://127.0.0.1:${settings.baseProxyPort}`),
      reachable(`http://127.0.0.1:${settings.mainServerPort}`),
    ])
    return proxy && server
  }

  /**
   * Is the desktop app itself serving right now?
   *
   * Two backends over one data directory is not a state worth discovering the
   * hard way, so the app always wins: if the file it wrote points at something
   * that answers, headless stays out of the way.
   */
  async function appServing() {
    const catalog = readCatalog({ mode: 'all' })
    // `baseURL` may already be redirected at this plugin's own backend, so probe
    // the one the desktop app wrote to its state file instead.
    const baseURL = typeof catalog?.fileBaseURL === 'string' ? catalog.fileBaseURL : null
    if (baseURL === null) return null
    return await reachable(baseURL) ? baseURL : null
  }

  async function start() {
    if (starting !== null) return starting
    starting = (async () => {
      lastAttempt = Date.now()
      const identity = readIdentity(settings)
      if (identity === null) {
        lastError = 'DuMate has never been signed in on this machine: auth.json has no account. Sign in to the DuMate app once, then start headless mode.'
        return { ok: false, error: lastError }
      }
      if (!existsSync(settings.baseProxyExe) || !existsSync(settings.mainServerExe)) {
        lastError = `DuMate binaries were not found under ${settings.appRoot}. Install the desktop app or point headless.appRoot at it.`
        return { ok: false, error: lastError }
      }
      if (await running()) return { ok: true, baseURL: headlessBaseURL(settings), already: true }

      // The desktop app is already serving: never start a second backend over
      // the same data directory.
      const appBaseURL = await appServing()
      if (appBaseURL !== null) return { ok: true, baseURL: appBaseURL, already: true, external: true }

      mkdirSync(settings.logDir, { recursive: true })
      // One nonce for both processes: the proxy takes it as a password and the
      // backend sends it as `X-Dumate-Inapp-Key`, so a mismatch means 401s.
      const inappKey = randomBytes(32).toString('hex')
      // The proxy mints gateway tokens from the account cookie; the backend
      // needs it listening before its first token request.
      const proxy = launch(settings.baseProxyExe, ['--host=127.0.0.1', `--port=${settings.baseProxyPort}`], 'base proxy', inappKey)
      if (!await waitForPort(settings.baseProxyPort, 15_000)) {
        killTree(proxy.pid)
        lastError = `DuMate's base proxy did not start on port ${settings.baseProxyPort}.`
        return { ok: false, error: lastError }
      }

      const version = appVersion(settings)
      const server = launch(settings.mainServerExe, [
        '-c', settings.configPath,
        '--hostname=127.0.0.1',
        `--port=${settings.mainServerPort}`,
        `-proxy-port=${settings.baseProxyPort}`,
        '-proxy-target-domain=https://console.bce.baidu.com',
        `--user-id=${identity.userId}`,
        `--log-dir=${join(settings.logDir, 'desktop-main')}`,
        '--log-stdout=0',
        '-opencode-cp-enable=false',
      ], 'backend', inappKey)
      if (!await waitForPort(settings.mainServerPort)) {
        killTree(server.pid)
        killTree(proxy.pid)
        lastError = `DuMate's backend did not start on port ${settings.mainServerPort}. See ${logPath('desktop-main')}.`
        return { ok: false, error: lastError }
      }

      writeState({
        startedAt: Date.now(),
        baseProxyPid: proxy.pid,
        mainServerPid: server.pid,
        baseProxyPort: settings.baseProxyPort,
        mainServerPort: settings.mainServerPort,
        appVersion: version,
      })
      lastError = null
      logger.info?.(`[dumate-gateway] headless DuMate started at ${headlessBaseURL(settings)}`)
      return { ok: true, baseURL: headlessBaseURL(settings) }
    })().finally(() => {
      starting = null
    })
    return starting
  }

  /** Start only if it makes sense: opt-in, cooldown-guarded, only when offline. */
  async function ensure() {
    if (settings.autoStart !== true) return null
    if (await running()) return headlessBaseURL(settings)
    if (Date.now() - lastAttempt < RETRY_COOLDOWN_MS) return null
    const result = await start()
    return result.ok === true ? result.baseURL : null
  }

  async function stop() {
    const state = readState()
    // `taskkill /T /F` on a stored pid is only safe while that pid still runs
    // the binary we started: Windows recycles pids, and killing an unrelated
    // tree is far worse than leaving a process behind.
    for (const [pid, expected] of [
      [state?.mainServerPid, 'dumate-main-server'],
      [state?.baseProxyPid, 'dumate-base-proxy'],
    ]) {
      if (Number.isInteger(pid)) killTree(pid, expected)
    }
    // The binaries also stop on their own when the desktop app takes their
    // data directory, so a missing process is a success, not an error.
    for (const key of ['mainServerPort', 'baseProxyPort']) {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline && await reachable(`http://127.0.0.1:${settings[key]}`)) await delay(PROBE_INTERVAL_MS)
    }
    try {
      rmSync(settings.statePath, { force: true })
    } catch {
      // A missing file is already the desired end state.
    }
    return { ok: true }
  }

  async function status() {
    return {
      enabled: true,
      running: await running(),
      baseURL: headlessBaseURL(settings),
      baseProxyPort: settings.baseProxyPort,
      mainServerPort: settings.mainServerPort,
      signedIn: readIdentity(settings) !== null,
      // The desktop app's own endpoint, when it is serving right now. Two
      // backends over one data directory is the one state worth warning about,
      // and `running()` alone cannot tell it apart from "the app is up".
      desktopBaseURL: await appServing(),
      last_error: lastError,
    }
  }

  return { start, stop, ensure, status, settings }
}

/**
 * Latest version the desktop app recorded, for the backend's telemetry field.
 *
 * `app.json` keeps every version the app has ever started (`launchedVersions`),
 * so the newest key is the installed one. The comparison is numeric per part:
 * a plain string sort puts `1.0.9` above `1.0.10` and would under-report the
 * version the gateway sees. Returns `undefined` when the file is unreadable, and
 * `headlessEnv` then leaves the variable out rather than writing `undefined`
 * into the launcher script.
 */
function appVersion(settings) {
  try {
    const json = JSON.parse(readFileSync(join(settings.appDataDir, 'app.json'), 'utf8'))
    const versions = Object.keys(json?.startupTracking?.launchedVersions ?? {})
    if (versions.length === 0) return undefined
    return versions.sort(compareVersions).at(-1)
  } catch {
    return undefined
  }
}

/** `1.0.10` is newer than `1.0.9`; non-numeric parts compare as text. */
function compareVersions(left, right) {
  const a = String(left).split('.')
  const b = String(right).split('.')
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index] ?? '0'
    const y = b[index] ?? '0'
    const nx = Number(x)
    const ny = Number(y)
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx - ny
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** Kill a process and its children; `SIGTERM` on Windows does not do that. */
function killTree(pid, expected) {
  if (!Number.isInteger(pid)) return
  // Only kill a pid that still belongs to the image we started. A missing
  // process is the desired end state, so `pidRuns` reports `true` for it and
  // the `taskkill` below fails harmlessly.
  if (expected !== undefined && !pidRuns(pid, expected)) return
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    try {
      process.kill(pid)
    } catch {
      // Already gone.
    }
  }
}

/** `true` when `pid` is running an image whose name contains `expected`. */
function pidRuns(pid, expected) {
  try {
    const probe = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).ProcessName`,
    ], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    const name = String(probe.stdout ?? '').trim().toLowerCase()
    if (name === '') return true
    return name.includes(expected.toLowerCase())
  } catch {
    // Unknown means "do not kill": leaving a process alive is recoverable.
    return false
  }
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : undefined
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
