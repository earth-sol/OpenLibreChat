#!/usr/bin/env bash
set -e
git remote add upstream https://github.com/danny-avila/LibreChat.git
# 1) Fetch & reset to upstream
git fetch upstream
git checkout -B upstream-sync upstream/main
git reset --hard upstream/main

# 2) Reapply AST transform (inject PluginLoader)
npx jscodeshift -t codemods/insert-pluginloader.js frontend/src/index.tsx
npx jscodeshift -t codemods/insert-pluginserver.js api/app/index.ts

# 3) Programmatically add/update deps in package.jsons
node scripts/update-packagejson.js

# 4) Install dependencies and update lockfiles
npm install                         # root: jscodeshift
npm install --prefix api/app        # api/app: express
npm install --prefix frontend       # frontend: opentelemetry + existing deps

# 5) Stage ALL changes
git add .

# 6) Commit & merge
git commit -m "chore: reapply plugin runtime + bump deps & lockfiles"
git checkout main
git merge --no-ff upstream-sync -m "chore: bump upstream + reapply plugin framework"

# 7) Push update of fork
git push origin main --force

echo "✅ Fork synced and all modifications applied."
