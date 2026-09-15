import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PINNED_SNIP_VERSION } from "../src/snip-cli"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function doctor(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "smartsnip-doctor-"))
  const home = mkdtempSync(join(tmpdir(), "smartsnip-doctor-home-"))
  dirs.push(dir, home)

  const snip = join(dir, "snip")
  writeFileSync(
    snip,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "snip ${version}"; else printf 'tee.mode: always\\ndisplay.quiet_no_filter: true\\n'; fi\n`,
  )
  chmodSync(snip, 0o755)
  mkdirSync(join(dir, ".opencode"))
  writeFileSync(join(dir, ".opencode", "smartsnip.json"), JSON.stringify({ snipPath: snip }))

  const result = Bun.spawnSync(
    ["bun", join(import.meta.dir, "..", "bin", "smartsnip.ts"), "doctor"],
    { cwd: dir, env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, "data") } },
  )
  expect(result.exitCode).toBe(0)
  return result.stdout.toString()
}

describe("doctor version guidance", () => {
  test("older Snip recommends upgrading Snip", () => {
    const output = doctor("0.24.9")
    expect(output).toContain(`upgrade to ${PINNED_SNIP_VERSION} or newer`)
    expect(output).toContain("brew upgrade snip")
  })

  test("matching Snip reports matching routing rules", () => {
    const output = doctor(PINNED_SNIP_VERSION)
    expect(output).toContain("routing table is generated from this release")
    expect(output).not.toContain("upgrade")
  })

  test("newer Snip recommends checking for SmartSnip rules", () => {
    const output = doctor("0.26.0")
    expect(output).toContain(`embedded routing rules target ${PINNED_SNIP_VERSION}`)
    expect(output).toContain("Check for a SmartSnip update")
    expect(output).not.toContain("upgrade")
    expect(output).not.toContain("downgrade")
  })
})
