/**
 * codemods/transform-security-middleware.js
 *
 * 1) CJS → ESM for helmet, rateLimit, mongo-sanitize
 * 2) Rename rate-limit keys: windowMs→window, max→limit
 * 3) app.use(sanitize()) → app.hook('preHandler', sanitize())
 * 4) Bun-friendly (ESM), verbose debug logging
 */

export default function transformer(fileInfo, { jscodeshift: j }) {
  const root = j(fileInfo.source);
  let didTransform = false;

  // Helpers to track found identifiers
  let helmetId = null;
  let rateLimitId = null;
  let sanitizeId = null;

  // 1) FIND & REMOVE CJS requires, COLLECT local names
  root
    .find(j.VariableDeclaration)
    .filter(path => {
      const decl = path.node.declarations[0];
      return (
        decl.init?.type === 'CallExpression' &&
        decl.init.callee.name === 'require' &&
        ['helmet', 'express-rate-limit', 'express-mongo-sanitize'].includes(
          decl.init.arguments[0].value
        )
      );
    })
    .forEach(path => {
      const decl = path.node.declarations[0];
      const pkg = decl.init.arguments[0].value;
      const localName = decl.id.type === 'ObjectPattern'
        ? decl.id.properties[0].value.name
        : decl.id.name;

      console.debug(
        `[transform-security-middleware][DEBUG] removing require('${pkg}') from ${fileInfo.path}`
      );

      if (pkg === 'helmet') helmetId = localName;
      if (pkg === 'express-rate-limit') rateLimitId = localName;
      if (pkg === 'express-mongo-sanitize') sanitizeId = localName;

      j(path).remove(); // remove the entire `const ... = require(...)`
      didTransform = true;
    });

  // 2) INSERT ESM imports at top in correct order
  const firstImport = root.find(j.ImportDeclaration).at(0);
  const insertBefore = firstImport.size() ? firstImport.get() : null;

  const importDecls = [];
  if (helmetId) {
    importDecls.push(
      j.importDeclaration(
        [j.importSpecifier(j.identifier('helmet'), j.identifier(helmetId))],
        j.literal('@elysia/helmet')
      )
    );
  }
  if (rateLimitId) {
    importDecls.push(
      j.importDeclaration(
        [j.importSpecifier(j.identifier('rateLimit'), j.identifier(rateLimitId))],
        j.literal('@elysia/rate-limit')
      )
    );
  }
  if (sanitizeId) {
    importDecls.push(
      j.importDeclaration(
        [j.importDefaultSpecifier(j.identifier(sanitizeId))],
        j.literal('express-mongo-sanitize')
      )
    );
  }

  if (importDecls.length) {
    console.debug(
      `[transform-security-middleware][DEBUG] injecting ESM imports into ${fileInfo.path}`
    );
    importDecls.reverse().forEach(imp => {
      if (insertBefore) j(insertBefore).insertBefore(imp);
      else root.get().node.program.body.unshift(imp);
    });
    didTransform = true;
  }

  // 3) RENAME rateLimit OPTION KEYS
  if (rateLimitId) {
    // a) Direct call: rateLimit({ windowMs, max, ... })
    root
      .find(j.CallExpression, { callee: { name: rateLimitId } })
      .filter(p => p.node.arguments[0]?.type === 'ObjectExpression')
      .forEach(p => {
        const obj = p.node.arguments[0];
        obj.properties.forEach(prop => {
          if (prop.key.name === 'windowMs') {
            console.debug(
              `[transform-security-middleware][DEBUG] renaming windowMs→window in ${fileInfo.path}`
            );
            prop.key.name = 'window';
          }
          if (prop.key.name === 'max') {
            console.debug(
              `[transform-security-middleware][DEBUG] renaming max→limit in ${fileInfo.path}`
            );
            prop.key.name = 'limit';
          }
        });
        didTransform = true;
      });

    // b) limiterOptions = { windowMs, max, … }
    root
      .find(j.VariableDeclarator, { id: { name: 'limiterOptions' } })
      .filter(p => p.node.init?.type === 'ObjectExpression')
      .forEach(p => {
        p.node.init.properties.forEach(prop => {
          if (
            prop.key.name === 'windowMs' &&
            prop.shorthand
          ) {
            console.debug(
              `[transform-security-middleware][DEBUG] renaming limiterOptions.windowMs→window in ${fileInfo.path}`
            );
            prop.key.name = 'window';
            prop.shorthand = false;
          }
          if (
            prop.key.name === 'max' &&
            prop.shorthand
          ) {
            console.debug(
              `[transform-security-middleware][DEBUG] renaming limiterOptions.max→limit in ${fileInfo.path}`
            );
            prop.key.name = 'limit';
            prop.shorthand = false;
          }
        });
        didTransform = true;
      });
  }

  // 4) CONVERT app.use(sanitize()) → app.hook('preHandler', sanitize())
  if (sanitizeId) {
    root
      .find(j.ExpressionStatement, {
        expression: {
          type: 'CallExpression',
          callee: { object: { name: 'app' }, property: { name: 'use' } },
        },
      })
      .filter(path => {
        const arg = path.node.expression.arguments[0];
        return (
          arg?.type === 'CallExpression' &&
          arg.callee.name === sanitizeId
        );
      })
      .forEach(path => {
        console.debug(
          `[transform-security-middleware][DEBUG] converting app.use(${sanitizeId}()) → app.hook('preHandler', ${sanitizeId}()) in ${fileInfo.path}`
        );
        const newExpr = j.callExpression(
          j.memberExpression(j.identifier('app'), j.identifier('hook')),
          [j.literal('preHandler'), j.callExpression(j.identifier(sanitizeId), [])]
        );
        j(path).replaceWith(j.expressionStatement(newExpr));
        didTransform = true;
      });
  }

  return didTransform ? root.toSource({ quote: 'single' }) : null;
}