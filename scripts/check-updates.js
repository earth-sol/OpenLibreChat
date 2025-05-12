#!/usr/bin/env bun

/**
 * Scans every package.json in the repo (excluding node_modules and .git),
 * and runs `bun outdated` (or `bun outdated --json`) to check for newer versions.
 *
 * ✔ Uses Bun.Glob for native file matching
 * ✔ Uses Bun.spawn to invoke Bun’s own CLI
 * ✔ Supports --format=text (default) or --format=json
 * ✔ Verbose by default; use --quiet or --silent to suppress
 * ✔ Supports --dry-run to preview without executing
 * ✔ Graceful per-package error handling; exits non-zero if any outdated or errors
 */

async function main() {
  // ─── CLI FLAGS ──────────────────────────────────────────────────────────────
  const args   = Bun.argv.slice(1);
  const dryRun = args.includes("--dry")       || args.includes("--dry-run");
  const quiet  = args.includes("--quiet")     || args.includes("--silent");
  const help   = args.includes("-h")          || args.includes("--help");
  const fmtArg = args.find(a => a.startsWith("--format="));
  const format = fmtArg
    ? fmtArg.split("=")[1]
    : args.includes("--json")
      ? "json"
      : "text";

  if (help) {
    console.log(`
Usage: check-updates.js [options]

Options:
  --format=text|json    Output format (default: text)
  --json                Alias for --format=json
  --dry-run, --dry      Preview which dirs would be checked
  --quiet, --silent     Suppress logs
  -h, --help            Show this help
`);
    Bun.exit(0);
  }

  const log   = (...m) => { if (!quiet) console.log(...m) };
  const error = (...m) => console.error(...m);
  const debug = (...m) => { if (!quiet) console.debug(...m) };

  log("▶ check-updates: starting in format:", format);

  // ─── PROJECT ROOT ────────────────────────────────────────────────────────────
  const rootUrl  = new URL("../", import.meta.url);
  const rootPath = Bun.fileURLToPath(rootUrl);

  // ─── COLLECT DIRECTORIES ──────────────────────────────────────────────────────
  const dirs = new Set([rootPath]);
  const pkgGlob = new Bun.Glob("**/package.json");
  for await (const pkgPath of pkgGlob.scan({ cwd: rootPath, absolute: true, onlyFiles: true })) {
    if (pkgPath.includes("/node_modules/") || pkgPath.includes("/.git/")) continue;
    const idx = pkgPath.lastIndexOf("/");
    const dir = idx >= 0 ? pkgPath.slice(0, idx) : rootPath;
    dirs.add(dir);
  }

  // ─── RUN OUTDATED CHECKS ──────────────────────────────────────────────────────
  let failures = 0;
  const results = {}; // for JSON format

  for (const dir of dirs) {
    log(`\n→ Checking updates in ${dir}`);
    if (dryRun) {
      log("   (dry-run) would run: bun outdated" + (format === "json" ? " --json" : ""));
      continue;
    }

    // Build command
    const cmd = ["bun", "outdated"];
    if (format === "json") cmd.push("--json");

    debug("   cmd:", cmd.join(" "));

    const proc = Bun.spawn({
      cmd,
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const { exitCode } = await proc.exited;
    const out = await proc.stdout.text();
    const err = await proc.stderr.text();

    if (format === "json") {
      if (exitCode === 0 || exitCode === 1) {
        // 0: all up-to-date, 1: some outdated
        try {
          const data = out.trim() ? JSON.parse(out) : {};
          // use relative path as key
          const rel = dir === rootPath ? "." : dir.slice(rootPath.length + 1);
          results[rel] = data;
        } catch (e) {
          error(`❌ JSON parse error in ${dir}:`, e.message);
          failures++;
        }
      } else {
        error(`❌ bun outdated failed in ${dir} (exit ${exitCode})`);
        if (err) error(err.trim());
        failures++;
      }
    } else {
      // text mode: print stdout & stderr
      if (exitCode === 0) {
        log("   ✔ up-to-date");
      } else if (exitCode === 1) {
        log(out.trim() || "(no outdated packages found)");
      } else {
        error(`❌ bun outdated error in ${dir} (exit ${exitCode})`);
        if (err) error(err.trim());
        failures++;
      }
    }
  }

  // ─── OUTPUT & EXIT ───────────────────────────────────────────────────────────
  if (format === "json" && !dryRun) {
    console.log(JSON.stringify(results, null, 2));
  }

  if (failures > 0) {
    error(`\n❌ check-updates: completed with ${failures} errors/outdated`);
    Bun.exit(1);
  } else {
    log(`\n✔ check-updates: all done`);
  }
}

main().catch(err => {
  console.error("‼ check-updates crashed:", err);
  Bun.exit(1);
});