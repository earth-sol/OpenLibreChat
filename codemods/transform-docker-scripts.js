#!/usr/bin/env bun

/**
 * transform-docker-scripts.js
 *
 * - Scans all shell scripts under utils/docker via Bun.Glob
 * - CLI flags:
 *     --dry-run    Preview changes without writing
 *     --quiet      Suppress logs
 *     --silent     Alias for --quiet
 *     -h, --help   Show this help
 * - Idempotent: skips files containing "# bun: docker-scripts-updated"
 * - Preserves shebang; injects BUN_BASE_IMAGE; replaces npm/yarn → bun;
 *   injects --build-arg BUN_BASE_IMAGE into docker build commands;
 *   re-applies exec bit
 * - Fully async I/O and Bun.exit on fatal
 */

import { Glob } from "bun";
import path from "path";

async function main() {
  const args   = Bun.argv.slice(1);
  const dryRun = args.includes("--dry")    || args.includes("--dry-run");
  const quiet  = args.includes("--quiet")  || args.includes("--silent");
  const help   = args.includes("-h")       || args.includes("--help");

  if (help) {
    console.log(`
Usage: transform-docker-scripts.js [options]

Options:
  --dry-run, --dry      Preview changes without writing
  --quiet, --silent     Suppress all output
  -h, --help            Show this help
`);
    Bun.exit(0);
  }

  const log    = (...m) => { if (!quiet) console.log(...m) };
  const debug  = (...m) => { if (!quiet) console.debug(...m) };
  const error  = (...m) => console.error(...m);

  log("▶ transform-docker-scripts: starting", dryRun ? "(dry-run)" : "");

  const SHELL_GLOB    = "utils/docker/*.sh";
  const MARKER        = "# bun: docker-scripts-updated";
  const DEFAULT_BASE  = "oven/bun:latest";
  const BASE_VAR      = "BUN_BASE_IMAGE";

  // Regex replacements for npm/yarn → bun
  const REPLACEMENTS = [
    { regex: /\bnpm install\b/g,     repl: "bun install" },
    { regex: /\bnpm run\b/g,         repl: "bun run" },
    { regex: /\byarn install\b/g,    repl: "bun install" },
    { regex: /\bnode\b/g,            repl: "bun" }
  ];

  let processed = 0, failed = 0;
  for await (const rel of new Glob(SHELL_GLOB).scan({ onlyFiles: true })) {
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

    // Skip if already updated
    if (src.includes(MARKER)) {
      log("  ↪ already transformed");
      continue;
    }

    // Split into lines for in-place edits
    let lines     = src.split("\n");
    let hasMod    = false;

    // 1) Shebang handling
    let shebangIdx = lines.findIndex(l => l.startsWith("#!"));
    if (shebangIdx === -1) {
      lines.unshift("#!/usr/bin/env bash");
      shebangIdx = 0;
      hasMod = true;
      debug("  ▶ inserted default shebang");
    }

    // 2) Inject marker
    lines.splice(shebangIdx + 1, 0, MARKER);
    hasMod = true;

    // 3) Inject BUN_BASE_IMAGE declaration if missing
    const fullText = lines.join("\n");
    if (!/\bBUN_BASE_IMAGE\b/.test(fullText)) {
      const baseImage = Bun.env.BUN_BASE_IMAGE || DEFAULT_BASE;
      const inject = [
        `: "\${${BASE_VAR}:=${baseImage}}"`,
        `export ${BASE_VAR}`
      ];
      lines.splice(shebangIdx + 2, 0, ...inject);
      hasMod = true;
      log("  ✓ injected BUN_BASE_IMAGE declaration");
    }

    // 4) Command replacements
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

    // 5) Inject build-arg into docker build commands
    lines = lines.map(line => {
      if (/^\s*docker build\b/.test(line) && !/--build-arg\s+BUN_BASE_IMAGE/.test(line)) {
        hasMod = true;
        log("  ↗ injected --build-arg into docker build");
        return line.replace(
          /(docker build\b)/,
          `$1 --build-arg ${BASE_VAR}=\$${BASE_VAR}`
        );
      }
      return line;
    });

    // 6) Write or preview
    const output = lines.join("\n");
    if (!hasMod) {
      log("  ↪ no changes");
      continue;
    }
    if (dryRun) {
      log("  (dry-run) changes detected");
    } else {
      try {
        await Bun.write(filePath, output);
        // Re-apply exec bit
        Bun.spawnSync({ cmd: ["chmod", "+x", filePath] });
        log("  ✔ written and exec bit ensured");
      } catch (err) {
        error("  ❌ write failed:", err.message);
        failed++;
      }
    }
  }

  log(`\n✔ done. processed=${processed}, failed=${failed}`);
  if (failed) Bun.exit(1);
}

main().catch(err => {
  console.error("‼ transform-docker-scripts crashed:", err);
  Bun.exit(1);
});