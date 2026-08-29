import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "../src/utils/hash.js";

test("sha256 is deterministic", () => {
  assert.equal(
    sha256("hello"),
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
  );
});
