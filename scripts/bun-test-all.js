#!/usr/bin/env bun

/**
 * Recursively discovers all test files via Bun.Glob and runs them
 * under Bun’s test runner. 
 * 
 * ✔ Uses Bun.Glob for native file matching
 * ✔ Spawns a single `bun test` with explicit file list
 * ✔ Verbose by default (pass --quiet or --silent to suppress)
 * ✔ Supports --dry-run to preview without running tests
 * ✔ Graceful failure reporting, non-zero exit if tests fail
 */

async function main() {
  // ─── CLI FLAGS ──────────────────────────────────────────────────────────────
  const args   = Bun.argv.slice(1);
  const dryRun = args.includes("--dry")    || args.includes("--dry-run");
  const quiet  = args.includes("--quiet")  || args.includes("--silent");
  const help   = args.includes("-h")       || args.includes("--help");

  if (help) {
    console.log(`
Usage: bun-test-all.js [options]

Options:
  --dry-run, --dry      Preview which tests would run without executing
  --quiet, --silent     Suppress all output
  -h, --help            Show this help
`);
    Bun.exit(0);
  }

  const log   = (...m) => { if (!quiet) console.log(...m) };
  const error = (...m) => console.error(...m);
  const debug = (...m) => { if (!quiet) console.debug(...m) };

  log("▶ bun-test-all: starting");

  // ─── PROJECT ROOT ────────────────────────────────────────────────────────────
  // Script lives in scripts/, so root is one level up
  const rootUrl  = new URL("../", import.meta.url);
  const rootPath = Bun.fileURLToPath(rootUrl);

  // ─── TEST PATTERNS ──────────────────────────────────────────────────────────
  // These mirror your JSON plan's testPatterns
  const patterns = [
    "api/test/**/*.{spec,test}.js",
    "client/test/**/*.{spec,test}.tsx",
    "packages/**/test/**/*.{spec,test}.{js,ts,tsx}",
    "e2e/specs/**/*.{spec,test}.{js,ts}"
  ];

  // ─── DISCOVER TEST FILES ────────────────────────────────────────────────────
  const testFiles = new Set();

  for (const pattern of patterns) {
    debug(`Scanning pattern: ${pattern}`);
    const glob = new Bun.Glob(pattern);
    for await (const relPath of glob.scan({ cwd: rootPath, absolute: true, onlyFiles: true })) {
      testFiles.add(relPath);
    }
  }

  if (testFiles.size === 0) {
    log("⚠ No test files found, nothing to run.");
    Bun.exit(0);
  }

  // Convert to array
  const files = Array.from(testFiles);

  log(`Discovered ${files.length} test file(s).\n`);

  if (dryRun) {
    log("⚙️  Dry-run mode, would run:");
    for (const f of files) log("  -", f.replace(`${rootPath}/`, ""));
    Bun.exit(0);
  }

  // ─── RUN BUN TEST ────────────────────────────────────────────────────────────
  log("→ Running bun test on all discovered files...\n");
  const cmd = ["bun", "test", ...files];
  debug("Command:", cmd.join(" "));

  const proc = Bun.spawn({
    cmd,
    cwd: rootPath,
    stdout: "inherit",
    stderr: "inherit"
  });

  const { exitCode } = await proc.exited;

  if (exitCode !== 0) {
    error(`\n❌ bun-test-all: some tests failed (exit ${exitCode})`);
    Bun.exit(exitCode);
  } else {
    log("\n✔ bun-test-all: all tests passed");
  }
}

main().catch(err => {
  console.error("‼ bun-test-all crashed:", err);
  Bun.exit(1);
});