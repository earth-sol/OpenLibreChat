#!/usr/bin/env bun

import { join } from "path";

// 1. Legacy deps to drop
const REMOVE = [
  "express","express-async-handler","body-parser","cookie-parser",
  "cors","dotenv","morgan","helmet","express-session","passport",
  "passport-local","mongoose","connect-mongo","redis","socket.io"
];

// 2. APIs to prioritize
const PRIORITIZED = [
  "elysia",
  "@elysiajs/static","@elysiajs/cors","@elysiajs/compression",
  "@elysiajs/cookie","@elysiajs/helmet","@elysiajs/logger",
  "@elysiajs/rate-limit","@elysiajs/session","@elysiajs/ws",
  "@elysiajs/swagger","@elysiajs/opentelemetry","@elysiajs/bearer",
  "@elysiajs/jwt","@elysiajs/server-timing","@elysiajs/cron",
  "@elysiajs/stream","@elysiajs/trpc","@elysiajs/graphql-yoga",
  "@elysiajs/graphql-apollo","@elysiajs/html"
];

function reorderDeps(block = {}) {
  const ordered = {};
  const seen = new Set();

  // Pull in prioritized first
  for (const name of PRIORITIZED) {
    if (name in block) {
      ordered[name] = block[name];
      seen.add(name);
    }
  }
  // Then the rest alphabetically
  for (const name of Object.keys(block).sort()) {
    if (!seen.has(name)) ordered[name] = block[name];
  }
  return ordered;
}

async function transformPackageJson(filePath) {
  try {
    const text = await Bun.file(filePath).text();
    const pkg = JSON.parse(text);

    console.log(`[transform-package-json] Processing ${filePath}`);

    // Remove legacy deps
    for (const section of ["dependencies","devDependencies"]) {
      if (pkg[section]) {
        for (const dep of REMOVE) {
          if (pkg[section][dep]) {
            console.log(`  - removing ${section}['${dep}']`);
            delete pkg[section][dep];
          }
        }
        if (Object.keys(pkg[section]).length === 0) {
          delete pkg[section];
        }
      }
    }

    // ESM
    pkg.type = "module";

    // Engines
    pkg.engines = pkg.engines || {};
    pkg.engines.bun    = ">=1.2.10";
    pkg.engines.elysia = ">=1.2.25";

    // Scripts
    pkg.scripts = pkg.scripts || {};
    pkg.scripts.dev   ||= "bun run dev";
    pkg.scripts.test  ||= "bun test";
    pkg.scripts.build ||= "bun build";

    // Core dependency
    pkg.dependencies ||= {};
    pkg.dependencies.elysia ||= ">=1.2.25";

    // Reorder
    pkg.dependencies = reorderDeps(pkg.dependencies);
    if (pkg.devDependencies) {
      pkg.devDependencies = reorderDeps(pkg.devDependencies);
    }

    // Write back
    await Bun.write(filePath, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`[transform-package-json] Updated ${filePath}\n`);
  } catch (err) {
    console.error(`[transform-package-json] ERROR on ${filePath}:`, err);
  }
}

async function main() {
  for await (const entry of Bun.scandir(process.cwd(), { recursive: true })) {
    if (!entry.isFile || entry.name !== "package.json") continue;
    await transformPackageJson(entry.path);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});