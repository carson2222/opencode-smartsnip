import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface SmartSnipConfig {
  /** master switch */
  enabled: boolean
  /** commands (or "command subcommand") never wrapped — wins over builtin table */
  deny: string[]
  /** commands (or "command subcommand") always wrap-eligible — wins over deny */
  allow: string[]
  /** snip executable */
  snipPath: string
  /** scan ~/.config/snip/filters/*.yaml for user-authored filters */
  scanUserFilters: boolean
}

/**
 * Data-carrying channels denied by default: snip's filters for these are blunt
 * head-truncations, and an agent usually NEEDS this output verbatim
 * (API responses, remote command results, query rows). See RESEARCH.md.
 */
export const DEFAULT_DENY = ["ssh", "curl", "wget", "psql", "jq"]

const DEFAULTS: SmartSnipConfig = {
  enabled: true,
  deny: DEFAULT_DENY,
  allow: [],
  snipPath: "snip",
  scanUserFilters: true,
}

function readJson(path: string): Partial<SmartSnipConfig> | null {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (e) {
    console.warn(`[smartsnip] ignoring invalid config at ${path}: ${e}`)
    return null
  }
}

/**
 * Merge order (later wins): defaults <- global <- project.
 * `deny` and `allow` arrays are unioned across layers, not replaced.
 */
export function loadConfig(projectDir?: string): SmartSnipConfig {
  const layers = [
    readJson(join(homedir(), ".config", "opencode", "smartsnip.json")),
    projectDir ? readJson(join(projectDir, ".opencode", "smartsnip.json")) : null,
  ].filter((l): l is Partial<SmartSnipConfig> => l !== null)

  const cfg: SmartSnipConfig = { ...DEFAULTS, deny: [...DEFAULTS.deny] }
  for (const layer of layers) {
    if (typeof layer.enabled === "boolean") cfg.enabled = layer.enabled
    if (typeof layer.snipPath === "string") cfg.snipPath = layer.snipPath
    if (typeof layer.scanUserFilters === "boolean") cfg.scanUserFilters = layer.scanUserFilters
    if (Array.isArray(layer.deny)) cfg.deny = [...new Set([...cfg.deny, ...layer.deny])]
    if (Array.isArray(layer.allow)) cfg.allow = [...new Set([...cfg.allow, ...layer.allow])]
  }
  return cfg
}
