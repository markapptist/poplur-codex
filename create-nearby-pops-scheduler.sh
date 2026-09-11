#!/bin/zsh
# One-time: create the hourly Cloud Scheduler job that triggers the
# nearbyPopsDigest Cloud Run service (deployed by deploy-nearby-pops-digest.sh).
# Mirrors the shape Firebase creates for its own scheduled functions
# (firebase-schedule-radiusDecay-us-central1): POST, OIDC token from the
# compute service account, audience = service URL, 300 s attempt deadline.
# The service already grants that account roles/run.invoker.
set -euo pipefail
URL=$(gcloud run services describe nearbypopsdigest --region us-central1 --project poplur2025 --format='value(status.url)')
echo "service url: $URL"
gcloud scheduler jobs create http firebase-schedule-nearbyPopsDigest-us-central1 \
  --location us-central1 --project poplur2025 \
  --schedule "every 60 minutes" --time-zone UTC \
  --uri "$URL" --http-method POST \
  --oidc-service-account-email 440480901104-compute@developer.gserviceaccount.com \
  --oidc-token-audience "$URL" \
  --attempt-deadline 300s \
  --headers User-Agent=Google-Cloud-Scheduler \
  --description "Hourly nearby pops digest push (functions-digest codebase, Cloud Run gen2)"
gcloud scheduler jobs describe firebase-schedule-nearbyPopsDigest-us-central1 \
  --location us-central1 --project poplur2025 --format='value(state,schedule,httpTarget.uri)'
