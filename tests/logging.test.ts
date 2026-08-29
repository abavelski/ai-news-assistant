import assert from "node:assert/strict";
import test from "node:test";
import { Logger } from "../src/logging.js";

test("structured logger includes levels and context", () => {
  const lines: string[] = [];
  const log = new Logger({ component: "test" }, {
    level: "debug",
    sink: (line) => lines.push(line)
  });

  log.info("hello", { requestId: "req-1" });
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  assert.equal(record.level, "info");
  assert.equal(record.message, "hello");
  assert.equal(record.component, "test");
  assert.equal(record.requestId, "req-1");
  assert.equal(typeof record.timestamp, "string");
});

test("structured logger redacts API keys and authorization headers", () => {
  const lines: string[] = [];
  const log = new Logger({}, {
    level: "debug",
    sink: (line) => lines.push(line)
  });

  log.error("request failed with authorization: Bearer message-secret", {
    apiKey: "api-secret",
    headers: { authorization: "Bearer header-secret", accept: "application/json" },
    nested: { token: "token-secret" }
  });

  const line = lines.join("\n");
  assert.doesNotMatch(line, /api-secret|header-secret|message-secret|token-secret/);
  assert.match(line, /\[REDACTED\]/);
});
