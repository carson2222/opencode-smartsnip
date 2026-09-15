/**
 * The routing table has to describe snip v0.25.2 exactly. Every case below is
 * one where it did not, and each one lost output the agent had asked for.
 */
import { describe, expect, test } from "bun:test"
import { extractMatchRules } from "../src/filter-yaml"
import { buildMatchTable } from "../src/filters"
import { rewrite } from "../src/router"
import { DEFAULT_DENY, type SmartSnipConfig } from "../src/config"

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
const rw = (cmd: string) => rewrite(cmd, table, config)

describe("subcommand lists (npm/pnpm/yarn)", () => {
  test("only the dependency-changing subcommands wrap", () => {
    expect(rw("npm install")).toBe("snip npm install")
    expect(rw("npm ci")).toBe("snip npm ci")
    expect(rw("npm uninstall left-pad")).toBe("snip npm uninstall left-pad")
    expect(rw("pnpm add react")).toBe("snip pnpm add react")
  })

  test("npm view keeps its output — the install filter would reduce it to 'ok'", () => {
    expect(rw("npm view react version")).toBe("npm view react version")
    expect(rw("npm run build")).toBe("npm run build")
    expect(rw("npm ls --depth 0")).toBe("npm ls --depth 0")
    expect(rw("pnpm run dev")).toBe("pnpm run dev")
  })

  test("an empty string in the list is snip's bare-invocation key", () => {
    expect(rw("yarn")).toBe("snip yarn")
    expect(rw("yarn add react")).toBe("snip yarn add react")
    expect(rw("yarn test")).toBe("yarn test")
  })

  test("docker only wraps the four subcommands upstream filters", () => {
    expect(rw("docker ps")).toBe("snip docker ps")
    expect(rw("docker build .")).toBe("snip docker build .")
    expect(rw("docker exec -it web sh")).toBe("docker exec -it web sh")
  })
})

describe("the subcommand key is the first argument, flag or not", () => {
  test("a global flag before the subcommand reaches no filter in snip", () => {
    expect(rw("git --no-pager log -5")).toBe("git --no-pager log -5")
    expect(rw("git --no-pager status")).toBe("git --no-pager status")
    expect(rw("npm --silent install")).toBe("npm --silent install")
    expect(rw("pnpm -r install")).toBe("pnpm -r install")
    expect(rw("docker --debug ps")).toBe("docker --debug ps")
  })

  test("a flag-only invocation falls to the wildcard filter's exclude list", () => {
    expect(rw("yarn --version")).toBe("yarn --version")
    expect(rw("tsc --version")).toBe("tsc --version")
    expect(rw("tsc --noEmit")).toBe("snip tsc --noEmit")
  })

  test("user deny still reads the first non-flag argument", () => {
    const cfg = { ...config, deny: [...config.deny, "git status"] }
    expect(rewrite("git status", table, cfg)).toBe("git status")
  })
})

describe("exclude_flags match positional args too", () => {
  test("gh pr excludes the literal 'diff' (snip issue #87)", () => {
    expect(rw("gh pr diff 12")).toBe("gh pr diff 12")
    expect(rw("gh pr list")).toBe("snip gh pr list")
    expect(rw("gh pr view 12")).toBe("snip gh pr view 12")
  })
})

describe("exclude_flags written as a multi-line flow sequence", () => {
  test("git diff/show/log keep their patch when one is asked for", () => {
    expect(rw("git diff -p")).toBe("git diff -p")
    expect(rw("git diff --name-only")).toBe("git diff --name-only")
    expect(rw("git show -p HEAD")).toBe("git show -p HEAD")
    expect(rw("git log --graph")).toBe("git log --graph")
    expect(rw("git diff")).toBe("snip git diff")
    expect(rw("git log -5")).toBe("snip git log -5")
  })

  test("the extractor reads a list that opens on the next line", () => {
    const rules = extractMatchRules(
      [
        'name: "x"',
        "match:",
        '  command: "git"',
        '  subcommand: "diff"',
        "  exclude_flags:",
        '    ["--stat", "--name-only",',
        '     "-p", "--patch"]',
        "pipeline:",
        '  - action: "head"',
      ].join("\n"),
    )
    expect(rules).toEqual([
      {
        command: "git",
        subcommand: "diff",
        excludeFlags: ["--stat", "--name-only", "-p", "--patch"],
      },
    ])
  })

  test("inline and block subcommand lists both yield one rule each", () => {
    const head = ['name: "x"', "match:", '  command: "pkg"']
    const tail = ["pipeline:", '  - action: "head"']
    const inline = extractMatchRules(
      [...head, '  subcommand: ["a", "b"]', ...tail].join("\n"),
    )
    const block = extractMatchRules(
      [...head, "  subcommand:", '    - "a"', '    - "b"', ...tail].join("\n"),
    )
    expect(inline.map((r) => r.subcommand)).toEqual(["a", "b"])
    expect(block).toEqual(inline)
  })

  test("an omitted subcommand still means 'any first argument'", () => {
    const rules = extractMatchRules(
      ['name: "x"', "match:", '  command: "tsc"', "pipeline:", '  - action: "head"'].join("\n"),
    )
    expect(rules).toEqual([{ command: "tsc", subcommand: null, excludeFlags: [] }])
  })
})

describe("snip's own CLI is not a command to unwrap", () => {
  test("native invocations survive stripMimicry intact", () => {
    for (const cmd of [
      "snip --version",
      "snip config",
      "snip gain --daily",
      "snip discover",
      "snip verify --require-all",
      "snip init --agent cursor",
      "snip run -- git log -10",
      "snip check -- npm install",
      "snip -u git log",
    ]) {
      expect(rw(cmd)).toBe(cmd)
    }
  })

  test("stray prefixes on real programs still collapse", () => {
    expect(rw("snip sed -n 1p f")).toBe("sed -n 1p f")
    expect(rw("snip snip git status")).toBe("snip git status")
    expect(rw("git log | snip python3 -c x")).toBe("snip git log | python3 -c x")
  })
})
