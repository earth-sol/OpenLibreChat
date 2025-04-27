#!/usr/bin/env bun
/**
 * scripts/check-updates.js
 * --------------------------------
 * Bun-native CLI to check for recent npm package releases.
 * - Auto-discovers package.json if none specified.
 * - Multi-package.json support.
 * - Dynamic window (days back).
 * - Output as JSON or text.
 * - Dry-run and strict mode.
 * - Pure JavaScript + JSDoc.
 */

/**
 * @param {string} msg
 */
function print(msg) {
  console.log(`ℹ️  ${msg}`);
}

/**
 * @param {string} msg
 */
function success(msg) {
  console.log(`✅ ${msg}`);
}

/**
 * @param {string} msg
 */
function warn(msg) {
  console.warn(`⚠️  ${msg}`);
}

/**
 * @param {string} msg
 */
function error(msg) {
  console.error(`❌ ${msg}`);
  Bun.exit(1);
}

/**
 * Parses CLI arguments into options and positional args.
 * @param {string[]} args
 * @returns {{ options: Record<string,string>, positional: string[] }}
 */
function parseArgs(args) {
  const options = {};
  const positional = [];
  for (const arg of args) {
    if (arg.startsWith("--days=")) {
      options.days = arg.split("=")[1];
    } else if (arg.startsWith("--format=")) {
      options.format = arg.split("=")[1];
    } else if (arg === "--dry-run") {
      options.dryRun = "true";
    } else if (arg === "--strict") {
      options.strict = "true";
    } else {
      positional.push(arg);
    }
  }
  return { options, positional };
}

/**
 * Finds all package.json files in the repo, excluding common build dirs.
 * @returns {Promise<string[]>}
 */
async function findAllPackageJsons() {
  const glob = new Bun.Glob("**/package.json");
  const matches = await glob.scan({
    cwd: Bun.env.PWD || ".",
    absolute: true,
  });
  return matches.filter(path =>
    !path.includes("node_modules/") &&
    !path.includes("dist/") &&
    !path.includes("build/") &&
    !path.includes(".git/") &&
    !path.includes("coverage/")
  );
}

/**
 * Reads and parses a JSON file.
 * @param {string} path
 * @returns {Promise<any>}
 */
async function readJson(path) {
  const text = await Bun.file(path).text();
  return JSON.parse(text);
}

/**
 * Returns a timestamp (ms) for X days ago.
 * @param {number} daysBack
 * @returns {number}
 */
function daysAgoTimestamp(daysBack) {
  return Date.now() - daysBack * 24 * 60 * 60 * 1000;
}

/**
 * Checks each package for new versions within daysBack.
 * @param {string[]} packages
 * @param {number} daysBack
 * @returns {Promise<{package:string,version:string,published:string}[]>}
 */
async function checkPackageUpdates(packages, daysBack) {
  const now = Date.now();
  const cutoff = daysAgoTimestamp(daysBack);
  const updates = [];
  for (const pkg of packages) {
    try {
      const result = await $`bun pm info ${pkg} time --json`;
      const times = JSON.parse(result.stdout.toString());
      for (const [version, pubDate] of Object.entries(times)) {
        if (typeof pubDate === "string") {
          const t = new Date(pubDate).getTime();
          if (t > cutoff && t <= now) {
            updates.push({ package: pkg, version, published: pubDate });
          }
        }
      }
    } catch (e) {
      warn(`Failed to fetch info for ${pkg}: ${e.message}`);
    }
  }
  return updates;
}

async function main() {
  // Ensure Bun is installed and log version
  try {
    const bunVer = Bun.spawnSync(["bun", "--version"], { stdout: "pipe" })
      .stdout.toString().trim();
    print(`Bun version: ${bunVer}`);
  } catch {
    error("Bun is not installed. Install from https://bun.sh/");
  }

  const { options, positional } = parseArgs(Bun.argv.slice(2));
  const daysBack = parseInt(options.days || "3", 10);
  const format = options.format || "text";
  const dryRun = options.dryRun === "true";
  const strict = options.strict === "true";

  let pkgPaths = positional;
  if (pkgPaths.length === 0) {
    print("No package.json paths provided; scanning project...");
    pkgPaths = await findAllPackageJsons();
    if (pkgPaths.length === 0) {
      error("No package.json files found.");
    }
    print(`Found ${pkgPaths.length} package.json files.`);
  }

  const pkgSet = new Set();
  for (const path of pkgPaths) {
    const json = await readJson(path);
    for (const dep of Object.keys(json.dependencies || {})) pkgSet.add(dep);
    for (const dep of Object.keys(json.devDependencies || {})) pkgSet.add(dep);
  }

  if (pkgSet.size === 0) {
    if (strict) error("No dependencies to check.");
    else { warn("No dependencies to check."); Bun.exit(0); }
  }

  const updates = await checkPackageUpdates([...pkgSet], daysBack);

  if (dryRun) {
    if (format === "json") console.log(JSON.stringify(updates, null, 2));
    else updates.forEach(u => console.log(`- ${u.package}@${u.version} published on ${u.published}`));
    return;
  }

  if (updates.length === 0) {
    success(`No recent updates in the last ${daysBack} days.`);
    return;
  }

  if (format === "json") {
    console.log(JSON.stringify(updates, null, 2));
  } else {
    console.log(`Recent updates within ${daysBack} days:`);
    updates.forEach(u =>
      console.log(`- ${u.package}@${u.version} published on ${u.published}`)
    );
  }

  success(`Checked ${pkgSet.size} packages.`);
}

main().catch(e => error(e.message || String(e)));