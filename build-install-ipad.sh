#!/bin/bash
# Build Poplur2025 for Mark's iPad (10th gen) and install it.
#
# Builds `generic/platform=iOS` rather than pinning `-destination id=…`: a
# device-pinned build against a LOCKED phone retries forever and reports no
# compile error, which reads exactly like a hang. Build generic, then let
# devicectl do the install once the device is unlocked.
#
# This script used to pin `-destination id=…`, which is exactly the hang the
# iPhone script had already been fixed for: against a LOCKED iPad xcodebuild
# retries forever and reports no compile error. Generic, then devicectl.
#
# USAGE
#   build-install-ipad.sh                 build, install, verify the container
#   build-install-ipad.sh --launch        …and launch what was verified
#   build-install-ipad.sh --launch-only [PRODUCT]
#                                           no build: re-verify and launch a
#                                           product already installed from here
#                                           (default: the newest one carrying an
#                                           install.json). This mode exists so a
#                                           launch decided on AFTER the install
#                                           still runs inside the device lock and
#                                           still proves the container, instead of
#                                           being done by hand with a bare
#                                           `devicectl process launch` — which is
#                                           precisely the unverified launch of
#                                           2026-09-05.
set -o pipefail

DEVICE_UDID=AFE5B767-CB4D-5EED-B224-81FB4E779081   # Mark's iPad (10th gen)
DEVICE_LABEL="the iPad"
SCRIPT_NAME=build-install-ipad.sh
BUNDLE_ID=com.apptist.Poplur2025
PRODUCT_ROOT=/Users/matrix/Developer/.codex/build-products

# ── modes ───────────────────────────────────────────────────────────────────
# Parsed before anything expensive: --launch-only must not reach the preflight,
# which would claim (and prune toward) a build directory nothing is going to
# build into.
LAUNCH=0
LAUNCH_ONLY=0
PRODUCT_ARG=
for arg in "$@"; do
  case "$arg" in
    --launch) LAUNCH=1 ;;
    --launch-only) LAUNCH_ONLY=1; LAUNCH=1 ;;
    -*) echo "unknown option: $arg"; echo "usage: build-install-ipad.sh [--launch | --launch-only [PRODUCT]]"; exit 2 ;;
    *) PRODUCT_ARG="$arg" ;;
  esac
done
[ "${POPLUR_LAUNCH_AFTER_INSTALL:-0}" = 1 ] && LAUNCH=1

# A bare product name is the natural way to say which build you mean, but a
# verbatim argument resolves against the CALLER's cwd — so accept either form,
# as prune-build-products.sh does. With no argument: the newest product that
# actually reached an install, since only those can be verified.
resolve_product() {
  local dir
  if [ -n "$PRODUCT_ARG" ]; then
    [ -d "$PRODUCT_ARG" ] && { printf '%s' "$PRODUCT_ARG"; return 0; }
    [ -d "$PRODUCT_ROOT/$PRODUCT_ARG" ] && { printf '%s' "$PRODUCT_ROOT/$PRODUCT_ARG"; return 0; }
    return 1
  fi
  for dir in $(ls -td "$PRODUCT_ROOT"/ios-iphone-* 2>/dev/null); do
    [ -f "$dir/install.json" ] && { printf '%s' "$dir"; return 0; }
  done
  return 1
}


source /Users/matrix/Developer/.codex/lib/device-install.sh

# ── --launch-only: no build, no install; verify what is there and launch it ──
# The gap this closes: a launch decided on after the install used to mean a bare
# `devicectl process launch` typed by hand, outside the lock and with nothing
# checked — the 2026-09-05 failure exactly. Here it takes the same lock and runs
# the same verification against the install.json that build wrote.
if [ "$LAUNCH_ONLY" = 1 ]; then
  DD=$(resolve_product) || {
    echo "--launch-only: no product to launch${PRODUCT_ARG:+ matching \"$PRODUCT_ARG\"}"
    echo "  looked under $PRODUCT_ROOT for ios-ipad-* carrying an install.json"
    exit 1
  }
  INSTALL_JSON="$DD/install.json"
  [ -f "$INSTALL_JSON" ] || { echo "--launch-only: $DD never installed (no install.json)"; exit 1; }
  echo "=== launch-only: $DD ==="
  claim_device || exit 1
  verify_installed_container "$DD/relaunch-app.json" || exit 1
  launch_app
  rc=$?
  [ "$rc" -eq 0 ] && echo "DONE"
  exit "$rc"
fi

DD=/Users/matrix/Developer/.codex/build-products/ios-ipad-$(date +%Y%m%d-%H%M%S)
# Retention + disk floor BEFORE anything expensive starts. Also claims $DD, so a
# prune running in another session cannot take this build's directory mid-run.
# Exits non-zero (loudly) rather than letting a full disk surface 20 minutes
# later as "SwiftCompile failed" with no error: line.
/Users/matrix/Developer/.codex/build-preflight.sh --dir "$DD" || exit 1

cd /Users/matrix/Developer/Poplur2025-iOS || exit 1

echo "=== building for iPad 10th gen (generic/platform=iOS) ==="
xcodebuild \
  -project Poplur2025.xcodeproj \
  -scheme Poplur2025 \
  -configuration Debug \
  -destination generic/platform=iOS \
  -derivedDataPath "$DD" \
  -allowProvisioningUpdates \
  build 2>&1 | tee "$DD/build.log" | tail -40
# PIPESTATUS[0] is xcodebuild's own status, not tail's. `set -o pipefail` at the
# top of this script already makes a bare $? correct here, but only while that
# line survives: drop pipefail and $? silently becomes tail's 0, so a FAILED
# BUILD would report success. Naming the element makes the intent independent of
# a shell option set 120 lines away. Must be read on the very next line — any
# intervening command resets PIPESTATUS.
rc=${PIPESTATUS[0]}
if [ $rc -ne 0 ]; then
  echo "BUILD FAILED (exit $rc)"
  # xcodebuild diagnostics start the line with `error:`, and the console only ever
  # saw `tail -40` — which silently dropped them, so a failure read as no error at
  # all. The full log is kept beside the product; surface the real lines here.
  echo "=== error lines (full log: $DD/build.log) ==="
  grep -E '(^error:|: error:)' "$DD/build.log" | head -30 || echo "  (none — a failure with NO error: line is the documented out-of-disk signature)"
  exit $rc
fi

APP=$(find "$DD/Build/Products" -maxdepth 2 -name 'Poplur2025.app' -type d | head -1)
if [ -z "$APP" ]; then echo "BUILD OK but no Poplur2025.app under $DD/Build/Products"; exit 1; fi
echo "=== built: $APP ($(du -sh "$APP" | cut -f1)) ==="

# --- build provenance -------------------------------------------------------
# "A build product with no provenance is not evidence" (.claude/agents/build-runner.md):
# before 2026-07-17 nothing recorded which branch a product came from, which is how
# iOS and Android drifted onto different pre-login screens. Now that
# prune-build-products.sh deletes older product dirs, whichever one survives has to
# describe itself. Written BEFORE the install, so a failed install still leaves a record.
PROV_REPO=/Users/matrix/Developer/Poplur2025-iOS
PROV="$DD/BUILD-PROVENANCE.txt"
PROV_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PROV_LOCAL=$(date +'%Y-%m-%d %H:%M')
PROV_BRANCH=$(git -C "$PROV_REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || echo UNKNOWN)
PROV_SHA=$(git -C "$PROV_REPO" rev-parse HEAD 2>/dev/null || echo UNKNOWN)
PROV_SUBJECT=$(git -C "$PROV_REPO" log -1 --pretty=%s 2>/dev/null || echo UNKNOWN)
PROV_DIRTY_N=$(git -C "$PROV_REPO" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
if [ "${PROV_DIRTY_N:-0}" -gt 0 ]; then
  PROV_TREE="DIRTY — built from the WORKING TREE, not HEAD (intentional: this script
                     builds the live tree, so in-progress work reaches the device)"
  PROV_FILES="Uncommitted files at build time ($PROV_DIRTY_N):
$(git -C "$PROV_REPO" status --porcelain | sed 's/^/                     /')"
else
  PROV_TREE="clean — working tree matches HEAD"
  PROV_FILES="Uncommitted files at build time: none"
fi
# sha256 covers the Mach-O binary: a .app is a directory, and directories have no hash.
PROV_BIN="$APP/Poplur2025"
if [ -f "$PROV_BIN" ]; then
  PROV_BIN_SHA=$(shasum -a 256 "$PROV_BIN" | cut -d' ' -f1)
  PROV_BIN_SIZE="$(stat -f%z "$PROV_BIN") bytes"
else
  PROV_BIN_SHA="UNAVAILABLE — no Mach-O binary at this path"
  PROV_BIN_SIZE="n/a"
fi
PROV_APP_SIZE=$(du -sh "$APP" | awk '{print $1}')
PROV_WEB=$(find "$APP/ClayMapWeb" -maxdepth 1 -name 'index-*.js' 2>/dev/null | head -1)
if [ -n "$PROV_WEB" ]; then PROV_WEB="ClayMapWeb/$(basename "$PROV_WEB")"; else PROV_WEB="none found"; fi
cat > "$PROV" <<EOF
BUILD PROVENANCE — Poplur iOS device build (iPad 10th gen)
==========================================================
Platform:            iOS (physical device — Mark's iPad, 10th generation)
Build type:          Debug configuration, xcodebuild build
Destination:         generic/platform=iOS  (device-generic: an id-pinned build against a
                     locked iPad retries forever and reads as a hang)
Built by:            .codex/build-install-ipad.sh
UTC build time:      $PROV_UTC  ($PROV_LOCAL local)
Repo:                $PROV_REPO
Branch:              $PROV_BRANCH
HEAD commit SHA:     $PROV_SHA
HEAD subject:        $PROV_SUBJECT
Tree state:          $PROV_TREE
$PROV_FILES

Install target
--------------
devicectl UDID:      $DEVICE_UDID

Artifact
--------
App bundle:          $APP
App bundle size:     $PROV_APP_SIZE
ClayMapWeb bundle:   $PROV_WEB

Mach-O binary (the sha256 covers this file — a .app is a directory and has no hash):
  $PROV_BIN
  size:   $PROV_BIN_SIZE
  sha256: $PROV_BIN_SHA
EOF
echo "=== provenance written: $PROV ==="

# Sanity: the whole point of this build is the web bundle it carries. The hashed
# filename changes on every sync, so derive the expected name from the synced
# source's index.html (what the WebView actually loads) instead of hardcoding it.
EXPECTED_WEB=$(grep -o 'index-[A-Za-z0-9_-]*\.js' /Users/matrix/Developer/Poplur2025-iOS/ClayMapWeb/index.html 2>/dev/null | head -1)
if [ -z "$EXPECTED_WEB" ]; then
  echo "=== WARNING: no hashed bundle name found in ClayMapWeb/index.html — cannot verify the .app's web bundle ==="
elif [ -f "$APP/ClayMapWeb/$EXPECTED_WEB" ]; then
  echo "=== bundle check: $EXPECTED_WEB present in the .app (matches synced index.html) ==="
else
  echo "=== WARNING: expected clay-map bundle $EXPECTED_WEB not found in the .app ==="
  ls "$APP/ClayMapWeb"/index-*.js 2>/dev/null | head -3
fi


claim_device || exit 1

INSTALL_JSON="$DD/install.json"
install_to_device || exit $?
verify_installed_container "$DD/installed-app.json" || exit 1

if [ "$LAUNCH" = 1 ]; then
  launch_app || exit $?
fi

echo "DONE"
exit 0
