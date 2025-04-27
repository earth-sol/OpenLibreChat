/**
 * codemods/transform-env-access.js
 *
 * – Strips all dotenv boilerplate
 * – Replaces process.env.VAR → Bun.env.VAR (server) or import.meta.env.VAR (client)
 * – Converts `||` fallbacks → `??` chains
 * – Verbose, colored Bun-based logging by default
 * – Idempotent; on parse/print errors, leaves source untouched
 */

const hasBun = typeof Bun !== 'undefined';
const env = hasBun ? Bun.env : process.env;

// enable debug logging unless DEBUG_LOGGING is explicitly "false"
const debug =
  env.DEBUG_LOGGING === undefined || env.DEBUG_LOGGING !== 'false';

// colored/info helpers when running under Bun
function info(msg) {
  if (!debug) return;
  if (hasBun && typeof Bun.color === 'function') {
    console.log(Bun.color('[env-codemod]', 'cyan'), msg);
  } else {
    console.log('[env-codemod]', msg);
  }
}

function error(msg, err) {
  if (hasBun && typeof Bun.color === 'function') {
    console.error(
      Bun.color('[env-codemod]', 'red'),
      msg,
      hasBun && Bun.inspect ? Bun.inspect(err) : err
    );
  } else {
    console.error('[env-codemod]', msg, err);
  }
}

module.exports = function transformer(file, api) {
  const j = api.jscodeshift;
  const filePath = file.path;

  info(`▶ processing ${filePath}`);

  let root;
  try {
    root = j(file.source);
  } catch (err) {
    error(`✗ parse failed for ${filePath}`, err);
    return file.source;
  }

  // use import.meta.env in client code (under client/ or vite.config)
  const useImportMeta = /[\\/]client[\\/]|vite\.config\./.test(filePath);

  // 1) strip dotenv usage
  // a) require('dotenv').config()
  root
    .find(j.ExpressionStatement, {
      expression: {
        type: 'CallExpression',
        callee: {
          type: 'MemberExpression',
          object: {
            type: 'CallExpression',
            callee: { name: 'require' },
            arguments: [{ value: 'dotenv' }],
          },
          property: { name: 'config' },
        },
      },
    })
    .forEach(p => {
      info(`– removed require('dotenv').config() @ line ${p.node.loc?.start.line}`);
      j(p).remove();
    });

  // b) import 'dotenv' or 'dotenv/config'
  root
    .find(j.ImportDeclaration, {
      source: s => ['dotenv', 'dotenv/config'].includes(s.value),
    })
    .forEach(p => {
      info(`– removed import '${p.node.source.value}' @ line ${p.node.loc?.start.line}`);
      j(p).remove();
    });

  // c) dotenv.config()
  root
    .find(j.ExpressionStatement, {
      expression: {
        type: 'CallExpression',
        callee: {
          type: 'MemberExpression',
          object: { name: 'dotenv' },
          property: { name: 'config' },
        },
      },
    })
    .forEach(p => {
      info(`– removed dotenv.config() @ line ${p.node.loc?.start.line}`);
      j(p).remove();
    });

  // helper to create Bun.env.KEY or import.meta.env.KEY AST
  function buildEnv(key) {
    return useImportMeta
      ? j.template.expression(`import.meta.env.${key}`)
      : j.template.expression(`Bun.env.${key}`);
  }

  // 2) transform fallbacks (||) → nullish (??)
  root
    .find(j.BinaryExpression, { operator: '||' })
    .forEach(p => {
      const { node } = p;
      const left = node.left;
      if (
        left.type === 'MemberExpression' &&
        left.object?.type === 'MemberExpression' &&
        left.object.object?.name === 'process' &&
        left.object.property?.name === 'env'
      ) {
        let key;
        if (left.computed && left.property.type === 'Literal') {
          key = left.property.value;
        } else if (!left.computed && left.property.type === 'Identifier') {
          key = left.property.name;
        } else {
          return;
        }

        const bunAccess = buildEnv(key);
        const def = node.right;
        let replacement;

        if (useImportMeta) {
          // Bun.env.KEY ?? import.meta.env.KEY ?? default
          replacement = j.logicalExpression(
            '??',
            bunAccess,
            j.logicalExpression('??', buildEnv(key), def)
          );
        } else {
          // Bun.env.KEY ?? default
          replacement = j.logicalExpression('??', bunAccess, def);
        }

        info(`– fallback → nullish for '${key}' @ line ${node.loc?.start.line}`);
        j(p).replaceWith(replacement);
      }
    });

  // 3) replace direct process.env.KEY
  root
    .find(j.MemberExpression)
    .forEach(p => {
      const n = p.node;
      if (
        n.object?.type === 'MemberExpression' &&
        n.object.object?.name === 'process' &&
        n.object.property?.name === 'env'
      ) {
        let key;
        if (n.computed && n.property.type === 'Literal') {
          key = n.property.value;
        } else if (!n.computed && n.property.type === 'Identifier') {
          key = n.property.name;
        } else {
          return;
        }

        info(`– replaced process.env.${key} @ line ${n.loc?.start.line}`);
        j(p).replaceWith(buildEnv(key));
      }
    });

  try {
    const output = root.toSource({ quote: 'single' });
    info(`✔ done ${filePath}`);
    return output;
  } catch (err) {
    error(`✗ print failed for ${filePath}`, err);
    return file.source;
  }
};

// support TypeScript
module.exports.parser = 'ts';