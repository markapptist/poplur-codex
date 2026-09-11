#!/usr/bin/env python3
"""Make the iOS app icon artwork fill its tile.

Every AppIcon*.appiconset master in Poplur2025-iOS (the primary and the eleven
alternates) is a 1024x1024 PNG whose artwork stops 37-69 px short of the edge,
with pure black around it. iOS masks the whole 1024 canvas, so the home screen
shows a black frame around a smaller tile (reported 11 Sep 2026).

This crops each master to its non-black bounding box (squared, centred),
resizes it back to 1024, then regenerates every size listed in the set's
Contents.json from that master. It edits the supplied artwork only by cropping
and scaling — nothing is drawn. Run with --dry-run to see the crop boxes.

    python3 .codex/fix-app-icon-margins.py --dry-run
    python3 .codex/fix-app-icon-margins.py            # applies; review with git diff --stat
"""
import glob, json, os, sys
from PIL import Image, ImageFile

# Some supplied masters end without the trailing IEND chunk; PIL refuses them by
# default although every pixel is present. Decode what is there.
ImageFile.LOAD_TRUNCATED_IMAGES = True

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "Poplur2025-iOS", "Poplur2025", "Assets.xcassets")
THRESHOLD = 40  # a pixel is "artwork" when any channel exceeds this
DRY = "--dry-run" in sys.argv

def artwork_bbox(im):
    r, g, b = im.convert("RGB").split()
    lit = lambda ch: ch.point(lambda v: 255 if v > THRESHOLD else 0)
    return Image.merge("RGB", (lit(r), lit(g), lit(b))).convert("L").point(lambda v: 255 if v > 0 else 0).getbbox()

def square_box(bb, w, h):
    l, t, r, b = bb
    side = max(r - l, b - t)
    cx, cy = (l + r) // 2, (t + b) // 2
    x0, y0 = max(0, min(w - side, cx - side // 2)), max(0, min(h - side, cy - side // 2))
    return (x0, y0, x0 + side, y0 + side)

changed = 0
for master in sorted(glob.glob(os.path.join(ROOT, "AppIcon*.appiconset", "Icon-App-1024x1024@1x.png"))):
    folder = os.path.dirname(master)
    im = Image.open(master)
    w, h = im.size
    box = square_box(artwork_bbox(im), w, h)
    fill = (box[2] - box[0]) / w * 100
    print(f"{os.path.basename(folder):26s} crop {box} — artwork filled {fill:.0f}% of the tile")
    if DRY or fill >= 99:
        continue
    fixed = im.crop(box).resize((1024, 1024), Image.LANCZOS)
    fixed.save(master, optimize=True)
    with open(os.path.join(folder, "Contents.json")) as f:
        contents = json.load(f)
    for entry in contents["images"]:
        name = entry.get("filename")
        if not name or name == os.path.basename(master):
            continue
        pts = float(entry["size"].split("x")[0])
        scale = int(entry["scale"].rstrip("x"))
        px = round(pts * scale)
        fixed.resize((px, px), Image.LANCZOS).save(os.path.join(folder, name), optimize=True)
    changed += 1

print("dry run — nothing written" if DRY else f"rewrote {changed} icon set(s)")
