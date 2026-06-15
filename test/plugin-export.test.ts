import { describe, expect, test } from "bun:test"
import * as entry from "../src/index"

// Regression guard for the v0.1.0 launch bug: if opencode does not detect a V1
// default plugin module (`{ id, server }`), it falls back to a legacy loader that
// treats EVERY export as a plugin factory. Non-plugin exports then break loading,
// and duplicate function exports register duplicate hooks. Keep this entry tiny.
describe("plugin entry — opencode load contract", () => {
  test("exports only the V1 default plugin module", () => {
    expect(Object.keys(entry)).toEqual(["default"])
  })

  test("default export has an id and server plugin", () => {
    expect(entry.default).toEqual({
      id: "opencode-smartsnip",
      server: expect.any(Function),
    })
  })
})
