#!/usr/bin/env bun

/**
 * transform-controllers.js
 *
 * A Bun-native codemod that:
 *  • Scans all JS/TS controllers under api/server/controllers
 *  • Converts CommonJS → ESM (module.exports → export ...)
 *  • Renames (req, res) → (req, ctx), makes handlers async
 *  • Injects `const body = await req.json()` + replaces `req.body`
 *  • Rewrites res.status(x).json(y) → return ctx.json(y, { status: x })
 *    and res.json(y) → return ctx.json(y)
 *  • Uses Bun.Glob, Bun.file, Bun.write for file I/O
 *  • **Always** logs verbose output for every file
 */

import j from 'jscodeshift';

/**
 * Apply all AST transforms to source; return { modified, output }
 */
function transformSource(source) {
  const root = j(source);
  let hasModifications = false;

  // 1) Collect & remove module.exports assignments
  const namedExports = [];
  const defaultExports = [];

  root
    .find(j.AssignmentExpression, {
      left: {
        object: { name: 'module' },
        property: { name: 'exports' },
      },
    })
    .forEach((path) => {
      const stmt = path.parent;
      const rhs = path.node.right;

      if (j.ObjectExpression.check(rhs)) {
        rhs.properties.forEach((prop) => {
          if (j.Property.check(prop)) {
            const name = prop.key.name || prop.key.value;
            namedExports.push(name);
          }
        });
      } else if (j.Identifier.check(rhs)) {
        defaultExports.push(rhs.name);
      } else if (
        j.FunctionExpression.check(rhs) ||
        j.ArrowFunctionExpression.check(rhs)
      ) {
        root
          .get()
          .node.program.body.splice(
            root.get().node.program.body.indexOf(stmt.value),
            1,
            j.exportDefaultDeclaration(rhs)
          );
        hasModifications = true;
      }

      j(stmt).remove();
      hasModifications = true;
    });

  // 2) Turn named vars → export const
  namedExports.forEach((name) => {
    root
      .find(j.VariableDeclarator, { id: { name } })
      .forEach((path) => {
        const decl = path.parent.node;
        j(path.parent).replaceWith(j.exportNamedDeclaration(decl, []));
        hasModifications = true;
      });
  });

  // 3) Append export default for defaultExports
  if (defaultExports.length) {
    root.find(j.Program).forEach((path) => {
      defaultExports.forEach((name) => {
        path.node.body.push(j.exportDefaultDeclaration(j.identifier(name)));
        hasModifications = true;
      });
    });
  }

  // 4) Transform each controller function
  function transformController(fnPath) {
    const fn = fnPath.node;
    if (!fn.params || fn.params.length < 2) return;

    const [reqParam, resParam] = fn.params;
    if (reqParam.name !== 'req') return;

    // rename res→ctx
    if (resParam.name !== 'ctx') {
      resParam.name = 'ctx';
      hasModifications = true;
    }

    // ensure async
    if (!fn.async) {
      fn.async = true;
      hasModifications = true;
    }

    // Inject `const body = await req.json()` if req.body is used
    let usesBody = false;
    j(fn.body)
      .find(j.MemberExpression, {
        object: { name: 'req' },
        property: { name: 'body' },
      })
      .forEach(() => (usesBody = true));

    if (usesBody && j.BlockStatement.check(fn.body)) {
      const decl = j.variableDeclaration('const', [
        j.variableDeclarator(
          j.identifier('body'),
          j.awaitExpression(
            j.callExpression(
              j.memberExpression(j.identifier('req'), j.identifier('json')),
              []
            )
          )
        ),
      ]);
      fn.body.body.unshift(decl);
      hasModifications = true;

      // replace all `req.body` → `body`
      j(fn.body)
        .find(j.MemberExpression, {
          object: { name: 'req' },
          property: { name: 'body' },
        })
        .replaceWith(j.identifier('body'));
    }

    // res.status(x).json(y) → return ctx.json(y, { status: x })
    j(fn.body)
      .find(j.CallExpression, {
        callee: {
          object: {
            callee: {
              object: { name: 'res' },
              property: { name: 'status' },
            },
          },
          property: { name: 'json' },
        },
      })
      .forEach((callPath) => {
        const statusCall = callPath.node.callee.object;
        const statusArg = statusCall.arguments[0];
        const [payload] = callPath.node.arguments;
        const newExpr = j.callExpression(
          j.memberExpression(j.identifier('ctx'), j.identifier('json')),
          [
            payload || j.literal(null),
            j.objectExpression([
              j.property('init', j.identifier('status'), statusArg),
            ]),
          ]
        );
        j(callPath.parent).replaceWith(j.returnStatement(newExpr));
        hasModifications = true;
      });

    // res.json(y) → return ctx.json(y)
    j(fn.body)
      .find(j.CallExpression, {
        callee: { object: { name: 'res' }, property: { name: 'json' } },
      })
      .forEach((callPath) => {
        const args = callPath.node.arguments;
        const newExpr = j.callExpression(
          j.memberExpression(j.identifier('ctx'), j.identifier('json')),
          args
        );
        j(callPath.parent).replaceWith(j.returnStatement(newExpr));
        hasModifications = true;
      });
  }

  // apply to named functions
  root.find(j.FunctionDeclaration).forEach(transformController);

  // apply to const foo = (req, res) => { … }
  root
    .find(j.VariableDeclarator, {
      init: (node) =>
        j.FunctionExpression.check(node) ||
        j.ArrowFunctionExpression.check(node),
    })
    .filter((path) => {
      const fn = path.node.init;
      return fn.params[0] && fn.params[0].name === 'req';
    })
    .forEach((path) => transformController(path.get('init')));

  return {
    modified: hasModifications,
    output: hasModifications
      ? root.toSource({ quote: 'single' })
      : source,
  };
}

(async () => {
  try {
    for await (const entry of new Bun.Glob(
      'api/server/controllers/**/*.{js,ts}'
    )) {
      if (!entry.isFile) continue;
      const filePath = entry.path;
      const src = await Bun.file(filePath).text();
      const { modified, output } = transformSource(src);

      if (modified && output !== src) {
        await Bun.write(filePath, output);
        console.debug(`[transform-controllers] ✎ ${filePath}`);
      } else {
        console.debug(`[transform-controllers] · ${filePath}`);
      }
    }
  } catch (err) {
    console.error('[transform-controllers] Error:', err);
    process.exit(1);
  }
})();