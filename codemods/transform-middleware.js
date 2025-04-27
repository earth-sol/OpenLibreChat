#!/usr/bin/env bun

/**
 * ESM + Bun-native jscodeshift transform for Express → Elysia middleware.
 *
 * - Always-verbose: debug output on every step
 * - No Node.js built-ins: uses only jscodeshift API + Bun.env for future hooks
 * - Handles complex next()/res.json/status/writeHead patterns
 */
export default function transformer(fileInfo, { jscodeshift: j }) {
  console.debug('[transform-middleware] 📄 Transforming:', fileInfo.path);

  const root = j(fileInfo.source);

  // 1) require(...) → import
  root.find(j.VariableDeclaration).forEach(path => {
    const decl = path.node.declarations[0];
    if (
      decl?.init?.type === 'CallExpression' &&
      decl.init.callee.name === 'require' &&
      decl.init.arguments.length === 1 &&
      decl.init.arguments[0].type === 'Literal'
    ) {
      const src = decl.init.arguments[0].value;
      let importDecl;
      if (decl.id.type === 'ObjectPattern') {
        importDecl = j.importDeclaration(
          decl.id.properties.map(prop =>
            j.importSpecifier(
              j.identifier(prop.key.name),
              j.identifier(prop.value?.name || prop.key.name)
            )
          ),
          j.literal(src)
        );
      } else if (decl.id.type === 'Identifier') {
        importDecl = j.importDeclaration(
          [j.importDefaultSpecifier(j.identifier(decl.id.name))],
          j.literal(src)
        );
      }
      if (importDecl) {
        j(path).replaceWith(importDecl);
        console.debug('  ↳ require → import:', src);
      }
    }
  });

  // 2) module.exports → export default
  root.find(j.AssignmentExpression, {
    left: { object: { name: 'module' }, property: { name: 'exports' } }
  }).forEach(path => {
    j(path.parent).replaceWith(j.exportDefaultDeclaration(path.node.right));
    console.debug('  ↳ module.exports → export default');
  });

  // 3) (req,res,next) → async (request,ctx), strip next()
  root.find(j.FunctionDeclaration)
    .filter(p => p.node.params.length === 3)
    .forEach(path => {
      const [reqP, resP, nextP] = path.node.params;
      const reqN = reqP.name, resN = resP.name, nextN = nextP.name;

      path.node.async = true;
      path.node.params = [j.identifier('request'), j.identifier('ctx')];
      console.debug(`  ↳ fn ${path.node.id.name} signature → async (request, ctx)`);

      // rename all reqN → request, resN → ctx
      j(path).find(j.Identifier, { name: reqN }).replaceWith(() => j.identifier('request'));
      j(path).find(j.Identifier, { name: resN }).replaceWith(() => j.identifier('ctx'));

      // drop next param & calls
      j(path).find(j.Identifier, { name: nextN }).forEach(id => id.prune());
      root.find(j.CallExpression, { callee: { name: nextN } })
        .forEach(call => { j(call.parent).remove(); console.debug(`    • removed next() call`); });
      console.debug(`  ↳ removed next() calls in ${path.node.id.name}`);
    });

  // 4) ctx.status(...).json/send(...) → return ctx.json(payload,{status})
  ['json','send'].forEach(method => {
    root.find(j.CallExpression, {
      callee: {
        type: 'MemberExpression',
        property: { name: method },
        object: {
          type: 'CallExpression',
          callee: {
            type: 'MemberExpression',
            object: { name: 'ctx' },
            property: { name: 'status' }
          }
        }
      }
    }).forEach(path => {
      const statusArg = path.node.callee.object.arguments[0];
      const dataArg   = path.node.arguments[0] || j.literal(null);
      const callExpr  = j.callExpression(
        j.memberExpression(j.identifier('ctx'), j.identifier('json')),
        [ dataArg, j.objectExpression([ j.property('init', j.identifier('status'), statusArg) ]) ]
      );
      j(path.parent).replaceWith(j.returnStatement(callExpr));
      console.debug(`  ↳ ctx.status().${method} → return ctx.json(...,{status})`);
    });
  });

  // 5) ctx.json/send(...) → return ctx.json(payload)
  ['json','send'].forEach(method => {
    root.find(j.CallExpression, {
      callee: { type: 'MemberExpression', object: { name: 'ctx' }, property: { name: method } }
    }).forEach(path => {
      const dataArg  = path.node.arguments[0] || j.literal(null);
      const callExpr = j.callExpression(
        j.memberExpression(j.identifier('ctx'), j.identifier('json')),
        [ dataArg ]
      );
      j(path.parent).replaceWith(j.returnStatement(callExpr));
      console.debug(`  ↳ ctx.${method} → return ctx.json()`);
    });
  });

  // 6) ctx.writeHead(status, headers) → ctx.set = { status, headers }
  root.find(j.CallExpression, {
    callee: { type: 'MemberExpression', object: { name: 'ctx' }, property: { name: 'writeHead' } }
  }).forEach(path => {
    const [st, hdrs] = path.node.arguments;
    if (st && hdrs) {
      const assign = j.assignmentExpression('=',
        j.memberExpression(j.identifier('ctx'), j.identifier('set')),
        j.objectExpression([
          j.property('init', j.identifier('status'), st),
          j.property('init', j.identifier('headers'), hdrs)
        ])
      );
      j(path.parent).replaceWith(j.expressionStatement(assign));
      console.debug('  ↳ ctx.writeHead → ctx.set assignment');
    }
  });

  return root.toSource({ quote: 'single', trailingComma: true });
}