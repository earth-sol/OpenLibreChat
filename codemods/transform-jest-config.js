#!/usr/bin/env bun
/**
 * codemods/transform-jest-config.js
 *
 * - Scans for all `api/jest.config.js` and `packages/\\*\\*\/jest.config.\\*` files
 * - Uses Bun’s native I/O (Bun.scandir, Bun.file, Bun.write) exclusively
 * - Applies a jscodeshift transformer to:
 *    • Remove `testEnvironment`, `transform`, and any existing `testMatch`
 *    • Inject a Bun‐friendly `testMatch` array
 *    • Preserve `setupFiles` and mocks
 *    • Anchor all `moduleNameMapper` keys (`^…$`)
 * - Emits verbose debug logs at every step (always on)
 */

import jscodeshift from 'jscodeshift';

function transformer(fileInfo, { jscodeshift: j }) {
  console.debug(`[transform-jest-config] ▶ Transforming ${fileInfo.path}`);

  const root = j(fileInfo.source);

  // Bun-friendly test globs
  const testPatterns = [
    '<rootDir>/api/test/**/*.{spec,test}.js',
    '<rootDir>/client/test/**/*.{spec,test}.tsx',
    '<rootDir>/packages/**/test/**/*.{spec,test}.{js,ts,tsx}',
    '<rootDir>/e2e/specs/**/*.{spec,test}.{js,ts}'
  ];

  function processConfig(objExpr) {
    console.debug(
      '[transform-jest-config] • original keys:',
      objExpr.properties.map(p => p.key.name || p.key.value)
    );

    // Strip unwanted props
    objExpr.properties = objExpr.properties.filter(prop => {
      const key =
        prop.key.type === 'Identifier' ? prop.key.name : prop.key.value;
      return !['testEnvironment', 'transform', 'testMatch'].includes(key);
    });

    console.debug(
      '[transform-jest-config] • pruned keys:',
      objExpr.properties.map(p => p.key.name || p.key.value)
    );

    // Inject testMatch
    objExpr.properties.push(
      j.property(
        'init',
        j.identifier('testMatch'),
        j.arrayExpression(testPatterns.map(pat => j.literal(pat)))
      )
    );

    console.debug(
      '[transform-jest-config] • injected testMatch:',
      testPatterns
    );

    // Anchor moduleNameMapper keys
    const mapperProp = objExpr.properties.find(prop => {
      const key =
        prop.key.type === 'Identifier' ? prop.key.name : prop.key.value;
      return key === 'moduleNameMapper';
    });

    if (mapperProp?.value.type === 'ObjectExpression') {
      mapperProp.value.properties.forEach(inner => {
        if (inner.key.type === 'Literal') {
          const original = inner.key.value;
          let anchored = String(original);
          if (!anchored.startsWith('^')) anchored = `^${anchored}`;
          if (!anchored.endsWith('$')) anchored = `${anchored}$`;
          inner.key.value = anchored;
          console.debug(
            `[transform-jest-config] • anchored "${original}" → "${anchored}"`
          );
        }
      });
    }
  }

  // Handle CommonJS: module.exports = { … }
  root
    .find(j.AssignmentExpression, {
      left: { object: { name: 'module' }, property: { name: 'exports' } }
    })
    .forEach(path => {
      console.debug('[transform-jest-config] ✔ Found CommonJS export');
      if (path.node.right.type === 'ObjectExpression') {
        processConfig(path.node.right);
      }
    });

  // Handle ESM: export default { … }
  root
    .find(j.ExportDefaultDeclaration, {
      declaration: { type: 'ObjectExpression' }
    })
    .forEach(path => {
      console.debug('[transform-jest-config] ✔ Found ESM export default');
      processConfig(path.node.declaration);
    });

  const output = root.toSource({ quote: 'single' });
  console.debug(
    `[transform-jest-config] ✔ Completed ${fileInfo.path}; output length ${output.length}`
  );
  return output;
}

async function run() {
  console.debug('[transform-jest-config] 🚀 Starting Bun-driven codemod scan');

  for await (const entry of Bun.scandir('.', { recursive: true })) {
    if (!entry.isFile) continue;
    const p = entry.path;

    // match api/jest.config.js exactly or any packages/**/jest.config.*
    if (
      p === 'api/jest.config.js' ||
      /^packages\/.+\/jest\.config\.(js|mjs|cjs)$/.test(p)
    ) {
      const src = await Bun.file(p).text();
      const transformed = transformer(
        { path: p, source: src },
        { jscodeshift }
      );

      if (transformed !== src) {
        await Bun.write(p, transformed);
        console.debug(`[transform-jest-config] ✔ Updated ${p}`);
      } else {
        console.debug(`[transform-jest-config] ○ No changes for ${p}`);
      }
    }
  }

  console.debug('[transform-jest-config] 🎉 All done');
}

if (import.meta.main) {
  run().catch(err => {
    console.error('[transform-jest-config] ❌ Error:', err);
    process.exit(1);
  });
}