/**
 * Injects a plugin-runtime bootstrap into client/index.html
 */
export default function transformer(file) {
  if (!/client\/index\.html$/.test(file.path)) return null;
  const lines = file.source.split("\n");
  const out = [];

  for (let line of lines) {
    out.push(line);
    // after the <div id="root">, inject a module import
    if (line.match(/<div\s+id="root".*>/)) {
      out.push(
        `  <!-- plugin loader bootstrap -->`,
        `  <script type="module">`,
        `    import './plugin-runtime/PluginLoader';`,
        `  </script>`
      );
    }
  }

  return out.join("\n");
}
