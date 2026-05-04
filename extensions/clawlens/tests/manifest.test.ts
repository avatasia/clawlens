import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

describe("openclaw.plugin.json", () => {
  test("collector config schema includes transcriptBindingStrategy", () => {
    const manifestPath = path.resolve(import.meta.dirname, "..", "openclaw.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const schema = manifest?.configSchema?.properties?.collector?.properties;
    assert.ok(schema);
    assert.deepEqual(schema.transcriptBindingStrategy, {
      type: "string",
      enum: ["legacy_recent_window", "safe_message_anchor"],
    });
  });
});
