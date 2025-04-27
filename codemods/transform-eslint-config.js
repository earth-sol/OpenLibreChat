#!/usr/bin/env bun
/**
 * codemods/transform-eslint-config.js
 *
 * - Recursively scans via Bun.scandir()
 * - Filters for .eslintrc.{js,cjs,mjs,json} & eslint.config.{js,mjs}
 * - Reads with Bun.file().text(), stats with Bun.stat()
 * - Writes with Bun.write()
 * - Uses jscodeshift for AST transforms on JS/MJS/CJS and JSON
 * - Always emits debug output
 * - Supports --dry-run
 */

import { scandir, stat, file, write } from 'bun';
import jscodeshift from 'jscodeshift';

// Names of ESLint config files to process
const CONFIG_FILES = new Set([
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.mjs',
  '.eslintrc.json',
  'eslint.config.js',
  'eslint.config.mjs'
]);

// Always verbose/debug by default
const DEBUG = true;
// Pass --dry-run to preview without writing
const DRY   = process.argv.includes('--dry-run');

function log(...args) {
  if (DEBUG) console.debug('[eslint-codemod]', ...args);
}

// Recursively find all matching config files
async function collectConfigs() {
  const paths = [];
  for await (const entry of scandir('.', { recursive: true })) {
    if (!entry.isFile) continue;
    if (!CONFIG_FILES.has(entry.name)) continue;

    // Double-check with stat
    try {
      const info = await stat(entry.path);
      if (info.isFile()) {
        paths.push(entry.path);
      } else {
        log(`Skipped non-file: ${entry.path}`);
      }
    } catch (e) {
      log(`Stat failed (${entry.path}):`, e.message);
    }
  }
  return paths;
}

// Transform a JSON-based ESLint config
function transformJSON(source, p) {
  let cfg;
  try {
    cfg = JSON.parse(source);
  } catch (e) {
    log(`⛔ JSON parse error (${p}):`, e.message);
    return null;
  }

  // parserOptions
  cfg.parserOptions         ||= {};
  cfg.parserOptions.ecmaVersion = 2022;
  cfg.parserOptions.sourceType  = 'module';

  // globals
  cfg.globals ||= {};
  delete cfg.globals.node;
  delete cfg.globals.commonjs;
  cfg.globals.Bun           = 'readonly';
  cfg.globals['import.meta']= 'readonly';

  // strip node/ rules
  if (cfg.rules) {
    for (const k of Object.keys(cfg.rules)) {
      if (k.startsWith('node/')) {
        delete cfg.rules[k];
        log(`  – removed rule ${k}`);
      }
    }
  }

  // strip node extends/plugins
  if (Array.isArray(cfg.extends)) {
    cfg.extends = cfg.extends.filter(e => !/node/.test(e));
  }
  if (Array.isArray(cfg.plugins)) {
    cfg.plugins = cfg.plugins.filter(p => p !== 'node');
  }

  log(`✅ JSON transformed: ${p}`);
  return JSON.stringify(cfg, null, 2) + '\n';
}

// Transform a JS/MJS/CJS ESLint config via AST
function transformJS(source, p) {
  const j = jscodeshift;
  let root;
  try {
    root = j(source);
  } catch (e) {
    log(`⛔ JS parse error (${p}):`, e.message);
    return null;
  }

  const nameOf = key => key.type === 'Identifier' ? key.name : key.value;

  function findOrCreate(obj, key, makeNode) {
    let prop = obj.properties.find(x => nameOf(x.key) === key);
    if (!prop) {
      prop = j.property('init', j.identifier(key), makeNode());
      obj.properties.push(prop);
    }
    return prop;
  }

  function ensure(obj, key, literal) {
    if (!obj.properties.some(x => nameOf(x.key) === key)) {
      obj.properties.push(
        j.property(
          'init',
          /^\w+$/.test(key) ? j.identifier(key) : j.literal(key),
          literal
        )
      );
    }
  }

  function mutate(objExpr) {
    // parserOptions
    const pOpt = findOrCreate(objExpr, 'parserOptions', () => j.objectExpression([])).value;
    pOpt.properties = pOpt.properties.filter(p => !['ecmaVersion','sourceType'].includes(nameOf(p.key)));
    pOpt.properties.push(j.property('init', j.identifier('ecmaVersion'), j.literal(2022)));
    pOpt.properties.push(j.property('init', j.identifier('sourceType'),  j.literal('module')));

    // globals
    const glb = findOrCreate(objExpr, 'globals', () => j.objectExpression([])).value;
    glb.properties = glb.properties.filter(prop => {
      return !(
        prop.type === 'SpreadElement' &&
        prop.argument.type === 'MemberExpression' &&
        ['node','commonjs'].includes(prop.argument.property.name)
      );
    });
    ensure(glb, 'Bun',         j.literal('readonly'));
    ensure(glb, 'import.meta', j.literal('readonly'));

    // rules
    const rulesProp = objExpr.properties.find(p => nameOf(p.key) === 'rules');
    if (rulesProp && rulesProp.value.type === 'ObjectExpression') {
      rulesProp.value.properties = rulesProp.value.properties.filter(r =>
        !nameOf(r.key).startsWith('node/')
      );
    }

    // extends
    const extProp = objExpr.properties.find(p => nameOf(p.key) === 'extends');
    if (extProp && extProp.value.type === 'ArrayExpression') {
      extProp.value.elements = extProp.value.elements.filter(el =>
        !(el.value && typeof el.value === 'string' && /node/.test(el.value))
      );
    }

    // plugins
    const plugProp = objExpr.properties.find(p => nameOf(p.key) === 'plugins');
    if (plugProp) {
      if (plugProp.value.type === 'ArrayExpression') {
        plugProp.value.elements = plugProp.value.elements.filter(e => e.value !== 'node');
      } else if (plugProp.value.type === 'ObjectExpression') {
        plugProp.value.properties = plugProp.value.properties.filter(pr =>
          nameOf(pr.key) !== 'node'
        );
      }
    }
  }

  // handle export default [...]
  root.find(jscodeshift.ExportDefaultDeclaration).forEach(path => {
    const d = path.node.declaration;
    if (d.type === 'ArrayExpression') {
      d.elements.forEach(el => el.type === 'ObjectExpression' && mutate(el));
    } else if (d.type === 'ObjectExpression') {
      mutate(d);
    }
  });

  // handle module.exports = {…}
  root.find(jscodeshift.AssignmentExpression, {
    left: { object: { name: 'module' }, property: { name: 'exports' } }
  }).forEach(path => {
    if (path.node.right.type === 'ObjectExpression') {
      mutate(path.node.right);
    }
  });

  log(`✅ JS transformed: ${p}`);
  return root.toSource({ quote: 'single', trailingComma: true });
}

async function main() {
  log('Starting ESLint codemod -- Bun version:', Bun.version);
  const files = await collectConfigs();

  if (!files.length) {
    console.warn('⚠️  No ESLint config files found.');
    return;
  }
  log('Configs found:', files);

  for (const p of files) {
    try {
      const src = await file(p).text();
      const out = p.endsWith('.json')
        ? transformJSON(src, p)
        : transformJS(src, p);

      if (out && out !== src) {
        if (DRY) {
          log(`[dry-run] would update: ${p}`);
        } else {
          await write(p, out);
          console.log(`Updated ${p}`);
        }
      } else {
        log(`No changes: ${p}`);
      }
    } catch (err) {
      console.error(`Error on ${p}:`, err);
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});