#!/usr/bin/env bun

/**
 * transform-eslint-config.js
 *
 * - Scans repository for ESLint config files via Bun.Glob:
 *     \*\*\/.eslintrc.{js,cjs,mjs,json}
 *     \*\*\/eslint.config.{js,mjs}
 * - CLI flags:
 *     --dry-run    Preview changes without writing
 *     --quiet      Suppress logs
 *     --silent     Alias for --quiet
 *     -h, --help   Show this help
 * - Idempotent: skips JS files containing "// bun: eslint-config-updated"
 * - Updates:
 *     • parserOptions.ecmaVersion → 2022
 *     • parserOptions.sourceType → "module"
 *     • globals.Bun → true
 *     • globals["import.meta"] → true
 *     • Removes any rules whose key starts with "node/"
 * - JSON configs updated in-place
 * - Uses Bun.Core for I/O & Glob; jscodeshift only for JS AST transforms
 * - Fully async, per-file try/catch, summary at end, Bun.exit on failure
 */

import { Glob } from "bun";
import path from "path";
import j from "jscodeshift";

async function main() {
  const args   = Bun.argv.slice(1);
  const dryRun = args.includes("--dry")    || args.includes("--dry-run");
  const quiet  = args.includes("--quiet")  || args.includes("--silent");
  const help   = args.includes("-h")       || args.includes("--help");
  if (help) {
    console.log(`
Usage: transform-eslint-config.js [options]

Options:
  --dry-run, --dry      Preview changes without writing
  --quiet, --silent     Suppress output
  -h, --help            Show this help
`);
    Bun.exit(0);
  }

  const log   = (...m) => { if (!quiet) console.log(...m) };
  const error = (...m) => console.error(...m);

  log("▶ transform-eslint-config: starting", dryRun ? "(dry-run)" : "");

  const MARKER     = "// bun: eslint-config-updated";
  const PATTERNS   = [
    "**/.eslintrc.{js,cjs,mjs,json}",
    "**/eslint.config.{js,mjs}"
  ];

  // Determine repo root relative to this script
  const rootUrl = new URL("../../LibreChat-main", import.meta.url);
  const root    = Bun.fileURLToPath(rootUrl);

  // Discover config files
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

    let modified = false;
    let out = src;

    // JSON-based config
    if (rel.endsWith(".json")) {
      let cfg;
      try {
        cfg = JSON.parse(src);
      } catch (err) {
        error("  ❌ JSON parse failed:", err.message);
        failed++;
        continue;
      }

      cfg.parserOptions = cfg.parserOptions || {};
      if (cfg.parserOptions.ecmaVersion !== 2022) {
        cfg.parserOptions.ecmaVersion = 2022;
        modified = true;
        log("  ✓ set parserOptions.ecmaVersion to 2022");
      }
      if (cfg.parserOptions.sourceType !== "module") {
        cfg.parserOptions.sourceType = "module";
        modified = true;
        log('  ✓ set parserOptions.sourceType to "module"');
      }

      cfg.globals = cfg.globals || {};
      if (cfg.globals.Bun !== true) {
        cfg.globals.Bun = true;
        modified = true;
        log("  ✓ added globals.Bun = true");
      }
      if (cfg.globals["import.meta"] !== true) {
        cfg.globals["import.meta"] = true;
        modified = true;
        log('  ✓ added globals["import.meta"] = true');
      }

      if (cfg.rules && typeof cfg.rules === "object") {
        for (const key of Object.keys(cfg.rules)) {
          if (key.startsWith("node/")) {
            delete cfg.rules[key];
            modified = true;
            log(`  ✓ removed rule "${key}"`);
          }
        }
      }

      if (modified) {
        out = JSON.stringify(cfg, null, 2) + "\n";
      }
    }
    // JS-based config
    else {
      // Idempotence: skip if marker present
      if (src.includes(MARKER)) {
        log("  ↪ already transformed");
        continue;
      }

      const rootAst = j(src);

      // Insert marker comment at top
      rootAst.get().node.program.body.unshift(
        j.commentLine(" bun: eslint-config-updated", true, false)
      );
      modified = true;

      // Locate config object (export default {...} or module.exports = {...})
      let cfgNode = null;
      rootAst.find(j.ExportDefaultDeclaration).forEach(p => {
        if (j.ObjectExpression.check(p.node.declaration)) {
          cfgNode = p.node.declaration;
        }
      });
      rootAst.find(j.AssignmentExpression, {
        left: { object: { name: "module" }, property: { name: "exports" } }
      }).forEach(p => {
        if (j.ObjectExpression.check(p.node.right)) {
          cfgNode = p.node.right;
        }
      });

      if (!cfgNode) {
        log("  ⚠ config object not found; skipping AST transform");
      } else {
        // Helper to get or create a property
        function ensureProp(obj, propName) {
          let prop = obj.properties.find(p =>
            j.ObjectProperty.check(p) &&
            ((j.Identifier.check(p.key) && p.key.name === propName) ||
             (j.Literal.check(p.key) && p.key.value === propName))
          );
          if (!prop) {
            prop = j.objectProperty(j.identifier(propName), j.objectExpression([]));
            obj.properties.push(prop);
            modified = true;
            log(`  ✓ added "${propName}" property`);
          }
          return prop;
        }

        // parserOptions
        const parserOptProp = ensureProp(cfgNode, "parserOptions");
        if (j.ObjectExpression.check(parserOptProp.value)) {
          const po = parserOptProp.value;
          // ecmaVersion
          let ev = po.properties.find(p =>
            j.ObjectProperty.check(p) &&
            j.Identifier.check(p.key) && p.key.name === "ecmaVersion"
          );
          if (ev) {
            if (ev.value.value !== 2022) {
              ev.value = j.literal(2022);
              modified = true;
              log("  ✓ updated parserOptions.ecmaVersion to 2022");
            }
          } else {
            po.properties.push(
              j.objectProperty(j.identifier("ecmaVersion"), j.literal(2022))
            );
            modified = true;
            log("  ✓ added parserOptions.ecmaVersion = 2022");
          }
          // sourceType
          let st = po.properties.find(p =>
            j.ObjectProperty.check(p) &&
            j.Identifier.check(p.key) && p.key.name === "sourceType"
          );
          if (st) {
            if (st.value.value !== "module") {
              st.value = j.literal("module");
              modified = true;
              log('  ✓ updated parserOptions.sourceType to "module"');
            }
          } else {
            po.properties.push(
              j.objectProperty(j.identifier("sourceType"), j.literal("module"))
            );
            modified = true;
            log('  ✓ added parserOptions.sourceType = "module"');
          }
        }

        // globals
        const globalsProp = ensureProp(cfgNode, "globals");
        if (j.ObjectExpression.check(globalsProp.value)) {
          const gl = globalsProp.value;
          // Bun
          let bunG = gl.properties.find(p =>
            j.ObjectProperty.check(p) &&
            ((j.Identifier.check(p.key) && p.key.name === "Bun") ||
             (j.Literal.check(p.key) && p.key.value === "Bun"))
          );
          if (bunG) {
            if (bunG.value.value !== true) {
              bunG.value = j.literal(true);
              modified = true;
              log("  ✓ set globals.Bun = true");
            }
          } else {
            gl.properties.push(
              j.objectProperty(j.identifier("Bun"), j.literal(true))
            );
            modified = true;
            log("  ✓ added globals.Bun = true");
          }
          // import.meta
          let imG = gl.properties.find(p =>
            j.ObjectProperty.check(p) &&
            j.Literal.check(p.key) && p.key.value === "import.meta"
          );
          if (imG) {
            if (imG.value.value !== true) {
              imG.value = j.literal(true);
              modified = true;
              log('  ✓ set globals["import.meta"] = true');
            }
          } else {
            gl.properties.push(
              j.objectProperty(j.literal("import.meta"), j.literal(true))
            );
            modified = true;
            log('  ✓ added globals["import.meta"] = true');
          }
        }

        // rules removal
        const rulesProp = cfgNode.properties.find(p =>
          j.ObjectProperty.check(p) &&
          ((j.Identifier.check(p.key) && p.key.name === "rules") ||
           (j.Literal.check(p.key) && p.key.value === "rules"))
        );
        if (rulesProp && j.ObjectExpression.check(rulesProp.value)) {
          const rp = rulesProp.value;
          rp.properties = rp.properties.filter(p => {
            const key = j.Literal.check(p.key)
              ? p.key.value
              : j.Identifier.check(p.key)
                ? p.key.name
                : null;
            if (key && key.startsWith("node/")) {
              modified = true;
              log(`  ✓ removed rule "${key}"`);
              return false;
            }
            return true;
          });
        }
      }

      // Generate new source if modified
      if (modified) {
        out = rootAst.toSource({ reuseWhitespace: true, quote: "single", trailingComma: true });
      }
    }

    if (!modified) {
      log("  ↪ no changes");
      continue;
    }

    if (dryRun) {
      log("  (dry-run) changes detected");
      continue;
    }

    try {
      await Bun.write(absPath, out);
      log("  ✔ written");
    } catch (err) {
      error("  ❌ write failed:", err.message);
      failed++;
    }
  }

  log(`\n✔ transform-eslint-config: processed=${processed}, failed=${failed}`);
  if (failed) Bun.exit(1);
}

main().catch(err => {
  console.error("‼ transform-eslint-config crashed:", err);
  Bun.exit(1);
});