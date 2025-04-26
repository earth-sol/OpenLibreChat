/**
 * codemods/replace-fs-with-bun-io.js
 */
export default function transformer(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);

  // 1. Remove fs imports if they only imported readFileSync/writeFileSync
  root.find(j.ImportDeclaration, { source: { value: 'fs' } })
    .forEach(path => {
      const specifiers = path.node.specifiers.filter(s => {
        const n = s.imported && s.imported.name;
        return n !== 'readFileSync' && n !== 'writeFileSync';
      });
      if (specifiers.length === 0) {
        j(path).remove();
      } else {
        path.node.specifiers = specifiers;
      }
    });

  // 2. readFileSync(...) → await Bun.file(...).text()
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

  // 3. writeFileSync(path,data) → await Bun.write(path,data)
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

  // 4. Wrap in async IIFE if we added any await
  if (root.find(j.AwaitExpression).size() > 0) {
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