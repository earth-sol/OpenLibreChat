#!/usr/bin/env bun

/**
 * scripts/transform-server-index.js
 *
 * A Bun-native CLI that transforms your Express-based `api/server/index.js`
 * into a Bun+Elysia setup, with:
 *  • Idempotency marker
 *  • Removal of dotenv, module-alias, express import
 *  • Path.join → URL…pathname (literals) + fallback
 *  • fs.readFileSync/writeFileSync/existsSync → Bun.file().text()/Bun.write()/Bun.file().exists()
 *  • CJS require(...) → ESM import ... from '...'
 *  • Import { Elysia } from 'elysia'; new Elysia({ bodyLimit: Bun.env.BODY_LIMIT ?? '3mb' })
 *  • Drop express.json()/urlencoded()
 *  • cookieParser → app.use(cookie())
 *  • mongoSanitize → app.hook('preHandler', mongoSanitize())
 *  • staticCache → app.static(dir, { maxAge: Number(Bun.env.STATIC_CACHE_S_MAX_AGE) })
 *  • noIndex → app.hook('onRequest', noIndex)
 *  • errorController → app.onError(errorController)
 *  • app.listen → await app.listen({ port, hostname: host })
 *  • await startServer()
 *  • Remap built-ins (fs, path, url, util) → bun:… modules
 *  • Debug logging on; can silence with --quiet
 *
 * Usage:
 *   ./scripts/transform-server-index.js [--dry-run] [--quiet]
 */

import { Glob } from 'bun';
import jscodeshift from 'jscodeshift';

const args   = Bun.argv.slice(1);
const dryRun = args.includes('--dry-run') || args.includes('-d');
const quiet  = args.includes('--quiet')   || args.includes('-q');
const log    = (...m) => !quiet && console.log(...m);
const debug  = (...m) => console.debug('[transform-server-index]', ...m);

function addImport(root, specifiers, source) {
  if (!root.find(jscodeshift.ImportDeclaration, { source: { value: source } }).size()) {
    const imp = jscodeshift.importDeclaration(specifiers, jscodeshift.literal(source));
    root.get().node.program.body.unshift(imp);
    debug(`import '${source}'`);
    return true;
  }
  return false;
}

function transformer(source, filePath) {
  if (source.includes('// bun: server-index-updated')) {
    debug(`skipping already transformed: ${filePath}`);
    return null;
  }

  const j = jscodeshift;
  const root = j(source);
  let didTransform = false;

  debug('transforming', filePath);

  // 0) Idempotency marker
  root.get().node.program.body.unshift(
    j.expressionStatement(j.literal('// bun: server-index-updated'))
  );

  // 1) Drop dotenv & module-alias
  root
    .find(j.CallExpression, {
      callee: {
        object: { callee: { name: 'require', arguments: [{ value: 'dotenv' }] } },
        property: { name: 'config' }
      }
    })
    .remove() && (didTransform = true);

  root
    .find(j.CallExpression, {
      callee: { name: 'require', arguments: [{ value: 'module-alias' }] }
    })
    .remove() && (didTransform = true);

  // 2) Drop express import/require
  root.find(j.ImportDeclaration, { source: { value: 'express' } }).remove() && (didTransform = true);
  root
    .find(j.VariableDeclarator, {
      init: { callee: { name: 'require', arguments: [{ value: 'express' }] } }
    })
    .remove() && (didTransform = true);

  // 3) Remap built-in modules → bun:…
  const builtIns = {
    fs:   { mod: 'bun:fs',   named: ['file','write','exists','readableStreamToText'] },
    path: { mod: 'bun:path', named: ['dirname','fromFileUrl'] },
    url:  { mod: 'bun:url',  named: ['pathToFileURL','fileURLToPath'] },
    util: { mod: 'bun:util', named: ['inspect'] }
  };
  root.find(j.ImportDeclaration).forEach(p => {
    const m = p.node.source.value;
    if (builtIns[m]) {
      const { mod, named } = builtIns[m];
      const specs = named.map(n => j.importSpecifier(j.identifier(n)));
      p.replace(j.importDeclaration(specs, j.literal(mod)));
      debug(`remapped '${m}' → '${mod}'`);
      didTransform = true;
    }
  });

  // 4) __dirname / __filename → import.meta.url/dir
  root.find(j.Identifier, { name: '__dirname' })
    .replaceWith(
      j.memberExpression(
        j.metaProperty(j.identifier('import'), j.identifier('meta')),
        j.identifier('dir')
      )
    ) && (didTransform = true);

  root.find(j.Identifier, { name: '__filename' })
    .replaceWith(
      j.memberExpression(
        j.metaProperty(j.identifier('import'), j.identifier('meta')),
        j.identifier('url')
      )
    ) && (didTransform = true);

  // 5) path.join → new URL(...).pathname (literals) or import.meta.resolve
  root
    .find(j.CallExpression, {
      callee: { object: { name: 'path' }, property: { name: 'join' } }
    })
    .replaceWith(path => {
      const args = path.node.arguments;
      const lits = args.filter(a => a.type === 'Literal').map(a => a.value);
      let expr;
      if (lits.length === args.length) {
        // all literals
        expr = j.newExpression(j.identifier('URL'), [
          j.literal(lits.join('/')),
          j.memberExpression(
            j.metaProperty(j.identifier('import'), j.identifier('meta')),
            j.identifier('url')
          )
        ]);
        expr = j.memberExpression(expr, j.identifier('pathname'));
      } else {
        // fallback
        expr = j.callExpression(
          j.memberExpression(
            j.metaProperty(j.identifier('import'), j.identifier('meta')),
            j.identifier('resolve')
          ),
          [j.literal(args.map(_=>undefined).join('/'))] // placeholder
        );
      }
      didTransform = true;
      return expr;
    });

  // Drop path imports/requires
  root.find(j.ImportDeclaration, { source: { value: 'path' } }).remove() && (didTransform = true);
  root
    .find(j.VariableDeclarator, {
      id: { name: 'path' },
      init: { callee: { name: 'require', arguments: [{ value: 'path' }] } }
    })
    .remove() && (didTransform = true);

  // 6) fs.readFileSync/writeFileSync/existsSync
  root
    .find(j.CallExpression, {
      callee: { object: { name: 'fs' }, property: { name: 'readFileSync' } }
    })
    .replaceWith(p =>
      j.awaitExpression(
        j.callExpression(
          j.memberExpression(j.callExpression(j.identifier('Bun.file'), [p.node.arguments[0]]), j.identifier('text')),
          []
        )
      )
    ) && (didTransform = true);

  root
    .find(j.CallExpression, {
      callee: { object: { name: 'fs' }, property: { name: 'writeFileSync' } }
    })
    .replaceWith(p =>
      j.awaitExpression(
        j.callExpression(j.identifier('Bun.write'), p.node.arguments)
      )
    ) && (didTransform = true);

  root
    .find(j.CallExpression, {
      callee: { object: { name: 'fs' }, property: { name: 'existsSync' } }
    })
    .replaceWith(p =>
      j.awaitExpression(
        j.callExpression(
          j.memberExpression(j.callExpression(j.identifier('Bun.file'), [p.node.arguments[0]]), j.identifier('exists')),
          []
        )
      )
    ) && (didTransform = true);

  // Drop fs import/require
  root.find(j.ImportDeclaration, { source: { value: 'fs' } }).remove() && (didTransform = true);
  root
    .find(j.VariableDeclarator, {
      id: { name: 'fs' },
      init: { callee: { name: 'require', arguments: [{ value: 'fs' }] } }
    })
    .remove() && (didTransform = true);

  // 7) CJS → ESM mapping for other requires (except express)
  const mapping = {
    cors: '@elysia/cors',
    compression: '@elysia/compression',
    'cookie-parser': '@elysia/cookie',
    'express-mongo-sanitize': 'express-mongo-sanitize',
    axios: 'axios',
    passport: 'passport',
    '~/strategies': '~/strategies',
    '~/lib/db': '~/lib/db',
    '~/server/utils': '~/server/utils',
    '~/config': '~/config',
    './utils/staticCache': './utils/staticCache',
    './middleware/noIndex': './middleware/noIndex',
    './middleware/errorController': './middleware/errorController',
    './routes': './routes'
  };

  root
    .find(j.VariableDeclarator, {
      init: { type: 'CallExpression', callee: { name: 'require' } }
    })
    .forEach(path => {
      const src = path.node.init.arguments[0].value;
      if (src === 'express' || !mapping[src]) return;
      const target = mapping[src];
      const id = path.node.id;
      const specs = [];
      if (id.type === 'Identifier') {
        specs.push(j.importDefaultSpecifier(j.identifier(id.name)));
      } else if (id.type === 'ObjectPattern') {
        id.properties.forEach(prop => {
          specs.push(j.importSpecifier(j.identifier(prop.key.name)));
        });
      }
      if (addImport(root, specs, target)) didTransform = true;
      j(path).remove();
    });

  // 8) Import Elysia
  if (addImport(root, [j.importSpecifier(j.identifier('Elysia'))], 'elysia')) {
    didTransform = true;
  }

  // 9) express() → new Elysia(...)
  root
    .find(j.VariableDeclarator, {
      init: { callee: { name: 'express' } }
    })
    .forEach(path => {
      path.node.init = j.newExpression(j.identifier('Elysia'), [
        j.objectExpression([
          j.property('init', j.identifier('bodyLimit'),
            j.logicalExpression('??',
              j.memberExpression(j.memberExpression(j.identifier('Bun'), j.identifier('env')), j.identifier('BODY_LIMIT')),
              j.literal('3mb')
            )
          )
        ])
      ]);
      didTransform = true;
    });

  // 10) Drop express.json()/urlencoded()
  root
    .find(j.CallExpression, {
      callee: { object: { name: 'express' }, property: { name: /^(json|urlencoded)$/ } }
    })
    .forEach(path => { j(path.parent).remove(); didTransform = true; });

  // 11) cookieParser → cookie()
  root
    .find(j.CallExpression, {
      callee: { object: { name: 'app' }, property: { name: 'use' } },
      arguments: [{ callee: { name: 'cookieParser' } }]
    })
    .replaceWith(() => {
      didTransform = true;
      return j.callExpression(
        j.memberExpression(j.identifier('app'), j.identifier('use')),
        [j.callExpression(j.identifier('cookie'), [])]
      );
    });

  // 12) mongoSanitize → preHandler hook
  root
    .find(j.CallExpression, {
      callee: { object: { name: 'app' }, property: { name: 'use' } },
      arguments: [{ callee: { name: 'mongoSanitize' } }]
    })
    .replaceWith(() => {
      didTransform = true;
      return j.callExpression(
        j.memberExpression(j.identifier('app'), j.identifier('hook')),
        [j.literal('preHandler'), j.callExpression(j.identifier('mongoSanitize'), [])]
      );
    });

  // 13) staticCache → app.static(...)
  root
    .find(j.CallExpression, {
      callee: { object: { name: 'app' }, property: { name: 'use' } },
      arguments: [{ callee: { name: 'staticCache' } }]
    })
    .replaceWith(path => {
      didTransform = true;
      const dirArg = path.node.arguments[0].arguments[0];
      return j.callExpression(
        j.memberExpression(j.identifier('app'), j.identifier('static')),
        [
          dirArg,
          j.objectExpression([
            j.property('init', j.identifier('maxAge'),
              j.callExpression(j.identifier('Number'), [
                j.memberExpression(
                  j.memberExpression(j.identifier('Bun'), j.identifier('env')),
                  j.identifier('STATIC_CACHE_S_MAX_AGE')
                )
              ])
            )
          ])
        ]
      );
    });

  // 14) noIndex → onRequest hook
  root
    .find(j.CallExpression, {
      callee: { object: { name: 'app' }, property: { name: 'use' } },
      arguments: [{ name: 'noIndex' }]
    })
    .replaceWith(() => {
      didTransform = true;
      return j.callExpression(
        j.memberExpression(j.identifier('app'), j.identifier('hook')),
        [j.literal('onRequest'), j.identifier('noIndex')]
      );
    });

  // 15) errorController → onError hook
  root
    .find(j.CallExpression, {
      callee: { object: { name: 'app' }, property: { name: 'use' } },
      arguments: [{ name: 'errorController' }]
    })
    .replaceWith(() => {
      didTransform = true;
      return j.callExpression(
        j.memberExpression(j.identifier('app'), j.identifier('onError')),
        [j.identifier('errorController')]
      );
    });

  // 16) app.listen(port, host) → await app.listen({ port, hostname: host })
  root
    .find(j.CallExpression, {
      callee: { object: { name: 'app' }, property: { name: 'listen' } }
    })
    .replaceWith(() => {
      didTransform = true;
      return j.awaitExpression(
        j.callExpression(
          j.memberExpression(j.identifier('app'), j.identifier('listen')),
          [
            j.objectExpression([
              j.property('init', j.identifier('port'), j.identifier('port')),
              j.property('init', j.identifier('hostname'), j.identifier('host'))
            ])
          ]
        )
      );
    });

  // 17) await startServer()
  root
    .find(j.ExpressionStatement, {
      expression: { type: 'CallExpression', callee: { name: 'startServer' } }
    })
    .forEach(path => {
      path.node.expression = j.awaitExpression(path.node.expression);
      didTransform = true;
    });

  if (!didTransform) return null;
  return root.toSource({ quote: 'single', trailingComma: true });
}

// ---- Runner --------------------------------------------------------------------------------------------
async function main() {
  for await (const filePath of new Glob(['api/server/index.js'])) {
    let src;
    try { src = await Bun.file(filePath).text(); }
    catch (e) { log(`read failed: ${filePath}`, e.message); continue; }

    const out = transformer(src, filePath);
    if (!out) {
      debug(`no changes for ${filePath}`);
      continue;
    }

    if (!dryRun) {
      try { await Bun.write(filePath, out); }
      catch (e) { log(`write failed: ${filePath}`, e.message); }
    }
    log(`${dryRun ? 'DRY' : '✔'} ${filePath}`);
  }
}

main().catch(e => {
  console.error('[transform-server-index] fatal error', e);
  Bun.exit(1);
});