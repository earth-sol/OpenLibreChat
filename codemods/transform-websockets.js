#!/usr/bin/env bun

/**
 * scripts/transform-websockets.js
 *
 * A Bun-native CLI that migrates Socket.IO → Elysia WS + Elysia.listen:
 *  • Idempotent via "// bun: websockets-updated" marker
 *  • Removes CJS require()/ESM import of 'socket.io' & 'http'
 *  • Inserts `import { ws } from '@elysia/ws'`
 *  • Detects all `const app = new Elysia(...)` bindings
 *  • Injects `app.use(ws())` after logger/otel or immediately after instantiation
 *  • Converts `io.on(...)` and `io.of(...).on(...)` → `app.ws(path, { open(ws){…} })`
 *  • Renames `socket.emit` → `ws.send` in handler bodies
 *  • Rewrites `app.listen(port[,host])` → `await app.listen(port, { hostname: host })`
 *  • CLI flags: --quiet, --dry-run
 *  • Uses Bun.Glob & Bun.file/Bun.write for I/O
 */

import { Glob } from 'bun'
import jscodeshift from 'jscodeshift'

const args   = Bun.argv.slice(1)
const dryRun = args.includes('--dry-run') || args.includes('-d')
const quiet  = args.includes('--quiet')   || args.includes('-q')
const log    = (...m) => !quiet && console.log(...m)
const debug  = (...m) => console.debug('[transform-websockets]', ...m)

// Helpers

/** Insert import if missing */
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

/** Remove Node-style require */
function removeRequire(root, j, mod) {
  const decls = root.find(j.VariableDeclarator, {
    init: { callee:{ name:'require', arguments:[{ value:mod }] } }
  })
  if (decls.size()) { decls.remove(); debug(`removed require('${mod}')`); return true }
  return false
}

/** Remove ESM import */
function removeImport(root, j, mod) {
  const imps = root.find(j.ImportDeclaration, { source:{ value:mod } })
  if (imps.size()) { imps.remove(); debug(`removed import '${mod}'`); return true }
  return false
}

/** Find import alias for a given export from a module */
function findAlias(root, j, moduleName, exportName) {
  let alias = null
  root.find(j.ImportDeclaration, { source:{ value: moduleName } }).forEach(path => {
    for (const spec of path.node.specifiers) {
      if ((spec.type === 'ImportDefaultSpecifier' && exportName === 'default') ||
          (spec.type === 'ImportSpecifier' && spec.imported.name === exportName)) {
        alias = spec.local.name
      }
    }
  })
  return alias
}

/** Locate all Elysia apps: const X = new Elysia(...) or Elysia(...) */
function findApps(root, j, eAlias) {
  const apps = []
  root.find(j.VariableDeclarator).forEach(path => {
    const { id, init } = path.node
    if (id.type !== 'Identifier' || !init) return
    const calleeName = init.type === 'NewExpression'
      ? init.callee.name
      : init.type === 'CallExpression'
        ? init.callee.name
        : null
    if (calleeName === eAlias) apps.push({ varName: id.name, path })
  })
  return apps
}

/** Build nullish fallback: a ?? Bun.env.X ?? fallback */
function nullish(j, left, envVar, fallback) {
  return j.logicalExpression(
    '??',
    left,
    j.logicalExpression(
      '??',
      j.memberExpression(j.memberExpression(j.identifier('Bun'), j.identifier('env')), j.identifier(envVar)),
      j.literal(fallback)
    )
  )
}

// Transformer

function transformer(source, filePath) {
  if (source.includes('// bun: websockets-updated')) return null

  const j = jscodeshift
  const root = j(source)
  let did = false

  debug('processing', filePath)

  // 1) Idempotency marker
  root.get().node.program.body.unshift(
    j.expressionStatement(j.literal('// bun: websockets-updated'))
  )
  did = true

  // 2) Remove socket.io & http
  did ||= removeRequire(root, j, 'socket.io')
  did ||= removeImport(root, j, 'socket.io')
  did ||= removeRequire(root, j, 'http')
  did ||= removeImport(root, j, 'http')

  // 3) Insert ESM import for WS plugin
  if (addImport(root, j, [ j.importSpecifier(j.identifier('ws')) ], '@elysia/ws')) {
    did = true
  }

  // 4) Find Elysia alias & apps
  const eAlias = findAlias(root, j, 'elysia', 'Elysia')
  if (!eAlias) {
    debug(`no Elysia import in ${filePath}`)
    return did ? root.toSource({ quote: 'single', trailingComma: true }) : null
  }
  const apps = findApps(root, j, eAlias)
  if (!apps.length) {
    debug(`no app binding in ${filePath}`)
    return did ? root.toSource({ quote: 'single', trailingComma: true }) : null
  }

  // 5) Find ordering anchors
  const loggerAlias    = findAlias(root, j, '@elysia/logger', 'logger')
  const telemetryAlias = findAlias(root, j, '@elysia/opentelemetry', 'opentelemetry')

  // 6) Inject app.use(ws()) on each app
  apps.forEach(({ varName, path }) => {
    let anchor = path

    // after logger()
    if (loggerAlias) {
      const logCall = root.find(j.CallExpression, {
        callee: { object:{ name:varName }, property:{ name:'use' }}
      }).filter(p => p.node.arguments[0]?.callee?.name === loggerAlias).at(0)
      if (logCall.size()) anchor = logCall.get()
    }
    // else after telemetry()
    if (telemetryAlias && anchor === path) {
      const telCall = root.find(j.CallExpression, {
        callee: { object:{ name:varName }, property:{ name:'use' }}
      }).filter(p => p.node.arguments[0]?.callee?.name === telemetryAlias).at(0)
      if (telCall.size()) anchor = telCall.get()
    }

    const stmt = j.expressionStatement(
      j.callExpression(
        j.memberExpression(j.identifier(varName), j.identifier('use')),
        [ j.callExpression(j.identifier('ws'), []) ]
      )
    )
    j(anchor).parent.insertAfter(stmt)
    debug(`injected app.use(ws()) for ${varName}`)
    did = true
  })

  // 7) Transform Socket.IO connection handlers
  let ioAlias = null
  const serverAlias = findAlias(root, j, 'socket.io', 'Server')
  if (serverAlias) {
    root.find(j.VariableDeclarator, {
      init: { callee: { name: serverAlias } }
    }).forEach(p => {
      ioAlias = p.node.id.name
      debug(`found io alias: ${ioAlias}`)
    })
  }

  if (ioAlias) {
    apps.forEach(({ varName }) => {
      root.find(j.CallExpression, { callee:{ property:{ name:'on' }}}).forEach(p => {
        const callee = p.node.callee
        let namespace = '/'
        let handler   = p.node.arguments[1]

        // io.of('/chat').on('connection', handler)
        if (
          callee.object.type === 'MemberExpression' &&
          callee.object.object.name === ioAlias &&
          callee.object.property.name === 'of' &&
          p.node.arguments[0].value === 'connection'
        ) {
          namespace = p.node.arguments[0].value
        }
        // io.on('connection', handler)
        else if (!(callee.object.name === ioAlias && p.node.arguments[0].value === 'connection')) {
          return
        }

        // rewrite socket.emit → ws.send
        const oldParam = handler.params[0]?.name || 'socket'
        const wsParam  = 'ws'
        j(handler.body).find(j.CallExpression, {
          callee:{ object:{ name:oldParam }, property:{ name:'emit' }}
        }).forEach(q => {
          q.node.callee = j.memberExpression(j.identifier(wsParam), j.identifier('send'))
        })

        // build app.ws(namespace, { open(ws){…} })
        const openProp = j.property(
          'init',
          j.identifier('open'),
          j.functionExpression(null, [ j.identifier(wsParam) ], handler.body)
        )
        const wsStmt = j.expressionStatement(
          j.callExpression(
            j.memberExpression(j.identifier(varName), j.identifier('ws')),
            [ j.literal(namespace), j.objectExpression([ openProp ]) ]
          )
        )

        // insert after the ws middleware
        const wsUse = root.find(j.CallExpression, {
          callee:{ object:{ name:varName }, property:{ name:'use' }}
        }).filter(r => r.node.arguments[0]?.callee?.name === 'ws').at(-1).get()
        j(wsUse).parent.insertAfter(wsStmt)

        // remove original io.on/namespace.on(...)
        j(p.parent).remove()
        debug(`mapped namespace '${namespace}'`)
        did = true
      })
    })
  }

  // 8) Rewrite app.listen → await app.listen(port, { hostname })
  apps.forEach(({ varName }) => {
    root.find(j.CallExpression, {
      callee:{ object:{ name:varName }, property:{ name:'listen' }}
    }).forEach(p => {
      const [portArg, hostArg] = p.node.arguments
      const portExpr = nullish(j, portArg || j.literal(undefined), 'PORT', 3000)
      const hostExpr = nullish(j, hostArg || j.literal(undefined), 'HOST', '0.0.0.0')

      const awaitExpr = j.awaitExpression(
        j.callExpression(
          j.memberExpression(j.identifier(varName), j.identifier('listen')),
          [ portExpr, j.objectExpression([
              j.property('init', j.identifier('hostname'), hostExpr)
            ]) ]
        )
      )
      j(p.parent).replaceWith(j.expressionStatement(awaitExpr))
      debug(`rewrote ${varName}.listen → await ${varName}.listen(...)`)
      did = true
    })
  })

  return did
    ? root.toSource({ quote:'single', trailingComma:true })
    : null
}

// Runner

async function main() {
  for await (const filePath of new Glob(['**/*.js','**/*.ts'])) {
    if (filePath.includes('node_modules/') || filePath.endsWith('transform-websockets.js')) continue

    let src
    try { src = await Bun.file(filePath).text() }
    catch (e) { log(`read failed: ${filePath}`, e.message); continue }

    let out
    try { out = transformer(src, filePath) }
    catch (e) { console.error('[transform-websockets] error in', filePath, e); continue }

    if (!out) { debug(`no changes: ${filePath}`); continue }
    if (!dryRun) {
      try { await Bun.write(filePath, out) }
      catch (e) { log(`write failed: ${filePath}`, e.message) }
    }
    log(`${dryRun ? 'DRY' : '✔'} ${filePath}`)
  }
}

main().catch(e => {
  console.error('[transform-websockets] fatal:', e)
  Bun.exit(1)
})