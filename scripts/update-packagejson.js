#!/usr/bin/env node
/**
 * scripts/update-packagejson.js
 *
 * Ensures your fork’s package.json files always include the required
 * dependency versions, adding or updating them as needed.
 */

const fs = require('fs');
const path = require('path');

function ensureDeps(relPath, deps, dev = false) {
  const pkgPath = path.resolve(__dirname, '..', relPath);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const section = dev ? 'devDependencies' : 'dependencies';
  pkg[section] = pkg[section] || {};
  for (const [name, version] of Object.entries(deps)) {
    pkg[section][name] = version;
  }
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`✅ Updated ${relPath} [${section}]`);
}

// 1) Root fork package.json (dev deps)
ensureDeps('package.json', {
  'jscodeshift': '^17.3.0'
}, true);

// 2) Express plugin server (prod deps)
ensureDeps('api/app/package.json', {
  'express': '^5.1.0'
}, false);

// 3) Frontend OpenTelemetry SDKs (prod deps)
ensureDeps('frontend/package.json', {
  '@opentelemetry/api': '^1.9.0',
  '@opentelemetry/sdk-trace-web': '^2.0.0',
  '@opentelemetry/sdk-trace-base': '^2.0.0'
}, false);