import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { formatTokens, nowUtcSnipFormat, savingsSince } from "../src/stats"

function makeDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "smartsnip-"))
  const path = join(dir, "tracking.db")
  const db = new Database(path)
  db.run(`CREATE TABLE commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT (datetime('now')),
    original_cmd TEXT NOT NULL, snip_cmd TEXT NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
    saved_tokens INTEGER NOT NULL, savings_pct REAL NOT NULL,
    exec_time_ms INTEGER NOT NULL)`)
  const ins = db.prepare(
    "INSERT INTO commands (timestamp, original_cmd, snip_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, exec_time_ms) VALUES (?,?,?,?,?,?,?,?)",
  )
  ins.run("2026-01-01 10:00:00", "git status", "snip git status", 100, 10, 90, 90, 50)
  ins.run("2026-01-02 10:00:00", "go test", "snip go test", 700, 20, 680, 97, 900)
  db.close()
  return path
}

describe("savingsSince", () => {
  test("sums rows at/after the cutoff", () => {
    const db = makeDb()
    expect(savingsSince("2026-01-01 00:00:00", db)).toEqual({ commands: 2, savedTokens: 770 })
    expect(savingsSince("2026-01-02 00:00:00", db)).toEqual({ commands: 1, savedTokens: 680 })
    expect(savingsSince("2026-01-03 00:00:00", db)).toEqual({ commands: 0, savedTokens: 0 })
  })

  test("fails soft on missing db", () => {
    expect(savingsSince("2026-01-01 00:00:00", "/nonexistent/tracking.db")).toBeNull()
  })
})

describe("helpers", () => {
  test("nowUtcSnipFormat matches snip's format", () => {
    expect(nowUtcSnipFormat()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  test("formatTokens", () => {
    expect(formatTokens(950)).toBe("950")
    expect(formatTokens(2_340)).toBe("2.3k")
    expect(formatTokens(2_300_000)).toBe("2.3M")
  })
})
