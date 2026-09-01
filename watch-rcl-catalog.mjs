import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const workspace = '/Users/matrix/Developer'
const generator = path.join(workspace, '.codex/generate-rcl-catalog-data.mjs')
const downstreamSync = path.join(workspace, '.codex/sync-gcl-downstream.mjs')
const captureScript = path.join(workspace, '.codex/capture-rcl-previews.cjs')
const runtimeNode = '/Users/matrix/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
const runtimeNodeModules = '/Users/matrix/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
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

function regenerate() {
  if (running) {
    pending = true
    return
  }
  running = true
  const child = spawn(process.execPath, [downstreamSync, '--quiet'], {
    cwd: workspace,
    stdio: ['ignore', 'inherit', 'inherit']
  })
  child.on('exit', code => {
    if (code) console.error(`GCL downstream sync exited with code ${code}`)
    const catalog = spawn(process.execPath, [generator], {
      cwd: workspace,
      stdio: ['ignore', 'inherit', 'inherit']
    })
    catalog.on('exit', catalogCode => {
      if (catalogCode) console.error(`RCL regeneration exited with code ${catalogCode}`)
      // Keep foreground GCL/RCL browsing responsive. Automatic source watches only
      // fill missing posters; a full recapture remains an explicit manual action.
      const capture = spawn(runtimeNode, [captureScript, '--missing'], {
        cwd: workspace,
        env: { ...process.env, NODE_PATH: runtimeNodeModules },
        stdio: ['ignore', 'inherit', 'inherit']
      })
      capture.on('exit', captureCode => {
        running = false
        if (captureCode) console.error(`RCL preview capture exited with code ${captureCode}`)
        if (pending) {
          pending = false
          regenerate()
        }
      })
    })
  })
}

function schedule(fileName = '') {
  if (/(^|\/)(\.git|node_modules|build|dist|DerivedData|Pods)(\/|$)/.test(fileName)) return
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(regenerate, 2000)
}

const watchers = []
for (const target of directoryTargets) {
  const full = path.join(workspace, target)
  if (!fs.existsSync(full)) continue
  watchers.push(fs.watch(full, { recursive: true }, (_event, fileName) => schedule(String(fileName || ''))))
}
for (const target of fileTargets) {
  const full = path.join(workspace, target)
  if (!fs.existsSync(full)) continue
  watchers.push(fs.watch(full, () => schedule(target)))
}

console.log(`Watching ${watchers.length} Poplur sources for Rough Copy updates.`)
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
