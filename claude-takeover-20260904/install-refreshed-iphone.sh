#!/bin/bash
set -euo pipefail
ROOT=/Users/matrix/Developer
CHECKPOINT="$ROOT/.codex/claude-takeover-20260904"
DD="$ROOT/.codex/build-products/ios-iphone-20260904-222946"
APP="$DD/Build/Products/Debug-iphoneos/Poplur2025.app"
DEVICE=339089BF-8115-5788-B719-5967E503A27B
if pgrep -x xcodebuild >/dev/null; then
  echo 'Another Xcode build is active; retry after it finishes.' >&2
  exit 1
fi
"$ROOT/.codex/prune-build-products.sh" --hold "$DD" 6
cd "$ROOT/Poplur2025-iOS"
xcodebuild -project Poplur2025.xcodeproj -scheme Poplur2025 \
  -configuration Debug -destination generic/platform=iOS \
  -derivedDataPath "$DD" -jobs 2 -allowProvisioningUpdates build \
  > "$CHECKPOINT/iphone-refresh-build.log" 2>&1
python3 "$CHECKPOINT/verify-bundles.py" "$APP"
python3 - "$APP" "$CHECKPOINT" <<'PY'
import datetime, hashlib, json, pathlib, subprocess, sys
app = pathlib.Path(sys.argv[1]); out = pathlib.Path(sys.argv[2])
repos = ['poplur-clay-map', 'Poplur2025-iOS', 'Poplur2025-Android', 'Poplur2025-ReactNative']
commits = {r: subprocess.check_output(['git','-C','/Users/matrix/Developer/'+r,'rev-parse','HEAD'],text=True).strip() for r in repos}
record = {'builtAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'app': str(app), 'commits': commits,
          'binarySha256': hashlib.sha256((app/'Poplur2025').read_bytes()).hexdigest(),
          'webEntry': (app/'ClayMapWeb/index.html').read_text()}
(out/'iphone-build-provenance.json').write_text(json.dumps(record,indent=2)+'\n')
PY
xcrun devicectl device install app --device "$DEVICE" "$APP" \
  --json-output "$CHECKPOINT/iphone-final-install.json"
xcrun devicectl device process launch --terminate-existing --device "$DEVICE" com.apptist.Poplur2025 \
  --json-output "$CHECKPOINT/iphone-final-launch.json"
xcrun devicectl device info apps --device "$DEVICE" --bundle-id com.apptist.Poplur2025 \
  --json-output "$CHECKPOINT/iphone-final-app.json"
echo 'Refreshed iPhone bundle built, verified, installed, and launched.'
