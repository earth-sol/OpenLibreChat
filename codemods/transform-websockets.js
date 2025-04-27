/**
 * codemods/transform-websockets.js
 *
 * Convert Socket.IO + app.listen → @elysia/ws + Bun.serve
 *
 * Usage:
 *   jscodeshift -t codemods/transform-websockets.js "<globs>"
 */

export default function transformer(fileInfo, { jscodeshift: j }) {
  const root = j(fileInfo.source);

  //
  // 1) Gather any socket.io Server names from imports or requires
  //
  const socketServerNames = new Set();

  // import Server from 'socket.io'
  root.find(j.ImportDeclaration, { source: { value: 'socket.io' } })
    .forEach(path => {
      path.node.specifiers.forEach(spec => {
        if (spec.imported?.name === 'Server') {
          socketServerNames.add(spec.local.name);
        } else if (spec.type === 'ImportDefaultSpecifier') {
          socketServerNames.add(spec.local.name);
        }
      });
      j(path).remove();
    });

  // const { Server } = require('socket.io')  OR  const io = require('socket.io')
  root.find(j.VariableDeclaration)
    .filter(path => {
      const dec = path.node.declarations[0];
      return dec.init?.callee?.name === 'require'
          && dec.init.arguments?.[0].value === 'socket.io';
    })
    .forEach(path => {
      const dec = path.node.declarations[0];
      if (dec.id.type === 'ObjectPattern') {
        dec.id.properties.forEach(p => {
          if (p.key.name === 'Server') socketServerNames.add(p.value.name);
        });
      } else if (dec.id.type === 'Identifier') {
        socketServerNames.add(dec.id.name);
      }
      j(path).remove();
    });

  if (!socketServerNames.size) {
    // nothing to do
    return null;
  }

  //
  // 2) Remove any `import http from 'http'` + `http.createServer(...)`
  //
  root.find(j.ImportDeclaration, { source: { value: 'http' } }).remove();
  root.find(j.CallExpression, {
    callee: {
      object: { name: 'http' },
      property: { name: 'createServer' }
    }
  }).forEach(path => j(path.parentPath).remove());

  //
  // 3) Inject `import { ws } from '@elysia/ws'` if missing
  //
  if (!root.find(j.ImportDeclaration, { source: { value: '@elysia/ws' } }).size()) {
    const imp = j.importDeclaration(
      [ j.importSpecifier(j.identifier('ws')) ],
      j.literal('@elysia/ws')
    );
    root.get().node.program.body.unshift(imp);
  }

  //
  // 4) Locate your Elysia app variable (e.g. `const app = new Elysia()`)
  //
  let appName = 'app';
  root.find(j.NewExpression, { callee: { name: 'Elysia' } })
    .forEach(path => {
      const parent = path.parentPath.node;
      if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
        appName = parent.id.name;
      }
    });

  //
  // 5) Insert `app.use(ws())` right after `new Elysia()`
  //
  const useWs = j.expressionStatement(
    j.callExpression(
      j.memberExpression(j.identifier(appName), j.identifier('use')),
      [ j.callExpression(j.identifier('ws'), []) ]
    )
  );
  root.find(j.VariableDeclarator, {
    id: { name: appName },
    init: { type: 'NewExpression', callee: { name: 'Elysia' } }
  }).forEach(path => {
    // insert after the entire `const app = new Elysia(...);` statement
    path.parentPath.parent.insertAfter(useWs);
  });

  //
  // 6) Remove any `new Server(...)` (Socket.IO server instantiation)
  //
  const ioNames = new Set();
  socketServerNames.forEach(name => {
    root.find(j.NewExpression, { callee: { name } })
      .forEach(path => {
        const varName = path.parentPath.node.id?.name;
        if (varName) ioNames.add(varName);
        j(path.parentPath).remove();
      });
  });

  //
  // 7) Transform each `io.on('connection', socket => { … })`
  //    into `app.ws('/socket.io', { open: socket => { … } })`
  //
  ioNames.forEach(ioName => {
    root.find(j.CallExpression, {
      callee: {
        object: { name: ioName },
        property: { name: 'on' }
      }
    })
    .filter(path => {
      const [evt, handler] = path.node.arguments;
      return evt.value === 'connection'
          && (handler.type === 'ArrowFunctionExpression' || handler.type === 'FunctionExpression');
    })
    .forEach(path => {
      const [, handler] = path.node.arguments;
      const sockParam = handler.params[0] || j.identifier('socket');
      const body = handler.body;

      // rewrite socket.emit(...) → socket.send(...)
      j(body)
        .find(j.CallExpression, {
          callee: {
            object: { name: sockParam.name },
            property: { name: 'emit' }
          }
        })
        .forEach(p => p.node.callee.property.name = 'send');

      // build ws options: only `open`
      const wsOpts = j.objectExpression([
        j.property(
          'init',
          j.identifier('open'),
          j.functionExpression(
            null,
            [ sockParam ],
            body.type === 'BlockStatement'
              ? body
              : j.blockStatement([ j.returnStatement(body) ])
          )
        )
      ]);

      // insert `app.ws('/socket.io', { open: … })` right after our `app.use(ws())`
      const wsCall = j.expressionStatement(
        j.callExpression(
          j.memberExpression(j.identifier(appName), j.identifier('ws')),
          [ j.literal('/socket.io'), wsOpts ]
        )
      );
      root.find(j.ExpressionStatement, stmt => stmt === useWs)
          .forEach(p => p.insertAfter(wsCall));

      // remove original io.on(...)
      j(path).remove();
    });
  });

  //
  // 8) Replace final `app.listen(port)` with `Bun.serve({ fetch: app.handle, websocket:{}, port })`
  //
  root.find(j.CallExpression, {
    callee: {
      object: { name: appName },
      property: { name: 'listen' }
    }
  }).forEach(path => {
    const args = path.node.arguments;
    // derive port: use first argument or fallback to Bun.env.PORT || 3000
    let portExpr;
    if (args[0]) {
      portExpr = args[0];
    } else {
      portExpr = j.logicalExpression(
        '||',
        j.memberExpression(
          j.memberExpression(j.identifier('Bun'), j.identifier('env')),
          j.identifier('PORT')
        ),
        j.literal(3000)
      );
    }

    // build Bun.serve({ fetch: app.handle, websocket: {}, port: <expr> })
    const serveCall = j.callExpression(
      j.memberExpression(j.identifier('Bun'), j.identifier('serve')),
      [ j.objectExpression([
          j.property('init', j.identifier('fetch'),
            j.memberExpression(j.identifier(appName), j.identifier('handle'))
          ),
          j.property('init', j.identifier('websocket'),
            j.objectExpression([])
          ),
          j.property('init', j.identifier('port'),
            portExpr
          )
        ])
      ]
    );

    // replace the whole `app.listen(...)` expression statement
    j(path.parentPath).replaceWith(j.expressionStatement(serveCall));
  });

  //
  // Done
  //
  return root.toSource({ quote: 'single' });
}