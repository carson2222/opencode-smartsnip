/**
 * Minimal extraction of `match:` rules from snip filter YAML files.
 * Not a YAML parser — only reads the handful of scalar/list keys we need,
 * and fails soft (returns []) on anything unexpected.
 */

export interface FilterRule {
  command: string
  /**
   * null  — `subcommand:` absent: the filter matches any first argument.
   * ""    — listed explicitly by snip as the bare-invocation case (`yarn`).
   * other — that exact first argument.
   */
  subcommand: string | null
  excludeFlags: string[]
  /** snip `match.require_flags`: only wrap when ALL of these are present. */
  requireFlags?: string[]
}

function unquote(s: string): string {
  return s.trim().replace(/^["']|["']$/g, "")
}

function parseInlineList(rest: string): string[] {
  return rest
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map(unquote)
}

/**
 * Join YAML flow sequences that upstream wraps over several lines:
 *
 *   exclude_flags:
 *     ["--stat", "--name-only",
 *      "-p", "--patch"]
 *
 * Without this the list reads as empty and `git diff -p` looks wrap-eligible,
 * which destroys the patch body the agent asked for.
 */
const FLOW_START_RE = /^(?:(?:subcommand|exclude_flags|require_flags):\s*)?\[/

function joinFlowSequences(yamlText: string): string[] {
  const out: string[] = []
  let pending: string | null = null
  for (const raw of yamlText.split("\n")) {
    if (pending !== null) {
      pending += ` ${raw.trim()}`
      if (!pending.includes("]")) continue
      out.push(pending)
      pending = null
      continue
    }
    if (FLOW_START_RE.test(raw.trim()) && !raw.includes("]")) {
      pending = raw
      continue
    }
    out.push(raw)
  }
  if (pending !== null) out.push(pending)
  return out
}

/**
 * One YAML file yields one rule per matched subcommand: snip v0.19+ accepts
 * `match.subcommand` as a list, and npm/pnpm/yarn now use it to cover only the
 * dependency-changing subcommands. Collapsing that list to a single rule is what
 * made `npm view` look filterable and lose its output to the install filter.
 */
export function extractMatchRules(yamlText: string): FilterRule[] {
  let command: string | null = null
  let subcommands: string[] | null = null
  const excludeFlags: string[] = []
  const requireFlags: string[] = []
  let inMatch = false
  let listTarget: string[] | null = null

  for (const raw of joinFlowSequences(yamlText)) {
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
      const rest = line.slice("subcommand:".length).trim()
      const values: string[] = []
      if (rest.startsWith("[")) {
        values.push(...parseInlineList(rest))
        listTarget = null
      } else if (rest) {
        values.push(unquote(rest))
        listTarget = null
      } else {
        listTarget = values // block list follows
      }
      subcommands = values
    } else if (line.startsWith("exclude_flags:") || line.startsWith("require_flags:")) {
      const key = line.startsWith("exclude_flags:") ? "exclude_flags:" : "require_flags:"
      const target = key === "exclude_flags:" ? excludeFlags : requireFlags
      const rest = line.slice(key.length).trim()
      if (rest.startsWith("[")) {
        for (const v of parseInlineList(rest)) if (v) target.push(v)
        listTarget = null
      } else {
        listTarget = target
      }
    } else if (line.startsWith("-") && listTarget) {
      listTarget.push(unquote(line.slice(1)))
    } else if (line.startsWith("[") && listTarget) {
      // flow sequence on the line after its key
      for (const v of parseInlineList(line)) if (v || listTarget === subcommands) listTarget.push(v)
      listTarget = null
    } else {
      listTarget = null
    }
  }

  if (!command) return []
  // An explicit but empty list registers under no key at all in snip's registry,
  // so the filter is dead there too — emit nothing rather than "matches anything".
  const keys: (string | null)[] = subcommands === null ? [null] : [...new Set(subcommands)]
  return keys.map((subcommand) => ({
    command,
    subcommand,
    excludeFlags: [...excludeFlags],
    ...(requireFlags.length ? { requireFlags: [...requireFlags] } : {}),
  }))
}
