import assert from "node:assert/strict";
import test from "node:test";
import { ConfigurationError } from "../src/errors.js";
import { validateSourceContext } from "../src/sources/source.js";

test("source context accepts only bounded non-secret primitive metadata", () => {
  assert.deepEqual(validateSourceContext({ subreddit: "selfhosted", score: 42, mature: false, flair: null }), {
    subreddit: "selfhosted",
    score: 42,
    mature: false,
    flair: null
  });
  assert.throws(
    () => validateSourceContext({ accessToken: "must-not-be-stored" }),
    (error: unknown) => error instanceof ConfigurationError && /credential/.test(error.message)
  );
  assert.throws(
    () => validateSourceContext({ nested: { raw: "provider payload" } }),
    /must be a string, number, boolean, or null/
  );
  assert.throws(
    () => validateSourceContext({ note: "x".repeat(2_001) }),
    /exceeds 2000 characters/
  );
});
