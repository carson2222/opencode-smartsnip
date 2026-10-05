import { describe, expect, test } from "bun:test"
import { addRule, buildMatchTable } from "../src/filters"
import { extractMatchRules } from "../src/filter-yaml"
import { rewrite } from "../src/router"
import type { SmartSnipConfig } from "../src/config"
import { DEFAULT_DENY } from "../src/config"

const config: SmartSnipConfig = {
  enabled: true,
  deny: [...DEFAULT_DENY],
  allow: [],
  snipPath: "snip",
  scanUserFilters: false,
  toast: false,
  stripMimicry: true,
}
const table = buildMatchTable(config)
const rw = (cmd: string, cfg: SmartSnipConfig = config) => rewrite(cmd, table, cfg)

describe("basic wrapping", () => {
  test("wraps a filterable command", () => {
    expect(rw("git status")).toBe("snip git status")
  })

  test("wraps known subcommands only", () => {
    expect(rw("git log -5")).toBe("snip git log -5")
    expect(rw("git rebase --continue")).toBe("git rebase --continue") // no filter
    expect(rw("git checkout main")).toBe("git checkout main") // no filter
  })

  test("snip's exclude_flags respected: --oneline means user wants that format", () => {
    expect(rw("git log --oneline")).toBe("git log --oneline")
  })

  test("leaves unknown commands untouched (issue #16 by construction)", () => {
    expect(rw("agent-browser snapshot -i")).toBe("agent-browser snapshot -i")
    expect(rw("sqlite3 db.sqlite 'SELECT 1'")).toBe("sqlite3 db.sqlite 'SELECT 1'")
    expect(rw("bun run format")).toBe("bun run format")
  })

  test("machine-readable output passes through verbatim", () => {
    expect(rw("gh pr list --json number,title")).toBe("gh pr list --json number,title")
    expect(rw("gh pr view 12 --jq .title")).toBe("gh pr view 12 --jq .title")
    expect(rw("gh run list --template '{{.name}}'")).toBe("gh run list --template '{{.name}}'")
    expect(rw(`gh pr list "--json" number,title`)).toBe(`gh pr list "--json" number,title`)
    expect(rw(`gh pr list '--json=number,title'`)).toBe(`gh pr list '--json=number,title'`)
    expect(rw("docker ps --format json")).toBe("docker ps --format json")
    expect(rw("git show origin/main:src/app.ts")).toBe("git show origin/main:src/app.ts")
    expect(rw("git show HEAD")).toBe("snip git show HEAD")
  })

  test("builtins never wrapped (issue #6)", () => {
    expect(rw("cd /tmp")).toBe("cd /tmp")
    expect(rw("source .venv/bin/activate")).toBe("source .venv/bin/activate")
    expect(rw("echo hello")).toBe("echo hello")
  })
})

describe("chains and pipes", () => {
  test("wraps each eligible segment in a chain (issue #3)", () => {
    expect(rw("git add -A && git commit -m 'x' && git push")).toBe(
      "snip git add -A && snip git commit -m 'x' && snip git push",
    )
  })

  test("mixed chain wraps only eligible segments", () => {
    expect(rw("cd /tmp && git status")).toBe("cd /tmp && snip git status")
  })

  test("never wraps downstream of a pipe", () => {
    expect(rw("git log | head -5")).toBe("snip git log | head -5")
    expect(rw("cat x.json | jq '.a'")).toBe("cat x.json | jq '.a'")
  })

  test("jq pipes survive intact (issue #8)", () => {
    const cmd = `cat file.json | jq '.content[0].text | fromjson | .results[].content'`
    expect(rw(cmd)).toBe(cmd)
  })

  test("preserves exact whitespace and separators", () => {
    expect(rw("git status ;  git log -1")).toBe("snip git status ;  snip git log -1")
  })
})

describe("idempotency (issue #15)", () => {
  test("already-snipped segments are not re-wrapped", () => {
    expect(rw("snip git status")).toBe("snip git status")
    expect(rw("cd /x && snip pnpm install")).toBe("cd /x && snip pnpm install")
  })

  test("rewrite is idempotent end-to-end", () => {
    const once = rw("git add . && git commit -m 'x'")
    expect(rw(once)).toBe(once)
  })

  test("custom snipPath basename is treated as already wrapped", () => {
    const cfg = { ...config, snipPath: "/opt/bin/snip-custom", stripMimicry: false }
    expect(rewrite("snip-custom git status", table, cfg)).toBe("snip-custom git status")
  })
})

describe("de-mimicry: strip stray snip the agent learned from persisted history", () => {
  test("strips snip off a command snip can't filter (kills #16 noise at the source)", () => {
    expect(rw("snip sed -n '1,5p' file")).toBe("sed -n '1,5p' file")
    expect(rw("snip awk 'NR>1' f")).toBe("awk 'NR>1' f")
  })

  test("collapses agent-typed snip stacking (issue #15)", () => {
    expect(rw("snip snip pnpm install")).toBe("snip pnpm install")
    expect(rw("snip snip snip git status")).toBe("snip git status")
    // a command snip cannot filter collapses all the way down
    expect(rw("snip snip pnpm lint")).toBe("pnpm lint")
  })

  test("strips a stray snip on a pipe consumer", () => {
    expect(rw("git log | snip python3 -c x")).toBe("snip git log | python3 -c x")
  })

  test("re-wraps a filterable command after stripping (still idempotent)", () => {
    expect(rw("snip git status")).toBe("snip git status")
    expect(rw("FOO=1 snip git log -1")).toBe("FOO=1 snip git log -1")
  })

  test("custom snipPath mimicry uses its basename", () => {
    const cfg = { ...config, snipPath: "/opt/bin/snip-custom" }
    expect(rewrite("snip-custom sed -n 1p f", table, cfg)).toBe("sed -n 1p f")
    expect(rewrite("snip-custom git status", table, cfg)).toBe("/opt/bin/snip-custom git status")
  })

  test("preserves snip on a command the plugin knows is filterable", () => {
    const cfg = { ...config, allow: ["mytool"] }
    const t = buildMatchTable(cfg)
    expect(rewrite("snip mytool run", t, cfg)).toBe("snip mytool run")
  })

  test("disabled via stripMimicry:false → old skip-based idempotency", () => {
    const cfg = { ...config, stripMimicry: false }
    expect(rewrite("snip sed -n 1p f", table, cfg)).toBe("snip sed -n 1p f")
    expect(rewrite("snip snip pnpm lint", table, cfg)).toBe("snip snip pnpm lint")
  })
})

describe("env prefixes (issue #22)", () => {
  test("env prefix stays before snip", () => {
    expect(rw("TZ=Europe/Warsaw git log -1")).toBe("TZ=Europe/Warsaw snip git log -1")
  })

  test("env with command substitution untouched", () => {
    const cmd = "VAR=$(echo hello) make build"
    expect(rw(cmd)).toBe(cmd)
  })
})

describe("risky syntax passthrough", () => {
  test("command substitution in segment", () => {
    const cmd = `asset=$(curl -s https://x.io | head -1); echo "$asset"`
    expect(rw(cmd)).toBe(cmd)
  })

  test("heredocs", () => {
    const cmd = "python3 - <<'PY'\nimport os\nPY"
    expect(rw(cmd)).toBe(cmd)
  })

  test("control flow", () => {
    const cmd = "for i in 1 2 3; do git status; done"
    expect(rw(cmd)).toBe(cmd)
  })

  test("subshells", () => {
    const cmd = "(cd /tmp && git status)"
    expect(rw(cmd)).toBe(cmd)
  })

  test("redirections stay byte-identical", () => {
    expect(rw("git diff > patch.diff")).toBe("git diff > patch.diff")
    expect(rw("pnpm test 2>&1")).toBe("pnpm test 2>&1")
    expect(rw("wc -l <<< 'hello'")).toBe("wc -l <<< 'hello'")
  })
})

describe("exclude_flags honored", () => {
  test("git log --format is excluded by snip's own filter rules", () => {
    const cmd = `git log --format="%h %s" -5`
    expect(rw(cmd)).toBe(cmd)
  })
})

describe("config: deny / allow / opt-out", () => {
  test("default deny: data channels stay raw", () => {
    expect(rw("curl -s https://api.example.com/data")).toBe("curl -s https://api.example.com/data")
    expect(rw("psql -c 'SELECT * FROM users'")).toBe("psql -c 'SELECT * FROM users'")
    expect(rw("ssh host uptime")).toBe("ssh host uptime")
  })

  test("user deny overrides builtin table", () => {
    const cfg = { ...config, deny: [...config.deny, "git status"] }
    expect(rw("git status", cfg)).toBe("git status")
    expect(rw("git log", cfg)).toBe("snip git log") // other subcommands unaffected
  })

  test("allow wins over deny", () => {
    const cfg = { ...config, allow: ["curl"] }
    expect(rw("curl -s https://x.io", cfg)).toBe("snip curl -s https://x.io")
  })

  test("allow adds unknown commands (user custom snip filters)", () => {
    const cfg = { ...config, allow: ["mytool"] }
    const t = buildMatchTable(cfg)
    expect(rewrite("mytool run", t, cfg)).toBe("snip mytool run")
  })

  test("#nosnip opt-out disables wrapping for the call", () => {
    expect(rw("git status #nosnip")).toBe("git status #nosnip")
    expect(rw("git log -50 # nosnip")).toBe("git log -50 # nosnip")
  })
})

describe("require_flags honored (user filters like node --test)", () => {
  const rules = extractMatchRules(
    'name: "node-test"\nversion: 1\nmatch:\n  command: "node"\n  require_flags: ["--test"]\npipeline:\n  - action: "head"\n    n: 5\n',
  )

  test("yaml extraction picks up require_flags", () => {
    expect(rules).toEqual([
      { command: "node", subcommand: null, excludeFlags: [], requireFlags: ["--test"] },
    ])
  })

  test("wraps only when required flag present", () => {
    const t = buildMatchTable(config)
    for (const rule of rules) addRule(t, rule)
    expect(rewrite("node --import tsx --test app.test.ts", t, config)).toBe(
      "snip node --import tsx --test app.test.ts",
    )
    expect(rewrite("node server.js", t, config)).toBe("node server.js")
    // snip matches require_flags against every argument including the first
    // (registry.go Match prepends the subcommand to allArgs, v0.25.2)
    expect(rewrite("node --test app.test.ts", t, config)).toBe("snip node --test app.test.ts")
  })
})
