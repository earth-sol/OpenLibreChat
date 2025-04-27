#!/usr/bin/env bash
set -euox pipefail

# Configure Git identity
git config user.name "github-actions"
git config user.email "actions@github.com"

# Ensure upstream remote exists
echo "⏳ Ensure upstream remote exists"
if git remote | grep -q '^upstream$'; then
  echo "✅ upstream already exists, skipping add."
else
  echo "➕ upstream missing, adding now…"
  git remote add upstream https://github.com/danny-avila/LibreChat.git
fi

# Defining protectedForkPaths
protectedForkPaths=(
  "client/src/plugin-runtime"
  "plugins"
  "scripts"
  "codemods"
  ".bun-version"
  "README.md"
  ".github/workflows/sync-upstream.yml"
  "config/config.json"
)

# 🔒 Stashing protected files

tmp=$(mktemp -d)
for path in "${protectedForkPaths[@]}"; do
  if [ -e "$path" ]; then
    mkdir -p "$tmp/$(dirname "$path")"
    cp -R "$path" "$tmp/$path"
    echo "  • $path"
  fi
done

# 📡 Fetching upstream and resetting to pristine state

git fetch upstream main
git checkout main
git reset --hard upstream/main
git clean -fdx

# 🗑️ Cleaning up JS lockfiles

find . -maxdepth 4 -type f \( -name 'package-lock.json' -o -name 'yarn.lock' -o -name 'pnpm-lock.yaml' -o -name 'bun.lockb' \) -print -exec rm -f {} +

# 🔍 Checking for any upstream-provided protected paths

upstream_changed=false
for path in "${protectedForkPaths[@]}"; do
  if [ -e "$path" ]; then
    echo "⚠️  Upstream introduced protected path: $path"
    upstream_changed=true
  fi
done 
if ! $upstream_changed; then
  echo "✅ No upstream changes detected in protected paths."
fi

# 🔄 Restoring protected files from stash

for path in "${protectedForkPaths[@]}"; do
  # remove whatever upstream put there (if anything)
  rm -rf "$path"
  # restore from our stash
  if [ -e "$tmp/$path" ]; then
    mkdir -p "$(dirname "$path")"
    cp -R "$tmp/$path" "$path"
    echo "   • Restored $path"
  else
    echo "   • ⚠️  Missing in stash (was not a protected file?): $path"
  fi
done
# 🗑️ clean up temp stash
rm -rf "$tmp"

# Stage all changes
echo "⏳ Stage all changes"
git add .
echo "✅ all changes staged"

# 💾 Commit & push
echo "⏳ Final commit"
git commit -m "chore: sync from upstream" \
  || echo "✅ nothing to commit"
echo "⏳ Final push"
git push origin main --force
echo "🎉 Sync complete."
