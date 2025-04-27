// codemods/transform-telemetry.js
/**
 * Codemod: transform-telemetry
 * Purpose: Inject @elysia/opentelemetry plugin into every Elysia app instance:
 *
 *   import { opentelemetry } from '@elysia/opentelemetry';
 *
 *   const app = new Elysia(...);
 *   app.use(
 *     opentelemetry({
 *       serviceName:
 *         Bun.env.SERVICE_NAME ||
 *         (typeof import.meta !== 'undefined' && import.meta.env?.SERVICE_NAME) ||
 *         'librechat-service'
 *     })
 *   );
 *
 * Features:
 *   • Detects both `new Elysia()` and `Elysia()` calls
 *   • Skips files with no Elysia instantiation
 *   • Idempotent: won’t duplicate import or use calls
 *   • Verbose logs every step
 *   • Uses Bun.env and import.meta.env, not process.env
 *   • Fails gracefully
 *
 * Usage:
 *   jscodeshift -t codemods/transform-telemetry.js <globs> --parser=ts
 */

module.exports = function transformer(fileInfo, api, options) {
  const j = api.jscodeshift;
  const root = j(fileInfo.source);

  console.log(`\n[telemetry] ➡️  Processing: ${fileInfo.path}`);

  // 1) Find any Elysia instantiations:
  const appVars = root.find(j.VariableDeclarator).filter(path => {
    const init = path.node.init;
    if (!init) return false;
    // support both `new Elysia()` and `Elysia()`
    const isNewOrCall =
      init.type === 'NewExpression' || init.type === 'CallExpression';
    if (!isNewOrCall) return false;

    // callee can be Identifier Elysia or MemberExpression .Elysia
    const callee = init.callee;
    const name =
      callee.type === 'Identifier'
        ? callee.name
        : callee.type === 'MemberExpression' && callee.property.type === 'Identifier'
        ? callee.property.name
        : null;
    return name === 'Elysia';
  });

  if (appVars.size() === 0) {
    console.log(`[telemetry] ⚠️  No Elysia() instantiation found -- skipping.`);
    return null;
  }

  // 2) Ensure the opentelemetry import exists
  const IMPORT_SOURCE = '@elysia/opentelemetry';
  const IMPORT_NAME = 'opentelemetry';
  const hasImport = root.find(j.ImportDeclaration, {
    source: { value: IMPORT_SOURCE }
  }).size();

  if (!hasImport) {
    const imp = j.importDeclaration(
      [j.importSpecifier(j.identifier(IMPORT_NAME))],
      j.literal(IMPORT_SOURCE)
    );
    const allImports = root.find(j.ImportDeclaration);
    if (allImports.size()) {
      allImports.at(-1).insertAfter(imp);
    } else {
      root.get().node.program.body.unshift(imp);
    }
    console.log(`[telemetry] ✅  Injected import {opentelemetry} from '${IMPORT_SOURCE}'.`);
  } else {
    console.log(`[telemetry] ℹ️  Import from '${IMPORT_SOURCE}' already present.`);
  }

  // 3) For each app var, insert app.use(opentelemetry(...)) if missing
  appVars.forEach(path => {
    const varName = path.node.id.name;
    // Check existing usage: app.use(opentelemetry(...))
    const hasUsage = root.find(j.CallExpression, {
      callee: {
        type: 'MemberExpression',
        object: { type: 'Identifier', name: varName },
        property: { type: 'Identifier', name: 'use' }
      }
    }).filter(p => {
      const arg0 = p.node.arguments[0];
      return (
        arg0 &&
        arg0.type === 'CallExpression' &&
        arg0.callee.type === 'Identifier' &&
        arg0.callee.name === IMPORT_NAME
      );
    }).size();

    if (hasUsage) {
      console.log(`[telemetry] ⚠️  '${varName}.use(opentelemetry)' already applied -- skipping.`);
      return;
    }

    // Build the fallback expression:
    // Bun.env.SERVICE_NAME
    const bunEnv = j.memberExpression(
      j.memberExpression(j.identifier('Bun'), j.identifier('env')),
      j.identifier('SERVICE_NAME')
    );
    // import.meta.env?.SERVICE_NAME
    const importMetaEnv = j.memberExpression(
      j.memberExpression(
        j.memberExpression(j.identifier('import.meta'), j.identifier('env')),
        j.identifier('SERVICE_NAME')
      ),
      j.identifier('') // workaround; we'll wrap it below
    );
    // Actually use a conditional logical OR chain:
    // Bun.env.SERVICE_NAME || (typeof import.meta !== 'undefined' && import.meta.env?.SERVICE_NAME) || 'librechat-service'
    const importMetaCheck = j.logicalExpression(
      '&&',
      j.binaryExpression(
        '!==',
        j.unaryExpression('typeof', j.identifier('import.meta')),
        j.literal('undefined')
      ),
      j.memberExpression(
        j.memberExpression(j.identifier('import.meta'), j.identifier('env')),
        j.identifier('SERVICE_NAME'),
        /* computed */ false
      )
    );
    const fallback = j.literal('librechat-service');
    const serviceNameExpr = j.logicalExpression(
      '||',
      bunEnv,
      j.logicalExpression('||', importMetaCheck, fallback)
    );

    // opentelemetry({ serviceName: <expr> })
    const optionsObj = j.objectExpression([
      j.property('init', j.identifier('serviceName'), serviceNameExpr)
    ]);
    const pluginCall = j.callExpression(j.identifier(IMPORT_NAME), [optionsObj]);
    const useCall = j.callExpression(
      j.memberExpression(j.identifier(varName), j.identifier('use')),
      [pluginCall]
    );

    // Insert right after the declaration
    j(path.parent).insertAfter(j.expressionStatement(useCall));
    console.log(`[telemetry] ✅  Injected ${varName}.use(opentelemetry({serviceName}))`);
  });

  // 4) Return modified source
  return root.toSource({
    quote: 'single',
    trailingComma: true,
    reuseWhitespace: false
  });
};

// Use the TypeScript parser (supports JS/TS/TSX)
module.exports.parser = 'ts';