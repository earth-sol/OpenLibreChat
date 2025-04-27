#!/usr/bin/env bun
/**
 * scripts/update-env.js
 * --------------------------------
 * Bun-native CLI to update .env files based on Bun.env values.
 * - Supports multiple input .env files.
 * - Auto-detects `.env*` if none provided.
 * - Strict mode (fail on missing env), dry-run, JSON output, fallback defaults.
 * - Safe atomic writes.
 * - Uses only Bun Core APIs (Bun.file, Bun.write, Bun.Glob, Bun.spawnSync).
 * - Pure JavaScript + JSDoc.
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
 * Checks if an executable exists in PATH.
 * @param {string} name
 * @returns {boolean}
 */
function checkExecutable(name) {
  const r = Bun.spawnSync(["which", name], { stdout: "ignore", stderr: "ignore" });
  return r.exitCode === 0;
}

/**
 * Parses CLI arguments.
 * @param {string[]} args
 * @returns {{ options: Record<string,string>, positional: string[] }}
 */
function parseArgs(args) {
  const options = {};
  const positional = [];
  for (const arg of args) {
    if (arg === "--strict") {
      options.strict = "true";
    } else if (arg === "--dry-run") {
      options.dryRun = "true";
    } else if (arg === "--json") {
      options.json = "true";
    } else if (arg.startsWith("--fallback=")) {
      options.fallback = arg.split("=")[1] ?? "";
    } else {
      positional.push(arg);
    }
  }
  return { options, positional };
}

/**
 * Finds all `.env*` files in the project root.
 * @returns {Promise<string[]>}
 */
async function findEnvFiles() {
  const glob = new Bun.Glob(".env*");
  const matches = await glob.scan({ cwd: Bun.env.PWD || ".", absolute: true });
  return matches;
}

/**
 * Reads an env file and returns its lines.
 * @param {string} path
 * @returns {Promise<string[]>}
 */
async function readEnvFile(path) {
  return (await Bun.file(path).text()).split(/\r?\n/);
}

/**
 * Writes lines to a file atomically.
 * @param {string} outPath
 * @param {string[]} lines
 */
async function writeEnvFile(outPath, lines) {
  const tmpdir = Bun.env.TMPDIR || "/tmp";
  const tmpPath = `${tmpdir}/update-env-${Date.now()}.tmp`;
  await Bun.write(tmpPath, lines.join("\n"));
  await Bun.write(outPath, await Bun.file(tmpPath).text());
}

/**
 * Main entrypoint.
 */
async function main() {
  // Ensure Bun present
  if (!checkExecutable("bun")) {
    error("Bun is not installed. Install from https://bun.sh/");
  }
  const bunVer = Bun.spawnSync(["bun", "--version"], { stdout: "pipe" })
    .stdout.toString().trim();
  print(`Bun version: ${bunVer}`);

  const { options, positional } = parseArgs(Bun.argv.slice(2));
  const outputPath = positional[0];
  let inputPaths = positional.slice(1);

  if (!outputPath) {
    error("Usage: bun scripts/update-env.js <output.env> [input.env ...] [--strict] [--dry-run] [--json] [--fallback=value]");
  }

  if (inputPaths.length === 0) {
    print("No input files provided; auto-detecting .env* files...");
    inputPaths = await findEnvFiles();
    if (inputPaths.length === 0) {
      error("No .env* files found for input.");
    }
    print(`Detected ${inputPaths.length} env files: ${inputPaths.join(", ")}`);
  }

  const strict = options.strict === "true";
  const dryRun = options.dryRun === "true";
  const jsonOut = options.json === "true";
  const fallbackDefault = options.fallback ?? "";

  // Read and merge all lines
  const merged = [];
  for (const path of inputPaths) {
    if (!(await Bun.file(path).exists())) {
      warn(`Skipping missing input file: ${path}`);
      continue;
    }
    merged.push(...await readEnvFile(path));
  }

  const updatedLines = [];
  const updates = [];
  const missing = [];

  for (const line of merged) {
    const m = line.match(/^\s*([A-Z0-9_]+)=GET_FROM_LOCAL_ENV\s*$/);
    if (m) {
      const key = m[1];
      const val = Bun.env[key];
      if (val !== undefined) {
        updatedLines.push(`${key}=${val}`);
        updates.push({ key, from: "GET_FROM_LOCAL_ENV", to: val });
      } else if (fallbackDefault) {
        updatedLines.push(`${key}=${fallbackDefault}`);
        updates.push({ key, from: "GET_FROM_LOCAL_ENV", to: fallbackDefault });
      } else {
        missing.push(key);
        updatedLines.push(line);
      }
    } else {
      updatedLines.push(line);
    }
  }

  if (missing.length && strict) {
    missing.forEach(k => warn(`Missing Bun.env[${k}] and strict mode ON.`));
    error("Aborting due to missing environment variables.");
  } else if (missing.length) {
    missing.forEach(k => warn(`Missing Bun.env[${k}], left unchanged.`));
  }

  if (dryRun) {
    if (jsonOut) {
      console.log(JSON.stringify(updates, null, 2));
    } else {
      console.log(updatedLines.join("\n"));
    }
    return;
  }

  // Write final output atomically
  await writeEnvFile(outputPath, updatedLines);

  if (jsonOut) {
    console.log(JSON.stringify(updates, null, 2));
  } else {
    if (updates.length) {
      success(`Updated variables: ${updates.map(u => u.key).join(", ")}`);
    }
    success(`Wrote updated env to: ${outputPath}`);
  }
}

main().catch(e => error(e.message || String(e)));