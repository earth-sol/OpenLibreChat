#!/usr/bin/env bun
/**
 * scripts/bun-test-all.js
 * --------------------------------
 * Bun-native CLI to run all tests across a monorepo.
 * - Discovers package.json via Bun.Glob, skipping node_modules and hidden dirs
 * - Supports --watch/-w, --jobs/-j <n>, --help flags and BUN_TEST_WATCH, BUN_TEST_JOBS env
 * - Runs tests with concurrency, with coverage by default
 * - Uses Bun Core APIs: Glob, spawn, fileURLToPath, exit, color, version, revision
 * - Reports per-package pass/fail and overall summary
 */

import { Glob } from "bun";
import { fileURLToPath } from "bun:path";

/** Parse CLI args and env flags */
function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--watch" || arg === "-w") {
      options.watch = true;
    } else if (arg === "--jobs" || arg === "-j") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        options.jobs = Math.max(1, parseInt(next, 10) || 1);
        i++;
      } else {
        options.jobs = 1;
      }
    }
  }
  // Env overrides
  if (Bun.env.BUN_TEST_WATCH === "1") options.watch = true;
  if (!options.jobs && Bun.env.BUN_TEST_JOBS) {
    options.jobs = Math.max(1, parseInt(Bun.env.BUN_TEST_JOBS, 10) || 1);
  }
  options.jobs = options.jobs || 1;
  return options;
}

const options = parseArgs(Bun.argv.slice(2));
if (options.help) {
  console.log(`
Usage: bun run scripts/bun-test-all.js [options]

Options:
  -w, --watch           Run tests in watch mode
  -j, --jobs <number>   Number of concurrent test batches (default: 1)
  -h, --help            Show this help and exit

Env:
  BUN_TEST_WATCH=1      Same as --watch
  BUN_TEST_JOBS=<n>     Same as --jobs <n>
`.trim());
  Bun.exit(0);
}

// Print metadata
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
console.log(Bun.color(`bun-test-all.js v${Bun.version} (rev ${Bun.revision})`, "cyan"));
console.log(`[INFO] Project root: ${projectRoot}`);
console.log(`[INFO] Concurrency: ${options.jobs}, Watch: ${Boolean(options.watch)}`);

/** Discover all package.json files under the repo */
async function discoverPackages() {
  const glob = new Glob("**/package.json", {
    root: projectRoot,
    ignore: ["**/node_modules/**", "**/.*"]
  });
  const files = [];
  for await (const file of glob.scan()) {
    files.push(file);
  }
  return files;
}

(async () => {
  const pkgFiles = await discoverPackages();
  console.log(`[DEBUG] Found ${pkgFiles.length} package.json files`);

  // Build base test command
  const baseCmd = ["bun", "test", "--coverage"];
  if (options.watch) baseCmd.push("--watch");
  console.log(`[DEBUG] Test command: ${baseCmd.join(" ")}`);

  const failures = [];

  // Run tests in batches of `jobs`
  for (let i = 0; i < pkgFiles.length; i += options.jobs) {
    const batch = pkgFiles.slice(i, i + options.jobs).map(async pkgPath => {
      // Derive workspace dir
      const dir = pkgPath.slice(0, -"package.json".length);
      console.log(`[DEBUG] Testing in ${dir}`);

      const proc = Bun.spawn({
        cmd: baseCmd,
        cwd: dir,
        stdout: "inherit",
        stderr: "inherit"
      });
      const { exitCode } = await proc.exited;
      if (exitCode !== 0) {
        console.log(Bun.color(`FAILED in ${dir} (code ${exitCode})`, "red"));
        failures.push({ dir, code: exitCode });
      } else {
        console.log(Bun.color(`PASSED in ${dir}`, "green"));
      }
    });
    await Promise.all(batch);
  }

  // Summary
  if (failures.length > 0) {
    console.log(Bun.color(`\n${failures.length} failure(s) detected`, "red"));
    Bun.exit(1);
  } else {
    console.log(Bun.color(`\nAll tests passed!`, "green"));
    Bun.exit(0);
  }
})();