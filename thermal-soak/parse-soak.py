#!/usr/bin/env python3
"""Parse a pulled poplur-diag.log into a per-leg thermal timeline.

usage: parse-soak.py <log> <leg-start-utc> [<leg-end-utc>]
  timestamps like 2026-08-17T20:27:41Z (must match a === LAUNCH === marker
  or any instant; rows between start and end are reported with mm:ss elapsed).

Emits: every [PoplurThermal] line (state, battery, charging, lowPower, reason),
every [ResourceSnapshot] (rss, mode, fps, renderer, lastThermal attribution),
[WebResourceSnapshot] displayActive, [BackgroundFence], and LAUNCH markers.
Transitions are flagged; owner attribution is read from the next snapshot's
lastThermal=prev>state:owner field.
"""
import re
import sys
from datetime import datetime, timezone

TS = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})Z (.*)$")


def parse_ts(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)


def main():
    path, start = sys.argv[1], parse_ts(sys.argv[2].rstrip("Z"))
    end = parse_ts(sys.argv[3].rstrip("Z")) if len(sys.argv) > 3 else None
    rows = []
    for line in open(path, encoding="utf-8", errors="replace"):
        m = TS.match(line.strip())
        if not m:
            continue
        t, body = parse_ts(m.group(1)), m.group(2)
        if t < start or (end and t > end):
            continue
        el = int((t - start).total_seconds())
        mmss = f"{el//60:02d}:{el%60:02d}"
        if body.startswith("=== LAUNCH"):
            rows.append((mmss, "LAUNCH", body))
        elif "[PoplurThermal]" in body:
            changed = "<-- CHANGED" in body
            state = body.split("]")[1].split()[0]
            kv = dict(re.findall(r"(\w+)=([^\s]+)", body))
            tag = "TRANSITION" if changed else "thermal"
            rows.append((mmss, tag,
                         f"{state} battery={kv.get('battery')} charging={kv.get('charging')} "
                         f"lowPower={kv.get('lowPower')} reason={kv.get('reason')}"))
        elif "[ResourceSnapshot]" in body:
            kv = dict(re.findall(r"(\w+)=([^\s{}]+)", body))
            rows.append((mmss, "snapshot",
                         f"reason={kv.get('reason')} rssMB={kv.get('rssMB')} mode={kv.get('mode')} "
                         f"thermal={kv.get('thermal')} fps={kv.get('fps')} renderer={kv.get('renderer')} "
                         f"lastThermal={kv.get('lastThermal')}"))
        elif "[WebResourceSnapshot]" in body and "displayActive" in body:
            da = re.search(r'"displayActive":(\w+)', body)
            rows.append((mmss, "web", f"displayActive={da.group(1) if da else '?'}"))
        elif "[BackgroundFence]" in body:
            rows.append((mmss, "fence", body.split("]", 1)[1].strip()))
    for mmss, tag, detail in rows:
        mark = " <<<" if tag == "TRANSITION" else ""
        print(f"{mmss}  {tag:<10} {detail}{mark}")


if __name__ == "__main__":
    main()
