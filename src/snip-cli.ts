import { spawnSync } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { delimiter, resolve } from "node:path"

export const PINNED_SNIP_VERSION = "0.25.2"

export const SNIP_NATIVE_SUBCOMMANDS = new Set([
  "run", "check", "init", "hook", "hook-audit", "gain", "cc-economics",
  "discover", "learn", "verify", "config", "trust", "untrust", "proxy",
  "inspect",
])

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

export function resolveSnip(snipPath: string): string | null {
  if (!snipPath) return null
  if (snipPath.includes("/")) {
    const file = resolve(snipPath)
    return isExecutableFile(file) ? file : null
  }
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue
    const file = resolve(dir, snipPath)
    if (isExecutableFile(file)) return file
  }
  return null
}

export function snipVersion(resolved: string): string | null {
  try {
    const r = spawnSync(resolved, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    if (r.status !== 0) return null
    return r.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null
  } catch {
    return null
  }
}
