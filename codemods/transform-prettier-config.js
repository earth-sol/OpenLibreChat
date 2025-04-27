#!/usr/bin/env bun
/**
 * codemods/transform-prettier-config.js
 *
 * Pure Bun-native jscodeshift transformer (no Node imports).
 * Ensures in any Prettier config:
 *   • singleQuote: true
 *   • semi: true
 *   • bracketSpacing: true
 *   • a TS/TSX override with parser="typescript"
 *
 * Idempotent and logs debug/info to the console.
 */

import jscodeshift from 'jscodeshift'

export default function transformer(fileInfo, api) {
  const { path: filePath, source } = fileInfo;
  // support either api.jscodeshift or imported one
  const j = api.jscodeshift || jscodeshift;
  const printOpts = { quote: 'single', trailingComma: true };

  console.debug(`[transform-prettier-config] ▶️  Processing ${filePath}`);

  // Is it JSON? (.prettierrc or *.json)
  const name = filePath.split('/').pop();
  const isJson = name === '.prettierrc' || name.toLowerCase().endsWith('.json');

  if (isJson) {
    // ---- JSON-based config ----
    let cfg;
    try {
      cfg = JSON.parse(source);
    } catch (err) {
      console.error(`[transform-prettier-config] ❌ JSON parse error in ${filePath}: ${err.message}`);
      return null;
    }

    let changed = false;
    // enforce core options
    if (cfg.singleQuote    !== true) { cfg.singleQuote    = true;    changed = true }
    if (cfg.semi           !== true) { cfg.semi           = true;    changed = true }
    if (cfg.bracketSpacing !== true) { cfg.bracketSpacing = true;    changed = true }

    // ensure overrides array exists
    if (!Array.isArray(cfg.overrides)) {
      cfg.overrides = []; changed = true;
    }

    // prepare TS override
    const tsOverride = {
      files: ['*.ts','*.tsx','*.mts','*.cts'],
      options: { parser: 'typescript' }
    };

    const hasTs = cfg.overrides.some(o =>
      Array.isArray(o.files) &&
      o.files.some(f => f.endsWith('.ts') || f.endsWith('.tsx'))
    );

    if (!hasTs) {
      cfg.overrides.push(tsOverride);
      changed = true;
    } else {
      // enforce parser in existing override
      cfg.overrides = cfg.overrides.map(o => {
        if (Array.isArray(o.files) &&
            o.files.some(f => f.endsWith('.ts')||f.endsWith('.tsx')) &&
            o.options?.parser !== 'typescript'
        ) {
          return { ...o, options: { ...o.options, parser: 'typescript' } };
        }
        return o;
      });
    }

    if (changed) {
      console.info(`[transform-prettier-config] ✔ Updated JSON: ${filePath}`);
      return JSON.stringify(cfg, null, 2) + '\n';
    } else {
      console.debug(`[transform-prettier-config] ✅ No change JSON: ${filePath}`);
      return null;
    }
  }

  // ---- JS-based config ----
  let root;
  try {
    root = j(source);
  } catch (err) {
    console.error(`[transform-prettier-config] ❌ AST parse error in ${filePath}: ${err.message}`);
    return null;
  }

  // locate the object literal
  let objPath = null;
  // module.exports = { ... }
  root.find(j.AssignmentExpression, {
    left: { object: { name: 'module' }, property: { name: 'exports' } }
  }).forEach(p => {
    if (p.node.right.type === 'ObjectExpression') {
      objPath = p.get('right');
    }
  });
  // export default { ... }
  if (!objPath) {
    root.find(j.ExportDefaultDeclaration).forEach(p => {
      if (p.node.declaration.type === 'ObjectExpression') {
        objPath = p.get('declaration');
      }
    });
  }

  if (!objPath) {
    console.debug(`[transform-prettier-config] ✅ No config object in: ${filePath}`);
    return null;
  }

  let mutated = false;

  // helper: set or update a property
  const setProp = (key, valNode) => {
    const props = objPath.node.properties;
    const existing = props.find(p =>
      ((p.key.type==='Identifier' && p.key.name===key) ||
       (p.key.type==='Literal'    && p.key.value===key))
    );
    if (existing) {
      const oldSrc = j(existing.value).toSource();
      const newSrc = j(valNode).toSource();
      if (oldSrc !== newSrc) {
        existing.value = valNode;
        mutated = true;
      }
    } else {
      props.unshift(j.property('init', j.identifier(key), valNode));
      mutated = true;
    }
  };

  // enforce defaults
  setProp('singleQuote',    j.literal(true));
  setProp('semi',           j.literal(true));
  setProp('bracketSpacing', j.literal(true));

  // AST node for TS override
  const tsOverrideNode = j.objectExpression([
    j.property('init', j.identifier('files'),
      j.arrayExpression(
        ['*.ts','*.tsx','*.mts','*.cts'].map(str => j.literal(str))
      )
    ),
    j.property('init', j.identifier('options'),
      j.objectExpression([
        j.property('init', j.identifier('parser'), j.literal('typescript'))
      ])
    )
  ]);

  // find existing overrides array
  const overridesProp = objPath.node.properties.find(p =>
    ((p.key.type==='Identifier' && p.key.name==='overrides') ||
     (p.key.type==='Literal'    && p.key.value==='overrides')) &&
    p.value.type==='ArrayExpression'
  );

  if (overridesProp) {
    const arr = overridesProp.value.elements;
    let found = false;
    arr.forEach(el => {
      if (el?.type === 'ObjectExpression') {
        const filesProp = el.properties.find(p =>
          ((p.key.type==='Identifier' && p.key.name==='files') ||
           (p.key.type==='Literal'    && p.key.value==='files')) &&
          p.value.type==='ArrayExpression'
        );
        if (filesProp &&
            filesProp.value.elements.some(f => /\.tsx?$/.test(f.value))
        ) {
          found = true;
          // ensure parser exists
          const opts = el.properties.find(p =>
            ((p.key.type==='Identifier' && p.key.name==='options') ||
             (p.key.type==='Literal'    && p.key.value==='options'))
          );
          if (opts && opts.value.type==='ObjectExpression') {
            const hasParser = opts.value.properties.some(p =>
              ((p.key.type==='Identifier' && p.key.name==='parser') ||
               (p.key.type==='Literal'    && p.key.value==='parser'))
            );
            if (!hasParser) {
              opts.value.properties.push(
                j.property('init', j.identifier('parser'), j.literal('typescript'))
              );
              mutated = true;
            }
          }
        }
      }
    });
    if (!found) {
      arr.push(tsOverrideNode);
      mutated = true;
    }
  } else {
    objPath.node.properties.unshift(
      j.property('init', j.identifier('overrides'),
        j.arrayExpression([tsOverrideNode])
      )
    );
    mutated = true;
  }

  if (!mutated) {
    console.debug(`[transform-prettier-config] ✅ No change JS: ${filePath}`);
    return null;
  }

  console.info(`[transform-prettier-config] ✔ Updated JS: ${filePath}`);
  return root.toSource(printOpts);
}