#!/usr/bin/env bun
/**
 * scripts/bump-version.js
 * --------------------------------
 * Bun-native CLI to bump patch version across all package.json files.
 * - Uses Bun's semver API.
 * - Finds all package.json (excluding node_modules, dist, build, .git).
 * - Reads root package.json to determine new version.
 * - Writes updated version to every discovered package.json.
 * - Outputs the new version.
 */

import { semver } from "bun";

/**
 * Reads JSON from a file.
 * @param {string} path
 * @returns {Promise<any>}
 */
async function readJson(path) {
  return JSON.parse(await Bun.file(path).text());
}

/**
 * Writes JSON to a file (preserving formatting).
 * @param {string} path
 * @param {any} obj
 */
async function writeJson(path, obj) {
  const text = JSON.stringify(obj, null, 2) + "\n";
  await Bun.write(path, text);
}

async function main() {
  // Find all package.json files
  const glob = new Bun.Glob("**/package.json");
  let files = await glob.scan({ cwd: Bun.env.PWD || ".", absolute: true });
  files = files.filter(path =>
    !path.includes("node_modules/") &&
    !path.includes("dist/") &&
    !path.includes("build/") &&
    !path.includes(".git/") &&
    !path.includes("coverage/")
  );

  if (files.length === 0) {
    console.error("❌ No package.json files found to bump.");
    Bun.exit(1);
  }

  // Read the root package.json first (fallback to first found)
  const cwd = Bun.env.PWD || ".";
  const rootPath = files.find(p => p === `${cwd}/package.json`) || files[0];
  const rootPkg = await readJson(rootPath);
  if (typeof rootPkg.version !== "string") {
    console.error("❌ Root package.json has no version field.");
    Bun.exit(1);
  }

  const newVersion = semver.inc(rootPkg.version, "patch");
  if (!newVersion) {
    console.error(`❌ Failed to bump version from ${rootPkg.version}`);
    Bun.exit(1);
  }

  console.log(`ℹ️  Bumping version to ${newVersion} in ${files.length} package.json files`);

  for (const file of files) {
    const pkg = await readJson(file);
    pkg.version = newVersion;
    await writeJson(file, pkg);
    console.log(`  • Updated ${file}`);
  }

  console.log(newVersion);
}

main().catch(err => {
  console.error("❌", err.message || err);
  Bun.exit(1);
});