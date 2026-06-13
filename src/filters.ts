import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { BUILTIN_FILTERS } from "./builtin-filters"
import { extractMatchRules, type FilterRule } from "./filter-yaml"
import type { SmartSnipConfig } from "./config"

export interface MatchEntry {
  /** null in the set means "any subcommand" */
  subcommands: Set<string | null>
  /** exclude flags per subcommand key ("" for null) */
  excludeFlags: Map<string, string[]>
  /** require flags per subcommand key ("" for null) — wrap only if ALL present */
  requireFlags: Map<string, string[]>
}

export type MatchTable = Map<string, MatchEntry>

function addRule(table: MatchTable, rule: FilterRule): void {
  let entry = table.get(rule.command)
  if (!entry) {
    entry = { subcommands: new Set(), excludeFlags: new Map(), requireFlags: new Map() }
    table.set(rule.command, entry)
  }
  entry.subcommands.add(rule.subcommand)
  entry.excludeFlags.set(rule.subcommand ?? "", rule.excludeFlags)
  if (rule.requireFlags?.length) entry.requireFlags.set(rule.subcommand ?? "", rule.requireFlags)
}

/** Scan user-authored snip filters so custom filters become wrap-eligible automatically. */
export function scanUserFilters(dir = join(homedir(), ".config", "snip", "filters")): FilterRule[] {
  try {
    if (!existsSync(dir)) return []
    const rules: FilterRule[] = []
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue
      try {
        const rule = extractMatchRules(readFileSync(join(dir, f), "utf8"))
        if (rule) rules.push(rule)
      } catch {
        // unreadable filter — snip itself will deal with it; we just don't route to it
      }
    }
    return rules
  } catch {
    return []
  }
}

export function buildMatchTable(config: SmartSnipConfig): MatchTable {
  const table: MatchTable = new Map()
  for (const rule of BUILTIN_FILTERS) addRule(table, rule)
  if (config.scanUserFilters) {
    for (const rule of scanUserFilters()) addRule(table, rule)
  }
  // config.allow entries become wrap-eligible ("cmd" or "cmd sub")
  for (const item of config.allow) {
    const [command, subcommand] = item.trim().split(/\s+/)
    if (command) addRule(table, { command, subcommand: subcommand ?? null, excludeFlags: [] })
  }
  return table
}
