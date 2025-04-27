// codemods/transform-server-index.js

export default function transformer(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);

  /**
   * Utility: add an import declaration if it doesn’t already exist.
   * @param {Array<j.ImportSpecifier|j.ImportDefaultSpecifier>} specifiers
   * @param {string} source
   */
  function addImport(specifiers, source) {
    if (!root.find(j.ImportDeclaration, { source: { value: source } }).size()) {
      const imp = j.importDeclaration(specifiers, j.literal(source));
      root.get().value.program.body.unshift(imp);
    }
  }

  //
  // 1. Remove dotenv and module-alias calls
  //
  root
    .find(j.ExpressionStatement, {
      expression: {
        type: 'CallExpression',
        callee: {
          object: {
            type: 'CallExpression',
            callee: { name: 'require', arguments: [{ value: 'dotenv' }] }
          },
          property: { name: 'config' }
        }
      }
    })
    .remove();

  root
    .find(j.ExpressionStatement, {
      expression: {
        type: 'CallExpression',
        callee: { name: 'require', arguments: [{ value: 'module-alias' }] }
      }
    })
    .remove();

  //
  // 2. Replace path.join(__dirname, …) → new URL('…', import.meta.url).pathname
  //
  root
    .find(j.CallExpression, {
      callee: {
        object: { name: 'path' },
        property: { name: 'join' }
      }
    })
    .replaceWith(path => {
      const args = path.node.arguments.slice(1); // drop __dirname
      // only handle string literals for relative paths
      const rel = args
        .filter(a => a.type === 'Literal')
        .map(a => a.value)
        .join('/');
      const urlExpr = j.newExpression(j.identifier('URL'), [
        j.literal(rel),
        j.memberExpression(
          j.memberExpression(j.identifier('import'), j.identifier('meta')),
          j.identifier('url')
        )
      ]);
      return j.memberExpression(urlExpr, j.identifier('pathname'));
    });

  // Remove any path imports/requires
  root.find(j.ImportDeclaration, { source: { value: 'path' } }).remove();
  root
    .find(j.VariableDeclarator, {
      id: { name: 'path' },
      init: { callee: { name: 'require', arguments: [{ value: 'path' }] } }
    })
    .remove();

  //
  // 3. Replace fs.readFileSync(...) → await Bun.file(...).text()
  //
  root
    .find(j.CallExpression, {
      callee: {
        object: { name: 'fs' },
        property: { name: 'readFileSync' }
      }
    })
    .replaceWith(path => {
      const [fileArg] = path.node.arguments;
      return j.awaitExpression(
        j.callExpression(
          j.memberExpression(
            j.callExpression(j.identifier('Bun.file'), [fileArg]),
            j.identifier('text')
          ),
          []
        )
      );
    });

  // Remove fs import
  root.find(j.ImportDeclaration, { source: { value: 'fs' } }).remove();
  root
    .find(j.VariableDeclarator, {
      id: { name: 'fs' },
      init: { callee: { name: 'require', arguments: [{ value: 'fs' }] } }
    })
    .remove();

  //
  // 4. Convert all other require(...) → import … from '…'
  //    except express (handled below)
  //
  const mapping = {
    'cors': '@elysia/cors',
    'compression': '@elysia/compression',
    'cookie-parser': '@elysia/cookie',
    'express-mongo-sanitize': 'express-mongo-sanitize',
    'axios': 'axios',
    'passport': 'passport',
    '~/strategies': '~/strategies',
    '~/lib/db': '~/lib/db',
    '~/server/utils': '~/server/utils',
    '~/config': '~/config',
    './utils/staticCache': './utils/staticCache',
    './middleware/noIndex': './middleware/noIndex',
    './middleware/errorController': './middleware/errorController',
    './routes': './routes'
  };

  root
    .find(j.VariableDeclarator, {
      init: { type: 'CallExpression', callee: { name: 'require' } }
    })
    .forEach(path => {
      const src = path.node.init.arguments[0].value;
      if (src === 'express') return;
      const target = mapping[src];
      if (!target) return;
      const id = path.node.id;
      const specs = [];
      if (id.type === 'Identifier') {
        specs.push(j.importDefaultSpecifier(j.identifier(id.name)));
      } else if (id.type === 'ObjectPattern') {
        id.properties.forEach(prop => {
          specs.push(j.importSpecifier(j.identifier(prop.key.name)));
        });
      }
      addImport(specs, target);
      j(path.parent).remove();
    });

  //
  // 5. Import Elysia
  //
  addImport([j.importSpecifier(j.identifier('Elysia'))], 'elysia');

  //
  // 6. Replace const app = express() → const app = new Elysia({ bodyLimit: '3mb' })
  //
  root
    .find(j.VariableDeclarator, {
      init: { type: 'CallExpression', callee: { name: 'express' } }
    })
    .forEach(path => {
      path.node.init = j.newExpression(j.identifier('Elysia'), [
        j.objectExpression([
          j.property('init', j.identifier('bodyLimit'), j.literal('3mb'))
        ])
      ]);
    });

  //
  // 7. Remove Express’s JSON & URL‐encoded middleware
  //
  root
    .find(j.CallExpression, {
      callee: {
        object: { name: 'app' },
        property: { name: 'use' }
      },
      arguments: [
        {
          callee: {
            object: { name: 'express' },
            property: { name: /^(json|urlencoded)$/ }
          }
        }
      ]
    })
    .remove();

  //
  // 8. Mount middleware as Elysia plugins/hooks
  //

  // cookieParser → app.use(cookie())
  root
    .find(j.CallExpression, {
      callee: { object: { name: 'app' }, property: { name: 'use' } },
      arguments: [{ callee: { name: 'cookieParser' } }]
    })
    .replaceWith(() =>
      j.callExpression(
        j.memberExpression(j.identifier('app'), j.identifier('use')),
        [j.callExpression(j.identifier('cookie'), [])]
      )
    );

  // mongoSanitize → app.hook('preHandler', mongoSanitize())
  root
    .find(j.CallExpression, {
      callee: { object: { name: 'app' }, property: { name: 'use' } },
      arguments: [{ callee: { name: 'mongoSanitize' } }]
    })
    .replaceWith(() =>
      j.callExpression(
        j.memberExpression(j.identifier('app'), j.identifier('hook')),
        [j.literal('preHandler'), j.callExpression(j.identifier('mongoSanitize'), [])]
      )
    );

  // staticCache(dir) → app.static(dir, { maxAge: Number(Bun.env.STATIC_CACHE_S_MAX_AGE) })
  root
    .find(j.CallExpression, {
      callee: { object: { name: 'app' }, property: { name: 'use' } },
      arguments: [{ callee: { name: 'staticCache' } }]
    })
    .replaceWith(path => {
      const dirArg = path.node.arguments[0].arguments[0];
      return j.callExpression(
        j.memberExpression(j.identifier('app'), j.identifier('static')),
        [
          dirArg,
          j.objectExpression([
            j.property(
              'init',
              j.identifier('maxAge'),
              j.callExpression(j.identifier('Number'), [
                j.memberExpression(
                  j.memberExpression(j.identifier('Bun'), j.identifier('env')),
                  j.identifier('STATIC_CACHE_S_MAX_AGE')
                )
              ])
            )
          ])
        ]
      );
    });

  // noIndex → app.hook('onRequest', noIndex)
  root
    .find(j.CallExpression, {
      callee: { object: { name: 'app' }, property: { name: 'use' } },
      arguments: [{ name: 'noIndex' }]
    })
    .replaceWith(() =>
      j.callExpression(
        j.memberExpression(j.identifier('app'), j.identifier('hook')),
        [j.literal('onRequest'), j.identifier('noIndex')]
      )
    );

  // errorController → app.onError(errorController)
  root
    .find(j.CallExpression, {
      callee: { object: { name: 'app' }, property: { name: 'use' } },
      arguments: [{ name: 'errorController' }]
    })
    .replaceWith(() =>
      j.callExpression(
        j.memberExpression(j.identifier('app'), j.identifier('onError')),
        [j.identifier('errorController')]
      )
    );

  //
  // 9. Replace app.listen(port, host, cb) → await app.listen({ port, hostname: host })
  //
  root
    .find(j.CallExpression, {
      callee: { object: { name: 'app' }, property: { name: 'listen' } }
    })
    .replaceWith(() =>
      j.awaitExpression(
        j.callExpression(
          j.memberExpression(j.identifier('app'), j.identifier('listen')),
          [
            j.objectExpression([
              j.property('init', j.identifier('port'), j.identifier('port')),
              j.property('init', j.identifier('hostname'), j.identifier('host'))
            ])
          ]
        )
      )
    );

  //
  // 10. Wrap startServer() call in top-level await
  //
  root
    .find(j.ExpressionStatement, {
      expression: { type: 'CallExpression', callee: { name: 'startServer' } }
    })
    .forEach(path => {
      path.node.expression = j.awaitExpression(path.node.expression);
    });

  return root.toSource({ quote: 'single', trailingComma: true });
}