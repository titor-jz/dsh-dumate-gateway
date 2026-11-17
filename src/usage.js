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

function stateFile() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'dumate-gateway', 'usage.json')
}

let days = null

// Load lazily so a test can point DSH_HOME at a scratch directory before the
// first read or write, even though this module is imported statically.
function ensure() {
  if (days === null) days = load()
  return days
}

function load() {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf8')
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
  const created = { requests: 0, input_tokens: 0, output_tokens: 0, errors: 0, by_kind: {} }
  all[date] = created
  return created
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
  const slot = day.by_kind[kind] ?? (day.by_kind[kind] = { requests: 0, input_tokens: 0, output_tokens: 0, errors: 0 })
  const input = numberOr(usage?.inputTokens, 0)
  const output = numberOr(usage?.outputTokens, 0)
  for (const target of [day, slot]) {
    target.requests += 1
    target.input_tokens += input
    target.output_tokens += output
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
  const day = all[date] ?? { requests: 0, input_tokens: 0, output_tokens: 0, errors: 0, by_kind: {} }
  return {
    today: date,
    requests: day.requests,
    input_tokens: day.input_tokens,
    output_tokens: day.output_tokens,
    errors: day.errors,
    by_kind: day.by_kind,
    ...(day.last === undefined ? {} : { last: day.last }),
    days: Object.keys(all).sort().map(key => ({
      date: key,
      requests: all[key].requests,
      input_tokens: all[key].input_tokens,
      output_tokens: all[key].output_tokens,
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
