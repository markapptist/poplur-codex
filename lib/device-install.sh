#!/bin/bash
source /Users/matrix/Developer/.codex/lib/pid-identity.sh
# Shared device-install machinery — sourced by build-install-iphone.sh and
# build-install-ipad.sh.
#
# It lives here because it is a SAFETY mechanism, and two copies of a safety
# mechanism is one copy plus a copy that quietly falls behind. The iPad script
# was the proof: written from the same template as the iPhone one, it still
# carried every defect the iPhone script had since fixed — a device-pinned
# destination that retries forever against a locked device and reads as a hang,
# `install rc=$?` reading TAIL's status instead of devicectl's (so a FAILED
# install printed rc=0), a final `echo DONE` that exited 0 whatever happened,
# and no lock or container check at all.
#
# Callers set, before sourcing:
#   DEVICE_UDID  the devicectl identifier to lock and install to
#   BUNDLE_ID    the app's bundle identifier
#   SCRIPT_NAME  what to record as the lock owner (optional)
# and set DD / APP / INSTALL_JSON before calling install_to_device,
# verify_installed_container or launch_app.
#
# The lock is keyed by UDID, so an iPhone install and an iPad install never
# contend; only two installs to the SAME device serialise.

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
LOCK_DIR="$LOCK_ROOT/device-$DEVICE_UDID.lock"
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
        echo "pidstart=$(pid_start_token $$)"
        echo "started=$(date +%s)"
        echo "startedLocal=$(date '+%Y-%m-%d %H:%M:%S')"
        echo "device=$DEVICE_UDID"
        echo "script=${SCRIPT_NAME:-device-install}"
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

    # Owner identity, not just a live pid: a recycled pid would make a dead
    # session's lock look alive and every later install would wait out the full
    # timeout for a process that is not there (lib/pid-identity.sh).
    if pid_is_owner "$pid" "$(lock_field pidstart)"; then
      if [ "$waited" -ge "$LOCK_WAIT_SECS" ]; then
        echo "DEVICE BUSY: pid $pid has held $LOCK_DIR for ${age}s and is still running."
        echo "  waited ${waited}s (POPLUR_DEVICE_LOCK_WAIT=$LOCK_WAIT_SECS) — refusing to install over another session."
        echo "  holder: $(tr '\n' ' ' < "$LOCK_DIR/owner" 2>/dev/null)"
        echo "  build product kept at $APP — re-run the install by hand once the device is free."
        return 1
      fi
      [ $(( waited % 30 )) -eq 0 ] && echo "waiting for ${DEVICE_LABEL:-the device}: pid $pid holds the device lock (${age}s, waited ${waited}s)"
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

    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      # The number is in use, but by something else — say so precisely rather
      # than "gone", which would send anyone reading this hunting a live pid.
      echo "breaking stale device lock: pid $pid was RECYCLED (now $(ps -p "$pid" -o comm= 2>/dev/null | sed 's|.*/||'), not the owner) — lock age ${age}s"
    else
      echo "breaking stale device lock: owner pid ${pid:-unknown} is gone (lock age ${age}s)"
    fi
    rm -rf "$LOCK_DIR"
    # Loop round and try to claim it; if another waiter won the race we just wait.
  done
}

trap release_device_lock EXIT INT TERM

claim_device() {
  echo "=== taking device lock for $DEVICE_UDID ==="
  take_device_lock || return 1
  echo "=== device lock held (pid $$) ==="
}

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

# Sets VERIFIED / INSTALLED_URL / ON_DEVICE_URL; returns non-zero when the
# container on the phone is not the one $INSTALL_JSON says was written.
verify_installed_container() {  # <where to write the device read>
  local app_info_json="$1" info_rc
  INSTALLED_URL=$(container_url "$INSTALL_JSON" install)
  echo "=== verifying the installed container ==="
  xcrun devicectl device info apps --device "$DEVICE_UDID" --bundle-id "$BUNDLE_ID" \
    --json-output "$app_info_json" >/dev/null 2>&1
  info_rc=$?
  ON_DEVICE_URL=$(container_url "$app_info_json" info)

  VERIFIED=0
  if [ -z "$INSTALLED_URL" ]; then
    echo "VERIFY FAILED: no installationURL for $BUNDLE_ID in $INSTALL_JSON"
  elif [ "$info_rc" -ne 0 ] || [ -z "$ON_DEVICE_URL" ]; then
    echo "VERIFY FAILED: could not read the installed app back from the device (devicectl rc=$info_rc)"
    echo "  install wrote: $INSTALLED_URL"
    echo "  device info:   $app_info_json"
  elif [ "$INSTALLED_URL" != "$ON_DEVICE_URL" ]; then
    echo "VERIFY FAILED: the container on ${DEVICE_LABEL:-the device} is NOT the one this build installed."
    echo "  this build installed: $INSTALLED_URL"
    echo "  device now reports:   $ON_DEVICE_URL"
    echo "  Another session installed over it. Nothing was launched."
    echo "  This build stays at ${APP:-$DD} (provenance: ${PROV:-$DD/BUILD-PROVENANCE.txt}) — re-run the install to claim the device."
  else
    VERIFIED=1
    echo "=== verified: $ON_DEVICE_URL ==="
  fi
  [ "$VERIFIED" = 1 ] || { echo "INSTALL VERIFICATION FAILED — build product kept at ${APP:-$DD}"; return 1; }
  return 0
}

# --- launch (only ever on a verified container) ------------------------------
# Launching "whatever is on the phone" is exactly the 2026-09-05 failure, so this
# refuses on anything but a container this run has just proved. Every caller —
# --launch after an install, or --launch-only later — comes through here.
launch_app() {
  if [ "$VERIFIED" != 1 ]; then
    echo "REFUSING TO LAUNCH: the installed container was not verified as this build's."
    return 1
  fi
  echo "=== launching $BUNDLE_ID ==="
  xcrun devicectl device process launch --terminate-existing --device "$DEVICE_UDID" "$BUNDLE_ID" \
    --json-output "$DD/launch.json" 2>&1 | tail -10
  local launch_rc=${PIPESTATUS[0]}
  if [ "$launch_rc" -ne 0 ]; then
    echo "LAUNCH FAILED (exit $launch_rc) — the app IS installed and verified at $ON_DEVICE_URL"
    return "$launch_rc"
  fi
  return 0
}
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
install_attempt() {
  rm -f "$INSTALL_JSON"
  xcrun devicectl device install app --device "$DEVICE_UDID" "$APP" \
    --json-output "$INSTALL_JSON" 2>&1 | tail -15
  # devicectl's own status, not tail's. Must be read on the very next line —
  # any intervening command resets PIPESTATUS.
  return "${PIPESTATUS[0]}"
}
install_to_device() {
  echo "=== installing on ${DEVICE_LABEL:-the device} ==="
  install_attempt
  local install_rc=$?
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
    echo "  retry by hand: xcrun devicectl device install app --device $DEVICE_UDID \"$APP\""
    return "$install_rc"
  fi
  return 0
}


