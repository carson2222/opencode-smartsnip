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
  "scanUserFilters": true,
  "toast": true
}
```

- `deny` — never wrap these (`"cmd"` or `"cmd subcommand"`). Unioned across config layers.
- `allow` — force wrap-eligibility. Wins over deny. Use it to re-enable default-denied
  commands or to register commands you wrote custom snip filters for.
- `scanUserFilters` — auto-detect filters in `~/.config/snip/filters/` (default on).
- `toast` — once per session, show a TUI toast with tokens saved (read from snip's
  own tracking db). Set `false` to disable.

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
Shell output is auto-compressed via snip. Append `#nosnip` to a command when you need its full raw output. If output shows `[full output: <path>]`, Read that file instead of re-running.
```

No other prompt overhead — the rewrite is transparent.

## Reversible compression

Aggressive filtering is only safe if the original is recoverable (the idea behind
headroom's CCR). At this layer it comes for free by composition: snip's `tee` saves raw
output to a rotating local store and appends a `[full output: /path.log]` marker to the
filtered result — and the agent already has a `Read` tool. By default snip tees only on
failures; for full reversibility set in `~/.config/snip/config.toml`:

```toml
[tee]
mode = "always"   # every filtered output recoverable; 20-file rotation, 1MB cap
```

`smartsnip doctor` checks this for you.

## CLI: discover & doctor

```bash
bunx opencode-smartsnip discover --days 30   # missed-savings report from YOUR real history
bunx opencode-smartsnip doctor               # verify snip, reversibility, effective routing
```

`discover` replays your actual opencode bash history (read-only, local) through the
router and reports: what's being filtered, what's denied, the biggest unfiltered
token-burners, and which custom snip filters would pay off most. Real output:

```
smartsnip discover — last 14 days of opencode bash history
2106 commands, ~893.5k tokens of raw output

FILTERED by snip (working for you):
  git                         418 calls    182.4k est. tokens
  pnpm                        184 calls    164.7k est. tokens
  ...

NO FILTER (biggest missed savings first):
  python3                      49 calls     73.2k est. tokens
  agent-browser                83 calls     33.2k est. tokens

Suggestions:
  - write a snip filter for 'python3' (~5 min of YAML): …/snip/blob/master/SKILL.md
  then it is auto-detected — no plugin config needed (scanUserFilters).
```

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
