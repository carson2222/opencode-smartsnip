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
import { BUILTINS, isSnipHead, OPT_OUT_RE, shouldWrap, stripSnipPrefix } from "../src/router"
import { splitTopLevel, analyzeSegment } from "../src/parser"
import { PINNED_SNIP_VERSION, resolveSnip, snipVersion } from "../src/snip-cli"
import { formatTokens } from "../src/stats"

const dataRoot = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share")
const OPENCODE_DB = join(dataRoot, "opencode", "opencode.db")

function opendb(path: string) {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
  return new Database(path, { readonly: true })
}

interface Agg {
  calls: number
  /**
   * Characters of tool output as opencode stored them. For a segment that ran
   * under snip this is already the filtered text, so it is never a saving and
   * never the raw size — only what the model actually read.
   */
  storedChars: number
}

function matchesFilterIgnoringFlags(
  head: string,
  matcherKey: string,
  table: ReturnType<typeof buildMatchTable>,
): boolean {
  const entry = table.get(head)
  if (!entry) return false
  return entry.subcommands.has(null) || entry.subcommands.has(matcherKey)
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
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

  const alreadyFiltered = new Map<string, Agg>()
  const wouldWrap = new Map<string, Agg>()
  const denied = new Map<string, Agg>()
  const noFilter = new Map<string, Agg>()
  const formatExcluded: Agg = { calls: 0, storedChars: 0 }
  const piped: Agg = { calls: 0, storedChars: 0 }
  const optedOut: Agg = { calls: 0, storedChars: 0 }
  const unparseable: Agg = { calls: 0, storedChars: 0 }
  let total = 0
  let totalChars = 0

  const bump = (m: Map<string, Agg>, key: string, chars: number) => {
    const a = m.get(key) ?? { calls: 0, storedChars: 0 }
    a.calls++
    a.storedChars += chars
    m.set(key, a)
  }
  const bumpOne = (a: Agg, chars: number) => {
    a.calls++
    a.storedChars += chars
  }

  for (const r of rows) {
    if (!r.cmd) continue
    total++
    const chars = r.len ?? 0
    totalChars += chars

    // an explicit opt-out is a decision, not a gap
    if (OPT_OUT_RE.test(r.cmd)) {
      bumpOne(optedOut, chars)
      continue
    }
    const pieces = splitTopLevel(r.cmd)
    if (!pieces) {
      bumpOne(unparseable, chars)
      continue
    }
    // In a pipeline the stored output belongs to the last stage, so nothing
    // about the head's filter can be read off these characters.
    if (pieces.some((p) => p.kind === "op" && (p.text === "|" || p.text === "|&"))) {
      bumpOne(piped, chars)
      continue
    }

    // classify every interesting top-level segment; split stored chars evenly
    const segs: { head: string; sub: string | null; matcherKey: string; text: string; wasWrapped: boolean }[] = []
    for (const p of pieces) {
      if (p.kind === "op" || !p.text.trim()) continue
      // history stores the rewritten command, so unwrap it and judge the real one
      const text = stripSnipPrefix(p.text, config.snipPath)
      const info = analyzeSegment(text)
      if (!info) continue
      if (BUILTINS.has(info.head)) continue // builtins are noise, not opportunity
      // what survives stripping with a snip head is snip's own CLI (`snip gain`)
      if (isSnipHead(info.head, config.snipPath)) continue
      segs.push({
        head: info.head,
        sub: info.subcommand,
        matcherKey: info.tokens[1] ?? "",
        text,
        wasWrapped: text !== p.text,
      })
    }
    if (segs.length === 0) {
      bumpOne(unparseable, chars)
      continue
    }
    const share = chars / segs.length
    for (const s of segs) {
      if (s.wasWrapped) {
        bump(alreadyFiltered, s.head, share)
      } else if (shouldWrap(s.text, table, config)) {
        bump(wouldWrap, s.head, share)
      } else if (
        table.has(s.head) &&
        (config.deny.includes(s.head) || (s.sub && config.deny.includes(`${s.head} ${s.sub}`)))
      ) {
        bump(denied, s.head, share)
      } else if (matchesFilterIgnoringFlags(s.head, s.matcherKey, table)) {
        // a filter exists but the agent asked for a specific format (exclude_flags)
        // — an intentional decline
        bumpOne(formatExcluded, share)
      } else {
        // subcommand granularity for commands snip partially covers (e.g. "git checkout")
        const sub = s.sub && /^[a-z0-9:_-]+$/i.test(s.sub) ? s.sub : null
        const key = table.has(s.head) && sub ? `${s.head} ${sub}` : s.head
        bump(noFilter, key, share)
      }
    }
  }

  const top = (m: Map<string, Agg>, n: number) =>
    [...m.entries()].sort((a, b) => b[1].storedChars - a[1].storedChars).slice(0, n)
  const line = (k: string, a: Agg) =>
    `  ${k.padEnd(24)} ${String(a.calls).padStart(6)} calls  ${formatTokens(Math.round(a.storedChars / 4)).padStart(8)} est. tokens`
  const one = (label: string, a: Agg) =>
    console.log(`${label}: ${a.calls} calls, ~${formatTokens(Math.round(a.storedChars / 4))} est. tokens`)

  console.log(`\nsmartsnip discover — last ${days} days of opencode bash history`)
  console.log(
    `${total} commands, ~${formatTokens(Math.round(totalChars / 4))} est. tokens of stored output.`,
  )
  console.log(
    "Counts below are what opencode stored, not raw command output and not savings:\n" +
      "snip-filtered entries were already condensed before they were stored.\n",
  )

  console.log("RAN UNDER SNIP (stored output is post-filter):")
  for (const [k, a] of top(alreadyFiltered, 10)) console.log(line(k, a))

  console.log("\nWRAP-ELIGIBLE, RAN RAW (routing would wrap these today):")
  for (const [k, a] of top(wouldWrap, 10)) console.log(line(k, a))

  const deniedTop = top(denied, 5)
  if (deniedTop.length) {
    console.log("\nDENIED by config (data channels — re-enable with \"allow\" if safe):")
    for (const [k, a] of deniedTop) console.log(line(k, a))
  }

  console.log("\nNO FILTER IN SNIP (largest stored output first):")
  for (const [k, a] of top(noFilter, 10)) console.log(line(k, a))

  console.log()
  if (formatExcluded.calls > 0) one("DECLINED — a specific format was requested (exclude_flags)", formatExcluded)
  if (optedOut.calls > 0) one("OPTED OUT — #nosnip", optedOut)
  one("PIPED — stored output is the last stage's, so the head's filter tells nothing", piped)
  one("UNPARSEABLE — heredocs, control flow, subshells", unparseable)
  console.log()
}

async function doctor(): Promise<void> {
  const config = loadConfig(process.cwd())
  const ok = (s: string) => console.log(`  ✓ ${s}`)
  const warn = (s: string) => console.log(`  ! ${s}`)

  console.log("\nsmartsnip doctor\n")

  const resolved = resolveSnip(config.snipPath)
  if (!resolved) warn(`'${config.snipPath}' not found — plugin will disable itself`)
  else {
    ok(`snip binary: ${resolved}`)
    const version = snipVersion(resolved)
    if (!version) warn("could not read snip's version")
    else if (version === PINNED_SNIP_VERSION)
      ok(`snip ${version} (routing table is generated from this release)`)
    else if (compareVersions(version, PINNED_SNIP_VERSION) < 0)
      warn(
        `snip ${version} installed; routing is generated from ${PINNED_SNIP_VERSION}.\n` +
          `    Filters differ between releases, so upgrade to ${PINNED_SNIP_VERSION} or newer:\n` +
          "    brew upgrade snip",
      )
    else
      warn(
        `snip ${version} installed; embedded routing rules target ${PINNED_SNIP_VERSION}.\n` +
          "    Check for a SmartSnip update with rules for this Snip release.",
      )
  }

  // snip config / tee mode (reversibility)
  let cfgText = ""
  if (resolved) {
    const snipCfg = Bun.spawnSync([resolved, "config"], { stderr: "ignore" })
    cfgText = snipCfg.stdout.toString()
  }
  const teeMode = cfgText.match(/tee\.mode:\s*(\S+)/)?.[1]
  if (teeMode === "always")
    ok(
      "tee.mode=always — raw output is saved and linked as [full output: …].\n" +
        "    Outputs under 500 bytes are skipped; default limits are 1 MiB per file\n" +
        "    and 20 files. Use #nosnip when you need unfiltered output.",
    )
  else if (teeMode === "failures")
    warn(
      "tee.mode=failures — raw output only saved when commands fail.\n" +
        "    To save it for successful commands too, set in ~/.config/snip/config.toml:\n" +
        '    [tee]\n    mode = "always"',
    )
  else warn("could not read snip tee mode")
  const quiet = cfgText.match(/display\.quiet_no_filter:\s*(\S+)/)?.[1]
  if (quiet === "true") ok("quiet_no_filter=true — agent-mimicked snip prefixes stay silent")
  else if (!cfgText) warn("could not read quiet_no_filter setting")
  else
    warn(
      "quiet_no_filter=false — opencode persists rewritten commands, so agents start\n" +
        "    typing `snip` themselves, sometimes where snip has no filter. smartsnip strips\n" +
        "    most of that (stripMimicry), but set this as a backstop in ~/.config/snip/config.toml:\n" +
        "    [display]\n    quiet_no_filter = true",
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
