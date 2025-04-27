// codemods/transform-session-auth.js
import { color } from 'bun';

export default function transformer(fileInfo, { jscodeshift: j, stats }) {
  stats.verbose = true;
  const root = j(fileInfo.source);
  const filePath = fileInfo.path;

  // Collect whatever names you bound to express-session & passport
  const sessionAliases = new Set();
  const passportAliases = new Set();

  // Helper: log if verbose
  const log = (msg, c = 'green') => {
    console.log(color(`[transform-session-auth] ${msg}`, c));
  };

  try {
    // ──────────────────────────────────────────────────────────────────────────
    // 1) Find & remove imports/requires for express-session → track alias
    // ──────────────────────────────────────────────────────────────────────────
    root.find(j.ImportDeclaration, { source: { value: 'express-session' } })
      .forEach(path => {
        path.node.specifiers.forEach(spec =>
          sessionAliases.add(spec.local.name)
        );
        log(`stripping ESM import from 'express-session'`, 'yellow');
        j(path).remove();
      });

    root.find(j.VariableDeclarator, {
      init: {
        callee: { name: 'require' },
        arguments: [{ value: 'express-session' }]
      }
    }).forEach(path => {
      const id = path.node.id;
      if (id.type === 'Identifier') {
        sessionAliases.add(id.name);
      } else if (id.type === 'ObjectPattern') {
        id.properties.forEach(prop =>
          sessionAliases.add(prop.value.name)
        );
      }
      log(`stripping CJS require('express-session')`, 'yellow');
      j(path.parentPath).remove();
    });

    // ──────────────────────────────────────────────────────────────────────────
    // 2) Find & remove imports/requires for passport → track alias
    // ──────────────────────────────────────────────────────────────────────────
    root.find(j.ImportDeclaration, { source: { value: 'passport' } })
      .forEach(path => {
        path.node.specifiers.forEach(spec =>
          passportAliases.add(spec.local.name)
        );
        log(`stripping ESM import from 'passport'`, 'yellow');
        j(path).remove();
      });

    root.find(j.VariableDeclarator, {
      init: {
        callee: { name: 'require' },
        arguments: [{ value: 'passport' }]
      }
    }).forEach(path => {
      const id = path.node.id;
      if (id.type === 'Identifier') {
        passportAliases.add(id.name);
      }
      log(`stripping CJS require('passport')`, 'yellow');
      j(path.parentPath).remove();
    });

    // ──────────────────────────────────────────────────────────────────────────
    // 3) Inject Session import if missing
    // ──────────────────────────────────────────────────────────────────────────
    const hasSessionImport = root.find(j.ImportDeclaration, {
      source: { value: '@elysia/session' }
    }).size();

    if (!hasSessionImport) {
      log(`inserting import Session from '@elysia/session'`, 'cyan');
      const imp = j.importDeclaration(
        [ j.importDefaultSpecifier(j.identifier('Session')) ],
        j.literal('@elysia/session')
      );
      root.get().node.program.body.unshift(imp);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 4) Rewrite app.use(<sessionAlias>(opts)) → app.use(Session(opts))
    // ──────────────────────────────────────────────────────────────────────────
    if (sessionAliases.size) {
      const isSessionCall = path =>
        path.node.arguments.length === 1 &&
        path.node.arguments[0].callee &&
        sessionAliases.has(path.node.arguments[0].callee.name);

      root.find(j.CallExpression, {
        callee: { object: { name: 'app' }, property: { name: 'use' } }
      })
      .filter(isSessionCall)
      .forEach(path => {
        const oldName = path.node.arguments[0].callee.name;
        log(`replacing app.use(${oldName}(…)) with app.use(Session(…))`, 'magenta');
        const opts = path.node.arguments[0].arguments;
        path.get('arguments', 0).replace(
          j.callExpression(j.identifier('Session'), opts)
        );
      });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 5) Remove all passport.initialize()/passport.session() uses
    // ──────────────────────────────────────────────────────────────────────────
    if (passportAliases.size) {
      ['initialize', 'session'].forEach(fnName => {
        root.find(j.ExpressionStatement, {
          expression: {
            callee: {
              object: aliasObj => passportAliases.has(aliasObj.name),
              property: { name: fnName }
            }
          }
        })
        .forEach(path => {
          log(`removing app.use(passport.${fnName}())`, 'magenta');
          j(path).remove();
        });
      });

      // Remove any passport.use(...) calls (strategy registration)
      root.find(j.CallExpression, {
        callee: {
          object: aliasObj => passportAliases.has(aliasObj.name),
          property: { name: 'use' }
        }
      })
      .forEach(path => {
        log(`removing ${path.node.callee.object.name}.use(...)`, 'magenta');
        // drop the entire statement
        j(path.parentPath).remove();
      });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 6) Optionally inject an auth‐mapping hook (if your session plugin supports it)
    //    -- adjust or remove if your plugin uses a different API
    // ──────────────────────────────────────────────────────────────────────────
    const hasAuthHook = root.find(j.CallExpression, {
      callee: { object: { name: 'app' }, property: { name: 'auth' } }
    }).size();

    if (!hasAuthHook) {
      log(`injecting app.auth hook → map ctx.session.user`, 'cyan');
      const hook = j.expressionStatement(
        j.callExpression(
          j.memberExpression(j.identifier('app'), j.identifier('auth')),
          [ j.arrowFunctionExpression(
              [ j.identifier('ctx') ],
              j.conditionalExpression(
                j.logicalExpression(
                  '&&',
                  j.memberExpression(
                    j.identifier('ctx'),
                    j.identifier('session')
                  ),
                  j.memberExpression(
                    j.identifier('ctx.session'),
                    j.identifier('user')
                  )
                ),
                j.memberExpression(
                  j.identifier('ctx.session'),
                  j.identifier('user')
                ),
                j.literal(null)
              )
            )
          ]
        )
      );
      // append at end
      root.get().node.program.body.push(hook);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Generate output
    // ──────────────────────────────────────────────────────────────────────────
    log(`finished transform on ${filePath}`, 'green');
    return root.toSource({ quote: 'single', trailingComma: true });
  }
  catch (err) {
    console.error(color(
      `[transform-session-auth] ERROR in ${filePath}: ${err.message}`,
      'red'
    ));
    // fail‐safe: return original
    return fileInfo.source;
  }
}