#!/usr/bin/env bash
set -euox pipefail

# Ensure upstream remote exists
if ! git remote get-url upstream > /dev/null 2>&1; then
  git remote add upstream https://github.com/danny-avila/LibreChat.git
fi

# Configure Git identity
git config user.name "github-actions"
git config user.email "actions@github.com"

# Pre-merge: idempotently protect custom dirs via merge=ours
touch .gitattributes
_append_if_missing() {
  grep -qxF "$1" .gitattributes || echo "$1" >> .gitattributes
}
_append_if_missing "client/src/plugin-runtime/** merge=ours"
_append_if_missing "plugins/**                   merge=ours"
_append_if_missing "scripts/**                   merge=ours"
_append_if_missing "codemods/**                  merge=ours"
git config merge.ours.driver true
git add .gitattributes
git commit -m "chore: protect custom folders via merge=ours (pre-merge)" \
  || echo "✅ .gitattributes up-to-date"

# Fetch & merge upstream/main
git fetch upstream main
git checkout main
git pull --ff-only origin main
git merge upstream/main -m "chore: merge upstream/main into fork"

# Post-merge: re-apply protection (idempotent)
touch .gitattributes
_append_if_missing "client/src/plugin-runtime/** merge=ours"
_append_if_missing "plugins/**                   merge=ours"
_append_if_missing "scripts/**                   merge=ours"
_append_if_missing "codemods/**                  merge=ours"
git config merge.ours.driver true
git add .gitattributes
git commit -m "chore: protect custom folders via merge=ours (post-merge)" \
  || echo "✅ .gitattributes intact"

# Bump deps before install
bun run scripts/update-packagejson.js

# Install root deps (including jscodeshift)
bun install --frozen-lockfile

# Apply codemods
bun run jscodeshift \
  -t codemods/insert-pluginloader.js \
  --parser=tsx --extensions=tsx,ts client/src/main.jsx

bun run jscodeshift \
  -t codemods/insert-pluginloader-html.js \
  --parser=none --extensions=html client/index.html

bun run jscodeshift \
  -t codemods/insert-vite-config.js \
  --parser=tsx --extensions=ts,tsx client/vite.config.ts

bun run jscodeshift \
  -t codemods/inline-pluginserver-elysia.js \
  --parser=tsx --extensions=ts,tsx api/app/index.ts

bun run jscodeshift \
  -t codemods/replace-fs-with-bun-io.js \
  --parser=tsx --extensions=ts,tsx .

# Install workspace deps
echo "⏳ installing api/app deps"
bun install --cwd api/app --production
echo "✅ api/app deps installed"
echo "⏳ installing api/app deps"
bun install --cwd client  --production
echo "✅ client deps installed"

# Stage all changes
git add \
  .gitattributes \
  client/src/main.jsx client/index.html client/vite.config.ts \
  api/app/index.js \
  package.json package-lock.json \
  api/app/package.json api/app/package-lock.json \
  client/package.json client/package-lock.json \
  codemods scripts
echo "✅ all changes staged"

# 1️⃣1️⃣ Final commit & push
git commit -m "chore: reapply plugin framework + bump deps & lockfiles" \
  || echo "✅ nothing to commit"

git push origin main --force
echo "🎉 Sync complete."