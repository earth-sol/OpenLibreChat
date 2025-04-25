/**
 * codemods/replace-fs-with-bun-io.js
 */
export default function transformer(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);

  // 1. Remove readFileSync & writeFileSync imports from 'fs'
  root.find(j.ImportDeclaration, { source: { value: 'fs' } })
    .forEach(path => {
      const specs = path.node.specifiers.filter(s => {
        const n = s.imported && s.imported.name;
        return n !== 'readFileSync' && n !== 'writeFileSync';
      });
      if (specs.length === 0) {
        j(path).remove();
      } else {
        path.node.specifiers = specs;
      }
    });

  // 2. Replace readFileSync(...) → await Bun.file(...).text()
  root.find(j.CallExpression, { callee: { name: 'readFileSync' } })
    .replaceWith(path => {
      const [fileArg] = path.node.arguments;
      return j.awaitExpression(
        j.callExpression(
          j.memberExpression(
            j.callExpression(j.memberExpression(j.identifier('Bun'), j.identifier('file')), [fileArg]),
            j.identifier('text')
          ),
          []
        )
      );
    });

  // 3. Replace writeFileSync(path, data) → await Bun.write(path, data)
  root.find(j.CallExpression, { callee: { name: 'writeFileSync' } })
    .replaceWith(path => {
      const [pathArg, dataArg] = path.node.arguments;
      return j.awaitExpression(
        j.callExpression(
          j.memberExpression(j.identifier('Bun'), j.identifier('write')),
          [pathArg, dataArg]
        )
      );
    });

  // 4. Wrap top-level code in async IIFE if any `await` was added
  const hasAwait = root.find(j.AwaitExpression).size() > 0;
  if (hasAwait) {
    const program = root.get().node;
    program.body = [
      j.expressionStatement(
        j.callExpression(
          j.arrowFunctionExpression([], j.blockStatement(program.body), true),
          []
        )
      )
    ];
  }

  return root.toSource({ quote: 'single', trailingComma: true });
}
