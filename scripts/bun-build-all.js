#!/usr/bin/env bun
/**
 * scripts/bun-build-all.js
 * --------------------------------
 * Bun-native CLI to build all workspaces in a monorepo.
 * - Cleans root dist/
 * - Detects workspaces from package.json "workspaces"
 * - Supports --verbose/-v, --concurrency=N, --dry-run flags
 * - Auto-detects entrypoints if no build script
 * - Uses Bun Core APIs: Glob, spawn, stat, rm, file, env, exit
 * - Concurrent builds, debug logging, graceful errors
 */

import { Glob } from "bun";
import path from "path";

/** Parse CLI args for --verbose, --concurrency=N, --dry-run */
function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    if (arg === "--verbose" || arg === "-v") opts.verbose = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("--concurrency=")) {
      const n = parseInt(arg.split("=")[1], 10);
      if (Number.isInteger(n) && n > 0) opts.concurrency = n;
    }
  }
  return opts;
}
const options = parseArgs(Bun.argv.slice(2));
const verbose = Boolean(options.verbose);
const dryRun = Boolean(options.dryRun);
const concurrency = Number.isInteger(options.concurrency) && options.concurrency > 0
  ? options.concurrency
  : 1;
const debug = Boolean(Bun.env.DEBUG_LOGGING || Bun.env.DEBUG_CONSOLE);

/** Logging helpers */
function print(msg) { console.log(`ℹ️  ${msg}`); }
function success(msg) { console.log(`✅ ${msg}`); }
function error(msg) { console.error(`❌ ${msg}`); Bun.exit(1); }
function debugLog(msg, ...args) { if (debug) console.debug(`🐛 [build][debug] ${msg}`, ...args); }

/** Check if an executable exists in PATH */
function checkExecutable(name) {
  return Bun.spawnSync(["which", name], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

/** Check whether a path exists */
async function pathExists(p) {
  try {
    await Bun.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Detect common entry files in a workspace */
async function detectEntry(ws) {
  const candidates = [
    "index.ts", "index.js",
    "src/index.ts", "src/index.js",
    "server/index.ts", "server/index.js",
    "src/main.tsx", "src/main.jsx"
  ];
  for (const rel of candidates) {
    const full = path.join(ws, rel);
    if (await pathExists(full)) return rel;
  }
  return null;
}

/** Expand workspace patterns to actual directories */
async function expandWorkspaces(patterns) {
  const dirs = [];
  const root = Bun.env.PWD;
  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      // glob each pattern/package.json
      for await (const file of new Glob(`${pattern}/package.json`).scan(root)) {
        dirs.push(path.dirname(file));
      }
    } else {
      const wsDir = pattern.replace(/\/$/, "");
      const pkgFile = path.join(root, wsDir, "package.json");
      if (await pathExists(pkgFile)) dirs.push(path.join(root, wsDir));
    }
  }
  return dirs;
}

/** Run an array of async tasks with a concurrency limit */
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

async function main() {
  // Ensure Bun exists
  if (!checkExecutable("bun")) {
    error("Bun CLI not found. Please install Bun from https://bun.sh/");
  }

  const root = Bun.env.PWD;
  print("🧹 Cleaning root dist/ …");
  await Bun.rm(path.join(root, "dist"), { recursive: true, force: true }).catch(() => {});

  print("📦 Reading workspaces from package.json …");
  const rootPkg = JSON.parse(await Bun.file(path.join(root, "package.json")).text());
  const patterns = rootPkg.workspaces || [];
  if (!patterns.length) {
    print("⚠️  No workspaces defined--nothing to build.");
    return;
  }

  debugLog("Workspace patterns:", patterns);
  const workspaces = await expandWorkspaces(patterns);
  debugLog("Detected workspaces:", workspaces);

  if (!workspaces.length) {
    print("⚠️  No valid workspace directories found.");
    return;
  }

  print(`🚧 Building ${workspaces.length} workspace(s) with concurrency=${concurrency}…`);
  const tasks = workspaces.map(ws => async () => {
    const relWs = path.relative(root, ws);
    print(`\n🔨 Workspace: ${relWs}`);
    const pkgFile = path.join(ws, "package.json");
    const pkg = JSON.parse(await Bun.file(pkgFile).text());

    // Determine build command
    let cmd;
    let cwd = ws;
    const env = { ...Bun.env, NODE_ENV: "production" };

    if (pkg.scripts?.["b:build"]) {
      cmd = ["bun", "run", "b:build"];
    } else if (pkg.scripts?.build) {
      cmd = ["bun", "run", "build"];
    } else {
      const entry = await detectEntry(ws);
      if (!entry) {
        print(`⚠️  No entrypoint found in ${relWs}, skipping.`);
        return;
      }
      const outdir = path.join(root, "dist", relWs);
      await Bun.mkdir(path.dirname(outdir), { recursive: true }).catch(() => {});
      cmd = ["bun", "build", "--outdir", outdir, entry];
      cwd = ws;
    }

    print(`▶️  ${cmd.join(" ")}`);
    debugLog("Spawn env:", env);
    if (dryRun) {
      debugLog("Dry-run mode; skipping execution.");
      return;
    }

    const proc = Bun.spawn({ cmd, cwd, env, stdout: "inherit", stderr: "inherit" });
    const { exitCode } = await proc.exited;
    if (exitCode !== 0) {
      error(`Build failed for ${relWs} (exit ${exitCode}).`);
    } else {
      success(`Built ${relWs} successfully.`);
    }
  });

  await runConcurrent(tasks, concurrency);
  success("\n✅ All workspaces built successfully.");
}

main().catch(err => {
  console.error("🚨 Unexpected error:", err);
  Bun.exit(1);
});