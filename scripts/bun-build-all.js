#!/usr/bin/env bun

/**
 * Recursively discovers all subprojects with a "build" script in package.json,
 * then runs `bun run build` in each. Also includes the root if it has a build script.
 * 
 * ✔ Uses Bun.Glob for native file matching
 * ✔ Reads package.json via Bun.file().text()
 * ✔ Spawns Bun-native processes
 * ✔ Verbose by default (use --quiet/--silent to suppress)
 * ✔ Supports --dry-run for preview without executing
 * ✔ Graceful per-project error handling, non-zero exit if any fail
 */

async function main() {
  // ─── CLI FLAGS ──────────────────────────────────────────────────────────────
  const args   = Bun.argv.slice(1);
  const dryRun = args.includes("--dry")    || args.includes("--dry-run");
  const quiet  = args.includes("--quiet")  || args.includes("--silent");
  const help   = args.includes("-h")       || args.includes("--help");

  if (help) {
    console.log(`
Usage: bun-build-all.js [options]

Options:
  --dry-run, --dry      Preview which builds would run without executing
  --quiet, --silent     Suppress all output
  -h, --help            Show this help
`);
    Bun.exit(0);
  }

  const log   = (...m) => { if (!quiet) console.log(...m) };
  const error = (...m) => console.error(...m);
  const debug = (...m) => { if (!quiet) console.debug(...m) };

  log("▶ bun-build-all: starting");

  // ─── PROJECT ROOT ────────────────────────────────────────────────────────────
  const rootUrl  = new URL("../", import.meta.url);
  const rootPath = Bun.fileURLToPath(rootUrl);

  // ─── DISCOVER BUILDABLE PROJECTS ────────────────────────────────────────────
  const dirsToBuild = new Set();

  // Always consider root
  dirsToBuild.add(rootPath);

  // Scan for every package.json
  const glob = new Bun.Glob("**/package.json");
  for await (const pkgPath of glob.scan({ cwd: rootPath, absolute: true, onlyFiles: true })) {
    // Skip node_modules and .git
    if (pkgPath.includes("/node_modules/") || pkgPath.includes("/.git/")) continue;

    let pkgJson;
    try {
      pkgJson = JSON.parse(await Bun.file(pkgPath).text());
    } catch (err) {
      debug(`⚠ Skipping invalid JSON: ${pkgPath}`);
      continue;
    }

    // If it defines a "build" script, schedule it
    if (pkgJson.scripts && typeof pkgJson.scripts.build === "string") {
      const idx = pkgPath.lastIndexOf("/");
      const dir = idx >= 0 ? pkgPath.slice(0, idx) : rootPath;
      dirsToBuild.add(dir);
    }
  }

  // ─── RUN BUILDS ──────────────────────────────────────────────────────────────
  const allDirs = Array.from(dirsToBuild);
  log(`Found ${allDirs.length} project(s) with a build script.\n`);

  let total = 0, failed = 0;
  for (const dir of allDirs) {
    total++;
    log(`→ [${total}/${allDirs.length}] building in ${dir}`);
    if (dryRun) {
      log("   (dry-run) would run: bun run build");
      continue;
    }

    try {
      const proc = Bun.spawn({
        cmd: ["bun", "run", "build"],
        cwd: dir,
        stdout: "inherit",
        stderr: "inherit"
      });
      const { exitCode } = await proc.exited;
      if (exitCode !== 0) {
        error(`❌ build failed in ${dir} (exit ${exitCode})`);
        failed++;
      } else {
        log("   ✔ success");
      }
    } catch (err) {
      error(`❌ spawn error in ${dir}:`, err);
      failed++;
    }
  }

  // ─── SUMMARY & EXIT ──────────────────────────────────────────────────────────
  log(`\n✔ bun-build-all: done. total=${total}, failed=${failed}`);
  if (failed > 0) Bun.exit(1);
}

main().catch(err => {
  console.error("‼ bun-build-all crashed:", err);
  Bun.exit(1);
});