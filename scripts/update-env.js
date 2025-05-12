#!/usr/bin/env bun

/**
 * Recursively finds all ".env*" files under the project root (except node_modules/.env)
 * and updates any KEY=… lines where the KEY exists in Bun.env.
 *
 * ✔ Uses Bun.Glob for native file matching
 * ✔ Reads & writes files via Bun.file() / Bun.write()
 * ✔ Verbose-by-default logging (pass --quiet or --silent to suppress)
 * ✔ Supports --dry-run to preview without writing
 * ✔ Idempotent: re-running won’t reapply unchanged values
 * ✔ Graceful per-file error handling, exit code >0 if any failures
 */

async function main() {
  // ─── CLI FLAGS ──────────────────────────────────────────────────────────────
  const args   = Bun.argv.slice(1);
  const dryRun = args.includes("--dry")    || args.includes("--dry-run");
  const quiet  = args.includes("--quiet")  || args.includes("--silent");
  const help   = args.includes("-h")       || args.includes("--help");

  if (help) {
    console.log(`
Usage: update-envs.js [options]

Options:
  --dry-run, --dry      Preview without writing any files
  --quiet, --silent     Suppress all output
  -h, --help            Show this help
`);
    Bun.exit(0);
  }

  const log   = (...m) => { if (!quiet) console.log(...m) };
  const error = (...m) => console.error(...m);
  const debug = (...m) => { if (!quiet) console.debug(...m) };

  log("▶ update-envs: starting");

  // ─── PROJECT ROOT ────────────────────────────────────────────────────────────
  const rootUrl  = new URL("../", import.meta.url);
  const rootPath = Bun.fileURLToPath(rootUrl);

  // ─── FIND .env* FILES ────────────────────────────────────────────────────────
  const glob = new Bun.Glob(".env*");
  let processed = 0, updated = 0, skipped = 0, errors = 0;

  for await (const relPath of glob.scan({ cwd: rootPath, absolute: false, onlyFiles: true })) {
    // Skip .env.example or files in node_modules
    if (relPath.startsWith("node_modules/") || relPath.endsWith(".example")) {
      debug(`↪ skipping ${relPath}`);
      continue;
    }

    const filePath = rootPath + "/" + relPath;
    processed++;
    debug(`\n[+] Processing ${relPath}`);

    let text;
    try {
      text = await Bun.file(filePath).text();
    } catch (err) {
      error(`❌ Read failed: ${relPath}`, err.message);
      errors++;
      continue;
    }

    const lines = text.split(/\r?\n/);
    let changed = false;

    const outLines = lines.map((line) => {
      // Match KEY=VALUE (no leading spaces)
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) return line;

      const [ , key, oldVal ] = m;
      const newVal = Bun.env[key];
      if (newVal === undefined) {
        debug(`   ↪ no Bun.env[${key}], leaving unchanged`);
        return line;
      }

      // If value is already up-to-date, skip
      if (oldVal === newVal) {
        debug(`   ↪ ${key} already up-to-date`);
        return line;
      }

      changed = true;
      log(`   ✓ ${key}: "${oldVal}" → "${newVal}"`);
      return `${key}=${newVal}`;
    });

    if (!changed) {
      debug(`   ↪ no keys updated in ${relPath}`);
      skipped++;
      continue;
    }

    const newText = outLines.join("\n");
    if (dryRun) {
      log(`   (dry-run) would write updates to ${relPath}`);
      updated++;
    } else {
      try {
        await Bun.write(filePath, newText);
        log(`   ✔ updated ${relPath}`);
        updated++;
      } catch (err) {
        error(`❌ Write failed: ${relPath}`, err.message);
        errors++;
      }
    }
  }

  // ─── SUMMARY & EXIT ──────────────────────────────────────────────────────────
  log(`\n✔ update-envs: done. processed=${processed}, updated=${updated}, skipped=${skipped}, errors=${errors}`);
  if (errors > 0) Bun.exit(1);
}

main().catch((err) => {
  console.error("‼ update-envs crashed:", err);
  Bun.exit(1);
});