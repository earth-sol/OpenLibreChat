#!/usr/bin/env bun

/**
 * transform-devcontainer.js
 *
 * - Scans `.devcontainer/devcontainer.json` via Bun.Glob
 * - Ensures:
 *    • `forwardPorts` includes [3080, 3090]
 *    • `postCreateCommand` is "bun install"
 *    • `customizations.vscode.extensions` contains "ms-vscode.vscode-typescript-tslint-plugin"
 * - Idempotent: skips files already marked
 * - CLI flags:
 *     --dry-run    preview without writing
 *     --quiet      suppress logs
 *     --silent     alias for --quiet
 *     -h, --help   show this help
 * - Uses Bun.Core for I/O and Glob; uses Bun.exit on failure
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
Usage: transform-devcontainer.js [options]

Options:
  --dry-run, --dry      Preview changes without writing
  --quiet, --silent     Suppress all output
  -h, --help            Show this help
`);
    Bun.exit(0);
  }

  const log   = (...m) => { if (!quiet) console.log(...m) };
  const error = (...m) => console.error(...m);

  log("▶ transform-devcontainer: starting");

  // Marker for idempotence
  const marker = "bun: devcontainer-updated";

  // Locate .devcontainer folder under LibreChat-main
  const rootUrl = new URL("../../LibreChat-main/.devcontainer", import.meta.url);
  const devcRoot = Bun.fileURLToPath(rootUrl);

  // Find all devcontainer.json files
  const glob = new Glob("devcontainer.json");
  let processed = 0, failed = 0;

  for await (const rel of glob.scan({ cwd: devcRoot, absolute: false, onlyFiles: true })) {
    processed++;
    const filePath = path.join(devcRoot, rel);
    log(`\n→ ${path.relative(devcRoot, filePath)}`);

    let src;
    try {
      src = await Bun.file(filePath).text();
    } catch (err) {
      error("  ❌ read failed:", err.message);
      failed++;
      continue;
    }

    // Skip if already transformed
    if (src.includes(marker)) {
      log("  ↪ already transformed (marker found)");
      continue;
    }

    let cfg;
    try {
      cfg = JSON.parse(src);
    } catch (err) {
      error("  ❌ JSON parse failed:", err.message);
      failed++;
      continue;
    }

    let changed = false;

    // Ensure forwardPorts
    cfg.forwardPorts = Array.isArray(cfg.forwardPorts) ? cfg.forwardPorts : [];
    [3080, 3090].forEach(port => {
      if (!cfg.forwardPorts.includes(port)) {
        cfg.forwardPorts.push(port);
        changed = true;
        log(`   ✓ added forwardPort ${port}`);
      }
    });

    // Ensure postCreateCommand
    if (cfg.postCreateCommand !== "bun install") {
      cfg.postCreateCommand = "bun install";
      changed = true;
      log(`   ✓ set postCreateCommand to "bun install"`);
    }

    // Ensure customizations.vscode.extensions
    cfg.customizations = cfg.customizations || {};
    cfg.customizations.vscode = cfg.customizations.vscode || {};
    cfg.customizations.vscode.extensions = Array.isArray(cfg.customizations.vscode.extensions)
      ? cfg.customizations.vscode.extensions
      : [];
    const ext = "ms-vscode.vscode-typescript-tslint-plugin";
    if (!cfg.customizations.vscode.extensions.includes(ext)) {
      cfg.customizations.vscode.extensions.push(ext);
      changed = true;
      log(`   ✓ added VSCode extension ${ext}`);
    }

    if (!changed) {
      log("  ↪ no changes needed");
      continue;
    }

    // Serialize with marker at top
    const out = `/* ${marker} */\n` +
      JSON.stringify(cfg, null, 2) + "\n";

    if (dryRun) {
      log("  (dry-run) changes detected");
    } else {
      try {
        await Bun.write(filePath, out);
        log("  ✔ written");
      } catch (err) {
        error("  ❌ write failed:", err.message);
        failed++;
      }
    }
  }

  log(`\n✔ transform-devcontainer: processed=${processed}, failed=${failed}`);
  if (failed) Bun.exit(1);
}

main().catch(err => {
  console.error("‼ transform-devcontainer crashed:", err);
  Bun.exit(1);
});