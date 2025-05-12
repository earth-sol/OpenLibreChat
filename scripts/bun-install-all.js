#!/usr/bin/env bun

/**
 * Recursively runs `bun install` in the root and every subdirectory
 * containing a package.json (excluding node_modules and .git).
 * 
 * ✔ Uses Bun.Glob for native, zero-install globs
 * ✔ Uses Bun.spawn for native child processes
 * ✔ Verbose by default (use --quiet or --silent to suppress)
 * ✔ Supports --dry-run to preview without executing
 * ✔ Graceful per-directory error handling, non-zero exit if any fail
 */

async function main() {
  // ─── CLI FLAGS ──────────────────────────────────────────────────────────────
  const args   = Bun.argv.slice(1);
  const dryRun = args.includes("--dry")       || args.includes("--dry-run");
  const quiet  = args.includes("--quiet")     || args.includes("--silent");
  const help   = args.includes("-h")          || args.includes("--help");

  if (help) {
    console.log(`
Usage: bun-install-all.js [options]

Options:
  --dry-run, --dry      Preview without actually running installs
  --quiet, --silent     Suppress all output
  -h, --help            Show this help
`);
    Bun.exit(0);
  }

  const log   = (...m) => { if (!quiet) console.log(...m) };
  const error = (...m) => console.error(...m);
  const debug = (...m) => { if (!quiet) console.debug(...m) };

  log("▶ bun-install-all: starting");

  // ─── PROJECT ROOT ────────────────────────────────────────────────────────────
  // Script lives in scripts/, so project root is one directory up
  const rootUrl  = new URL("../", import.meta.url);
  const rootPath = Bun.fileURLToPath(rootUrl);

  // ─── COLLECT DIRECTORIES ──────────────────────────────────────────────────────
  // Always install in root
  const dirs = new Set([rootPath]);

  // Find all package.json files
  const glob = new Bun.Glob("**/package.json");
  for await (const pkgPath of glob.scan({ cwd: rootPath, absolute: true, onlyFiles: true })) {
    // Skip vendor and git metadata
    if (pkgPath.includes("/node_modules/") || pkgPath.includes("/.git/")) continue;
    // Directory is everything before the last slash
    const idx = pkgPath.lastIndexOf("/");
    const dir = idx >= 0 ? pkgPath.slice(0, idx) : pkgPath;
    dirs.add(dir);
  }

  // ─── RUN INSTALLS ────────────────────────────────────────────────────────────
  let total = 0, failed = 0;
  for (const dir of dirs) {
    total++;
    log(`→ [${total}/${dirs.size}] bun install in ${dir}`);
    if (dryRun) {
      log("   (dry-run) would run: bun install");
      continue;
    }

    try {
      // Spawn bun install in that directory
      const proc = Bun.spawn({
        cmd: ["bun", "install"],
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe"
      });

      const { exitCode } = await proc.exited;
      const out = await proc.stdout.text();
      const err = await proc.stderr.text();

      if (exitCode !== 0) {
        error(`❌ install failed in ${dir} (exit ${exitCode})`);
        if (out.trim()) error(out.trim());
        if (err.trim()) error(err.trim());
        failed++;
      } else {
        log("   ✔ success");
        if (out.trim())  debug(out.trim());
        if (err.trim())  debug(err.trim());
      }
    } catch (err) {
      error(`❌ spawn error in ${dir}:`, err);
      failed++;
    }
  }

  // ─── SUMMARY & EXIT ──────────────────────────────────────────────────────────
  log(`\n✔ bun-install-all: done. total=${total}, failed=${failed}`);
  if (failed > 0) Bun.exit(1);
}

main().catch(err => {
  console.error("‼ bun-install-all crashed:", err);
  Bun.exit(1);
});