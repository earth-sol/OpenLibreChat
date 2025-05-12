#!/usr/bin/env bun

/**
 * scripts/transform-db-utils.js
 *
 * A Bun-native CLI codemod that converts Node‐fs sync calls in your
 * api/lib/db utilities into Bun-native file APIs, for Bun-only runtimes.
 *
 *  • Idempotent via "// bun: db-utils-updated" marker
 *  • Uses jscodeshift.withParser('ts') for TS/JSX support
 *  • Detects actual `fs` import/require alias
 *  • Transforms:
 *      - fs.readFileSync(path[, encoding])
 *        → await Bun.file(path).text()
 *      - fs.writeFileSync(path, data)
 *        → await Bun.write(path, data)
 *      - fs.existsSync(path)
 *        → await Bun.file(path).exists()
 *      - fs.unlinkSync(path)
 *        → await Bun.file(path).delete()
 *  • Marks parent functions async when injecting `await`
 *  • Removes now-unused `fs`, `path`, `url` imports/requires
 *  • Skips files already stamped
 *  • Supports --dry-run/-d and --quiet/-q
 *  • Configurable root via --root=<dir>
 */

import { Glob } from 'bun'
import jscodeshiftPkg from 'jscodeshift'
import path from 'path'

const args     = Bun.argv.slice(1)
const dryRun   = args.includes('--dry-run') || args.includes('-d')
const quiet    = args.includes('--quiet')    || args.includes('-q')
const rootFlag = args.find(a => a.startsWith('--root='))
const baseDir  = rootFlag
  ? path.resolve(rootFlag.split('=')[1])
  : process.cwd()

const log   = (...msg) => !quiet && console.log(...msg)
const debug = (...msg) => !quiet && console.debug('[transform-db-utils]', ...msg)

/** Find the local alias for `fs` (import or require) */
function findFsAlias(root, j) {
  let alias = null

  // ES import: import fs from 'fs' or import * as fs from 'fs'
  root.find(j.ImportDeclaration, { source: { value: 'fs' } })
    .forEach(p => {
      p.node.specifiers.forEach(spec => {
        alias = spec.local.name
      })
    })

  if (alias) return alias

  // CommonJS require: const fs = require('fs')
  root.find(j.VariableDeclarator, {
    init: {
      callee: { name: 'require' },
      arguments: [{ value: 'fs' }]
    }
  }).forEach(p => {
    if (p.node.id.type === 'Identifier') {
      alias = p.node.id.name
    }
  })

  return alias || 'fs'
}

/** Mark the nearest enclosing function async if not already */
function ensureAsync(path, j) {
  const fn = path.closest(
    p =>
      p.node.type === 'FunctionDeclaration' ||
      p.node.type === 'FunctionExpression' ||
      p.node.type === 'ArrowFunctionExpression'
  )
  if (fn && !fn.node.async) {
    fn.node.async = true
    debug('marked function async at line', fn.node.loc.start.line)
  }
}

/** Remove ESM import of `mod` */
function removeImport(root, j, mod) {
  const imps = root.find(j.ImportDeclaration, { source: { value: mod } })
  if (imps.size()) {
    imps.remove()
    debug(`removed import '${mod}'`)
    return true
  }
  return false
}

/** Remove CommonJS require of `mod` */
function removeRequire(root, j, mod) {
  const calls = root.find(j.CallExpression, {
    callee: { name: 'require' },
    arguments: [{ value: mod }]
  })
  if (calls.size()) {
    calls.forEach(p => j(p).parent.remove())
    debug(`removed require('${mod}')`)
    return true
  }
  return false
}

/** Perform AST transforms on a single file */
function transform(source, filePath) {
  if (source.includes('// bun: db-utils-updated')) {
    debug('already updated:', filePath)
    return null
  }

  const j    = jscodeshiftPkg.withParser('ts')
  const root = j(source)
  let did    = false

  debug('processing', filePath)

  // 1) Idempotency marker
  root.get().node.program.body.unshift(
    j.expressionStatement(j.literal('// bun: db-utils-updated'))
  )
  did = true

  // 2) Detect fs alias and remove its import/require later
  const fsAlias = findFsAlias(root, j)

  // 3) Transform fs.*Sync calls
  const mappings = [
    {
      name: 'readFileSync',
      replace: args => {
        const [pathArg] = args
        return j.awaitExpression(
          j.callExpression(
            j.memberExpression(
              j.callExpression(j.identifier('Bun.file'), [pathArg]),
              j.identifier('text')
            ),
            []
          )
        )
      }
    },
    {
      name: 'writeFileSync',
      replace: args => {
        const [pathArg, dataArg] = args
        return j.awaitExpression(
          j.callExpression(j.identifier('Bun.write'), [pathArg, dataArg])
        )
      }
    },
    {
      name: 'existsSync',
      replace: args => {
        const [pathArg] = args
        return j.awaitExpression(
          j.callExpression(
            j.memberExpression(
              j.callExpression(j.identifier('Bun.file'), [pathArg]),
              j.identifier('exists')
            ),
            []
          )
        )
      }
    },
    {
      name: 'unlinkSync',
      replace: args => {
        const [pathArg] = args
        return j.awaitExpression(
          j.callExpression(
            j.memberExpression(
              j.callExpression(j.identifier('Bun.file'), [pathArg]),
              j.identifier('delete')
            ),
            []
          )
        )
      }
    }
  ]

  mappings.forEach(({ name, replace }) => {
    root.find(j.CallExpression, {
      callee: {
        type: 'MemberExpression',
        object: { name: fsAlias },
        property: { name }
      }
    }).forEach(path => {
      const newExpr = replace(path.node.arguments)
      path.replace(newExpr)
      ensureAsync(path, j)
      did = true
      debug(`replaced fs.${name} at line`, path.node.loc.start.line)
    })
  })

  // 4) Remove now-unused fs/path/url imports & requires
  ['fs', 'path', 'url'].forEach(mod => {
    removeImport(root, j, mod) || removeRequire(root, j, mod)
  })

  return did
    ? root.toSource({ quote: 'single', trailingComma: true })
    : null
}

/** Main runner */
async function main() {
  const pattern = path.join(baseDir, 'api/lib/db/**/*.{js,ts}')
  let processed = 0
  let failed    = 0

  for await (const filePath of new Glob([pattern])) {
    if (
      filePath.includes('node_modules') ||
      filePath.endsWith('transform-db-utils.js')
    ) continue

    let src
    try {
      src = await Bun.file(filePath).text()
    } catch (e) {
      console.error('[transform-db-utils] read failed:', filePath, e.message)
      failed++
      continue
    }

    let out
    try {
      out = transform(src, filePath)
    } catch (e) {
      console.error('[transform-db-utils] transform error in', filePath, e)
      failed++
      continue
    }

    processed++
    if (!out) {
      debug('no changes:', filePath)
      continue
    }

    if (dryRun) {
      log('DRY', filePath)
    } else {
      try {
        await Bun.write(filePath, out)
        log('✔', filePath)
      } catch (e) {
        console.error('[transform-db-utils] write failed:', filePath, e.message)
        failed++
      }
    }
  }

  log(`\ntransform-db-utils: processed=${processed}, failed=${failed}`)
  if (failed) Bun.exit(1)
}

main().catch(e => {
  console.error('[transform-db-utils] fatal:', e)
  Bun.exit(1)
})