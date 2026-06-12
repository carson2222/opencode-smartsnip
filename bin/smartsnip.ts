#!/usr/bin/env bun
/**
 * smartsnip CLI — opencode-native counterparts to headroom's `learn` and snip's
 * `discover`, built on your real opencode session history.
 *
 *   smartsnip discover   scan opencode's local DB for missed token savings
 *   smartsnip doctor     check the smartsnip/snip setup end to end
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { loadConfig, DEFAULT_DENY } from "../src/config"
import { buildMatchTable } from "../src/filters"
import { BUILTINS, shouldWrap } from "../src/router"
import { splitTopLevel, analyzeSegment } from "../src/parser"
import { formatTokens } from "../src/stats"

const dataRoot = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share")
const OPENCODE_DB = join(dataRoot, "opencode", "opencode.db")

function opendb(path: string) {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
  return new Database(path, { readonly: true })
}

interface Agg {
  calls: number
  outChars: number
}

/** True when a filter rule matches command+subcommand regardless of flag exclusions. */
function matchesFilterIgnoringFlags(
  head: string,
  sub: string | null,
  table: ReturnType<typeof buildMatchTable>,
): boolean {
  const entry = table.get(head)
  if (!entry) return false
  return entry.subcommands.has(null) || (sub !== null && entry.subcommands.has(sub))
}

function discover(days: number): void {
  if (!existsSync(OPENCODE_DB)) {
    console.error(`opencode database not found at ${OPENCODE_DB}`)
    process.exit(1)
  }
  const config = loadConfig(process.cwd())
  const table = buildMatchTable(config)
  const db = opendb(OPENCODE_DB)

  const since = Date.now() - days * 86_400_000
  const rows = db
    .query(
      `SELECT json_extract(data,'$.state.input.command') AS cmd,
              LENGTH(json_extract(data,'$.state.output')) AS len
       FROM part
       WHERE json_extract(data,'$.type')='tool'
         AND json_extract(data,'$.tool')='bash'
         AND json_extract(data,'$.state.status')='completed'
         AND json_extract(data,'$.state.time.start') >= ?`,
    )
    .all(since) as { cmd: string | null; len: number | null }[]
  db.close()

  const wrapped = new Map<string, Agg>()
  const denied = new Map<string, Agg>()
  const noFilter = new Map<string, Agg>()
  const formatExcluded: Agg = { calls: 0, outChars: 0 }
  const unparseable: Agg = { calls: 0, outChars: 0 }
  let total = 0
  let totalChars = 0

  const bump = (m: Map<string, Agg>, key: string, chars: number) => {
    const a = m.get(key) ?? { calls: 0, outChars: 0 }
    a.calls++
    a.outChars += chars
    m.set(key, a)
  }

  for (const r of rows) {
    if (!r.cmd) continue
    total++
    const chars = r.len ?? 0
    totalChars += chars
    const pieces = splitTopLevel(r.cmd)
    if (!pieces) {
      unparseable.calls++
      unparseable.outChars += chars
      continue
    }
    // classify every interesting top-level segment; share output chars evenly
    const segs: { head: string; sub: string | null; text: string }[] = []
    let prevOp: string | null = null
    for (const p of pieces) {
      if (p.kind === "op") {
        prevOp = p.text
        continue
      }
      const downstreamOfPipe = prevOp === "|" || prevOp === "|&"
      prevOp = null
      if (downstreamOfPipe || !p.text.trim()) continue // pipe consumers are never wrappable
      const info = analyzeSegment(p.text)
      if (!info) continue
      if (BUILTINS.has(info.head)) continue // builtins are noise, not opportunity
      if (info.head === "snip") continue // already-wrapped historical commands
      segs.push({ head: info.head, sub: info.subcommand, text: p.text })
    }
    if (segs.length === 0) {
      unparseable.calls++
      unparseable.outChars += chars
      continue
    }
    const share = chars / segs.length
    for (const s of segs) {
      if (shouldWrap(s.text, table, config)) {
        bump(wrapped, s.head, share)
      } else if (
        table.has(s.head) &&
        (config.deny.includes(s.head) || (s.sub && config.deny.includes(`${s.head} ${s.sub}`)))
      ) {
        bump(denied, s.head, share)
      } else if (matchesFilterIgnoringFlags(s.head, s.sub, table)) {
        // a filter exists but the agent asked for a specific format (exclude_flags)
        // — intentional decline, not a missed saving
        formatExcluded.calls++
        formatExcluded.outChars += share
      } else {
        // subcommand granularity for commands snip partially covers (e.g. "git checkout")
        const sub = s.sub && /^[a-z0-9:_-]+$/i.test(s.sub) ? s.sub : null
        const key = table.has(s.head) && sub ? `${s.head} ${sub}` : s.head
        bump(noFilter, key, share)
      }
    }
  }

  const top = (m: Map<string, Agg>, n: number) =>
    [...m.entries()].sort((a, b) => b[1].outChars - a[1].outChars).slice(0, n)
  const line = (k: string, a: Agg) =>
    `  ${k.padEnd(24)} ${String(a.calls).padStart(6)} calls  ${formatTokens(Math.round(a.outChars / 4)).padStart(8)} est. tokens`

  console.log(`\nsmartsnip discover — last ${days} days of opencode bash history`)
  console.log(`${total} commands, ~${formatTokens(Math.round(totalChars / 4))} tokens of raw output\n`)

  console.log("FILTERED by snip (working for you):")
  for (const [k, a] of top(wrapped, 10)) console.log(line(k, a))

  const deniedTop = top(denied, 5)
  if (deniedTop.length) {
    console.log("\nDENIED by config (data channels — re-enable with \"allow\" if safe):")
    for (const [k, a] of deniedTop) console.log(line(k, a))
  }

  console.log("\nNO FILTER (biggest missed savings first):")
  for (const [k, a] of top(noFilter, 10)) console.log(line(k, a))

  if (formatExcluded.calls > 0)
    console.log(
      `\nDECLINED — agent asked for a specific format (exclude_flags): ${formatExcluded.calls} calls, ~${formatTokens(Math.round(formatExcluded.outChars / 4))} est. tokens`,
    )
  console.log(
    `\nUNWRAPPABLE (heredocs/control flow/pipes-only): ${unparseable.calls} calls, ~${formatTokens(Math.round(unparseable.outChars / 4))} est. tokens`,
  )

  const best = top(noFilter, 3).filter(([, a]) => a.outChars > 100_000)
  if (best.length) {
    console.log("\nSuggestions:")
    for (const [k] of best) {
      console.log(
        `  - write a snip filter for '${k}' (~5 min of YAML): https://github.com/edouard-claude/snip/blob/master/SKILL.md`,
      )
    }
    console.log(`  then it is auto-detected — no plugin config needed (scanUserFilters).`)
    console.log(
      `  tip: \`smartsnip install-command\` adds a /snip-filter slash command that automates this.`,
    )
  }
  console.log()
}

async function doctor(): Promise<void> {
  const config = loadConfig(process.cwd())
  const ok = (s: string) => console.log(`  ✓ ${s}`)
  const warn = (s: string) => console.log(`  ! ${s}`)

  console.log("\nsmartsnip doctor\n")

  // snip binary
  const which = Bun.spawnSync(["sh", "-c", `command -v ${config.snipPath}`])
  if (which.exitCode === 0) ok(`snip binary: ${which.stdout.toString().trim()}`)
  else warn(`'${config.snipPath}' not on PATH — plugin will disable itself`)

  // snip config / tee mode (reversibility)
  const snipCfg = Bun.spawnSync(["sh", "-c", `${config.snipPath} config 2>/dev/null`])
  const cfgText = snipCfg.stdout.toString()
  const teeMode = cfgText.match(/tee\.mode:\s*(\S+)/)?.[1]
  if (teeMode === "always")
    ok("tee.mode=always — every filtered output is recoverable ([full output: …] markers)")
  else if (teeMode === "failures")
    warn(
      "tee.mode=failures — raw output only saved when commands fail.\n" +
        "    For headroom-style full reversibility set in ~/.config/snip/config.toml:\n" +
        '    [tee]\n    mode = "always"',
    )
  else warn("could not read snip tee mode")
  const quiet = cfgText.match(/display\.quiet_no_filter:\s*(\S+)/)?.[1]
  if (quiet === "true") ok("quiet_no_filter=true")
  else
    console.log(
      "  i quiet_no_filter=false — harmless with allowlist routing (smartsnip never routes unfiltered commands)",
    )

  // config files
  for (const p of [
    join(homedir(), ".config", "opencode", "smartsnip.json"),
    join(process.cwd(), ".opencode", "smartsnip.json"),
  ]) {
    if (existsSync(p)) {
      try {
        JSON.parse(readFileSync(p, "utf8"))
        ok(`config: ${p}`)
      } catch {
        warn(`config has invalid JSON: ${p}`)
      }
    }
  }

  // effective routing table
  const table = buildMatchTable(config)
  ok(`allowlist: ${table.size} commands wrap-eligible`)
  ok(`deny list: ${config.deny.join(", ") || "(empty)"}`)
  if (JSON.stringify(config.deny) !== JSON.stringify(DEFAULT_DENY))
    console.log("    (customized from defaults)")

  // opencode DB for discover
  if (existsSync(OPENCODE_DB)) ok(`opencode history: ${OPENCODE_DB}`)
  else warn("opencode history db not found — `smartsnip discover` unavailable")
  console.log()
}

function installCommand(project: boolean): void {
  const src = join(import.meta.dir, "..", "commands", "snip-filter.md")
  const destDir = project
    ? join(process.cwd(), ".opencode", "commands")
    : join(homedir(), ".config", "opencode", "commands")
  mkdirSync(destDir, { recursive: true })
  const dest = join(destDir, "snip-filter.md")
  copyFileSync(src, dest)
  console.log(`installed /snip-filter command -> ${dest}`)
  console.log(
    "Slash commands cost zero prompt tokens until invoked — unlike a skill, which is listed in every request.",
  )
}

const cmd = process.argv[2]
if (cmd === "discover") {
  const daysArg = process.argv.indexOf("--days")
  const days = daysArg !== -1 ? Number(process.argv[daysArg + 1]) || 30 : 30
  discover(days)
} else if (cmd === "doctor") {
  await doctor()
} else if (cmd === "install-command") {
  installCommand(process.argv.includes("--project"))
} else {
  console.log(`smartsnip — opencode plugin companion CLI

Usage:
  smartsnip discover [--days N]      missed-savings report from your real opencode history (default 30 days)
  smartsnip doctor                   verify snip + plugin setup, reversibility, effective routing
  smartsnip install-command          install the /snip-filter slash command (zero prompt cost)
                     [--project]     install into ./.opencode/commands instead of global config`)
  process.exit(cmd ? 1 : 0)
}
