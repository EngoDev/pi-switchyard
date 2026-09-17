import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveTypeSafeApiKey } from "../src/auth.js";

test("environment key takes precedence without exposing its value", () => {
  assert.equal(resolveTypeSafeApiKey({ TYPESAFE_API_KEY: " direct " }, "/missing"), "direct");
});

test("loads TYPESAFE_API_KEY from a dotenv file", () => {
  const dir = mkdtempSync(join(tmpdir(), "switchyard-auth-"));
  const path = join(dir, ".env");
  try {
    writeFileSync(path, "OTHER=x\nTYPESAFE_API_KEY=file-secret\n");
    assert.equal(resolveTypeSafeApiKey({}, path), "file-secret");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
