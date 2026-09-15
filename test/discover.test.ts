/**
 * `discover` reports what opencode stored, over a fixture history database.
 * The numbers it prints used to read as "raw output" and "missed savings" while
 * they were neither: snip-filtered entries were stored already condensed, and a
 * pipeline's stored output belongs to its last stage, not its head.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HISTORY: { cmd: string; output: string }[] = [
  { cmd: "snip git status", output: "x".repeat(400) }, // already filtered when stored
  { cmd: "git diff", output: "y".repeat(800) }, // routing would wrap this today
  { cmd: "cargo fmt", output: "z".repeat(1200) }, // snip has no filter
  { cmd: "git log | head -5", output: "p".repeat(2000) }, // stored output is head's
  { cmd: "cargo fmt #nosnip", output: "q".repeat(1600) }, // an explicit decision
  { cmd: "for f in *; do echo $f; done", output: "u".repeat(600) }, // unparseable
  { cmd: "git diff --name-only", output: "w".repeat(700) }, // declined by exclude_flags
  { cmd: "git --no-pager log", output: "g".repeat(500) },
  { cmd: "curl -s https://example.com", output: "c".repeat(900) }, // denied data channel
]

let dataHome: string
let report: string

beforeAll(async () => {
  dataHome = mkdtempSync(join(tmpdir(), "smartsnip-discover-"))
  const dbDir = join(dataHome, "opencode")
  mkdirSync(dbDir, { recursive: true })
  const db = new Database(join(dbDir, "opencode.db"))
  db.run(
    "CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)",
  )
  const insert = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
  HISTORY.forEach((row, i) => {
    const data = JSON.stringify({
      type: "tool",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: row.cmd },
        output: row.output,
        time: { start: Date.now() },
      },
    })
    insert.run(`p${i}`, "m", "s", Date.now(), Date.now(), data)
  })
  db.close()

  const proc = Bun.spawnSync(["bun", join(import.meta.dir, "..", "bin", "smartsnip.ts"), "discover"], {
    env: { ...process.env, XDG_DATA_HOME: dataHome },
  })
  expect(proc.exitCode).toBe(0)
  report = proc.stdout.toString()
})

afterAll(() => rmSync(dataHome, { recursive: true, force: true }))

const sectionOf = (head: string): string => {
  const rest = report.slice(report.indexOf(head) + head.length)
  const end = rest.search(/\n[A-Z][A-Z ,'-]+[:(]/)
  return end === -1 ? rest : rest.slice(0, end)
}

describe("discover classification", () => {
  test("counts every stored bash call once", () => {
    expect(report).toContain(`${HISTORY.length} commands`)
  })

  test("a historical `snip git status` counts as filtered, not as a missed gap", () => {
    expect(sectionOf("RAN UNDER SNIP")).toMatch(/git\s+1 calls/)
    expect(sectionOf("NO FILTER IN SNIP")).not.toMatch(/^  git\s+\d+ calls/m)
  })

  test("wrap-eligible commands that ran raw are listed separately", () => {
    expect(sectionOf("WRAP-ELIGIBLE, RAN RAW")).toMatch(/git\s+1 calls/)
  })

  test("a pipeline is never credited to its head", () => {
    expect(report).toMatch(/PIPED[^\n]*: 1 calls/)
  })

  test("#nosnip is a decision, not a gap", () => {
    expect(report).toMatch(/OPTED OUT[^\n]*: 1 calls/)
    expect(sectionOf("NO FILTER IN SNIP")).not.toContain("cargo fmt #nosnip")
  })

  test("declined, denied and unparseable each land in their own bucket", () => {
    expect(report).toMatch(/DECLINED[^\n]*: 1 calls/)
    expect(report).toMatch(/UNPARSEABLE[^\n]*: 1 calls/)
    expect(sectionOf("DENIED by config")).toContain("curl")
  })

  test("a leading flag is a literal matcher key, not an excluded format", () => {
    expect(report).toMatch(/DECLINED[^\n]*: 1 calls/)
    expect(sectionOf("NO FILTER IN SNIP")).toContain("git log")
  })

  test("a genuine gap is still surfaced", () => {
    expect(sectionOf("NO FILTER IN SNIP")).toContain("cargo")
  })

  test("never calls stored characters raw output or savings", () => {
    expect(report).toContain("est. tokens of stored output")
    expect(report).not.toContain("raw output")
    expect(report.toLowerCase()).not.toContain("missed savings")
    expect(report).not.toContain("~5 min of YAML")
  })
})
