#!/usr/bin/env bun

/**
 * codemods/transform-tsconfig.js
 *
 * Standalone Bun script (no Node APIs) to:
 *  • Scan for \\*\\*\/tsconfig\\*.json
 *  • Read each file via Bun.file().text()
 *  • Parse & apply:
 *      – TS flags: ESNext, react-jsx, bundler, noEmit, etc.
 *      – Migrate compilerOptions.paths → top-level imports
 *      – Inject default Elysia/Bun imports ("elysia", "@elysia/\\*", "bun:\\*")
 *      – Ensure ambient types ["elysia","bun"]
 *  • Overwrite each file via Bun.writeFile
 *  • Verbose console logging throughout
 */

const TS_FLAGS = {
  module:                     'ESNext',
  target:                     'ESNext',
  moduleDetection:            'force',
  jsx:                        'react-jsx',
  moduleResolution:           'bundler',
  allowImportingTsExtensions: true,
  verbatimModuleSyntax:       true,
  noEmit:                     true,
  importsNotUsedAsValues:     'preserve'
};

const DEFAULT_IMPORTS = {
  "elysia":      ["elysia"],
  "@elysia/*":   ["@elysia/*"],
  "bun:*":       ["bun:*"]
};

const DEFAULT_TYPES = ['elysia', 'bun'];

function transformConfig(src, filePath) {
  let cfg;
  try {
    cfg = JSON.parse(src);
  } catch {
    console.warn(`[transform-tsconfig] ⚠ Invalid JSON in ${filePath}, skipping.`);
    return null;
  }

  console.log(`[transform-tsconfig] • Applying TS_FLAGS to ${filePath}`);
  const opts = cfg.compilerOptions ||= {};
  Object.assign(opts, TS_FLAGS);

  if (opts.paths && typeof opts.paths === 'object') {
    const aliases = Object.keys(opts.paths);
    cfg.imports ||= {};
    for (const [alias, targets] of Object.entries(opts.paths)) {
      cfg.imports[alias] = targets;
    }
    delete opts.paths;
    console.log(
      `[transform-tsconfig]   ↳ Migrated paths → imports: ${aliases.join(', ')}`
    );
  } else {
    console.log(`[transform-tsconfig]   ↳ No paths to migrate`);
  }

  cfg.imports ||= {};
  const injected = [];
  for (const [k, v] of Object.entries(DEFAULT_IMPORTS)) {
    if (cfg.imports[k] == null) {
      cfg.imports[k] = v;
      injected.push(k);
    }
  }
  console.log(
    injected.length
      ? `[transform-tsconfig]   ↳ Injected default imports: ${injected.join(', ')}`
      : `[transform-tsconfig]   ↳ Default imports already present`
  );

  const typesSet = new Set(opts.types || []);
  DEFAULT_TYPES.forEach((t) => typesSet.add(t));
  opts.types = Array.from(typesSet);
  console.log(
    `[transform-tsconfig]   ↳ Ensured ambient types: ${opts.types.join(', ')}`
  );

  return JSON.stringify(cfg, null, 2) + '\n';
}

async function main() {
  console.log(`[transform-tsconfig] Starting scan…`);
  for await (const entry of Bun.scandir('.', { recursive: true, includeDirs: false })) {
    if (!entry.isFile || !/^tsconfig.*\.json$/.test(entry.name)) continue;
    const filePath = entry.path;
    console.log(`\n[transform-tsconfig] === Processing ${filePath} ===`);
    const src = await Bun.file(filePath).text();
    const out = transformConfig(src, filePath);
    if (out !== null) {
      await Bun.writeFile(filePath, out);
      console.log(`[transform-tsconfig] ✔ Wrote updated ${filePath}`);
    }
  }
  console.log(`\n[transform-tsconfig] All done!`);
}

main().catch((err) => {
  console.error(`[transform-tsconfig] Fatal error:`, err);
  process.exit(1);
});