#!/usr/bin/env bun
/**
 * codemods/transform-dockerfile.js
 *
 * AST-driven Dockerfile transformer using dockerfile-ast, fully Bun-native,
 * with verbose debug logging.
 */

import { DockerfileParser } from 'dockerfile-ast'; // AST parser for Dockerfiles

/**
 * Recursively yield any Dockerfile or Dockerfile.multi under the given directory.
 */
async function* findDockerfiles(dir) {
  for await (const entry of Bun.scandir(dir)) {
    if (entry.isFile) {
      if (entry.name === 'Dockerfile' || entry.name === 'Dockerfile.multi') {
        yield entry.path;
      }
    } else if (entry.isDirectory) {
      yield* findDockerfiles(entry.path);
    }
  }
}

/**
 * Parse, transform, and write back one Dockerfile.
 */
async function transformFile(filePath) {
  console.log(`\n[DEBUG] Transforming ${filePath}`);

  // 1. Read content
  console.log(`[DEBUG] Reading file`);
  const original = await Bun.file(filePath).text();

  // 2. Parse AST
  console.log(`[DEBUG] Parsing AST`);
  const df = DockerfileParser.parse(original);

  // 3. Build a list of edits
  const edits = [];
  for (const instr of df.getInstructions()) {
    const kw = instr.getKeyword().toUpperCase();
    const { start, end } = instr.getRange();
    const snippet = original.slice(start.offset, end.offset).replace(/\n/g, '\\n');

    console.log(`[DEBUG] Instruction: ${kw} @ ${start.offset}-${end.offset}`);
    console.log(`[DEBUG] Raw snippet: "${snippet}"`);

    // FROM → oven/bun:edge-alpine
    if (kw === 'FROM') {
      const args = instr.getArguments();
      if (args.length) {
        const nextArgEnd = args[1]?.getRange().end.offset ?? end.offset;
        const tail = original.slice(nextArgEnd, end.offset);
        const replacement = `oven/bun:edge-alpine${tail}`;
        edits.push({
          start: args[0].getRange().start.offset,
          end: end.offset,
          content: replacement
        });
        console.log(`[DEBUG]   → Replacing FROM image with "${replacement}"`);
      }
    }

    // RUN → map npm|yarn to bun commands
    else if (kw === 'RUN') {
      console.log(`[DEBUG] Handling RUN`);
      const body = original.slice(start.offset, end.offset).replace(/^RUN\s+/i, '');
      const parts = body
        .split(/(\s+&&\s+|\s*;\s*)/)
        .map(s => s.trim())
        .filter(s => s && !/^(?:&&|;)$/.test(s));

      console.log(`[DEBUG]   RUN segments:`, parts);
      const mapped = parts.map(cmd => {
        if (/^(?:npm|yarn)\b/.test(cmd)) {
          if (/install\b/.test(cmd)) {
            console.log(`[DEBUG]     → install → bun install --production`);
            return 'bun install --production';
          }
          if (/prune\b/.test(cmd)) {
            console.log(`[DEBUG]     → prune → bun prune --production`);
            return 'bun prune --production';
          }
          if (/\b(?:run\s+)?build\b/.test(cmd)) {
            console.log(`[DEBUG]     → build → bun run scripts/bun-build-all.js`);
            return 'bun run scripts/bun-build-all.js';
          }
        }
        return cmd;
      });

      const replacement = 'RUN ' + mapped.join(' && ');
      edits.push({ start: start.offset, end: end.offset, content: replacement });
      console.log(`[DEBUG]   → New RUN: "${replacement}"`);
    }

    // CMD / ENTRYPOINT → bun run ...
    else if (kw === 'CMD' || kw === 'ENTRYPOINT') {
      console.log(`[DEBUG] Handling ${kw}`);
      let replacement;

      // Exec-form detection
      if (instr.getExecArgs) {
        const args = instr.getExecArgs();
        if (Array.isArray(args) && args[0] === 'node') {
          const newArgs = JSON.stringify(['bun', 'run', ...args.slice(1)]);
          replacement = `${kw} ${newArgs}`;
          console.log(`[DEBUG]   Exec-form swap: ${replacement}`);
        }
      }

      // Shell-form fallback
      if (!replacement) {
        const shellCmd = original
          .slice(start.offset + kw.length, end.offset)
          .trim()
          .replace(/"/g, '\\"');
        replacement = `${kw} ["bun","run","${shellCmd}"]`;
        console.log(`[DEBUG]   Shell-form wrap: ${replacement}`);
      }

      edits.push({ start: start.offset, end: end.offset, content: replacement });
    }

    else {
      console.log(`[DEBUG] No transform for ${kw}`);
    }
  }

  // 4. Apply edits
  if (edits.length) {
    console.log(`[DEBUG] Applying ${edits.length} edits`);
    edits.sort((a, b) => b.start - a.start);
    let updated = original;
    for (const { start, end, content } of edits) {
      updated = updated.slice(0, start) + content + updated.slice(end);
    }

    console.log(`[DEBUG] Writing updated content`);
    await Bun.write(filePath, updated);
    console.log(`[DEBUG] Finished writing`);
  } else {
    console.log(`[DEBUG] No edits needed`);
  }
}

/**
 * Entrypoint: scan & transform all Dockerfiles.
 */
async function main() {
  console.log('[DEBUG] Scanning for Dockerfiles...');
  for await (const filePath of findDockerfiles(process.cwd())) {
    await transformFile(filePath);
  }
  console.log('\n🎉 [DEBUG] All transforms complete');
}

main().catch(err => {
  console.error('[ERROR]', err);
  process.exit(1);
});