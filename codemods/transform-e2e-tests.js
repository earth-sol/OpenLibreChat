/**
 * codemods/transform-e2e-tests.js
 *
 * A jscodeshift transformer for Bun+Elysia migration of E2E tests.
 */

export const parser = 'ts';

export default function transformer(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);
  const p = file.path.replace(/\\/g, '/');

  // 1) Drop `import path from 'path'`
  root.find(j.ImportDeclaration, { source: { value: 'path' } }).remove();

  // 2) Replace path.resolve(process.cwd(), '<file>.js') → Bun.cwd() + '/<file>.ts'
  root
    .find(j.CallExpression, {
      callee: {
        object: { name: 'path' },
        property: { name: 'resolve' }
      }
    })
    .forEach(pathResolve => {
      const [first, second] = pathResolve.node.arguments;
      if (
        first &&
        first.type === 'CallExpression' &&
        first.callee.type === 'MemberExpression' &&
        first.callee.object.name === 'process' &&
        first.callee.property.name === 'cwd' &&
        second &&
        (second.type === 'Literal' || second.type === 'StringLiteral')
      ) {
        // build Bun.cwd() + '/…'
        let filePath = String(second.value);
        // switch .js → .ts
        filePath = filePath.replace(/\.js$/, '.ts');
        if (!filePath.startsWith('/')) filePath = '/' + filePath;

        const bunCwd = j.callExpression(
          j.memberExpression(j.identifier('Bun'), j.identifier('cwd')),
          []
        );
        j(pathResolve).replaceWith(
          j.binaryExpression('+', bunCwd, j.literal(filePath))
        );
      }
    });

  // 3) Convert `require('dotenv').config(...)` → `import { config } from 'dotenv'; config(...)`
  let insertedConfigImport = false;
  root
    .find(j.ExpressionStatement, {
      expression: {
        type: 'CallExpression',
        callee: {
          type: 'MemberExpression',
          object: {
            type: 'CallExpression',
            callee: { name: 'require' },
            arguments: [{ value: 'dotenv' }]
          },
          property: { name: 'config' }
        }
      }
    })
    .forEach(stmt => {
      const args = stmt.node.expression.arguments;
      if (!insertedConfigImport) {
        const imp = j.importDeclaration(
          [j.importSpecifier(j.identifier('config'))],
          j.literal('dotenv')
        );
        root.get().node.program.body.unshift(imp);
        insertedConfigImport = true;
      }
      j(stmt).replaceWith(
        j.expressionStatement(j.callExpression(j.identifier('config'), args))
      );
    });

  // 4) Replace all process.env.X → Bun.env.X
  root
    .find(j.MemberExpression, {
      object: {
        type: 'MemberExpression',
        object: { name: 'process' },
        property: { name: 'env' }
      }
    })
    .forEach(pathEnv => {
      const prop = pathEnv.node.property;
      const newEnv = j.memberExpression(
        j.memberExpression(j.identifier('Bun'), j.identifier('env')),
        prop,
        pathEnv.node.computed
      );
      j(pathEnv).replaceWith(newEnv);
    });

  // 5) Clean up require.resolve('…') → '…'
  root
    .find(j.CallExpression, {
      callee: {
        type: 'MemberExpression',
        object: { name: 'require' },
        property: { name: 'resolve' }
      }
    })
    .forEach(call => {
      const arg = call.node.arguments[0];
      if (arg && (arg.type === 'Literal' || arg.type === 'StringLiteral')) {
        j(call).replaceWith(j.literal(arg.value));
      }
    });

  // 6) In Playwright configs: webServer.command: `node ${…}` → `bun run ${…}`
  root
    .find(j.TemplateLiteral)
    .forEach(tl => {
      const quasis = tl.node.quasis;
      if (
        quasis.length === 2 &&
        quasis[0].value.raw.trim().startsWith('node ')
      ) {
        // rewrite prefix
        quasis[0].value.raw = quasis[0].value.raw.replace(/^(\s*)node\s+/, '$1bun run ');
        quasis[0].value.cooked = quasis[0].value.raw;
      }
    });

  // also handle string-literal commands if present
  root
    .find(j.Literal, { value: v => typeof v === 'string' && v.startsWith('node ') })
    .forEach(lit => {
      lit.node.value = lit.node.value.replace(/^node\s+/, 'bun run ');
    });

  return root.toSource({
    quote: 'single',
    trailingComma: true,
    reuseWhitespace: false
  });
}