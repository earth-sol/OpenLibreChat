#!/usr/bin/env bun
/**
 * scripts/bun-install-all.js
 * --------------------------------
 * Bun-native CLI to install all dependencies across a monorepo.
 * - Auto-discovers all package.json (excluding build/test dirs)
 * - Installs in root first, then sub-packages
 * - Supports --verbose/-v, --concurrency=N, --dry-run
 * - Uses Bun Core APIs: Glob, spawn, env, exit
 * - Idempotent, fails gracefully, with debug logging
 */

import { Glob } from "bun";

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
function error(msg) {
  console.error(`❌ ${msg}`);
  Bun.exit(1);
}

/**
 * @param {string} msg
 * @param {...any} args
 */
function debugLog(msg, ...args) {
  if (debug) console.debug(`🛠 [bun-install-all][debug] ${msg}`, ...args);
}

/**
 * Check if an executable exists in PATH.
 * @param {string} name
 * @returns {boolean}
 */
function checkExecutable(name) {
  return Bun.spawnSync(["which", name], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

/**
 * Parse CLI args for --verbose, --concurrency=N, --dry-run
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (arg.startsWith("--concurrency=")) {
      options.concurrency = parseInt(arg.split("=")[1], 10);
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    }
  }
  return options;
}

/**
 * Run async tasks with a concurrency limit.
 * @param {Array<() => Promise<void>>} tasks
 * @param {number} limit
 */
async function runConcurrent(tasks, limit) {
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const task = tasks[idx++];
      await task();
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
}

const options = parseArgs(Bun.argv.slice(2));
const verbose = options.verbose === true;
const dryRun = options.dryRun === true;
const concurrency = Number.isInteger(options.concurrency) && options.concurrency > 0
  ? options.concurrency
  : 1;
const debug = Boolean(Bun.env.DEBUG_LOGGING || Bun.env.DEBUG_CONSOLE);

async function main() {
  if (!checkExecutable("bun")) {
    error("Bun CLI not found. Please install Bun from https://bun.sh/");
  }

  // Determine working directory
  const root = Bun.env.PWD;
  debugLog("Working directory:", root);

  // Discover package.json files
  const pkgFiles = [];
  for await (const path of new Glob("**/package.json").scan(root)) {
    if (/(node_modules|dist|build|\.git|coverage)\//.test(path)) {
      debugLog("Skipping excluded path:", path);
      continue;
    }
    pkgFiles.push(path);
  }

  if (pkgFiles.length === 0) {
    print("🔍 No package.json files found.");
    return;
  }

  // Sort: root first, then alphabetical
  pkgFiles.sort((a, b) => {
    if (a === `${root}/package.json`) return -1;
    if (b === `${root}/package.json`) return 1;
    return a.localeCompare(b);
  });

  print(`📦 Installing in ${pkgFiles.length} packages:`);
  pkgFiles.forEach(p => print(`   • ${p.replace(root + "/", "")}`));

  let hadError = false;
  const tasks = pkgFiles.map(pkgPath => async () => {
    const dir = pkgPath.replace(/\/package\.json$/, "");
    print(`➡️  Installing in: ${dir}`);
    debugLog("Install flags:", { dryRun, concurrency });
    if (dryRun) {
      debugLog("Dry-run mode: no actual install.");
      return;
    }
    const proc = Bun.spawn(["bun", "install"], {
      cwd: dir,
      stdout: "inherit",
      stderr: "inherit"
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.error(`❌ Failed in ${dir} (exit code ${exitCode})`);
      hadError = true;
    } else {
      success(`Installed successfully in ${dir}`);
    }
  });

  await runConcurrent(tasks, concurrency);

  if (hadError) {
    error("⚠️ One or more installs failed.");
  } else {
    success("🎉 All installs completed successfully.");
  }
}

main().catch(err => {
  console.error("🚨 Unexpected error:", err);
  Bun.exit(1);
});