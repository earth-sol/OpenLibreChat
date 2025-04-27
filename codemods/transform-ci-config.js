#!/usr/bin/env bun

// codemods/transform-ci-config.js
//
// Bun-native, AST-driven transformer for GitHub Actions workflow YAML files,
// with Bun handling all file I/O. Logs verbose debug output.
// Requires Bun ≥1.2.10 and the "yaml" package.
//
// Usage:
//   bun add -d yaml
//   bun run codemods/transform-ci-config.js

import YAML from "yaml";

const WORKFLOWS_DIR = ".github/workflows";

/**
 * Map a single shell line from npm → bun, preserving indentation.
 */
function transformRunLine(line) {
  const indentMatch = line.match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : "";
  const trimmed = line.trimStart();

  if (!trimmed.startsWith("npm")) {
    return line;
  }

  const parts = trimmed.split(/\s+/);
  let newCmd = trimmed;

  if (parts[1] === "ci") {
    newCmd = trimmed.replace(/^npm\s+ci\b/, "bun install");
  } else if (parts[1] === "install") {
    newCmd = trimmed.replace(/^npm\s+install\b/, "bun install");
  } else if (parts[1] === "run" && parts[2] === "build") {
    newCmd = trimmed.replace(/^npm\s+run\s+build\b/, "bun build");
  } else {
    newCmd = trimmed.replace(/^npm\b/, "bun");
  }

  return indent + newCmd;
}

async function transformCIConfigs() {
  console.log("[ci-codemod] Scanning directory:", WORKFLOWS_DIR);

  for await (const entry of Bun.scandir(WORKFLOWS_DIR)) {
    if (!entry.isFile) continue;
    if (!entry.name.match(/\.(ya?ml)$/)) continue;

    const filePath = `${WORKFLOWS_DIR}/${entry.name}`;
    console.log("\n[ci-codemod] Processing file:", filePath);

    const text = await Bun.file(filePath).text();
    const doc = YAML.parseDocument(text, {
      keepCstNodes: true,
      keepNodeTypes: true
    });

    let modified = false;
    const root = doc.contents;

    if (root && root.items) {
      // Locate the top-level `jobs:` mapping
      const jobsPair = root.items.find(p => p.key?.value === "jobs");
      if (jobsPair && jobsPair.value?.items) {
        for (const jobPair of jobsPair.value.items) {
          const jobName = jobPair.key.value;
          const jobMap  = jobPair.value;
          const stepsPair = jobMap.items.find(p => p.key?.value === "steps");
          if (!stepsPair || !stepsPair.value?.items) continue;

          stepsPair.value.items.forEach((stepItem, idx) => {
            if (stepItem.type !== "MAP") return;

            stepItem.items.forEach(prop => {
              // 1) Swap actions/setup-node → oven-sh/setup-bun
              if (
                prop.key.value === "uses" &&
                typeof prop.value.value === "string" &&
                prop.value.value.startsWith("actions/setup-node")
              ) {
                const oldVal = prop.value.value;
                prop.value.value = "oven-sh/setup-bun@v1";
                console.log(
                  `[DEBUG] ${filePath} [job=${jobName} step=${idx}] ` +
                  `uses: "${oldVal}" -> "${prop.value.value}"`
                );
                modified = true;
              }

              // 2) Transform npm commands in run: blocks
              if (
                prop.key.value === "run" &&
                typeof prop.value.value === "string"
              ) {
                const originalRun = prop.value.value;
                const newRun = originalRun
                  .split("\n")
                  .map(line => {
                    const mapped = transformRunLine(line);
                    if (mapped !== line) {
                      console.log(
                        `[DEBUG] ${filePath} [job=${jobName} step=${idx}] ` +
                        `run-line: "${line.trim()}" -> "${mapped.trim()}"`
                      );
                      modified = true;
                    }
                    return mapped;
                  })
                  .join("\n");

                if (newRun !== originalRun) {
                  prop.value.value = newRun;
                  console.log(
                    `[DEBUG] ${filePath} [job=${jobName} step=${idx}] updated run block`
                  );
                }
              }
            });
          });
        }
      }
    }

    if (modified) {
      await Bun.write(filePath, String(doc));
      console.log(`[ci-codomod] ✅ Updated ${filePath}`);
    } else {
      console.log(`[ci-codemod] ⚪ No changes in ${filePath}`);
    }
  }

  console.log("\n[ci-codemod] Done.");
}

await transformCIConfigs();