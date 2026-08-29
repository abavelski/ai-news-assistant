import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonObject } from "../src/llm/provider.js";

test("parseJsonObject accepts fenced JSON", () => {
  const parsed = parseJsonObject<{ ok: boolean }>("```json\n{\"ok\":true}\n```");
  assert.deepEqual(parsed, { ok: true });
});
