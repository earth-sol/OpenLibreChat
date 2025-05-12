#!/usr/bin/env bun

/**
 * transform-ci-config.js
 *
 * - Scans .github/workflows/\*\*\/\*.yml/.yaml
 * - Swaps actions/setup-node → oven-sh/setup-bun@v1
 * - Rewrites npm commands in run: blocks to Bun equivalents
 * - Uses Bun.Glob for discovery and Bun.file()/Bun.write() for I/O
 * - Supports --dry-run and --quiet
 * - Graceful per-file error handling
 */

import { Glob } from "bun";
import path from "path";
import YAML from "yaml";

// ─── CLI FLAGS ────────────────────────────────────────────────────────────────
const args    = Bun.argv.slice(1);
const dryRun  = args.includes("--dry")    || args.includes("--dry-run");
const quiet   = args.includes("--quiet")  || args.includes("--silent");
const help    = args.includes("-h")       || args.includes("--help");
if (help) {
  console.log(`
Usage: transform-ci-config.js [options]

Options:
  --dry-run, --dry        Preview without writing changes
  --quiet, --silent       Suppress debug logs
  -h, --help              Show this help
`);
  Bun.exit(0);
}
const log   = (...m) => { if (!quiet) console.log(...m) };
const debug = (...m) => { if (!quiet) console.debug(...m) };
const error = (...m) => console.error(...m);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function transformRunLine(line) {
  const indentMatch = line.match(/^(\s*)/);
  const indent      = indentMatch ? indentMatch[1] : "";
  const trimmed     = line.trimStart();

  if (!trimmed.startsWith("npm")) return line;

  const parts = trimmed.split(/\s+/);
  let newCmd = trimmed;

  if (parts[1] === "ci" || parts[1] === "install") {
    newCmd = trimmed.replace(/^npm\s+(ci|install)\b/, "bun install");
  } else if (parts[1] === "run" && parts[2] === "build") {
    newCmd = trimmed.replace(/^npm\s+run\s+build\b/, "bun build");
  } else {
    newCmd = trimmed.replace(/^npm\b/, "bun");
  }

  debug(`    run-line: "${trimmed}" → "${newCmd}"`);
  return indent + newCmd;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  log("▶ transform-ci-config: starting", dryRun ? "(dry-run)" : "");

  // workflows live under LibreChat-main/.github/workflows
  const codeRoot = Bun.fileURLToPath(new URL("../../LibreChat-main", import.meta.url));
  const pattern  = ".github/workflows/**/*.{yml,yaml}";

  const glob = new Glob(pattern);
  let processed = 0, failed = 0;

  for await (const relFile of glob.scan({ cwd: codeRoot, absolute: false, onlyFiles: true })) {
    processed++;
    const absFile = path.join(codeRoot, relFile);
    log(`\n→ ${relFile}`);

    try {
      const text = await Bun.file(absFile).text();
      const doc  = YAML.parseDocument(text, {
        keepCstNodes: true,
        keepNodeTypes: true
      });
      let modified = false;

      const root = doc.contents;
      if (root && root.items) {
        // Locate jobs
        const jobsPair = root.items.find(p => p.key?.value === "jobs");
        if (jobsPair && jobsPair.value?.items) {
          for (const jobPair of jobsPair.value.items) {
            const jobName   = jobPair.key.value;
            const jobMap    = jobPair.value;
            const stepsPair = jobMap.items.find(p => p.key?.value === "steps");
            if (!stepsPair || !stepsPair.value?.items) continue;

            stepsPair.value.items.forEach((stepItem, idx) => {
              if (stepItem.type !== "MAP") return;

              stepItem.items.forEach(prop => {
                // 1) actions/setup-node → oven-sh/setup-bun@v1
                if (
                  prop.key.value === "uses" &&
                  typeof prop.value.value === "string" &&
                  prop.value.value.startsWith("actions/setup-node")
                ) {
                  const old = prop.value.value;
                  prop.value.value = "oven-sh/setup-bun@v1";
                  debug(`  [${jobName}][step ${idx}] uses: "${old}" → "${prop.value.value}"`);
                  modified = true;
                }

                // 2) npm → bun in run:
                if (
                  prop.key.value === "run" &&
                  typeof prop.value.value === "string"
                ) {
                  const orig = prop.value.value;
                  const transformed = orig
                    .split("\n")
                    .map(transformRunLine)
                    .join("\n");
                  if (transformed !== orig) {
                    prop.value.value = transformed;
                    debug(`  [${jobName}][step ${idx}] updated run block`);
                    modified = true;
                  }
                }
              });
            });
          }
        }
      }

      if (modified) {
        if (dryRun) {
          log("  (dry-run) changes detected");
        } else {
          await Bun.write(absFile, String(doc));
          log("  ✔ written");
        }
      } else {
        log("  ⚪ no changes");
      }
    } catch (err) {
      error(`  ❌ failed to process:`, err.message);
      failed++;
    }
  }

  log(`\n✔ transform-ci-config: processed=${processed}, failed=${failed}`);
  if (failed) Bun.exit(1);
}

main().catch(err => {
  console.error("‼ transform-ci-config crashed:", err);
  Bun.exit(1);
});