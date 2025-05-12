#!/usr/bin/env bun

/**
 * transform-prettier-config.js
 *
 * - Scans repo for Prettier config files via Bun.Glob:
 *     \*\*\/.prettierrc
 *     \*\*\/.prettierrc.{json,js,cjs,mjs}
 *     \*\*\/prettier.config.{js,cjs,mjs}
 * - CLI flags:
 *     --dry-run, --dry       Preview changes
 *     --quiet, --silent      Suppress logs
 *     -h, --help             Show this help
 * - Idempotent for JS configs: skips files containing "// bun: prettier-config-updated"
 * - Ensures:
 *     • singleQuote: true
 *     • semi: false
 *     • bracketSpacing: true
 *     • parser: "typescript"
 * - JSON configs updated in-place via JSON.parse/stringify
 * - JS configs transformed via jscodeshift AST, preserving formatting
 * - Fully async I/O, per-file try/catch, summary at end, uses Bun.exit
 */

import { Glob } from "bun";
import path from "path";
import j from "jscodeshift";

async function main() {
  const args   = Bun.argv.slice(1);
  const dryRun = args.includes("--dry-run") || args.includes("--dry");
  const quiet  = args.includes("--quiet")  || args.includes("--silent");
  const help   = args.includes("-h")       || args.includes("--help");
  if (help) {
    console.log(`
Usage: transform-prettier-config.js [options]

Options:
  --dry-run, --dry       Preview changes without writing
  --quiet, --silent      Suppress output
  -h, --help             Show this help
`);
    Bun.exit(0);
  }

  const log   = (...m) => { if (!quiet) console.log(...m) };
  const error = (...m) => console.error(...m);

  log("▶ transform-prettier-config: starting", dryRun ? "(dry-run)" : "");

  const MARKER    = "// bun: prettier-config-updated";
  const PATTERNS  = [
    "**/.prettierrc",
    "**/.prettierrc.json",
    "**/.prettierrc.js",
    "**/.prettierrc.cjs",
    "**/.prettierrc.mjs",
    "**/prettier.config.js",
    "**/prettier.config.cjs",
    "**/prettier.config.mjs"
  ];

  const rootUrl = new URL("../../LibreChat-main", import.meta.url);
  const root    = Bun.fileURLToPath(rootUrl);

  let processed = 0, failed = 0;

  for (const pat of PATTERNS) {
    const glob = new Glob(pat);
    for await (const rel of glob.scan({ cwd: root, absolute: false, onlyFiles: true })) {
      processed++;
      const abs = path.join(root, rel);
      log(`\n→ ${rel}`);

      let src;
      try {
        src = await Bun.file(abs).text();
      } catch (err) {
        error("  ❌ read failed:", err.message);
        failed++;
        continue;
      }

      let out = src;
      let modified = false;

      // JSON-based config (.prettierrc or .json)
      if (rel.endsWith(".json") || rel.endsWith(".prettierrc")) {
        let cfg;
        try {
          cfg = JSON.parse(src);
        } catch (err) {
          error("  ❌ JSON parse failed:", err.message);
          failed++;
          continue;
        }

        // enforce settings
        if (cfg.singleQuote !== true) {
          cfg.singleQuote = true; modified = true; log("  ✓ singleQuote = true");
        }
        if (cfg.semi !== false) {
          cfg.semi = false; modified = true; log("  ✓ semi = false");
        }
        if (cfg.bracketSpacing !== true) {
          cfg.bracketSpacing = true; modified = true; log("  ✓ bracketSpacing = true");
        }
        if (cfg.parser !== "typescript") {
          cfg.parser = "typescript"; modified = true; log('  ✓ parser = "typescript"');
        }

        if (!modified) {
          log("  ↪ no changes");
          continue;
        }

        out = JSON.stringify(cfg, null, 2) + "\n";
      }
      // JS-based config
      else {
        if (src.includes(MARKER)) {
          log("  ↪ already transformed");
          continue;
        }
        const ast = j(src);
        // insert marker
        ast.get().node.program.body.unshift(
          j.commentLine(" bun: prettier-config-updated", true, false)
        );
        modified = true;

        // find the config object literal
        let obj = null;
        ast.find(j.ExportDefaultDeclaration).forEach(p => {
          if (j.ObjectExpression.check(p.node.declaration)) obj = p.node.declaration;
        });
        ast.find(j.AssignmentExpression, {
          left: { object: { name: "module" }, property: { name: "exports" } }
        }).forEach(p => {
          if (j.ObjectExpression.check(p.node.right)) obj = p.node.right;
        });

        if (!obj) {
          log("  ⚠ config object not found; skipping AST transform");
          out = src;
        } else {
          // helper to ensure or update a property
          function upsertProp(name, valueNode) {
            const prop = obj.properties.find(p =>
              j.ObjectProperty.check(p) &&
              ((j.Identifier.check(p.key) && p.key.name === name) ||
               (j.Literal.check(p.key) && p.key.value === name))
            );
            if (prop) {
              if (!j.Literal.check(prop.value) ||
                  prop.value.value !== valueNode.value) {
                prop.value = valueNode;
                log(`  ✓ updated ${name}`);
              }
            } else {
              obj.properties.push(
                j.objectProperty(j.identifier(name), valueNode)
              );
              log(`  ✓ added ${name}`);
            }
          }

          upsertProp("singleQuote", j.literal(true));
          upsertProp("semi", j.literal(false));
          upsertProp("bracketSpacing", j.literal(true));
          upsertProp("parser", j.literal("typescript"));

          out = ast.toSource({
            reuseWhitespace: true,
            quote: "single",
            trailingComma: true
          });
        }
      }

      if (dryRun) {
        log("  (dry-run) changes detected");
        continue;
      }

      try {
        await Bun.write(abs, out);
        log("  ✔ written");
      } catch (err) {
        error("  ❌ write failed:", err.message);
        failed++;
      }
    }
  }

  log(`\n✔ transform-prettier-config: processed=${processed}, failed=${failed}`);
  if (failed) Bun.exit(1);
}

main().catch(err => {
  console.error("‼ transform-prettier-config crashed:", err);
  Bun.exit(1);
});