#!/usr/bin/env bun

/**
 * scripts/transform-express-routes-to-elysia.js
 *
 * A Bun-native CLI codemod that converts Express Router modules into
 * Elysia instances, leveraging:
 *  • Idempotency via "// bun: express-routes-to-elysia-updated" marker
 *  • True alias detection for express & Router (ESM + CJS)
 *  • Removal of all express imports/requires & Node path imports
 *  • Full TS/JS support via jscodeshift.withParser('ts')
 *  • Collection of router.use(prefix, …middleware) into group prefix & preHandler
 *  • Collection of router.METHOD(path, …middleware, handler) into grouped routes
 *  • A single `router.group(prefix, grp => { … })` block per module
 *  • Hoisting of shared middleware into group.use(...)
 *  • Fallback to direct router.METHOD if no prefix
 *  • Insertion of `import { Elysia } from 'elysia'` and `const router = new Elysia()`
 *  • Export default router
 *  • CLI flags: --quiet, --dry-run
 *  • Bun.Glob & Bun.file/Bun.write for I/O
 */

import { Glob } from 'bun';
import jscodeshiftPkg from 'jscodeshift';

const args   = Bun.argv.slice(1);
const dryRun = args.includes('--dry-run') || args.includes('-d');
const quiet  = args.includes('--quiet')   || args.includes('-q');
const log    = (...m) => !quiet && console.log(...m);
const debug  = (...m) => console.debug('[transform-express-routes]', ...m);

/** Nullish-coalesce helper: a ?? Bun.env[envVar] ?? fallback */
function nullish(j, left, envVar, fallback) {
  return j.logicalExpression(
    '??',
    left,
    j.logicalExpression(
      '??',
      j.memberExpression(j.memberExpression(j.identifier('Bun'), j.identifier('env')), j.identifier(envVar)),
      j.literal(fallback)
    )
  );
}

async function main() {
  for await (const filePath of new Glob(['api/server/routes/**/*.{js,ts}'])) {
    if (filePath.includes('node_modules/') || filePath.endsWith('transform-express-routes-to-elysia.js'))
      continue;

    let src;
    try { src = await Bun.file(filePath).text(); }
    catch (e) { log(`read failed: ${filePath}`, e.message); continue; }

    let out;
    try { out = transform(src, filePath); }
    catch (e) { console.error('[transform-express-routes] error in', filePath, e); continue; }

    if (!out) {
      debug(`no changes: ${filePath}`);
      continue;
    }
    if (!dryRun) {
      try { await Bun.write(filePath, out); }
      catch (e) { log(`write failed: ${filePath}`, e.message); }
    }
    log(`${dryRun ? 'DRY' : '✔'} ${filePath}`);
  }
}

function transform(source, filePath) {
  // 0) Idempotency guard
  if (source.includes('// bun: express-routes-to-elysia-updated')) return null;

  // 1) Prepare jscodeshift with TS support
  const jscodeshift = jscodeshiftPkg.withParser('ts');
  const j = jscodeshift;
  const root = j(source);
  let did = false;

  debug('transforming', filePath);

  // 2) Insert marker
  root.get().node.program.body.unshift(
    j.expressionStatement(j.literal('// bun: express-routes-to-elysia-updated'))
  );
  did = true;

  // 3) Detect express & Router aliases, remove imports/requires
  let expressAlias = null, routerCtorAlias = null;
  // ESM express
  root.find(j.ImportDeclaration, { source: { value: 'express' } })
    .forEach(path => {
      path.node.specifiers.forEach(spec => {
        if (spec.type === 'ImportDefaultSpecifier') expressAlias = spec.local.name;
        if (spec.type === 'ImportSpecifier' && spec.imported.name === 'Router')
          routerCtorAlias = spec.local.name;
      });
      j(path).remove(); did = true;
    });
  // CJS express
  root.find(j.VariableDeclarator, {
    init: { callee: { name: 'require', arguments: [{ value: 'express' }] } }
  }).forEach(path => {
    const id = path.node.id;
    if (id.type === 'Identifier') expressAlias = id.name;
    else if (id.type === 'ObjectPattern') {
      id.properties.forEach(p => {
        if (p.key.name === 'Router') routerCtorAlias = p.value.name;
      });
    }
    j(path.parent).remove(); did = true;
  });
  expressAlias ||= 'express';
  routerCtorAlias ||= 'Router';

  // 4) Remove Node path module (optional)
  ['path','url'].forEach(mod => {
    root.find(j.ImportDeclaration, { source:{ value:mod }})
      .remove() && (did = true);
    root.find(j.VariableDeclarator, {
      init:{ callee:{ name:'require', arguments:[{value:mod}]}}
    }).remove() && (did = true);
  });

  // 5) Locate router binding: const X = express.Router() or Router()
  let routerVar = null;
  root.find(j.VariableDeclarator, {
    init: {
      type: 'CallExpression',
      callee: {
        type: 'MemberExpression',
        object: { name: expressAlias },
        property: { name: 'Router' }
      }
    }
  }).forEach(path => {
    routerVar = path.node.id.name;
    // replace RHS with `new Elysia()`
    path.node.init = j.newExpression(j.identifier('Elysia'), []);
    did = true;
  });
  // also Router() directly
  root.find(j.VariableDeclarator, {
    init:{ callee:{ name: routerCtorAlias }}
  }).forEach(path => {
    routerVar = path.node.id.name;
    path.node.init = j.newExpression(j.identifier('Elysia'), []);
    did = true;
  });
  if (!routerVar) {
    debug(`no Router() found in ${filePath}, skipping`);
    return did ? root.toSource({ quote:'single', trailingComma:true }) : null;
  }

  // 6) Import Elysia if missing
  if (!root.find(j.ImportDeclaration,{ source:{ value:'elysia' }}).size()) {
    root.get().node.program.body.unshift(
      j.importDeclaration(
        [ j.importSpecifier(j.identifier('Elysia')) ],
        j.literal('elysia')
      )
    );
    debug('import { Elysia } from \'elysia\'');
    did = true;
  }

  // 7) Collect router-level prefix & middleware
  const info = { prefix: '', middleware: [], routes: [] };
  root.find(j.CallExpression, {
    callee: {
      object: { name: routerVar },
      property: { name: 'use' }
    }
  }).forEach(path => {
    const args = path.node.arguments;
    let idx = 0;
    if (args[0]?.type === 'Literal') {
      info.prefix = args[0].value;
      idx = 1;
    }
    for (let i = idx; i < args.length; i++) {
      info.middleware.push(args[i]);
    }
    j(path).remove(); did = true;
  });

  // 8) Collect routes
  const methods = ['get','post','put','patch','delete','options','head'];
  root.find(j.CallExpression, {
    callee: {
      object:{ name: routerVar },
      property: p=> methods.includes(p.name)
    }
  }).forEach(path => {
    const method = path.node.callee.property.name;
    const args = path.node.arguments;
    const routePath = args[0];
    const handler = args[args.length - 1];
    const mws = args.slice(1, args.length - 1);
    info.routes.push({ method, routePath, middleware: mws, handler });
    j(path).remove(); did = true;
  });

  // 9) Remove module.exports = routerVar
  root.find(j.AssignmentExpression, {
    left: { object:{ name:'module' }, property:{ name:'exports' }}
  }).forEach(path => {
    j(path.parent).remove(); did = true;
  });

  // 10) Build group or direct routes
  const stmts = [];
  if (info.routes.length) {
    // if prefix or middleware, use router.group
    if (info.prefix || info.middleware.length) {
      const groupFnBody = [];
      // group.use for shared middleware
      if (info.middleware.length) {
        groupFnBody.push(
          j.expressionStatement(
            j.callExpression(
              j.memberExpression(j.identifier('grp'), j.identifier('use')),
              [ j.arrayExpression(info.middleware) ]
            )
          )
        );
      }
      // each route
      info.routes.forEach(r => {
        const args = [
          r.routePath,
          r.middleware.length
            ? j.objectExpression([
                j.property('init', j.identifier('preHandler'), j.arrayExpression(r.middleware)),
                j.property('init', j.identifier('handler'), r.handler)
              ])
            : r.handler
        ];
        groupFnBody.push(
          j.expressionStatement(
            j.callExpression(
              j.memberExpression(j.identifier('grp'), j.identifier(r.method)),
              args
            )
          )
        );
      });
      // router.group(prefix, grp => { ... })
      stmts.push(
        j.expressionStatement(
          j.callExpression(
            j.memberExpression(j.identifier(routerVar), j.identifier('group')),
            [
              j.literal(info.prefix),
              j.arrowFunctionExpression(
                [ j.identifier('grp') ],
                j.blockStatement(groupFnBody)
              )
            ]
          )
        )
      );
    } else {
      // direct router.METHOD
      info.routes.forEach(r => {
        const args = [
          r.routePath,
          r.middleware.length
            ? j.objectExpression([
                j.property('init', j.identifier('preHandler'), j.arrayExpression(r.middleware)),
                j.property('init', j.identifier('handler'), r.handler)
              ])
            : r.handler
        ];
        stmts.push(
          j.expressionStatement(
            j.callExpression(
              j.memberExpression(j.identifier(routerVar), j.identifier(r.method)),
              args
            )
          )
        );
      });
    }
  }

  // 11) Insert generated statements after routerVar declaration
  const decl = root.find(j.VariableDeclarator, { id: { name: routerVar } }).at(0);
  if (decl.size()) {
    const p = decl.get();
    stmts.reverse().forEach(s => {
      j(p).parent.insertAfter(s);
    });
    did = true;
  }

  // 12) Export default routerVar
  if (!root.find(j.ExportDefaultDeclaration).size()) {
    root.get().node.program.body.push(
      j.exportDefaultDeclaration(j.identifier(routerVar))
    );
    did = true;
  }

  return did
    ? root.toSource({ quote:'single', trailingComma:true })
    : null;
}

main().catch(e => {
  console.error('[transform-express-routes] fatal:', e);
  Bun.exit(1);
});