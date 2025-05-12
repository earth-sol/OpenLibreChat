#!/usr/bin/env bun

/**
 * transform-helm-values.js
 *
 * - Scans for Helm values.yaml files via Bun.Glob:
 *     charts/\*\*\/values.yaml
 * - CLI flags:
 *     --dry-run    Preview changes without writing
 *     --quiet      Suppress logs
 *     --silent     Alias for --quiet
 *     -h, --help   Show this help
 * - Idempotent: skips files containing "# bun: helm-values-updated"
 * - Ensures:
 *     • image.repository = Bun.env.IMAGE_REPO || "myregistry/librechat-bun"
 *     • image.tag        = Bun.env.IMAGE_TAG  || "latest"
 *     • service.port     = Number(Bun.env.SERVICE_PORT) || 3080
 *     • command          = ["bun","run","src/server/index.ts"]
 * - Uses Bun.Core for I/O & Glob; yaml for parsing/dumping
 * - Per-file try/catch, summary at end; uses Bun.exit on failure
 */

import { Glob } from "bun";
import path from "path";
import YAML from "yaml";

async function main() {
  const args   = Bun.argv.slice(1);
  const dryRun = args.includes("--dry")    || args.includes("--dry-run");
  const quiet  = args.includes("--quiet")  || args.includes("--silent");
  const help   = args.includes("-h")       || args.includes("--help");
  if (help) {
    console.log(`
Usage: transform-helm-values.js [options]

Options:
  --dry-run, --dry      Preview changes without writing
  --quiet, --silent     Suppress output
  -h, --help            Show this help
`);
    Bun.exit(0);
  }

  const log   = (...m) => { if (!quiet) console.log(...m) };
  const error = (...m) => console.error(...m);

  log("▶ transform-helm-values: starting", dryRun ? "(dry-run)" : "");

  const MARKER      = "# bun: helm-values-updated";
  const PATTERN     = "charts/**/values.yaml";
  const rootUrl     = new URL("../../LibreChat-main", import.meta.url);
  const rootPath    = Bun.fileURLToPath(rootUrl);

  const desiredRepo = Bun.env.IMAGE_REPO    || "myregistry/librechat-bun";
  const desiredTag  = Bun.env.IMAGE_TAG     || "latest";
  const desiredPort = Number(Bun.env.SERVICE_PORT) || 3080;
  const desiredCmd  = ["bun", "run", "src/server/index.ts"];

  let processed = 0, failed = 0;
  for await (const rel of new Glob(PATTERN).scan({ cwd: rootPath, onlyFiles: true })) {
    processed++;
    const filePath = path.join(rootPath, rel);
    log(`\n→ ${rel}`);

    let src;
    try {
      src = await Bun.file(filePath).text();
    } catch (err) {
      error("  ❌ read failed:", err.message);
      failed++;
      continue;
    }

    // Skip if already transformed
    if (src.includes(MARKER)) {
      log("  ↪ already transformed");
      continue;
    }

    let cfg;
    try {
      cfg = YAML.parse(src) || {};
    } catch (err) {
      error("  ❌ YAML parse failed:", err.message);
      failed++;
      continue;
    }

    let modified = false;

    // image.repository
    cfg.image = cfg.image || {};
    if (cfg.image.repository !== desiredRepo) {
      cfg.image.repository = desiredRepo;
      modified = true;
      log(`  ✓ set image.repository = "${desiredRepo}"`);
    }

    // image.tag
    if (cfg.image.tag !== desiredTag) {
      cfg.image.tag = desiredTag;
      modified = true;
      log(`  ✓ set image.tag = "${desiredTag}"`);
    }

    // service.port
    cfg.service = cfg.service || {};
    if (cfg.service.port !== desiredPort) {
      cfg.service.port = desiredPort;
      modified = true;
      log(`  ✓ set service.port = ${desiredPort}`);
    }

    // command
    if (
      !Array.isArray(cfg.command) ||
      JSON.stringify(cfg.command) !== JSON.stringify(desiredCmd)
    ) {
      cfg.command = desiredCmd;
      modified = true;
      log(`  ✓ set command = [${desiredCmd.map(c => `"${c}"`).join(", ")}]`);
    }

    if (!modified) {
      log("  ↪ no changes");
      continue;
    }

    // Serialize with marker
    const out = MARKER + "\n" + YAML.stringify(cfg, { lineWidth: -1 });

    if (dryRun) {
      log("  (dry-run) would write changes");
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

  log(`\n✔ transform-helm-values: processed=${processed}, failed=${failed}`);
  if (failed) Bun.exit(1);
}

main().catch(err => {
  console.error("‼ transform-helm-values crashed:", err);
  Bun.exit(1);
});