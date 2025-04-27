#!/usr/bin/env bun
/**
 * scripts/transform-utils.js
 * --------------------------------
 * Bun-native CLI to codemod shell scripts:
 * - Replace npm, npx, yarn calls with bun, bunx.
 * - Safe backups (`.bak` files).
 * - Logs Bun version.
 * - Fully Bun Core APIs, pure JavaScript.
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
function warn(msg) {
  console.warn(`⚠️  ${msg}`);
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
 * @returns {Promise<string[]>}
 */
async function findShellScripts() {
  const glob = new Bun.Glob("**/*.sh");
  const matches = await glob.scan({
    cwd: Bun.env.PWD || ".",
    absolute: true,
  });
  return matches.filter(path =>
    path.includes("/utils/") ||
    path.includes("/packages/") ||
    path.includes("/client/")
  );
}

/**
 * Transform a single file in place, backing up original.
 * @param {string} filePath
 */
async function transformFile(filePath) {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    warn(`Skipping missing file: ${filePath}`);
    return;
  }

  const original = await file.text();
  const transformed = original
    .replace(/\bnpm view\b/g, "bun pm info")
    .replace(/\bnpm ci\b/g, "bun install --frozen-lockfile")
    .replace(/\bnpm install\b/g, "bun install")
    .replace(/\bnpm test\b/g, "bun test")
    .replace(/\bnpm run\b/g, "bun run")
    .replace(/\bnpx\b/g, "bunx")
    .replace(/\byarn add\b/g, "bun add")
    .replace(/\byarn init\b/g, "bun init")
    .replace(/\byarn\b/g, "bun");

  if (transformed === original) {
    print(`No changes needed: ${filePath}`);
    return;
  }

  const backupPath = `${filePath}.bak`;
  await Bun.write(backupPath, original);
  print(`Backup created: ${backupPath}`);

  await Bun.write(filePath, transformed);
  success(`Transformed: ${filePath}`);
}

async function main() {
  // Validate Bun
  if (!checkExecutable("bun")) {
    error("Bun is not installed. Please install Bun: https://bun.sh/");
  }
  const bunVer = Bun.spawnSync(["bun", "--version"], { stdout: "pipe" }).stdout.toString().trim();
  print(`Bun version: ${bunVer}`);

  print("Scanning for shell scripts to transform...");
  const scripts = await findShellScripts();
  if (scripts.length === 0) {
    warn("No shell scripts found under utils/, packages/, or client/.");
    return;
  }
  print(`Found ${scripts.length} shell scripts.`);

  for (const script of scripts) {
    await transformFile(script);
  }

  success("All shell scripts processed.");
}

main().catch(err => { error(err.message || String(err)); });