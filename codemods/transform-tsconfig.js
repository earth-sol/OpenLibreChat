#!/usr/bin/env bun

/**
 * transform-tsconfig.js
 *
 * - Ensures compilerOptions are configured for Bun & Elysia:
 *   module: "ESNext", target: "ESNext", moduleDetection: "force",
 *   jsx: "react-jsx", moduleResolution: "bundler",
 *   allowImportingTsExtensions: true, verbatimModuleSyntax: true,
 *   noEmit: true, importsNotUsedAsValues: "preserve"
 * - Migrates any compilerOptions.paths → top-level imports (import map)
 * - Uses Bun.Glob for native file discovery
 * - Uses Bun.file().text() and Bun.write() for I/O
 * - Verbose by default; suppress with --quiet or --silent
 * - Supports --dry-run to preview without writing
 * - Idempotent and fails gracefully per-file
 */

async function main() {
  // CLI flags
  const args   = Bun.argv.slice(1);
  const dryRun = args.includes("--dry")    || args.includes("--dry-run");
  const quiet  = args.includes("--quiet")  || args.includes("--silent");
  const help   = args.includes("-h")       || args.includes("--help");
  if (help) {
    console.log(`
Usage: transform-tsconfig.js [options]

Options:
  --dry-run, --dry      Preview changes without writing files
  --quiet, --silent     Suppress all output
  -h, --help            Show this help
`);
    Bun.exit(0);
  }

  const log   = (...m) => { if (!quiet) console.log(...m) };
  const error = (...m) => console.error(...m);

  log("▶ transform-tsconfig: starting");

  // Discover all tsconfig*.json files under the repo
  const glob = new Bun.Glob("**/tsconfig*.json");
  let processed = 0, failed = 0;

  for await (const relPath of glob.scan({ cwd: ".", absolute: false, onlyFiles: true })) {
    // Skip node_modules
    if (relPath.includes("node_modules/")) continue;

    processed++;
    log(`\n→ ${relPath}`);

    // Read
    let text;
    try {
      text = await Bun.file(relPath).text();
    } catch (err) {
      error(`  ❌ failed to read: ${err.message}`);
      failed++;
      continue;
    }

    // Parse JSON
    let cfg;
    try {
      cfg = JSON.parse(text);
    } catch (err) {
      error(`  ❌ JSON parse error: ${err.message}`);
      failed++;
      continue;
    }

    // Prepare flags
    const co = cfg.compilerOptions = cfg.compilerOptions || {};
    let changed = false;

    // Ensure compilerOptions
    const ensure = (key, value) => {
      if (co[key] !== value) {
        co[key] = value;
        log(`   ✓ set compilerOptions.${key} = ${JSON.stringify(value)}`);
        changed = true;
      }
    };

    ensure("module", "ESNext");
    ensure("target", "ESNext");
    ensure("moduleDetection", "force");
    ensure("jsx", "react-jsx");
    ensure("moduleResolution", "bundler");
    ensure("allowImportingTsExtensions", true);
    ensure("verbatimModuleSyntax", true);
    ensure("noEmit", true);
    ensure("importsNotUsedAsValues", "preserve");

    // Migrate paths → imports (import map)
    if (co.paths) {
      cfg.imports = cfg.imports || {};
      for (const [alias, targets] of Object.entries(co.paths)) {
        // Only string-array values
        if (Array.isArray(targets)) {
          cfg.imports[alias] = targets;
          log(`   ✓ migrated paths['${alias}'] → imports['${alias}']`);
        }
      }
      delete co.paths;
      changed = true;
    }

    // Idempotent: no-op if nothing changed
    if (!changed) {
      log("   ↪ no changes needed");
      continue;
    }

    // Stringify with 2-space indent
    const out = JSON.stringify(cfg, null, 2) + "\n";

    if (dryRun) {
      log("   (dry-run) would write changes");
    } else {
      try {
        await Bun.write(relPath, out);
        log("   ✔ written");
      } catch (err) {
        error(`  ❌ write failed: ${err.message}`);
        failed++;
      }
    }
  }

  log(`\n✔ transform-tsconfig: processed=${processed}, failed=${failed}`);
  if (failed) Bun.exit(1);
}

main().catch(err => {
  console.error("‼ transform-tsconfig crashed:", err);
  Bun.exit(1);
});