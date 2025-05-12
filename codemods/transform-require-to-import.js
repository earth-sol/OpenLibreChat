#!/usr/bin/env bun

/**
 * scripts/transform-require-to-import.js
 *
 * A Bun-native CLI that:
 *  • Scans all .js/.ts files (skipping node_modules)
 *  • Uses jscodeshift purely for AST transforms
 *  • Uses Bun core APIs for file I/O & globbing
 *  • Swaps CommonJS → ESM with full semantics:
 *      - `const X = require('mod')`           → `import X from 'mod'`
 *      - `const { a, b: c } = require('mod')` → `import { a, b as c } from 'mod'`
 *      - `require('side-effect')`             → `import 'side-effect'`
 *      - `require('mod').prop`                → default or namespace import + `.prop`
 *      - `module.exports = X`                 → `export default X`
 *      - `exports.foo = Y`                    → `export const foo = Y`
 *      - dynamic `require(expr)`              → `await import(expr)`
 *      - `require.resolve(...)`               → `import.meta.resolve(...)`
 *      - `__dirname` / `__filename`           → `import.meta.dir` / `import.meta.url`
 *      - Node built-ins (`fs`, `path`, `url`, `util`) → `bun:…` imports
 *  • Debug logging always on; fails gracefully
 *
 * Usage:
 *   ./scripts/transform-require-to-import.js [--dry-run] [--quiet]
 */

import { Glob } from 'bun';
import jscodeshift from 'jscodeshift';

const args   = Bun.argv.slice(1);
const dryRun = args.includes('--dry-run') || args.includes('-d');
const quiet  = args.includes('--quiet')   || args.includes('-q');
const log    = (...m) => !quiet && console.log(...m);
const debug  = (...m) => console.debug('[transform-require]', ...m);

// ------ Alias helper ----------------------------------------------------------
const aliasCounts = {};
function makeAlias(name) {
  let base = name.replace(/[^A-Za-z0-9_$]/g, '_').replace(/^(\d)/, '_$1');
  if (!base) base = '_mod';
  aliasCounts[base] = (aliasCounts[base] || 0) + 1;
  return aliasCounts[base] === 1 ? base : `${base}_${aliasCounts[base]}`;
}

// ------ AST transformer ------------------------------------------------------
function transformer(fileInfo, { jscodeshift: j }) {
  const src  = fileInfo.source;
  const root = j(src);
  let did = false;

  debug('processing', fileInfo.path);

  // Built-ins remap
  const builtIns = {
    fs:   { mod:'bun:fs',   named:['file','write','readableStreamToText'] },
    path: { mod:'bun:path', named:['dirname','fromFileUrl'] },
    url:  { mod:'bun:url',  named:['pathToFileURL','fileURLToPath'] },
    util: { mod:'bun:util', named:['inspect'] },
  };
  root.find(j.ImportDeclaration).forEach(p => {
    const m = p.node.source.value;
    if (builtIns[m]) {
      const { mod, named } = builtIns[m];
      const specs = named.map(n => j.importSpecifier(j.identifier(n)));
      p.replace(j.importDeclaration(specs, j.literal(mod)));
      debug(`remapped built-in '${m}' → '${mod}'`);
      did = true;
    }
  });

  // __dirname / __filename
  root.find(j.Identifier, { name:'__dirname' })
      .replaceWith(j.memberExpression(
        j.metaProperty(j.identifier('import'), j.identifier('meta')),
        j.identifier('dir')
      )) && (did = true);
  root.find(j.Identifier, { name:'__filename' })
      .replaceWith(j.memberExpression(
        j.metaProperty(j.identifier('import'), j.identifier('meta')),
        j.identifier('url')
      )) && (did = true);

  // Collect imports
  const importMap = new Map(); // mod→{default,spec:Set,alias?}
  const newImports = [];

  // 1) Side-effect require('mod')
  root.find(j.CallExpression, {
    callee: { name:'require' },
    arguments:[{ type:'Literal' }]
  })
  .filter(p=>p.parent.value.type==='ExpressionStatement')
  .forEach(p=>{
    const mod = p.node.arguments[0].value;
    importMap.set(mod, { default:false, spec:new Set(), alias:null });
    newImports.push(j.importDeclaration([], j.literal(mod)));
    debug(`side-effect import '${mod}'`);
    j(p).remove();
    did = true;
  });

  // 2) const/let X = require('mod') or destructure
  root.find(j.VariableDeclarator)
    .filter(p=>
      p.node.init?.type==='CallExpression' &&
      p.node.init.callee.name==='require' &&
      p.node.init.arguments.length===1 &&
      p.node.init.arguments[0].type==='Literal'
    )
    .forEach(p=>{
      const mod = p.node.init.arguments[0].value;
      let info = importMap.get(mod) || { default:false, spec:new Set(), alias:null };
      importMap.set(mod, info);

      if (p.node.id.type==='ObjectPattern') {
        for (const prop of p.node.id.properties) {
          const imp = prop.key.name, loc = prop.value.name;
          info.spec.add(JSON.stringify({imp,loc}));
        }
        debug(`named import {${[...info.spec].map(s=>JSON.parse(s).imp).join(',')}} from '${mod}'`);
      } else {
        info.default = true;
        info.local   = p.node.id.name;
        debug(`default import '${info.local}' from '${mod}'`);
      }
      j(p).remove(); did = true;
    });

  // 3) require('mod').prop
  root.find(j.MemberExpression, {
    object:{
      type:'CallExpression',
      callee:{name:'require'},
      arguments:[{type:'Literal'}]
    }
  }).forEach(p=>{
    const mod = p.node.object.arguments[0].value;
    let info = importMap.get(mod) || { default:false, spec:new Set(), alias:null };
    importMap.set(mod, info);

    const prop = p.node.property.name;
    if (info.default) {
      j(p).replaceWith(j.memberExpression(j.identifier(info.local), j.identifier(prop)));
      debug(`default import.${prop}`);
    } else {
      const alias = info.alias || (info.alias = makeAlias(mod));
      j(p).replaceWith(j.memberExpression(j.identifier(alias), j.identifier(prop)));
      debug(`namespace import ${alias}.${prop}`);
    }
    did = true;
  });

  // 4) Dynamic require → await import
  root.find(j.CallExpression, { callee:{name:'require'} })
    .filter(p=>!p.node.arguments[0]||p.node.arguments[0].type!=='Literal')
    .forEach(p=>{
      j(p).replaceWith(j.awaitExpression(j.callExpression(j.identifier('import'), p.node.arguments)));
      debug('dynamic require → await import');
      did = true;
    });

  // 5) require.resolve → import.meta.resolve
  root.find(j.CallExpression, {
    callee:{
      type:'MemberExpression',
      object:{name:'require'},
      property:{name:'resolve'}
    }
  }).forEach(p=>{
    j(p).replaceWith(
      j.callExpression(
        j.memberExpression(
          j.metaProperty(j.identifier('import'), j.identifier('meta')),
          j.identifier('resolve')
        ),
        p.node.arguments
      )
    );
    debug('require.resolve → import.meta.resolve');
    did = true;
  });

  // 6) module.exports → export default
  root.find(j.AssignmentExpression, {
    left:{object:{name:'module'},property:{name:'exports'}}
  }).forEach(p=>{
    j(p.parent).replaceWith(j.exportDefaultDeclaration(p.node.right));
    debug('module.exports → export default');
    did = true;
  });

  // 7) exports.foo = Y → export const foo=Y
  root.find(j.AssignmentExpression, {
    left:{object:{name:'exports'},property:{type:'Identifier'}}
  }).forEach(p=>{
    const nm = p.node.left.property.name;
    const ed = j.exportNamedDeclaration(
      j.variableDeclaration('const',[
        j.variableDeclarator(j.identifier(nm), p.node.right)
      ]),[]
    );
    j(p.parent).replaceWith(ed);
    debug(`exports.${nm} → export const ${nm}`);
    did = true;
  });

  // 8) Build final import declarations
  importMap.forEach((info,mod)=>{
    if (!info.node) {
      const specs = [];
      if (info.default) specs.push(j.importDefaultSpecifier(j.identifier(info.local)));
      for (const s of info.spec) {
        const {imp,loc} = JSON.parse(s);
        specs.push(j.importSpecifier(j.identifier(imp), j.identifier(loc)));
      }
      if (!info.default && info.alias) specs.push(j.importNamespaceSpecifier(j.identifier(info.alias)));
      newImports.push(j.importDeclaration(specs, j.literal(mod)));
      debug(`import for '${mod}'`);
    }
  });

  // 9) Prepend after any 'use strict'
  if (newImports.length) {
    const bd = root.get().node.program.body;
    let idx = bd.findIndex(n=>
      n.type!=='ImportDeclaration' &&
      !(n.type==='ExpressionStatement'&&n.expression.value==='use strict')
    );
    if(idx<0)idx=0;
    bd.splice(idx,0,...newImports);
    debug(`inserted ${newImports.length} import(s)`);
    did = true;
  }

  return did ? root.toSource({quote:'single',trailingComma:true}) : null;
}

// ------ Runner ----------------------------------------------------------------------------------
async function main() {
  for await (const f of new Glob(['**/*.js','**/*.ts'])) {
    if (f.includes('node_modules/')) continue;
    let src;
    try { src = await Bun.file(f).text(); }
    catch(e){ log(`read fail: ${f}`, e.message); continue; }
    const out = transformer({ source: src, path: f }, { jscodeshift });
    if (!out) { debug(`no change: ${f}`); continue; }
    if (!dryRun) {
      try { await Bun.write(f, out); }
      catch(e){ log(`write fail: ${f}`, e.message); }
    }
    log(`${dryRun? 'DRY':'✔'} ${f}`);
  }
}

main().catch(e=>{
  console.error('[transform-require-to-import] fatal:', e);
  Bun.exit(1);
});