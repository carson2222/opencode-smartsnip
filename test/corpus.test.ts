/**
 * Replay tests over real-world commands captured from actual opencode sessions
 * (sanitized). Invariants must hold for every command ever observed:
 *
 *  1. Stripping the injected `snip ` prefixes restores the original command.
 *  2. rewrite(rewrite(x)) === rewrite(x)  (idempotency)
 *  3. No segment is ever double-wrapped.
 *
 * Set SMARTSNIP_CORPUS=/path/to/corpus.json to additionally replay a full
 * private corpus (not committed).
 */
import { describe, expect, test } from "bun:test"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { buildMatchTable } from "../src/filters"
import { rewrite } from "../src/router"
import { DEFAULT_DENY, type SmartSnipConfig } from "../src/config"

const config: SmartSnipConfig = {
  enabled: true,
  deny: [...DEFAULT_DENY],
  allow: [],
  snipPath: "snip",
  scanUserFilters: false,
  toast: false,
}
const table = buildMatchTable(config)

function loadCorpus(): string[] {
  const fixtures: string[] = JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures", "commands.json"), "utf8"),
  )
  const extra = process.env["SMARTSNIP_CORPUS"]
  if (extra && existsSync(extra)) {
    const rows = JSON.parse(readFileSync(extra, "utf8")) as { cmd: string | null }[]
    for (const r of rows) if (r.cmd) fixtures.push(r.cmd)
  }
  return fixtures
}

const corpus = loadCorpus()

describe(`corpus replay (${corpus.length} real commands)`, () => {
  test("unwrap restores original", () => {
    for (const cmd of corpus) {
      const out = rewrite(cmd, table, config)
      const restored = out.replaceAll(/(^|\s|;|&|\|)snip (?!gain|init|config|proxy|discover)/g, "$1")
      const restoredOriginal = cmd.replaceAll(/(^|\s|;|&|\|)snip (?!gain|init|config|proxy|discover)/g, "$1")
      expect(restored).toBe(restoredOriginal)
    }
  })

  test("idempotency: rewriting twice changes nothing", () => {
    for (const cmd of corpus) {
      const once = rewrite(cmd, table, config)
      const twice = rewrite(once, table, config)
      expect(twice).toBe(once)
    }
  })

  test("never introduces double-wrapping", () => {
    // historical corpora may contain literal `snip snip` from the old plugin's
    // stacking bug — the new router must never add to it
    for (const cmd of corpus) {
      if (cmd.includes("snip snip")) continue
      const out = rewrite(cmd, table, config)
      expect(out.includes("snip snip")).toBe(false)
    }
  })

  test("wrapped commands keep their structure", () => {
    for (const cmd of corpus) {
      const out = rewrite(cmd, table, config)
      if (out === cmd) continue
      // separators count must be identical
      const seps = (s: string) => (s.match(/&&|\|\||;|\|/g) ?? []).length
      expect(seps(out)).toBe(seps(cmd))
    }
  })
})
