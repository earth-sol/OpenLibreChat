#!/usr/bin/env bun
// scripts/update-packagejson.js
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Sync a package.json:
 *  - removePatterns: [ /express/, … ] to strip any matching pkg.
 *  - addDeps:        { pkg: version } → dependencies
 *  - addDev:         { pkg: version } → devDependencies
 */
function syncPackage(
  pkgPath,
  { removePatterns = [], addDeps = {}, addDev = {} } = {}
) {
  const fullPath = resolve(process.cwd(), pkgPath);
  const pkg = JSON.parse(readFileSync(fullPath, 'utf-8'));
  const removed = [];

  // Strip matching packages
  ['dependencies', 'devDependencies'].forEach(field => {
    if (!pkg[field]) return;
    for (const name of Object.keys(pkg[field])) {
      if (removePatterns.some(rx => rx.test(name))) {
        removed.push({ name, field });
        delete pkg[field][name];
      }
    }
  });
  if (removed.length) {
    console.log(`🗑  Removed from ${pkgPath}:`);
    removed.forEach(r => console.log(`    • ${r.name} (from ${r.field})`));
  }

  // Merge in new deps
  pkg.dependencies    = { ...(pkg.dependencies    || {}), ...addDeps };
  pkg.devDependencies = { ...(pkg.devDependencies || {}), ...addDev  };

  writeFileSync(fullPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  console.log(`✅ Synced deps in ${pkgPath}`);
}

const expressRx = [/^express($|[-/])/i];

// 1. Root: dev‐only build & codemod tools
syncPackage('package.json', {
  removePatterns: expressRx,
  addDeps: {},
  addDev: {
    unified:             '^11.0.5',
    'rehype-parse':      '^9.0.1',
    'rehype-stringify':  '^9.0.3',
    'unist-util-visit':  '^5.0.0',
    jscodeshift:         '^17.3.0',
    '@types/jscodeshift':'^17.3.0'
  }
});

// 2. api/app: Elysia + Bun-native OTEL
syncPackage('api/app/package.json', {
  removePatterns: expressRx,
  addDeps: {
    elysia:                           '^1.2.25',
    '@elysiajs/static':               '^1.2.0',
    '@opentelemetry/sdk-node':        '^0.39.0',
    '@opentelemetry/auto-instrumentations-node':'^0.39.0',
    '@opentelemetry/exporter-trace-otlp-http':'^0.39.0',
    '@opentelemetry/resources':      '^1.12.0',
    '@opentelemetry/semantic-conventions':'^1.9.0'
  },
  addDev: {}
});

// 3. client: front-end instrumentation
syncPackage('client/package.json', {
  removePatterns: expressRx,
  addDeps: {
    '@opentelemetry/api':           '^1.9.0',
    '@opentelemetry/sdk-trace-base':'^2.0.0',
    '@opentelemetry/sdk-trace-web': '^2.0.0'
  },
  addDev: {}
});

console.log('🎉 All package.json workspaces synced.');