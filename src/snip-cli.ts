export const PINNED_SNIP_VERSION = "0.25.2"

export const SNIP_NATIVE_SUBCOMMANDS = new Set([
  "run", "check", "init", "hook", "hook-audit", "gain", "cc-economics",
  "discover", "learn", "verify", "config", "trust", "untrust", "proxy",
  "inspect",
])

export function resolveSnip(snipPath: string): string | null {
  // Explicit PATH reflects runtime changes; Bun.which otherwise uses its startup snapshot.
  return Bun.which(snipPath, { PATH: process.env["PATH"] ?? "" })
}

export function snipVersion(resolved: string): string | null {
  try {
    const r = Bun.spawnSync([resolved, "--version"], { stderr: "ignore" })
    if (r.exitCode !== 0) return null
    return r.stdout.toString().match(/\d+\.\d+\.\d+/)?.[0] ?? null
  } catch {
    return null
  }
}
