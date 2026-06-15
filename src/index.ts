import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig } from "./config"
import { buildMatchTable } from "./filters"
import { rewrite } from "./router"
import { formatTokens, nowUtcSnipFormat, savingsSince } from "./stats"

// opencode loads this module and treats EVERY export as a plugin factory: it
// iterates the exports and calls each one, requiring each to be a function
// ("Plugin export is not a function" otherwise). So the plugin entry must export
// ONLY plugin functions. Library helpers (rewrite, loadConfig, DEFAULT_DENY, …)
// are intentionally NOT re-exported here — import them from their own modules.

export const SmartSnipPlugin: Plugin = async ({ $, client, directory }) => {
  // POSIX parser — PowerShell/native Windows is a non-goal for now
  if (process.platform === "win32") return {}

  const config = loadConfig(directory)
  if (!config.enabled) return {}

  try {
    await $`command -v ${config.snipPath}`.quiet()
  } catch {
    console.warn(
      `[smartsnip] '${config.snipPath}' not found in PATH — plugin disabled. ` +
        "Install: brew install edouard-claude/tap/snip",
    )
    return {}
  }

  const table = buildMatchTable(config)

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

      const savings = savingsSince(startedAt)
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

export default SmartSnipPlugin
