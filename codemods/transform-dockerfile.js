#!/usr/bin/env bun

/**
 * transform-dockerfile.js
 *
 * - Scans all Dockerfile and Dockerfile.multi under the repo via Bun.Glob
 * - CLI flags:
 *     --dry-run    Preview changes without writing
 *     --quiet      Suppress logs
 *     --silent     Alias for --quiet
 *     -h, --help   Show this help
 * - Idempotent: skips files containing "# bun: dockerfile-updated"
 * - Uses dockerfile-ast for precise parsing & byte-range edits
 * - Fully async I/O: Bun.file().text(), Bun.write()
 * - Per-file error handling; summary at end
 * - Uses Bun.exit on fatal
 */

import { Glob } from "bun";
import path from "path";
import { DockerfileParser } from "dockerfile-ast";

async function main() {
  const args   = Bun.argv.slice(1);
  const dryRun = args.includes("--dry")    || args.includes("--dry-run");
  const quiet  = args.includes("--quiet")  || args.includes("--silent");
  const help   = args.includes("-h")       || args.includes("--help");

  if (help) {
    console.log(`
Usage: transform-dockerfile.js [options]

Options:
  --dry-run, --dry      Preview changes without writing
  --quiet, --silent     Suppress all output
  -h, --help            Show this help
`);
    Bun.exit(0);
  }

  const log   = (...m) => { if (!quiet) console.log(...m) };
  const debug = (...m) => { if (!quiet) console.debug(...m) };
  const error = (...m) => console.error(...m);

  log("▶ transform-dockerfile: starting", dryRun ? "(dry-run)" : "");

  const MARKER    = "# bun: dockerfile-updated";
  // Patterns relative to repo root
  const PATTERNS  = ["**/Dockerfile", "**/Dockerfile.multi"];

  // Determine repo root (LibreChat-main) relative to this script
  const rootUrl = new URL("../../LibreChat-main", import.meta.url);
  const root    = Bun.fileURLToPath(rootUrl);

  // Discover files
  const files = new Set();
  for (const pat of PATTERNS) {
    const glob = new Glob(pat);
    for await (const rel of glob.scan({ cwd: root, absolute: false, onlyFiles: true })) {
      files.add(rel);
    }
  }

  let processed = 0, failed = 0;
  for (const rel of files) {
    processed++;
    const absPath = path.join(root, rel);
    log(`\n→ ${rel}`);

    let src;
    try {
      src = await Bun.file(absPath).text();
    } catch (err) {
      error("  ❌ read failed:", err.message);
      failed++;
      continue;
    }

    // Skip if already updated
    if (src.includes(MARKER)) {
      log("  ↪ already transformed");
      continue;
    }

    let parser, edits = [];
    try {
      parser = DockerfileParser.parse(src);
      const instructions = parser.getInstructions();

      for (const inst of instructions) {
        const keyword = inst.getKeyword().toUpperCase();

        if (keyword === "FROM") {
          const args = inst.getArguments();
          if (args.length) {
            const [arg] = args;
            const current = arg.getValue();
            const target  = "oven/bun:edge-alpine";
            if (current !== target) {
              const [start, end] = arg.getRange();
              edits.push({ start, end, text: target });
              debug(`  FROM ${current} → ${target}`);
            }
          }
        }

        else if (keyword === "RUN") {
          const args = inst.getArguments();
          if (args.length) {
            const start = args[0].getRange()[0];
            const end   = args[args.length - 1].getRange()[1];
            const raw   = src.slice(start, end);
            const replaced = raw
              .replace(/\bnpm install\b/g, "bun install")
              .replace(/\bnpm run\b/g,     "bun run")
              .replace(/\byarn install\b/g,"bun install")
              .replace(/\bnode\b/g,        "bun");
            if (replaced !== raw) {
              edits.push({ start, end, text: replaced });
              debug("  RUN command rewritten");
            }
          }
        }

        else if (keyword === "CMD" || keyword === "ENTRYPOINT") {
          const args = inst.getArguments();
          if (args.length) {
            const start = args[0].getRange()[0];
            const end   = args[args.length - 1].getRange()[1];
            const raw   = src.slice(start, end);
            const replaced = raw.replace(/\bnode\b/g, "bun");
            if (replaced !== raw) {
              edits.push({ start, end, text: replaced });
              debug(`  ${keyword} rewritten`);
            }
          }
        }
      }
    } catch (err) {
      error("  ❌ parse failed:", err.message);
      failed++;
      continue;
    }

    if (edits.length === 0) {
      log("  ↪ no changes");
      continue;
    }

    // Apply edits in reverse order
    let newSrc = src;
    edits.sort((a, b) => b.start - a.start).forEach(({ start, end, text }) => {
      newSrc = newSrc.slice(0, start) + text + newSrc.slice(end);
    });

    // Prefix marker
    newSrc = MARKER + "\n" + newSrc;

    if (dryRun) {
      log("  (dry-run) changes detected");
    } else {
      try {
        await Bun.write(absPath, newSrc);
        log("  ✔ written");
      } catch (err) {
        error("  ❌ write failed:", err.message);
        failed++;
      }
    }
  }

  log(`\n✔ transform-dockerfile: processed=${processed}, failed=${failed}`);
  if (failed) Bun.exit(1);
}

main().catch(err => {
  console.error("‼ transform-dockerfile crashed:", err);
  Bun.exit(1);
});