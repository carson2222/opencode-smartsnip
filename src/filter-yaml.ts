/**
 * Minimal extraction of `match:` rules from snip filter YAML files.
 * Not a YAML parser — only reads the handful of scalar/list keys we need,
 * and fails soft (returns null) on anything unexpected.
 */

export interface FilterRule {
  command: string
  subcommand: string | null
  excludeFlags: string[]
}

export function extractMatchRules(yamlText: string): FilterRule | null {
  let command: string | null = null
  let subcommand: string | null = null
  const excludeFlags: string[] = []
  let inMatch = false
  let listTarget: string[] | null = null

  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "")

  for (const raw of yamlText.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()

    if (indent === 0) {
      inMatch = line === "match:"
      listTarget = null
      continue
    }
    if (!inMatch) continue

    if (line.startsWith("command:")) {
      command = unquote(line.slice("command:".length))
      listTarget = null
    } else if (line.startsWith("subcommand:")) {
      subcommand = unquote(line.slice("subcommand:".length))
      listTarget = null
    } else if (line.startsWith("exclude_flags:")) {
      const rest = line.slice("exclude_flags:".length).trim()
      if (rest.startsWith("[")) {
        for (const item of rest.replace(/^\[|\]$/g, "").split(",")) {
          const v = unquote(item)
          if (v) excludeFlags.push(v)
        }
        listTarget = null
      } else {
        listTarget = excludeFlags
      }
    } else if (line.startsWith("- ") && listTarget) {
      listTarget.push(unquote(line.slice(2)))
    } else {
      listTarget = null
    }
  }

  if (!command) return null
  return { command, subcommand, excludeFlags }
}
