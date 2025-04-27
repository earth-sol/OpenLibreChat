#!/usr/bin/env bun
/**
 * scripts/run-codemods.js
 * --------------------------------
 * Bun-native orchestrator for all JavaScript codemods in the project.
 * - Discovers codemods under codemods/*.js
 * - Orders them according to a strategic dependency list, falling back to alphabetical
 * - Executes each via jscodeshift or bunx jscodeshift
 * - Supports --verbose (or -v) flag for detailed logging
 * - Uses only Bun Core APIs (glob, spawn, env, exit)
 * - Fails fast on missing tools or codemod errors
 */

/**
 * @param {string} msg
 */
function print(msg) {
  console.log(`ℹ️  ${msg}`);
}

/**
 * @param {string} msg
 */
function success(msg) {
  console.log(`✅ ${msg}`);
}

/**
 * @param {string} msg
 */
function error(msg) {
  console.error(`❌ ${msg}`);
  Bun.exit(1);
}

/**
 * Check if an executable exists in PATH.
 * @param {string} name
 * @returns {boolean}
 */
function checkExecutable(name) {
  const res = Bun.spawnSync(["which", name], { stdout: "ignore", stderr: "ignore" });
  return res.exitCode === 0;
}

/**
 * Parse CLI arguments.
 * @param {string[]} args
 * @returns {{ options: Record<string,string>, positional: string[] }}
 */
function parseArgs(args) {
  const options = {};
  const positional = [];
  for (const arg of args) {
    if (arg === "--verbose" || arg === "-v") {
      options.verbose = "true";
    } else {
      positional.push(arg);
    }
  }
  return { options, positional };
}

// File patterns for jscodeshift
const FILE_GLOBS = [
  "api/**/*.js",
  "api/**/*.ts",
  "api/server/**/*.js",
  "api/server/routes/**/*.js",
  "api/server/middleware/**/*.js",
  "api/lib/db/**/*.js",
  "api/config/**/*.js",
  "api/jest.config.js",
  "client/index.html",
  "client/**/*.html",
  "client/vite.config.ts",
  "client/src/**/*.{js,jsx,ts,tsx}",
  "client/test/**/*.{js,jsx,ts,tsx}",
  "packages/data-schemas/src/**/*.ts",
  "packages/data-schemas/tsconfig*.json",
  "packages/mcp/src/**/*.ts",
  "packages/mcp/tsconfig*.json",
  "packages/data-provider/src/**/*.ts",
  "packages/data-provider/tsconfig*.json",
  "packages/data-provider/react-query/src/**/*.ts",
  "packages/data-provider/react-query/tsconfig*.json",
  ".github/workflows/*.yml",
  "Dockerfile",
  "Dockerfile.multi",
  "docker-compose.yml",
  "deploy-compose.yml",
  "docker-compose.override.yml.example",
  "rag.yml",
  "charts/**/*.yaml",
  "config/**/*.js",
  "utils/**/*.sh",
  "utils/**/*.py",
  "e2e/**/*.ts",
  "e2e/**/*.js",
  "packages/**/jest.config.*"
].join(" ");

/**
 * The strategic execution order for codemods. 
 * Any codemod not listed here will be appended alphabetically.
 */
const DESIRED_ORDER = [
  "transform-require-to-import.js",
  "transform-env-access.js",
  "transform-server-index.js",
  "transform-express-routes-to-elysia.js",
  "transform-middleware.js",
  "transform-controllers.js",
  "transform-security-middleware.js",
  "transform-session-auth.js",
  "transform-websockets.js",
  "transform-db-utils.js",
  "transform-package-json.js",
  "transform-tsconfig.js",
  "transform-client-html.js",
  "transform-jest-config.js",
  "transform-ci-config.js",
  "transform-dockerfile.js",
  "transform-docker-compose.js",
  "transform-helm-values.js",
  "transform-eslint-config.js",
  "transform-prettier-config.js",
  "transform-readme.js",
  "transform-telemetry.js",
  "transform-devcontainer.js",
  "transform-husky.js",
  "transform-docker-scripts.js",
  "transform-config-scripts.js",
  "transform-e2e-tests.js"
];

/**
 * Discover and order codemod scripts.
 * @returns {Promise<string[]>}
 */
async function discoverAndOrderCodemods() {
  const mods = [];
  for await (const path of glob("codemods/*.js")) {
    mods.push(path);
  }
  // Map basename -> full path
  const byName = new Map(mods.map(p => [p.split("/").pop(), p]));
  const ordered = [];

  // Include in DESIRED_ORDER first
  for (const name of DESIRED_ORDER) {
    if (byName.has(name)) {
      ordered.push(byName.get(name));
      byName.delete(name);
    }
  }
  // Append any remaining codemods alphabetically
  const remainder = Array.from(byName.keys()).sort();
  for (const name of remainder) {
    ordered.push(byName.get(name));
  }

  return ordered;
}

async function main() {
  // Log Bun version
  try {
    const bunVer = Bun.spawnSync(["bun", "--version"], { stdout: "pipe" })
      .stdout.toString().trim();
    print(`Running on Bun v${bunVer}`);
  } catch {
    print("⚠️  Unable to determine Bun version.");
  }

  // Ensure jscodeshift or bunx is available
  const hasJSC = checkExecutable("jscodeshift");
  const hasBunx = checkExecutable("bunx");
  if (!hasJSC && !hasBunx) {
    error("jscodeshift not found and bunx not available. Please install jscodeshift.");
  }

  const { options } = parseArgs(Bun.argv.slice(2));
  const verbose = options.verbose === "true";

  print("🔍 Discovering and ordering codemods...");
  const codemods = await discoverAndOrderCodemods();
  if (codemods.length === 0) {
    print("⚠️  No codemods found in codemods/ directory.");
    return;
  }
  print(`⚙️  Executing ${codemods.length} codemod(s) in strategic order:`);
  codemods.forEach(m => print(`   • ${m.split("/").pop()}`));

  for (const mod of codemods) {
    const name = mod.split("/").pop();
    print(`\n🔧  Applying ${name}...`);
    const runner = hasJSC ? "jscodeshift" : "bunx jscodeshift";
    const cmd = [
      ...runner.split(" "),
      "-t", mod,
      "--parser", "tsx",
      "--extensions", "js,jsx,ts,tsx",
      "--verbose=2",
      ...FILE_GLOBS.split(" ")
    ];

    if (verbose) {
      print(`Executing: ${cmd.join(" ")}`);
    }
    const proc = spawn({ cmd, stdout: "inherit", stderr: "inherit" });
    const { exitCode, success: ok } = await proc.exited;
    if (!ok) {
      error(`Codemod failed: ${name} (exit ${exitCode})`);
    }
    success(`Completed ${name}`);
  }

  success("\n🎉  All codemods applied successfully!");
}

await main();