#!/usr/bin/env bash
set -e

# 1) Fetch & reset to upstream
git fetch upstream
git checkout -B upstream-sync upstream/main
git reset --hard upstream/main

# 2) Reapply AST transform (inject PluginLoader)
npx jscodeshift -t codemods/insert-pluginloader.js frontend/src/index.tsx

# 3) Programmatically add/update deps in package.jsons
node scripts/update-packagejson.js

# 4) Install dependencies and update lockfiles
npm install                         # root: jscodeshift
npm install --prefix api/app        # api/app: express
npm install --prefix frontend       # frontend: opentelemetry + existing deps

# 5) Stage ALL changes (code, package.jsons & lockfiles)
git add frontend/src/index.tsx
git add package.json package-lock.json
git add api/app/package.json api/app/package-lock.json
git add frontend/package.json frontend/package-lock.json

# 6) Commit & merge
git commit -m "chore: reapply PluginLoader + bump deps & lockfiles"
git checkout main
git merge --no-ff upstream-sync -m "chore: bump upstream + reapply plugin runtime"

# 7) Push to your fork
git push origin main --force

echo "✅ Sync complete!"