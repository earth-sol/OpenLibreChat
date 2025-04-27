#!/usr/bin/env bun

/**
 * codemods/transform-client-html.js
 *
 * Bun-native HTML transform:
 * - Scans all .html files under client/ via Bun.scandir
 * - Converts <script src="..."> → <script type="module">await import('...');</script>
 * - In client/index.html, injects:
 *     <script defer type="module">
 *       await import('/src/main.jsx');
 *     </script>
 *   immediately after the inline "theme setup" script (detects `const theme =`)
 * - Uses Bun’s built-in HTMLRewriter for streaming transforms
 * - Emits verbose debug logs for every step
 */

async function* findHtmlFiles(dir) {
  for await (const entry of Bun.scandir(dir, { recursive: true })) {
    if (entry.isFile && entry.path.endsWith('.html')) {
      yield entry.path;
    }
  }
}

async function transformHtml(source, filePath) {
  const rewriter = new HTMLRewriter()

    // 1) Convert <script src="..."> → dynamic module imports
    .on('script[src]', {
      element(el) {
        const src = el.getAttribute('src');
        el.removeAttribute('src');
        el.setAttribute('type', 'module');
        el.setInnerContent(`await import('${src}');`, { html: false });
        console.log('[debug]', filePath, '→ converted <script src="…">', src);
      }
    });

  // 2) Inject main.jsx loader in client/index.html
  if (filePath.endsWith('client/index.html')) {
    rewriter.on('script:not([src])', {
      element(el) {
        const text = el.textContent;
        if (text.includes('const theme =')) {
          el.after(
            `<script defer type="module">\n  await import('/src/main.jsx');\n</script>`,
            { html: true }
          );
          console.log('[debug]', filePath, '→ injected main.jsx loader');
        }
      }
    });
  }

  const transformed = await rewriter.transform(source);
  return transformed.text();
}

async function main() {
  console.log('Starting transform-client-html.js (verbose Bun-native)');

  for await (const filePath of findHtmlFiles('client')) {
    console.log('[debug] Processing file:', filePath);

    const original = await Bun.file(filePath).text();
    const updated = await transformHtml(original, filePath);

    if (updated !== original) {
      await Bun.write(filePath, updated);
      console.log(`✔ Updated ${filePath}`);
    } else {
      console.log(`[debug] No changes for ${filePath}`);
    }
  }

  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});