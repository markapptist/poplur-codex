#!/bin/zsh
set -eu

ROOT=/Users/matrix/Developer
STATE="$ROOT/.codex/gcl-watch-hashes"
LOCK=/tmp/com.poplur.gcl-change-sync.lock
CODEX=/Applications/ChatGPT.app/Contents/Resources/codex
THREAD=019f4f6f-a064-7ce3-b8c9-01f716b29481

mkdir "$LOCK" 2>/dev/null || exit 0
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

# Wait until every canonical file has been stable for at least 30 seconds.
while true; do
  now=$(/bin/date +%s)
  recent=0
  for file in "$ROOT"/good-copy*.html; do
    [[ -e "$file" ]] || continue
    modified=$(/usr/bin/stat -f %m "$file")
    if (( now - modified < 30 )); then
      recent=1
      break
    fi
  done
  (( recent == 0 )) && break
  /bin/sleep 5
done

current=$(/usr/bin/mktemp /tmp/gcl-watch-current.XXXXXX)
trap '/bin/rm -f "$current"; rmdir "$LOCK" 2>/dev/null || true' EXIT
/usr/bin/shasum -a 256 "$ROOT"/good-copy*.html > "$current"

[[ -f "$STATE" ]] || /bin/cp "$current" "$STATE"
/usr/bin/cmp -s "$current" "$STATE" && exit 0

# Record the observed hashes before waking Codex so repeated filesystem events
# cannot create duplicate runs for the same canonical content.
/bin/cp "$current" "$STATE"

"$CODEX" exec \
  -C "$ROOT" \
  -s danger-full-access \
  --dangerously-bypass-approvals-and-sandbox \
  resume "$THREAD" \
  "A filesystem watcher detected a stable content-hash change in /Users/matrix/Developer/good-copy*.html. Run the GCL Immediate Repo Sync procedure once using /Users/matrix/.codex/automations/gcl-immediate-repo-sync/automation.toml and /Users/matrix/Developer/.codex/gcl-sync-state.json. Do not open browser tabs."
