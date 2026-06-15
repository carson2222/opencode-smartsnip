/**
 * Shell-aware top-level command splitting.
 *
 * Design rule: when in doubt, refuse to parse (return null) and the router will
 * pass the command through untouched. A wrong wrap is a bug; a passthrough never is.
 */

export type Piece =
  | { kind: "seg"; text: string }
  | { kind: "op"; text: string }

/** Shell control keywords — if a segment starts with one, we refuse the whole command. */
const CONTROL_KEYWORDS = new Set([
  "for", "while", "until", "if", "then", "else", "elif", "fi", "do", "done",
  "case", "esac", "select", "function", "time", "coproc",
])

/**
 * Split a shell command into top-level segments and operators, preserving the
 * exact original text so that concatenating all pieces reproduces the input.
 *
 * Returns null when the command uses constructs we refuse to rewrite:
 * heredocs, `;;` (case), or control-flow keywords at segment head.
 */
export function splitTopLevel(command: string): Piece[] | null {
  const pieces: Piece[] = []
  let buf = ""
  let i = 0
  const n = command.length
  let sq = false // inside '...'
  let dq = false // inside "..."
  let bt = false // inside `...`
  let depth = 0  // $( ), ( ), { -- any unquoted paren/brace nesting

  const pushSeg = () => {
    pieces.push({ kind: "seg", text: buf })
    buf = ""
  }

  while (i < n) {
    const c = command[i]!
    const next = i + 1 < n ? command[i + 1]! : ""

    if (sq) {
      buf += c
      if (c === "'") sq = false
      i++
      continue
    }
    if (dq) {
      if (c === "\\") { buf += command.slice(i, i + 2); i += 2; continue }
      buf += c
      if (c === '"') dq = false
      i++
      continue
    }
    if (bt) {
      buf += c
      if (c === "`") bt = false
      i++
      continue
    }

    switch (c) {
      case "'": sq = true; buf += c; i++; continue
      case '"': dq = true; buf += c; i++; continue
      case "`": bt = true; buf += c; i++; continue
      case "\\": buf += command.slice(i, i + 2); i += 2; continue
    }

    // heredoc / herestring: refuse heredocs, allow <<< herestrings
    if (c === "<" && next === "<") {
      if (command[i + 2] === "<") { buf += "<<<"; i += 3; continue }
      return null
    }

    if (c === "(" || c === "{") { depth++; buf += c; i++; continue }
    if ((c === ")" || c === "}") && depth > 0) { depth--; buf += c; i++; continue }
    if (command.startsWith("$(", i)) { depth++; buf += "$("; i += 2; continue }

    if (depth === 0) {
      if (command.startsWith("&&", i)) { pushSeg(); pieces.push({ kind: "op", text: "&&" }); i += 2; continue }
      if (command.startsWith("||", i)) { pushSeg(); pieces.push({ kind: "op", text: "||" }); i += 2; continue }
      if (command.startsWith(";;", i)) return null // case syntax
      if (c === ";" || c === "\n") { pushSeg(); pieces.push({ kind: "op", text: c }); i++; continue }
      if (command.startsWith("|&", i)) { pushSeg(); pieces.push({ kind: "op", text: "|&" }); i += 2; continue }
      if (c === "|") { pushSeg(); pieces.push({ kind: "op", text: "|" }); i++; continue }
      if (c === "&") {
        // not a separator when part of a redirection: >&, <&, &>, &>>, 2>&1
        const prev = i > 0 ? command[i - 1]! : ""
        if (prev === ">" || prev === "<" || next === ">") { buf += c; i++; continue }
        pushSeg(); pieces.push({ kind: "op", text: "&" }); i++; continue
      }
    }

    buf += c
    i++
  }

  if (sq || dq || bt) return null // unbalanced quoting — refuse
  pushSeg()

  // refuse commands containing control-flow segments
  for (const p of pieces) {
    if (p.kind !== "seg") continue
    const head = p.text.trim().split(/\s+/)[0]
    if (head && CONTROL_KEYWORDS.has(head)) return null
  }

  return pieces
}

/** Matches one or more leading NAME=value assignments (values may be quoted). */
export const ENV_PREFIX_RE =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s'"]*)\s+)+/

export interface SegmentInfo {
  /** leading whitespace, preserved on rewrite */
  leading: string
  /** NAME=value prefix incl. trailing space, possibly "" */
  envPrefix: string
  /** command body after env prefix */
  body: string
  /** head executable (basename, $PATH-style) */
  head: string
  /** first non-flag argument after head, if any */
  subcommand: string | null
  /** all whitespace-split tokens of body (head included) */
  tokens: string[]
}

/** Analyze a single segment. Returns null for empty/unanalyzable segments. */
export function analyzeSegment(segment: string): SegmentInfo | null {
  const leading = segment.match(/^\s*/)?.[0] ?? ""
  const s = segment.slice(leading.length)
  if (!s) return null

  const envMatch = s.match(ENV_PREFIX_RE)
  const envPrefix = envMatch?.[0] ?? ""
  // env values containing substitution are dangerous to reorder around (issue #22)
  if (envPrefix.includes("$(") || envPrefix.includes("`")) return null

  const body = s.slice(envPrefix.length)
  if (!body.trim()) return null

  const tokens = body.trim().split(/\s+/)
  const rawHead = tokens[0]!
  // skip leading redirections or weird heads
  if (/^[<>0-9&]/.test(rawHead)) return null
  const head = rawHead.includes("/") ? rawHead.split("/").pop()! : rawHead

  let subcommand: string | null = null
  for (const t of tokens.slice(1)) {
    if (!t.startsWith("-")) { subcommand = t; break }
  }

  return { leading, envPrefix, body, head, subcommand, tokens }
}

/** Syntax inside a segment that makes wrapping unsafe. */
export function hasRiskySyntax(segment: string): boolean {
  // Redirections must stay raw: `snip git diff > patch.diff` would write the
  // filtered/truncated diff into the file instead of the original output.
  return /\$\(|`|<\(|>\(|(^|\s)(?:\d+)?(?:>>?|<<?|&>)/.test(segment)
}
