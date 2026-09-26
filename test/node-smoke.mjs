import assert from "node:assert/strict"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const temp = mkdtempSync(join(tmpdir(), "smartsnip-node-"))
const originalPath = process.env.PATH
const originalHome = process.env.HOME

try {
  const pkg = join(temp, "node_modules", "opencode-smartsnip")
  mkdirSync(join(pkg, "dist"), { recursive: true })
  copyFileSync(join(root, "dist", "index.js"), join(pkg, "dist", "index.js"))
  copyFileSync(join(root, "package.json"), join(pkg, "package.json"))

  const bin = join(temp, "bin")
  mkdirSync(bin)
  const snip = join(bin, "snip")
  writeFileSync(snip, "#!/bin/sh\nexit 0\n")
  chmodSync(snip, 0o755)
  process.env.PATH = bin
  process.env.HOME = temp

  const dbDir = join(temp, ".local", "share", "snip")
  mkdirSync(dbDir, { recursive: true })
  const db = new DatabaseSync(join(dbDir, "tracking.db"))
  db.exec("CREATE TABLE commands (timestamp TEXT, saved_tokens INTEGER)")
  db.prepare("INSERT INTO commands VALUES (?, ?)").run("9999-01-01 00:00:00", 1200)
  db.close()

  const project = join(temp, "project")
  mkdirSync(join(project, ".opencode"), { recursive: true })
  writeFileSync(join(project, ".opencode", "smartsnip.json"), JSON.stringify({ scanUserFilters: false }))

  const { default: plugin } = await import(pathToFileURL(join(pkg, "dist", "index.js")).href)
  assert.equal(plugin.id, "opencode-smartsnip")
  const resolver = join(temp, "resolve.mjs")
  writeFileSync(resolver, "import root from 'opencode-smartsnip'; import server from 'opencode-smartsnip/server'; export default [root, server]\n")
  const { default: entries } = await import(pathToFileURL(resolver).href)
  assert.deepEqual(entries, [plugin, plugin])
  let toast
  const hooks = await plugin.server({ directory: project, client: { tui: { showToast: async (value) => { toast = value } } } })
  const output = { args: { command: "git status" } }
  await hooks["tool.execute.before"]({ tool: "bash" }, output)
  assert.equal(output.args.command, "snip git status")
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "test" } } })
  assert.match(toast.body.message, /1\.2k tokens across 1 commands/)

  let before
  await plugin.setup({
    location: { directory: project },
    tool: {
      hook: async (name, callback) => {
        assert.equal(name, "execute.before")
        before = callback
      },
    },
  })
  assert.equal(typeof before, "function")
  const event = { tool: "shell", input: { command: "git status", workdir: project } }
  before(event)
  assert.deepEqual(event.input, { command: "snip git status", workdir: project })
  console.log("Node desktop smoke passed (v1 bash + SQLite toast + v2 shell)")
} finally {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  rmSync(temp, { recursive: true, force: true })
}
