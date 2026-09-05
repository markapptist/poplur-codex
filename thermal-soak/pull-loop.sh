#!/bin/bash
# The operator half of an ACTIVE thermal-soak leg (PROTOCOL.md step 2).
#
# PROTOCOL.md has referenced `pull-loop.sh <leg> <seconds>` since the first run
# but the script was never written, so every leg was driven by hand — which is
# part of why four camera attempts died on operator availability. This is it.
#
# Pulls Documents/poplur-diag.log every INTERVAL seconds for DURATION seconds
# and keeps EVERY pull (a byte-identical pull means nothing happened, which is
# itself a reading — see PROTOCOL.md). The pull is read-only and does not
# disturb the app.
#
#   ./pull-loop.sh camera-60fps 600 [45]
#
# Prints a live one-line status per pull so an attended leg (camera, map) can be
# watched without a second terminal, and stops early and loudly if the app
# backgrounds — a display lock kills the leg and there is no point pulling for
# another nine minutes.
set -o pipefail

LEG="${1:?usage: pull-loop.sh <leg-name> <duration-seconds> [interval-seconds]}"
DURATION="${2:?usage: pull-loop.sh <leg-name> <duration-seconds> [interval-seconds]}"
INTERVAL="${3:-45}"

DEVICE=339089BF-8115-5788-B719-5967E503A27B
BUNDLE=com.apptist.Poplur2025
ROOT="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$ROOT/raw/$LEG-$STAMP"
mkdir -p "$OUT"

LAUNCH_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LAUNCH_EPOCH="$(date +%s)"
echo "leg=$LEG  start=$LAUNCH_UTC  duration=${DURATION}s  interval=${INTERVAL}s"
echo "pulls -> $OUT"
echo

pull() {
  xcrun devicectl device copy from \
    --device "$DEVICE" \
    --domain-type appDataContainer --domain-identifier "$BUNDLE" \
    --source Documents/poplur-diag.log --destination "$1" >/dev/null 2>&1
}

END=$(( $(date +%s) + DURATION ))
N=0
LAST_SUM=""
while [ "$(date +%s)" -lt "$END" ]; do
  N=$((N + 1))
  FILE="$(printf '%s/pull-%03d.log' "$OUT" "$N")"
  if ! pull "$FILE"; then
    echo "$(date -u +%H:%M:%S)  pull $N FAILED (device locked or unplugged?)"
    sleep "$INTERVAL"
    continue
  fi
  SUM="$(shasum -a 256 "$FILE" | cut -c1-12)"
  # Epoch arithmetic: `date -j -f` reads the Z-suffixed stamp as LOCAL time and
  # printed -14400s for the first ten runs of this loop.
  ELAPSED=$(( $(date +%s) - LAUNCH_EPOCH ))
  THERMAL="$(grep '\[PoplurThermal\]' "$FILE" | tail -1 | sed 's/.*\[PoplurThermal\] \([a-z]*\).*/\1/')"
  OWNER="$(grep -o 'lastThermal=[^ }]*' "$FILE" | tail -1)"
  # A fenced app is a dead leg: the display locked, or the user switched away.
  # The key is JSON-quoted in the log, and older sessions above the launch
  # marker always carry a fence — only lines after THIS launch count.
  if [ "$N" -gt 1 ] && awk -v s="$LAUNCH_UTC" '$0 ~ "=== LAUNCH ===" && $1 >= s {f=1} f' "$FILE" | grep -q '"displayActive":false'; then
    FENCE="  <-- BACKGROUNDED, leg is dead (Auto-Lock?)"
  else
    FENCE=""
  fi
  if [ "$SUM" = "$LAST_SUM" ]; then CHANGED="(no change)"; else CHANGED="NEW"; fi
  LAST_SUM="$SUM"
  printf '%s  pull %03d  %4ds  thermal=%-8s %-34s %s%s\n' \
    "$(date -u +%H:%M:%S)" "$N" "$ELAPSED" "${THERMAL:-?}" "${OWNER:-lastThermal=-}" "$CHANGED" "$FENCE"
  sleep "$INTERVAL"
done

FINAL="$OUT/final.log"
pull "$FINAL"
END_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo
echo "final pull -> $FINAL"
echo "parse with:"
echo "  python3 $ROOT/parse-soak.py $FINAL $LAUNCH_UTC $END_UTC"
