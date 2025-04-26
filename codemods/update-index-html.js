#!/usr/bin/env bun
// scripts/update-index-html.js

import { readFileSync, writeFileSync } from 'fs';
import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import { resolve } from 'path';

(async () => {
  const filePath = resolve(process.cwd(), 'client/index.html');
  const source   = readFileSync(filePath, 'utf-8');

  // 1. Parse into a rehype AST
  const processor = unified().use(rehypeParse, { fragment: false });
  const tree      = processor.parse(source);

  let injected = false;

  // 2. Walk the AST, find the <div id="root">, and inject our script node
  visit(tree, 'element', (node, index, parent) => {
    if (
      !injected &&
      node.tagName === 'div' &&
      node.properties &&
      node.properties.id === 'root'
    ) {
      const scriptNode = {
        type: 'element',
        tagName: 'script',
        properties: { type: 'module', 'data-plugin-loader': 'true' },
        children: [
          {
            type: 'text',
            value: "import './plugin-runtime/PluginLoader'"
          }
        ]
      };

      // Insert right after the <div id="root"> node
      parent.children.splice(index + 1, 0, scriptNode);
      injected = true;
    }
  });

  // 3. If we injected, stringify and write
  if (injected) {
    const out = await unified().use(rehypeStringify).stringify(tree);
    writeFileSync(filePath, out, 'utf-8');
    console.log('✅ Injected plugin-loader script into index.html');
  } else {
    console.log('ℹ️  No changes needed (already injected or root missing)');
  }
})();