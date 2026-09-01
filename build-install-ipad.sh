#!/bin/bash
# Build Poplur2025 for Mark's iPad (10th gen) and install it.
# Simulator tooling cannot drive a physical device, so this is a real
# xcodebuild + devicectl install.
set -o pipefail

IPAD=AFE5B767-CB4D-5EED-B224-81FB4E779081
DD=/Users/matrix/Developer/.codex/build-products/ios-ipad-$(date +%Y%m%d-%H%M%S)
# Retention + disk floor BEFORE anything expensive starts. Also claims $DD, so a
# prune running in another session cannot take this build's directory mid-run.
# Exits non-zero (loudly) rather than letting a full disk surface 20 minutes
# later as "SwiftCompile failed" with no error: line.
/Users/matrix/Developer/.codex/build-preflight.sh --dir "$DD" || exit 1

cd /Users/matrix/Developer/Poplur2025-iOS || exit 1

echo "=== building for iPad (10th generation) ==="
xcodebuild \
  -project Poplur2025.xcodeproj \
  -scheme Poplur2025 \
  -configuration Debug \
  -destination "id=$IPAD" \
  -derivedDataPath "$DD" \
  -allowProvisioningUpdates \
  build 2>&1 | tee "$DD/build.log" | tail -40
rc=$?
if [ $rc -ne 0 ]; then
  echo "BUILD FAILED (exit $rc)"
  # See the note in build-install-iphone.sh: `tail -40` alone hid every `error:`
  # line, so a real compile failure was indistinguishable from an out-of-disk one.
  echo "=== error lines (full log: $DD/build.log) ==="
  grep -E '(^error:|: error:)' "$DD/build.log" | head -30 || echo "  (none — a failure with NO error: line is the documented out-of-disk signature)"
  exit $rc
fi

APP=$(find "$DD/Build/Products" -maxdepth 2 -name 'Poplur2025.app' -type d | head -1)
if [ -z "$APP" ]; then
  echo "BUILD OK but no Poplur2025.app found under $DD/Build/Products"
  exit 1
fi
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
Destination:         id=$IPAD
                     (pinned: simulator tooling cannot drive a physical device)
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
devicectl UDID:      $IPAD

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

echo "=== installing on iPad ==="
xcrun devicectl device install app --device "$IPAD" "$APP" 2>&1 | tail -15
echo "install rc=$?"
echo "DONE"
