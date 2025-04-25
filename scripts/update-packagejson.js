#!/usr/bin/env bun
// scripts/update-packagejson.js
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const targets = ['package.json', 'api/app/package.json', 'client/package.json'];

/**
 * Merge deps into specified field of a package.json
 */
function ensureDeps(pkgPath, deps, dev = false) {
  const fullPath = resolve(process.cwd(), pkgPath);
  const pkg = JSON.parse(readFileSync(fullPath, 'utf-8'));
  const field = dev ? 'devDependencies' : 'dependencies';
  pkg[field] = { ...pkg[field], ...deps };
  writeFileSync(fullPath, JSON.stringify(pkg, null, 2) + '\n');
}

// Example: always ensure Elysia is installed in api/app
ensureDeps('api/app/package.json', { elysia: '^1.5.0', '@elysiajs/static': '^1.0.0' });

// Other global deps (OTel, jscodeshift) can be managed similarly...
console.log('✅ package.json dependencies updated.');