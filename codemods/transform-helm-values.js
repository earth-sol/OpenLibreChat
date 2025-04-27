#!/usr/bin/env bun

/**
 * codemods/transform-helm-values.js
 *
 * Pure Bun-native Helm values.yaml transformer:
 * - No Node built-ins or external parsers
 * - Uses Bun.scandir(), Bun.file().text(), Bun.write()
 * - Runs verbosely by default, logging every step
 *
 * Adjusts:
 *   image.repository → myregistry/librechat-bun
 *   image.tag        → "latest"
 *   service.port     → 3080
 *   command block    → ["bun","run","src/server/index.ts"]
 */

async function transform(filePath) {
  console.log("[DEBUG] Reading", filePath);
  let txt = await Bun.file(filePath).text();
  console.log("[DEBUG] Original content:\n", txt);

  // 1) Update image.repository
  txt = txt.replace(
    /^(\s*repository:).*/m,
    `$1 myregistry/librechat-bun`
  );
  console.log("[DEBUG] → repository set to myregistry/librechat-bun");

  // 2) Update image.tag
  txt = txt.replace(
    /^(\s*tag:).*/m,
    `$1 "latest"`
  );
  console.log("[DEBUG] → tag set to \"latest\"");

  // 3) Update service.port
  txt = txt.replace(
    /^(\s*port:).*/m,
    `$1 3080`
  );
  console.log("[DEBUG] → service.port set to 3080");

  // 4) Ensure top-level command block
  const cmdBlock =
`command:
  - bun
  - run
  - src/server/index.ts
`;
  if (/^command:/m.test(txt)) {
    // Replace existing command block
    txt = txt.replace(
      /^command:[\s\S]*?(?=^[^\s-]|$)/m,
      cmdBlock
    );
    console.log("[DEBUG] → Replaced existing command block");
  } else {
    // Append at end
    txt += "\n" + cmdBlock;
    console.log("[DEBUG] → Appended command block");
  }

  console.log("[DEBUG] Final content:\n", txt);
  await Bun.write(filePath, txt);
  console.log(`✅ Transformed ${filePath}`);
}

async function run() {
  console.log("[DEBUG] Scanning charts/librechat for values.yaml");
  let found = false;

  for await (const entry of Bun.scandir("charts/librechat")) {
    if (entry.isFile && entry.name === "values.yaml") {
      found = true;
      await transform(`charts/librechat/${entry.name}`);
    } else {
      console.log(`[DEBUG] Skipping ${entry.name} (${entry.isDirectory ? "dir" : "other"})`);
    }
  }

  if (!found) {
    console.error("❌ No charts/librechat/values.yaml found");
    process.exit(1);
  }
}

run().catch(err => {
  console.error("❌ Error in transform-helm-values.js:", err);
  process.exit(1);
});