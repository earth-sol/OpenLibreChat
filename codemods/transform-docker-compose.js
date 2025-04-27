#!/usr/bin/env bun
/**
 * codemods/transform-docker-compose.js
 * Bun-native, plugin-driven, always-verbose, path-free Docker Compose transforms.
 */

import yaml from 'js-yaml'

// ─── Config ───────────────────────────────────────────────────────────────────
const DEFAULT_PATTERNS = [
  'docker-compose.yml',
  'deploy-compose.yml',
  'docker-compose.override.yml*',
  'rag.yml'
]
const GLOBS = (Bun.env.COMPOSE_GLOBS?.split(',') || DEFAULT_PATTERNS).map(s => s.trim())
const BACKUP_SUFFIX = Bun.env.BACKUP_SUFFIX || '.bak'
const MIN_DEPENDS_ON = 3.9

// ─── Logger ───────────────────────────────────────────────────────────────────
function debug(...args) {
  console.log('[debug]', ...args)
}

// ─── YAML I/O ─────────────────────────────────────────────────────────────────
function loadYAML(filePath) {
  debug('Reading YAML from', filePath)
  return yaml.load(Bun.file(filePath).textSync()) || {}
}

function dumpYAML(filePath, doc) {
  debug('Writing YAML to', filePath)
  Bun.write(filePath, yaml.dump(doc, { lineWidth: -1 }))
}

// ─── Transformer scaffolding ─────────────────────────────────────────────────
class Transformer {
  constructor() { this.plugins = [] }

  use(fn) {
    debug('Registering plugin', fn.name)
    this.plugins.push(fn)
    return this
  }

  async transformOne(file) {
    debug('---\nProcessing file:', file)

    // 1) Backup
    const bak = file + BACKUP_SUFFIX
    if (!Bun.file(bak).existsSync()) {
      Bun.file(file).copySync(bak)
      console.log(`• backed up ${file} → ${bak}`)
    } else {
      debug('Backup already exists, skipping:', bak)
    }

    // 2) Load
    let doc = loadYAML(file)

    // 3) Plugins
    for (let plugin of this.plugins) {
      debug(`Plugin start: ${plugin.name}`)
      try {
        const result = await plugin(doc, file)
        if (result) doc = result
      } catch (err) {
        console.error(`⁉ Error in plugin ${plugin.name} for ${file}:`, err)
      }
      debug(`Plugin end:   ${plugin.name}`)
    }

    // 4) Dump
    dumpYAML(file, doc)
    console.log(`✔ transformed ${file}`)
  }

  async run() {
    debug('Using glob patterns:', GLOBS)
    const files = new Set()
    for (let pat of GLOBS) {
      for await (let entry of new Bun.Glob(pat)) {
        debug('Matched file:', entry.path)
        files.add(entry.path)
      }
    }
    if (!files.size) {
      console.warn('⚠ No Docker Compose files found for patterns:', GLOBS)
      return
    }
    console.log(`→ Found ${files.size} compose file(s).`)
    for (let f of files) {
      await this.transformOne(f)
    }
  }
}

// ─── Built-in plugins ─────────────────────────────────────────────────────────

// 1) Image rewrite & build injection
async function imagePlugin(doc) {
  debug('imagePlugin running')
  const svcs = doc.services || {}
  for (let [name, svc] of Object.entries(svcs)) {
    if (typeof svc.image === 'string' && svc.image.startsWith('ghcr.io/danny-avila/librechat')) {
      const tag = Bun.env.IMAGE_TAG ?? 'latest'
      let repo
      if (name === 'api') repo = Bun.env.IMAGE_REPO ?? 'myregistry/librechat-bun'
      else if (['rag_api','rag-api'].includes(name))
        repo = Bun.env.RAG_IMAGE_REPO ?? 'myregistry/librechat-rag-api-bun'
      if (repo) {
        debug(`Rewriting image for ${name}:`, svc.image, '→', `${repo}:${tag}`)
        svc.image = `${repo}:${tag}`

        if (!svc.build) {
          const df = Bun.file('Dockerfile.multi').existsSync() && name !== 'api'
            ? 'Dockerfile.multi'
            : 'Dockerfile'
          debug(`Injecting build section for ${name} with Dockerfile "${df}"`)
          svc.build = {
            context: '.',
            dockerfile: df,
            ...(df === 'Dockerfile.multi'
              ? { target: name === 'api' ? 'api-build' : undefined }
              : {})
          }
        }
      }
    }
  }
  return doc
}

// 2) Command rewrite to Bun
async function commandPlugin(doc) {
  debug('commandPlugin running')
  const svcs = doc.services || {}
  const rewrite = str => str
    .replace(/\bnpm install\b/g, 'bun install')
    .replace(/\bnpm run\b/g,     'bun run')
    .replace(/\byarn install\b/g,'bun install')
    .replace(/\bnode\b/g,        'bun')

  for (let svc of Object.values(svcs)) {
    if (svc.command) {
      debug('Original command:', svc.command)
      if (typeof svc.command === 'string') svc.command = rewrite(svc.command)
      else if (Array.isArray(svc.command)) svc.command = svc.command.map(rewrite)
      debug('Rewritten command:', svc.command)
    }
  }
  return doc
}

// 3) Ensure .env mount for API
async function envPlugin(doc) {
  debug('envPlugin running')
  const svc = doc.services?.api
  if (!svc) return doc

  svc.volumes = svc.volumes || []
  const hasEnv = svc.volumes.some(v =>
    typeof v === 'string' ? v.includes('.env') : v.target === '/app/.env'
  )
  if (!hasEnv) {
    debug('Injecting .env mount into api service')
    const entry = svc.volumes.some(v => typeof v === 'object')
      ? { type: 'bind', source: './.env', target: '/app/.env' }
      : './.env:/app/.env'
    svc.volumes.unshift(entry)
  }
  return doc
}

// 4) HTTP healthcheck + modern depends_on
async function healthPlugin(doc) {
  debug('healthPlugin running')
  const version = parseFloat(doc.version || '0')
  for (let [name, svc] of Object.entries(doc.services || {})) {
    if (['api','rag_api','rag-api'].includes(name) && !svc.healthcheck) {
      debug(`Adding healthcheck to "${name}"`)
      let port = '3080'
      if (svc.ports?.length) port = svc.ports[0].toString().split(':').pop()
      svc.healthcheck = {
        test: ['CMD-SHELL', `curl -f http://localhost:${port}/health || exit 1`],
        interval: '30s',
        timeout: '10s',
        retries: 5
      }
      if (version >= MIN_DEPENDS_ON && Array.isArray(svc.depends_on)) {
        debug(`Converting depends_on for "${name}" to service_healthy conditions`)
        const obj = {}
        for (let d of svc.depends_on) obj[d] = { condition: 'service_healthy' }
        svc.depends_on = obj
      }
    }
  }
  if (!doc.version) {
    debug('Setting default compose version to 3.8')
    doc.version = '3.8'
  }
  return doc
}

// ─── Execute transformer ──────────────────────────────────────────────────────
new Transformer()
  .use(imagePlugin)
  .use(commandPlugin)
  .use(envPlugin)
  .use(healthPlugin)
  // → add custom plugins here via .use(yourPlugin)
  .run()
  .catch(err => {
    console.error('❌ transform-docker-compose failed:', err)
    process.exit(1)
  })