#!/usr/bin/env bun

/**
 * transform-package-json.js
 *
 * - Scans for all package.json files via Bun.Glob("\*\*\/package.json")
 * - CLI flags:
 *     --dry-run, --dry        Preview changes without writing
 *     --quiet, --silent       Suppress all output
 *     -h, --help              Show this help
 * - Idempotent via top-level `_bunUpdated: true` marker in JSON
 * - Removes legacy Node/Express dependencies
 * - Ensures:
 *     • type = "module"
 *     • engines.bun = ">=1.2.10"
 *     • engines.elysia = ">=1.2.25"
 *     • scripts.dev = "bun run dev"
 *     • scripts.test = "bun test"
 *     • scripts.build = "bun build"
 *     • dependencies.elysia = ">=1.2.25"
 * - Reorders dependencies: prioritized Elysia packages first, then alphabetically
 * - Only writes when actual modifications occurred
 * - Per-file try/catch; summary at end; exits non-zero on any failure
 */

import { Glob } from "bun";
import path from "path";

const REMOVE = [
  "express", "express-async-handler", "body-parser", "cookie-parser",
  "cors", "dotenv", "morgan", "helmet", "express-session", "passport",
  "passport-local", "mongoose", "connect-mongo", "redis", "socket.io"
];

const PRIORITIZED = [
  "elysia",
  "@elysiajs/static", "@elysiajs/cors", "@elysiajs/compression",
  "@elysiajs/cookie", "@elysiajs/helmet", "@elysiajs/logger",
  "@elysiajs/rate-limit", "@elysiajs/session", "@elysiajs/ws",
  "@elysiajs/swagger", "@elysiajs/opentelemetry", "@elysiajs/bearer",
  "@elysiajs/jwt", "@elysiajs/server-timing", "@elysiajs/cron",
  "@elysiajs/stream", "@elysiajs/trpc", "@elysiajs/graphql-yoga",
  "@elysiajs/graphql-apollo", "@elysiajs/html"
];

function reorderDeps(block = {}) {
  const ordered = {};
  const seen = new Set();

  for (const name of PRIORITIZED) {
    if (name in block) {
      ordered[name] = block[name];
      seen.add(name);
    }
  }
  for (const name of Object.keys(block).sort()) {
    if (!seen.has(name)) {
      ordered[name] = block[name];
    }
  }
  return ordered;
}

async function main() {
  const args   = Bun.argv.slice(1);
  const dryRun = args.includes("--dry-run") || args.includes("--dry");
  const quiet  = args.includes("--quiet")  || args.includes("--silent");
  const help   = args.includes("-h")       || args.includes("--help");

  if (help) {
    console.log(`
Usage: transform-package-json.js [options]

Options:
  --dry-run, --dry        Preview changes without writing
  --quiet, --silent       Suppress output
  -h, --help              Show this help
`);
    Bun.exit(0);
  }

  const log   = (...msg) => { if (!quiet) console.log(...msg); };
  const error = (...msg) => console.error(...msg);

  log("▶ transform-package-json: starting", dryRun ? "(dry-run)" : "");

  // Repo root (LibreChat-main) relative to this script
  const rootUrl = new URL("../../LibreChat-main", import.meta.url);
  const root    = Bun.fileURLToPath(rootUrl);

  const glob = new Glob("**/package.json");
  let processed = 0, failed = 0;

  for await (const rel of glob.scan({ cwd: root, absolute: false, onlyFiles: true })) {
    processed++;
    const filePath = path.join(root, rel);
    log(`\n→ ${rel}`);

    let src;
    try {
      src = await Bun.file(filePath).text();
    } catch (err) {
      error("  ❌ read failed:", err.message);
      failed++;
      continue;
    }

    let pkg;
    try {
      pkg = JSON.parse(src);
    } catch (err) {
      error("  ❌ JSON parse failed:", err.message);
      failed++;
      continue;
    }

    // Idempotence: skip if already updated
    if (pkg._bunUpdated) {
      log("  ↪ already transformed");
      continue;
    }

    let modified = false;

    // Remove legacy dependencies
    for (const dep of REMOVE) {
      if (pkg.dependencies?.[dep]) {
        delete pkg.dependencies[dep];
        modified = true;
        log(`  ✓ removed dependency "${dep}"`);
      }
      if (pkg.devDependencies?.[dep]) {
        delete pkg.devDependencies[dep];
        modified = true;
        log(`  ✓ removed devDependency "${dep}"`);
      }
    }
    if (pkg.dependencies && Object.keys(pkg.dependencies).length === 0) {
      delete pkg.dependencies;
      modified = true;
      log("  ✓ removed empty dependencies block");
    }
    if (pkg.devDependencies && Object.keys(pkg.devDependencies).length === 0) {
      delete pkg.devDependencies;
      modified = true;
      log("  ✓ removed empty devDependencies block");
    }

    // Ensure module type
    if (pkg.type !== "module") {
      pkg.type = "module";
      modified = true;
      log('  ✓ set "type" to "module"');
    }

    // Ensure engines
    pkg.engines = pkg.engines || {};
    if (pkg.engines.bun !== ">=1.2.10") {
      pkg.engines.bun = ">=1.2.10";
      modified = true;
      log('  ✓ set engines.bun = ">=1.2.10"');
    }
    if (pkg.engines.elysia !== ">=1.2.25") {
      pkg.engines.elysia = ">=1.2.25";
      modified = true;
      log('  ✓ set engines.elysia = ">=1.2.25"');
    }

    // Ensure scripts
    pkg.scripts = pkg.scripts || {};
    if (!pkg.scripts.dev) {
      pkg.scripts.dev = "bun run dev";
      modified = true;
      log('  ✓ added script "dev": "bun run dev"');
    }
    if (!pkg.scripts.test) {
      pkg.scripts.test = "bun test";
      modified = true;
      log('  ✓ added script "test": "bun test"');
    }
    if (!pkg.scripts.build) {
      pkg.scripts.build = "bun build";
      modified = true;
      log('  ✓ added script "build": "bun build"');
    }

    // Ensure core dependency
    pkg.dependencies = pkg.dependencies || {};
    if (!pkg.dependencies.elysia) {
      pkg.dependencies.elysia = ">=1.2.25";
      modified = true;
      log('  ✓ added dependency "elysia": ">=1.2.25"');
    }

    // Reorder dependencies
    if (pkg.dependencies) {
      const before = JSON.stringify(pkg.dependencies);
      pkg.dependencies = reorderDeps(pkg.dependencies);
      if (JSON.stringify(pkg.dependencies) !== before) {
        modified = true;
        log("  ✓ reordered dependencies");
      }
    }
    if (pkg.devDependencies) {
      const beforeDev = JSON.stringify(pkg.devDependencies);
      pkg.devDependencies = reorderDeps(pkg.devDependencies);
      if (JSON.stringify(pkg.devDependencies) !== beforeDev) {
        modified = true;
        log("  ✓ reordered devDependencies");
      }
    }

    // Set idempotence marker
    if (modified) {
      pkg._bunUpdated = true;
      log("  ✓ set _bunUpdated = true");
    }

    if (!modified) {
      log("  ↪ no changes");
      continue;
    }

    const out = JSON.stringify(pkg, null, 2) + "\n";
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

  log(`\n✔ transform-package-json: processed=${processed}, failed=${failed}`);
  if (failed) Bun.exit(1);
}

main().catch(err => {
  console.error("‼ transform-package-json crashed:", err);
  Bun.exit(1);
});