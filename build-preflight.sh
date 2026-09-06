#!/usr/bin/env bash
source /Users/matrix/Developer/.codex/lib/pid-identity.sh
# build-preflight.sh — run this as the FIRST thing in any build.
#
# Two jobs, in this order:
#   1. prune .codex/build-products so the build does not start on a disk that
#      previous builds filled (see prune-build-products.sh for the history)
#   2. refuse to start at all if free space is still too low
#
# Job 2 exists because a full volume is invisible at the point of failure. On
# 2026-08-21 the volume hit 227MiB free and what people actually saw was:
#   * `git worktree add` dying partway with "No space left on device",
#     leaving a partial worktree behind
#   * headless Chrome dying mid-run during performance probes, read as probe bugs
#   * load spikes blamed on session contention
# and, from the build side (see .claude/agents/build-runner.md):
#   * `SwiftCompile failed` with NO `error:` lines anywhere in the log
#   * `Mkdtemp`/`copy: No space left on device (28)`
# Every one of those costs more to diagnose than it costs to check df up front.
#
# USAGE
#   .codex/build-preflight.sh                      # prune + check, that is all
#   .codex/build-preflight.sh --dir "$DD"          # also claim $DD against pruning
#   .codex/build-preflight.sh --no-prune           # check only
#
# OPTIONS / ENV
#   --dir DIR             the derived-data dir this build will write; it is
#                         created and stamped with a .build-lock naming the
#                         calling process, so a concurrent prune leaves it alone
#   --min-free-gb N       hard floor; below this the build refuses to start
#                         (default 8, env POPLUR_MIN_FREE_GB)
#   --target-free-gb N    reclaim target handed to the pruner; only below this
#                         does pruning give up the keep-newest-N guarantee
#                         (default 15, env POPLUR_TARGET_FREE_GB)
#   --warn-free-gb N      print a warning below this (default 12). Kept below the
#                         reclaim target on purpose: this workbench idles around
#                         20 GiB free (CoreSimulator + iOS DeviceSupport alone are
#                         ~28 GiB), so a higher threshold would fire on every
#                         build and pay for a full du walk of those caches.
#   --no-prune            skip pruning, only check
#   --quiet               suppress the pruner's per-directory chatter
#
# EXIT: 0 = clear to build (possibly with a warning), 1 = too little space, 2 = usage

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="/Users/matrix/Developer"
PRUNER="$HERE/prune-build-products.sh"

MIN_FREE_GB="${POPLUR_MIN_FREE_GB:-8}"
TARGET_FREE_GB="${POPLUR_TARGET_FREE_GB:-15}"
WARN_FREE_GB=12
BUILD_DIR=""
DO_PRUNE=true
QUIET=false

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)            BUILD_DIR="${2-}"; shift ;;
    --min-free-gb)    MIN_FREE_GB="${2-}"; shift ;;
    --target-free-gb) TARGET_FREE_GB="${2-}"; shift ;;
    --warn-free-gb)   WARN_FREE_GB="${2-}"; shift ;;
    --no-prune)       DO_PRUNE=false ;;
    --quiet)          QUIET=true ;;
    -h|--help)        sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "build-preflight: unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

free_gb() { df -Pk "$ROOT" 2>/dev/null | tail -1 | awk '{printf "%.1f", $4/1048576}'; }
below() { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a+0 < b+0)}'; }

# Only walked when space is actually tight — du over CoreSimulator/DeviceSupport
# is slow, and the happy path must stay cheap enough to run before every build.
report_consumers() {
  echo "  Biggest consumers right now:"
  for p in "$ROOT/.codex/build-products" \
           "$ROOT/Poplur2025-iOS/.codex/build-products" \
           /private/tmp/xcode-dd-dev \
           /private/tmp/poplur-android-build \
           "$HOME/Library/Developer/Xcode/DerivedData" \
           "$HOME/Library/Developer/CoreSimulator/Devices" \
           "$HOME/Library/Developer/Xcode/iOS DeviceSupport" \
           "$ROOT/.codex/handoff-worktrees"; do
    [ -e "$p" ] || continue
    printf '    %8s  %s\n' "$(du -sxh "$p" 2>/dev/null | cut -f1)" "$p"
  done | sort -rh -k1 2>/dev/null || true
}

if $DO_PRUNE && [ -x "$PRUNER" ]; then
  if $QUIET; then
    "$PRUNER" --min-free-gb "$TARGET_FREE_GB" --quiet
  else
    "$PRUNER" --min-free-gb "$TARGET_FREE_GB"
  fi
fi

FREE="$(free_gb)"

if below "$FREE" "$MIN_FREE_GB"; then
  cat >&2 <<MSG

=========================== BUILD PREFLIGHT: STOP ===========================
Only ${FREE} GiB free on the volume holding $ROOT.
Refusing to start a build below the ${MIN_FREE_GB} GiB floor.

This is a HARD STOP on purpose. Starting here does not give you a clean
"disk full" error — it gives you, somewhere in the next 20 minutes:
  * SwiftCompile failed with no 'error:' line anywhere in the log
  * Mkdtemp / copy: No space left on device (28)
  * git worktree add dying partway and leaving a partial worktree
  * headless Chrome dying mid-probe, which reads as a probe bug
Every one of those has already cost this workbench a debugging session.
MSG
  report_consumers >&2
  cat >&2 <<'MSG'

  To reclaim, in rough order of safety:
    .codex/prune-build-products.sh --list            # see what retention holds
    .codex/prune-build-products.sh --min-free-gb 25  # prune harder (never touches a live build)
    xcrun simctl delete unavailable                  # dead simulator runtimes
  Older ~/Library/Developer/Xcode/iOS DeviceSupport/<version> directories are
  safe to remove for iOS versions no device here still runs.
=============================================================================

MSG
  exit 1
fi

if below "$FREE" "$WARN_FREE_GB"; then
  echo "build-preflight: WARNING — ${FREE} GiB free (floor is ${MIN_FREE_GB} GiB). Building anyway." >&2
  report_consumers >&2
else
  $QUIET || echo "build-preflight: ${FREE} GiB free — clear to build."
fi

# Claim the build's directory so a prune from a concurrent session cannot take
# it mid-build. $PPID is the build script itself, which lives for the whole run.
if [ -n "$BUILD_DIR" ]; then
  mkdir -p "$BUILD_DIR" || { echo "build-preflight: cannot create $BUILD_DIR" >&2; exit 1; }
  # pid alone is not an identity: a recycled pid pins the directory forever
  # (see lib/pid-identity.sh). Record the owner's start time with it.
  { echo "pid=$PPID"
    echo "pidstart=$(pid_start_token "$PPID")"
    echo "started=$(date +%s)"
    echo "hold_until=$(( $(date +%s) + 21600 ))"
    echo "note=$(basename "$0") claim for $(basename "$BUILD_DIR")"
  } > "$BUILD_DIR/.build-lock"
  $QUIET || echo "build-preflight: claimed $BUILD_DIR (pid $PPID)"
fi

exit 0
