import { readFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// SemVer 2.0: numeric prerelease identifiers must not contain leading zeros.
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function validateRelease(
  manifest: { name?: unknown; version?: unknown; private?: unknown },
  release: { tag_name?: unknown; prerelease?: unknown; draft?: unknown },
): "latest" | "next" {
  if (manifest.name !== "pi-switchyard" || manifest.private === true) {
    throw new Error("Expected a public pi-switchyard package");
  }
  if (typeof manifest.version !== "string" || manifest.version !== manifest.version.trim() || !versionPattern.test(manifest.version)) {
    throw new Error("package.json must contain a valid semantic version");
  }
  if (release.draft !== false || typeof release.prerelease !== "boolean") {
    throw new Error("Expected a published GitHub release");
  }
  if (release.tag_name !== `v${manifest.version}`) {
    throw new Error("Release tag must exactly match v<package.json version>");
  }
  const hasPrereleaseVersion = Boolean(versionPattern.exec(manifest.version)?.[4]);
  if (release.prerelease !== hasPrereleaseVersion) {
    throw new Error("GitHub prerelease status must match the package version's prerelease suffix");
  }
  return release.prerelease ? "next" : "latest";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!eventPath || !outputPath || process.env.GITHUB_EVENT_NAME !== "release") {
    throw new Error("Run this script from a GitHub release workflow");
  }
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  if (event.action !== "published" || !event.release) {
    throw new Error("Only release.published events may publish to npm");
  }
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const tag = validateRelease(manifest, event.release);
  appendFileSync(outputPath, `npm_tag=${tag}\n`);
  console.log(`Validated pi-switchyard@${manifest.version}; npm dist-tag: ${tag}`);
}
