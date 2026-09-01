#!/bin/bash
# Turn an Instruments "Animation Hitches" .trace into per-screen frame numbers.
#
#   .codex/trace-fps.sh feed.trace [label]
#
# Measures START-TO-START intervals from hitches-frame-lifetimes. That table's
# own `duration` column is frame LIFETIME — how long a frame lives in the render
# pipeline, ~3 vsyncs deep — so a healthy 60fps screen reports ~50ms there.
# Reading that as frame time makes every screen look broken. The gap between
# successive frames is what a person actually sees.
#
# Two xctrace quirks this works around:
#   - it must be run from a shell; spawning it from node segfaults
#   - `export` intermittently exits without writing anything, so retry
#
# A static screen legitimately produces almost no frames — the instrument
# records while the app renders. Interact with the screen during the recording,
# and treat a tiny frame count as "not measured", never as a good result.
set -uo pipefail
TRACE="${1:?usage: trace-fps.sh <file.trace> [label]}"
LABEL="${2:-$(basename "$TRACE" .trace)}"
OUT=$(mktemp -t tracefps)

for attempt in 1 2 3 4; do
  xcrun xctrace export --input "$TRACE" \
    --xpath '/trace-toc/run[@number="1"]/data/table[@schema="hitches-frame-lifetimes"]' \
    >"$OUT" 2>/dev/null
  [ -s "$OUT" ] && break
  sleep 1
done

python3 -c '
import sys, re
label, path = sys.argv[1], sys.argv[2]
data = open(path, encoding="utf-8", errors="replace").read()
starts = sorted(int(m) for m in re.findall(r"<start-time[^>]*>(\d+)</start-time>", data))
if len(starts) < 30:
    print(f"{label:<22} NOT MEASURED — only {len(starts)} frames. Screen was idle, or the export failed.")
    sys.exit(2)
gaps = sorted((b - a) / 1e6 for a, b in zip(starts, starts[1:]))
pct = lambda p: gaps[min(len(gaps) - 1, int(len(gaps) * p))]
p50, p90, p99 = pct(.5), pct(.9), pct(.99)
# A hitch is a frame that missed its slot: 20ms is past a 60Hz vsync (16.7ms)
# without flagging ordinary jitter.
hitch = sum(1 for g in gaps if g > 20)
print(f"{label:<22} fps {1000/p50:3.0f}  p50 {p50:5.1f}ms  p90 {p90:5.1f}ms  "
      f"p99 {p99:6.1f}ms  worst {gaps[-1]:5.0f}ms  hitches {hitch}/{len(gaps)} ({100*hitch/len(gaps):.1f}%)")
' "$LABEL" "$OUT"
rc=$?
rm -f "$OUT"
exit $rc
