#!/usr/bin/env bun

/**
 * Recursively bumps the patch version (X.Y.Z → X.Y.(Z+1)) in every package.json
 * under the repo (excluding node_modules and .git). 
 *
 * ✔ Uses Bun.Glob for native file discovery
 * ✔ Reads/writes with Bun.file() and Bun.write()
 * ✔ Verbose by default (use --quiet or --silent to suppress)
 * ✔ Supports --dry-run to preview without writing
 * ✔ Graceful per-file error handling; exits non-zero if any errors
 */

async function main() {
  // ─── CLI FLAGS ──────────────────────────────────────────────────────────────
  const args   = Bun.argv.slice(1);
  const dryRun = args.includes("--dry")    || args.includes("--dry-run");
  const quiet  = args.includes("--quiet")  || args.includes("--silent");
  const help   = args.includes("-h")       || args.includes("--help");

  if (help) {
    console.log(`
Usage: bump-versions.js [options]

Options:
  --dry-run, --dry      Preview version bumps without writing
  --quiet, --silent     Suppress all output
  -h, --help            Show this help
`);
    Bun.exit(0);
  }

  const log   = (...m) => { if (!quiet) console.log(...m) };
  const error = (...m) => console.error(...m);
  const debug = (...m) => { if (!quiet) console.debug(...m) };

  log("▶ bump-versions: starting");

  // ─── PROJECT ROOT ────────────────────────────────────────────────────────────
  // Script lives in scripts/, so root is one level up
  const rootUrl  = new URL("../", import.meta.url);
  const rootPath = Bun.fileURLToPath(rootUrl);

  // ─── FIND ALL package.json ───────────────────────────────────────────────────
  const glob = new Bun.Glob("**/package.json");
  const pkgFiles = [];

  for await (const relPath of glob.scan({ cwd: rootPath, absolute: false, onlyFiles: true })) {
    // Skip vendor and git metadata
    if (relPath.includes("/node_modules/") || relPath.includes("/.git/")) continue;
    pkgFiles.push(relPath);
  }

  if (pkgFiles.length === 0) {
    log("⚠ No package.json files found");
    Bun.exit(0);
  }

  // ─── BUMP VERSIONS ────────────────────────────────────────────────────────────
  let total = 0, bumped = 0, errorsCount = 0;

  for (const relPath of pkgFiles) {
    total++;
    const absPath = `${rootPath}/${relPath}`;
    log(`→ [${total}/${pkgFiles.length}] ${relPath}`);

    // Read file
    let text;
    try {
      text = await Bun.file(absPath).text();
    } catch (err) {
      error(`❌ Read failed: ${relPath} -- ${err.message}`);
      errorsCount++;
      continue;
    }

    // Parse JSON
    let pkg;
    try {
      pkg = JSON.parse(text);
    } catch (err) {
      error(`❌ JSON parse error: ${relPath} -- ${err.message}`);
      errorsCount++;
      continue;
    }

    // Validate version field
    const v = pkg.version;
    if (typeof v !== "string") {
      debug(`   ↪ no version field, skipping`);
      continue;
    }

    const parts = v.split(".");
    if (parts.length < 3 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[2])) {
      debug(`   ↪ version not X.Y.Z semver, skipping: ${v}`);
      continue;
    }

    // Compute new version
    const patch = parseInt(parts[2], 10) + 1;
    const newVersion = `${parts[0]}.${parts[1]}.${patch}`;

    if (newVersion === v) {
      debug(`   ↪ already ${newVersion}, skipping`);
      continue;
    }

    log(`   ✓ ${v} → ${newVersion}`);
    pkg.version = newVersion;

    // Stringify & write
    const newText = JSON.stringify(pkg, null, 2) + "\n";
    if (dryRun) {
      debug(`   (dry-run) would write updated version`);
      bumped++;
    } else {
      try {
        await Bun.write(absPath, newText);
        bumped++;
      } catch (err) {
        error(`❌ Write failed: ${relPath} -- ${err.message}`);
        errorsCount++;
      }
    }
  }

  // ─── SUMMARY & EXIT ──────────────────────────────────────────────────────────
  log(`\n✔ bump-versions: done. total=${total}, bumped=${bumped}, errors=${errorsCount}`);
  if (errorsCount > 0) Bun.exit(1);
}

main().catch(err => {
  console.error("‼ bump-versions crashed:", err);
  Bun.exit(1);
});