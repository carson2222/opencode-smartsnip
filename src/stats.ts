/**
 * Read-only access to snip's token tracking database (~/.local/share/snip/tracking.db).
 * Everything fails soft: any error returns null — stats are a bonus, never a breakage.
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface Savings {
  commands: number
  savedTokens: number
}

export function defaultTrackingDbPath(): string {
  return join(homedir(), ".local", "share", "snip", "tracking.db")
}

/**
 * Total snip savings recorded at or after `sinceUtcIso` (snip stores UTC
 * `datetime('now')` strings, e.g. "2026-06-09 21:36:38").
 */
export function savingsSince(
  sinceUtcIso: string,
  dbPath = defaultTrackingDbPath(),
): Savings | null {
  try {
    if (!existsSync(dbPath)) return null
    // bun:sqlite is built into the Bun runtime opencode plugins run under
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
    const db = new Database(dbPath, { readonly: true })
    try {
      const row = db
        .query(
          "SELECT COUNT(*) AS commands, COALESCE(SUM(saved_tokens), 0) AS savedTokens FROM commands WHERE timestamp >= ?",
        )
        .get(sinceUtcIso) as { commands: number; savedTokens: number } | undefined
      if (!row) return null
      return { commands: row.commands, savedTokens: row.savedTokens }
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

/** "2026-06-09 21:36:38" — snip's timestamp format, current UTC time. */
export function nowUtcSnipFormat(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ")
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
