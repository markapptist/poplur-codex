#!/bin/zsh
# Deploy nearbyPopsDigest (Poplur2025-iOS/functions-digest) to Cloud Run.
#
# Why not `firebase deploy`: on 11 Sep 2026 every Cloud Functions deploy in this
# project — the 195 MiB main codebase AND this 50 KB one — failed Cloud Run's
# 240 s startup probe with zero log lines. Build-log diff showed all failures
# were built on Google's new run image (nodejs22_20260902) under the default
# gen1 sandbox, while every healthy function still runs on the 19 Aug image.
# The same source deploys and serves immediately on the gen2 execution
# environment, which `firebase deploy` cannot request. So this codebase is
# deployed with `gcloud run deploy --function`, which uses the same buildpack
# and functions-framework injection as Cloud Functions.
#
# lib/ is gitignored here, so it is rebuilt and tested before every upload;
# .gcloudignore ships lib/ but not node_modules/.
#
# The hourly trigger is a Cloud Scheduler job created once (11 Sep 2026):
#   firebase-schedule-nearbyPopsDigest-us-central1 → POST <service url>, OIDC as
#   440480901104-compute@developer.gserviceaccount.com. It survives redeploys.
set -euo pipefail
cd /Users/matrix/Developer/Poplur2025-iOS/functions-digest
[[ -d node_modules ]] || npm ci --no-fund --no-audit
npm run build
node scripts/testNearbyPopsPolicy.js
gcloud run deploy nearbypopsdigest \
  --source . --function nearbyPopsDigest \
  --region us-central1 --project poplur2025 \
  --execution-environment gen2 --memory 512Mi --cpu 1 --max-instances 1 --timeout 300 \
  --no-allow-unauthenticated \
  --set-env-vars 'GCLOUD_PROJECT=poplur2025,FIREBASE_CONFIG={"projectId":"poplur2025"}' \
  --quiet
gcloud run services describe nearbypopsdigest --region us-central1 --project poplur2025 \
  --format='value(status.latestReadyRevisionName,status.url)'
