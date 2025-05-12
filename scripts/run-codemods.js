#!/usr/bin/env bun

// ─── CLI FLAGS ────────────────────────────────────────────────────────────────
const args   = Bun.argv.slice(1);
const dryRun = args.includes("--dry-run") || args.includes("--dry");
const quiet  = args.includes("--quiet")    || args.includes("--silent");
const help   = args.includes("-h")         || args.includes("--help");

if (help) {
  console.log(`
Usage: run-codemods.js [options]

Options:
  --dry-run, --dry    Preview without running codemods
  --quiet, --silent   Suppress all output
  -h, --help          Show this help
`);
  Bun.exit(0);
}

const log   = (...m) => { if (!quiet) console.log(...m) };
const error = (...m) => console.error(...m);

// ─── PROJECT & CODEMODS DIRECTORY ─────────────────────────────────────────────
const projectRoot   = Bun.fileURLToPath(new URL("..", import.meta.url));
const codemodsDirUrl = new URL("../codemods/", import.meta.url);

// ─── ORDERED TRANSFORMS ────────────────────────────────────────────────────────
const transforms = [
  // Core syntax & TS
  "transform-require-to-import.js",
  "transform-tsconfig.js",

  // Server (middleware, routes, controllers, telemetry, DB utils)
  "transform-security-middleware.js",
  "transform-session-auth.js",
  "transform-websockets.js",
  "transform-middleware.js",
  "transform-express-routes-to-elysia.js",
  "transform-controllers.js",
  "transform-telemetry.js",
  "transform-db-utils.js",
  "transform-server-index.js",

  // Env & scripts
  "transform-env-access.js",
  "transform-config-scripts.js",
  "transform-package-json.js",

  // CI / Docker / Helm
  "transform-ci-config.js",
  "transform-dockerfile.js",
  "transform-docker-compose.js",
  "transform-docker-scripts.js",
  "transform-helm-values.js",

  // Testing & E2E
  "transform-jest-config.js",
  "transform-e2e-tests.js",

  // Lint & format
  "transform-eslint-config.js",
  "transform-prettier-config.js",

  // Dev tooling
  "transform-devcontainer.js",
  "transform-husky.js",

  // Client HTML
  "transform-client-html.js"
];

// ─── MAIN ─────────────────────────────────────────────────────────────────────
let total = 0, failed = 0;

for (const scriptName of transforms) {
  total++;
  const scriptUrl  = new URL(`./${scriptName}`, codemodsDirUrl);
  const scriptPath = Bun.fileURLToPath(scriptUrl);

  // check existence
  let exists = true;
  try {
    await Bun.stat(scriptPath);
  } catch {
    log(`⚠ skip [${total}/${transforms.length}] ${scriptName} (not found)`);
    continue;
  }

  log(`→ [${total}/${transforms.length}] ${scriptName}`);

  if (dryRun) {
    log(`   (dry-run) would run: bun ${scriptPath.replace(`${projectRoot}/`, "")}`);
    continue;
  }

  // spawn the codemod
  const proc = Bun.spawn({
    cmd: ["bun", scriptPath],
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  // await its completion
  const { exitCode } = await proc.exited;
  const out = await proc.stdout.text();
  const err = await proc.stderr.text();

  if (exitCode !== 0) {
    error(`❌  ${scriptName} failed (exit ${exitCode})`);
    if (out) error(out.trim());
    if (err) error(err.trim());
    failed++;
  } else {
    log(`   ✔ success`);
    if (!quiet && out.trim())  console.log(out.trim());
    if (!quiet && err.trim())  console.error(err.trim());
  }
}

log(`\n✔ run-codemods: complete (total=${total}, failed=${failed})`);
if (failed > 0) Bun.exit(1);