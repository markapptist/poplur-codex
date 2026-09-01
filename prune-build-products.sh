#!/usr/bin/env bash
# prune-build-products.sh — retention for the workbench build-product directories.
#
# WHY THIS EXISTS
#   .codex/build-products had no retention. Every build wrote one timestamped
#   derived-data tree (336KB .. 4.0GB) and nothing ever removed one. On
#   2026-08-21 it held 22 directories / ~31GB accumulated in ~48h and filled the
#   466GB volume to 227MiB free.
#
#   A full volume never announces itself as a full volume. What was actually
#   observed first: `git worktree add` dying partway with "No space left on
#   device" and leaving a partial worktree; headless Chrome dying mid-run during
#   performance probes (read as probe bugs); load spikes blamed on session
#   contention. Retention therefore runs at the START of a build, before a build
#   can begin on a nearly-full disk — not afterwards, and not on a timer.
#
# CONCURRENCY
#   Several agent sessions build on this workbench at the same time (two live
#   xcodebuilds were running while this script was written). A directory is
#   never removed while anything suggests it is live. Four independent vetoes,
#   any one of which spares it:
#     1. `.build-lock` naming a live pid, or carrying a future hold_until
#     2. anything under it modified inside the grace window
#     3. its path in the argv of a running process
#     4. a `.keep` marker file (a manual, permanent pin)
#   On top of that the N newest directories are always kept, and removal is a
#   rename into .trash/ followed by rm -rf, so a directory disappears atomically
#   rather than being read half-deleted by someone else.
#
# USAGE
#   prune-build-products.sh [options]          prune per the retention policy
#   prune-build-products.sh --list             show state, delete nothing
#   prune-build-products.sh --dry-run          show what would go
#   prune-build-products.sh --hold DIR [HRS]   pin DIR against pruning (default 6h)
#   prune-build-products.sh --release DIR      drop that pin
#
# OPTIONS
#   --root DIR           product root (repeatable; default .codex/build-products)
#   --keep N             always keep the N newest                    (default 4)
#   --max-age-hours H    older than this is a prune candidate       (default 24)
#   --grace-minutes M    never touch anything modified this recently (default 45)
#   --min-free-gb G      after the normal pass, keep deleting oldest-first until
#                        this much is free (in-use vetoes still apply) (default 0=off)
#   --keep-floor N       --min-free-gb never goes below this many     (default 1)
#   --quiet              only report deletions and problems

set -uo pipefail

FIND=/usr/bin/find
STAT=/usr/bin/stat
DEFAULT_ROOT="/Users/matrix/Developer/.codex/build-products"

ROOTS=()
KEEP=4
MAX_AGE_HOURS=24
GRACE_MINUTES=45
MIN_FREE_GB=0
KEEP_FLOOR=1
DRY_RUN=false
LIST_ONLY=false
QUIET=false
MODE=prune
HOLD_TARGET=""
HOLD_HOURS=6

die() { printf 'prune-build-products: %s\n' "$*" >&2; exit 2; }
say() { $QUIET || printf '%s\n' "$*"; }

while [ $# -gt 0 ]; do
  arg="$1"; val=""
  case "$arg" in --*=*) val="${arg#*=}"; arg="${arg%%=*}";; esac
  next() { if [ -n "$val" ]; then printf '%s' "$val"; else printf '%s' "${2-}"; fi; }
  case "$arg" in
    --root)          ROOTS+=("$(next "$@")");        [ -n "$val" ] || shift ;;
    --keep)          KEEP="$(next "$@")";            [ -n "$val" ] || shift ;;
    --max-age-hours) MAX_AGE_HOURS="$(next "$@")";   [ -n "$val" ] || shift ;;
    --grace-minutes) GRACE_MINUTES="$(next "$@")";   [ -n "$val" ] || shift ;;
    --min-free-gb)   MIN_FREE_GB="$(next "$@")";     [ -n "$val" ] || shift ;;
    --keep-floor)    KEEP_FLOOR="$(next "$@")";      [ -n "$val" ] || shift ;;
    --hold)          MODE=hold; HOLD_TARGET="$(next "$@")"; [ -n "$val" ] || shift
                     case "${2-}" in [0-9]*) HOLD_HOURS="$2"; shift;; esac ;;
    --release)       MODE=release; HOLD_TARGET="$(next "$@")"; [ -n "$val" ] || shift ;;
    --dry-run)       DRY_RUN=true ;;
    --list)          LIST_ONLY=true ;;
    --quiet)         QUIET=true ;;
    -h|--help)       sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)               die "unknown option: $1" ;;
  esac
  shift
done
[ ${#ROOTS[@]} -gt 0 ] || ROOTS=("$DEFAULT_ROOT")

now=$(date +%s)

human_kb() {  # KB -> human
  awk -v k="${1:-0}" 'BEGIN{
    if (k >= 1048576) printf "%.1fG", k/1048576;
    else if (k >= 1024) printf "%.0fM", k/1024;
    else printf "%dK", k }'
}
free_kb() { df -Pk "$1" 2>/dev/null | tail -1 | awk '{print $4}'; }

# ---------------------------------------------------------------- hold/release
lock_path() { printf '%s/.build-lock' "$1"; }

# A bare product name ("--release ios-iphone-20260901-1045") is the natural way
# to name one of these directories, but a verbatim argument resolves against the
# CALLER's cwd rather than the product root — so it addressed a path that does
# not exist, which --release then treated as success. Accept either form: use
# the argument as given when it is a directory, otherwise look for it under each
# configured root.
resolve_target() {
  local target="$1" root
  if [ -d "$target" ]; then printf '%s' "$target"; return 0; fi
  for root in "${ROOTS[@]}"; do
    if [ -d "$root/$target" ]; then printf '%s' "$root/$target"; return 0; fi
  done
  return 1
}

if [ "$MODE" = hold ]; then
  # Capture into a temp first: assigning directly would blank HOLD_TARGET on
  # failure and the die message would name nothing.
  resolved=$(resolve_target "$HOLD_TARGET") || die "--hold: not a directory: $HOLD_TARGET"
  HOLD_TARGET="$resolved"
  until_ts=$(( now + HOLD_HOURS * 3600 ))
  # Deliberately no pid= here: the caller is usually a `zsh -c` that exits at
  # once, and a recycled pid would pin the directory past the hold. hold_until
  # is the mechanism for a hold; pid= is for a build that owns the dir live.
  { echo "started=$now"
    echo "hold_until=$until_ts"
    echo "note=held by $(id -un) for ${HOLD_HOURS}h"
  } > "$(lock_path "$HOLD_TARGET")"
  say "held $HOLD_TARGET until $(date -r "$until_ts" '+%Y-%m-%d %H:%M')"
  exit 0
fi
if [ "$MODE" = release ]; then
  resolved=$(resolve_target "$HOLD_TARGET") || die "--release: not a directory: $HOLD_TARGET"
  lock="$(lock_path "$resolved")"
  # `rm -f` exits 0 for a path that does not exist, so the old unconditional
  # `&& say released` reported a release that never happened — observed on
  # 2026-09-01, where a bare product name resolved outside the root, printed
  # "released", left the hold in place, and the next prune pass skipped the
  # directory as still held. Only claim a release when a lock was really there.
  if [ -e "$lock" ]; then
    rm -f "$lock" || die "--release: could not remove $lock"
    say "released $resolved"
  else
    say "no hold on $resolved — nothing to release"
  fi
  exit 0
fi

# ------------------------------------------------------------------- pruning
# One ps snapshot for the whole run. Any live process naming a directory's path
# in its argv pins that directory: xcodebuild -derivedDataPath, a devicectl
# install reading the .app, a cp collecting products, a tail on a build log.
PS_SNAPSHOT="$(ps -eo pid=,args= 2>/dev/null | grep -v -e 'prune-build-products' -e 'build-preflight')"

# Grace reference file: anything newer than this is being actively written.
GRACE_REF="$(mktemp -t prune-build-products)" || die "cannot create temp file"
touch -t "$(date -v-"${GRACE_MINUTES}"M +%Y%m%d%H%M.%S)" "$GRACE_REF" \
  || die "cannot stamp grace reference"
trap 'rm -f "$GRACE_REF"' EXIT

# Effective mtime: a build's top-level dir stops changing once Build/, Logs/ and
# SourcePackages/ exist, so the top-level mtime alone would rank a running build
# as ancient. Take the newest of the directory and its immediate children.
effective_mtime() {
  local d="$1" newest
  newest=$("$STAT" -f '%m' "$d" 2>/dev/null || echo 0)
  local child
  while IFS= read -r child; do
    local m; m=$("$STAT" -f '%m' "$child" 2>/dev/null || echo 0)
    [ "$m" -gt "$newest" ] && newest=$m
  done < <("$FIND" "$d" -mindepth 1 -maxdepth 1 2>/dev/null)
  printf '%s' "$newest"
}

# Why this directory must be spared, or empty if it may go.
# Ordered cheapest-first; the deep walk only runs if nothing cheaper vetoed.
veto_reason() {
  local d="$1" lock pid hold_until hit
  [ -e "$d/.keep" ] && { printf 'pinned by .keep'; return; }

  lock="$(lock_path "$d")"
  if [ -f "$lock" ]; then
    pid=$(sed -n 's/^pid=//p' "$lock" | head -1)
    hold_until=$(sed -n 's/^hold_until=//p' "$lock" | head -1)
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      printf 'build-lock pid %s alive' "$pid"; return
    fi
    if [ -n "${hold_until:-}" ] && [ "$hold_until" -gt "$now" ] 2>/dev/null; then
      printf 'held until %s' "$(date -r "$hold_until" '+%H:%M')"; return
    fi
  fi

  hit="$(printf '%s\n' "$PS_SNAPSHOT" | grep -F -- "$d" | head -1)"
  if [ -n "$hit" ]; then
    printf 'in use by pid %s' "$(printf '%s' "$hit" | awk '{print $1}')"; return
  fi

  # Depth 6 reaches Build/Products/<cfg>/Poplur2025.app/<file> and the
  # Intermediates.noindex object dirs — where a running build actually writes.
  if [ -n "$("$FIND" "$d" -maxdepth 6 -newer "$GRACE_REF" -print -quit 2>/dev/null)" ]; then
    printf 'written to within %sm' "$GRACE_MINUTES"; return
  fi
}

remove_dir() {  # rename out of the way first: disappearing is atomic, rm -rf is not
  local d="$1" root="$2" trash="$2/.trash" staged
  mkdir -p "$trash" 2>/dev/null
  staged="$trash/$(basename "$d").$$"
  if mv "$d" "$staged" 2>/dev/null; then
    # Synchronous on purpose. The rename is what makes the directory vanish
    # atomically for other sessions; the rm is what actually returns the bytes,
    # and callers check free space immediately after this returns.
    rm -rf "$staged" 2>/dev/null
    return 0
  fi
  return 1
}

total_reclaimed_kb=0
exit_code=0

for root in "${ROOTS[@]}"; do
  [ -d "$root" ] || { say "prune-build-products: no such root, skipping: $root"; continue; }

  # Whole-root lock. A concurrent prune is not an error — one pass is enough.
  LOCK="$root/.prune.lock"
  if ! mkdir "$LOCK" 2>/dev/null; then
    lock_age=$(( now - $("$STAT" -f '%m' "$LOCK" 2>/dev/null || echo "$now") ))
    if [ "$lock_age" -gt 1800 ]; then
      say "prune-build-products: breaking stale lock (${lock_age}s old)"
      rm -rf "$LOCK" 2>/dev/null
      mkdir "$LOCK" 2>/dev/null || { say "prune-build-products: $root locked, skipping"; continue; }
    else
      say "prune-build-products: another prune holds $root, skipping"
      continue
    fi
  fi
  echo "$$" > "$LOCK/pid" 2>/dev/null
  # shellcheck disable=SC2064
  trap "rm -rf '$LOCK' '$GRACE_REF'" EXIT

  # Leftovers from a prune that was killed mid-rm.
  if [ -d "$root/.trash" ]; then
    if mv "$root/.trash" "$root/.trash-old.$$" 2>/dev/null; then
      rm -rf "$root/.trash-old.$$" 2>/dev/null
    fi
  fi

  free_before=$(free_kb "$root")
  say "prune-build-products: $root  (free ${free_before:+$(human_kb "$free_before")}, keep newest $KEEP, max age ${MAX_AGE_HOURS}h)"

  # Newest-first list of "<mtime>\t<path>".
  entries=()
  while IFS= read -r d; do
    [ -d "$d" ] || continue
    [ -L "$d" ] && continue
    entries+=("$(effective_mtime "$d")	$d")
  done < <("$FIND" "$root" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null)

  if [ ${#entries[@]} -eq 0 ]; then
    say "  (empty)"
    rm -rf "$LOCK"; continue
  fi

  sorted=()
  while IFS= read -r line; do sorted+=("$line"); done \
    < <(printf '%s\n' "${entries[@]}" | sort -rn)

  age_cutoff=$(( now - MAX_AGE_HOURS * 3600 ))
  survivors=()   # newest-first, still on disk, no veto — reclaim eats these from the end
  idx=0
  for line in "${sorted[@]}"; do
    mtime="${line%%	*}"; d="${line#*	}"
    name="$(basename "$d")"
    idx=$(( idx + 1 ))
    age_h=$(( (now - mtime) / 3600 ))

    reason="$(veto_reason "$d")"
    if [ -n "$reason" ]; then
      say "  skip    $name  ($reason)"
      continue
    fi
    if [ "$idx" -le "$KEEP" ]; then
      say "  keep    $name  (newest $KEEP, ${age_h}h)"
      survivors+=("$d")
      continue
    fi
    if [ "$mtime" -ge "$age_cutoff" ]; then
      say "  keep    $name  (${age_h}h < ${MAX_AGE_HOURS}h)"
      survivors+=("$d")
      continue
    fi

    size_kb=$(du -sk "$d" 2>/dev/null | awk '{print $1}'); size_kb=${size_kb:-0}
    if $LIST_ONLY || $DRY_RUN; then
      say "  WOULD DELETE $name  $(human_kb "$size_kb")  (${age_h}h old)"
      continue
    fi
    if remove_dir "$d" "$root"; then
      printf '  deleted %s  %s  (%sh old)\n' "$name" "$(human_kb "$size_kb")" "$age_h"
      total_reclaimed_kb=$(( total_reclaimed_kb + size_kb ))
    else
      printf 'prune-build-products: could not remove %s\n' "$d" >&2
      exit_code=1
    fi
  done

  # Reclaim: the disk is still too tight, so give up the newest-N guarantee —
  # but never the in-use vetoes, and never the last KEEP_FLOOR directories.
  if [ "$MIN_FREE_GB" -gt 0 ] && ! $LIST_ONLY; then
    want_kb=$(( MIN_FREE_GB * 1048576 ))
    # Walk survivors oldest-first by index. No array mutation: bash 3.2 (this
    # machine) errors on "${arr[@]}" for an empty array under `set -u`.
    remaining=${#survivors[@]}
    i=$(( remaining - 1 ))
    while [ "$remaining" -gt "$KEEP_FLOOR" ] && [ "$i" -ge 0 ]; do
      have_kb=$(free_kb "$root"); have_kb=${have_kb:-0}
      [ "$have_kb" -ge "$want_kb" ] && break
      oldest="${survivors[$i]}"
      i=$(( i - 1 ))
      reason="$(veto_reason "$oldest")"
      if [ -n "$reason" ]; then
        say "  skip    $(basename "$oldest")  (reclaim, but $reason)"
        continue
      fi
      size_kb=$(du -sk "$oldest" 2>/dev/null | awk '{print $1}'); size_kb=${size_kb:-0}
      if $DRY_RUN; then
        say "  WOULD DELETE $(basename "$oldest")  $(human_kb "$size_kb")  (reclaim to ${MIN_FREE_GB}G free)"
        continue
      fi
      if remove_dir "$oldest" "$root"; then
        printf '  deleted %s  %s  (reclaim to %sG free)\n' \
          "$(basename "$oldest")" "$(human_kb "$size_kb")" "$MIN_FREE_GB"
        total_reclaimed_kb=$(( total_reclaimed_kb + size_kb ))
        remaining=$(( remaining - 1 ))
      else
        printf 'prune-build-products: could not remove %s\n' "$oldest" >&2
        exit_code=1
      fi
    done
  fi

  rm -rf "$LOCK" 2>/dev/null
  trap 'rm -f "$GRACE_REF"' EXIT
done

if [ "$total_reclaimed_kb" -gt 0 ]; then
  printf 'prune-build-products: reclaimed %s\n' "$(human_kb "$total_reclaimed_kb")"
fi
exit "$exit_code"
