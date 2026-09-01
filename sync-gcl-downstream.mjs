import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const workspace = '/Users/matrix/Developer'
const statePath = path.join(workspace, '.codex/gcl-downstream-sync-state.json')
const reportPath = path.join(workspace, '.claude/artifacts/gcl-downstream-sync-report.json')

const ignoredDirs = new Set(['.git', 'node_modules', 'dist', 'build', 'tmp', 'models'])
const mapInputs = [
  'poplur-clay-map/index.html',
  'poplur-clay-map/package-lock.json',
  'poplur-clay-map/package.json',
  'poplur-clay-map/public',
  'poplur-clay-map/scripts/sync-mobile.sh',
  'poplur-clay-map/src',
  'poplur-clay-map/tsconfig.json',
  'poplur-clay-map/vite.config.ts'
]

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function slash(value) {
  return value.split(path.sep).join('/')
}

function collectFiles(relativeInputs) {
  const files = []
  const visit = file => {
    if (!fs.existsSync(file)) return
    const stat = fs.statSync(file)
    if (stat.isDirectory()) {
      if (ignoredDirs.has(path.basename(file))) return
      for (const entry of fs.readdirSync(file)) visit(path.join(file, entry))
      return
    }
    // Finder metadata is neither app source nor a release input. Including it
    // made merely browsing public/ change the hash and trigger a full guarded
    // mobile rebuild/thermal run for an otherwise identical snapshot.
    if (stat.isFile() && path.basename(file) !== '.DS_Store') files.push(file)
  }
  for (const item of relativeInputs) visit(path.join(workspace, item))
  return files.sort((a, b) => slash(a).localeCompare(slash(b)))
}

function hashFiles(files) {
  const hash = crypto.createHash('sha256')
  let latestMtime = 0
  for (const file of files) {
    const stat = fs.statSync(file)
    latestMtime = Math.max(latestMtime, stat.mtimeMs)
    hash.update(slash(path.relative(workspace, file)))
    hash.update('\0')
    hash.update(fs.readFileSync(file))
    hash.update('\0')
  }
  return {
    hash: files.length ? hash.digest('hex') : '',
    files: files.map(file => slash(path.relative(workspace, file))),
    updatedAt: latestMtime ? new Date(latestMtime).toISOString() : ''
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.status !== 0) {
    const error = new Error(`${command} ${args.join(' ')} failed with ${result.status}`)
    error.stdout = result.stdout
    error.stderr = result.stderr
    throw error
  }
  return `${result.stdout || ''}${result.stderr || ''}`
}

const force = process.argv.includes('--force')
const quiet = process.argv.includes('--quiet')
const state = readJson(statePath, { version: 1, screens: {} })
state.version = 1
state.screens ||= {}

const source = hashFiles(collectFiles(mapInputs))
const previous = state.screens.map
const needsSync = force || previous?.sourceHash !== source.hash
const report = {
  generatedAt: new Date().toISOString(),
  screens: {
    map: {
      sourceHash: source.hash,
      sourceUpdatedAt: source.updatedAt,
      sourceFiles: source.files.length,
      platforms: ['iOS', 'iPad', 'Android', 'Android Tablet'],
      reactNative: 'manual parity required: React Native has a separate MapScreen implementation',
      status: needsSync ? 'synced' : 'unchanged'
    }
  }
}

if (needsSync) {
  const output = run('./scripts/sync-mobile.sh', [], path.join(workspace, 'poplur-clay-map'))
  state.screens.map = {
    sourceHash: source.hash,
    sourceUpdatedAt: source.updatedAt,
    syncedAt: report.generatedAt,
    platforms: report.screens.map.platforms,
    command: 'poplur-clay-map/scripts/sync-mobile.sh'
  }
  report.screens.map.syncedAt = report.generatedAt
  report.screens.map.output = output
} else {
  report.screens.map.syncedAt = previous?.syncedAt || ''
}

fs.mkdirSync(path.dirname(statePath), { recursive: true })
fs.mkdirSync(path.dirname(reportPath), { recursive: true })
fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)

if (!quiet) {
  console.log(JSON.stringify(report, null, 2))
}
