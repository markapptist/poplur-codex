#!/bin/bash
# Build Poplur2025 for MATRIX's iPhone 16 and install it.
#
# Builds `generic/platform=iOS` rather than pinning `-destination id=…`: a
# device-pinned build against a LOCKED phone retries forever and reports no
# compile error, which reads exactly like a hang. Build generic, then let
# devicectl do the install once the phone is unlocked.
set -o pipefail

IPHONE=339089BF-8115-5788-B719-5967E503A27B
DD=/Users/matrix/Developer/.codex/build-products/ios-iphone-$(date +%Y%m%d-%H%M%S)
# Retention + disk floor BEFORE anything expensive starts. Also claims $DD, so a
# prune running in another session cannot take this build's directory mid-run.
# Exits non-zero (loudly) rather than letting a full disk surface 20 minutes
# later as "SwiftCompile failed" with no error: line.
/Users/matrix/Developer/.codex/build-preflight.sh --dir "$DD" || exit 1

cd /Users/matrix/Developer/Poplur2025-iOS || exit 1

echo "=== building for iPhone 16 (generic/platform=iOS) ==="
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
BUILD PROVENANCE — Poplur iOS device build (iPhone 16)
======================================================
Platform:            iOS (physical device — MATRIX's iPhone 16)
Build type:          Debug configuration, xcodebuild build
Destination:         generic/platform=iOS  (device-generic: an id-pinned build against a
                     locked phone retries forever and reads as a hang)
Built by:            .codex/build-install-iphone.sh
UTC build time:      $PROV_UTC  ($PROV_LOCAL local)
Repo:                $PROV_REPO
Branch:              $PROV_BRANCH
HEAD commit SHA:     $PROV_SHA
HEAD subject:        $PROV_SUBJECT
Tree state:          $PROV_TREE
$PROV_FILES

Install target
--------------
devicectl UDID:      $IPHONE

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


# --- device lock (install + launch only) ------------------------------------
# On the evening of 2026-09-05 two sessions built and installed to this phone
# within three minutes of each other (products ios-iphone-20260905-205512 and
# -205515). The second install silently replaced the first: one session put
# container 4ACF434D-8BBB-4CA3-A14D-DB3ABD34AA1D on the device, the other's
# install landed at 21:09 as 55BD326F-2269-4FD9-B3D9-A417371CB60B, and the first
# session then launched a binary it had never verified. Both were the same commit
# that night so nothing broke; two sessions on different branches would leave the
# phone running whichever finished last, with no signal at the launch step.
#
# The pre-build pgrep guard does not catch this — the other build was still inside
# build-preflight.sh's prune and had no xcodebuild process to find yet. So the lock
# is taken around the INSTALL, not the build: builds may overlap freely (they write
# to their own $DD), only the device is exclusive.
#
# A stale lock must never deadlock the workbench, so the holder records its pid and
# start time and a lock whose owner is gone is broken. A lock whose owner is still
# ALIVE is waited on, never broken — waiting out a live install is correct, and
# after POPLUR_DEVICE_LOCK_WAIT seconds this exits loudly rather than hanging.
BUNDLE_ID=com.apptist.Poplur2025
LOCK_ROOT=/Users/matrix/Developer/.codex/locks
LOCK_DIR="$LOCK_ROOT/device-$IPHONE.lock"
LOCK_HELD=0
LOCK_WAIT_SECS=${POPLUR_DEVICE_LOCK_WAIT:-900}
# Grace before an owner file we cannot read is called stale: mkdir and the write of
# owner/ are two steps, so a lock caught between them is young, not abandoned.
LOCK_WRITE_GRACE=10

lock_field() { sed -n "s/^$1=//p" "$LOCK_DIR/owner" 2>/dev/null | head -1; }

release_device_lock() {
  [ "$LOCK_HELD" = 1 ] || return 0
  # Only ever remove a lock this process still owns. If it was broken as stale and
  # retaken by someone else, theirs is not ours to delete.
  if [ "$(lock_field pid)" = "$$" ]; then rm -rf "$LOCK_DIR"; fi
  LOCK_HELD=0
}

take_device_lock() {
  mkdir -p "$LOCK_ROOT" || { echo "cannot create $LOCK_ROOT"; return 1; }
  local waited=0 pid now started age
  while :; do
    # mkdir is the atomic claim: it either creates the directory or fails, with no
    # test-then-create window for a second script to slip through.
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      { echo "pid=$$"
        echo "started=$(date +%s)"
        echo "startedLocal=$(date '+%Y-%m-%d %H:%M:%S')"
        echo "device=$IPHONE"
        echo "script=build-install-iphone.sh"
        echo "product=$DD"
      } > "$LOCK_DIR/owner"
      LOCK_HELD=1
      return 0
    fi

    pid=$(lock_field pid)
    now=$(date +%s)
    started=$(lock_field started)
    case "$started" in ''|*[!0-9]*) started=$(stat -f %m "$LOCK_DIR" 2>/dev/null || echo "$now") ;; esac
    case "$started" in ''|*[!0-9]*) started=$now ;; esac
    age=$(( now - started ))

    if [ -n "$pid" ] && [ -z "${pid//[0-9]/}" ] && kill -0 "$pid" 2>/dev/null; then
      if [ "$waited" -ge "$LOCK_WAIT_SECS" ]; then
        echo "DEVICE BUSY: pid $pid has held $LOCK_DIR for ${age}s and is still running."
        echo "  waited ${waited}s (POPLUR_DEVICE_LOCK_WAIT=$LOCK_WAIT_SECS) — refusing to install over another session."
        echo "  holder: $(tr '\n' ' ' < "$LOCK_DIR/owner" 2>/dev/null)"
        echo "  build product kept at $APP — re-run the install by hand once the device is free."
        return 1
      fi
      [ $(( waited % 30 )) -eq 0 ] && echo "waiting for the iPhone: pid $pid holds the device lock (${age}s, waited ${waited}s)"
      sleep 5
      waited=$(( waited + 5 ))
      continue
    fi

    if [ "$age" -lt "$LOCK_WRITE_GRACE" ]; then
      # No live owner, but the lock is seconds old — most likely someone between
      # mkdir and their owner write. Give them the grace window before breaking it.
      sleep 2
      waited=$(( waited + 2 ))
      continue
    fi

    echo "breaking stale device lock: owner pid ${pid:-unknown} is gone (lock age ${age}s)"
    rm -rf "$LOCK_DIR"
    # Loop round and try to claim it; if another waiter won the race we just wait.
  done
}

trap release_device_lock EXIT INT TERM

echo "=== taking device lock for $IPHONE ==="
take_device_lock || exit 1
echo "=== device lock held (pid $$) ==="

echo "=== installing on iPhone ==="
# The install is the step this script exists to deliver, yet until 2026-09-05 its
# result never reached the exit status: the script ended on `echo "DONE"`, so a
# failed devicectl install (seen that day: CoreDevice.ControlChannelConnectionError /
# NWError 54 over Wi-Fi, `install rc=1`) still exited 0 and a caller's
# `SCRIPT EXIT: 0` read as success. That class of failure is a transient transport
# error — the retry succeeded at once — so the same .app is retried exactly once,
# with no rebuild, before the script fails. The build product and
# BUILD-PROVENANCE.txt stay in place either way, so a failed install can be
# re-run by hand from $APP.
#
# --json-output is what makes the install answerable: the installationURL naming the
# container devicectl just wrote is a structured field, and scraping it out of the
# human-readable text would break the first time Apple reflows that output.
INSTALL_JSON="$DD/install.json"
APP_INFO_JSON="$DD/installed-app.json"
install_attempt() {
  rm -f "$INSTALL_JSON"
  xcrun devicectl device install app --device "$IPHONE" "$APP" \
    --json-output "$INSTALL_JSON" 2>&1 | tail -15
  # devicectl's own status, not tail's. Must be read on the very next line —
  # any intervening command resets PIPESTATUS.
  return "${PIPESTATUS[0]}"
}
install_attempt
install_rc=$?
if [ "$install_rc" -ne 0 ]; then
  echo "install attempt 1 failed (devicectl rc=$install_rc) — retrying the same .app once, no rebuild"
  sleep 3
  install_attempt
  install_rc=$?
fi
echo "install rc=$install_rc"
if [ "$install_rc" -ne 0 ]; then
  echo "INSTALL FAILED (exit $install_rc) after 2 attempts — build product kept at $APP"
  echo "  provenance: $PROV"
  echo "  retry by hand: xcrun devicectl device install app --device $IPHONE \"$APP\""
  exit "$install_rc"
fi

# --- installed-container verification ---------------------------------------
# What the 2026-09-05 collision actually needed: the container this install wrote
# has to still be the container the device reports afterwards. If another session
# installed between our write and this read, the URLs differ and we say so instead
# of launching a stranger's build.
container_url() {  # <json file> <install|info>
  python3 - "$1" "$2" "$BUNDLE_ID" <<'PY' 2>/dev/null
import json, sys
path, kind, bundle = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    doc = json.load(open(path))
except Exception:
    sys.exit(1)
result = doc.get("result") or {}
if kind == "install":
    entries = result.get("installedApplications") or []
    key_id, key_url = "bundleID", "installationURL"
else:
    entries = result.get("apps") or []
    key_id, key_url = "bundleIdentifier", "url"
for entry in entries:
    if entry.get(key_id) == bundle:
        url = entry.get(key_url) or ""
        # file:///private/var/…/Poplur2025.app/ — normalise scheme and trailing
        # slash so a cosmetic difference never reads as a different container.
        if url.startswith("file://"):
            url = url[len("file://"):]
        print(url.rstrip("/"))
        break
PY
}

INSTALLED_URL=$(container_url "$INSTALL_JSON" install)
echo "=== verifying the installed container ==="
xcrun devicectl device info apps --device "$IPHONE" --bundle-id "$BUNDLE_ID" \
  --json-output "$APP_INFO_JSON" >/dev/null 2>&1
info_rc=$?
ON_DEVICE_URL=$(container_url "$APP_INFO_JSON" info)

VERIFIED=0
if [ -z "$INSTALLED_URL" ]; then
  echo "VERIFY FAILED: no installationURL for $BUNDLE_ID in $INSTALL_JSON"
elif [ "$info_rc" -ne 0 ] || [ -z "$ON_DEVICE_URL" ]; then
  echo "VERIFY FAILED: could not read the installed app back from the device (devicectl rc=$info_rc)"
  echo "  install wrote: $INSTALLED_URL"
  echo "  device info:   $APP_INFO_JSON"
elif [ "$INSTALLED_URL" != "$ON_DEVICE_URL" ]; then
  echo "VERIFY FAILED: the container on the phone is NOT the one this script installed."
  echo "  this install wrote: $INSTALLED_URL"
  echo "  device now reports: $ON_DEVICE_URL"
  echo "  Another session installed over this build. Nothing was launched."
  echo "  This build stays at $APP (provenance: $PROV) — re-run the install to claim the device."
else
  VERIFIED=1
  echo "=== verified: $ON_DEVICE_URL ==="
fi
if [ "$VERIFIED" -ne 1 ]; then
  echo "INSTALL VERIFICATION FAILED — build product kept at $APP"
  exit 1
fi

# --- launch (opt-in, and only on a verified container) -----------------------
# Off by default so the script's existing contract — build, install, exit — is
# unchanged. When asked for, it launches only what was just verified: launching
# "whatever is on the phone" is exactly the 2026-09-05 failure.
LAUNCH=0
for arg in "$@"; do case "$arg" in --launch) LAUNCH=1 ;; esac; done
[ "${POPLUR_LAUNCH_AFTER_INSTALL:-0}" = 1 ] && LAUNCH=1
if [ "$LAUNCH" = 1 ]; then
  if [ "$VERIFIED" -ne 1 ]; then
    echo "REFUSING TO LAUNCH: the installed container was not verified as this build's."
    exit 1
  fi
  echo "=== launching $BUNDLE_ID ==="
  xcrun devicectl device process launch --terminate-existing --device "$IPHONE" "$BUNDLE_ID" \
    --json-output "$DD/launch.json" 2>&1 | tail -10
  launch_rc=${PIPESTATUS[0]}
  if [ "$launch_rc" -ne 0 ]; then
    echo "LAUNCH FAILED (exit $launch_rc) — the app IS installed and verified at $ON_DEVICE_URL"
    exit "$launch_rc"
  fi
fi

echo "DONE"
exit 0
