import { describe, expect, test } from "bun:test"
import { analyzeSegment, splitTopLevel } from "../src/parser"

const join = (pieces: { text: string }[]) => pieces.map((p) => p.text).join("")

describe("splitTopLevel", () => {
  test("single command", () => {
    const p = splitTopLevel("git status")!
    expect(p).toEqual([{ kind: "seg", text: "git status" }])
  })

  test("reconstruction is lossless", () => {
    const cmd = "git add -A &&  git commit -m 'x; y && z' ; echo done | wc -l"
    expect(join(splitTopLevel(cmd)!)).toBe(cmd)
  })

  test("does not split pipes inside quotes (issue #8)", () => {
    const cmd = `cat file.json | jq '.content[0].text | fromjson | .results[]'`
    const p = splitTopLevel(cmd)!
    const ops = p.filter((x) => x.kind === "op")
    expect(ops).toHaveLength(1) // only the real pipe
  })

  test("does not split on & in redirections", () => {
    const p = splitTopLevel("make build 2>&1")!
    expect(p).toEqual([{ kind: "seg", text: "make build 2>&1" }])
    const q = splitTopLevel("cmd &> out.log")!
    expect(q.filter((x) => x.kind === "op")).toHaveLength(0)
  })

  test("splits on background &", () => {
    const p = splitTopLevel("pnpm dev & sleep 2")!
    expect(p.filter((x) => x.kind === "op")[0]?.text).toBe("&")
  })

  test("refuses heredocs", () => {
    expect(splitTopLevel("python3 - <<'EOF'\nimport os\nEOF")).toBeNull()
    expect(splitTopLevel("cat > f << EOF\nhello\nEOF")).toBeNull()
  })

  test("allows herestrings", () => {
    expect(splitTopLevel("wc -l <<< 'hello'")).not.toBeNull()
  })

  test("refuses control flow", () => {
    expect(splitTopLevel("for i in 1 2; do echo $i; done")).toBeNull()
    expect(splitTopLevel("if [ -f x ]; then cat x; fi")).toBeNull()
    expect(splitTopLevel("while true; do sleep 1; done")).toBeNull()
  })

  test("refuses unbalanced quotes", () => {
    expect(splitTopLevel(`echo "unclosed`)).toBeNull()
  })

  test("operators inside $() are not split points", () => {
    const cmd = `echo $(git status && echo ok)`
    const p = splitTopLevel(cmd)!
    expect(p.filter((x) => x.kind === "op")).toHaveLength(0)
  })

  test("newline separates segments", () => {
    const p = splitTopLevel("git status\ngit log")!
    expect(p.filter((x) => x.kind === "seg")).toHaveLength(2)
  })
})

describe("analyzeSegment", () => {
  test("plain command", () => {
    const i = analyzeSegment("git log --oneline -5")!
    expect(i.head).toBe("git")
    expect(i.subcommand).toBe("log")
    expect(i.envPrefix).toBe("")
  })

  test("env prefix preserved", () => {
    const i = analyzeSegment("TZ=Europe/Warsaw git log")!
    expect(i.envPrefix).toBe("TZ=Europe/Warsaw ")
    expect(i.head).toBe("git")
  })

  test("quoted env values", () => {
    const i = analyzeSegment(`DATABASE_URL="postgresql://u:p@localhost:5432/db" yarn prisma generate`)!
    expect(i.head).toBe("yarn")
    expect(i.subcommand).toBe("prisma")
  })

  test("env value with command substitution is rejected (issue #22)", () => {
    expect(analyzeSegment("VAR=$(echo hello) command")).toBeNull()
  })

  test("path heads use basename", () => {
    expect(analyzeSegment("./gradlew assembleDebug")!.head).toBe("gradlew")
    expect(analyzeSegment("/usr/bin/git status")!.head).toBe("git")
  })

  test("subcommand skips flags", () => {
    expect(analyzeSegment("cargo --quiet test")!.subcommand).toBe("test")
  })

  test("redirection heads rejected", () => {
    expect(analyzeSegment("2>&1")).toBeNull()
    expect(analyzeSegment("> out.log")).toBeNull()
  })

  test("leading whitespace preserved", () => {
    const i = analyzeSegment("  git status")!
    expect(i.leading).toBe("  ")
  })
})
