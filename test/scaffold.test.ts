import assert from "node:assert/strict";
import test from "node:test";

import jevRouterExtension from "../src/index.js";

test("exports a Pi extension factory", () => {
  assert.equal(typeof jevRouterExtension, "function");
});
