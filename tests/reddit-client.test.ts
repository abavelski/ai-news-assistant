import assert from "node:assert/strict";
import test from "node:test";
import { FetchError } from "../src/errors.js";
import type { FetchFunction } from "../src/http.js";
import { RedditClient } from "../src/sources/reddit-client.js";

function clientConfig() {
  return {
    clientId: "client-id",
    clientSecret: "super-secret",
    userAgent: "linux:ai-news-assistant:0.1 (by /u/testowner)",
    timeoutMs: 5_000,
    retries: 1,
    retryBaseDelayMs: 10,
    maxResponseBytes: 100_000,
    maxRateLimitWaitMs: 10_000
  };
}

test("Reddit client uses application-only OAuth, a descriptive User-Agent, bearer auth, and token caching", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn: FetchFunction = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/api/v1/access_token")) {
      return new Response(JSON.stringify({ access_token: "token-value", token_type: "bearer", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ data: { children: [] } }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-ratelimit-remaining": "50",
        "x-ratelimit-reset": "60"
      }
    });
  };

  const client = new RedditClient(clientConfig(), { fetchFn, now: () => 1_000 });
  await client.getJson("/r/selfhosted/new", { limit: 25, raw_json: 1 });
  await client.getJson("/r/homelab/new", { limit: 10 });

  assert.equal(calls.length, 3, "one OAuth request should be reused for two API calls");
  const tokenRequest = calls[0];
  assert.match(tokenRequest?.url ?? "", /reddit\.com\/api\/v1\/access_token$/);
  assert.equal(tokenRequest?.init?.method, "POST");
  assert.equal(tokenRequest?.init?.body, "grant_type=client_credentials");
  const tokenHeaders = new Headers(tokenRequest?.init?.headers);
  assert.equal(tokenHeaders.get("user-agent"), clientConfig().userAgent);
  assert.equal(tokenHeaders.get("authorization"), `Basic ${Buffer.from("client-id:super-secret").toString("base64")}`);

  const apiHeaders = new Headers(calls[1]?.init?.headers);
  assert.equal(apiHeaders.get("user-agent"), clientConfig().userAgent);
  assert.equal(apiHeaders.get("authorization"), "Bearer token-value");
  assert.match(calls[1]?.url ?? "", /^https:\/\/oauth\.reddit\.com\/r\/selfhosted\/new\?/);
});

test("Reddit client follows bounded 429 guidance and never exposes OAuth secrets in errors", async () => {
  let apiAttempts = 0;
  const delays: number[] = [];
  const fetchFn: FetchFunction = async (input) => {
    const url = String(input);
    if (url.includes("/api/v1/access_token")) {
      return new Response(JSON.stringify({ access_token: "token-value", expires_in: 3600 }), { status: 200 });
    }
    apiAttempts += 1;
    if (apiAttempts === 1) {
      return new Response("rate limited", { status: 429, headers: { "retry-after": "0.02" } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const client = new RedditClient(clientConfig(), {
    fetchFn,
    sleep: async (milliseconds) => { delays.push(milliseconds); },
    now: () => 1_000
  });
  assert.deepEqual(await client.getJson("/api/test"), { ok: true });
  assert.equal(apiAttempts, 2);
  assert.deepEqual(delays, [20]);

  const failing = new RedditClient({ ...clientConfig(), retries: 0 }, {
    fetchFn: async (input) => String(input).includes("access_token")
      ? new Response("denied", { status: 401 })
      : new Response("unused", { status: 500 })
  });
  await assert.rejects(
    failing.getAccessToken(),
    (error: unknown) => {
      assert.ok(error instanceof FetchError);
      const serialized = JSON.stringify({ message: error.message, context: error.context });
      assert.doesNotMatch(serialized, /super-secret|client-id/);
      assert.equal(error.context?.kind, "authentication");
      return true;
    }
  );
});

test("Reddit client stops instead of waiting beyond the configured rate-limit window", async () => {
  const client = new RedditClient({ ...clientConfig(), maxRateLimitWaitMs: 100, retries: 1 }, {
    fetchFn: async (input) => String(input).includes("access_token")
      ? new Response(JSON.stringify({ access_token: "token-value", expires_in: 3600 }), { status: 200 })
      : new Response("limited", { status: 429, headers: { "retry-after": "2" } }),
    sleep: async () => undefined
  });

  await assert.rejects(
    client.getJson("/api/test"),
    (error: unknown) => error instanceof FetchError && error.context?.kind === "rate-limit"
  );
});