#!/usr/bin/env bun
/**
 * measure-savings.ts — replay your real opencode bash history through the ACTUAL
 * snip filters and report measured token savings. This is the script behind the
 * "Numbers" section of the README; run it on your own history to reproduce.
 *
 *   bun scripts/measure-savings.ts --days 7
 *   bun scripts/measure-savings.ts --days 1 --dir myproject
 *
 * Honest accounting:
 *   - Recorded stdout is fed back to snip via a PATH shim — no command re-runs,
 *     no side effects. snip applies the same filter it would in a live session.
 *   - Only commands smartsnip wraps as a SINGLE top-level segment are replayed
 *     exactly. Chained / multi-segment commands are counted as UNFILTERED, so the
 *     headline percentage is conservative (real savings are higher).
 *   - opencode stores stdout+stderr merged and we replay it on stdout; filters
 *     keyed to the stderr stream (e.g. some test runners) are under-credited.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config"
import { buildMatchTable } from "../src/filters"
import { rewrite } from "../src/router"
import { splitTopLevel } from "../src/parser"
import { formatTokens } from "../src/stats"

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name)
  const v = i !== -1 ? process.argv[i + 1] : undefined
  return v ?? def
}

const days = Number(arg("--days", "7")) || 7
const dirFilter = arg("--dir", "")

const dataRoot = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share")
const DB = join(dataRoot, "opencode", "opencode.db")

const snip = Bun.which("snip")
if (!snip) {
  console.error("snip not found on PATH — install it first (brew install edouard-claude/tap/snip)")
  process.exit(1)
}

const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
let db: InstanceType<typeof Database>
try {
  db = new Database(DB, { readonly: true })
} catch {
  console.error(`opencode database not found at ${DB}`)
  process.exit(1)
}

const since = Date.now() - days * 86_400_000
const where = [
  "json_extract(p.data,'$.type')='tool'",
  "json_extract(p.data,'$.tool')='bash'",
  "json_extract(p.data,'$.state.status')='completed'",
  "json_extract(p.data,'$.state.time.start') >= ?",
]
const params: (string | number)[] = [since]
if (dirFilter) {
  where.push("s.directory LIKE ?")
  params.push(`%${dirFilter}%`)
}

const rows = db
  .query(
    `SELECT p.session_id AS sid,
            json_extract(p.data,'$.state.time.start') AS t,
            json_extract(p.data,'$.state.input.command') AS cmd,
            json_extract(p.data,'$.state.output') AS out
     FROM part p JOIN session s ON s.id = p.session_id
     WHERE ${where.join(" AND ")}`,
  )
  .all(...params) as { sid: string; t: number; cmd: string | null; out: string | null }[]

// assistant message timestamps per session — for the context-resend multiplier
const msgRows = db
  .query(
    `SELECT m.session_id AS sid, m.time_created AS t FROM message m
     JOIN session s ON s.id = m.session_id
     WHERE json_extract(m.data,'$.role')='assistant'
       AND m.time_created >= ?${dirFilter ? " AND s.directory LIKE ?" : ""}`,
  )
  .all(...(dirFilter ? [since, `%${dirFilter}%`] : [since])) as { sid: string; t: number }[]
db.close()

const msgTimes = new Map<string, number[]>()
for (const m of msgRows) {
  const a = msgTimes.get(m.sid) ?? []
  a.push(m.t)
  msgTimes.set(m.sid, a)
}
for (const a of msgTimes.values()) a.sort((x, y) => x - y)

const config = loadConfig(process.cwd())
const table = buildMatchTable(config)

const work = mkdtempSync(join(tmpdir(), "smartsnip-measure-"))
const binDir = join(work, "bin")
const home = join(work, "home")
Bun.spawnSync(["mkdir", "-p", binDir, home])
const payload = join(work, "payload")

let rawTotal = 0
let afterTotal = 0
let replayed = 0
let chained = 0
let resendWeighted = 0
const perHead = new Map<string, { calls: number; raw: number; after: number }>()

for (const r of rows) {
  if (!r.cmd) continue
  const raw = (r.out ?? "").length
  rawTotal += raw

  // context-resend multiplier: how many assistant turns re-send this output
  const after = (msgTimes.get(r.sid) ?? []).filter((mt) => mt > r.t).length
  resendWeighted += raw * after

  const rewritten = rewrite(r.cmd, table, config)
  if (rewritten === r.cmd) {
    afterTotal += raw
    continue
  }
  const pieces = splitTopLevel(r.cmd)
  const segs = pieces ? pieces.filter((p) => p.kind !== "op") : []
  if (segs.length !== 1) {
    chained++
    afterTotal += raw // conservative: no credit for partial wraps
    continue
  }

  const head = r.cmd.trim().split(/\s+/)[0]!
  writeFileSync(payload, r.out ?? "")
  const shim = join(binDir, head)
  writeFileSync(shim, `#!/bin/sh\ncat "${payload}"\n`)
  chmodSync(shim, 0o755)
  const proc = Bun.spawnSync(["sh", "-c", `${snip} ${r.cmd}`], {
    env: { PATH: `${binDir}:/usr/bin:/bin`, HOME: home }, // isolate snip db/tee/config
    stdout: "pipe",
    stderr: "pipe",
  })
  const filtered = proc.stdout.toString().length
  replayed++
  afterTotal += filtered
  const agg = perHead.get(head) ?? { calls: 0, raw: 0, after: 0 }
  agg.calls++
  agg.raw += raw
  agg.after += filtered
  perHead.set(head, agg)
}

rmSync(work, { recursive: true, force: true })

const pct = (a: number, b: number) => (b === 0 ? 0 : 100 * (1 - a / b))
const tok = (chars: number) => formatTokens(Math.round(chars / 4))

console.log(`\nmeasure-savings — last ${days} days${dirFilter ? ` in *${dirFilter}*` : ""}`)
console.log(`${rows.length} bash calls  ·  ${replayed} replayed through snip  ·  ${chained} chained (no credit)\n`)
console.log(`raw bash output      ${tok(rawTotal).padStart(9)}`)
console.log(`with smartsnip       ${tok(afterTotal).padStart(9)}`)
console.log(`saved                ${tok(rawTotal - afterTotal).padStart(9)}   = ${pct(afterTotal, rawTotal).toFixed(1)}% of bash output`)

if (perHead.size) {
  console.log(`\nper command (exact replay):`)
  for (const [k, a] of [...perHead].sort((x, y) => y[1].raw - x[1].raw))
    console.log(`  ${k.padEnd(16)} ${String(a.calls).padStart(4)} calls  ${tok(a.raw).padStart(8)} -> ${tok(a.after).padStart(8)}  (${pct(a.after, a.raw).toFixed(0)}% cut)`)
}

console.log(`\ncontext-resend multiplier: bash output is re-sent on each following turn.`)
console.log(`raw output × resends:  ${tok(resendWeighted)} of cumulative context traffic`)
console.log(`saved at the source:   ~${tok((resendWeighted / Math.max(rawTotal, 1)) * (rawTotal - afterTotal))} of that never travels\n`)
