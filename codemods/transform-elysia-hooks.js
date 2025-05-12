#!/usr/bin/env bun

/**
 * scripts/transform-elysia-hooks.js
 *
 * A Bun-native CLI codemod that consolidates scattered Elysia lifecycle hooks
 * (onRequest, onParse, onTransform, onBeforeHandle, onAfterHandle,
 * onAfterResponse, mapResponse, onError) into a single chained call on `new Elysia()`,
 * removes leftover imports, and is fully idempotent.
 *
 *  • Idempotent via "// bun: elysia-hooks-updated" marker
 *  • Removes Express & Node core imports (express, path, url)
 *  • Detects the Elysia alias from imports
 *  • Finds `const app = new Elysia(...)` or `const app = Elysia(...)`
 *  • Collects `app.onX(...)` calls and rebuilds `app = new Elysia(...).onX(...).onY(...)`
 *  • Removes the now-inlined hook statements
 *  • Uses jscodeshift with TS parser for full TS/JSX support
 *  • Supports --dry-run / --quiet flags
 */

import { Glob } from 'bun'
import jscodeshiftPkg from 'jscodeshift'

const args   = Bun.argv.slice(1)
const dryRun = args.includes('--dry-run') || args.includes('-d')
const quiet  = args.includes('--quiet')   || args.includes('-q')
const log    = (...m) => !quiet && console.log(...m)
const debug  = (...m) => console.debug('[transform-elysia-hooks]', ...m)

/** Remove CJS require of a module */
function removeRequire(root, j, mod) {
  const decls = root.find(j.VariableDeclarator, {
    init: { callee: { name: 'require', arguments: [{ value: mod }] } }
  })
  if (decls.size()) {
    decls.remove()
    debug(`removed require('${mod}')`)
    return true
  }
  return false
}

/** Remove ESM import of a module */
function removeImport(root, j, mod) {
  const imps = root.find(j.ImportDeclaration, { source: { value: mod } })
  if (imps.size()) {
    imps.remove()
    debug(`removed import '${mod}'`)
    return true
  }
  return false
}

/** Find alias of a named import from a module */
function findImportAlias(root, j, moduleName, exportName) {
  let alias = null
  root.find(j.ImportDeclaration, { source: { value: moduleName } })
    .forEach(path => {
      path.node.specifiers.forEach(spec => {
        if (
          (spec.type === 'ImportSpecifier'  && spec.imported.name === exportName) ||
          (spec.type === 'ImportDefaultSpecifier' && exportName === 'default')
        ) {
          alias = spec.local.name
        }
      })
    })
  return alias
}

/** Transform code */
function transform(source, filePath) {
  // 0) skip if already applied
  if (source.includes('// bun: elysia-hooks-updated')) return null

  const jscodeshift = jscodeshiftPkg.withParser('ts')
  const j = jscodeshift
  const root = j(source)
  let did = false

  debug('processing', filePath)

  // 1) insert idempotency marker
  root.get().node.program.body.unshift(
    j.expressionStatement(j.literal('// bun: elysia-hooks-updated'))
  )
  did = true

  // 2) remove express & Node core imports/requires
  ['express','path','url'].forEach(mod => {
    did ||= removeImport(root, j, mod)
    did ||= removeRequire(root, j, mod)
  })

  // 3) detect Elysia import alias
  const eAlias = findImportAlias(root, j, 'elysia', 'Elysia') || 'Elysia'

  // 4) locate `const app = new Elysia(...)` or `const app = Elysia(...)`
  let appVar = null
  let appDeclPath = null
  root.find(j.VariableDeclarator).forEach(path => {
    const { id, init } = path.node
    if (!init || id.type !== 'Identifier') return

    const isNew =
      init.type === 'NewExpression' &&
      init.callee.name === eAlias
    const isCall =
      init.type === 'CallExpression' &&
      init.callee.name === eAlias

    if (isNew || isCall) {
      appVar = id.name
      appDeclPath = path
    }
  })

  if (!appVar) {
    debug('no Elysia app instantiation found; skipping')
    return did ? root.toSource({ quote:'single', trailingComma:true }) : null
  }

  // 5) collect all scattered hook calls
  const hookMethods = [
    'onRequest','onParse','onTransform',
    'onBeforeHandle','onAfterHandle','onAfterResponse',
    'mapResponse','onError'
  ]
  const hookCalls = []

  root.find(j.ExpressionStatement, {
    expression: {
      type: 'CallExpression',
      callee: {
        type: 'MemberExpression',
        object: { name: appVar },
        property: p => hookMethods.includes(p.name)
      }
    }
  }).forEach(path => {
    const { callee, arguments: args } = path.node.expression
    hookCalls.push({
      name: callee.property.name,
      args,
      path
    })
  })

  if (hookCalls.length) {
    did = true

    // 6) build chained call on the original init
    let chained = appDeclPath.node.init
    hookCalls.forEach(h => {
      chained = j.callExpression(
        j.memberExpression(chained, j.identifier(h.name)),
        h.args
      )
    })

    // 7) replace the initializer with the chained version
    appDeclPath.get('init').replace(chained)

    // 8) remove the now-inlined hook statements
    hookCalls.forEach(h => j(h.path).remove())
  }

  return did
    ? root.toSource({ quote:'single', trailingComma:true })
    : null
}

// Runner
async function main() {
  // target only the main server entrypoint
  for await (const filePath of new Glob(['api/server/index.{js,ts}'])) {
    if (filePath.includes('node_modules/') || filePath.endsWith('transform-elysia-hooks.js'))
      continue

    let src
    try { src = await Bun.file(filePath).text() }
    catch (e) { log(`read failed: ${filePath}`, e.message); continue }

    let out
    try { out = transform(src, filePath) }
    catch (e) {
      console.error('[transform-elysia-hooks] error in', filePath, e)
      continue
    }

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
  console.error('[transform-elysia-hooks] fatal:', e)
  Bun.exit(1)
})