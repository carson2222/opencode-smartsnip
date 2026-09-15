// Linux lacks the /usr/bin/command fallback that hid issue #2 on macOS.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/index"

const noopClient = { tui: { showToast: async () => {} } }

function makeStub(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, "#!/bin/sh\nexit 0\n")
  chmodSync(path, 0o755)
  return path
}

async function start(projectDir: string) {
  // The Plugin input carries more than the probe path needs; opencode supplies
  // the rest at runtime.
  return await plugin.server({ client: noopClient, directory: projectDir } as never)
}

function project(config?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "smartsnip-startup-"))
  if (config) {
    mkdirSync(join(dir, ".opencode"), { recursive: true })
    writeFileSync(join(dir, ".opencode", "smartsnip.json"), JSON.stringify(config))
  }
  return dir
}

describe("startup probe", () => {
  let stubDir: string
  let originalPath: string | undefined
  let originalHome: string | undefined
  const dirs: string[] = []

  beforeEach(() => {
    stubDir = mkdtempSync(join(tmpdir(), "smartsnip-bin-"))
    dirs.push(stubDir)
    originalPath = process.env["PATH"]
    originalHome = process.env["HOME"]
    const home = mkdtempSync(join(tmpdir(), "smartsnip-home-"))
    dirs.push(home)
    process.env["HOME"] = home
  })

  afterEach(() => {
    if (originalPath === undefined) delete process.env["PATH"]
    else process.env["PATH"] = originalPath
    if (originalHome === undefined) delete process.env["HOME"]
    else process.env["HOME"] = originalHome
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  test("finds an executable that is only on PATH — no shell involved", async () => {
    makeStub(stubDir, "snip")
    process.env["PATH"] = stubDir
    const dir = project()
    dirs.push(dir)

    const hooks = await start(dir)
    expect(Object.keys(hooks)).toContain("tool.execute.before")
  })

  test("disables itself when the binary is genuinely missing", async () => {
    process.env["PATH"] = stubDir // exists, holds no snip
    const dir = project()
    dirs.push(dir)

    expect(await start(dir)).toEqual({})
  })

  test("an absolute snipPath works with PATH empty", async () => {
    const abs = makeStub(stubDir, "snip-custom")
    process.env["PATH"] = ""
    const dir = project({ snipPath: abs })
    dirs.push(dir)

    const hooks = await start(dir)
    expect(Object.keys(hooks)).toContain("tool.execute.before")
  })

  test("a non-executable file at snipPath counts as missing", async () => {
    const path = join(stubDir, "snip-noexec")
    writeFileSync(path, "#!/bin/sh\n")
    chmodSync(path, 0o644)
    const dir = project({ snipPath: path })
    dirs.push(dir)

    expect(await start(dir)).toEqual({})
  })

  test("the started plugin's bash hook actually rewrites the command", async () => {
    makeStub(stubDir, "snip")
    process.env["PATH"] = stubDir
    const dir = project()
    dirs.push(dir)

    const hooks = await start(dir)
    const before = hooks["tool.execute.before"]!

    const wrapped = { args: { command: "git status" } }
    await before({ tool: "bash", sessionID: "s", callID: "c" } as never, wrapped as never)
    expect(wrapped.args.command).toBe("snip git status")

    const untouched = { args: { command: "npm view react version" } }
    await before({ tool: "bash", sessionID: "s", callID: "c2" } as never, untouched as never)
    expect(untouched.args.command).toBe("npm view react version")

    const notBash = { args: { command: "git status" } }
    await before({ tool: "read", sessionID: "s", callID: "c3" } as never, notBash as never)
    expect(notBash.args.command).toBe("git status")
  })

  test("a disabled plugin registers no hooks at all", async () => {
    makeStub(stubDir, "snip")
    process.env["PATH"] = stubDir
    const dir = project({ enabled: false })
    dirs.push(dir)

    expect(await start(dir)).toEqual({})
  })
})
