#!/bin/bash
# Capture screen renders whenever origin/main moves, so drift is caught against the
# GCL prototype instead of being discovered weeks later on a device.
#
# WHAT THIS DOES AND DOES NOT DO
# ------------------------------
# It builds, installs and CAPTURES. It does not decide whether a screen matches.
# Automatic pixel verdicts were attempted on 2026-07-17 and measurably failed to
# separate the known-bad Welcome from the known-good (0.1054 vs 0.1029), because Good
# Copy stores only backdrop assets, not full-screen references. So this leaves a
# capture + a REVIEW-PENDING marker; a Claude session (or a scheduled agent) looks at
# the images and rules. The `claude` CLI is not on PATH here, so the review cannot be
# driven from this script.
#
# Cost: a full Android build is ~8 min and iOS ~5 min, so a push-triggered run is not
# free. POLL_SECONDS throttles how often we check, not how long a build takes.
#
# Usage:
#   .codex/watch-main-parity.sh          # poll forever
#   .codex/watch-main-parity.sh --once   # single check, for cron/manual use
set -uo pipefail

ROOT=/Users/matrix/Developer
STATE="$ROOT/.codex/main-parity-state.json"
INBOX="$ROOT/.codex/parity-review-inbox"
LOG="$ROOT/.codex/main-parity.log"
LOCK=/tmp/com.poplur.main-parity.lock
POLL_SECONDS=${POLL_SECONDS:-120}
SDK=/Users/matrix/Library/Android/sdk
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$SDK"

mkdir "$LOCK" 2>/dev/null || { echo "already running"; exit 0; }
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
mkdir -p "$INBOX"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }

sha_of() { git -C "$ROOT/$1" rev-parse origin/main 2>/dev/null; }

check_repo() {
  local repo="$1" prev="$2"
  git -C "$ROOT/$repo" fetch origin --quiet 2>/dev/null
  local now; now=$(sha_of "$repo")
  [ -z "$now" ] && { log "$repo: cannot resolve origin/main; skipping"; return 1; }
  [ "$now" = "$prev" ] && return 1
  log "$repo: origin/main moved $prev -> $now"
  echo "$now"
  return 0
}

# Build Android from origin/main in a disposable worktree and capture the screens.
# A fresh worktree has no local.properties (gitignored) — write it or the build dies
# instantly with "SDK location not found".
run_android() {
  local sha="$1"
  local wt="$ROOT/.codex-worktrees/parity-android-$sha"
  rm -rf "$wt"; git -C "$ROOT/Poplur2025-Android" worktree prune 2>/dev/null
  git -C "$ROOT/Poplur2025-Android" worktree add --detach "$wt" "$sha" --quiet 2>/dev/null || { log "android: worktree add failed"; return 1; }
  echo "sdk.dir=$SDK" > "$wt/local.properties"

  log "android: building $sha (~8 min)"
  touch "$INBOX/.build-start-$sha"   # marker: anything newer than this is ours
  ( cd "$wt" && ./gradlew :app:assembleDebug --no-configuration-cache -x lint >"$INBOX/android-build-$sha.log" 2>&1 )
  local rc=$?
  if [ $rc -ne 0 ]; then
    log "android: BUILD FAILED (gradle exit $rc) — see $INBOX/android-build-$sha.log"
    git -C "$ROOT/Poplur2025-Android" worktree remove --force "$wt" 2>/dev/null
    return 1
  fi

  # The build dir is SHARED across worktrees (settings.gradle.kts:31 -> /private/tmp/
  # poplur-android-build/app), so an APK sitting there may belong to another branch.
  #
  # Do NOT compare the APK's mtime against the build log: Gradle keeps writing the log
  # AFTER packaging the APK, so a legitimate APK is always slightly OLDER than its own
  # log (measured: apk 08:06:35, log 08:06:39). That check rejects every real build.
  #
  # Use a marker dropped before the build starts: any APK newer than the marker was
  # produced by this run.
  local apk=/private/tmp/poplur-android-build/app/outputs/apk/debug/app-debug.apk
  if [ ! -f "$apk" ] || [ ! "$apk" -nt "$INBOX/.build-start-$sha" ]; then
    log "android: no APK newer than this run's start marker — shared build dir may hold another branch's output; refusing to install"
    git -C "$ROOT/Poplur2025-Android" worktree remove --force "$wt" 2>/dev/null
    return 1
  fi

  local serial; serial=$("$SDK/platform-tools/adb" devices | awk '/\tdevice$/{print $1; exit}')
  if [ -z "$serial" ]; then
    log "android: no device attached — captured nothing (NOT a pass)"
    git -C "$ROOT/Poplur2025-Android" worktree remove --force "$wt" 2>/dev/null
    return 1
  fi
  "$SDK/platform-tools/adb" -s "$serial" install -r -d "$apk" >/dev/null 2>&1 || { log "android: install failed"; return 1; }
  log "android: installed $sha on $serial; capturing"
  node "$ROOT/.codex/verify-screen-parity.mjs" >"$INBOX/parity-$sha.txt" 2>&1
  cp "$ROOT/.codex/screen-parity-report.json" "$INBOX/parity-$sha.json" 2>/dev/null
  git -C "$ROOT/Poplur2025-Android" worktree remove --force "$wt" 2>/dev/null

  cat > "$INBOX/REVIEW-PENDING-$sha.md" <<EOF
# Screen parity capture — Android origin/main $sha

Captured $(date -u +%Y-%m-%dT%H:%M:%SZ). **Not yet reviewed. This is not a pass.**

Renders are in /private/tmp/poplur-screen-parity/ and listed in parity-$sha.json.

A human or vision model must compare each capture against its reference and rule.
Do NOT infer parity from the coarseHint field — it demonstrably cannot separate a
broken Welcome (0.1054) from a correct one (0.1029).

Uncovered targets in this run verified nothing; read the tally before believing green.
EOF
  log "android: capture complete -> $INBOX/REVIEW-PENDING-$sha.md"
}

once() {
  local prev_ios prev_android now_android
  prev_ios=$(python3 -c "import json,sys;print(json.load(open('$STATE')).get('ios',''))" 2>/dev/null || echo "")
  prev_android=$(python3 -c "import json,sys;print(json.load(open('$STATE')).get('android',''))" 2>/dev/null || echo "")

  if now_android=$(check_repo Poplur2025-Android "$prev_android"); then
    run_android "$now_android"
    prev_android="$now_android"
  fi

  # iOS capture requires a built .app installed on a booted simulator. Left unwired
  # deliberately: as of 2026-07-17 no iOS binary had been produced (the build hit a
  # full disk), so wiring it would only produce confident-looking nothing.
  local now_ios; now_ios=$(sha_of Poplur2025-iOS)
  if [ -n "$now_ios" ] && [ "$now_ios" != "$prev_ios" ]; then
    log "ios: origin/main moved $prev_ios -> $now_ios (capture NOT wired — needs build+install to simulator)"
    prev_ios="$now_ios"
  fi

  printf '{\n  "ios": "%s",\n  "android": "%s",\n  "updatedAt": "%s"\n}\n' \
    "$prev_ios" "$prev_android" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE"
}

if [ "${1:-}" = "--once" ]; then
  once
  exit 0
fi

log "watching origin/main for Poplur2025-iOS + Poplur2025-Android (poll ${POLL_SECONDS}s)"
while true; do
  once
  sleep "$POLL_SECONDS"
done
