/**
 * Injects PluginLoader into frontend/src/index.tsx
 */
export default function transformer(file, api) {
  const j = api.jscodeshift;
  if (!/frontend\/src\/index\.tsx$/.test(file.path)) return null;
  const root = j(file.source);

  // 1) import PluginLoader
  root.get().node.program.body.unshift(
    j.importDeclaration(
      [j.importDefaultSpecifier(j.identifier('PluginLoader'))],
      j.literal('./plugin-runtime/PluginLoader')
    )
  );
  // 2) wrap <App/> in <PluginLoader>
  root
    .find(j.JSXElement, { openingElement: { name: { name: 'App' } } })
    .replaceWith(path =>
      j.jsxElement(
        j.jsxOpeningElement(j.jsxIdentifier('PluginLoader'), []),
        j.jsxClosingElement(j.jsxIdentifier('PluginLoader')),
        [path.node]
      )
    );

  return root.toSource({ quote: 'single' });
}
