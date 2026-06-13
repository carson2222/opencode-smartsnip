import {
  analyzeSegment,
  hasRiskySyntax,
  splitTopLevel,
  type SegmentInfo,
} from "./parser"
import type { MatchTable } from "./filters"
import type { SmartSnipConfig } from "./config"

/** Shell builtins and shell-internal words that must never be wrapped. */
export const BUILTINS = new Set([
  "cd", "source", ".", "export", "alias", "unalias", "unset", "set", "shopt",
  "eval", "exec", "echo", "printf", "true", "false", "pwd", "test", "[", "[[",
  "read", "wait", "trap", "pushd", "popd", "dirs", "jobs", "fg", "bg", "kill",
  "ulimit", "umask", "type", "command", "builtin", "let", "local", "declare",
  "readonly", "return", "break", "continue", "exit", "hash", "getopts", "sleep",
])

/** Agent opt-out marker: a `#nosnip` comment anywhere disables wrapping for the call. */
const OPT_OUT_RE = /(^|\s)#\s*nosnip\b/

/**
 * Peel stray `snip` prefixes (one or more) off a segment, preserving leading
 * whitespace and any env-assignment prefix. Returns the segment unchanged when
 * there is nothing to strip or it can't be analyzed. This is what lets wrapping
 * be re-decided from a clean slate: `snip snip pnpm` → `pnpm`, `snip sed` → `sed`.
 */
function stripSnipPrefix(segment: string, snipPath: string): string {
  const base = snipPath.includes("/") ? snipPath.split("/").pop()! : snipPath
  const names = new Set(["snip", snipPath, base])
  let cur = segment
  for (;;) {
    const info = analyzeSegment(cur)
    if (!info || !names.has(info.head) || info.tokens.length < 2) return cur
    // body starts at the head; drop the first token and its trailing whitespace
    cur = info.leading + info.envPrefix + info.body.replace(/^\S+\s+/, "")
  }
}

function isDenied(info: SegmentInfo, config: SmartSnipConfig): boolean {
  const allowHit =
    config.allow.includes(info.head) ||
    (info.subcommand !== null && config.allow.includes(`${info.head} ${info.subcommand}`))
  if (allowHit) return false
  return (
    config.deny.includes(info.head) ||
    (info.subcommand !== null && config.deny.includes(`${info.head} ${info.subcommand}`))
  )
}

/** Decide whether a single analyzed segment should be wrapped with snip. */
export function shouldWrap(
  segment: string,
  table: MatchTable,
  config: SmartSnipConfig,
): SegmentInfo | null {
  if (hasRiskySyntax(segment)) return null
  const info = analyzeSegment(segment)
  if (!info) return null
  if (info.head === "snip" || info.head === config.snipPath) return null // idempotency
  if (BUILTINS.has(info.head)) return null
  if (info.body.startsWith("(") || info.body.startsWith("{")) return null // subshell/group

  const entry = table.get(info.head)
  if (!entry) return null

  // subcommand matching: a `null` rule matches anything; otherwise the segment's
  // first non-flag argument must equal a listed subcommand
  let subKey: string
  if (entry.subcommands.has(null)) {
    subKey = ""
  } else if (info.subcommand !== null && entry.subcommands.has(info.subcommand)) {
    subKey = info.subcommand
  } else {
    return null
  }

  // honor snip's own exclude_flags (prefix matching, mirroring snip's matcher)
  const excludes = entry.excludeFlags.get(subKey) ?? []
  if (excludes.length > 0) {
    for (const token of info.tokens.slice(1)) {
      if (!token.startsWith("-")) continue
      const bare = token.split("=")[0]!
      if (excludes.some((ex) => bare.startsWith(ex))) return null
    }
  }

  // honor snip's require_flags: wrap only if ALL required flags are present.
  // NOTE: snip (≤0.15.0) checks require_flags against args[1:] only — a required
  // flag in the first-argument slot is not seen (fixed on master). We mirror the
  // stricter reading (tokens after the first argument), which is correct on
  // 0.15.0 and merely conservative (safe passthrough) on fixed versions.
  const requires = entry.requireFlags.get(subKey) ?? []
  if (requires.length > 0) {
    const flags = info.tokens.slice(2).filter((t) => t.startsWith("-")).map((t) => t.split("=")[0]!)
    if (!requires.every((req) => flags.some((f) => f.startsWith(req)))) return null
  }

  if (isDenied(info, config)) return null
  return info
}

/**
 * Rewrite a bash command, prefixing wrap-eligible top-level segments with `snip`.
 * Returns the input unchanged whenever anything is uncertain.
 */
export function rewrite(
  command: string,
  table: MatchTable,
  config: SmartSnipConfig,
): string {
  if (!command.trim()) return command
  if (OPT_OUT_RE.test(command)) return command

  const pieces = splitTopLevel(command)
  if (!pieces) return command // heredoc, control flow, unbalanced quotes, case…

  let prevOp: string | null = null
  const out = pieces.map((piece) => {
    if (piece.kind === "op") {
      prevOp = piece.text
      return piece.text
    }
    const downstreamOfPipe = prevOp === "|" || prevOp === "|&"
    prevOp = null

    // normalize away mimicked/persisted snip prefixes, then decide fresh
    const text = config.stripMimicry ? stripSnipPrefix(piece.text, config.snipPath) : piece.text

    // segments downstream of a pipe receive stdin — wrapping is pointless/harmful,
    // but a stray snip the agent typed there still gets stripped above
    if (downstreamOfPipe) return text

    const info = shouldWrap(text, table, config)
    if (!info) return text
    return `${info.leading}${info.envPrefix}${config.snipPath} ${info.body}`
  })

  return out.join("")
}
