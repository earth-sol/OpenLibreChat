/**
 * codemods/transform-db-utils.js
 *
 * Bun-first, ESM jscodeshift transform for api/lib/db/**/*.js
 *
 * Usage (run under Bun):
 *   bunx jscodeshift \
 *     --extensions=js,ts \
 *     --parser=tsx \
 *     -t codemods/transform-db-utils.js \
 *     api/lib/db/**/*.{js,ts}
 */
export default function transformer(fileInfo, api) {
  const j = api.jscodeshift;
  const root = j(fileInfo.source);

  const debug = (...args) => console.debug('[transform-db-utils]', ...args);

  debug(`⟳ ${fileInfo.path}`);

  // --- 1) Remove `fs` & `path` imports/requires ---
  root
    .find(j.ImportDeclaration, {
      source: { value: val => val === 'fs' || val === 'path' }
    })
    .forEach(p => {
      debug('Removing import', p.value.source.value, 'line', p.value.loc.start.line);
      j(p).remove();
    });

  root
    .find(j.CallExpression, {
      callee: { name: 'require' },
      arguments: arg =>
        arg[0] &&
        (arg[0].value === 'fs' || arg[0].value === 'path')
    })
    .forEach(p => {
      debug('Removing require', p.value.arguments[0].value, 'line', p.value.loc.start.line);
      j(p.parent).remove(); // remove `const fs = require('fs')`
    });

  // --- Helpers for path → URL conversion ---
  function isDirname(node) {
    return node.type === 'Identifier' && node.name === '__dirname';
  }
  function isFilename(node) {
    return node.type === 'Identifier' && node.name === '__filename';
  }
  function makeURLLiteral(pathLiteral) {
    return j.newExpression(
      j.identifier('URL'),
      [
        j.literal(pathLiteral),
        j.memberExpression(
          j.metaProperty(j.identifier('import'), j.identifier('meta')),
          j.identifier('url')
        )
      ]
    );
  }
  function replaceDirname(pathNode) {
    debug('→ __dirname → URL(".", import.meta.url) at line', pathNode.value.loc.start.line);
    j(pathNode).replaceWith(
      makeURLLiteral('./')
    );
  }
  function replaceFilename(pathNode) {
    debug('→ __filename → import.meta.url at line', pathNode.value.loc.start.line);
    j(pathNode).replaceWith(
      j.memberExpression(
        j.metaProperty(j.identifier('import'), j.identifier('meta')),
        j.identifier('url')
      )
    );
  }

  // --- 2) Replace __dirname & __filename ---
  root.find(j.Identifier, { name: '__dirname' }).forEach(replaceDirname);
  root.find(j.Identifier, { name: '__filename' }).forEach(replaceFilename);

  // --- 3) Handle path.join/resolve(__dirname, 'a', 'b') ---
  root
    .find(j.CallExpression, {
      callee: {
        object: { name: 'path' },
        property: { name: name => name === 'join' || name === 'resolve' }
      }
    })
    .forEach(p => {
      const args = p.value.arguments;
      if (
        args.length >= 2 &&
        isDirname(args[0]) &&
        args.slice(1).every(a => a.type === 'Literal')
      ) {
        const segments = args.slice(1).map(a => a.value);
        const joined = segments.join('/');
        debug(
          `→ path.${p.value.callee.property.name}(__, ${segments.join(
            ','
          )}) → URL("${joined}", import.meta.url) at line`,
          p.value.loc.start.line
        );
        j(p).replaceWith(makeURLLiteral(joined));
      }
    });

  // --- 4) FS → Bun API patterns ---
  const fsPatterns = [
    // sync & promise read
    {
      test: (o, p) =>
        (o === 'fs' && p === 'readFileSync') ||
        (o === 'fs' &&
          p === 'promises' &&
          // require two steps: .promises.readFile
          false),
      replace: pathNode => {
        const { node } = pathNode;
        const args = node.arguments;
        const raw = args[0] || j.literal('');
        const encoding = args[1] && args[1].type === 'Literal' ? args[1].value : null;
        const method = /utf-?8/i.test(encoding) ? 'text' : 'arrayBuffer';
        const fileExpr = transformArg(raw);
        debug(`→ read → Bun.file().${method}() at line`, node.loc.start.line);
        j(pathNode).replaceWith(
          j.awaitExpression(
            j.callExpression(
              j.memberExpression(
                j.callExpression(
                  j.memberExpression(j.identifier('Bun'), j.identifier('file')),
                  [fileExpr]
                ),
                j.identifier(method)
              ),
              []
            )
          )
        );
      }
    },
    // write
    {
      test: (o, p) =>
        (o === 'fs' && p === 'writeFileSync') ||
        (o === 'fs' &&
          p === 'promises' &&
          false),
      replace: pathNode => {
        const { node } = pathNode;
        const [raw, data, opts] = node.arguments;
        const fileExpr = transformArg(raw);
        const dataExpr = data || j.literal('');
        const args = opts ? [fileExpr, dataExpr, opts] : [fileExpr, dataExpr];
        debug(`→ write → Bun.write() at line`, node.loc.start.line);
        j(pathNode).replaceWith(
          j.awaitExpression(
            j.callExpression(
              j.memberExpression(j.identifier('Bun'), j.identifier('write')),
              args
            )
          )
        );
      }
    },
    // exists
    {
      test: (o, p) => o === 'fs' && p === 'existsSync',
      replace: pathNode => {
        const { node } = pathNode;
        const raw = node.arguments[0] || j.literal('');
        const fileExpr = transformArg(raw);
        debug(`→ exists → Bun.file().exists() at line`, node.loc.start.line);
        j(pathNode).replaceWith(
          j.awaitExpression(
            j.callExpression(
              j.memberExpression(
                j.callExpression(
                  j.memberExpression(j.identifier('Bun'), j.identifier('file')),
                  [fileExpr]
                ),
                j.identifier('exists')
              ),
              []
            )
          )
        );
      }
    },
    // unlink
    {
      test: (o, p) =>
        (o === 'fs' && p === 'unlinkSync') ||
        (o === 'fs' &&
          p === 'promises' &&
          false),
      replace: pathNode => {
        const { node } = pathNode;
        const raw = node.arguments[0] || j.literal('');
        const fileExpr = transformArg(raw);
        debug(`→ unlink → Bun.remove() at line`, node.loc.start.line);
        j(pathNode).replaceWith(
          j.awaitExpression(
            j.callExpression(
              j.memberExpression(j.identifier('Bun'), j.identifier('remove')),
              [fileExpr]
            )
          )
        );
      }
    },
    // mkdir
    {
      test: (o, p) =>
        (o === 'fs' && p === 'mkdirSync') ||
        (o === 'fs' &&
          p === 'promises' &&
          false),
      replace: pathNode => {
        const { node } = pathNode;
        const [raw, opts] = node.arguments;
        const fileExpr = transformArg(raw);
        const args = opts ? [fileExpr, opts] : [fileExpr];
        debug(`→ mkdir → Bun.mkdir() at line`, node.loc.start.line);
        j(pathNode).replaceWith(
          j.awaitExpression(
            j.callExpression(
              j.memberExpression(j.identifier('Bun'), j.identifier('mkdir')),
              args
            )
          )
        );
      }
    },
    // readdir
    {
      test: (o, p) =>
        (o === 'fs' && p === 'readdirSync') ||
        (o === 'fs' &&
          p === 'promises' &&
          false),
      replace: pathNode => {
        const { node } = pathNode;
        const raw = node.arguments[0] || j.literal('');
        const fileExpr = transformArg(raw);
        debug(`→ readdir → Bun.readdir() at line`, node.loc.start.line);
        j(pathNode).replaceWith(
          j.awaitExpression(
            j.callExpression(
              j.memberExpression(j.identifier('Bun'), j.identifier('readdir')),
              [fileExpr]
            )
          )
        );
      }
    }
  ];

  // helper: apply FS patterns
  fsPatterns.forEach(({ test, replace }) => {
    root
      .find(j.CallExpression)
      .filter(p => {
        const { callee } = p.value;
        if (callee.type === 'MemberExpression') {
          // handle fs.readFileSync or fs.promises.readFile
          if (
            callee.object.type === 'MemberExpression' &&
            callee.object.object.name === 'fs' &&
            callee.object.property.name === 'promises' &&
            callee.property.name &&
            test('fs', 'promises', callee.property.name)
          ) {
            return true;
          }
          if (
            callee.object.name === 'fs' &&
            test('fs', callee.property.name)
          ) {
            return true;
          }
        }
        return false;
      })
      .forEach(replace);
  });

  // --- 5) Mark async functions that now use await ---
  root
    .find(j.Function)
    .forEach(p => {
      if (!p.value.async && j(p).find(j.AwaitExpression).size()) {
        debug('Marking async function at line', p.value.loc.start.line);
        p.value.async = true;
      }
    });
  root
    .find(j.ArrowFunctionExpression)
    .forEach(p => {
      if (!p.value.async && j(p).find(j.AwaitExpression).size()) {
        debug('Marking async arrow at line', p.value.loc.start.line);
        p.value.async = true;
      }
    });

  return root.toSource({ quote: 'single' });

  // --- utility to handle __dirname + literals & path.join/resolve etc ---
  function transformArg(node) {
    // literal joins: __dirname + '/a/b'
    if (
      node.type === 'BinaryExpression' &&
      node.operator === '+' &&
      isDirname(node.left) &&
      node.right.type === 'Literal'
    ) {
      const seg = String(node.right.value).replace(/^\/+/, '');
      return makeURLLiteral(seg);
    }
    // path.join/resolve
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      node.callee.object.name === 'path' &&
      (node.callee.property.name === 'join' ||
        node.callee.property.name === 'resolve') &&
      node.arguments.length >= 2 &&
      isDirname(node.arguments[0]) &&
      node.arguments.slice(1).every(a => a.type === 'Literal')
    ) {
      const segs = node.arguments.slice(1).map(a => a.value);
      return makeURLLiteral(segs.join('/'));
    }
    return node;
  }
}