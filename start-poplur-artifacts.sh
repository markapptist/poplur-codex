#!/usr/bin/env bash

set -euo pipefail

ROOT="/Users/matrix/Developer"
STATE_DIR="$ROOT/.codex/artifact-workbench"
mkdir -p "$STATE_DIR"
chmod a-w "$ROOT/.claude/artifacts/gcl-prototype.html"

# Reclaim stale build products before the downstream sync below (which embeds a
# full map build) and before any build this session runs. Build products used to
# accumulate with no retention and filled the volume on 2026-08-21; the pruner
# never touches a directory a concurrent session is still building into. A
# failure here must not keep the workbench dark.
"$ROOT/.codex/prune-build-products.sh" --quiet || true

# The downstream sync embeds a full map build plus the thermal gate; its
# failure must not keep the workbench dark — the servers below are the first
# thing every session needs. Continue loudly instead of dying here.
if ! node "$ROOT/.codex/sync-gcl-downstream.mjs" --quiet; then
  echo "⚠️  sync-gcl-downstream.mjs FAILED — starting workbench servers anyway." >&2
  echo "    Downstream map bundles may be stale. Re-run after diagnosing:" >&2
  echo "    node $ROOT/.codex/sync-gcl-downstream.mjs" >&2
fi
node "$ROOT/.codex/generate-gcl-screen-tracking.mjs"
# Rough Copy is review-gated: only regenerate to bootstrap a missing catalog, and never let a
# refused regeneration abort workbench startup.
node "$ROOT/.codex/generate-rcl-catalog-data.mjs" --bootstrap || true

port_is_open() {
  lsof -tiTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

start_service() {
  local name="$1"
  local port="$2"
  local url="$3"
  shift 3

  if ! port_is_open "$port"; then
    nohup "$@" >"$STATE_DIR/$name.log" 2>&1 < /dev/null &
    echo $! >"$STATE_DIR/$name.pid"
  fi

  for _ in {1..120}; do
    if port_is_open "$port"; then
      return 0
    fi
    sleep 0.25
  done

  echo "Unable to start $name on port $port. See $STATE_DIR/$name.log" >&2
  return 1
}

start_service \
  "post-login" \
  "5173" \
  "http://127.0.0.1:5173/?view=home" \
  npm --prefix "$ROOT/poplur-clay-map" run dev -- --host 127.0.0.1 --port 5173 --strictPort

if ! port_is_open 5199; then
  launchctl remove com.poplur.clay-map-audio >/dev/null 2>&1 || true
  launchctl submit \
    -l com.poplur.clay-map-audio \
    -o "$STATE_DIR/clay-map-audio.log" \
    -e "$STATE_DIR/clay-map-audio.log" \
    -- "$(command -v node)" "$ROOT/poplur-clay-map/node_modules/vite/bin/vite.js" \
      "$ROOT/poplur-clay-map" --host 127.0.0.1 --port 5199 --strictPort
  for _ in {1..120}; do
    port_is_open 5199 && break
    sleep 0.25
  done
  port_is_open 5199 || {
    echo "Unable to start clay-map-audio on port 5199. See $STATE_DIR/clay-map-audio.log" >&2
    exit 1
  }
fi

start_service \
  "subscreens" \
  "8945" \
  "http://127.0.0.1:8945/.claude/artifacts/poplur-subscreen-twins.html" \
  python3 -m http.server 8945 --bind 127.0.0.1 --directory "$ROOT"

# Radius Lab: the Test Center (8084) drops one synthetic pin on the production map and rewrites
# its radius through this local admin-path service. Its own process on purpose: the desk's
# test-control proxy is supervised with keychain tokens and must never restart for lab work.
start_service \
  "radius-lab" \
  "8098" \
  "http://127.0.0.1:8098/health" \
  node "$ROOT/PoplurLandingPage-HTML/PoplurApp/scripts/radius-lab-server.mjs"

if ! port_is_open 8946; then
  launchctl remove com.poplur.garbage-collection >/dev/null 2>&1 || true
  launchctl submit \
    -l com.poplur.garbage-collection \
    -o "$STATE_DIR/garbage-collection.log" \
    -e "$STATE_DIR/garbage-collection.log" \
    -- "$(command -v node)" "$ROOT/.codex/garbage-collection-server.mjs"
  for _ in {1..120}; do
    port_is_open 8946 && break
    sleep 0.25
  done
  port_is_open 8946 || {
    echo "Unable to start handoff service on port 8946. See $STATE_DIR/garbage-collection.log" >&2
    exit 1
  }
fi

rcl_watcher_pid_file="$STATE_DIR/rcl-watcher.pid"
rcl_watcher_running=false
if [[ -s "$rcl_watcher_pid_file" ]]; then
  rcl_watcher_pid="$(cat "$rcl_watcher_pid_file")"
  if kill -0 "$rcl_watcher_pid" >/dev/null 2>&1; then
    rcl_watcher_running=true
  fi
fi
if [[ "$rcl_watcher_running" != true ]]; then
  launchctl remove com.poplur.rough-copy-watcher >/dev/null 2>&1 || true
  launchctl submit \
    -l com.poplur.rough-copy-watcher \
    -o "$STATE_DIR/rcl-watcher.log" \
    -e "$STATE_DIR/rcl-watcher.log" \
    -- "$(command -v node)" "$ROOT/.codex/watch-rcl-catalog.mjs"
  for _ in {1..40}; do
    rcl_watcher_pid="$(pgrep -f "watch-rcl-catalog.mjs" | head -1 || true)"
    if [[ -n "$rcl_watcher_pid" ]] && kill -0 "$rcl_watcher_pid" >/dev/null 2>&1; then
      echo "$rcl_watcher_pid" >"$rcl_watcher_pid_file"
      rcl_watcher_running=true
      break
    fi
    sleep 0.25
  done
  if [[ "$rcl_watcher_running" != true ]]; then
    echo "Unable to start Rough Copy watcher. See $STATE_DIR/rcl-watcher.log" >&2
    exit 1
  fi
fi

# Good Copy downstream handoffs are event-driven. This watcher is idle until a
# canonical good-copy*.html file changes, then hashes/debounces the change before
# waking Codex. Do not replace this with a timer-based automation.
if ! pgrep -f "watch-gcl-events.mjs" >/dev/null 2>&1; then
  launchctl remove com.poplur.gcl-change-watcher >/dev/null 2>&1 || true
  launchctl submit \
    -l com.poplur.gcl-change-watcher \
    -o "$STATE_DIR/gcl-change-watcher.log" \
    -e "$STATE_DIR/gcl-change-watcher.log" \
    -- "$(command -v node)" "$ROOT/.codex/watch-gcl-events.mjs"
fi

RCL_CAPTURE_NODE="/Users/matrix/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
RCL_CAPTURE_NODE_PATH="/Users/matrix/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules"
NODE_PATH="$RCL_CAPTURE_NODE_PATH" "$RCL_CAPTURE_NODE" "$ROOT/.codex/capture-rcl-previews.cjs" --missing

printf '%s\n' \
  "Post-login: http://127.0.0.1:5173/" \
  "Home view:  http://127.0.0.1:5173/?view=home" \
  "Map:        http://127.0.0.1:5199/" \
  "Subscreens:  http://127.0.0.1:8945/.claude/artifacts/poplur-subscreen-twins.html" \
  "GCL Live:    http://127.0.0.1:8945/good-copy-live.html#iphone" \
  "Hold menu:  http://127.0.0.1:5173/?view=holdmenu" \
  "Rough Copy: http://127.0.0.1:8945/rough-copy-live.html"
printf '%s\n' "Garbage Collection: http://127.0.0.1:8946/"
