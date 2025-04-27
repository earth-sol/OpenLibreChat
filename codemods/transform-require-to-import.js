import { env, color } from 'bun';
/**
 * codemods/transform-require-to-import.js
 *
 * Generic CommonJS→ESM:
 *  - `const X = require('Y')`           → `import X from 'Y';`
 *  - `const { a, b: c } = require('Y')` → `import { a, b as c } from 'Y';`
 *  - `require('side-effect')`           → `import 'side-effect';`
 *  - `require('mod').prop`              → `import * as _mod from 'mod'; _mod.prop`
 *  - `module.exports = X`               → `export default X;`
 *  - `exports.foo = Y`                  → `export const foo = Y;`
 *  - Dynamic `require(expr)`            → `await import(expr)`
 *
 * Defaults to verbose debug logging; disable by `export DEBUG_REQUIRE_TO_IMPORT='false'`.
 */

export default function transformer(fileInfo, api) {
  const j = api.jscodeshift;
  const root = j(fileInfo.source);

  // debug flag
  const DEBUG = env.DEBUG_REQUIRE_TO_IMPORT !== 'false';
  const log = (...args) => DEBUG
    && console.debug(color('gray', '[transform-require-to-import]'), ...args);

  // helper: sanitize module names into JS identifiers
  function sanitizeIdentifier(str) {
    return str
      .replace(/[^A-Za-z0-9_$]/g, '_')
      .replace(/^(\d)/, '_$1');
  }

  // collect existing imports
  const importMap = new Map();   // module → { node: ImportDeclaration, alias?:string }
  const newImports = [];

  root.find(j.ImportDeclaration).forEach(path => {
    const src = path.node.source.value;
    importMap.set(src, { node: path.node, alias: null });
  });

  // 1) side-effect requires → import 'mod';
  root.find(j.ExpressionStatement, {
    expression: {
      type: 'CallExpression',
      callee: { name: 'require' },
      arguments: [{ type: 'Literal' }]
    }
  }).forEach(path => {
    const mod = path.node.expression.arguments[0].value;
    if (!importMap.has(mod)) {
      const imp = j.importDeclaration([], j.literal(mod));
      newImports.push(imp);
      importMap.set(mod, { node: imp, alias: null });
      log(`→ added side-effect import '${mod}'`);
    }
    j(path).remove();
  });

  // 2) const/let/var X = require('Y') or {…} = require('Y')
  root.find(j.VariableDeclarator).filter(p => {
    const init = p.node.init;
    return init
      && init.type === 'CallExpression'
      && init.callee.name === 'require'
      && init.arguments.length === 1
      && init.arguments[0].type === 'Literal';
  }).forEach(path => {
    const src = path.node.init.arguments[0].value;
    const binding = path.node.id;
    let specifiers = [];

    if (binding.type === 'Identifier') {
      specifiers.push(j.importDefaultSpecifier(j.identifier(binding.name)));
      log(`→ default import '${binding.name}' from '${src}'`);
    } else if (binding.type === 'ObjectPattern') {
      binding.properties.forEach(prop => {
        if (prop.type === 'Property') {
          const key = prop.key.name;
          const alias = prop.value.name;
          specifiers.push(
            key === alias
              ? j.importSpecifier(j.identifier(key))
              : j.importSpecifier(j.identifier(key), j.identifier(alias))
          );
        }
      });
      log(`→ named import { ${binding.properties.map(p => p.key.name).join(', ')} } from '${src}'`);
    } else {
      // fallback to namespace
      const name = path.node.id.name;
      specifiers.push(j.importNamespaceSpecifier(j.identifier(name)));
      log(`→ namespace import '${name}' from '${src}'`);
    }

    // merge into existing or enqueue new
    const existing = importMap.get(src);
    if (existing) {
      specifiers.forEach(spec => {
        if (!existing.node.specifiers.some(s =>
          s.local.name === spec.local.name
          && ((spec.imported && s.imported && s.imported.name === spec.imported.name)
              || (!spec.imported && !s.imported))
        )) {
          existing.node.specifiers.push(spec);
          log(`   • merged specifier into '${src}'`);
        }
      });
    } else {
      const imp = j.importDeclaration(specifiers, j.literal(src));
      newImports.push(imp);
      importMap.set(src, { node: imp, alias: null });
      log(`→ created import for '${src}'`);
    }

    // remove original declaration (or just the one binding)
    const parent = path.parent.node;
    if (parent.declarations.length > 1) {
      parent.declarations = parent.declarations.filter(d => d !== path.node);
    } else {
      j(path.parent).remove();
    }
  });

  // 2.5) MemberExpression: require('mod').prop → import * as alias from 'mod'; alias.prop
  root.find(j.MemberExpression, {
    object: {
      type: 'CallExpression',
      callee: { name: 'require' },
      arguments: [{ type: 'Literal' }]
    }
  }).forEach(path => {
    const lit = path.node.object.arguments[0].value;
    let info = importMap.get(lit);

    // if not yet namespace-imported, create alias
    if (!info || !info.alias) {
      const alias = `_mod_${sanitizeIdentifier(lit)}`;
      const imp = j.importDeclaration(
        [ j.importNamespaceSpecifier(j.identifier(alias)) ],
        j.literal(lit)
      );
      newImports.push(imp);
      importMap.set(lit, { node: imp, alias });
      log(`→ namespace import * as ${alias} from '${lit}'`);
      info = importMap.get(lit);
    }

    // replace require('mod') → alias
    j(path.get('object')).replaceWith(j.identifier(info.alias));
    log(`→ rewrote require('${lit}').${path.node.property.name} → ${info.alias}.${path.node.property.name}`);
  });

  // 3) dynamic require(x) → await import(x)
  root.find(j.CallExpression, {
    callee: { name: 'require' }
  }).filter(p => {
    const arg = p.node.arguments[0];
    return !arg || arg.type !== 'Literal';
  }).forEach(path => {
    const imp = j.callExpression(j.identifier('import'), path.node.arguments);
    j(path).replaceWith(j.awaitExpression(imp));
    log('→ replaced dynamic require(...) with await import(...)');
  });

  // 4) module.exports = X → export default X
  root.find(j.AssignmentExpression, {
    left: {
      object: { name: 'module' },
      property: { name: 'exports' }
    }
  }).forEach(path => {
    j(path.parent).replaceWith(
      j.exportDefaultDeclaration(path.node.right)
    );
    log('→ converted module.exports to export default');
  });

  // 5) exports.foo = Y → export const foo = Y
  root.find(j.AssignmentExpression, {
    left: {
      object: { name: 'exports' },
      property: { type: 'Identifier' }
    }
  }).forEach(path => {
    const name = path.node.left.property.name;
    const named = j.exportNamedDeclaration(
      j.variableDeclaration('const', [
        j.variableDeclarator(j.identifier(name), path.node.right)
      ]),
      []
    );
    j(path.parent).replaceWith(named);
    log(`→ converted exports.${name} to named export`);
  });

  // 6) finally, insert any new imports just after any 'use strict'
  if (newImports.length) {
    const body = root.get().node.program.body;
    let idx = body.findIndex(node =>
      node.type !== 'ImportDeclaration'
      && !(node.type === 'ExpressionStatement'
           && node.expression.type === 'Literal'
           && node.expression.value === 'use strict')
    );
    if (idx < 0) idx = 0;
    body.splice(idx, 0, ...newImports);
    log(`→ inserted ${newImports.length} import(s)`);
  }

  return root.toSource({ quote: 'single', trailingComma: true });
}