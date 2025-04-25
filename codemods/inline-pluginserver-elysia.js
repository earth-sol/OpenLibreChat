// codemods/inline-pluginserver-elysia.js
export default function transformer(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);

  //
  // 1. Remove Express & pluginServer imports
  //
  root
    .find(j.ImportDeclaration, {
      source: { value: 'express' }
    })
    .remove(); // Remove Express import  [oai_citation:0‡Hypermod](https://www.hypermod.io/docs/guides/import-manipulation?utm_source=chatgpt.com)

  root
    .find(j.ImportDeclaration, {
      source: { value: './pluginServer' }
    })
    .remove(); // Remove pluginServer import  [oai_citation:1‡Gist](https://gist.github.com/8f5a6a78268839abaca78ad1fbe8368c?utm_source=chatgpt.com)

  //
  // 2. Insert Elysia, staticPlugin, fs, path imports
  //
  const firstImport = root.find(j.ImportDeclaration).at(0);
  firstImport.insertBefore(
    j.importDeclaration(
      [ j.importSpecifier(j.identifier('Elysia')), j.importSpecifier(j.identifier('file')) ],
      j.literal('elysia')
    )
  ); //  [oai_citation:2‡TalentConnect](https://www.toptal.com/javascript/write-code-to-rewrite-your-code?utm_source=chatgpt.com)

  firstImport.insertBefore(
    j.importDeclaration(
      [ j.importSpecifier(j.identifier('staticPlugin')) ],
      j.literal('@elysiajs/static')
    )
  ); //  [oai_citation:3‡Elysia - Ergonomic Framework for Humans](https://elysiajs.com/plugins/static?utm_source=chatgpt.com)

  firstImport.insertBefore(
    j.importDeclaration(
      [ j.importSpecifier(j.identifier('readFileSync')) ],
      j.literal('fs')
    )
  ); //  [oai_citation:4‡jscodeshift](https://jscodeshift.com/build/api-reference/?utm_source=chatgpt.com)

  firstImport.insertBefore(
    j.importDeclaration(
      [ j.importSpecifier(j.identifier('resolve')), j.importSpecifier(j.identifier('join')) ],
      j.literal('path')
    )
  ); //  [oai_citation:5‡jscodeshift](https://jscodeshift.com/build/api-reference/?utm_source=chatgpt.com)

  //
  // 3. Inject config-loading boilerplate after imports
  //
  const configAst = j.template.statement(`
    const rawCfg = readFileSync(resolve(__dirname, '../../config/config.json'), 'utf-8');
    const cfg = JSON.parse(rawCfg);
    const PORT = Number(process.env.PLUGIN_SERVER_PORT) || cfg.pluginServer.port;
    const PREFIX = process.env.PLUGIN_SERVER_STATIC_PREFIX || cfg.pluginServer.staticPrefix;
    const PLUGINS_DIR = process.env.PLUGIN_SERVER_DIR
      ? resolve(process.env.PLUGIN_SERVER_DIR)
      : resolve(__dirname, '../../', cfg.pluginServer.pluginsDir);
    const MANIFEST_ROUTE = process.env.PLUGIN_MANIFEST_ROUTE || cfg.api.manifestRoute;
    const CONFIG_ROUTE = process.env.PLUGIN_CONFIG_ROUTE   || cfg.api.configRoute;
  `);

  firstImport.insertBefore(configAst); //  [oai_citation:6‡Elysia - Ergonomic Framework for Humans](https://elysiajs.com/tutorial?utm_source=chatgpt.com)

  //
  // 4. Replace `const app = express()` with `const app = new Elysia()`
  //
  root
    .find(j.VariableDeclarator, {
      id: { name: 'app' },
      init: { callee: { name: 'express' } }
    })
    .forEach(path => {
      j(path).replaceWith(
        j.variableDeclarator(
          j.identifier('app'),
          j.newExpression(j.identifier('Elysia'), [])
        )
      );
    }); //  [oai_citation:7‡jscodeshift](https://jscodeshift.com/build/api-reference/?utm_source=chatgpt.com)

  //
  // 5. Remove any existing `app.use(pluginServer)` calls
  //
  root
    .find(j.ExpressionStatement, {
      expression: {
        callee: {
          object: { name: 'app' },
          property: { name: 'use' }
        },
        arguments: [{ name: 'pluginServer' }]
      }
    })
    .remove(); //  [oai_citation:8‡jscodeshift](https://jscodeshift.com/build/api-reference/?utm_source=chatgpt.com)

  //
  // 6. Inject .use(staticPlugin) and .get(...) before app.listen(...)
  //
  const listenCall = root.find(j.CallExpression, {
    callee: { property: { name: 'listen' } }
  });
  listenCall.forEach(path => {
    // Insert staticPlugin usage
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
    ); //  [oai_citation:9‡Elysia - Ergonomic Framework for Humans](https://elysiajs.com/plugins/static?utm_source=chatgpt.com)

    // Insert manifest route
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
                        j.memberExpression(j.identifier('entries'), j.identifier('filter')),
                        [
                          j.arrowFunctionExpression(
                            [j.identifier('f')],
                            j.callExpression(
                              j.memberExpression(
                                j.memberExpression(j.identifier('f'), j.identifier('name')),
                                j.identifier('endsWith')
                              ),
                              [j.literal('manifest.json')]
                            )
                          )
                        ]
                      ),
                      j.identifier('map')
                    ),
                    [
                      j.arrowFunctionExpression(
                        [j.identifier('f')],
                        j.blockStatement([
                          j.variableDeclaration('const', [
                            j.variableDeclarator(
                              j.identifier('m'),
                              j.callExpression(
                                j.memberExpression(
                                  j.identifier('JSON'),
                                  j.identifier('parse')
                                ),
                                [
                                  j.callExpression(
                                    j.memberExpression(
                                      j.identifier('readFileSync'),
                                      j.identifier('readFileSync')
                                    ),
                                    [
                                      j.callExpression(
                                        j.memberExpression(
                                          j.identifier('join'),
                                          j.identifier('join')
                                        ),
                                        [
                                          j.identifier('PLUGINS_DIR'),
                                          j.memberExpression(j.identifier('f'), j.identifier('name'))
                                        ]
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
                                    j.templateElement({ raw: '', cooked: '' }, true)
                                  ],
                                  [j.identifier('PREFIX'), j.memberExpression(j.identifier('m'), j.identifier('id')), j.literal('/ui.js')]
                                )
                              )
                            ])
                          )
                        ])
                      )
                    ]
                  )
                ),
                // .sort((a,b)=>a.order-b.order)
                j.callExpression(
                  j.memberExpression(
                    j.callExpression(
                      j.memberExpression(
                        j.callExpression(
                          j.memberExpression(j.identifier('map'), j.identifier('sort')),
                          []
                        ),
                        j.identifier('sort')
                      ),
                      []
                    ),
                    j.identifier('sort')
                  ),
                  [
                    j.arrowFunctionExpression(
                      [j.identifier('a'), j.identifier('b')],
                      j.binaryExpression('-', j.memberExpression(j.identifier('a'), j.identifier('order')), j.memberExpression(j.identifier('b'), j.identifier('order')))
                    )
                  ]
                )
              ])
            )
          ]
        )
      )
    ); //  [oai_citation:10‡Elysia - Ergonomic Framework for Humans](https://elysiajs.com/essential/route?utm_source=chatgpt.com)

    // Insert config route
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
    ); //  [oai_citation:11‡Elysia - Ergonomic Framework for Humans](https://elysiajs.com/essential/route?utm_source=chatgpt.com)
  });

  return root.toSource({ quote: 'single', trailingComma: true });
}