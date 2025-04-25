#!/usr/bin/env bash
set -e

# 1) fetch upstream
git fetch upstream
git checkout -B upstream-sync upstream/main
git reset --hard upstream/main

# 2) reapply AST transform
npx jscodeshift -t codemods/insert-pluginloader.js frontend/src/index.tsx

# 3) programmatically update package.jsons
node scripts/update-packagejson.js

# 4) commit changes
git add frontend/src/index.tsx package.json api/app/package.json frontend/package.json
git commit -m "chore: reapply PluginLoader + bump package deps automatically"

# 5) merge and push
git checkout main
git merge --no-ff upstream-sync -m "chore: bump upstream + reapply plugin runtime"
git push origin main --force