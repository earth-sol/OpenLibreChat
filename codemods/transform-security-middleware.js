#!/usr/bin/env bun

/**
 * scripts/transform-security-middleware.js
 *
 * A Bun-native CLI codemod that converts Express security middleware
 * (helmet, express-rate-limit, express-mongo-sanitize) to Elysia plugins:
 *
 *  • Idempotent via "// bun: security-mw-updated" marker
 *  • Unified on jscodeshift.withParser('ts') for TS/JSX support
 *  • True alias detection for both ESM imports and CJS requires
 *  • Data-driven plugin mappings & hook stages via CLI flags
 *  • Merges import injection, option renames, and hook rewrites in one pass
 *  • Cleans up legacy imports/requires and unused modules
 *  • Supports --dry-run/-d, --quiet/-q, --root=<dir>, --sanitize-hook=<hookName>
 */

import { Glob } from 'bun';
import jscodeshiftPkg from 'jscodeshift';
import path from 'path';

const args               = Bun.argv.slice(1);
const dryRun             = args.includes('--dry-run') || args.includes('-d');
const quiet              = args.includes('--quiet')    || args.includes('-q');
const rootFlag           = args.find(a => a.startsWith('--root='));
const baseDir            = rootFlag ? rootFlag.split('=')[1] : process.cwd();
const sanitizeHookFlag   = args.find(a => a.startsWith('--sanitize-hook='));
const sanitizeHook       = sanitizeHookFlag ? sanitizeHookFlag.split('=')[1] : 'preHandler';

const log   = (...m) => !quiet && console.log(...m);
const debug = (...m) => !quiet && console.debug('[transform-security-mw]', ...m);

// Plugin definitions in desired insertion order
const plugins = [
  {
    pkg: '@elysia/helmet',
    importName: 'helmet',
    hook: 'onRequest',
    typeOnly: true,
    optionsRename: null
  },
  {
    pkg: '@elysia/rate-limit',
    importName: 'rateLimit',
    hook: 'onRequest',
    typeOnly: true,
    optionsRename: { windowMs: 'window', max: 'limit' }
  },
  {
    pkg: 'express-mongo-sanitize',
    importName: 'default',
    hook: sanitizeHook,
    typeOnly: false,
    optionsRename: null
  }
];

function removeImport(root, j, mod) {
  const imps = root.find(j.ImportDeclaration, { source: { value: mod } });
  if (imps.size()) { imps.remove(); debug(`removed import '${mod}'`); return true; }
  return false;
}

function removeRequire(root, j, mod) {
  const calls = root.find(j.CallExpression, {
    callee: { name: 'require' },
    arguments: [{ value: mod }]
  });
  if (calls.size()) {
    calls.forEach(p => j(p).parent.remove());
    debug(`removed require('${mod}')`);
    return true;
  }
  return false;
}

function findAlias(root, j, pkg, importName) {
  let alias = null;
  // ESM import
  root.find(j.ImportDeclaration, { source: { value: pkg } }).forEach(p => {
    p.node.specifiers.forEach(spec => {
      if (
        (importName === 'default' && spec.type === 'ImportDefaultSpecifier') ||
        (spec.type === 'ImportSpecifier' && spec.imported.name === importName)
      ) {
        alias = spec.local.name;
      }
    });
  });
  if (alias) return alias;
  // CJS require
  root.find(j.VariableDeclarator, {
    init: {
      type: 'CallExpression',
      callee: { name: 'require' },
      arguments: [{ value: pkg }]
    }
  }).forEach(p => {
    if (p.node.id.type === 'Identifier') alias = p.node.id.name;
  });
  return alias;
}

function transform(source, filePath) {
  if (source.includes('// bun: security-mw-updated')) return null;

  const j    = jscodeshiftPkg.withParser('ts');
  const root = j(source);
  let did    = false;

  debug('processing', filePath);

  // 1) idempotency marker
  root.get().node.program.body.unshift(
    j.expressionStatement(j.literal('// bun: security-mw-updated'))
  );
  did = true;

  // 2) detect plugin aliases & prepare import declarations
  const importDecls = [];
  plugins.forEach(plugin => {
    const { pkg, importName, typeOnly } = plugin;
    let id = findAlias(root, j, pkg, importName);
    plugin.alias = id;

    if (!id) {
      // generate a unique local name
      id = importName === 'default'
        ? pkg.split('/').pop()
        : importName;
      plugin.alias = id;

      // build import declaration
      const specifier = importName === 'default'
        ? j.importDefaultSpecifier(j.identifier(id))
        : j.importSpecifier(j.identifier(importName), j.identifier(id));

      const decl = j.importDeclaration([specifier], j.literal(pkg));
      if (typeOnly) decl.importKind = 'type';
      importDecls.push(decl);
      debug(`will insert import for '${pkg}' as '${id}'`);
    }
  });

  // 3) single AST pass: imports, option-renames, hook-rewrites
  root.find(j.Program).forEach(p => {
    j(p).visit({
      visitImportDeclaration(path) {
        // remove legacy imports
        plugins.forEach(({ pkg }) => {
          if (path.node.source.value === pkg) {
            path.prune();
            did = true;
            debug(`removed legacy import ${pkg}`);
          }
        });
        this.traverse(path);
      },

      visitVariableDeclarator(path) {
        // remove require(...) for legacy
        const init = path.node.init;
        if (
          init &&
          init.type === 'CallExpression' &&
          init.callee.name === 'require' &&
          typeof init.arguments[0]?.value === 'string'
        ) {
          const pkg = init.arguments[0].value;
          if (plugins.some(pl => pl.pkg === pkg)) {
            path.parent.prune();
            did = true;
            debug(`removed legacy require ${pkg}`);
            return false;
          }
        }
        this.traverse(path);
      },

      visitCallExpression(path) {
        const { node } = path;
        // plugin hook & option rename
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.property.name === 'use' &&
          node.arguments.length &&
          node.arguments[0].type === 'CallExpression'
        ) {
          const inner = node.arguments[0];
          const calleeName = inner.callee.name;

          const plugin = plugins.find(pl => pl.alias === calleeName);
          if (plugin) {
            did = true;
            // rename options if any
            if (plugin.optionsRename && inner.arguments[0]?.type === 'ObjectExpression') {
              inner.arguments[0].properties.forEach(prop => {
                if (prop.type === 'Property' && prop.key.type === 'Identifier') {
                  const newKey = plugin.optionsRename[prop.key.name];
                  if (newKey) {
                    prop.key.name = newKey;
                    debug(`renamed option ${prop.key.name} → ${newKey}`);
                  }
                }
              });
            }
            // rewrite app.use → app.<hook>
            const obj = node.callee.object;
            path.node.callee = j.memberExpression(
              obj,
              j.identifier(plugin.hook)
            );
            debug(`rewrote use → ${plugin.hook} for ${calleeName}`);
          }
        }
        this.traverse(path);
      }
    });
  });

  // 4) insert missing imports just after the marker
  if (importDecls.length) {
    const prog = root.get().node.program.body;
    const insertIdx = prog.findIndex(stmt =>
      stmt.type === 'ExpressionStatement' &&
      stmt.expression.value === '// bun: security-mw-updated'
    ) + 1;
    prog.splice(insertIdx, 0, ...importDecls);
    did = true;
  }

  // 5) clean up unused imports: path, url
  ['path','url'].forEach(mod => {
    removeImport(root, j, mod) || removeRequire(root, j, mod);
  });

  return did
    ? root.toSource({ quote:'single', trailingComma:true })
    : null;
}

async function main() {
  const pattern = path.join(baseDir, '**/*.{js,ts,tsx}');
  let processed = 0, failed = 0;

  for await (const filePath of new Glob([pattern])) {
    if (filePath.includes('node_modules') || filePath.endsWith('transform-security-middleware.js'))
      continue;

    let src;
    try { src = await Bun.file(filePath).text() }
    catch (e) {
      console.error('[security-mw] read failed:', filePath, e.message);
      failed++; continue;
    }

    let out;
    try { out = transform(src, filePath) }
    catch (e) {
      console.error('[security-mw] transform error in', filePath, e);
      failed++; continue;
    }

    processed++;
    if (!out) {
      debug('no changes:', filePath);
      continue;
    }

    if (dryRun) {
      log('DRY', filePath);
    } else {
      try {
        await Bun.write(filePath, out);
        log('✔', filePath);
      } catch (e) {
        console.error('[security-mw] write failed:', filePath, e.message);
        failed++;
      }
    }
  }

  log(`\ntransform-security-middleware: processed=${processed}, failed=${failed}`);
  if (failed) Bun.exit(1);
}

main().catch(e => {
  console.error('[security-mw] fatal:', e);
  Bun.exit(1);
});