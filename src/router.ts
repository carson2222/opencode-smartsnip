import {
  analyzeSegment,
  hasRiskySyntax,
  splitTopLevel,
  type SegmentInfo,
} from "./parser"
import type { MatchEntry, MatchTable, SubKey } from "./filters"
import type { SmartSnipConfig } from "./config"
import { SNIP_NATIVE_SUBCOMMANDS } from "./snip-cli"

/** Shell builtins and shell-internal words that must never be wrapped. */
export const BUILTINS = new Set([
  "cd", "source", ".", "export", "alias", "unalias", "unset", "set", "shopt",
  "eval", "exec", "echo", "printf", "true", "false", "pwd", "test", "[", "[[",
  "read", "wait", "trap", "pushd", "popd", "dirs", "jobs", "fg", "bg", "kill",
  "ulimit", "umask", "type", "command", "builtin", "let", "local", "declare",
  "readonly", "return", "break", "continue", "exit", "hash", "getopts", "sleep",
])

/** Agent opt-out marker: a `#nosnip` comment anywhere disables wrapping for the call. */
export const OPT_OUT_RE = /(^|\s)#\s*nosnip\b/

function snipHeadNames(snipPath: string): Set<string> {
  const base = snipPath.includes("/") ? snipPath.split("/").pop()! : snipPath
  return new Set(["snip", snipPath, base])
}

export function isSnipHead(head: string, snipPath: string): boolean {
  return snipHeadNames(snipPath).has(head)
}

/**
 * Peel stray `snip` prefixes (one or more) off a segment, preserving leading
 * whitespace and any env-assignment prefix. This is what lets wrapping be
 * re-decided from a clean slate: `snip snip pnpm` → `pnpm`, `snip sed` → `sed`.
 *
 * A prefix is only stray when snip would treat the next token as a program to
 * run. `snip config`, `snip gain --daily` and `snip --version` are snip's own
 * CLI, and stripping the head there turned them into `config`, `gain --daily`
 * and a bare `--version`.
 */
export function stripSnipPrefix(segment: string, snipPath: string): string {
  const names = snipHeadNames(snipPath)
  let cur = segment
  for (;;) {
    const info = analyzeSegment(cur)
    if (!info || !names.has(info.head) || info.tokens.length < 2) return cur
    const next = info.tokens[1]!
    if (next.startsWith("-") || SNIP_NATIVE_SUBCOMMANDS.has(next)) return cur
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
  if (isSnipHead(info.head, config.snipPath)) return null // idempotency
  if (BUILTINS.has(info.head)) return null
  if (info.body.startsWith("(") || info.body.startsWith("{")) return null // subshell/group

  const entry = table.get(info.head)
  if (!entry) return null
  if (!matchesEntry(entry, info)) return null

  if (isDenied(info, config)) return null
  return info
}

/**
 * Mirror of snip's `Registry.Match` + `matchesFlags` (internal/filter/registry.go,
 * v0.25.2). Three details that all cost output when they were approximated:
 *
 * - the subcommand key is literally the first argument, flag or not, so
 *   `git --no-pager log` reaches no filter and must not be wrapped;
 * - an absent first argument is the `""` key, which is how `yarn` alone matches;
 * - `exclude_flags`/`require_flags` are prefix-matched against *every* argument,
 *   positionals included, so `gh pr` excludes the literal `diff`.
 *
 * `info.subcommand` stays the first non-flag argument: that is the useful
 * reading for the user's own deny/allow entries, not for snip's table.
 */
function matchesEntry(entry: MatchEntry, info: SegmentInfo): boolean {
  const args = info.tokens.slice(1)
  const firstArg = args[0] ?? ""
  const candidates: SubKey[] = []
  if (entry.subcommands.has(firstArg)) candidates.push(firstArg)
  if (entry.subcommands.has(null)) candidates.push(null)

  return candidates.some((key) => {
    const excludes = entry.excludeFlags.get(key) ?? []
    if (excludes.some((ex) => args.some((a) => a.startsWith(ex)))) return false
    const requires = entry.requireFlags.get(key) ?? []
    return requires.every((req) => args.some((a) => a.startsWith(req)))
  })
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
