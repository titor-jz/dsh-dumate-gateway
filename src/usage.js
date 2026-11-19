// Local, private usage accounting for everything that reaches the DuMate proxy.
//
// The counters exist for one reason: the account behind DuMate must not be pushed
// harder than a person typing in the app would. Every path through
// `streamChatCompletion` records one row here, the panel reads the snapshot from
// the same-origin status route, and nothing is ever sent anywhere else.
//
// The file lives under ~/.dsh/dumate-gateway/usage.json, keeps seven days, and a
// write failure only costs the counters — never a chat.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const KEEP_DAYS = 7

function dataDir() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'dumate-gateway')
}

function stateFile() {
  return path.join(dataDir(), 'usage.json')
}

/**
 * Rows recovered from the session logs by `tools/backfill-cache.mjs`.
 *
 * Kept in a second file on purpose: a process still running an older release
 * rewrites `usage.json` from its own in-memory copy on every request, which
 * would erase anything written there from outside. A file that old code does
 * not know about survives until it can be read.
 */
function repairFile() {
  return path.join(dataDir(), 'usage-recovered.json')
}

let days = null
let stamp = null
let repairStamp = null

// Load lazily so a test can point DSH_HOME at a scratch directory before the
// first read or write, even though this module is imported statically.
function ensure() {
  if (days === null) {
    days = load()
    stamp = mtime()
    repairStamp = mtimeOf(repairFile())
    absorb(loadFrom(repairFile()))
  } else {
    // Two processes share this file: the host plugin and the HTTP gateway.
    // Whoever writes last would otherwise erase the other's rows (and a
    // backfill from the session logs would vanish on the next request), so
    // adopt whatever landed on disk since our copy was taken.
    const current = mtime()
    if (current !== stamp) {
      stamp = current
      absorb(load())
    }
    // The repair file is small and cheap to re-stat; folding it in on every
    // pass is what makes it survive a co-writer that rewrites its own rows.
    const repair = mtimeOf(repairFile())
    if (repair !== repairStamp) {
      repairStamp = repair
      absorb(loadFrom(repairFile()))
    }
  }
  return days
}

function mtime() {
  return mtimeOf(stateFile())
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return null
  }
}

/**
 * Fold another copy of the ledger into ours.
 *
 * Every counter is monotonic within a day, so `max` reconciles two writers
 * without double counting — re-merging the same file any number of times is a
 * no-op. `last` keeps whichever record is newer.
 * @param {Record<string, any>} other - rows read from disk.
 */
function absorb(other) {
  const all = days
  for (const [date, row] of Object.entries(other ?? {})) {
    if (row === null || typeof row !== 'object') continue
    const mine = all[date]
    if (mine === undefined) {
      // A partial row (the repair file carries only cache counters) must not
      // create a day by itself: a day with no `requests`/`input_tokens` would
      // sum to NaN in the panel. Repair rows only ever top up a real day.
      if (typeof row.requests !== 'number' || typeof row.input_tokens !== 'number') continue
      all[date] = { ...emptyDay(), ...row }
      continue
    }
    for (const field of COUNTERS) {
      mine[field] = Math.max(numberOr(mine[field], 0), numberOr(row[field], 0))
    }
    const kinds = mine.by_kind ?? (mine.by_kind = {})
    for (const [kind, slot] of Object.entries(row.by_kind ?? {})) {
      if (slot === null || typeof slot !== 'object') continue
      const target = kinds[kind] ?? (kinds[kind] = emptyCounters())
      for (const field of COUNTERS) {
        target[field] = Math.max(numberOr(target[field], 0), numberOr(slot[field], 0))
      }
    }
    if (typeof row.last?.at === 'string' && (mine.last?.at === undefined || row.last.at > mine.last.at)) {
      mine.last = row.last
    }
  }
}

const COUNTERS = ['requests', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'errors']

function load() {
  return loadFrom(stateFile())
}

function loadFrom(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && parsed.days !== null && typeof parsed.days === 'object'
      ? parsed.days
      : {}
  } catch {
    return {}
  }
}

function today() {
  // Local calendar day: the person watching the counter lives in this timezone.
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function bucket(date) {
  const all = ensure()
  const existing = all[date]
  if (existing !== undefined) return existing
  const created = emptyDay()
  all[date] = created
  return created
}

/**
 * One row of counters.
 *
 * `input_tokens` is the uncached prompt only, because that is what the provider
 * charges for as fresh context; cache hits are counted separately so the panel
 * can show both figures instead of one number that silently disagrees with the
 * host's own statistics (which fold cache reads into the prompt total).
 */
function emptyCounters() {
  return { requests: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, errors: 0 }
}

/** A day row: the same counters, plus the per-entry-point split. */
function emptyDay() {
  return { ...emptyCounters(), by_kind: {} }
}

function prune(all) {
  const keys = Object.keys(all).sort()
  while (keys.length > KEEP_DAYS) {
    delete all[keys.shift()]
  }
}

function persist(all) {
  try {
    const file = stateFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, days: all }, null, 2)}\n`)
    stamp = mtime()
  } catch {
    // Read-only home or a locked file: the counters still work in memory.
  }
}

/**
 * Record one finished call.
 * @param {{kind?: string, model?: string, usage?: object | null, ok?: boolean, code?: string | null, ms?: number}} row
 */
export function record({ kind = 'chat', model, usage = null, ok = true, code = null, ms = 0 }) {
  const all = ensure()
  const date = today()
  const day = bucket(date)
  const slot = day.by_kind[kind] ?? (day.by_kind[kind] = emptyCounters())
  const input = numberOr(usage?.inputTokens, 0)
  const output = numberOr(usage?.outputTokens, 0)
  const cacheRead = numberOr(usage?.cacheReadTokens, 0)
  const cacheWrite = numberOr(usage?.cacheWriteTokens, 0)
  for (const target of [day, slot]) {
    target.requests += 1
    target.input_tokens += input
    target.output_tokens += output
    target.cache_read_tokens = numberOr(target.cache_read_tokens, 0) + cacheRead
    target.cache_write_tokens = numberOr(target.cache_write_tokens, 0) + cacheWrite
    if (ok === false) target.errors += 1
  }
  day.last = { at: new Date().toISOString(), kind, model: model ?? null, ok, code, ms }
  prune(all)
  persist(all)
}

/** Today plus the retained days, shaped for the panel. */
export function snapshot() {
  const all = ensure()
  const date = today()
  const day = all[date] ?? { ...emptyDay() }
  return {
    today: date,
    requests: day.requests,
    input_tokens: day.input_tokens,
    output_tokens: day.output_tokens,
    cache_read_tokens: numberOr(day.cache_read_tokens, 0),
    cache_write_tokens: numberOr(day.cache_write_tokens, 0),
    errors: day.errors,
    by_kind: day.by_kind,
    ...(day.last === undefined ? {} : { last: day.last }),
    days: Object.keys(all).sort().map(key => ({
      date: key,
      requests: numberOr(all[key].requests, 0),
      input_tokens: numberOr(all[key].input_tokens, 0),
      output_tokens: numberOr(all[key].output_tokens, 0),
      cache_read_tokens: numberOr(all[key].cache_read_tokens, 0),
      cache_write_tokens: numberOr(all[key].cache_write_tokens, 0),
      errors: all[key].errors,
    })),
  }
}

/** Test seam: drop everything (also wipes the persisted file). */
export function reset() {
  days = {}
  persist(days)
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
