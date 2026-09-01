#!/bin/bash
# MAP-RETURN leg — the tab-cycle soak that prices coming BACK to a parked map.
#
# Why this leg exists: the 20 Aug burn (nominal->fair in 7m21s) was mount churn,
# and half of it was the map fully rebuilding on every return. The 75s grace
# park fixed the rebuild; the 21 Aug work fixed what was left — a return used to
# replay the whole ambient decoration showcase for a camera that had not moved
# (109 Mapbox frames -> 1, headless). NEITHER fix has ever been measured on
# hardware. This leg is that measurement.
#
# The tab switching CANNOT be automated — a human holds the phone. This script
# is the operator's half: it gates, launches, calls the cadence out loud, runs
# the pull loop alongside, and parses at the end.
#
#   ./map-return-leg.sh <leg-name> [duration-seconds] [dwell-seconds]
#
# CADENCE MATTERS. Returns must land INSIDE the 75s iOS grace window or the map
# is dropped and rebuilt, which is a different code path and not what this leg
# prices. Default 8s dwell reproduces the 2-10s cycling of the original burn.
set -o pipefail

LEG="${1:?usage: map-return-leg.sh <leg-name> [duration] [dwell]}"
DURATION="${2:-600}"
DWELL="${3:-8}"
SPEAK="${SPEAK:-1}"

DEVICE=339089BF-8115-5788-B719-5967E503A27B
BUNDLE=com.apptist.Poplur2025
ROOT="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"

pull() {
  xcrun devicectl device copy from --device "$DEVICE" \
    --domain-type appDataContainer --domain-identifier "$BUNDLE" \
    --source Documents/poplur-diag.log --destination "$1" >/dev/null 2>&1
}

say_now() { [ "$SPEAK" = "1" ] && say -r 220 "$1" >/dev/null 2>&1 & }

echo "── gate ─────────────────────────────────────────────────────────"
for pid in $(xcrun devicectl device info processes --device "$DEVICE" 2>/dev/null \
             | grep 'Poplur2025.app/Poplur2025' | awk '{print $1}'); do
  echo "  terminating pid $pid"
  xcrun devicectl device process terminate --device "$DEVICE" --pid "$pid" >/dev/null 2>&1
done
pull "$TMP/gate.log" || { echo "  cannot pull log — device locked?"; exit 1; }
THERMAL="$(grep '\[PoplurThermal\]' "$TMP/gate.log" | tail -1 | sed 's/.*\[PoplurThermal\] \([a-z]*\).*/\1/')"
CHARGING="$(grep -o 'charging=[a-z]*' "$TMP/gate.log" | tail -1)"
BATTERY="$(grep -o 'battery=[0-9]*%' "$TMP/gate.log" | tail -1)"
echo "  thermal=$THERMAL  $CHARGING  $BATTERY"
if [ "$THERMAL" != "nominal" ]; then
  echo "  ABORT: baseline is '$THERMAL', not nominal. Cool down and retry (>=8 min)." >&2
  exit 1
fi
if [ "$CHARGING" = "charging=true" ]; then
  echo "  WARNING: phone is PLUGGED IN. Charging adds heat and never rests the SoC," >&2
  echo "           so a 'fair' reading here is not attributable to the app. Unplug for" >&2
  echo "           the real leg; continuing only gives you a plugged-in comparison." >&2
fi

echo
echo "── launch ───────────────────────────────────────────────────────"
xcrun devicectl device process launch --device "$DEVICE" --terminate-existing "$BUNDLE" 2>&1 | tail -1
LAUNCH_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# THE REAL GATE READING. `charging=`/`thermal=` in a pulled log are only written
# when the app logs a thermal line, so a pre-launch pull reports whatever was
# true at the LAST launch — unplugging the phone thirty seconds ago does not
# show up. The fresh `reason=start` line this launch just wrote is the only
# trustworthy reading, and it is worth 20s to check it before committing a
# person to ten minutes of holding a phone.
sleep 20
pull "$TMP/start.log"
START_LINE="$(grep '\[PoplurThermal\].*reason=start' "$TMP/start.log" | tail -1)"
echo "  gate line: ${START_LINE:-<none — app may not have launched>}"
START_THERMAL="$(printf '%s' "$START_LINE" | sed 's/.*\[PoplurThermal\] \([a-z]*\).*/\1/')"
START_CHARGING="$(printf '%s' "$START_LINE" | grep -o 'charging=[a-z]*')"
if [ "$START_THERMAL" != "nominal" ]; then
  echo "  ABORT: leg started at '$START_THERMAL', not nominal." >&2; exit 1
fi
if [ "$START_CHARGING" = "charging=true" ] && [ "${FORCE:-0}" != "1" ]; then
  echo >&2
  echo "  ABORT: phone is PLUGGED IN as of this launch. Charging adds heat and" >&2
  echo "  never rests the SoC, so a 'fair' here is not attributable to the app." >&2
  echo "  Unplug and re-run, or set FORCE=1 for a deliberate plugged data point." >&2
  for pid in $(xcrun devicectl device info processes --device "$DEVICE" 2>/dev/null \
               | grep 'Poplur2025.app/Poplur2025' | awk '{print $1}'); do
    xcrun devicectl device process terminate --device "$DEVICE" --pid "$pid" >/dev/null 2>&1
  done
  exit 1
fi
echo "  gate OK: thermal=$START_THERMAL $START_CHARGING"

BASE_LAUNCHES="$(grep -c '=== LAUNCH ===' "$TMP/start.log")"
"$ROOT/pull-loop.sh" "$LEG" "$DURATION" 45 &
PULL_PID=$!
echo "  pull loop running (pid $PULL_PID) — live status interleaves below"

echo
echo "── cadence ──  MAP is every other stop. Hold the phone, watch the map."
echo "               On each RETURN note: does the world sit STILL until you"
echo "               touch it? That is the fix being exercised. A loading globe"
echo "               instead means the grace window expired — cadence too slow."
echo
OTHERS=(feed profile post feed profile camera)
END=$(( $(date +%s) + DURATION ))
STEP=0
while [ "$(date +%s)" -lt "$END" ]; do
  if [ $((STEP % 2)) -eq 0 ]; then TARGET="map"; else TARGET="${OTHERS[$(( (STEP/2) % ${#OTHERS[@]} ))]}"; fi
  printf '%s  %4ds  ->  %s\n' "$(date -u +%H:%M:%S)" "$(( $(date +%s) - END + DURATION ))" "$TARGET"
  say_now "$TARGET"
  STEP=$((STEP + 1))
  if [ $((STEP % 8)) -eq 0 ]; then
    NEWEST="$(ls -t "$ROOT/raw/$LEG"-*/pull-*.log 2>/dev/null | head -1)"
    if [ -n "$NEWEST" ]; then
      N_LAUNCH="$(grep -c '=== LAUNCH ===' "$NEWEST")"
      if [ "$N_LAUNCH" -gt "$BASE_LAUNCHES" ]; then
        echo
        echo "  *** ABORT: the app RELAUNCHED mid-leg (launch markers $BASE_LAUNCHES -> $N_LAUNCH)."
        echo "  *** A relaunch re-fronts home and resets the surface under test, so this"
        echo "  *** leg is void. Ask what happened on the phone (crash? force-quit?),"
        echo "  *** then re-run. Not burning the rest of your ten minutes."
        kill $PULL_PID 2>/dev/null
        say_now "leg void, app relaunched"
        break
      fi
    fi
  fi
  sleep "$DWELL"
done

echo
echo "── close ────────────────────────────────────────────────────────"
wait $PULL_PID 2>/dev/null
END_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
OUT="$(ls -td "$ROOT/raw/$LEG"-* 2>/dev/null | head -1)"
for pid in $(xcrun devicectl device info processes --device "$DEVICE" 2>/dev/null \
             | grep 'Poplur2025.app/Poplur2025' | awk '{print $1}'); do
  xcrun devicectl device process terminate --device "$DEVICE" --pid "$pid" >/dev/null 2>&1
done
echo
echo "leg=$LEG  launch=$LAUNCH_UTC  end=$END_UTC"
echo "raw pulls: $OUT"
echo
if [ -n "$OUT" ] && [ -f "$OUT/final.log" ]; then
  echo "── leg validity ─────────────────────────────────────────────────"
  echo "  launch markers in final pull: $(grep -c '=== LAUNCH ===' "$OUT/final.log") (baseline $BASE_LAUNCHES; more = VOID)"
  # SCOPE THESE TO THE LEG. poplur-diag.log is append-only and carries every
  # prior session, so an unscoped grep reports HISTORY as if it were this leg.
  # On 2026-08-22 that read "6 map returns / 27 tab commits" for a leg whose
  # window actually contained 0 and 1 — a leg that exercised nothing looked
  # valid. The window starts at $LAUNCH_UTC; lexical compare works because the
  # timestamps are fixed-width ISO-8601 Z.
  legwin() { awk -v t="$LAUNCH_UTC" '$0 >= t' "$OUT/final.log"; }
  echo "  map returns actually committed: $(legwin | grep -c '\[WebTab\] committed=map previous=') (in-leg; whole file has $(grep -c '\[WebTab\] committed=map previous=' "$OUT/final.log"))"
  echo "  total tab commits:              $(legwin | grep -c '\[WebTab\] committed=') (in-leg; whole file has $(grep -c '\[WebTab\] committed=' "$OUT/final.log"))"
  echo "  fence/background lines:         $(legwin | grep -c 'BackgroundFence\|background-before-fence\|displayActive:false') (in-leg; non-zero here means the display locked and the leg is DEAD)"
  echo "  thermal transitions (<-- CHANGED): $(grep -c 'CHANGED' "$OUT/final.log")"
  echo
fi
echo "parse:  python3 $ROOT/parse-soak.py $OUT/final.log $LAUNCH_UTC $END_UTC"
rm -rf "$TMP"
