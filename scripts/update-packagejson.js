#!/usr/bin/env node
/**
 * scripts/update-packagejson.js
 *
 * Ensures your three package.jsons get the right deps,
 * whether your front-end lives in `frontend/` or `client/`.
 */

const fs = require('fs');
const path = require('path');

function ensureDeps(relPath, deps, dev = false) {
  const pkgPath = path.resolve(__dirname, '..', relPath);
  if (!fs.existsSync(pkgPath)) {
    console.warn(`⚠️  Skipping missing ${relPath}`);
    return;
  }
  const text = fs.readFileSync(pkgPath, 'utf8');
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch (err) {
    console.error(`❌ Failed to parse ${relPath}:`, err.message);
    process.exit(1);
  }
  const section = dev ? 'devDependencies' : 'dependencies';
  pkg[section] = pkg[section] || {};
  for (const [name, version] of Object.entries(deps)) {
    pkg[section][name] = version;
  }
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`✅ Updated ${relPath} [${section}]`);
}

// 1) Root devDependencies
ensureDeps('package.json', {
  'jscodeshift': '^17.3.0'
}, true);

// 2) API server dependencies
ensureDeps('api/app/package.json', {
  'express': '^5.1.0'
}, false);

// 3) Frontend dependencies — try frontend/, then client/
const frontendPath = fs.existsSync(path.resolve(__dirname, '../frontend/package.json'))
  ? 'frontend/package.json'
  : 'client/package.json';

ensureDeps(frontendPath, {
  '@opentelemetry/api': '^1.9.0',
  '@opentelemetry/sdk-trace-web': '^2.0.0',
  '@opentelemetry/sdk-trace-base': '^2.0.0'
}, false);