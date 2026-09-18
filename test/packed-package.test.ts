import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("packed-artifact validation works with inherited npm publish dry-run", { timeout: 120_000 }, () => {
  // Exercise the real nested pack/install/load path, not just argument construction.
  // `npm publish --dry-run` exports this setting into prepublishOnly and its children.
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("../scripts/check-packed-package.mjs", import.meta.url)),
  ], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, npm_config_dry_run: "true" },
    encoding: "utf8",
    timeout: 110_000,
    maxBuffer: 5 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Packed Pi Switchyard artifact installed and loaded successfully/);
});
