import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await mkdtemp(join(tmpdir(), "pi-switchyard-pack-"));
const packDir = join(tempRoot, "pack");
const installDir = join(tempRoot, "install");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
  }
}

try {
  await mkdir(packDir, { recursive: true });
  // npm publish --dry-run exports npm_config_dry_run to lifecycle children.
  // These temporary local operations must create real files to validate the artifact.
  // Override only pack/install; never alter the parent publish's dry-run setting.
  run("npm", ["pack", "--ignore-scripts", "--dry-run=false", "--pack-destination", packDir]);

  const tarballs = (await readdir(packDir)).filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(`Expected one packed tarball, found ${tarballs.length}`);
  }

  const tarball = join(packDir, tarballs[0]);
  run("npm", [
    "install",
    "--ignore-scripts",
    "--dry-run=false",
    "--omit=dev",
    "--legacy-peer-deps",
    "--no-package-lock",
    "--no-audit",
    "--no-fund",
    "--prefix",
    installDir,
    tarball,
  ]);

  const installedRoot = join(installDir, "node_modules", "pi-switchyard");
  const installedManifest = JSON.parse(
    await readFile(join(installedRoot, "package.json"), "utf8"),
  );
  if (installedManifest.pi?.extensions?.[0] !== "./index.ts") {
    throw new Error("Packed package does not expose ./index.ts as its Pi extension");
  }

  run("pi", [
    "-ne",
    "-e",
    installedRoot,
    "-p",
    "--no-session",
    "/switchyard show",
  ]);

  console.log("Packed Pi Switchyard artifact installed and loaded successfully.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
