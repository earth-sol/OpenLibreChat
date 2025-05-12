#!/usr/bin/env bun

/**
 * transform-jest-config.js
 *
 * - Converts existing Jest configs (CJS or ESM) to Bun-friendly patterns:
 *   - Removes `testEnvironment` and `transform`
 *   - Ensures `testMatch` matches your Bun patterns
 *   - Anchors all `moduleNameMapper` keys with ^…$
 * - Scans `api/jest.config.js` and `packages/\*\*\/jest.config.\*`
 * - Uses Bun.Glob for native file globs
 * - Uses Babel for AST transforms
 * - Bun-native I/O (`Bun.file`, `Bun.write`)
 * - Verbose by default; `--quiet` to silence
 * - Supports `--dry-run` to preview without writing
 * - Idempotent and graceful on errors
 */

import { Glob } from "bun";
import path from "path";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import generate from "@babel/generator";
import * as t from "@babel/types";

async function main() {
  const args   = Bun.argv.slice(1);
  const dryRun = args.includes("--dry")    || args.includes("--dry-run");
  const quiet  = args.includes("--quiet")  || args.includes("--silent");
  const help   = args.includes("-h")       || args.includes("--help");

  if (help) {
    console.log(`
Usage: transform-jest-config.js [options]

Options:
  --dry-run, --dry      Preview changes without writing files
  --quiet, --silent     Suppress all output
  -h, --help            Show this help
`);
    Bun.exit(0);
  }

  const log   = (...m) => { if (!quiet) console.log(...m) };
  const error = (...m) => console.error(...m);

  log("▶ transform-jest-config: starting");

  // Code root (LibreChat-main) is two levels up from this codemod
  const codeRootUrl  = new URL("../../LibreChat-main", import.meta.url);
  const rootPath     = Bun.fileURLToPath(codeRootUrl);

  // Patterns to match Jest config files
  const patterns = [
    "api/jest.config.js",
    "packages/**/jest.config.*"
  ];

  const files = new Set();
  for (const pat of patterns) {
    const glob = new Glob(pat);
    for await (const rel of glob.scan({ cwd: rootPath, absolute: false, onlyFiles: true })) {
      files.add(rel);
    }
  }

  if (files.size === 0) {
    log("⚠ No Jest config files found");
    return;
  }

  const testMatchPatterns = [
    "api/test/**/*.{spec,test}.js",
    "client/test/**/*.{spec,test}.tsx",
    "packages/**/test/**/*.{spec,test}.{js,ts,tsx}",
    "e2e/specs/**/*.{spec,test}.{js,ts}"
  ].map(p => t.stringLiteral(p));

  let processed = 0, failed = 0;
  for (const relFile of files) {
    processed++;
    const absFile = path.join(rootPath, relFile);
    log(`\n→ ${relFile}`);

    let src;
    try {
      src = await Bun.file(absFile).text();
    } catch (err) {
      error("  ❌ read failed:", err.message);
      failed++;
      continue;
    }

    let ast;
    try {
      ast = parse(src, {
        sourceType: "unambiguous",
        plugins: ["jsx", "typescript"]
      });
    } catch (err) {
      error("  ❌ parse failed:", err.message);
      failed++;
      continue;
    }

    // Locate the exported config object
    let cfgNode = null;
    traverse(ast, {
      ExportDefaultDeclaration(path) {
        if (t.isObjectExpression(path.node.declaration)) {
          cfgNode = path.node.declaration;
          path.stop();
        }
      },
      AssignmentExpression(path) {
        // module.exports = { ... }
        const { left, right } = path.node;
        if (
          t.isMemberExpression(left) &&
          t.isIdentifier(left.object, { name: "module" }) &&
          t.isIdentifier(left.property, { name: "exports" }) &&
          t.isObjectExpression(right)
        ) {
          cfgNode = right;
          path.stop();
        }
      }
    });

    if (!cfgNode) {
      log("  ↪ no config object found, skipping");
      continue;
    }

    let changed = false;

    // Remove testEnvironment and transform properties
    cfgNode.properties = cfgNode.properties.filter(prop => {
      if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key)) return true;
      const k = prop.key.name;
      if (k === "testEnvironment" || k === "transform") {
        log(`   ✓ removed "${k}"`);
        changed = true;
        return false;
      }
      return true;
    });

    // Ensure testMatch property
    const existingTM = cfgNode.properties.find(prop =>
      t.isObjectProperty(prop) &&
      ((t.isIdentifier(prop.key) && prop.key.name === "testMatch") ||
       (t.isStringLiteral(prop.key) && prop.key.value === "testMatch"))
    );
    if (existingTM) {
      // Replace its value
      existingTM.value = t.arrayExpression(testMatchPatterns);
      log("   ✓ replaced testMatch");
      changed = true;
    } else {
      // Insert before first other property
      const tmProp = t.objectProperty(t.identifier("testMatch"), t.arrayExpression(testMatchPatterns));
      cfgNode.properties.unshift(tmProp);
      log("   ✓ added testMatch");
      changed = true;
    }

    // Process moduleNameMapper
    const mnmProp = cfgNode.properties.find(prop =>
      t.isObjectProperty(prop) &&
      ((t.isIdentifier(prop.key) && prop.key.name === "moduleNameMapper") ||
       (t.isStringLiteral(prop.key) && prop.key.value === "moduleNameMapper"))
    );
    if (mnmProp && t.isObjectExpression(mnmProp.value)) {
      for (const subProp of mnmProp.value.properties) {
        if (t.isObjectProperty(subProp)) {
          // Determine raw key name
          let rawKey = t.isIdentifier(subProp.key)
            ? subProp.key.name
            : t.isStringLiteral(subProp.key)
              ? subProp.key.value
              : null;
          if (rawKey) {
            let anchored = rawKey;
            if (!anchored.startsWith("^")) anchored = "^" + anchored;
            if (!anchored.endsWith("$")) anchored = anchored + "$";
            if (rawKey !== anchored) {
              subProp.key = t.stringLiteral(anchored);
              log(`   ✓ anchored moduleNameMapper key: "${rawKey}" → "${anchored}"`);
              changed = true;
            }
          }
        }
      }
    }

    // If nothing changed, skip writing
    if (!changed) {
      log("   ↪ no changes needed");
      continue;
    }

    // Generate code
    const output = generate(ast, {
      retainLines: true,
      comments: true,
      concise: false
    }).code;

    if (dryRun) {
      log("   (dry-run) skipped write");
    } else {
      try {
        await Bun.write(absFile, output);
        log("   ✔ written");
      } catch (err) {
        error("  ❌ write failed:", err.message);
        failed++;
      }
    }
  }

  log(`\n✔ transform-jest-config: processed=${processed}, failed=${failed}`);
  if (failed) Bun.exit(1);
}

main().catch(err => {
  console.error("‼ transform-jest-config crashed:", err);
  Bun.exit(1);
});