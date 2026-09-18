import assert from "node:assert/strict";
import test from "node:test";
import { validateRelease } from "../scripts/check-release.js";

const manifest = { name: "pi-switchyard", version: "0.1.0" };
const release = { tag_name: "v0.1.0", prerelease: false, draft: false };

test("stable releases publish under latest", () => {
  assert.equal(validateRelease(manifest, release), "latest");
});

test("prereleases publish under next without replacing latest", () => {
  for (const version of ["0.2.0-beta.1", "1.0.0-rc.0", "1.0.0-0", "1.0.0-beta.1+build.42"]) {
    assert.equal(validateRelease({ ...manifest, version }, {
      ...release, tag_name: `v${version}`, prerelease: true,
    }), "next");
  }
});

test("release tags must exactly match the version", () => {
  for (const tag_name of ["0.1.0", "v0.2.0", "v0.1.0\n", "$(echo injected)", undefined]) {
    assert.throws(() => validateRelease(manifest, { ...release, tag_name }), /exactly match/);
  }
});

test("release and package prerelease status must agree", () => {
  assert.throws(() => validateRelease(manifest, { ...release, prerelease: true }), /prerelease status/);
  assert.throws(() => validateRelease({ ...manifest, version: "0.1.0-beta.1" }, {
    ...release, tag_name: "v0.1.0-beta.1",
  }), /prerelease status/);
});

test("private, wrong-name, draft and malformed releases are rejected", () => {
  assert.throws(() => validateRelease({ ...manifest, private: true }, release), /public/);
  assert.throws(() => validateRelease({ ...manifest, name: "other-package" }, release), /public/);
  assert.throws(() => validateRelease(manifest, { ...release, draft: true }), /published/);
  assert.throws(() => validateRelease(manifest, { tag_name: "v0.1.0" }), /published/);
  for (const version of ["01.0.0", "1.0", "1.0.0-beta.01", "1.0.0-", "v1.0.0", "1.0.0\n", null]) {
    assert.throws(() => validateRelease({ ...manifest, version }, release), /semantic version/);
  }
});
