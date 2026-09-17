import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeForRouter } from "../src/privacy.js";

test("redacts common credentials from Jev routing state", () => {
  const input = [
    "TYPESAFE_API_KEY=secret-value",
    "PASSWORD='secret with spaces'",
    "Bearer abcdefghijklmnop",
    "sk-abcdefghijklmnop",
    "AKIAABCDEFGHIJKLMNOP",
    "eyJabc.def.ghi",
    "postgres://user:password@example.test/db",
  ].join(" ");
  const output = sanitizeForRouter(input);
  assert.doesNotMatch(output, /secret-value|secret with spaces|abcdefghijklmnop|AKIAABCDEFGHIJKLMNOP|eyJabc|:password@/);
  assert.match(output, /REDACTED/);
});

test("bounds text sent to Jev", () => {
  const output = sanitizeForRouter("x".repeat(100), 10);
  assert.match(output, /^x{10}/);
  assert.match(output, /truncated for routing/);
});
