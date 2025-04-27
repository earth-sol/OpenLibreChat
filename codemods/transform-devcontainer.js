#!/usr/bin/env bun
/**
 * transform-devcontainer.js
 *
 * A Bun-native script to update .devcontainer/devcontainer.json:
 *  - Ensure forwardPorts includes 3080 & 3090
 *  - Set postCreateCommand to "bun install"
 *  - Add ms-vscode.vscode-typescript-tslint-plugin to customizations.vscode.extensions
 *  - Preserve all other properties
 *
 * Usage:
 *   bun codemods/transform-devcontainer.js [path/to/devcontainer.json]
 *
 * Defaults:
 *   path = "./.devcontainer/devcontainer.json"
 *
 * Debug logging enabled by default; disable with DEBUG_LOGGING=false or --quiet.
 */

const USAGE = `
Usage: bun transform-devcontainer.js [path/to/devcontainer.json]

  If no path is provided, defaults to "./.devcontainer/devcontainer.json".
  Enable/disable debug logs via DEBUG_LOGGING env (true/false) or --quiet flag.
`;

(async () => {
  try {
    const args = process.argv.slice(2);
    if (args.includes('-h') || args.includes('--help')) {
      console.log(USAGE.trim());
      return;
    }

    const QUIET = args.includes('--quiet') || Bun.env.DEBUG_LOGGING === 'false';
    const log = (...msgs) => !QUIET && console.log('[devcontainer]', ...msgs);
    const warn = (...msgs) => console.warn('[devcontainer WARN]', ...msgs);

    // Determine file path
    const rawPath = args[0] || new URL('../.devcontainer/devcontainer.json', import.meta.url).pathname;
    const fileUrl = rawPath.startsWith('file://') ? new URL(rawPath) : new URL(`file://${Bun.pathToFileURL(rawPath)}`);
    const filePath = Bun.fileURLToPath(fileUrl);

    log('▶ Target file:', filePath);

    // Read & parse
    let json;
    try {
      const text = await (await Bun.file(fileUrl)).text();
      json = JSON.parse(text);
    } catch (err) {
      warn('Cannot read or parse JSON:', err.message);
      return;
    }

    // 1) forwardPorts
    const NEED_PORTS = [3080, 3090];
    if (!Array.isArray(json.forwardPorts)) {
      log('Adding forwardPorts →', NEED_PORTS);
      json.forwardPorts = NEED_PORTS.slice();
    } else {
      const ports = new Set(json.forwardPorts);
      NEED_PORTS.forEach((p) => {
        if (!ports.has(p)) {
          log(`➕ Including port ${p}`);
          ports.add(p);
        }
      });
      json.forwardPorts = Array.from(ports).sort((a, b) => a - b);
    }

    // 2) postCreateCommand
    const CMD = 'bun install';
    if (json.postCreateCommand !== CMD) {
      log('Setting postCreateCommand →', CMD);
      json.postCreateCommand = CMD;
    }

    // 3) customizations.vscode.extensions
    const EXT = 'ms-vscode.vscode-typescript-tslint-plugin';
    json.customizations ??= {};
    json.customizations.vscode ??= {};
    if (!Array.isArray(json.customizations.vscode.extensions)) {
      log('Initializing extensions with →', [EXT]);
      json.customizations.vscode.extensions = [EXT];
    } else if (!json.customizations.vscode.extensions.includes(EXT)) {
      log(`➕ Adding extension → ${EXT}`);
      json.customizations.vscode.extensions.push(EXT);
    }

    // 4) Preserve other keys (workspaceFolder, features, remoteUser, etc.)
    log('✅ All other keys preserved');

    // Write back
    const out = JSON.stringify(json, null, 2) + '\n';
    await Bun.write(filePath, out);
    log('✔ Updated', filePath);
  } catch (fatal) {
    console.error('[devcontainer FATAL]', fatal);
    process.exit(1);
  }
})();