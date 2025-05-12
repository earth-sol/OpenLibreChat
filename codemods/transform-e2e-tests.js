/**
 * codemods/transform-e2e-tests.js
 *
 * A jscodeshift transformer for Bun+Elysia migration of E2E tests.
 *
 * Enhancements:
 *  - Guards against duplicate `import { config } from 'dotenv'`
 *  - Enables reuseWhitespace to preserve formatting
 *  - Transforms `path.resolve(process.cwd(), ...)` and `path.join(process.cwd(), ...)` → `Bun.cwd() + '/...'.replace(/\.js$/, '.ts')`
 *  - Broadens Playwright `webServer.command` conversion:
 *      • TemplateLiterals starting with `node ` → `bun run `
 *      • StringLiterals starting with `node ` → `bun run `
 */

export const parser = 'ts';

export default function transformer(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);

  // 1) Drop `import path from 'path'`
  root.find(j.ImportDeclaration, { source: { value: 'path' } }).remove();

  // 2) require('dotenv').config() → import { config } from 'dotenv'; config();
  // Remove require-config calls
  let needsConfigImport = false;
  root.find(j.ExpressionStatement, {
    expression: {
      callee: {
        object: {
          callee: { name: 'require' },
          arguments: [{ value: 'dotenv' }]
        },
        property: { name: 'config' }
      }
    }
  })
  .forEach(path => {
    needsConfigImport = true;
    // Replace `require('dotenv').config(args)` with `config(args)`
    const args = path.node.expression.arguments || [];
    j(path).replaceWith(
      j.expressionStatement(
        j.callExpression(j.identifier('config'), args)
      )
    );
  });

  // Add import { config } from 'dotenv' at top if needed and not already present
  if (needsConfigImport) {
    const hasImport = root.find(j.ImportDeclaration, {
      source: { value: 'dotenv' }
    }).filter(path =>
      path.node.specifiers.some(spec =>
        spec.imported && spec.imported.name === 'config'
      )
    ).size() > 0;

    if (!hasImport) {
      root.get().node.program.body.unshift(
        j.importDeclaration(
          [j.importSpecifier(j.identifier('config'))],
          j.literal('dotenv')
        )
      );
    }
  }

  // 3) process.env.X → Bun.env.X
  root.find(j.MemberExpression, {
    object: { name: 'process' },
    property: { name: 'env' }
  }).forEach(path => {
    // transform process.env.X → Bun.env.X
    const prop = path.parentPath.node.property;
    j(path.parentPath).replaceWith(
      j.memberExpression(
        j.memberExpression(j.identifier('Bun'), j.identifier('env')),
        prop
      )
    );
  });

  // 4) path.resolve(process.cwd(), 'file.js') & path.join(...)
  ['resolve', 'join'].forEach(method => {
    root.find(j.CallExpression, {
      callee: {
        object: { name: 'path' },
        property: { name: method }
      }
    }).forEach(pathCall => {
      const args = pathCall.node.arguments;
      // first arg must be process.cwd()
      if (
        args.length >= 2 &&
        j.CallExpression.check(args[0]) &&
        j.MemberExpression.check(args[0].callee) &&
        args[0].callee.object.name === 'process' &&
        args[0].callee.property.name === 'cwd'
      ) {
        // collect literal segments, replace .js → .ts
        const segments = args.slice(1).map(arg => {
          if (j.Literal.check(arg) && typeof arg.value === 'string') {
            return arg.value.replace(/\.js$/, '.ts');
          }
          return null;
        }).filter(s => s !== null);
        const joined = segments.join('/');
        // build Bun.cwd() + '/joined'
        const newExpr = j.binaryExpression(
          '+',
          j.callExpression(
            j.memberExpression(j.identifier('Bun'), j.identifier('cwd')),
            []
          ),
          j.literal('/' + joined)
        );
        j(pathCall).replaceWith(newExpr);
      }
    });
  });

  // 5) Playwright webServer.command conversions
  // a) TemplateLiteral
  root.find(j.TemplateLiteral).filter(path =>
    path.node.quasis.length > 0 &&
    path.node.quasis[0].value.raw.startsWith('node ')
  ).forEach(pathTL => {
    pathTL.node.quasis[0].value.raw =
      pathTL.node.quasis[0].value.raw.replace(/^node\s+/, 'bun run ');
  });

  // b) StringLiteral or Literal
  root.find(j.Literal, {
    value: v => typeof v === 'string' && v.startsWith('node ')
  }).forEach(pathLit => {
    pathLit.node.value = pathLit.node.value.replace(/^node\s+/, 'bun run ');
  });

  return root.toSource({
    quote: 'single',
    trailingComma: true,
    reuseWhitespace: true
  });
}