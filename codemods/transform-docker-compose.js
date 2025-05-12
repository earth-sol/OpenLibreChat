#!/usr/bin/env bun

/**
 * transform-docker-compose.js
 *
 * - Scans root for compose files via Bun.Glob:
 *     docker-compose.yml
 *     deploy-compose.yml
 *     docker-compose.override.yml
 *     docker-compose.override.yml.example
 *     rag.yml
 * - Fully async I/O: Bun.file().text(), Bun.file().copy(), Bun.write()
 * - CLI flags:
 *     --dry-run    Preview changes without writing
 *     --quiet      Suppress logs
 *     --silent     Alias for --quiet
 *     -h, --help   Show this help
 * - Idempotent: skips files containing "# bun: docker-compose-updated"
 * - Uses YAML for parsing/dumping, with a marker comment at top on write
 * - Plugins:
 *     imagePlugin, commandPlugin, envPlugin, healthPlugin
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
Usage: transform-docker-compose.js [options]

Options:
  --dry-run, --dry      Preview changes without writing
  --quiet, --silent     Suppress output
  -h, --help            Show this help
`);
    Bun.exit(0);
  }

  const log   = (...m) => { if (!quiet) console.log(...m) };
  const debug = (...m) => { if (!quiet) console.debug(...m) };
  const error = (...m) => console.error(...m);

  log("▶ transform-docker-compose: starting", dryRun ? "(dry-run)" : "");

  // Marker for idempotence
  const MARKER = "# bun: docker-compose-updated";

  // Project root (LibreChat-main)
  const rootUrl = new URL("../../LibreChat-main", import.meta.url);
  const root    = Bun.fileURLToPath(rootUrl);

  // Compose file patterns
  const PATTERNS = [
    "docker-compose.yml",
    "deploy-compose.yml",
    "docker-compose.override.yml",
    "docker-compose.override.yml.example",
    "rag.yml"
  ];

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
    log(`\n→ ${rel}`);
    const filePath = path.join(root, rel);

    // Read source
    let src;
    try {
      src = await Bun.file(filePath).text();
    } catch (err) {
      error("  ❌ read failed:", err.message);
      failed++;
      continue;
    }

    // Skip already transformed
    if (src.includes(MARKER)) {
      log("  ↪ already transformed");
      continue;
    }

    // Backup
    const bakPath = filePath + ".bak";
    try {
      if (!dryRun && !(await Bun.file(bakPath).exists())) {
        await Bun.file(filePath).copy(bakPath);
        debug("  backup created:", bakPath);
      }
    } catch (err) {
      error("  ⚠ backup failed:", err.message);
    }

    // Parse YAML
    let doc;
    try {
      doc = YAML.parse(src) || {};
    } catch (err) {
      error("  ❌ YAML parse failed:", err.message);
      failed++;
      continue;
    }

    // Apply plugins
    let changed = false;
    try {
      ({ doc, changed } = applyPlugins(doc, { debug, log }));
    } catch (err) {
      error("  ❌ plugin pipeline error:", err.message);
      failed++;
      continue;
    }

    if (!changed) {
      log("  ↪ no changes");
      continue;
    }

    // Generate output with marker
    const out = MARKER + "\n" + YAML.stringify(doc, { lineWidth: -1 });
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

  log(`\n✔ done. processed=${processed}, failed=${failed}`);
  if (failed) Bun.exit(1);
}

/**
 * Runs each plugin, returning { doc, changed }
 */
function applyPlugins(doc, { debug, log }) {
  let changed = false;
  const svcs = doc.services || {};

  // ─── imagePlugin ─────────────────────────────────────────────────────────────
  debug("imagePlugin running");
  for (const [name, svc] of Object.entries(svcs)) {
    if (typeof svc.image === "string" && svc.image.startsWith("ghcr.io/danny-avila/librechat")) {
      const tag = Bun.env.IMAGE_TAG ?? "latest";
      let repo;
      if (name === "api") repo = Bun.env.IMAGE_REPO ?? "myregistry/librechat-bun";
      else if (["rag_api", "rag-api"].includes(name))
        repo = Bun.env.RAG_IMAGE_REPO ?? "myregistry/librechat-rag-api-bun";
      if (repo) {
        debug(`  Rewriting image for ${name}: ${svc.image} → ${repo}:${tag}`);
        svc.image = `${repo}:${tag}`;
        if (!svc.build) {
          svc.build = {
            context: ".",
            dockerfile: name === "api" ? "Dockerfile" : "Dockerfile.multi"
          };
          debug(`  Added build config to ${name}`);
        }
        changed = true;
      }
    }
  }

  // ─── commandPlugin ────────────────────────────────────────────────────────────
  debug("commandPlugin running");
  const rewrite = str =>
    str.replace(/\bnpm install\b/g, "bun install")
       .replace(/\bnpm run\b/g,     "bun run")
       .replace(/\byarn install\b/g,"bun install")
       .replace(/\bnode\b/g,        "bun");
  for (const svc of Object.values(svcs)) {
    if (svc.command) {
      debug("  Original command:", svc.command);
      if (typeof svc.command === "string") {
        const updated = rewrite(svc.command);
        if (updated !== svc.command) {
          svc.command = updated;
          debug("  Rewritten command:", svc.command);
          changed = true;
        }
      } else if (Array.isArray(svc.command)) {
        const updatedArr = svc.command.map(rewrite);
        if (!Bun.deepEquals(updatedArr, svc.command)) {
          svc.command = updatedArr;
          debug("  Rewritten command array:", svc.command);
          changed = true;
        }
      }
    }
  }

  // ─── envPlugin ────────────────────────────────────────────────────────────────
  debug("envPlugin running");
  const apiSvc = doc.services?.api;
  if (apiSvc) {
    apiSvc.volumes = Array.isArray(apiSvc.volumes) ? apiSvc.volumes : [];
    const hasEnv = apiSvc.volumes.some(v =>
      typeof v === "string" ? v.includes(".env") : v.target === "/app/.env"
    );
    if (!hasEnv) {
      debug("  Injecting .env mount into api service");
      const entry = apiSvc.volumes.some(v => typeof v === "object")
        ? { type: "bind", source: "./.env", target: "/app/.env" }
        : "./.env:/app/.env";
      apiSvc.volumes.unshift(entry);
      changed = true;
    }
  }

  // ─── healthPlugin ───────────────────────────────────────────────────────────
  debug("healthPlugin running");
  const version       = parseFloat(doc.version || "0");
  const MIN_DEPENDS_ON = 3.9;
  for (const [name, svc] of Object.entries(svcs)) {
    if (["api", "rag_api", "rag-api"].includes(name) && !svc.healthcheck) {
      debug(`  Adding healthcheck to "${name}"`);
      let port = "3080";
      if (Array.isArray(svc.ports) && svc.ports.length) {
        port = svc.ports[0].toString().split(":").pop();
      }
      svc.healthcheck = {
        test: ["CMD-SHELL", `curl -f http://localhost:${port}/health || exit 1`],
        interval: "30s",
        timeout: "10s",
        retries: 5
      };
      changed = true;
      if (version >= MIN_DEPENDS_ON && Array.isArray(svc.depends_on)) {
        debug(`  Converting depends_on for "${name}" to service_healthy conditions`);
        const obj = {};
        for (const d of svc.depends_on) obj[d] = { condition: "service_healthy" };
        svc.depends_on = obj;
        changed = true;
      }
    }
  }

  return { doc, changed };
}

main().catch(err => {
  console.error("‼ transform-docker-compose crashed:", err);
  Bun.exit(1);
});