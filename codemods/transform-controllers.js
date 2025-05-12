#!/usr/bin/env bun

/**
 * scripts/transform-controllers.js
 *
 * A Bun-native CLI codemod that converts CommonJS/Express-style controllers
 * into ESM exports with Elysia-compatible handler signatures:
 *
 *  • Idempotent via "// bun: controllers-updated" marker
 *  • Removes Express & Node core imports (express, fs, path, url)
 *  • Converts module.exports and exports.foo → export const foo
 *  • Preserves module.exports = Foo → export default Foo
 *  • Renames handler signature (req, res) → async (request, ctx)
 *  • Injects `const body = await request.json()` if `reqAlias.body` is used
 *  • Replaces all `reqAlias.body` → `body`
 *  • Rewrites:
 *      - res.status(code).json(body)
 *        → return ctx.json(body, { status: code })
 *      - res.json(body) / res.send(body)
 *        → return ctx.json(body)
 *      - res.redirect(url)
 *        → return new Response(null, { status: 302, headers: { location: url } })
 *      - res.sendStatus(code)
 *        → return new Response(null, { status: code })
 *  • Cleans up any leftover Express or Node imports
 *  • Supports --dry-run and --quiet flags
 */

import { Glob } from 'bun'
import jscodeshiftPkg from 'jscodeshift'

const args   = Bun.argv.slice(1)
const dryRun = args.includes('--dry-run') || args.includes('-d')
const quiet  = args.includes('--quiet')   || args.includes('-q')
const log    = (...m) => !quiet && console.log(...m)
const debug  = (...m) => console.debug('[transform-controllers]', ...m)

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

function transform(source, filePath) {
  // 0) Idempotency guard
  if (source.includes('// bun: controllers-updated')) return null

  // 1) Setup jscodeshift with TS support
  const jscodeshift = jscodeshiftPkg.withParser('ts')
  const j = jscodeshift
  const root = j(source)
  let did = false

  debug('processing', filePath)

  // 2) Insert marker
  root.get().node.program.body.unshift(
    j.expressionStatement(j.literal('// bun: controllers-updated'))
  )
  did = true

  // 3) Remove Express & Node core imports/requires
  ['express','fs','path','url'].forEach(mod => {
    did ||= removeImport(root, j, mod)
    did ||= removeRequire(root, j, mod)
  })

  // 4) Convert CommonJS exports → ESM
  const defaultExports = []

  // exports.foo = ...
  root.find(j.ExpressionStatement, {
    expression: {
      type: 'AssignmentExpression',
      left: {
        object: { name: 'exports' }
      }
    }
  }).forEach(path => {
    const { left, right } = path.node.expression
    const name = left.property.name
    // export const name = right
    const decl = j.exportNamedDeclaration(
      j.variableDeclaration('const', [
        j.variableDeclarator(j.identifier(name), right)
      ]),
      []
    )
    j(path).replaceWith(decl)
    did = true
  })

  // module.exports = { a:..., b:... } or = foo
  root.find(j.ExpressionStatement, {
    expression: {
      type: 'AssignmentExpression',
      left: {
        object:{ name:'module' },
        property:{ name:'exports' }
      }
    }
  }).forEach(path => {
    const right = path.node.expression.right
    if (right.type === 'ObjectExpression') {
      // named exports
      right.properties.forEach(prop => {
        if (prop.type === 'Property') {
          const key = prop.key.name || prop.key.value
          const val = prop.value
          const namedDecl = j.exportNamedDeclaration(
            j.variableDeclaration('const', [
              j.variableDeclarator(j.identifier(key), val)
            ]),
            []
          )
          root.get().node.program.body.push(namedDecl)
        }
      })
    } else if (right.type === 'Identifier') {
      // default export
      defaultExports.push(right.name)
    }
    j(path).remove()
    did = true
  })

  // 5) Transform each controller function
  root.find(j.FunctionDeclaration).forEach(path => {
    const fn = path.node
    if (fn.params.length < 2) return

    // Capture original param names
    const reqAlias = fn.params[0].name
    const resAlias = fn.params[1].name

    // 5a) Rename parameters to (request, ctx)
    fn.params[0] = j.identifier('request')
    fn.params[1] = j.identifier('ctx')

    // 5b) Ensure async
    if (!fn.async) { fn.async = true; did = true }

    // 5c) Inject `const body = await request.json()` if reqAlias.body is used
    let usesBody = false
    j(fn.body).find(j.MemberExpression, {
      object: { name: reqAlias },
      property: { name: 'body' }
    }).forEach(() => { usesBody = true })

    if (usesBody) {
      const first = fn.body.body[0]
      const already = first && first.type === 'VariableDeclaration'
        && first.declarations[0].id.name === 'body'
      if (!already) {
        const decl = j.variableDeclaration('const', [
          j.variableDeclarator(
            j.identifier('body'),
            j.awaitExpression(
              j.callExpression(
                j.memberExpression(j.identifier('request'), j.identifier('json')),
                []
              )
            )
          )
        ])
        fn.body.body.unshift(decl)
        did = true
      }
      // Replace all `request.body` → `body`
      j(fn.body).find(j.MemberExpression, {
        object:{ name:'request' },
        property:{ name:'body' }
      }).replaceWith(j.identifier('body'))
      did = true
    }

    // 5d) Rename any remaining resAlias → ctx
    j(fn.body).find(j.Identifier, { name: resAlias })
      .replaceWith(j.identifier('ctx'))
    did = true

    // 5e) Rewrite response patterns

    // res.status(x).json(y)
    j(fn.body).find(j.CallExpression, {
      callee: {
        property: { name: 'json' },
        object: {
          type: 'CallExpression',
          callee: { property: { name: 'status' } }
        }
      }
    }).forEach(p => {
      const bodyArg = p.node.arguments[0]
      const statusCall = p.node.callee.object
      const statusArg = statusCall.arguments[0]
      const ret = j.returnStatement(
        j.callExpression(
          j.memberExpression(j.identifier('ctx'), j.identifier('json')),
          [
            bodyArg,
            j.objectExpression([
              j.property('init', j.identifier('status'), statusArg)
            ])
          ]
        )
      )
      j(p.parent).replaceWith(ret)
      did = true
    })

    // res.json(y) or res.send(y)
    j(fn.body).find(j.CallExpression, {
      callee: {
        object:{ name:'ctx' },
        property: p => p.name === 'json' || p.name === 'send'
      }
    }).forEach(p => {
      const [arg] = p.node.arguments
      const ret = j.returnStatement(
        j.callExpression(
          j.memberExpression(j.identifier('ctx'), j.identifier('json')),
          [ arg ]
        )
      )
      j(p.parent).replaceWith(ret)
      did = true
    })

    // res.redirect(url)
    j(fn.body).find(j.CallExpression, {
      callee: {
        object:{ name:'ctx' },
        property:{ name:'redirect' }
      }
    }).forEach(p => {
      const [urlArg] = p.node.arguments
      const resp = j.newExpression(
        j.identifier('Response'),
        [
          j.literal(null),
          j.objectExpression([
            j.property('init', j.identifier('status'), j.literal(302)),
            j.property(
              'init',
              j.literal('headers'),
              j.objectExpression([
                j.property('init', j.literal('location'), urlArg)
              ])
            )
          ])
        ]
      )
      j(p.parent).replaceWith(j.returnStatement(resp))
      did = true
    })

    // res.sendStatus(code)
    j(fn.body).find(j.CallExpression, {
      callee: {
        object:{ name:'ctx' },
        property:{ name:'sendStatus' }
      }
    }).forEach(p => {
      const [codeArg] = p.node.arguments
      const resp = j.newExpression(
        j.identifier('Response'),
        [
          j.literal(null),
          j.objectExpression([
            j.property('init', j.identifier('status'), codeArg)
          ])
        ]
      )
      j(p.parent).replaceWith(j.returnStatement(resp))
      did = true
    })
  })

  // 6) Emit `export default` for collected defaultExports
  defaultExports.forEach(name => {
    root.get().node.program.body.push(
      j.exportDefaultDeclaration(j.identifier(name))
    )
    did = true
  })

  return did
    ? root.toSource({ quote:'single', trailingComma:true })
    : null
}

async function main() {
  for await (const filePath of new Glob(['**/*.{js,ts}'])) {
    if (
      filePath.includes('node_modules/') ||
      filePath.includes('codemods/') ||
      filePath.endsWith('transform-controllers.js')
    ) continue

    let src
    try { src = await Bun.file(filePath).text() }
    catch (e) { log(`read failed: ${filePath}`, e.message); continue }

    let out
    try { out = transform(src, filePath) }
    catch (e) {
      console.error('[transform-controllers] error in', filePath, e)
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
  console.error('[transform-controllers] fatal:', e)
  Bun.exit(1)
})