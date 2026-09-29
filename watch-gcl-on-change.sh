#!/bin/zsh
set -eu

ROOT=/Users/matrix/Developer
STATE="$ROOT/.codex/gcl-watch-hashes"
LOCK=/tmp/com.poplur.gcl-change-sync.lock
# The ChatGPT app's 28 Sep 2026 update moved its bundled CLI here; the old
# Contents/Resources/codex binary no longer exists.
CODEX=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex

# --dry-run hashes and compares exactly like a real run, then prints the wake-up
# it would perform. It takes no lock, wakes nothing and records nothing.
DRY_RUN=false
[[ "${1:-}" == --dry-run ]] && DRY_RUN=true

stamp() { /bin/date -u '+%Y-%m-%dT%H:%M:%SZ'; }

if ! $DRY_RUN; then
  mkdir "$LOCK" 2>/dev/null || exit 0
  trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
fi

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
if $DRY_RUN; then
  trap '/bin/rm -f "$current"' EXIT
else
  trap '/bin/rm -f "$current"; rmdir "$LOCK" 2>/dev/null || true' EXIT
fi
/usr/bin/shasum -a 256 "$ROOT"/good-copy*.html > "$current"

if [[ ! -f "$STATE" ]]; then
  $DRY_RUN && { print "No $STATE yet; a real run would record the current hashes as the baseline."; exit 0; }
  /bin/cp "$current" "$STATE"
fi
changed=$(/usr/bin/diff "$STATE" "$current" | /usr/bin/sed -n 's|^[<>] [0-9a-f]*  .*/||p' | /usr/bin/sort -u | /usr/bin/paste -sd ' ' -)

# A fresh session instead of `exec resume <thread>`: the long-lived "Good copy"
# thread (019f4f6f-…) was deleted, which made every wake-up fail with "no rollout
# found". The procedure's state lives in gcl-sync-state.json, not in a thread.
wake=(
  "$CODEX" exec
  -C "$ROOT"
  -s danger-full-access
  --dangerously-bypass-approvals-and-sandbox
  "A filesystem watcher detected a stable content-hash change in /Users/matrix/Developer/good-copy*.html (changed: ${changed:-unknown}). Run the GCL Immediate Repo Sync procedure once: follow the prompt in /Users/matrix/.codex/automations/gcl-immediate-repo-sync/automation.toml (its PAUSED status only retires the old timer; this watcher now triggers it) with /Users/matrix/Developer/.codex/gcl-sync-state.json as its state. Do not open browser tabs."
)

if $DRY_RUN; then
  if [[ -x "$CODEX" ]]; then print "Codex CLI: $CODEX"; else print "Codex CLI missing: $CODEX"; fi
  if /usr/bin/cmp -s "$current" "$STATE"; then
    print "Good Copy matches the last successful wake-up; a real run would stay idle."
  else
    print "Changed since the last successful wake-up: $changed"
    print "A real run would execute:"
    print -r -- ${(qq)wake}
  fi
  exit 0
fi

/usr/bin/cmp -s "$current" "$STATE" && exit 0

if [[ ! -x "$CODEX" ]]; then
  print "[$(stamp)] GCL wake-up failed: no Codex CLI at $CODEX; gcl-watch-hashes left unchanged."
  exit 1
fi

print "[$(stamp)] Good Copy changed ($changed); waking Codex in a fresh exec session."
if "${wake[@]}" </dev/null; then
  # Record the hashes only once Codex has taken the change, so a failed wake-up
  # is retried rather than marked as handled.
  /bin/cp "$current" "$STATE"
  print "[$(stamp)] GCL wake-up finished; recorded the new Good Copy hashes."
else
  code=$?
  print "[$(stamp)] GCL wake-up failed (exit $code); gcl-watch-hashes left unchanged so the watcher retries."
  exit $code
fi
