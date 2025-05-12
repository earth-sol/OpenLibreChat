#!/usr/bin/env bun

/**
 * transform-husky.js
 *
 * - Scans all Husky hook scripts under the specified hooks directory via Bun.Glob
 * - CLI flags:
 *     --hooks-dir=DIR    Path to hooks folder (default: ".husky")
 *     --dry-run, -n      Preview changes without writing files
 *     --quiet, --silent  Suppress all output
 *     -h, --help         Show this help
 * - Idempotent: skips files containing "# bun: husky-updated"
 * - Preserves shebang; injects marker; replaces npm/yarn → bun; re-applies exec bit
 * - Fully async I/O and per-file error handling; summary at end
 */

import { Glob } from "bun";
import path from "path";

async function main() {
  const args    = Bun.argv.slice(1);
  const hooksDir= args.find(a => a.startsWith("--hooks-dir="))?.split("=")[1] || ".husky";
  const dryRun  = args.includes("--dry-run") || args.includes("-n");
  const quiet   = args.includes("--quiet")  || args.includes("--silent");
  const help    = args.includes("-h")       || args.includes("--help");

  if (help) {
    console.log(`
Usage: transform-husky.js [options]

Options:
  --hooks-dir=DIR      Path to Husky hooks folder (default: ".husky")
  --dry-run, -n        Preview changes without writing files
  --quiet, --silent    Suppress all output
  -h, --help           Show this help
`);
    Bun.exit(0);
  }

  const log   = (...m) => { if (!quiet) console.log(...m) };
  const debug = (...m) => { if (!quiet) console.debug(...m) };
  const error = (...m) => console.error(...m);

  log("▶ transform-husky: starting", dryRun ? "(dry-run)" : "");

  const MARKER      = "# bun: husky-updated";
  const PATTERN     = `${hooksDir}/**/*`;
  const REPLACEMENTS = [
    { regex: /\byarn(?:\s+run)?\s+(\S+)/g, repl: "bun run $1" },
    { regex: /\bnpm\s+run\s+(\S+)/g,       repl: "bun run $1" },
    { regex: /\byarn\b/g,                  repl: "bun" },
    { regex: /\bnpm\b/g,                   repl: "bun" },
    { regex: /\bnpx\b/g,                   repl: "bunx" },
    { regex: /\bbun run test\b/g,          repl: "bun test" },
    { regex: /\bbun run build\b/g,         repl: "bun build" }
  ];

  let processed = 0, failed = 0;
  for await (const rel of new Glob(PATTERN).scan({ onlyFiles: true })) {
    processed++;
    const filePath = path.resolve(rel);
    log(`\n→ ${rel}`);

    let src;
    try {
      src = await Bun.file(filePath).text();
    } catch (err) {
      error("  ❌ read failed:", err.message);
      failed++;
      continue;
    }

    if (src.includes(MARKER)) {
      log("  ↪ already transformed");
      continue;
    }

    let lines = src.split("\n");
    let hasMod = false;

    // 1) Shebang detection/insertion
    let shebangIdx = lines.findIndex(l => l.startsWith("#!"));
    if (shebangIdx === -1) {
      lines.unshift("#!/usr/bin/env bash");
      shebangIdx = 0;
      hasMod = true;
      debug("  ▶ inserted default shebang");
    }

    // 2) Insert marker after shebang
    lines.splice(shebangIdx + 1, 0, MARKER);
    hasMod = true;

    // 3) Command replacements
    lines = lines.map(line => {
      let updated = line;
      for (const { regex, repl } of REPLACEMENTS) {
        if (regex.test(updated)) {
          updated = updated.replace(regex, repl);
          hasMod = true;
          debug(`  🔄 replaced in line: ${regex}`);
        }
      }
      return updated;
    });

    // 4) If no modifications, skip
    if (!hasMod) {
      log("  ↪ no changes");
      continue;
    }

    const output = lines.join("\n");

    // 5) Dry-run preview
    if (dryRun) {
      log("  (dry-run) changes detected");
      continue;
    }

    // 6) Write and reapply exec bit
    try {
      await Bun.write(filePath, output);
      Bun.spawnSync({ cmd: ["chmod", "+x", filePath] });
      log("  ✔ written and exec bit ensured");
    } catch (err) {
      error("  ❌ write failed:", err.message);
      failed++;
    }
  }

  log(`\n✔ transform-husky: processed=${processed}, failed=${failed}`);
  if (failed) Bun.exit(1);
}

main().catch(err => {
  console.error("‼ transform-husky crashed:", err);
  Bun.exit(1);
});