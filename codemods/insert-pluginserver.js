/**
 * Injects pluginServer into api/app/index.ts
 */
export default function transformer(file, api) {
  const j = api.jscodeshift;
  if (!/api\/app\/index\.ts$/.test(file.path)) return null;
  const root = j(file.source);
  const body = root.get().node.program.body;

  // 1) import pluginServer
  const imp = j.importDeclaration(
    [j.importDefaultSpecifier(j.identifier('pluginServer'))],
    j.literal('./pluginServer')
  );
  // place after last import
  let idx = body.findIndex(n => n.type !== 'ImportDeclaration');
  if (idx < 0) idx = body.length;
  body.splice(idx, 0, imp);

  // 2) insert app.use(pluginServer);
  // find last app.use(...)
  const uses = body.filter(n =>
    n.type === 'ExpressionStatement' &&
    n.expression.type === 'CallExpression' &&
    n.expression.callee.object?.name === 'app' &&
    n.expression.callee.property?.name === 'use'
  );
  let insertAt = uses.length
    ? body.indexOf(uses[uses.length - 1]) + 1
    : idx + 1;
  const useStmt = j.expressionStatement(
    j.callExpression(
      j.memberExpression(j.identifier('app'), j.identifier('use')),
      [j.identifier('pluginServer')]
    )
  );
  body.splice(insertAt, 0, useStmt);

  return root.toSource({ quote: 'single' });
}
