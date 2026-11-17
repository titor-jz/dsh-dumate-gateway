/**
 * Locate the DuMate desktop app's live model catalog.
 *
 * DuMate writes its opencode configuration into a hashed directory on every
 * launch, and the backend port is embedded in that file's `baseURL`. Reading
 * it is therefore the only reliable way to find a running instance: the port
 * changes from launch to launch and nothing about it is stable.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CACHE_TTL_MS = 2000

/**
 * DuMate's catalog mixes user-facing chat models with its own plumbing: routing
 * helpers, validators, embeddings, an OCR endpoint and an auto-router with six
 * L0/L1/L2 variants. None of those are useful in a model picker, so the default
 * view is curated. `models.mode: 'all'` shows the raw table, and `models.exclude`
 * hides further keys by substring.
 */
const CURATED_HIDDEN = [
  /^model-/, // internal capability models: routing, aiassist, validate, gui-use, ...
  /^dm-auto-model\//, // auto-router variants share one purpose and differ only by level
  /^llm-mock$/i,
  /^qianfan-ocr$/i,
  /^dumate-image/i,
  /embedding/i,
  /rerank/i,
]

let cache = { at: 0, value: null }

/** Where DuMate keeps per-install state: `%APPDATA%\qianfan-desktop-app\qianfan_desk_xdg\<hash>`. */
export function stateRoots() {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  const root = join(appData, 'qianfan-desktop-app', 'qianfan_desk_xdg')
  try {
    return readdirSync(root).map(name => join(root, name, 'config', 'opencode', 'opencode.json'))
  } catch {
    return []
  }
}

/** The newest `opencode.json` a DuMate launch left behind, or `null` when the app never ran. */
export function liveConfigPath(roots = stateRoots()) {
  if (process.env.DUMATE_OPENCODE_CONFIG) return process.env.DUMATE_OPENCODE_CONFIG
  let newest = null
  for (const path of roots) {
    try {
      const stat = statSync(path)
      if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: stat.mtimeMs }
    } catch {
      // A candidate that disappeared between listing and stat is simply not live.
    }
  }
  return newest?.path ?? null
}

/**
 * Read the live catalog.
 *
 * @param {{force?: boolean, mode?: 'curated' | 'all', exclude?: string[]}} [options]
 * @returns {null | {
 *   configPath: string,
 *   baseURL: string,
 *   apiKey: string | null,
 *   models: Array<{id: string, name: string, inputModalities: string[], contextWindow?: number, maxTokens?: number}>,
 * }}
 */
export function readCatalog({ force = false, mode = 'curated', exclude = [] } = {}) {
  const raw = loadRaw({ force })
  if (raw === null) return null
  const models = curateEntries(raw.entries, { mode, exclude })
  return { configPath: raw.configPath, baseURL: raw.baseURL, apiKey: raw.apiKey, models }
}

/** Parse the live file into key→model entries; cached briefly because the picker asks often. */
function loadRaw({ force = false } = {}) {
  const now = Date.now()
  if (!force && cache.value !== null && now - cache.at < CACHE_TTL_MS) return cache.value

  const configPath = liveConfigPath()
  if (configPath === null) {
    cache = { at: now, value: null }
    return null
  }

  let json
  try {
    json = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    cache = { at: now, value: null }
    return null
  }

  const provider = json?.provider?.QianfanPersonalQuota ?? Object.values(json?.provider ?? {})[0]
  const baseURL = normalizeBaseURL(process.env.DUMATE_HOST_URL ?? provider?.options?.baseURL)
  if (baseURL === null) {
    cache = { at: now, value: null }
    return null
  }

  const apiKey = typeof provider?.options?.apiKey === 'string' && provider.options.apiKey !== 'nokey'
    ? provider.options.apiKey
    : null

  // Keep the raw entries; the curated view is applied per call so that
  // `models.mode` can change without re-reading the file.
  const entries = Object.entries(provider?.models ?? {}).map(([key, model]) => ({
    key,
    model,
    preferred: typeof model?.id === 'string' && model.id !== '' ? model.id : key,
  }))

  const value = { configPath, baseURL, apiKey, entries }
  cache = { at: now, value }
  return value
}

/**
 * Turn raw catalog entries into picker rows.
 *
 * The harness requires unique model ids, but a catalog may alias two keys to one
 * upstream id (DuMate ships `glm-5` and `model-text` both naming `model-text`).
 * Entries that name themselves keep their id; aliases fall back to their unique
 * key, which the proxy accepts as well. Hiding a self-named key first lets the
 * alias take the nicer id: with `model-text` hidden, `glm-5` becomes the row whose
 * id is `model-text` and whose label is `Glm 5`.
 *
 * @param {Array<{key: string, model: unknown, preferred: string}>} entries
 * @param {{mode?: 'curated' | 'all', exclude?: string[]}} [options]
 */
export function curateEntries(entries, { mode = 'curated', exclude = [] } = {}) {
  const needles = exclude.filter(value => typeof value === 'string' && value !== '')
  const visible = mode === 'all'
    ? entries
    : entries.filter(entry => !CURATED_HIDDEN.some(pattern => pattern.test(entry.key))
      && !needles.some(needle => entry.key.toLowerCase().includes(needle.toLowerCase())))

  // Never strand the picker: if curation hid everything, show the raw table.
  const kept = visible.length > 0 ? visible : entries

  const models = []
  const used = new Set()
  for (const { key, model, preferred } of kept) {
    if (preferred === key) {
      used.add(key)
      models.push(modelEntry(key, model, key))
    }
  }
  for (const { key, model, preferred } of kept) {
    if (preferred === key) continue
    const id = used.has(preferred) ? key : preferred
    if (used.has(id)) continue
    used.add(id)
    models.push(modelEntry(id, model, key))
  }
  return models
}

/** One catalog row in the plugin's own vocabulary. */
function modelEntry(id, model, key) {
  return {
    id,
    name: humanize(key),
    inputModalities: modalities(model?.modalities?.input),
    contextWindow: positive(model?.limit?.input ?? model?.limit?.context),
    maxTokens: positive(model?.limit?.output),
  }
}

/** Drop the trailing `/` so request paths concatenate predictably. */
function normalizeBaseURL(url) {
  if (typeof url !== 'string' || url === '') return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

/** Keep only the modalities the harness models today; `video` has no harness equivalent. */
function modalities(input) {
  if (!Array.isArray(input)) return ['text']
  const mapped = input.flatMap(value => (value === 'image' ? ['image'] : value === 'text' ? ['text'] : []))
  return mapped.length === 0 ? ['text'] : [...new Set(mapped)]
}

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** `deepseek-v41-flash` → `Deepseek V41 Flash`; `dm-auto-model/text.L1` → `Dm Auto Model / Text L1`. */
function humanize(key) {
  return key
    .replace(/[\/.]+/g, ' ')
    .split(/[\s-_]+/)
    .filter(Boolean)
    .map(part => part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1))
    .join(' ')
}
