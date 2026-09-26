import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join, relative } from "node:path"
import { resolveSnip, snipVersion } from "../src/snip-cli"

describe("snip executable lookup", () => {
  let dir: string
  let originalPath: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "smartsnip-lookup-"))
    originalPath = process.env["PATH"]
  })

  afterEach(() => {
    if (originalPath === undefined) delete process.env["PATH"]
    else process.env["PATH"] = originalPath
    rmSync(dir, { recursive: true, force: true })
  })

  test("finds the first executable file on PATH and skips empty entries", () => {
    const first = join(dir, "snip")
    writeFileSync(first, "#!/bin/sh\nprintf 'snip 0.25.2\\n'\n")
    chmodSync(first, 0o755)
    process.env["PATH"] = ["", dir, ""].join(delimiter)
    expect(resolveSnip("snip")).toBe(first)
    expect(snipVersion(first)).toBe("0.25.2")
  })

  test("empty PATH entries do not search the current directory", () => {
    const file = join(dir, "snip")
    writeFileSync(file, "#!/bin/sh\nexit 0\n")
    chmodSync(file, 0o755)
    const cwd = process.cwd()
    try {
      process.chdir(dir)
      process.env["PATH"] = delimiter
      expect(resolveSnip("snip")).toBeNull()
    } finally {
      process.chdir(cwd)
    }
  })

  test("rejects non-executable files and directories on PATH", () => {
    const file = join(dir, "snip")
    writeFileSync(file, "not executable")
    chmodSync(file, 0o644)
    process.env["PATH"] = dir
    expect(resolveSnip("snip")).toBeNull()
    expect(resolveSnip(".")).toBeNull()
  })

  test("accepts absolute and cwd-relative paths with a slash", () => {
    const file = join(dir, "snip")
    writeFileSync(file, "#!/bin/sh\nexit 0\n")
    chmodSync(file, 0o755)
    process.env["PATH"] = ""
    expect(resolveSnip(file)).toBe(file)
    expect(resolveSnip(relative(process.cwd(), file))).toBe(file)
    chmodSync(file, 0o644)
    expect(resolveSnip(file)).toBeNull()
  })
})
