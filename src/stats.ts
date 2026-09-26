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
export async function savingsSince(
  sinceUtcIso: string,
  dbPath = defaultTrackingDbPath(),
): Promise<Savings | null> {
  try {
    if (!existsSync(dbPath)) return null
    const query = "SELECT COUNT(*) AS commands, COALESCE(SUM(saved_tokens), 0) AS savedTokens FROM commands WHERE timestamp >= ?"
    let row: unknown
    if ("Bun" in globalThis) {
      const { Database } = await import("bun:sqlite")
      const db = new Database(dbPath, { readonly: true })
      try {
        row = db.query(query).get(sinceUtcIso)
      } finally {
        db.close()
      }
    } else {
      const { DatabaseSync } = await import("node:sqlite")
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        row = db.prepare(query).get(sinceUtcIso)
      } finally {
        db.close()
      }
    }
    if (typeof row !== "object" || row === null || !("commands" in row) || !("savedTokens" in row)) return null
    if (typeof row.commands !== "number" || typeof row.savedTokens !== "number") return null
    return { commands: row.commands, savedTokens: row.savedTokens }
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
