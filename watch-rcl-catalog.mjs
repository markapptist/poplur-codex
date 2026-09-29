import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const workspace = '/Users/matrix/Developer'
const downstreamSync = path.join(workspace, '.codex/sync-gcl-downstream.mjs')
const downstreamReportPath = path.join(workspace, '.claude/artifacts/gcl-downstream-sync-report.json')
const captureScript = path.join(workspace, '.codex/capture-rcl-previews.cjs')
const refreshMetaPath = path.join(workspace, '.claude/artifacts/rcl-refresh-meta.json')
const pendingSourcesPath = path.join(workspace, '.codex/artifact-workbench/rcl-pending-sources.json')
const runtimeNode = '/Users/matrix/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
const runtimeNodeModules = '/Users/matrix/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'

// launchd (com.poplur.rough-copy-watcher) starts this watcher with the stock
// PATH (/usr/bin:/bin:/usr/sbin:/sbin), which has no `node`. sync-mobile.sh runs
// bare `node`, and ./node_modules/.bin/{tsc,vite} are `#!/usr/bin/env node`
// shims, so every automatic downstream sync died with exit 127. Every child
// therefore gets the directory of the node running this watcher first on PATH.
const nodeBinDir = path.dirname(process.execPath)
const childPath = [nodeBinDir, ...(process.env.PATH || '').split(path.delimiter)]
  .filter((entry, index, entries) => entry && entries.indexOf(entry) === index)
  .join(path.delimiter)
const childEnv = { ...process.env, PATH: childPath }

const directoryTargets = [
  'Poplur2025-iOS/Poplur2025',
  'Poplur2025-iOS/PoplurWatch',
  'Poplur2025-Android/app/src/main/java',
  'Poplur2025-Android/wear/src/main',
  'Poplur2025-ReactNative/src/screens',
  'PoplurLandingPage-HTML/PoplurApp/src/app',
  'poplur-clay-map/public',
  'poplur-clay-map/src'
]
const fileTargets = [
  'good-copy-live.html',
  'poplur-clay-map/index.html',
  'poplur-clay-map/package-lock.json',
  'poplur-clay-map/package.json',
  'poplur-clay-map/scripts/sync-mobile.sh',
  'poplur-clay-map/tsconfig.json',
  'poplur-clay-map/vite.config.ts',
  '.claude/artifacts/poplur-subscreen-twins.html',
  '.claude/artifacts/poplur-subscreen-twins.css',
  '.claude/artifacts/poplur-subscreen-twins.js',
  '.claude/artifacts/poplur-prelogin-flow.html'
]

let debounceTimer = null
let running = false
let pending = false
const changedSources = new Set()

const stamp = () => new Date().toISOString()

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

// Rough Copy is review-gated: generate-rcl-catalog-data.mjs throws unless it is
// run with --approved, so this watcher never runs it (an unapproved run crashed
// on every cycle and regenerated nothing). It only records which sources changed
// since the last approved regeneration; the RCL thread regenerates with
// --approved once the user approves the named change.
function recordPendingSources(sources) {
  if (!sources.length) return
  const now = stamp()
  const approvedAt = readJson(refreshMetaPath, {}).generatedAt || ''
  const record = readJson(pendingSourcesPath, {})
  record.version = 1
  record.sources = record.sources && typeof record.sources === 'object' ? record.sources : {}
  for (const [source, entry] of Object.entries(record.sources)) {
    // An approved regeneration consumed everything that changed before it.
    if (approvedAt && (entry?.lastChangedAt || '') < approvedAt) delete record.sources[source]
  }
  for (const source of sources) {
    const entry = record.sources[source] || { firstChangedAt: now, changes: 0 }
    entry.lastChangedAt = now
    entry.changes += 1
    record.sources[source] = entry
  }
  record.lastApprovedRegenerationAt = approvedAt
  record.updatedAt = now
  fs.mkdirSync(path.dirname(pendingSourcesPath), { recursive: true })
  fs.writeFileSync(pendingSourcesPath, `${JSON.stringify(record, null, 2)}\n`)
  const shown = sources.slice(0, 6).join(', ') + (sources.length > 6 ? `, +${sources.length - 6} more` : '')
  console.log(`${now} Rough Copy: ${sources.length} changed source(s) recorded as pending approval (${Object.keys(record.sources).length} pending in ${path.relative(workspace, pendingSourcesPath)}): ${shown}`)
}

function describeDownstreamSync() {
  const map = readJson(downstreamReportPath, {}).screens?.map
  if (!map) return 'report unreadable'
  if (map.status !== 'synced') return `map ${map.status || 'unknown'}, last synced ${map.syncedAt || 'never'}`
  const lines = String(map.output || '').trim().split('\n')
  const synced = lines.findIndex(line => line.startsWith('Synced native clay map bundles'))
  const tail = (synced >= 0 ? lines.slice(synced, synced + 3) : lines.slice(-3)).join(' | ')
  return `map synced at ${map.syncedAt}${tail ? ` — ${tail}` : ''}`
}

function regenerate() {
  if (running) {
    pending = true
    return
  }
  running = true
  const sources = [...changedSources].sort()
  changedSources.clear()
  recordPendingSources(sources)
  const child = spawn(process.execPath, [downstreamSync, '--quiet'], {
    cwd: workspace,
    env: childEnv,
    stdio: ['ignore', 'inherit', 'inherit']
  })
  child.on('exit', code => {
    if (code) console.error(`${stamp()} GCL downstream sync exited with code ${code}`)
    else console.log(`${stamp()} GCL downstream sync: ${describeDownstreamSync()}`)
    // Keep foreground GCL/RCL browsing responsive. Automatic source watches only
    // fill missing posters; a full recapture remains an explicit manual action.
    const capture = spawn(runtimeNode, [captureScript, '--missing'], {
      cwd: workspace,
      env: { ...childEnv, NODE_PATH: runtimeNodeModules },
      stdio: ['ignore', 'inherit', 'inherit']
    })
    capture.on('exit', captureCode => {
      running = false
      if (captureCode) console.error(`${stamp()} RCL preview capture exited with code ${captureCode}`)
      if (pending) {
        pending = false
        regenerate()
      }
    })
  })
}

function schedule(source) {
  if (/(^|\/)(\.git|node_modules|build|dist|DerivedData|Pods)(\/|$)/.test(source)) return
  changedSources.add(source)
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(regenerate, 2000)
}

const watchers = []
for (const target of directoryTargets) {
  const full = path.join(workspace, target)
  if (!fs.existsSync(full)) continue
  watchers.push(fs.watch(full, { recursive: true }, (_event, fileName) => schedule(path.posix.join(target, String(fileName || '')))))
}
for (const target of fileTargets) {
  const full = path.join(workspace, target)
  if (!fs.existsSync(full)) continue
  watchers.push(fs.watch(full, () => schedule(target)))
}

console.log(`${stamp()} Watching ${watchers.length} Poplur sources for Rough Copy updates.`)
console.log(`${stamp()} Child PATH starts with ${nodeBinDir} (node ${process.version}).`)
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
