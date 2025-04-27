#!/usr/bin/env bun
/**
 * codemods/transform-docker-scripts.js
 *
 * Bun‐native script to transform all shell scripts under utils/docker:
 *  - Replace npm/yarn with bun equivalents
 *  - Ensure BUN_BASE_IMAGE is declared (default: oven/bun:latest)
 *  - Add --build-arg BUN_BASE_IMAGE to docker build commands
 *  - Preserve shebang and exec bit
 *  - Verbose logging by default
 *  - Idempotent & fail gracefully
 */

import { Glob } from 'bun';

// Configuration
const SHELL_GLOB = 'utils/docker/*.sh';
const DEFAULT_BASE = 'oven/bun:latest';

// Mapping of regex → replacement for package manager commands
const REPLACEMENTS = [
  { regex: /\bnpm\s+install\b/g,       repl: 'bun install' },
  { regex: /\bnpm\s+ci\b/g,            repl: 'bun install' },
  { regex: /\bnpm\s+run\s+([^\s]+)/g,  repl: 'bun run $1' },
  { regex: /\byarn\s+install\b/g,      repl: 'bun install' },
  { regex: /\byarn\s+add\b/g,          repl: 'bun add' },
  { regex: /\byarn\s+run\s+([^\s]+)/g, repl: 'bun run $1' },
  { regex: /\byarn\s+build\b/g,        repl: 'bun build' },
  { regex: /\byarn\s+test\b/g,         repl: 'bun test' }
];

async function transformFile(filePath) {
  try {
    console.log(`\n🔧 Processing: ${filePath}`);

    // 1. Read original content
    const file = Bun.file(filePath);
    const original = await file.text();
    let updated = original;

    // 2. Ensure shebang is present and preserve it
    const lines = updated.split('\n');
    const shebangIdx = lines.findIndex((l) => l.startsWith('#!'));
    if (shebangIdx === -1) {
      console.warn('  ⚠️  No shebang found; inserting default');
      lines.unshift('#!/usr/bin/env bash');
    }

    // 3. Inject BUN_BASE_IMAGE declaration if missing
    if (!/\bBUN_BASE_IMAGE\b/.test(updated)) {
      const baseImage = Bun.env.BUN_BASE_IMAGE || DEFAULT_BASE;
      const injection = [
        '# --- begin bun-base-image injection ---',
        `: "\${BUN_BASE_IMAGE:=${baseImage}}"`,
        'export BUN_BASE_IMAGE',
        '# --- end bun-base-image injection ---'
      ];
      // Insert right after shebang
      lines.splice(shebangIdx + 1, 0, ...injection);
      console.log('  ✅ Injected BUN_BASE_IMAGE declaration');
    }

    // 4. Apply npm/yarn → bun command replacements
    for (const { regex, repl } of REPLACEMENTS) {
      if (regex.test(updated)) {
        updated = updated.replace(regex, repl);
        console.log(`  🔄 Replaced commands matching ${regex}`);
      }
    }

    // 5. Inject --build-arg for docker build lines
    updated = lines
      .map((line) => {
        // if this line has a docker build without build-arg, inject it
        if (/^\s*docker build\b/.test(line) && !/--build-arg\s+BUN_BASE_IMAGE/.test(line)) {
          const transformed = line.replace(
            /(docker build\b)/,
            `$1 --build-arg BUN_BASE_IMAGE=\$BUN_BASE_IMAGE`
          );
          console.log('  ↗ Injected build-arg into docker build');
          return transformed;
        }
        return line;
      })
      .join('\n');

    // 6. If nothing changed, skip writing
    if (updated === original) {
      console.log('  ⚪ No changes needed');
      return;
    }

    // 7. Write back and reapply exec bit
    await Bun.write(filePath, updated);
    // Preserve executable permission
    Bun.spawnSync({
      cmd: ['chmod', '+x', filePath],
      stdout: 'inherit',
      stderr: 'inherit'
    });

    console.log('  ✅ File updated');
  } catch (err) {
    console.error(`  ❌ Error in ${filePath}:`, err);
  }
}

async function main() {
  console.log('🚀 Starting transform-docker-scripts codemod...');
  for await (const filePath of new Glob(SHELL_GLOB)) {
    await transformFile(filePath);
  }
  console.log('\n🎉 Completed all transformations.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});