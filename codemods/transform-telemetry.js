#!/usr/bin/env bun

/**
 * scripts/transform-telemetry.js
 *
 * A Bun-native CLI that injects @elysia/opentelemetry into every Elysia app:
 *  • Idempotent via "// bun: telemetry-injected" marker
 *  • Removes existing CJS require()/ESM import of '@elysia/opentelemetry'
 *  • Adds `import { opentelemetry } from '@elysia/opentelemetry'`
 *  • Builds serviceName with nullish-coalescing:
 *      Bun.env.SERVICE_NAME ??
 *      import.meta.env?.SERVICE_NAME ??
 *      'librechat-service'
 *  • Injects `app.use(opentelemetry({ serviceName }))`:
 *      – Right after any existing logger plugin call, or
 *      – Immediately after `new Elysia(...)`
 *  • CLI flags: --quiet, --dry-run
 *  • Uses Bun core APIs for globbing & file I/O
 */

import { Glob } from 'bun'
import jscodeshift from 'jscodeshift'

const args   = Bun.argv.slice(1)
const dryRun = args.includes('--dry-run') || args.includes('-d')
const quiet  = args.includes('--quiet')   || args.includes('-q')
const log    = (...m) => !quiet && console.log(...m)
const debug  = (...m) => console.debug('[transform-telemetry]', ...m)

/**
 * Idempotently add an import declaration.
 * Returns true if inserted.
 */
function addImport(root, j, specifiers, source) {
  if (!root.find(j.ImportDeclaration, { source: { value: source } }).size()) {
    const imp = j.importDeclaration(specifiers, j.literal(source))
    root.get().node.program.body.unshift(imp)
    debug(`import '${source}'`)
    return true
  }
  return false
}

/**
 * Remove any CJS require() of moduleName.
 */
function removeCJSRequire(root, j, moduleName) {
  return root
    .find(j.VariableDeclarator, {
      init: { callee: { name: 'require', arguments: [{ value: moduleName }] } }
    })
    .remove().size() > 0
}

/**
 * Remove any ESM import of moduleName.
 */
function removeESMImport(root, j, moduleName) {
  return root
    .find(j.ImportDeclaration, { source: { value: moduleName } })
    .remove().size() > 0
}

/**
 * Find the local alias for a named export from a module.
 * E.g. `import { Elysia as E } from 'elysia'` → returns 'E'.
 * Or `import Elysia from 'elysia'` → returns 'Elysia'.
 */
function findAlias(root, j, moduleName, exportName) {
  let alias = null
  root.find(j.ImportDeclaration, { source: { value: moduleName } })
    .forEach(path => {
      path.node.specifiers.forEach(spec => {
        if (spec.type === 'ImportDefaultSpecifier' && exportName === 'default') {
          alias = spec.local.name
        }
        else if (spec.type === 'ImportSpecifier' && spec.imported.name === exportName) {
          alias = spec.local.name
        }
        else if (spec.type === 'ImportNamespaceSpecifier' && exportName === '*') {
          alias = spec.local.name
        }
      })
    })
  return alias
}

/**
 * Locate all Elysia app bindings:
 *   const app = new Elysia(...)   or
 *   const app = Elysia(...)
 * Returns array of { varName, path } pairs.
 */
function findAppBindings(root, j, eAlias) {
  const apps = []
  root.find(j.VariableDeclarator).forEach(path => {
    const { id, init } = path.node
    if (id.type !== 'Identifier' || !init) return
    const name = init.callee?.name
    const isNew = init.type === 'NewExpression' && name === eAlias
    const isCall = init.type === 'CallExpression' && name === eAlias
    if (isNew || isCall) {
      apps.push({ varName: id.name, path })
    }
  })
  return apps
}

/**
 * Build AST for:
 *   Bun.env.SERVICE_NAME ?? import.meta.env.SERVICE_NAME ?? 'librechat-service'
 */
function buildServiceNameExpr(j) {
  const bunEnv = j.memberExpression(
    j.memberExpression(j.identifier('Bun'), j.identifier('env')),
    j.identifier('SERVICE_NAME')
  )
  const metaEnv = j.memberExpression(
    j.memberExpression(
      j.metaProperty(j.identifier('import'), j.identifier('meta')),
      j.identifier('env')
    ),
    j.identifier('SERVICE_NAME')
  )
  const fallback = j.literal('librechat-service')
  return j.logicalExpression(
    '??',
    bunEnv,
    j.logicalExpression('??', metaEnv, fallback)
  )
}

function transformer(source, filePath) {
  // Skip if already injected
  if (source.includes('// bun: telemetry-injected')) return null

  const j = jscodeshift
  const root = j(source)
  let did = false

  debug('processing', filePath)

  // 1) Marker
  root.get().node.program.body.unshift(
    j.expressionStatement(j.literal('// bun: telemetry-injected'))
  )
  did = true

  // 2) Remove existing plugin require/import
  if (removeCJSRequire(root, j, '@elysia/opentelemetry')) did = true
  if (removeESMImport(root, j, '@elysia/opentelemetry'))   did = true

  // 3) Add ESM import
  if (addImport(root, j, [ j.importSpecifier(j.identifier('opentelemetry')) ], '@elysia/opentelemetry')) {
    did = true
  }

  // 4) Find Elysia alias
  const eAlias = findAlias(root, j, 'elysia', 'Elysia')
  if (!eAlias) {
    debug(`no Elysia import found in ${filePath}`)
    return did ? root.toSource({ quote: 'single', trailingComma: true }) : null
  }

  // 5) Find any logger alias (to preserve ordering)
  const loggerAlias = findAlias(root, j, '@elysia/logger', 'logger')

  // 6) Locate app instances
  const apps = findAppBindings(root, j, eAlias)
  if (!apps.length) {
    debug(`no app binding found in ${filePath}`)
    return did ? root.toSource({ quote: 'single', trailingComma: true }) : null
  }

  // 7) Build plugin AST
  const serviceNameExpr = buildServiceNameExpr(j)
  const pluginCall = j.callExpression(
    j.identifier('opentelemetry'),
    [ j.objectExpression([ j.property('init', j.identifier('serviceName'), serviceNameExpr) ]) ]
  )

  // 8) Inject for each app
  apps.forEach(({ varName, path }) => {
    // find logger injection: app.use(logger(...))
    let injectionPoint = null
    if (loggerAlias) {
      const loggerCall = root.find(j.CallExpression, {
        callee: {
          type: 'MemberExpression',
          object: { name: varName },
          property: { name: 'use' }
        }
      }).filter(p => {
        const arg0 = p.node.arguments[0]
        return arg0?.type === 'CallExpression' && arg0.callee.name === loggerAlias
      }).at(0)

      if (loggerCall.size()) {
        injectionPoint = loggerCall.get()
      }
    }

    // default: after app instantiation
    if (!injectionPoint) {
      injectionPoint = path
    }

    const useStmt = j.expressionStatement(
      j.callExpression(
        j.memberExpression(j.identifier(varName), j.identifier('use')),
        [ pluginCall ]
      )
    )
    j(injectionPoint).parent.insertAfter(useStmt)
    debug(`injected telemetry into ${varName}`)
    did = true
  })

  return did ? root.toSource({ quote: 'single', trailingComma: true }) : null
}

async function main() {
  for await (const filePath of new Glob(['**/*.js', '**/*.ts'])) {
    // skip node_modules and this script
    if (filePath.includes('node_modules/') || filePath.endsWith('transform-telemetry.js')) continue

    let src
    try { src = await Bun.file(filePath).text() }
    catch (e) { log(`read failed: ${filePath}`, e.message); continue }

    const out = transformer(src, filePath)
    if (!out) {
      debug(`no changes: ${filePath}`)
      continue
    }

    if (!dryRun) {
      try { await Bun.write(filePath, out) }
      catch (e) { log(`write failed: ${filePath}`, e.message) }
    }
    log(`${dryRun ? 'DRY' : '✔'} ${filePath}`)
  }
}

main().catch(e => {
  console.error('[transform-telemetry] fatal:', e)
  Bun.exit(1)
})