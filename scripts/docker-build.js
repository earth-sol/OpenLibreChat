#!/usr/bin/env bun
/**
 * scripts/docker-build.js
 * --------------------------------
 * Bun-native CLI to build Docker images for LibreChat.
 * - Validates Bun and Docker installation.
 * - Prints Bun and Docker versions.
 * - Dynamic tag, Dockerfile, context directory.
 * - Supports multiple --build-arg entries.
 * - Injects standard OCI-compliant labels.
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
function error(msg) {
  console.error(`❌ ${msg}`);
  Bun.exit(1);
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function checkExecutable(name) {
  const res = Bun.spawnSync(["which", name], { stdout: "ignore", stderr: "ignore" });
  return res.exitCode === 0;
}

/**
 * @param {string[]} args
 * @returns {{ options: Record<string,string|string[]>, positional: string[] }}
 */
function parseArgs(args) {
  const options = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--build-arg=")) {
      const val = arg.split("=")[1];
      options["build-arg"] = options["build-arg"] || [];
      options["build-arg"].push(val);
    } else if (arg === "--build-arg") {
      const val = args[++i];
      options["build-arg"] = options["build-arg"] || [];
      options["build-arg"].push(val);
    } else if (arg.startsWith("--tag=")) {
      options.tag = arg.split("=")[1];
    } else if (arg.startsWith("--dockerfile=")) {
      options.dockerfile = arg.split("=")[1];
    } else if (arg.startsWith("--context=")) {
      options.context = arg.split("=")[1];
    } else {
      positional.push(arg);
    }
  }

  return { options, positional };
}

async function main() {
  // Validate Bun and Docker
  if (!checkExecutable("bun")) {
    error("Bun is not installed. Please install Bun from https://bun.sh/");
  }
  if (!checkExecutable("docker")) {
    error("Docker CLI is not installed. Please install Docker to proceed.");
  }

  // Print versions
  const bunVer = Bun.spawnSync(["bun", "--version"], { stdout: "pipe" }).stdout.toString().trim();
  const dockerVer = Bun.spawnSync(["docker", "--version"], { stdout: "pipe" }).stdout.toString().trim();
  print(`Bun version: ${bunVer}`);
  print(`Docker version: ${dockerVer}`);

  // Parse arguments
  const { options, positional } = parseArgs(Bun.argv.slice(2));

  const TAG = options.tag || Bun.env.LIBRE_CHAT_DOCKER_TAG || "latest";
  const DOCKERFILE = options.dockerfile || "Dockerfile";
  const CONTEXT_DIR = options.context || positional[0] || ".";
  const BUILD_ARGS = Array.isArray(options["build-arg"]) ? options["build-arg"] : [];

  print(`Using tag: ${TAG}`);
  print(`Using Dockerfile: ${DOCKERFILE}`);
  print(`Using context directory: ${CONTEXT_DIR}`);

  // Check file existence
  if (!(await Bun.file(DOCKERFILE).exists())) {
    error(`Dockerfile not found at path: ${DOCKERFILE}`);
  }
  if (!(await Bun.file(CONTEXT_DIR).exists())) {
    error(`Context directory not found: ${CONTEXT_DIR}`);
  }

  const localImage = `librechat:${TAG}`;
  print(`Building Docker image: ${localImage}`);

  // Prepare OCI labels
  const buildDate = new Date().toISOString();
  const labels = [
    `org.opencontainers.image.created=${buildDate}`,
    `org.opencontainers.image.version=${TAG}`,
    `org.opencontainers.image.source=https://github.com/your-org/librechat`
  ];

  // Assemble Docker build command
  const cmd = [
    "docker", "build",
    "-f", DOCKERFILE,
    "-t", localImage
  ];

  for (const label of labels) {
    cmd.push("--label", label);
  }
  for (const arg of BUILD_ARGS) {
    cmd.push("--build-arg", arg);
  }
  cmd.push(CONTEXT_DIR);

  print(`OCI labels: ${labels.join(", ")}`);
  if (BUILD_ARGS.length) {
    print(`Build args: ${BUILD_ARGS.join(", ")}`);
  }

  // Execute build
  const result = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    error("Docker build failed.");
  }

  success(`Docker image built successfully: ${localImage}`);
}

main().catch(err => error(err.message || String(err)));