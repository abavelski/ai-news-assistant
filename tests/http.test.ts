import assert from "node:assert/strict";
import test from "node:test";
import { FetchError } from "../src/errors.js";
import { fetchWithRetry, isRetryableHttpStatus, retryDelayMs } from "../src/http.js";

test("fetchWithRetry retries transient failures with exponential backoff and configured user-agent", async () => {
  const calls: Array<{ url: string; userAgent: string | null }> = [];
  const delays: number[] = [];
  let attempt = 0;

  const response = await fetchWithRetry("https://meduza.io/rss/all", {
    userAgent: "fixture-agent/1.0",
    timeoutMs: 5_000,
    retries: 2,
    retryBaseDelayMs: 25,
    fetchFn: async (input, init) => {
      attempt += 1;
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), userAgent: headers.get("user-agent") });
      if (attempt < 3) return new Response("temporary", { status: 503, statusText: "Unavailable" });
      return new Response("ok", { status: 200 });
    },
    sleep: async (milliseconds) => { delays.push(milliseconds); }
  });

  assert.equal(await response.text(), "ok");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.userAgent), ["fixture-agent/1.0", "fixture-agent/1.0", "fixture-agent/1.0"]);
  assert.deepEqual(delays, [25, 50]);
});

test("fetchWithRetry does not retry non-transient HTTP failures", async () => {
  let calls = 0;
  await assert.rejects(
    fetchWithRetry("https://meduza.io/not-found", {
      userAgent: "fixture-agent/1.0",
      timeoutMs: 5_000,
      retries: 3,
      retryBaseDelayMs: 1,
      fetchFn: async () => {
        calls += 1;
        return new Response("missing", { status: 404, statusText: "Not Found" });
      },
      sleep: async () => undefined
    }),
    (error: unknown) => error instanceof FetchError && /HTTP 404/.test(error.message)
  );
  assert.equal(calls, 1);
});

test("HTTP retry helpers classify only transient statuses and cap backoff", () => {
  assert.equal(isRetryableHttpStatus(429), true);
  assert.equal(isRetryableHttpStatus(503), true);
  assert.equal(isRetryableHttpStatus(404), false);
  assert.equal(retryDelayMs(500, 1), 500);
  assert.equal(retryDelayMs(500, 4), 4_000);
  assert.equal(retryDelayMs(10_000, 4), 30_000);
});
