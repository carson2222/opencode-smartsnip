# opencode-smartsnip

opencode plugin that routes shell commands through [snip](https://github.com/edouard-claude/snip)
to cut LLM token usage by 60–90% — **without breaking your commands**.

Existing snip plugins wrap *every* bash command. That causes stacked `snip snip snip` prefixes,
broken `jq` pipes, mangled env assignments, "no filter" stderr noise that costs more tokens than
it saves, and truncated SQL/API output your agent actually needed.

smartsnip inverts the policy: **only commands snip can genuinely filter get wrapped.**
Everything else passes through byte-identical.

Validated against a corpus of **23,917 real bash commands** from real opencode sessions —
allowlist routing still captures 63% of all tool-output volume while eliminating the entire
bug surface of wrap-everything. See [RESEARCH.md](./RESEARCH.md) for the data.

## How it works

```
agent runs: cd /x && git status && cat big.json | jq '.a | .b'
                          │
                          ▼ tool.execute.before
smartsnip:  cd /x && snip git status && cat big.json | jq '.a | .b'
            ─┬───    ─┬─────────────    ─┬──────────────────────────
             │        │                  └ pipes & jq untouched
             │        └ matches snip's git-status filter → wrapped
             └ builtin → untouched
```

The routing decisions, in order:

1. `#nosnip` comment anywhere → entire command untouched (agent/user opt-out)
2. Heredocs, control flow (`for`/`if`/`while`), `case`, unbalanced quotes → untouched
3. Per top-level segment (split quote/paren/redirection-aware):
   - shell builtins, subshells, segments after a `|` → untouched
   - `$( )`, backticks, process substitution in segment → untouched
   - already `snip`-prefixed → untouched (idempotent)
   - head command + subcommand looked up in snip's own filter table
     (131 built-in filters + your `~/.config/snip/filters/*.yaml`, auto-scanned)
   - snip's `exclude_flags` honored (`git log --format=...` stays raw)
   - deny/allow config applied
4. Match → `ENV=... snip <command>`; anything uncertain → untouched

**When in doubt, it does nothing.** A passthrough is always correct; a wrong wrap never is.

## Install

1. Install snip:

```bash
brew install edouard-claude/tap/snip
# or: go install github.com/edouard-claude/snip/cmd/snip@latest
```

2. Add the plugin to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-smartsnip"]
}
```

Or, until the npm release / for development, install from source:

```bash
git clone https://github.com/carson2222/opencode-smartsnip.git
mkdir -p ~/.config/opencode/plugins
printf 'export { SmartSnipPlugin } from "%s/src/index"\n' "$PWD/opencode-smartsnip" \
  > ~/.config/opencode/plugins/smartsnip.ts
```

If snip isn't on PATH the plugin disables itself with a warning — safe to ship in
a shared repo config.

## Configuration

Optional. `~/.config/opencode/smartsnip.json` (global) and `.opencode/smartsnip.json`
(per project, merged on top):

```json
{
  "enabled": true,
  "deny": ["pnpm", "git diff"],
  "allow": ["ssh", "mytool"],
  "snipPath": "snip",
  "scanUserFilters": true
}
```

- `deny` — never wrap these (`"cmd"` or `"cmd subcommand"`). Unioned across config layers.
- `allow` — force wrap-eligibility. Wins over deny. Use it to re-enable default-denied
  commands or to register commands you wrote custom snip filters for.
- `scanUserFilters` — auto-detect filters in `~/.config/snip/filters/` (default on).

### Default deny list

`ssh`, `curl`, `wget`, `psql`, `jq` are **not wrapped by default**, even though snip has
filters for them. Those filters are blunt head-truncations, and agents usually need that
output verbatim (API responses, remote results, query rows). Filtering test/build/lint/VCS
noise saves tokens; truncating data channels forces re-runs. Re-enable any of them with
`"allow": ["curl"]`.

### Agent opt-out

Any command containing a `#nosnip` comment is left untouched:

```bash
git log -200 #nosnip
```

Optionally add one line to your `AGENTS.md` so agents know about it:

```
Shell output is auto-compressed via snip. Append `#nosnip` to a command when you need its full raw output.
```

No other prompt overhead — the rewrite is transparent.

## Why not the original opencode-snip?

| | opencode-snip | smartsnip |
|---|---|---|
| Routing | wraps everything | allowlist from snip's own filter table |
| `snip: no filter for "X"` noise ([#16](https://github.com/VincentHardouin/opencode-snip/issues/16)) | yes, costs tokens | impossible by construction |
| `snip snip snip` stacking ([#15](https://github.com/VincentHardouin/opencode-snip/issues/15)) | yes | per-segment idempotency, corpus-tested |
| `jq '.a \| .b'` pipes ([#8](https://github.com/VincentHardouin/opencode-snip/issues/8)) | broken | quote-aware parser |
| `VAR=$(cmd) x` ([#22](https://github.com/VincentHardouin/opencode-snip/issues/22)) | corrupted | detected, passthrough |
| heredocs ([#6](https://github.com/VincentHardouin/opencode-snip/issues/6)-class) | wrapped, breaks | detected, passthrough |
| permission rules blast radius ([#7](https://github.com/VincentHardouin/opencode-snip/issues/7)) | every command rewritten | only filterable commands |
| configuration | none | deny/allow, opt-out, custom filter scan |
| SQL/API truncation | forced or full off | data channels denied by default |

## Development

```bash
bun install
bun test                  # 47 tests incl. replay of 656 sanitized real-world commands
bun run typecheck
bun run generate:filters  # re-sync allowlist from upstream snip filters
```

Run the full private-corpus replay (any opencode user can extract their own):

```bash
SMARTSNIP_CORPUS=/path/to/corpus.json bun test
```

## License

MIT
