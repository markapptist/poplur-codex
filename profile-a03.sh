#!/bin/bash
# Frame-time profile of the Poplur Android app on a physical low-tier device
# (the Galaxy A03s is the reference: 2.8GB RAM, Android 13). Run after every
# build/install so Android lag is caught the moment it lands.
#
#   .codex/profile-a03.sh            profile, append to history, report
#   .codex/profile-a03.sh --quiet    only print if something regressed
#
# Why gfxinfo and not the web profiler: the app renders through a WebView, and
# gfxinfo reports what the device actually presented — including the compositor
# — for whatever is on screen. It needs no debug socket, so it works on release
# builds too. GPU percentiles come with it, which is the useful part: when total
# frame time is high and gpu time is low, the cost is main-thread JS, not
# drawing, and shaving geometry will not help.

# Load guard. gfxinfo frame times are WALL CLOCK, so a busy Mac inflates them
# through the USB/adb path and the profile reports a regression that does not
# exist. Measured 2026-08-19: on ONE unchanged build, map p50 read 36ms and
# 250ms fifty-five seconds apart while a gradle build held the machine at load
# 700-825. The thermal gate already refuses to be trusted above ~load 20; the
# same rule applies here.
MAX_LOAD="${POPLUR_PROFILE_MAX_LOAD:-20}"
LOAD1="$(sysctl -n vm.loadavg | awk '{print $2}' | cut -d. -f1)"
if [ "${LOAD1:-0}" -gt "$MAX_LOAD" ]; then
  echo "profile-a03: load ${LOAD1} is above ${MAX_LOAD} — SKIPPING." >&2
  echo "  Frame times measured under contention are not evidence of anything." >&2
  echo "  Re-run on a quiet machine, or set POPLUR_PROFILE_MAX_LOAD to override." >&2
  exit 0
fi

set -uo pipefail

PKG=com.apptists.poplur2025
ADB="$HOME/Library/Android/sdk/platform-tools/adb"
HISTORY="$(dirname "$0")/a03-perf-history.jsonl"
QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

# A physical device, never the emulator — an emulator's frame times say nothing
# about what a low-tier phone does.
SERIAL=$($ADB devices | awk '$2=="device" && $1 !~ /^emulator-/ {print $1; exit}')
if [ -z "$SERIAL" ]; then
  echo "profile-a03: no physical device attached — skipping (emulators are not a substitute)."
  exit 0
fi
sh() { $ADB -s "$SERIAL" shell "$@" 2>/dev/null; }

if ! sh pm list packages | grep -q "$PKG"; then
  echo "profile-a03: $PKG is not installed on $SERIAL — build and install first."
  exit 0
fi

# Screen-relative gesture targets: the tab cube sits bottom-centre and is only
# ~180px wide, so a swipe that starts outside it scrolls the feed instead of
# changing tab.
SIZE=$(sh wm size | grep -o '[0-9]*x[0-9]*' | head -1)
W=${SIZE%x*}; H=${SIZE#*x}
CUBE_Y=$((H * 7 / 8)); CUBE_L=$((W / 2 + 65)); CUBE_R=$((W / 2 - 65))

measure() { # $1 = label; echoes "label 50th 90th 99th janky% frames"
  sh dumpsys gfxinfo "$PKG" reset >/dev/null
  for _ in 1 2 3 4 5 6; do sh input swipe $((W/2)) $((H*3/4)) $((W/2)) $((H/3)) 350 >/dev/null; done
  sh dumpsys gfxinfo "$PKG" | awk -v l="$1" '
    /Total frames rendered:/ {f=$4}
    /^Janky frames:/         {j=$3}
    /^50th percentile:/      {p50=$3}
    /^90th percentile:/      {p90=$3}
    /^99th percentile:/      {p99=$3}
    /50th gpu percentile:/   {g50=$4}
    END {gsub(/ms/,"",p50); gsub(/ms/,"",p90); gsub(/ms/,"",p99); gsub(/ms/,"",g50)
         # "Janky frames: 123 (93.18%)" — $3 is the COUNT, not the percent.
         # It was being printed straight into a %%-suffixed column, which is
         # why the history is full of "janky 161%" and why the number so often
         # equalled the frame count exactly. Convert it here, once.
         jp = (f+0 > 0) ? int((j+0) * 100 / (f+0)) : 0
         printf "%s %s %s %s %s %s %s\n", l, p50+0, p90+0, p99+0, jp, f+0, g50+0}'
}

sh am force-stop "$PKG"
sh monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null
# Wait for real rendering rather than a fixed sleep: the WebView home takes
# markedly longer to first paint on a low-tier device than on any emulator.
for _ in $(seq 1 40); do
  frames=$(sh dumpsys gfxinfo "$PKG" | awk '/Total frames rendered:/{print $4}')
  [ "${frames:-0}" -gt 60 ] 2>/dev/null && break
  sleep 2
done
sleep 6

FEED=$(measure feed)
# Two cube swipes: feed -> profile -> map.
for _ in 1 2; do sh input swipe $CUBE_L $CUBE_Y $CUBE_R $CUBE_Y 250 >/dev/null; sleep 9; done
sleep 12
MAP=$(measure map)

STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
{ echo "$FEED"; echo "$MAP"; } | while read -r l p50 p90 p99 j f g50; do
  # A zero-frame run is not a data point. Writing it stored gfxinfo's
  # empty-histogram 4950ms as a real p50, which then became the baseline the
  # NEXT run was judged against — so one void sample manufactured a regression
  # twice: once as the reading, once as the yardstick.
  [ "${f:-0}" -lt 1 ] 2>/dev/null && continue
  printf '{"at":"%s","device":"%s","screen":"%s","p50":%s,"p90":%s,"p99":%s,"janky":%s,"frames":%s,"gpu_p50":%s}\n' \
    "$STAMP" "$SERIAL" "$l" "$p50" "$p90" "$p99" "$j" "$f" "$g50" >> "$HISTORY"
done

# Compare against the previous run of the same screen, so a regression is
# reported the build it appears in rather than discovered weeks later.
regressed=0
report=""
for row in "$FEED" "$MAP"; do
  set -- $row; l=$1; p50=$2; p90=$3; p99=$4; j=$5; f=$6; g50=$7
  # NO FRAMES, NO VERDICT.
  #
  # gfxinfo does not report "unknown" for an empty histogram — it reports
  # 4950ms at every percentile, with 0% janky. Those two together are the
  # signature of a measurement that never happened, and they are impossible as
  # a real reading: a 4.95s frame cannot be 0% janky. Read literally they look
  # like a catastrophic regression, and this loop used to report one, three
  # runs in a row, ratcheting the "previous" baseline higher each time it
  # wrote the phantom to history.
  #
  # A screen can legitimately render nothing: a settled WebView presents no
  # frames at idle, which is precisely the quiet this app works to achieve. So
  # zero frames means the sample is void — say so, and do not poison the
  # baseline or fire the hook.
  if [ "${f:-0}" -lt 1 ] 2>/dev/null; then
    report="$report$(printf '  %-5s no frames rendered — sample void (app not foregrounded on this screen?)\n' "$l")\n"
    continue
  fi
  prev=$(grep "\"screen\":\"$l\"" "$HISTORY" 2>/dev/null | tail -2 | head -1 | sed -n 's/.*"p50":\([0-9]*\).*/\1/p')
  delta=""
  if [ -n "$prev" ] && [ "$prev" -gt 0 ] 2>/dev/null; then
    diff=$((p50 - prev))
    delta=" (prev ${prev}ms)"
    # >20% worse and at least 8ms: noise on a thermally-throttled phone is real,
    # so a small wobble must not cry wolf every build.
    if [ $diff -gt 8 ] && [ $((diff * 100 / prev)) -gt 20 ]; then regressed=1; delta="$delta  REGRESSED +${diff}ms"; fi
  fi
  # The 4950 sentinel again, in the GPU field this time. A frame histogram can
  # have samples while the GPU one has none (not every driver reports it), so
  # the frames>0 guard above does not catch this — and 4950 sails past
  # "g50 > p50/2", labelling a main-thread-bound screen "gpu-bound". That is
  # the one misreading this tool must never make: its own header says a low GPU
  # time means the cost is JS and shaving geometry will not help, so a false
  # gpu-bound sends you off optimising the wrong thing entirely.
  if [ "${g50:-0}" -ge 4950 ] 2>/dev/null || [ "${g50:-0}" -le 0 ] 2>/dev/null; then
    bound="main-thread?"   # no GPU histogram — bound is unmeasured, not proven
  else
    bound="main-thread"; [ "$g50" -gt $((p50 / 2)) ] 2>/dev/null && bound="gpu"
  fi
  report="$report$(printf '  %-5s p50 %4sms  p90 %4sms  p99 %5sms  janky %3s%%  %s-bound%s\n' \
    "$l" "$p50" "$p90" "$p99" "$j" "$bound" "$delta")\n"
done

if [ $QUIET -eq 0 ] || [ $regressed -eq 1 ]; then
  echo "A03 frame profile — $STAMP — $SERIAL"
  printf "%b" "$report"
  [ $regressed -eq 1 ] && echo "  ^ regression vs previous build"
fi
# Exit 2 on regression: run from a hook with asyncRewake, that is what pulls
# Claude back to look at it. A clean run stays silent and exits 0, so the only
# time this interrupts anyone is when the phone actually got slower.
[ $regressed -eq 1 ] && exit 2
exit 0
