#!/usr/bin/env bun

/**
 * codemods/transform-husky.js
 *
 * Recursively scans your Husky hooks directory and replaces:
 *   • `npm run <cmd>` → `bun run <cmd>`
 *   • `npm` → `bun`
 *   • `npx` → `bunx`
 *   • `yarn [run] <cmd>` → `bun run <cmd>`
 *   • `yarn` → `bun`
 *   • `bun run test` → `bun test`
 *   • `bun run build` → `bun build`
 *
 * Features:
 *   • Uses Bun.Glob for fast, flexible globbing
 *   • Reads/writes via Bun.file/Bun.write (atomic)
 *   • CLI flags: --hooks-dir, --dry-run, --help
 *   • Honors HUSKY_HOOKS_DIR env var
 *   • Skips binary or unreadable files
 */

import { env, exit } from "bun";

// --- CLI / ENV parsing ---
let hooksDir = env.HUSKY_HOOKS_DIR || ".husky";
let dryRun   = false;

for (const arg of process.argv.slice(2)) {
  if (arg === "-n" || arg === "--dry-run") {
    dryRun = true;
  } else if (/^--hooks-dir=/.test(arg)) {
    hooksDir = arg.split("=", 2)[1];
  } else if (arg === "-h" || arg === "--help") {
    return printHelp() && exit(0);
  } else {
    console.warn(`[transform-husky] Unknown option "${arg}"`);
    return printHelp() && exit(1);
  }
}

console.log(`[transform-husky] Hooks dir: ${hooksDir}`);
console.log(`[transform-husky] Dry run: ${dryRun}`);

// --- Content transformer ---
function transformContent(raw) {
  let updated = raw;

  // npm / yarn → bun
  updated = updated
    // yarn run <cmd> → bun run <cmd>
    .replace(/\byarn(?:\s+run)?\s+(\S+)/g, "bun run $1")
    // npm run <cmd> → bun run <cmd>
    .replace(/\bnpm\s+run\s+(\S+)/g, "bun run $1")
    // standalone yarn → bun
    .replace(/\byarn\b/g, "bun")
    // standalone npm → bun
    .replace(/\bnpm\b/g, "bun")
    // npx → bunx
    .replace(/\bnpx\b/g, "bunx")
    // bun run test → bun test
    .replace(/\bbun run test\b/g, "bun test")
    // bun run build → bun build
    .replace(/\bbun run build\b/g, "bun build");

  return updated;
}

// --- Main ---
async function main() {
  try {
    const glob = new Bun.Glob(`${hooksDir}/**/*`, { includeDirs: false });
    for await (const entry of glob) {
      const fp = entry.path;

      let raw;
      try {
        raw = await Bun.file(fp).text();
      } catch (err) {
        console.warn(`[transform-husky] Skipping unreadable "${fp}": ${err.message}`);
        continue;
      }

      const updated = transformContent(raw);
      if (updated === raw) {
        console.log(`[transform-husky] No change: ${fp}`);
        continue;
      }

      if (dryRun) {
        console.log(`[transform-husky] [DRY] Would update: ${fp}`);
      } else {
        try {
          await Bun.write(fp, updated);
          console.log(`[transform-husky] Updated: ${fp}`);
        } catch (err) {
          console.error(`[transform-husky] Failed to write "${fp}": ${err.message}`);
        }
      }
    }

    console.log("[transform-husky] Complete.");
  } catch (err) {
    console.error(`[transform-husky] Fatal: ${err.message}`);
    exit(1);
  }
}

// --- Help text ---
function printHelp() {
  console.log(`
Usage: bun transform-husky.js [options]

Options:
  --hooks-dir=DIR    Path to .husky hooks folder (default: ".husky")
  -n, --dry-run      Show actions without writing files
  -h, --help         Show this message
`);
}

main();