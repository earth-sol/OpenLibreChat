#!/usr/bin/env bun
// scripts/update-packagejson.js
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const targets = ['package.json', 'api/app/package.json', 'client/package.json'];

/**
 * Merge or remove dependencies in package.json
 */
function syncPackage(pkgPath, addDeps = {}, addDev = {}, removeDeps = []) {
  const fullPath = resolve(process.cwd(), pkgPath);
  const pkg = JSON.parse(readFileSync(fullPath, 'utf-8'));

  // Remove unwanted dependencies
  removeDeps.forEach(dep => {
    if (pkg.dependencies && pkg.dependencies[dep]) {
      delete pkg.dependencies[dep];
    }
    if (pkg.devDependencies && pkg.devDependencies[dep]) {
      delete pkg.devDependencies[dep];
    }
  });

  // Merge in new dependencies
  pkg.dependencies     = { ...pkg.dependencies,     ...addDeps     };
  pkg.devDependencies  = { ...pkg.devDependencies,  ...addDev      };

  writeFileSync(fullPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
}

// Remove Express from api/app and ensure Elysia deps are present
syncPackage(
  'api/app/package.json',
  { elysia: '^1.5.0', '@elysiajs/static': '^1.2.0' }, // add
  {},                                                // no dev
  ['express']                                        // remove
);

// (Optionally ensure other packages like jscodeshift, OpenTelemetry exist…)
console.log('✅ package.json scripts updated.');