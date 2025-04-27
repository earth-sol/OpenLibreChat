#!/usr/bin/env bun
/**
 * scripts/docker-push.js
 * --------------------------------
 * Bun-native CLI to push Docker images for LibreChat.
 * - Validates Bun and Docker installation.
 * - Prints Bun and Docker versions.
 * - Dynamic tag and registry.
 * - Manifest inspection and optional cosign signing.
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
 * Check if an executable is in PATH.
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
    if (arg.startsWith("--tag=")) {
      options.tag = arg.split("=")[1];
    } else if (arg.startsWith("--registry=")) {
      options.registry = arg.split("=")[1];
    } else {
      positional.push(arg);
    }
  }
  return { options, positional };
}

async function main() {
  // Validate Bun and Docker
  if (!checkExecutable("bun")) {
    error("Bun is not installed. Install from https://bun.sh/");
  }
  if (!checkExecutable("docker")) {
    error("Docker CLI is not installed. Please install Docker.");
  }

  // Print versions
  const bunVer = Bun.spawnSync(["bun", "--version"], { stdout: "pipe" }).stdout.toString().trim();
  const dockerVer = Bun.spawnSync(["docker", "--version"], { stdout: "pipe" }).stdout.toString().trim();
  print(`Bun version: ${bunVer}`);
  print(`Docker version: ${dockerVer}`);

  const { options } = parseArgs(Bun.argv.slice(2));
  const TAG = options.tag || Bun.env.LIBRE_CHAT_DOCKER_TAG || "latest";
  const REGISTRY = options.registry || Bun.env.DOCKER_REMOTE_REGISTRY;
  if (!REGISTRY) {
    error("Remote registry not specified. Use --registry or set DOCKER_REMOTE_REGISTRY.");
  }

  const LOCAL_IMAGE = `librechat:${TAG}`;
  const REMOTE_IMAGE = `${REGISTRY}/librechat:${TAG}`;
  print(`Local image: ${LOCAL_IMAGE}`);
  print(`Remote image: ${REMOTE_IMAGE}`);

  // Tag the image
  print("Tagging image...");
  let result = Bun.spawnSync(["docker", "tag", LOCAL_IMAGE, REMOTE_IMAGE], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) error("docker tag failed.");

  // Push the image
  print("Pushing image...");
  result = Bun.spawnSync(["docker", "push", REMOTE_IMAGE], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) error("docker push failed.");

  // Verify manifest
  print("Verifying image manifest...");
  result = Bun.spawnSync(["docker", "manifest", "inspect", REMOTE_IMAGE], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) error("Image manifest verification failed.");
  success("Remote image manifest verified.");

  // Optional cosign signing
  if (checkExecutable("cosign")) {
    const cosignVer = Bun.spawnSync(["cosign", "version"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
    print(`Cosign version: ${cosignVer}`);
    print("Signing image with cosign...");
    result = Bun.spawnSync(["cosign", "sign", REMOTE_IMAGE], { stdout: "inherit", stderr: "inherit" });
    if (result.exitCode !== 0) {
      warn("cosign sign failed; continuing without signature.");
    } else {
      success("Image signed successfully with cosign.");
    }
  } else {
    warn("cosign not found; skipping signing.");
  }

  success(`Image push and verification complete: ${REMOTE_IMAGE}`);
}

main().catch(err => error(err.message || String(err)));