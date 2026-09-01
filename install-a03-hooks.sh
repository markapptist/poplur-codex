#!/bin/bash
# Install the A03 pre-push hook into every Poplur repo. Re-runnable: an existing
# hook that is not ours is left alone and reported, never overwritten.
set -uo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)/hooks/pre-push-a03"
for repo in poplur-clay-map Poplur2025-Android Poplur2025-iOS Poplur2025-ReactNative; do
  dir="/Users/matrix/Developer/$repo"
  [ -d "$dir/.git" ] || { printf '  %-24s no .git — skipped\n' "$repo"; continue; }
  dest="$dir/.git/hooks/pre-push"
  if [ -e "$dest" ] && ! grep -q "pre-push-a03\|profile-a03" "$dest" 2>/dev/null; then
    printf '  %-24s ALREADY HAS a different pre-push hook — left untouched\n' "$repo"
    continue
  fi
  cp "$SRC" "$dest" && chmod +x "$dest"
  printf '  %-24s installed\n' "$repo"
done
