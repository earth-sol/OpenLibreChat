/**
 * codemods/inline-pluginserver-elysia.js
 */
export default function transformer(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);

  // 1. Remove Express & pluginServer imports
  root.find(j.ImportDeclaration, { source: { value: 'express' } }).remove();
  root.find(j.ImportDeclaration, { source: { value: './pluginServer' } }).remove();

  // 2. Insert Elysia & staticPlugin + fs/path imports
  const firstImp = root.find(j.ImportDeclaration).at(0);
  firstImp.insertBefore(
    j.importDeclaration(
      [j.importSpecifier(j.identifier('Elysia')), j.importSpecifier(j.identifier('file'))],
      j.literal('elysia')
    )
  );
  firstImp.insertBefore(
    j.importDeclaration(
      [j.importSpecifier(j.identifier('staticPlugin'))],
      j.literal('@elysiajs/static')
    )
  );
  firstImp.insertBefore(
    j.importDeclaration(
      [j.importSpecifier(j.identifier('readFileSync'))],
      j.literal('fs')
    )
  );
  firstImp.insertBefore(
    j.importDeclaration(
      [j.importSpecifier(j.identifier('resolve')), j.importSpecifier(j.identifier('join'))],
      j.literal('path')
    )
  );

  // 3. Inject config-loading boilerplate (sync)
  firstImp.insertBefore(
    j.template.statement(`
const rawCfg = readFileSync(resolve(__dirname, '../../config/config.json'), 'utf-8');
const cfg    = JSON.parse(rawCfg);
const PORT   = Number(process.env.PLUGIN_SERVER_PORT) || cfg.pluginServer.port;
const PREFIX = process.env.PLUGIN_SERVER_STATIC_PREFIX || cfg.pluginServer.staticPrefix;
const PLUGINS_DIR = process.env.PLUGIN_SERVER_DIR
  ? resolve(process.env.PLUGIN_SERVER_DIR)
  : resolve(__dirname, '../../', cfg.pluginServer.pluginsDir);
const MANIFEST_ROUTE = process.env.PLUGIN_MANIFEST_ROUTE || cfg.api.manifestRoute;
const CONFIG_ROUTE   = process.env.PLUGIN_CONFIG_ROUTE   || cfg.api.configRoute;
    `)
  );

  // 4. Replace `const app = express()` → `const app = new Elysia()`
  root.find(j.VariableDeclarator, {
    id: { name: 'app' },
    init: { callee: { name: 'express' } }
  })
  .replaceWith(() =>
    j.variableDeclarator(
      j.identifier('app'),
      j.newExpression(j.identifier('Elysia'), [])
    )
  );

  // 5. Remove `app.use(pluginServer)`
  root.find(j.ExpressionStatement, {
    expression: {
      callee: { object: { name: 'app' }, property: { name: 'use' } },
      arguments: [{ name: 'pluginServer' }]
    }
  }).remove();

  // 6. Inject staticPlugin and routes before listen()
  root.find(j.CallExpression, { callee: { property: { name: 'listen' } } })
    .forEach(path => {
      // serve /plugins
      j(path).insertBefore(
        j.expressionStatement(
          j.callExpression(
            j.memberExpression(j.identifier('app'), j.identifier('use')),
            [
              j.callExpression(j.identifier('staticPlugin'), [
                j.objectExpression([
                  j.property('init', j.identifier('assets'), j.identifier('PLUGINS_DIR')),
                  j.property('init', j.identifier('prefix'), j.identifier('PREFIX'))
                ])
              ])
            ]
          )
        )
      );

      // GET /api/plugins
      j(path).insertBefore(
        j.expressionStatement(
          j.callExpression(
            j.memberExpression(j.identifier('app'), j.identifier('get')),
            [
              j.identifier('MANIFEST_ROUTE'),
              j.arrowFunctionExpression(
                [],
                j.blockStatement([
                  j.variableDeclaration('const', [
                    j.variableDeclarator(
                      j.identifier('entries'),
                      j.callExpression(
                        j.memberExpression(j.identifier('file'), j.identifier('entriesSync')),
                        [j.identifier('PLUGINS_DIR')]
                      )
                    )
                  ]),
                  j.returnStatement(
                    j.callExpression(
                      j.memberExpression(
                        j.callExpression(
                          j.memberExpression(
                            j.callExpression(
                              j.memberExpression(j.identifier('entries'), j.identifier('filter')),
                              [j.arrowFunctionExpression(
                                [j.identifier('f')],
                                j.callExpression(
                                  j.memberExpression(
                                    j.memberExpression(j.identifier('f'), j.identifier('name')),
                                    j.identifier('endsWith')
                                  ),
                                  [j.literal('manifest.json')]
                                )
                              )]
                            ),
                            j.identifier('map')
                          ),
                          [j.arrowFunctionExpression(
                            [j.identifier('f')],
                            j.blockStatement([
                              j.variableDeclaration('const', [
                                j.variableDeclarator(
                                  j.identifier('m'),
                                  j.callExpression(
                                    j.memberExpression(j.identifier('JSON'), j.identifier('parse')),
                                    [
                                      j.callExpression(
                                        j.memberExpression(j.identifier('readFileSync'), j.identifier('readFileSync')),
                                        [
                                          j.callExpression(
                                            j.memberExpression(j.identifier('join'), j.identifier('join')),
                                            [j.identifier('PLUGINS_DIR'), j.memberExpression(j.identifier('f'), j.identifier('name'))]
                                          ),
                                          j.literal('utf-8')
                                        ]
                                      )
                                    ]
                                  )
                                )
                              ]),
                              j.returnStatement(
                                j.objectExpression([
                                  j.spreadElement(j.identifier('m')),
                                  j.property(
                                    'init',
                                    j.identifier('url'),
                                    j.templateLiteral(
                                      [
                                        j.templateElement({ raw: '', cooked: '' }, false),
                                        j.templateElement({ raw: '/ui.js', cooked: '/ui.js' }, true)
                                      ],
                                      [j.identifier('PREFIX'), j.memberExpression(j.identifier('m'), j.identifier('id'))]
                                    )
                                  )
                                ])
                              )
                            ])
                          )]
                          ),
                        ),
                        j.identifier('sort')
                      ),
                      [j.arrowFunctionExpression(
                        [j.identifier('a'), j.identifier('b')],
                        j.binaryExpression('-', j.memberExpression(j.identifier('a'), j.identifier('order')), j.memberExpression(j.identifier('b'), j.identifier('order')))
                      )]
                    )
                  )
                ])
              )
            ]
          )
        )
      );

      // GET /api/config
      j(path).insertBefore(
        j.expressionStatement(
          j.callExpression(
            j.memberExpression(j.identifier('app'), j.identifier('get')),
            [
              j.identifier('CONFIG_ROUTE'),
              j.arrowFunctionExpression(
                [],
                j.objectExpression([
                  j.property('init', j.identifier('pluginServer'),
                    j.objectExpression([
                      j.property('init', j.identifier('port'), j.identifier('PORT')),
                      j.property('init', j.identifier('staticPrefix'), j.identifier('PREFIX')),
                      j.property('init', j.identifier('pluginsDir'), j.identifier('PLUGINS_DIR'))
                    ])
                  ),
                  j.property('init', j.identifier('api'),
                    j.objectExpression([
                      j.property('init', j.identifier('manifestRoute'), j.identifier('MANIFEST_ROUTE')),
                      j.property('init', j.identifier('configRoute'), j.identifier('CONFIG_ROUTE'))
                    ])
                  )
                ])
              )
            ]
          )
        )
      );
    });

  return root.toSource({ quote: 'single', trailingComma: true });
}