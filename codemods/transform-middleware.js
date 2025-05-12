#!/usr/bin/env bun

/**
 * scripts/transform-middleware.js
 *
 * A Bun-native CLI codemod that reshapes Express-style middleware and error handlers
 * into Elysia lifecycle hooks:
 *
 *  • Idempotent via "// bun: middleware-updated" marker
 *  • Removes all `express` imports/requires and built-in JSON/urlencoded middleware
 *  • Detects real `app` bindings from `new Elysia()` (ESM & CJS)
 *  • Converts `app.use(fn)` where fn has (req, res, next) → `app.onRequest(fn')`
 *  • Renames `(req,res,next)` → `(request, ctx)`, drops `next()`
 *  • Translates `res.status(code).json(body)`, `res.json(body)`, `res.send(body)` into `return ctx.json(...)`
 *  • Detects any error-handler functions with 4 params and merges them into a single
 *    `app.onError((error, ctx) => { … })`, rewriting Express response calls inside
 *  • Cleans out leftover imports of replaced modules
 *  • CLI flags: --quiet / --dry-run
 *  • Uses Bun.Glob & Bun.file/Bun.write for I/O
 */

import { Glob } from 'bun'
import jscodeshiftPkg from 'jscodeshift'

const args   = Bun.argv.slice(1)
const dryRun = args.includes('--dry-run') || args.includes('-d')
const quiet  = args.includes('--quiet')   || args.includes('-q')
const log    = (...m) => !quiet && console.log(...m)
const debug  = (...m) => console.debug('[transform-middleware]', ...m)

/** Idempotently add an import */
function addImport(root, j, specifiers, source) {
  if (!root.find(j.ImportDeclaration, { source:{ value: source } }).size()) {
    root.get().node.program.body.unshift(
      j.importDeclaration(specifiers, j.literal(source))
    )
    debug(`import '${source}'`)
    return true
  }
  return false
}

/** Remove CJS require of a module */
function removeRequire(root, j, mod) {
  const decls = root.find(j.VariableDeclarator, {
    init: { callee:{ name:'require', arguments:[{ value:mod }] } }
  })
  if (decls.size()) { decls.remove(); debug(`removed require('${mod}')`); return true }
  return false
}

/** Remove ESM import of a module */
function removeImport(root, j, mod) {
  const imps = root.find(j.ImportDeclaration, { source:{ value: mod } })
  if (imps.size()) { imps.remove(); debug(`removed import '${mod}'`); return true }
  return false
}

/** Find alias of a named export from a module */
function findAlias(root, j, moduleName, exportName) {
  let alias = null
  root.find(j.ImportDeclaration, { source:{ value: moduleName } }).forEach(path => {
    path.node.specifiers.forEach(spec => {
      if ((spec.type === 'ImportDefaultSpecifier' && exportName === 'default') ||
          (spec.type === 'ImportSpecifier' && spec.imported.name === exportName)) {
        alias = spec.local.name
      }
    })
  })
  return alias
}

/** Locate all Elysia app bindings: const X = new Elysia(...) or Elysia() */
function findApps(root, j, eAlias) {
  const apps = []
  root.find(j.VariableDeclarator).forEach(path => {
    const { id, init } = path.node
    if (id.type!=='Identifier' || !init) return
    const callee = init.type==='NewExpression'
      ? init.callee.name
      : init.type==='CallExpression'
        ? init.callee.name
        : null
    if (callee === eAlias) apps.push({ name: id.name, path })
  })
  return apps
}

/** Transform Express-style handler → Elysia handler */
function transformHandler(fn, j) {
  // rename params
  fn.params = [ j.identifier('request'), j.identifier('ctx') ]

  // visitor: req → request, res → ctx, drop next()
  j(fn.body)
    .find(j.Identifier, { name: 'req' })
    .replaceWith(() => j.identifier('request'))
  j(fn.body)
    .find(j.Identifier, { name: 'res' })
    .replaceWith(() => j.identifier('ctx'))
  j(fn.body)
    .find(j.CallExpression, { callee:{ name:'next' } })
    .forEach(p => { j(p.parent).remove() })

  // res.status(x).json(y)
  j(fn.body)
    .find(j.CallExpression, {
      callee: {
        object: { type: 'CallExpression', callee:{ property:{ name:'status' } } },
        property: { name: 'json' }
      }
    })
    .forEach(p => {
      const [bodyArg] = p.node.arguments
      const statusCall = p.node.callee.object
      const statusArg = statusCall.arguments[0]
      const ret = j.returnStatement(
        j.callExpression(
          j.memberExpression(j.identifier('ctx'), j.identifier('json')),
          [ bodyArg, j.objectExpression([
              j.property('init', j.identifier('status'), statusArg)
            ]) ]
        )
      )
      j(p.parent).replaceWith(ret)
    })

  // res.json(y) or res.send(y)
  j(fn.body)
    .find(j.CallExpression, {
      callee: {
        object:{ name:'ctx' },
        property: p => p.name==='json' || p.name==='send'
      }
    })
    .forEach(p => {
      const [arg] = p.node.arguments
      const ret = j.returnStatement(
        j.callExpression(
          j.memberExpression(j.identifier('ctx'), j.identifier('json')),
          [ arg ]
        )
      )
      j(p.parent).replaceWith(ret)
    })
}

/** Main AST transform */
function transform(source, filePath) {
  // 0) idempotency
  if (source.includes('// bun: middleware-updated')) return null

  // 1) set up jscodeshift with TS support
  const jscodeshift = jscodeshiftPkg.withParser('ts')
  const j = jscodeshift
  const root = j(source)
  let did = false

  debug('processing', filePath)

  // 2) insert marker
  root.get().node.program.body.unshift(
    j.expressionStatement(j.literal('// bun: middleware-updated'))
  )
  did = true

  // 3) remove express imports/requires & builtins
  did ||= removeRequire(root, j, 'express')
  did ||= removeImport(root, j, 'express')
  // remove global JSON/urlencoded
  root.find(j.CallExpression, {
    callee: {
      object:{ name: 'express' },
      property: { name: /^(json|urlencoded)$/ }
    }
  }).forEach(p => { j(p.parent).remove(); did = true })

  // 4) import Elysia if missing
  if (!root.find(j.ImportDeclaration, { source:{ value:'elysia' }}).size()) {
    root.get().node.program.body.unshift(
      j.importDeclaration(
        [ j.importSpecifier(j.identifier('Elysia')) ],
        j.literal('elysia')
      )
    )
    debug('import { Elysia } from \'elysia\'')
    did = true
  }

  // 5) detect app bindings
  const eAlias = findAlias(root, j, 'elysia', 'Elysia') || 'Elysia'
  const apps = findApps(root, j, eAlias)
  if (!apps.length) {
    debug(`no Elysia app in ${filePath}`)
    return did ? root.toSource({ quote:'single', trailingComma:true }) : null
  }
  const appName = apps[0].name

  // 6) collect and remove error-handler functions
  const errorBodies = []
  // FunctionDeclaration arity 4
  root.find(j.FunctionDeclaration, { params: p=> p.length===4 })
    .forEach(path => {
      errorBodies.push(path.node.body.body)
      j(path).remove(); did = true
    })
  // variable declarator = fn expression or arrow fn
  root.find(j.VariableDeclarator).filter(p=>{
    const init = p.node.init
    return (init?.params?.length===4)
  }).forEach(path => {
    const fn = path.node.init
    errorBodies.push(fn.body.body)
    j(path.parent).remove(); did = true
  })
  // module.exports = fn
  root.find(j.AssignmentExpression, {
    left: { object:{ name:'module' }, property:{ name:'exports' } }
  }).filter(p => p.node.right.params?.length===4)
    .forEach(path => {
      errorBodies.push(path.node.right.body.body)
      j(path.parent).remove(); did = true
    })

  if (errorBodies.length) {
    // merge into single onError
    const merged = [].concat(...errorBodies)
    // transform merged body
    const errorFn = j.arrowFunctionExpression(
      [ j.identifier('error'), j.identifier('ctx') ],
      j.blockStatement(merged)
    )
    // apply our handler transforms
    transformHandler(errorFn, j)
    // insert after app instantiation
    const decl = apps[0].path
    j(decl).parent.insertAfter(
      j.expressionStatement(
        j.callExpression(
          j.memberExpression(j.identifier(appName), j.identifier('onError')),
          [ errorFn ]
        )
      )
    )
    debug(`inserted app.onError(...)`)
    did = true
  }

  // 7) transform app.use(fn) → app.onRequest(fn')
  root.find(j.CallExpression, {
    callee:{ object:{ name:appName }, property:{ name:'use' }}
  }).filter(path => {
    return path.node.arguments.some(arg =>
      ['FunctionExpression','ArrowFunctionExpression'].includes(arg.type)
    )
  }).forEach(path => {
    const fn = path.node.arguments.find(arg =>
      ['FunctionExpression','ArrowFunctionExpression'].includes(arg.type)
    )
    transformHandler(fn, j)
    // replace .use → .onRequest
    path.node.callee.property.name = 'onRequest'
    did = true
  })

  // 8) clean up leftover requires/imports of express middleware modules
  ['cookie-parser','compression','cors','helmet'].forEach(mod=>{
    did ||= removeRequire(root,j,mod)
    did ||= removeImport(root,j,mod)
  })

  return did
    ? root.toSource({ quote:'single', trailingComma:true })
    : null
}

// Runner
async function main() {
  for await (const filePath of new Glob(['**/*.{js,ts}'])) {
    if (
      filePath.includes('node_modules/') ||
      filePath.endsWith('transform-middleware.js')
    ) continue

    let src
    try { src = await Bun.file(filePath).text() }
    catch (e) { log(`read failed: ${filePath}`, e.message); continue }

    let out
    try { out = transform(src, filePath) }
    catch (e) {
      console.error('[transform-middleware] error in', filePath, e)
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
  console.error('[transform-middleware] fatal:', e)
  Bun.exit(1)
})