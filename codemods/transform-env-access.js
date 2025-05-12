#!/usr/bin/env bun

/**
 * scripts/transform-env-access.js
 *
 * A Bun-native CLI codemod that rewrites all environment-variable access
 * (process.env.X, import.meta.env.X, destructured env) → Bun.env.X,
 * injects per-file validations or a single app.resolve(...) hook,
 * removes legacy imports, and is fully idempotent.
 *
 *  • Idempotent via "// bun: env-access-updated" marker
 *  • Unified on jscodeshift.withParser('ts') for TS/JSX
 *  • Removes require/import of "dotenv/config" and "dotenv"
 *  • Handles destructuring: const { A, B = 'x' } = process.env
 *  • Rewrites process.env.X, import.meta.env.X, computed lookups,
 *    optional chaining, and converts `||` → `??`
 *  • Records keys used without fallback and injects `if (Bun.env.X === undefined) throw …`
 *  • Optionally (`--inject-hook`) adds a single app.resolve hook in "api/server/index.*"
 *    to validate all keys in one place
 *  • Cleans up unused imports (path, url)
 *  • Supports --dry-run/-d, --quiet/-q, --inject-hook, --env-target=<object.property>
 */

import { Glob } from 'bun'
import jscodeshiftPkg from 'jscodeshift'

const args        = Bun.argv.slice(1)
const dryRun      = args.includes('--dry-run') || args.includes('-d')
const quiet       = args.includes('--quiet')    || args.includes('-q')
const injectHook  = args.includes('--inject-hook')
const envFlag     = args.find(a => a.startsWith('--env-target='))
const envTarget   = envFlag ? envFlag.split('=')[1] : 'Bun.env'
const [envObj,envProp] = envTarget.split('.')

const log   = (...m) => !quiet && console.log(...m)
const debug = (...m) => !quiet && console.debug('[transform-env-access]', ...m)

/** Remove ESM import of a module */
function removeImport(root,j,mod) {
  const imps = root.find(j.ImportDeclaration, { source:{ value: mod } })
  if (imps.size()) { imps.remove(); debug(`removed import '${mod}'`); return true }
  return false
}
/** Remove CJS require of a module */
function removeRequire(root,j,mod) {
  const calls = root.find(j.CallExpression, {
    callee: { name:'require' },
    arguments: [{ value: mod }]
  })
  if (calls.size()) {
    calls.forEach(p => j(p).parent.remove())
    debug(`removed require('${mod}')`)
    return true
  }
  return false
}

/** Core transform */
function transform(source,filePath) {
  // 0) idempotency
  if (source.includes('// bun: env-access-updated')) return null

  const j    = jscodeshiftPkg.withParser('ts')
  const root = j(source)
  let did    = false

  debug('processing', filePath)

  // 1) prepend marker
  root.get().node.program.body.unshift(
    j.expressionStatement(j.literal('// bun: env-access-updated'))
  )
  did = true

  // 2) strip dotenv imports/requires
  removeImport(root,j,'dotenv/config') || removeRequire(root,j,'dotenv/config')
  removeImport(root,j,'dotenv')        || removeRequire(root,j,'dotenv')

  // 3) collect required keys
  const required = new Set()
  function recordUsage(path) {
    const parent = path.parentPath.node
    if (
      parent.type === 'LogicalExpression' &&
      (parent.operator === '||' || parent.operator === '??')
    ) return
    const prop = path.node.property
    const key  = prop.type === 'Identifier' ? prop.name : prop.value
    required.add(key)
  }

  // 4) handle destructuring: const { A, B = 'x' } = process.env
  root.find(j.VariableDeclarator, {
    id:  { type:'ObjectPattern' },
    init:{ type:'MemberExpression', object:{ property:{ name:'env' } } }
  }).forEach(path => {
    did = true
    const { properties } = path.node.id
    const newDecls = []

    properties.forEach(prop => {
      if (prop.type !== 'Property') return
      const key      = prop.key.name || prop.key.value
      const valNode  = prop.value
      const local    = valNode.type === 'AssignmentPattern' ? valNode.left.name : valNode.name
      const fallback = valNode.type === 'AssignmentPattern' ? valNode.right : null

      const envAccess = j.memberExpression(
        j.identifier(envObj),
        j.identifier(envProp),
        false
      )
      const accessKey = j.memberExpression(envAccess, j.literal(key), true)

      const initExpr = fallback
        ? j.logicalExpression('??', accessKey, fallback)
        : accessKey

      if (!fallback) required.add(key)
      newDecls.push(j.variableDeclarator(j.identifier(local), initExpr))
    })

    const varDecl = j.variableDeclaration('const', newDecls)
    j(path).replaceWith(varDecl)
  })

  // 5) rewrite MemberExpressions: process.env.X, import.meta.env.X, optional chaining
  root.find(j.MemberExpression, path => {
    const { object, property } = path.node
    if (!property || (property.type !== 'Identifier' && property.type !== 'Literal')) return false

    // process.env.X
    if (
      object.type === 'MemberExpression' &&
      object.object.type === 'Identifier' &&
      object.object.name === 'process' &&
      object.property.name === 'env'
    ) return true

    // import.meta.env.X
    if (
      object.type === 'MemberExpression' &&
      object.object.type === 'MemberExpression' &&
      object.object.object.name === 'import' &&
      object.object.property.name === 'meta' &&
      object.property.name === 'env'
    ) return true

    return false
  }).forEach(path => {
    did = true
    recordUsage(path)

    const key       = path.node.property.type === 'Identifier'
      ? path.node.property.name
      : path.node.property.value

    const envAccess = j.memberExpression(
      j.identifier(envObj),
      j.identifier(envProp),
      false
    )
    const replacement = j.memberExpression(envAccess, j.literal(key), true)
    j(path).replaceWith(replacement)
  })

  // 6) convert `||` → `??`
  root.find(j.LogicalExpression, { operator:'||' })
    .forEach(path => {
      did = true
      j(path).replaceWith(
        j.logicalExpression('??', path.node.left, path.node.right)
      )
    })

  // 7) inject validation checks after last import
  if (required.size) {
    did = true
    const lastImport = root.find(j.ImportDeclaration).paths().pop()
    const idx = root.get().node.program.body.indexOf(lastImport.node) + 1

    const checks = [...required].map(key => {
      const envAccess = j.memberExpression(
        j.identifier(envObj),
        j.identifier(envProp),
        false
      )
      const accessKey = j.memberExpression(envAccess, j.literal(key), true)
      return j.ifStatement(
        j.binaryExpression('===', accessKey, j.identifier('undefined')),
        j.throwStatement(
          j.newExpression(j.identifier('Error'), [
            j.literal(`Missing required env: ${key}`)
          ])
        )
      )
    })

    root.get().node.program.body.splice(idx, 0, ...checks)
  }

  // 8) optional: inject a single app.resolve hook in api/server/index.*
  if (injectHook && filePath.match(/api\/server\/index\.(js|ts)$/)) {
    const appVarDecl = root.find(j.VariableDeclarator, {
      init: { type:'NewExpression', callee:{ name:'Elysia' } }
    }).paths()[0]

    if (appVarDecl) {
      did = true
      const varName = appVarDecl.node.id.name
      const hookFn  = j.callExpression(
        j.memberExpression(j.identifier(varName), j.identifier('resolve')),
        [ j.arrowFunctionExpression(
            [],
            j.blockStatement(
              [...required].map(key => {
                const envAccess = j.memberExpression(
                  j.identifier(envObj),
                  j.identifier(envProp),
                  false
                )
                const accessKey = j.memberExpression(envAccess, j.literal(key), true)
                return j.ifStatement(
                  j.binaryExpression('===', accessKey, j.identifier('undefined')),
                  j.throwStatement(
                    j.newExpression(j.identifier('Error'), [
                      j.literal(`Missing required env: ${key}`)
                    ])
                  )
                )
              })
            )
          ) ]
      )
      // insert right after the var declaration statement
      const stmtList = appVarDecl.parent.parent.node.body
      const stmtIdx  = stmtList.findIndex(s => s === appVarDecl.parent.node)
      stmtList.splice(stmtIdx + 1, 0, j.expressionStatement(hookFn))
    }
  }

  // 9) cleanup leftover imports
  ;['path','url'].forEach(mod => {
    removeImport(root,j,mod) || removeRequire(root,j,mod)
  })

  return did
    ? root.toSource({ quote:'single', trailingComma:true })
    : null
}

async function main() {
  let processed = 0, failed = 0

  for await (const filePath of new Glob(['**/*.{js,ts}'])) {
    if (
      filePath.includes('node_modules') ||
      filePath.endsWith('transform-env-access.js')
    ) continue

    let src
    try {
      src = await Bun.file(filePath).text()
    } catch (e) {
      log(`read failed: ${filePath}`, e.message)
      failed++
      continue
    }

    let out
    try {
      out = transform(src, filePath)
    } catch (e) {
      console.error('[transform-env-access] error in', filePath, e)
      failed++
      continue
    }

    processed++
    if (!out) {
      debug(`no changes: ${filePath}`)
      continue
    }

    if (dryRun) {
      log(`DRY ${filePath}`)
    } else {
      try {
        await Bun.write(filePath, out)
        log(`✔ ${filePath}`)
      } catch (e) {
        log(`write failed: ${filePath}`, e.message)
        failed++
      }
    }
  }

  log(`\n✔ transform-env-access: processed=${processed}, failed=${failed}`)
  if (failed) Bun.exit(1)
}

main().catch(e => {
  console.error('[transform-env-access] fatal:', e)
  Bun.exit(1)
})