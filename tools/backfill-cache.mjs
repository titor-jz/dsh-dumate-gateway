/**
 * One-off repair: recover cache counters from the DSH session logs.
 *
 * 0.0.2 and everything before it recorded only uncached prompt tokens, so every
 * day already in `~/.dsh/dumate-gateway/usage.json` is missing its cache reads —
 * which is most of the prompt volume. The DSH session log carries the full
 * `TokenUsage` per assistant message, attributed to a provider, so the gateway's
 * share can be re-derived from it.
 *
 * The result goes to a SEPARATE file, `usage-recovered.json`, which the usage
 * module folds into its own state whenever it reads. Writing straight into
 * `usage.json` is not durable: a host process still running an older release
 * rewrites that file from its in-memory copy on the next request and takes the
 * recovered counters with it. A file the old code does not know about cannot be
 * clobbered that way.
 *
 * The merge is idempotent — counters are monotonic, so the reader takes `max`
 * per field, and re-running this tool just rewrites the same numbers.
 *
 *   node tools/backfill-cache.mjs           # dry run, prints the table
 *   node tools/backfill-cache.mjs --write   # write usage-recovered.json
 *
 * Only days the ledger already knows are recovered; a day before the gateway
 * existed does not turn into a row of half-truths.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

const PROVIDER = 'gateway'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const ZSTD = 'session.v4.jsonl.zstd'

const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const write = process.argv.includes('--write')

function dataDir() {
  return path.join(home, 'dumate-gateway')
}

function ledgerFile() {
  return path.join(dataDir(), 'usage.json')
}

function repairFile() {
  return path.join(dataDir(), 'usage-recovered.json')
}

/** Every session file under the DSH home, whatever workspace it belongs to. */
function sessionFiles() {
  const root = path.join(home, 'sessions')
  let workspaces = []
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())
  } catch {
    return []
  }
  const found = []
  for (const workspace of workspaces) {
    const dir = path.join(root, workspace.name)
    let sessions = []
    try {
      sessions = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory())
    } catch {
      continue
    }
    for (const session of sessions) {
      const file = path.join(dir, session.name, ZSTD)
      if (fs.existsSync(file)) found.push(file)
    }
  }
  return found
}

/**
 * A session file is a run of concatenated zstd frames; `zstdDecompressSync`
 * decodes only the first, so split on the magic number and decode each.
 */
function readSession(file) {
  const buf = fs.readFileSync(file)
  const starts = []
  for (let i = 0; i <= buf.length - MAGIC.length; i += 1) {
    if (buf.compare(MAGIC, 0, MAGIC.length, i, i + MAGIC.length) === 0) starts.push(i)
  }
  let text = ''
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length
    try {
      text += zlib.zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8')
    } catch {
      // A torn frame only costs that frame.
    }
  }
  return text
}

function dayKey(ms) {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Aggregate the gateway's cache counters per local day across every session. */
function derive() {
  const days = new Map()
  const files = sessionFiles()
  for (const file of files) {
    let text = ''
    try {
      text = readSession(file)
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line === '' || !line.includes('cacheRead')) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event?.type !== 'assistant/message') continue
      const data = event.data
      if (data?.message?.source?.provider !== PROVIDER) continue
      const usage = data.usage
      if (usage === null || typeof usage !== 'object') continue
      if (typeof event.time !== 'number') continue
      const key = dayKey(event.time)
      const row = days.get(key) ?? { calls: 0, cacheRead: 0, cacheWrite: 0, input: 0, output: 0 }
      row.calls += 1
      row.cacheRead += numberOr(usage.cacheReadTokens, 0)
      row.cacheWrite += numberOr(usage.cacheWriteTokens, 0)
      row.input += numberOr(usage.inputTokens, 0)
      row.output += numberOr(usage.outputTokens, 0)
      days.set(key, row)
    }
  }
  return { days, files: files.length }
}

function loadLedger() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerFile(), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && parsed.days !== null && typeof parsed.days === 'object'
      ? parsed
      : { version: 1, days: {} }
  } catch {
    return { version: 1, days: {} }
  }
}

function format(value) {
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(0)}k`
  return String(value)
}

const { days: derived, files } = derive()
const ledger = loadLedger()

console.log(`scanned ${files} session file(s) under ${path.join(home, 'sessions')}`)
const dates = [...new Set([...Object.keys(ledger.days), ...derived.keys()])].sort()
if (dates.length === 0) {
  console.log('nothing to do: no ledger rows and no gateway usage in the logs')
  process.exit(0)
}

let changed = 0
for (const date of dates) {
  const row = ledger.days[date]
  const fromLog = derived.get(date)
  if (row === undefined) {
    if (fromLog !== undefined) console.log(`${date}  ledger row absent; log has ${fromLog.calls} calls — skipped`)
    continue
  }
  const beforeRead = numberOr(row.cache_read_tokens, 0)
  const beforeWrite = numberOr(row.cache_write_tokens, 0)
  const nextRead = Math.max(beforeRead, numberOr(fromLog?.cacheRead, 0))
  const nextWrite = Math.max(beforeWrite, numberOr(fromLog?.cacheWrite, 0))
  row.cache_read_tokens = nextRead
  row.cache_write_tokens = nextWrite
  const totalBefore = numberOr(row.input_tokens, 0) + beforeRead + beforeWrite + numberOr(row.output_tokens, 0)
  const totalAfter = numberOr(row.input_tokens, 0) + nextRead + nextWrite + numberOr(row.output_tokens, 0)
  const mark = nextRead === beforeRead && nextWrite === beforeWrite ? 'unchanged' : 'filled'
  if (mark === 'filled') changed += 1
  console.log(
    `${date}  req ${String(numberOr(row.requests, 0)).padStart(4)}  ` +
    `total ${format(totalBefore).padStart(6)} -> ${format(totalAfter).padStart(6)}  ` +
    `(cached ${format(nextRead)}, log calls ${fromLog?.calls ?? 0})  ${mark}`,
  )
}

if (!write) {
  console.log(`\ndry run: ${changed} day(s) would change. Re-run with --write to save.`)
  process.exit(0)
}
if (changed === 0) {
  console.log('\nnothing to write.')
  process.exit(0)
}
// Only the recovered fields are written here; the live ledger keeps its own
// request counts and output tokens. Reading takes max per counter, so a row that
// already carries these numbers simply stays as it is.
const recovered = { version: 1, days: {} }
for (const date of dates) {
  const row = ledger.days[date]
  if (row === undefined) continue
  recovered.days[date] = {
    cache_read_tokens: numberOr(row.cache_read_tokens, 0),
    cache_write_tokens: numberOr(row.cache_write_tokens, 0),
  }
}
fs.mkdirSync(dataDir(), { recursive: true })
fs.writeFileSync(repairFile(), `${JSON.stringify(recovered, null, 2)}\n`)
console.log(`\nwrote ${repairFile()} (${changed} day(s) recovered)`)
console.log('the usage module folds this file in on read; no restart of a running host is needed for new code.')