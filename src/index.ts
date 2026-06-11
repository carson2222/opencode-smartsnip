import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig } from "./config"
import { buildMatchTable } from "./filters"
import { rewrite } from "./router"

export { rewrite } from "./router"
export { loadConfig, DEFAULT_DENY, type SmartSnipConfig } from "./config"
export { buildMatchTable, scanUserFilters } from "./filters"
export { splitTopLevel, analyzeSegment } from "./parser"

export const SmartSnipPlugin: Plugin = async ({ $, directory }) => {
  // POSIX parser — PowerShell/native Windows is a non-goal for now (see TODO.md)
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

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      const command = output.args?.command
      if (!command || typeof command !== "string") return
      output.args.command = rewrite(command, table, config)
    },
  }
}

export default SmartSnipPlugin
