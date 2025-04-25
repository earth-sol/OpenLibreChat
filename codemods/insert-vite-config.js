/**
 * Ensures client/vite.config.ts fs.allow includes '.' and '..'
 */
export default function transformer(file, api) {
  const j = api.jscodeshift;
  if (!/client\/vite\.config\.ts$/.test(file.path)) return null;
  const root = j(file.source);

  // find server.fs.allow array
  root
    .find(j.Property, { key: { name: "allow" } })
    .forEach(path => {
      const arr = path.node.value.elements.map(e => e.value);
      ["." , ".."].forEach(val => {
        if (!arr.includes(val)) {
          path.node.value.elements.push(j.literal(val));
        }
      });
    });

  return root.toSource({ quote: "single", trailingComma: true });
}
