#!/usr/bin/env bun

/**
 * transform-client-html.js
 *
 * - Scans all HTML files under client/ via Bun.Glob
 * - Rewrites <script src="..."> → dynamic import:
 *     <script type="module" data-elysia-transformed>
 *       await import('…');
 *     </script>
 * - Idempotent: only transforms each <script src> once
 * - In client/index.html, injects a loader snippet after the theme setup script
 *     (<script>/\* theme setup \*\/</script>)
 *     and marks it with data-elysia-loader
 * - Uses Bun.Core APIs (Glob, file, write, HTMLRewriter)
 * - CLI flags:
 *     --dry-run    preview changes without writing
 *     --quiet      suppress logs
 *     --silent     alias for --quiet
 *     -h, --help   show this help
 * - Exits with non-zero if any file fails
 */

import { Glob } from "bun";
import path from "path";

async function transformScripts(html) {
  const rewriter = new HTMLRewriter();
  rewriter.on("script[src]", {
    element(el) {
      const src = el.getAttribute("src");
      if (!src) return;
      // replace with dynamic import script; strip src so it's not reprocessed
      el.replace(
        `<script type="module" data-elysia-transformed>await import('${src}');</script>`,
        { html: true }
      );
    }
  });
  const out = await rewriter.transform(html);
  return out.text();
}

async function main() {
  const args   = Bun.argv.slice(1);
  const dryRun = args.includes("--dry")    || args.includes("--dry-run");
  const quiet  = args.includes("--quiet")  || args.includes("--silent");
  const help   = args.includes("-h")       || args.includes("--help");

  if (help) {
    console.log(`
Usage: transform-client-html.js [options]

Options:
  --dry-run, --dry      Preview changes without writing files
  --quiet, --silent     Suppress all output
  -h, --help            Show this help
`);
    Bun.exit(0);
  }

  const log   = (...m) => { if (!quiet) console.log(...m) };
  const error = (...m) => console.error(...m);

  log("▶ transform-client-html: starting");

  // Project root is two levels up from this script to LibreChat-main
  const codeRootUrl  = new URL("../../LibreChat-main", import.meta.url);
  const root         = Bun.fileURLToPath(codeRootUrl);

  // Discover HTML files under client/
  const glob = new Glob("client/**/*.html");
  let processed = 0, failed = 0;

  for await (const relFile of glob.scan({ cwd: root, absolute: false, onlyFiles: true })) {
    processed++;
    const filePath = path.join(root, relFile);
    log(`\n→ ${relFile}`);

    let src;
    try {
      src = await Bun.file(filePath).text();
    } catch (err) {
      error("  ❌ read failed:", err.message);
      failed++;
      continue;
    }

    // 1) Transform <script src> to dynamic imports
    let updated;
    try {
      updated = await transformScripts(src);
    } catch (err) {
      error("  ❌ transform failed:", err.message);
      failed++;
      continue;
    }

    // 2) Inject loader into client/index.html
    if (relFile === "client/index.html") {
      const loaderMarker  = "data-elysia-loader";
      const snippetBefore = `<script>/* theme setup */</script>`;
      const snippetInject = `<script data-elysia-loader defer type="module">\n  await import('/src/main.jsx');\n</script>`;

      if (!updated.includes(loaderMarker)) {
        if (updated.includes(snippetBefore)) {
          updated = updated.replace(
            snippetBefore,
            snippetBefore + "\n" + snippetInject
          );
          log("  ✓ injected loader snippet");
        } else {
          log("  ⚠ snippetBefore not found; skipping loader injection");
        }
      } else {
        log("  ↪ loader already injected");
      }
    }

    // 3) Write changes if any
    if (updated === src) {
      log("  ↪ no changes");
      continue;
    }

    if (dryRun) {
      log("  (dry-run) detected changes");
    } else {
      try {
        await Bun.write(filePath, updated);
        log("  ✔ written");
      } catch (err) {
        error("  ❌ write failed:", err.message);
        failed++;
      }
    }
  }

  log(`\n✔ transform-client-html: processed=${processed}, failed=${failed}`);
  if (failed) Bun.exit(1);
}

main().catch(err => {
  console.error("‼ transform-client-html crashed:", err);
  Bun.exit(1);
});