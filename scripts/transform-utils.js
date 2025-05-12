#!/usr/bin/env bun

async function main() {
  // ─── CLI FLAGS ──────────────────────────────────────────────────────────────
  const args   = Bun.argv.slice(1);
  const dryRun = args.includes("--dry")    || args.includes("--dry-run");
  const quiet  = args.includes("--quiet")  || args.includes("--silent");
  const help   = args.includes("-h")       || args.includes("--help");

  if (help) {
    console.log(`
Usage: transform-utils.js [options]

Options:
  --dry-run, --dry    Preview without writing files
  --quiet, --silent   Suppress all output
  -h, --help          Show this help
`);
    Bun.exit(0);
  }

  const log   = (...m) => { if (!quiet) console.log(...m) };
  const debug = (...m) => { if (!quiet) console.debug(...m) };

  log("▶ transform-utils: starting");

  // ─── PROJECT ROOT ────────────────────────────────────────────────────────────
  const rootUrl  = new URL("../", import.meta.url);   // repo root
  const rootPath = Bun.fileURLToPath(rootUrl);

  // ─── FIND SHELL SCRIPTS ─────────────────────────────────────────────────────
  const glob = new Bun.Glob("utils/**/*.sh");
  let processed = 0, updated = 0, skipped = 0, errors = 0;

  for await (const absPath of glob.scan({ cwd: rootPath, absolute: true, onlyFiles: true })) {
    processed++;
    debug(`\n[+] Processing ${absPath}`);

    let original;
    try {
      original = await Bun.file(absPath).text();
    } catch (err) {
      console.error(`❌ Read failed: ${absPath}`, err.message);
      errors++;
      continue;
    }

    let transformed = original;

    // ─── APPLY REPPLACEMENTS ───────────────────────────────────────────────────
    // Npx → bunx
    transformed = transformed.replace(/\bnpx\b/g, "bunx");

    // npm → bun
    transformed = transformed
      .replace(/\bnpm\s+ci\b/g, "bun install")
      .replace(/\bnpm\s+install\b/g, "bun install")
      .replace(/\bnpm\s+run\b/g, "bun run")
      .replace(/\bnpm\b/g,      "bun");

    // yarn → bun
    transformed = transformed
      .replace(/\byarn\s+global\s+add\b/g, "bun add")
      .replace(/\byarn\s+add\b/g,          "bun add")
      .replace(/\byarn\s+install\b/g,      "bun install")
      .replace(/\byarn\s+run\b/g,          "bun run")
      .replace(/\byarn\s+(\S+)/g,          "bun run $1");

    // ─── SKIP IF NO CHANGES ────────────────────────────────────────────────────
    if (transformed === original) {
      debug(`   ↪ no npm/yarn/npx usages found, skipping`);
      skipped++;
      continue;
    }

    // ─── WRITE OR DRY-RUN ──────────────────────────────────────────────────────
    if (dryRun) {
      log(`   (dry-run) would update: ${absPath}`);
      updated++;
    } else {
      try {
        await Bun.write(absPath, transformed);
        log(`   ✔ updated: ${absPath}`);
        updated++;
      } catch (err) {
        console.error(`❌ Write failed: ${absPath}`, err.message);
        errors++;
      }
    }
  }

  // ─── SUMMARY & EXIT ─────────────────────────────────────────────────────────
  log(`\n✔ transform-utils: done. processed=${processed}, updated=${updated}, skipped=${skipped}, errors=${errors}`);
  if (errors > 0) Bun.exit(1);
}

main().catch(err => {
  console.error("‼ transform-utils crashed:", err);
  Bun.exit(1);
});