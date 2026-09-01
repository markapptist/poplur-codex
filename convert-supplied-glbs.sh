#!/bin/bash
# One-off: decimate the two user-supplied Meshy GLBs (bell + kodak camera) into
# bundle-sized clay assets at public/ ROOT (never public/models/, which
# sync-mobile strips from every phone bundle).
#
# Recipe is the proven one from 9 Aug (16 Meshy cubes, 327MB -> 1.6MB):
#   --simplify-error 0.0005  (0.005 turns bevels lumpy, 0.0002 stays too big)
set -euo pipefail

TOOLS=/Users/matrix/Developer/.codex/gltf-tools
PUB=/Users/matrix/Developer/poplur-clay-map/public
DL=/Users/matrix/Downloads

mkdir -p "$TOOLS"
cd "$TOOLS"
if [ ! -x "$TOOLS/node_modules/.bin/gltf-transform" ]; then
  echo "installing @gltf-transform/cli (isolated — it conflicts with @google/model-viewer in the app dep tree)"
  npm init -y >/dev/null 2>&1 || true
  npm install --no-audit --no-fund @gltf-transform/cli >/dev/null 2>&1
fi
GT="$TOOLS/node_modules/.bin/gltf-transform"
echo "gltf-transform: $("$GT" --version 2>/dev/null || echo unknown)"

convert() {
  local src="$1" out="$2"
  echo "--- $(basename "$out") ---"
  echo "in:  $(ls -lh "$src" | awk '{print $5}')"
  "$GT" optimize "$src" "$out" \
    --compress draco \
    --texture-compress webp \
    --texture-size 256 \
    --simplify-error 0.0005 2>&1 | tail -5
  echo "out: $(ls -lh "$out" | awk '{print $5}')"
}

convert "$DL/Meshy_AI_poplur_bell_3d_0810000128_image-to-3d-texture.glb"          "$PUB/poplur_bell.glb"
convert "$DL/Meshy_AI_poplur_flash_camera_3_0810000137_image-to-3d-texture.glb"   "$PUB/poplur_camera_kodak.glb"

echo
echo "DONE"
ls -lh "$PUB/poplur_bell.glb" "$PUB/poplur_camera_kodak.glb"
