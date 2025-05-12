#!/usr/bin/env bun

/**
 * transform-config-scripts.js
 *
 * - Scans all JS/TS under config/
 * - Uses Bun.Glob + Bun.file()/Bun.write() for discovery & I/O
 * - Imports jscodeshift *only* for AST transforms
 * - Converts:
 *    • require → import
 *    • process.env → Bun.env
 *    • fs.*Sync / fs.promises → Bun.file().text() / Bun.write()
 *    • child_process.execSync → Bun.spawnSync
 * - Marks functions async when introducing await
 * - Verbose by default; --quiet to silence; --dry-run to preview
 */

import { Glob } from "bun";
import path from "path";
import jscodeshift from "jscodeshift";

// CLI flags
const args   = Bun.argv.slice(1);
const dryRun = args.includes("--dry")    || args.includes("--dry-run");
const quiet  = args.includes("--quiet")  || args.includes("--silent");
const help   = args.includes("-h")       || args.includes("--help");
if (help) {
  console.log(`
Usage: transform-config-scripts.js [options]

Options:
  --dry-run, --dry      Preview changes without writing
  --quiet, --silent     Suppress logs
  -h, --help            Show help
`);
  Bun.exit(0);
}
const log   = (...m) => { if (!quiet) console.log(...m) };
const error = (...m) => console.error(...m);

/**
 * Perform the AST transforms on a single file's source.
 */
function transformSource(source) {
  const j = jscodeshift;
  const root = j(source);

  // Utility to mark containing function async
  function ensureAsync(path) {
    const fn = path.getFunctionParent();
    if (fn && !fn.node.async) fn.node.async = true;
  }

  // 1) require(...) → import
  root.find(j.CallExpression, { callee: { name: "require" } })
    .forEach(p => {
      const [arg] = p.node.arguments;
      if (!j.Literal.check(arg)) return;
      const src = arg.value;
      const parent = p.parentPath;
      // const x = require('y')
      if (parent.node.type === "VariableDeclarator") {
        const id = parent.node.id;
        const importDec = j.importDeclaration(
          [j.importDefaultSpecifier(id)],
          j.literal(src)
        );
        parent.parentPath.replace(importDec);
      }
      // require('x');
      else if (parent.node.type === "ExpressionStatement") {
        const importDec = j.importDeclaration([], j.literal(src));
        parent.replace(importDec);
      }
      // dynamic require → await import(...)
      else {
        const imp = j.awaitExpression(
          j.callExpression(j.import(), [arg])
        );
        ensureAsync(p);
        p.replace(imp);
      }
    });

  // 2) process.env.X & import.meta.env.X → Bun.env.X
  root.find(j.MemberExpression, {
    object: {
      object: { name: "process", type: "Identifier" },
      property: { name: "env", type: "Identifier" }
    }
  }).replaceWith(p =>
    j.memberExpression(
      j.memberExpression(j.identifier("Bun"), j.identifier("env")),
      p.node.property
    )
  );
  root.find(j.MemberExpression, {
    object: {
      object: {
        object: { name: "import", type: "Identifier" },
        property: { name: "meta", type: "Identifier" }
      },
      property: { name: "env", type: "Identifier" }
    }
  }).replaceWith(p =>
    j.memberExpression(
      j.memberExpression(j.identifier("Bun"), j.identifier("env")),
      p.node.property
    )
  );

  // 3) fs.readFileSync → await Bun.file().text()
  root.find(j.CallExpression, {
    callee: {
      object: { name: "fs", type: "Identifier" },
      property: { name: "readFileSync", type: "Identifier" }
    }
  }).forEach(p => {
    const [fileArg] = p.node.arguments;
    const call = j.awaitExpression(
      j.callExpression(
        j.memberExpression(
          j.callExpression(j.memberExpression(j.identifier("Bun"), j.identifier("file")), [fileArg]),
          j.identifier("text")
        ),
        []
      )
    );
    ensureAsync(p);
    p.replace(call);
  });

  // 4) fs.writeFileSync → await Bun.write()
  root.find(j.CallExpression, {
    callee: {
      object: { name: "fs", type: "Identifier" },
      property: { name: "writeFileSync", type: "Identifier" }
    }
  }).forEach(p => {
    const [fileArg, dataArg] = p.node.arguments;
    const call = j.awaitExpression(
      j.callExpression(
        j.memberExpression(j.identifier("Bun"), j.identifier("write")),
        [fileArg, dataArg]
      )
    );
    ensureAsync(p);
    p.replace(call);
  });

  // 5) fs.promises.readFile → await Bun.file().text()
  root.find(j.CallExpression, {
    callee: {
      object: {
        object: { name: "fs", type: "Identifier" },
        property: { name: "promises", type: "Identifier" }
      },
      property: { name: "readFile", type: "Identifier" }
    }
  }).forEach(p => {
    const [fileArg] = p.node.arguments;
    const call = j.awaitExpression(
      j.callExpression(
        j.memberExpression(
          j.callExpression(j.memberExpression(j.identifier("Bun"), j.identifier("file")), [fileArg]),
          j.identifier("text")
        ),
        []
      )
    );
    ensureAsync(p);
    p.replace(call);
  });

  // 6) fs.promises.writeFile → await Bun.write()
  root.find(j.CallExpression, {
    callee: {
      object: {
        object: { name: "fs", type: "Identifier" },
        property: { name: "promises", type: "Identifier" }
      },
      property: { name: "writeFile", type: "Identifier" }
    }
  }).forEach(p => {
    const [fileArg, dataArg] = p.node.arguments;
    const call = j.awaitExpression(
      j.callExpression(
        j.memberExpression(j.identifier("Bun"), j.identifier("write")),
        [fileArg, dataArg]
      )
    );
    ensureAsync(p);
    p.replace(call);
  });

  // 7) fs.existsSync → await Bun.file(path).exists()
  root.find(j.CallExpression, {
    callee: {
      object: { name: "fs", type: "Identifier" },
      property: { name: "existsSync", type: "Identifier" }
    }
  }).forEach(p => {
    const [fileArg] = p.node.arguments;
    const call = j.awaitExpression(
      j.callExpression(
        j.memberExpression(
          j.callExpression(j.memberExpression(j.identifier("Bun"), j.identifier("file")), [fileArg]),
          j.identifier("exists")
        ),
        []
      )
    );
    ensureAsync(p);
    p.replace(call);
  });

  // 8) child_process.execSync → Bun.spawnSync
  root.find(j.CallExpression, {
    callee: { property: { name: "execSync" } }
  }).forEach(p => {
    const [cmdArg, optsArg] = p.node.arguments;
    const call = j.callExpression(
      j.memberExpression(j.identifier("Bun"), j.identifier("spawnSync")),
      [j.arrayExpression([j.literal("sh"), j.literal("-c"), cmdArg]), optsArg || j.objectExpression([])]
    );
    p.replace(call);
  });

  return root.toSource({ quote: "single", trailingComma: true });
}

// Main
async function main() {
  log("▶ transform-config-scripts: starting");

  // Project root
  const rootUrl  = new URL("../../LibreChat-main", import.meta.url);
  const rootPath = Bun.fileURLToPath(rootUrl);

  // Scan config scripts
  const glob = new Glob("config/**/*.{js,ts}");
  let processed = 0, failed = 0;

  for await (const relFile of glob.scan({ cwd: rootPath, absolute: false, onlyFiles: true })) {
    processed++;
    const absFile = path.join(rootPath, relFile);
    log(`\n→ ${relFile}`);

    let src;
    try { src = await Bun.file(absFile).text(); }
    catch (err) { error("  ❌ read failed:", err.message); failed++; continue; }

    let out;
    try {
      out = transformSource(src);
    } catch (err) {
      error("  ❌ transform failed:", err.message); failed++; continue;
    }

    if (out === src) {
      log("  ↪ no changes");
      continue;
    }

    if (dryRun) {
      log("  (dry-run) detected changes");
    } else {
      try {
        await Bun.write(absFile, out);
        log("  ✔ written");
      } catch (err) {
        error("  ❌ write failed:", err.message);
        failed++;
      }
    }
  }

  log(`\n✔ transform-config-scripts: processed=${processed}, failed=${failed}`);
  if (failed) Bun.exit(1);
}

main().catch(err => {
  console.error("‼ transform-config-scripts crashed:", err);
  Bun.exit(1);
});