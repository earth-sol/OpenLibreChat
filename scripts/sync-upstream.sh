#!/usr/bin/env bash
set -exuo pipefail   # ← note the added -x for debug tracing

echo "🔄 Fetching latest from upstream..."
git fetch upstream

echo "🔀 Checking out (or creating) branch upstream-sync..."
if git rev-parse --verify upstream-sync &>/dev/null; then
  git checkout upstream-sync
else
  git checkout -b upstream-sync
fi

echo "💥 Hard-resetting to upstream/main…"
git reset --hard upstream/main

echo "🛠️  Reapplying AST codemods…"
npx jscodeshift -t codemods/insert-pluginloader.js frontend/src/index.tsx
npx jscodeshift -t codemods/insert-pluginserver.js api/app/index.ts

echo "📦 Updating package.json deps…"
node scripts/update-packagejson.js

echo "⚙️  Installing dependencies (clean)…"
npm ci --verbose
npm ci --prefix api/app --verbose
npm ci --prefix frontend --verbose

echo "✅ Staging modifications…"
git add \
  frontend/src/index.tsx \
  api/app/index.ts \
  package.json package-lock.json \
  api/app/package.json api/app/package-lock.json \
  frontend/package.json frontend/package-lock.json \
  codemods/ scripts/

echo "📝 Committing changes…"
git commit -m "chore: reapply plugin runtime + bump deps & lockfiles"

echo "🔀 Merging into main…"
git checkout main
git pull --rebase origin main
git merge --no-ff upstream-sync -m "chore: bump upstream + reapply plugin framework"

echo "🚀 Pushing updated main…"
git push origin main --force

echo "🎉 Sync complete!"
