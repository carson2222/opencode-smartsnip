import { describe, expect, test } from "bun:test"
import * as entry from "../src/index"

// Regression guard for the v0.1.0 launch bug: opencode loads the package `main`
// and treats EVERY export as a plugin factory, throwing "Plugin export is not a
// function" on the first non-function export. v0.1.0 re-exported DEFAULT_DENY (an
// array) from the entry, so the plugin never loaded. The entry must stay clean.
describe("plugin entry — opencode load contract", () => {
  test("every export is a function", () => {
    const exports = Object.entries(entry)
    expect(exports.length).toBeGreaterThan(0)
    for (const [name, value] of exports) {
      expect(typeof value === "function", `export "${name}" must be a function`).toBe(true)
    }
  })

  test("exposes the plugin as default and named export", () => {
    expect(typeof entry.default).toBe("function")
    expect(typeof entry.SmartSnipPlugin).toBe("function")
    expect(entry.default).toBe(entry.SmartSnipPlugin)
  })
})
