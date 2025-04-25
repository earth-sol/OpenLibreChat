#!/usr/bin/env bash

git remote add upstream https://github.com/danny-avila/LibreChat.git

# 1️⃣ Fetch upstream
echo "🔄 Fetching upstream/main…"
git fetch upstream main

# 2️⃣ Checkout your main and bring it up to date
echo "🔀 Checking out your main branch…"
git checkout main
git pull --ff-only origin main

# 3️⃣ Merge upstream/main into your main
echo "🔀 Merging upstream/main…"
git merge upstream/main -m "chore: merge upstream/main into fork"

# 4️⃣ Reapply AST transforms (codemods)
echo "🛠️  Reapplying codemods…"
npx jscodeshift -t codemods/insert-pluginloader.js frontend/src/index.tsx
npx jscodeshift -t codemods/insert-pluginserver.js api/app/index.ts

# 5️⃣ Programmatically bump package.jsons
echo "📦 Updating package.json dependencies…"
node scripts/update-packagejson.js

# 6️⃣ Clean install in each workspace
echo "⚙️  Installing dependencies…"
npm ci
npm ci --prefix api/app
npm ci --prefix frontend

# 7️⃣ Stage only the files we expect to change
echo "✅ Staging changes…"
git add \
  frontend/src/index.tsx \
  api/app/index.ts \
  package.json package-lock.json \
  api/app/package.json api/app/package-lock.json \
  frontend/package.json frontend/package-lock.json

# 8️⃣ Commit codemod + dep bumps + lockfiles
echo "📝 Committing changes…"
git commit -m "chore: reapply plugin framework + bump deps & lockfiles"

# 9️⃣ Push back to your fork
echo "🚀 Pushing to origin/main…"
git push origin main --force

echo "🎉 Sync complete!"