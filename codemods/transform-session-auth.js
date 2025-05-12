#!/usr/bin/env bun

/**
 * scripts/transform-session-auth.js
 *
 * A Bun-native CLI that transforms your Express+Passport session auth
 * into Elysia’s session plugin with environment-backed config:
 *
 *  • Idempotency marker
 *  • Remove dotenv, module-alias, express imports
 *  • Strip express.json()/urlencoded()
 *  • Remove express-session & passport imports/requires
 *  • Import Session from '@elysia/session'
 *  • Migrate `app.use(sess(opts))` → `app.use(Session({...}))`
 *    – Preserve any `store` prop but point `uri` to Bun.env.MONGO_URI
 *    – Set `secret: Bun.env.SESSION_SECRET ?? <fallback>`
 *    – Remove unsupported options (resave, saveUninitialized)
 *  • Remove passport.initialize()/passport.session()
 *  • Inject `app.auth(ctx => ctx.session?.user ?? null)`
 *  • Decorate `login`/`logout` on app: map to ctx.session.user
 *  • Debug logging on; silence with --quiet
 *  • Dry-run with --dry-run
 *  • Fails gracefully, leaves unmodified if no changes
 *
 * Usage:
 *   ./scripts/transform-session-auth.js [--dry-run] [--quiet]
 */

import { Glob } from 'bun'
import jscodeshift from 'jscodeshift'

const args   = Bun.argv.slice(1)
const dryRun = args.includes('--dry-run') || args.includes('-d')
const quiet  = args.includes('--quiet')   || args.includes('-q')
const log    = (...m) => !quiet && console.log(...m)
const debug  = (...m) => console.debug('[transform-session-auth]', ...m)

/**
 * Ensure an import is present; returns true if inserted.
 */
function addImport(root, specifiers, source) {
  const j = jscodeshift
  if (!root.find(j.ImportDeclaration, { source: { value: source } }).size()) {
    const imp = j.importDeclaration(specifiers, j.literal(source))
    root.get().node.program.body.unshift(imp)
    debug(`import '${source}'`)
    return true
  }
  return false
}

/**
 * Perform AST transforms on given source.
 */
function transformer(source, filePath) {
  if (source.includes('// bun: session-auth-updated')) {
    debug(`already transformed: ${filePath}`)
    return null
  }

  const j = jscodeshift
  const root = j(source)
  let didTransform = false

  debug('transforming', filePath)

  // 0) Idempotency marker
  root.get().node.program.body.unshift(
    j.expressionStatement(j.literal('// bun: session-auth-updated'))
  )

  // 1) Remove dotenv & module-alias
  root
    .find(j.CallExpression, {
      callee: {
        object: { callee: { name: 'require', arguments:[{value:'dotenv'}] } },
        property: { name: 'config' }
      }
    })
    .remove() && (didTransform = true)

  root
    .find(j.CallExpression, {
      callee: { name:'require', arguments:[{value:'module-alias'}] }
    })
    .remove() && (didTransform = true)

  // 2) Remove express imports/requires & json/urlencoded
  root.find(j.ImportDeclaration, { source: { value:'express' } }).remove() && (didTransform = true)
  root
    .find(j.VariableDeclarator, {
      init:{callee:{name:'require',arguments:[{value:'express'}]}}
    })
    .remove() && (didTransform = true)

  // strip express.json() / urlencoded()
  root
    .find(j.CallExpression, {
      callee: {
        object:{name:'express'},
        property:{name:/^(json|urlencoded)$/}
      }
    })
    .forEach(path => { j(path.parent).remove(); didTransform = true })

  // 3) Remove express-session & passport imports/requires, track aliases
  const sessionAliases  = new Set()
  const passportAliases = new Set()

  // ESM imports
  root.find(j.ImportDeclaration, { source:{value:'express-session'} })
    .forEach(path => {
      path.node.specifiers.forEach(spec => sessionAliases.add(spec.local.name))
      debug(`stripped import 'express-session'`)
      j(path).remove()
      didTransform = true
    })
  root.find(j.ImportDeclaration, { source:{value:'passport'} })
    .forEach(path => {
      path.node.specifiers.forEach(spec => passportAliases.add(spec.local.name))
      debug(`stripped import 'passport'`)
      j(path).remove()
      didTransform = true
    })

  // CJS requires
  root.find(j.VariableDeclarator, {
    init:{callee:{name:'require',arguments:[{value:'express-session'}]}}
  }).forEach(path => {
    const id = path.node.id
    if (id.type==='Identifier') sessionAliases.add(id.name)
    debug(`stripped require('express-session')`)
    j(path).remove()
    didTransform = true
  })
  root.find(j.VariableDeclarator, {
    init:{callee:{name:'require',arguments:[{value:'passport'}]}}
  }).forEach(path => {
    const id = path.node.id
    if (id.type==='Identifier') passportAliases.add(id.name)
    debug(`stripped require('passport')`)
    j(path).remove()
    didTransform = true
  })

  // 4) Import Session plugin
  if (addImport(root, [ j.importDefaultSpecifier(j.identifier('Session')) ], '@elysia/session')) {
    didTransform = true
  }

  // 5) Transform app.use(sessionAlias(opts)) → Session({ … })
  if (sessionAliases.size) {
    const isSessionUse = path =>
      path.node.arguments.length===1 &&
      path.node.arguments[0].callee &&
      sessionAliases.has(path.node.arguments[0].callee.name)

    root.find(j.CallExpression, {
      callee:{ object:{name:'app'}, property:{name:'use'}}
    })
    .filter(isSessionUse)
    .forEach(path => {
      const oldName = path.node.arguments[0].callee.name
      const optsNode = path.node.arguments[0].arguments[0] || j.objectExpression([])
      // build new options object
      const props = []
      if (optsNode.type==='ObjectExpression') {
        optsNode.properties.forEach(prop => {
          const key = prop.key.name
          if (key==='store') {
            // preserve store but map uri
            props.push(j.property(
              'init',
              j.identifier('store'),
              j.callExpression(
                j.memberExpression(j.identifier('new'), j.identifier('MongoStore')),
                [
                  j.objectExpression([
                    j.property(
                      'init',
                      j.identifier('uri'),
                      j.logicalExpression('??',
                        j.memberExpression(j.memberExpression(j.identifier('Bun'), j.identifier('env')), j.identifier('MONGO_URI')),
                        j.literal('mongodb://localhost:27017')
                      )
                    )
                  ])
                ]
              )
            ))
          } else if (key==='secret') {
            props.push(j.property(
              'init',
              j.identifier('secret'),
              j.logicalExpression('??',
                j.memberExpression(j.memberExpression(j.identifier('Bun'), j.identifier('env')), j.identifier('SESSION_SECRET')),
                j.literal('default-secret')
              )
            ))
          }
          // drop resave, saveUninitialized
        })
      }
      // ensure secret even if none
      if (!props.find(p=>p.key.name==='secret')) {
        props.push(j.property(
          'init',
          j.identifier('secret'),
          j.logicalExpression('??',
            j.memberExpression(j.memberExpression(j.identifier('Bun'), j.identifier('env')), j.identifier('SESSION_SECRET')),
            j.literal('default-secret')
          )
        ))
      }
      const newCall = j.callExpression(
        j.memberExpression(j.identifier('app'), j.identifier('use')),
        [
          j.callExpression(
            j.identifier('Session'),
            [ j.objectExpression(props) ]
          )
        ]
      )
      debug(`replaced app.use(${oldName}(...)) → Session(...)`)
      j(path.parent).replaceWith(j.expressionStatement(newCall))
      didTransform = true
    })
  }

  // 6) Remove passport.initialize()/session()
  if (passportAliases.size) {
    ['initialize','session'].forEach(fn =>
      root.find(j.CallExpression, {
        callee:{ object:{ name:alias=>passportAliases.has(alias) }, property:{ name:fn } }
      })
      .forEach(path => { j(path.parent).remove(); didTransform = true })
    )
  }

  // 7) Inject app.auth hook if missing
  if (!root.find(j.CallExpression, { callee:{ object:{name:'app'}, property:{name:'auth'} } }).size()) {
    debug('injecting app.auth hook')
    const authStmt = j.expressionStatement(
      j.callExpression(
        j.memberExpression(j.identifier('app'), j.identifier('auth')),
        [
          j.arrowFunctionExpression(
            [ j.identifier('ctx') ],
            j.logicalExpression(
              '??',
              j.memberExpression(
                j.memberExpression(j.identifier('ctx'), j.identifier('session')),
                j.identifier('user')
              ),
              j.literal(null)
            )
          )
        ]
      )
    )
    // insert after Elysia instantiation
    const varDecl = root.find(j.VariableDeclarator, { id:{name:'app'} }).at(0)
    if (varDecl.size()) varDecl.get().insertAfter(authStmt)
    else root.get().node.program.body.push(authStmt)
    didTransform = true
  }

  // 8) Decorate login/logout
  debug('injecting login/logout decorators')
  addImport(root, [ j.importSpecifier(j.identifier('decorate')) ], 'elysia')
  const decLogin = j.expressionStatement(
    j.callExpression(
      j.memberExpression(j.identifier('app'), j.identifier('decorate')),
      [
        j.literal('login'),
        j.arrowFunctionExpression(
          [ j.identifier('ctx'), j.identifier('user') ],
          j.assignmentExpression(
            '=',
            j.memberExpression(j.identifier('ctx.session'), j.identifier('user')),
            j.identifier('user')
          )
        )
      ]
    )
  )
  const decLogout = j.expressionStatement(
    j.callExpression(
      j.memberExpression(j.identifier('app'), j.identifier('decorate')),
      [
        j.literal('logout'),
        j.arrowFunctionExpression(
          [ j.identifier('ctx') ],
          j.callExpression(
            j.identifier('delete'),
            [
              j.memberExpression(j.identifier('ctx.session'), j.identifier('user'))
            ]
          )
        )
      ]
    )
  )
  // append at end
  root.get().node.program.body.push(decLogin, decLogout)
  didTransform = true

  if (!didTransform) return null
  return root.toSource({ quote:'single', trailingComma:true })
}

// Runner
async function main() {
  for await (const filePath of new Glob(['api/server/index.js'])) {
    let src
    try { src = await Bun.file(filePath).text() }
    catch (e) { log(`read failed: ${filePath}`, e.message); continue }
    const out = transformer(src, filePath)
    if (!out) { debug(`no change: ${filePath}`); continue }
    if (!dryRun) {
      try { await Bun.write(filePath, out) }
      catch (e) { log(`write failed: ${filePath}`, e.message) }
    }
    log(`${dryRun? 'DRY':'✔'} ${filePath}`)
  }
}

main().catch(e=>{
  console.error('[transform-session-auth] fatal:', e)
  Bun.exit(1)
})5