#!/usr/bin/env bash
# Sync content from Notion and open a pull request.
# Usage: npm run sync:pr   (or ./scripts/sync-pr.sh)
set -euo pipefail

cd "$(dirname "$0")/.."

branch="notion-sync/$(date -u +%Y%m%d-%H%M%S)"
base="${BASE_BRANCH:-main}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree not clean. Commit or stash your changes first." >&2
  exit 1
fi

echo "→ Pulling latest from origin/$base…"
git fetch origin "$base" --quiet
git checkout "$base" --quiet
git pull --ff-only origin "$base" --quiet

echo "→ Syncing from Notion…"
npm run --silent sync

if [[ -z "$(git status --porcelain -- content static)" ]]; then
  echo "No content changes — nothing to publish."
  exit 0
fi

git checkout -b "$branch"
git add content static
git commit -m "content: sync posts from Notion"
git push -u origin "$branch"

gh pr create \
  --base "$base" \
  --head "$branch" \
  --title "Sync posts from Notion" \
  --body "Automated content sync from Notion. Review the new/updated posts, then merge to publish."

echo "✓ Pull request opened for $branch"
