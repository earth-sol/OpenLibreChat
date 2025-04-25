/**
 * codemods/insert-pluginloader.js
 *
 * AST transform that injects PluginLoader into the React entrypoint
 * of client/src/index.tsx, adding the import and wrapping the
 * <App/> component in <PluginLoader>…</PluginLoader>.
 */

export default function transformer(file, api) {
  const j = api.jscodeshift;
  const rootAst = j(file.source);

  // Only transform the client entrypoint
  if (!/client\\/src\\/index\\.(t|j)sx?$/.test(file.path)) {
    return null;
  }

  // 1) Ensure import PluginLoader at top
  const imports = rootAst.find(j.ImportDeclaration);
  const hasImport = imports.nodes().some(n =>
    n.source.value === './plugin-runtime/PluginLoader'
  );

  if (!hasImport && imports.size() > 0) {
    imports.at(0).insertBefore(
      j.importDeclaration(
        [j.importDefaultSpecifier(j.identifier('PluginLoader'))],
        j.literal('./plugin-runtime/PluginLoader')
      )
    );
  }

  // 2) Wrap the rendered App in PluginLoader

  // a) ReactDOM.createRoot(...).render(...)
  rootAst
    .find(j.CallExpression, {
      callee: {
        type: 'MemberExpression',
        object: { type: 'Identifier', name: 'root' },
        property: { type: 'Identifier', name: 'render' }
      }
    })
    .forEach(path => {
      const args = path.node.arguments;
      if (args.length > 0) {
        path.node.arguments[0] = wrapWithPluginLoader(j, args[0]);
      }
    });

  // b) ReactDOM.render(...) (legacy)
  rootAst
    .find(j.CallExpression, {
      callee: {
        type: 'MemberExpression',
        object: { type: 'Identifier', name: 'ReactDOM' },
        property: { type: 'Identifier', name: 'render' }
      }
    })
    .forEach(path => {
      const args = path.node.arguments;
      if (args.length > 0) {
        args[0] = wrapWithPluginLoader(j, args[0]);
      }
    });

  return rootAst.toSource({ quote: 'single', trailingComma: true });
}

/**
 * Helper: wraps a JSXElement in <PluginLoader> unless already wrapped.
 * If the root JSX is <React.StrictMode>, wraps its children instead.
 */
function wrapWithPluginLoader(j, node) {
  if (!node || node.type !== 'JSXElement') return node;

  const name = node.openingElement.name;
  if (name.type === 'JSXIdentifier' && name.name === 'PluginLoader') {
    // already wrapped
    return node;
  }

  if (name.type === 'JSXIdentifier' && name.name === 'React.StrictMode') {
    // wrap inner children
    node.children = node.children.map(child => {
      if (child.type === 'JSXElement') {
        const childName = child.openingElement.name;
        if (childName.type === 'JSXIdentifier' && childName.name !== 'PluginLoader') {
          return j.jsxElement(
            j.jsxOpeningElement(j.jsxIdentifier('PluginLoader'), []),
            j.jsxClosingElement(j.jsxIdentifier('PluginLoader')),
            [child],
            false
          );
        }
      }
      return child;
    });
    return node;
  }

  // default: wrap entire node
  return j.jsxElement(
    j.jsxOpeningElement(j.jsxIdentifier('PluginLoader'), []),
    j.jsxClosingElement(j.jsxIdentifier('PluginLoader')),
    [node],
    false
  );
}