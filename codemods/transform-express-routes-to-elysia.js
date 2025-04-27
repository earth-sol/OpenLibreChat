/**
 * codemods/transform-express-routes-to-elysia.js
 *
 * - Inline Express Router() into Elysia `app` calls
 * - Support nested routers via `app.group()`
 * - Preserve middleware arrays → preHandler
 * - Convert res.json/status → ctx.json
 * - Use app.route() for dynamic methods
 * - Compute import path without Node APIs
 * - Idempotent and verbose by default
 */

//
// Helper: compute POSIX-style relative paths without Node’s `path` module
//
function toRelative(fromFile, toFile) {
  const fromParts = fromFile.replace(/\\/g, '/').split('/').slice(0, -1);
  const toParts   = toFile.replace(/\\/g, '/').split('/');
  let i = 0;
  while (
    i < fromParts.length &&
    i < toParts.length &&
    fromParts[i] === toParts[i]
  ) {
    i++;
  }
  const ups  = fromParts.length - i;
  const down = toParts.slice(i);
  return Array(ups).fill('..').concat(down).join('/');
}

export default function transformer(fileInfo, api) {
  const j    = api.jscodeshift;
  const root = j(fileInfo.source);
  let   routerVar = null;

  // 1) Remove any Express import / require
  root.find(j.ImportDeclaration, { source: { value: 'express' } }).remove();
  root
    .find(j.VariableDeclarator, {
      init: {
        type: 'CallExpression',
        callee: { name: 'require' },
        arguments: [{ type: 'Literal', value: 'express' }]
      }
    })
    .forEach(p => j(p.parent).remove());

  // 2) Detect and remove Router() declarations
  root
    .find(j.VariableDeclarator, {
      init: {
        type: 'CallExpression',
        callee: { property: { name: 'Router' } }
      }
    })
    .forEach(p => {
      routerVar = p.node.id.name;
      console.debug(`[codemod] found router: ${routerVar}`);
      j(p.parent).remove();
    });

  if (!routerVar) {
    // no router → skip
    return fileInfo.source;
  }

  // 3) Inject `import app from '…'` if missing
  const hasAppImport = root
    .find(j.ImportDeclaration, {
      specifiers: [{ local: { name: 'app' } }]
    })
    .size() > 0;

  if (!hasAppImport) {
    const fromFile  = fileInfo.path.replace(/\\/g, '/');
    const toFile    = 'api/server/index.js'; // adjust if using TS
    let   relPath   = toRelative(fromFile, toFile).replace(/\.[jt]s$/, '');
    if (!relPath.startsWith('.')) relPath = './' + relPath;

    const imp = j.importDeclaration(
      [ j.importDefaultSpecifier(j.identifier('app')) ],
      j.literal(relPath)
    );
    const lastImp = root.find(j.ImportDeclaration).at(-1);
    if (lastImp.size()) lastImp.insertAfter(imp);
    else root.get().node.program.body.unshift(imp);

    console.debug(`[codemod] injected import app from "${relPath}"`);
  }

  // 4) Collect child routers used in router.use(...)
  const childRouters = new Set();
  root
    .find(j.CallExpression, {
      callee: {
        object: { name: routerVar },
        property: { name: 'use' }
      }
    })
    .forEach(p => {
      const args = p.node.arguments;
      const last = args[args.length - 1];
      if (last && last.type === 'Identifier') {
        childRouters.add(last.name);
        console.debug(`[codemod] detected child router: ${last.name}`);
      }
    });

  // 5) Transform nested router.use(prefix, ...ms, childRouter) → app.group()
  root
    .find(j.CallExpression, {
      callee: {
        object: { name: routerVar },
        property: { name: 'use' }
      }
    })
    .forEach(p => {
      const args = p.node.arguments;
      const first = args[0];
      const rest  = args.slice(1);
      if (
        first &&
        first.type === 'Literal' &&
        rest.length > 0
      ) {
        const prefix = first;
        const last   = rest[rest.length - 1];
        const mids   = rest.slice(0, -1);

        if (last.type === 'Identifier' && childRouters.has(last.name)) {
          const groupFn = j.arrowFunctionExpression(
            [ j.identifier('group') ],
            j.blockStatement([
              j.expressionStatement(
                j.callExpression(
                  j.memberExpression(
                    j.identifier('group'),
                    j.identifier('use')
                  ),
                  mids
                )
              ),
              j.returnStatement(
                j.callExpression(
                  j.identifier(last.name),
                  []
                )
              )
            ])
          );

          const call = j.callExpression(
            j.memberExpression(j.identifier('app'), j.identifier('group')),
            [ prefix, groupFn ]
          );

          console.debug(
            `[codemod] ${routerVar}.use("${prefix.value}", …, ${last.name}) → app.group()`
          );
          j(p).replaceWith(call);
        }
      }
    });

  // 6) Transform router.METHOD(path, ...middleware, handler)
  root
    .find(j.CallExpression, {
      callee: {
        object: { name: routerVar },
        property: { type: 'Identifier' }
      }
    })
    .forEach(p => {
      const method     = p.node.callee.property.name;
      const [route, ...fns] = p.node.arguments;
      if (!route || fns.length < 1) return;

      const handler    = fns.pop();
      const preHandler = fns;

      // rewrite res.json → ctx.json
      const handlerSrc = j(handler)
        .find(j.CallExpression, {
          callee: {
            object: { name: 'res' },
            property: { name: 'json' }
          }
        })
        .forEach(path => {
          j(path.parentPath).replaceWith(
            j.returnStatement(
              j.callExpression(
                j.memberExpression(
                  j.identifier('ctx'),
                  j.identifier('json')
                ),
                path.node.arguments
              )
            )
          );
        })
        // rewrite res.status(code).json(body)
        .find(j.CallExpression, {
          callee: {
            object: {
              type: 'CallExpression',
              callee: {
                object: { name: 'res' },
                property: { name: 'status' }
              }
            },
            property: { name: 'json' }
          }
        })
        .forEach(path => {
          const statusCall = path.node.callee.object;
          const codeArg    = statusCall.arguments[0];
          const bodyArg    = path.node.arguments[0];
          j(path).replaceWith(
            j.returnStatement(
              j.callExpression(
                j.memberExpression(
                  j.identifier('ctx'),
                  j.identifier('json')
                ),
                [
                  bodyArg,
                  j.objectExpression([
                    j.property('init', j.identifier('status'), codeArg)
                  ])
                ]
              )
            )
          );
        })
        .toSource();

      // build options object
      const opts = [];
      if (preHandler.length) {
        opts.push(
          j.property(
            'init',
            j.identifier('preHandler'),
            j.arrayExpression(preHandler)
          )
        );
      }

      // choose direct app.METHOD or app.route
      let newCall;
      const std = ['get','post','put','patch','delete','head','options'];
      if (std.includes(method)) {
        const callArgs = [ route, j.identifier(handlerSrc) ];
        if (opts.length) callArgs.push(j.objectExpression(opts));
        newCall = j.callExpression(
          j.memberExpression(j.identifier('app'), j.identifier(method)),
          callArgs
        );
      } else {
        const callArgs = [
          j.literal(method.toUpperCase()),
          route,
          j.identifier(handlerSrc)
        ];
        if (opts.length) callArgs.push(j.objectExpression(opts));
        newCall = j.callExpression(
          j.memberExpression(j.identifier('app'), j.identifier('route')),
          callArgs
        );
      }

      console.debug(
        `[codemod] inlined ${routerVar}.${method}(${route.raw||route.value})`
      );
      j(p).replaceWith(newCall);
    });

  // 7) Remove any leftover router exports
  root
    .find(j.ExpressionStatement, {
      expression: {
        left: {
          object: { name: 'module' },
          property: { name: 'exports' }
        },
        right: { name: routerVar }
      }
    })
    .remove();
  root
    .find(j.ExportDefaultDeclaration, {
      declaration: { name: routerVar }
    })
    .remove();

  return root.toSource({ quote: 'single', trailingComma: true });
}

export const parser = 'ts';