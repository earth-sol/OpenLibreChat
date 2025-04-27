/**
 * codemods/transform-config-scripts.js
 *
 * - CJS → ESM imports
 * - process.env.X → Bun.env.X
 * - fs.promises.readFile/writeFile → Bun.file(...).text() / Bun.write(...)
 * - fs.readFileSync/writeFileSync → await Bun.file(...).text() / Bun.write(...)
 *   (marks enclosing fn async if needed)
 * - child_process.execSync(...) → Bun.spawnSync(['sh','-c', ...], opts)
 *
 * Usage:
 *   jscodeshift -t codemods/transform-config-scripts.js "config/\*\*\/\*.{js,ts}" --parser=tsx --extensions=js,ts
 */
export default function transformer(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);

  // Helpers
  const imported = new Set();
  const newImports = [];
  const fsVars = new Set();       // local names for require('fs')
  const cpVars = new Set();       // local names for require('child_process')
  const cpExecs = new Set();      // local names for destructured execSync

  function toId(name) {
    return name.replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/^[^a-zA-Z]+/, '');
  }

  function ensureAsync(path) {
    let p = path;
    while (p && !(
      j.FunctionDeclaration.check(p.node) ||
      j.FunctionExpression.check(p.node) ||
      j.ArrowFunctionExpression.check(p.node)
    )) p = p.parentPath;
    if (p && !p.node.async) p.node.async = true;
  }

  // 1. Collect fs & child_process require() locals
  root.find(j.VariableDeclarator, {
    init: { type: 'CallExpression', callee: { name: 'require' }, arguments: [{ value: 'fs' }] }
  }).forEach(p => {
    if (j.Identifier.check(p.node.id)) {
      fsVars.add(p.node.id.name);
    } else if (j.ObjectPattern.check(p.node.id)) {
      p.node.id.properties.forEach(prop => {
        if (j.Property.check(prop) && j.Identifier.check(prop.value)) {
          fsVars.add(prop.value.name);
        }
      });
    }
  });

  root.find(j.VariableDeclarator, {
    init: { type: 'CallExpression', callee: { name: 'require' }, arguments: [{ value: 'child_process' }] }
  }).forEach(p => {
    const id = p.node.id;
    if (j.Identifier.check(id)) {
      cpVars.add(id.name);
    } else if (j.ObjectPattern.check(id)) {
      id.properties.forEach(prop => {
        if (j.Property.check(prop) && prop.key.name === 'execSync' && j.Identifier.check(prop.value)) {
          cpExecs.add(prop.value.name);
        }
      });
    }
  });

  // 2. Transform `const X = require('mod')` → `import X from 'mod'`
  root.find(j.VariableDeclarator, {
    init: { type: 'CallExpression', callee: { name: 'require' }, arguments: [{ type: 'Literal' }] }
  }).forEach(path => {
    const decl = path.node;
    const mod = decl.init.arguments[0].value;
    if (imported.has(mod)) return;
    const specs = [];
    if (j.Identifier.check(decl.id)) {
      specs.push(j.importDefaultSpecifier(j.identifier(decl.id.name)));
    } else if (j.ObjectPattern.check(decl.id)) {
      decl.id.properties.forEach(prop => {
        if (j.Property.check(prop) && j.Identifier.check(prop.key)) {
          const name = prop.key.name;
          const alias = prop.value.name;
          specs.push(name === alias
            ? j.importSpecifier(j.identifier(name))
            : j.importSpecifier(j.identifier(name), j.identifier(alias))
          );
        }
      });
    }
    if (specs.length) {
      newImports.push(j.importDeclaration(specs, j.literal(mod)));
      imported.add(mod);
    }
  });

  // 3. Transform dynamic require('module-alias')(…) → import + call
  root.find(j.ExpressionStatement, {
    expression: {
      type: 'CallExpression',
      callee: { type: 'CallExpression', callee: { name: 'require' }, arguments: [{ type: 'Literal' }] }
    }
  }).forEach(path => {
    const outer = path.node.expression;
    const inner = outer.callee;
    const mod = inner.arguments[0].value;
    const id = toId(mod);
    if (!imported.has(mod)) {
      newImports.push(j.importDeclaration(
        [j.importDefaultSpecifier(j.identifier(id))],
        j.literal(mod)
      ));
      imported.add(mod);
    }
    path.replace(
      j.expressionStatement(
        j.callExpression(j.identifier(id), outer.arguments)
      )
    );
  });

  // 4. Remove all original require() decls
  root.find(j.VariableDeclarator, {
    init: { type: 'CallExpression', callee: { name: 'require' } }
  }).forEach(path => {
    const p = path.parent.node;
    if (p.declarations.length === 1) j(path.parent).remove();
    else j(path).remove();
  });

  // 5. Insert our new imports at the top
  if (newImports.length) {
    const first = root.find(j.ImportDeclaration).at(0);
    if (first.size()) first.insertBefore(newImports);
    else root.get().node.program.body = [...newImports, ...root.get().node.program.body];
  }

  // 6. process.env.X → Bun.env.X
  root.find(j.MemberExpression, {
    object: { object: { name: 'process' }, property: { name: 'env' } }
  }).replaceWith(p =>
    j.memberExpression(
      j.memberExpression(j.identifier('Bun'), j.identifier('env')),
      p.node.property,
      p.node.computed
    )
  );

  // 7. child_process.execSync(...) → Bun.spawnSync(['sh','-c', ...], opts)
  root.find(j.CallExpression, {
    callee: path => (
      (path.type === 'MemberExpression'
        && cpVars.has(path.object.name)
        && path.property.name === 'execSync')
      || (path.type === 'Identifier' && cpExecs.has(path.name))
    )
  }).replaceWith(path => {
    const call = path.node;
    const cmd = call.arguments[0];
    const opts = call.arguments[1] || j.objectExpression([]);
    // if string, wrap in shell array
    const argsArray = j.isLiteral(cmd) && typeof cmd.value === 'string'
      ? j.arrayExpression([
          j.literal('sh'),
          j.literal('-c'),
          j.literal(cmd.value)
        ])
      : cmd;
    return j.callExpression(
      j.memberExpression(j.identifier('Bun'), j.identifier('spawnSync')),
      [argsArray, opts]
    );
  });

  // 8. fs.promises.readFile(...) → await Bun.file(...).text()
  root.find(j.AwaitExpression, {
    argument: {
      type: 'CallExpression',
      callee: {
        type: 'MemberExpression',
        object: {
          type: 'MemberExpression',
          object: obj => fsVars.has(obj.name),
          property: { name: 'promises' }
        },
        property: { name: 'readFile' }
      }
    }
  }).replaceWith(path => {
    const call = path.node.argument;
    const fileArg = call.arguments[0];
    const textCall = j.callExpression(
      j.memberExpression(
        j.callExpression(
          j.memberExpression(j.identifier('Bun'), j.identifier('file')),
          [fileArg]
        ),
        j.identifier('text')
      ),
      []
    );
    return j.awaitExpression(textCall);
  });

  // 9. fs.promises.writeFile(...) → await Bun.write(...)
  root.find(j.AwaitExpression, {
    argument: {
      type: 'CallExpression',
      callee: {
        type: 'MemberExpression',
        object: {
          type: 'MemberExpression',
          object: obj => fsVars.has(obj.name),
          property: { name: 'promises' }
        },
        property: { name: 'writeFile' }
      }
    }
  }).replaceWith(path => {
    const [fileArg, dataArg] = path.node.argument.arguments;
    const writeCall = j.callExpression(
      j.memberExpression(j.identifier('Bun'), j.identifier('write')),
      [fileArg, dataArg]
    );
    return j.awaitExpression(writeCall);
  });

  // 10. fs.readFileSync(...) & fs.writeFileSync(...) → await Bun.file(...).text()/Bun.write(...)
  ['readFileSync', 'writeFileSync'].forEach(fn => {
    root.find(j.CallExpression, {
      callee: {
        type: 'MemberExpression',
        object: obj => fsVars.has(obj.name),
        property: { name: fn }
      }
    }).replaceWith(path => {
      const call = path.node;
      const [fileArg, dataArg] = call.arguments;
      let expr;
      if (fn === 'readFileSync') {
        expr = j.callExpression(
          j.memberExpression(
            j.callExpression(
              j.memberExpression(j.identifier('Bun'), j.identifier('file')),
              [fileArg]
            ),
            j.identifier('text')
          ),
          []
        );
      } else { // writeFileSync
        expr = j.callExpression(
          j.memberExpression(j.identifier('Bun'), j.identifier('write')),
          [fileArg, dataArg]
        );
      }
      // wrap in await and mark fn async
      ensureAsync(path);
      return j.awaitExpression(expr);
    });
  });

  return root.toSource({ quote: 'single', trailingComma: true });
}