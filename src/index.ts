import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig } from "./config"
import { buildMatchTable } from "./filters"
import { rewrite } from "./router"
import { resolveSnip } from "./snip-cli"
import { formatTokens, nowUtcSnipFormat, savingsSince } from "./stats"

interface ShellEvent {
  tool: string
  input: unknown
}

interface PluginContextV2 {
  location: { directory: string }
  tool: { hook: (name: "execute.before", callback: (event: ShellEvent) => void) => Promise<unknown> }
}

function init(directory: string) {
  // POSIX parser — PowerShell/native Windows is a non-goal for now
  if (process.platform === "win32") return null
  const config = loadConfig(directory)
  if (!config.enabled) return null

  if (!resolveSnip(config.snipPath)) {
    console.warn(
      `[smartsnip] '${config.snipPath}' not found in PATH — plugin disabled. ` +
        "Install: brew install edouard-claude/tap/snip, " +
        "or go install github.com/edouard-claude/snip@latest",
    )
    return null
  }
  return { config, table: buildMatchTable(config) }
}

const SmartSnipPlugin: Plugin = async ({ client, directory }) => {
  const state = init(directory)
  if (!state) return {}
  const { config, table } = state

  // Savings toast state: report once per session, only counting savings
  // accrued after this plugin instance started.
  const startedAt = nowUtcSnipFormat()
  const toastedSessions = new Set<string>()
  let wrappedAnything = false
  let reportedSavedTokens = 0

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      const command = output.args?.command
      if (!command || typeof command !== "string") return
      const rewritten = rewrite(command, table, config)
      if (rewritten !== command) wrappedAnything = true
      output.args.command = rewritten
    },

    event: async ({ event }) => {
      if (!config.toast || event.type !== "session.idle") return
      if (!wrappedAnything) return
      const sessionID = (event as { properties?: { sessionID?: string } }).properties?.sessionID
      if (!sessionID || toastedSessions.has(sessionID)) return

      const savings = await savingsSince(startedAt)
      if (!savings || savings.savedTokens <= reportedSavedTokens) return

      toastedSessions.add(sessionID)
      reportedSavedTokens = savings.savedTokens
      try {
        await client.tui.showToast({
          body: {
            title: "smartsnip",
            message: `snip saved ~${formatTokens(savings.savedTokens)} tokens across ${savings.commands} commands`,
            variant: "success",
            duration: 5000,
          },
        })
      } catch {
        // headless / no TUI — stats are a bonus, never a breakage
      }
    },
  }
}

async function setup(ctx: PluginContextV2): Promise<void> {
  const state = init(ctx.location.directory)
  if (!state) return
  const { config, table } = state
  await ctx.tool.hook("execute.before", (event) => {
    if (event.tool !== "shell") return
    const input = event.input
    if (typeof input !== "object" || input === null || !("command" in input)) return
    if (typeof input.command !== "string") return
    const command = rewrite(input.command, table, config)
    if (command !== input.command) event.input = { ...input, command }
  })
}

const plugin = {
  id: "opencode-smartsnip",
  server: SmartSnipPlugin,
  setup,
}

export default plugin
