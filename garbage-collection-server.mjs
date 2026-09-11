import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import vm from 'node:vm'

const ROOT = '/Users/matrix/Developer'
const BIN = path.join(ROOT, '.codex/recycling-bin')
const ITEMS = path.join(BIN, 'items')
const MANIFEST = path.join(BIN, 'manifest.json')
const UI = path.join(ROOT, '.claude/artifacts/garbage-collection.html')
const RCL_CATALOG = path.join(ROOT, '.claude/artifacts/rcl-screen-catalog.js')
const RCL_GENERATOR = path.join(ROOT, '.codex/generate-rcl-catalog-data.mjs')
const GCL_PROTOTYPE_HANDOFF = path.join(ROOT, '.codex/handoff-gcl-prototype.mjs')
const PORT = 8946
const projectRoots = ['Poplur2025-iOS', 'Poplur2025-Android', 'Poplur2025-ReactNative', 'PoplurLandingPage-HTML', 'poplur-clay-map']
const codeExtensions = new Set(['.swift', '.kt', '.kts', '.tsx', '.ts', '.jsx', '.js', '.html', '.css'])
const protectedScreenFiles = new Set([
  'HomeView.swift', 'FeedView.swift', 'MapView.swift', 'ProfileView.swift', 'Poplur2025App.swift',
  'SignedInContent.kt', 'PoplurRoot.kt', 'FeedScreen.kt', 'MapScreen.kt', 'ProfileScreen.kt',
  'CameraScreen.kt', 'App.tsx'
])
const candidates = [
  'Poplur2025-ReactNative/ios/Poplur/Images.xcassets/SplashScreenBackground.colorset/Contents 2.json',
  'Poplur2025-ReactNative/ios/Poplur/Images.xcassets/SplashScreenBackground.colorset/Contents 3.json',
  'Poplur2025-ReactNative/ios/Poplur/Images.xcassets/SplashScreenLogo.imageset/Contents 2.json',
  'Poplur2025-ReactNative/ios/Poplur/Images.xcassets/SplashScreenLogo.imageset/Contents 3.json',
  'Poplur2025-ReactNative/ios/Poplur/Images.xcassets/SplashScreenLogo.imageset/SplashScreenLogo 2.png',
  'Poplur2025-ReactNative/ios/Poplur/Images.xcassets/SplashScreenLogo.imageset/SplashScreenLogo 3.png',
  'poplur-clay-map/holdmenu_icons_original_backup',
  'poplur-clay-map/icon-export',
  'poplur-clay-map/poplur_holdmenu_icons',
  'poplur-clay-map/poplur_holdmenu_icons.zip'
]

fs.mkdirSync(ITEMS, { recursive: true })
const readManifest = () => { try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) } catch { return [] } }
const writeManifest = data => fs.writeFileSync(MANIFEST, JSON.stringify(data, null, 2) + '\n')
const sizeOf = target => {
  const stat = fs.statSync(target)
  if (!stat.isDirectory()) return stat.size
  return fs.readdirSync(target).reduce((sum, name) => sum + sizeOf(path.join(target, name)), 0)
}
const safeItem = id => readManifest().find(item => item.id === id && item.status === 'recycled')
const mimeTypes = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.json':'application/json','.txt':'text/plain','.md':'text/markdown','.js':'text/javascript','.mjs':'text/javascript','.ts':'text/plain','.tsx':'text/plain','.swift':'text/plain','.kt':'text/plain','.kts':'text/plain','.html':'text/html','.css':'text/css' }

function collect() {
  const manifest = readManifest()
  for (const originalPath of candidates) {
    const source = path.join(ROOT, originalPath)
    if (!fs.existsSync(source) || manifest.some(item => item.originalPath === originalPath && item.status === 'recycled')) continue
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
    const storedPath = path.join(ITEMS, id)
    const bytes = sizeOf(source)
    fs.renameSync(source, storedPath)
    manifest.push({ id, originalPath, storedPath: path.relative(ROOT, storedPath), bytes, type: fs.statSync(storedPath).isDirectory() ? 'folder' : 'file', recycledAt: new Date().toISOString(), status: 'recycled' })
  }
  writeManifest(manifest)
}

function restore(id) {
  const manifest = readManifest(); const item = manifest.find(entry => entry.id === id && entry.status === 'recycled')
  if (!item) throw new Error('Item not found')
  const source = path.join(ROOT, item.storedPath), destination = path.join(ROOT, item.originalPath)
  if (fs.existsSync(destination)) throw new Error('Restore blocked: original path is occupied')
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.renameSync(source, destination)
  item.status = 'restored'; item.restoredAt = new Date().toISOString(); writeManifest(manifest)
}

function remove(id) {
  const manifest = readManifest(); const item = manifest.find(entry => entry.id === id && entry.status === 'recycled')
  if (!item) throw new Error('Item not found')
  fs.rmSync(path.join(ROOT, item.storedPath), { recursive: true, force: true })
  item.status = 'deleted'; item.deletedAt = new Date().toISOString(); writeManifest(manifest)
}

const projectChecks = {
  'Poplur2025-ReactNative': [{ command: 'npm', args: ['run', 'typecheck'], label: 'TypeScript typecheck' }],
  'poplur-clay-map': [{ command: 'npm', args: ['run', 'build'], label: 'Production build' }],
  'Poplur2025-Android': [{ command: './gradlew', args: [':app:assembleDebug'], label: 'Android debug build' }],
  'Poplur2025-iOS': [{ command: 'xcodebuild', args: ['-project', 'Poplur2025.xcodeproj', '-scheme', 'Poplur2025', '-sdk', 'iphonesimulator', '-configuration', 'Debug', 'CODE_SIGNING_ALLOWED=NO', 'ONLY_ACTIVE_ARCH=YES', 'ARCHS=x86_64', 'build'], label: 'iOS simulator build' }],
  'PoplurLandingPage-HTML': [{ command: 'npm', args: ['run', 'lint'], label: 'Website lint', cwd: 'PoplurApp' }]
}

const androidStudioJavaHome = '/Applications/Android Studio.app/Contents/jbr/Contents/Home'
const validationEnv = {
  ...process.env,
  PATH: [
    path.join(androidStudioJavaHome, 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ].join(':'),
  ...(fs.existsSync(androidStudioJavaHome) ? { JAVA_HOME: androidStudioJavaHome } : {})
}

function validateProject(project) {
  const checks = projectChecks[project] || []
  if (checks.length === 0) {
    // A standalone document or a folder outside the app projects has no build
    // to protect. Failing closed here made such items undeletable from the page
    // (11 Sep 2026: engagement-push-plan.md returned an empty validation), so
    // the owner's confirmation in the UI is the only gate for them.
    return {
      project, ok: true, checkedAt: new Date().toISOString(),
      results: [{ label: 'No build validation applies', ok: true, status: 0,
        output: `"${project}" is not one of the validated projects (${Object.keys(projectChecks).join(', ')}). Nothing to build, so the item is removed on the owner's confirmation alone.` }]
    }
  }
  const results = checks.map(check => {
    const run = spawnSync(check.command, check.args, {
      cwd: path.join(ROOT, project, check.cwd || ''),
      env: validationEnv,
      encoding: 'utf8',
      timeout: 60 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024
    })
    const output = `${run.stdout || ''}${run.stderr || ''}`.trim().slice(-12000)
    return { label: check.label, ok: run.status === 0, status: run.status, output: output || (run.error?.message || '') }
  })
  return { project, ok: checks.length > 0 && results.every(result => result.ok), checkedAt: new Date().toISOString(), results }
}

function recordValidation(ids, validation) {
  const manifest = readManifest()
  manifest.filter(item => ids.includes(item.id)).forEach(item => { item.lastValidation = validation })
  writeManifest(manifest)
}

const validationProjectFor = item => item.validationProject || item.originalPath.split('/')[0]

function removeRegeneratedOutput(item) {
  if (item.kind !== 'generated-build-output' || item.regenerable !== true) return
  const target = path.resolve(ROOT, item.originalPath)
  if (!target.startsWith(`${ROOT}${path.sep}`)) throw new Error('Generated output path is outside the workspace')
  fs.rmSync(target, { recursive: true, force: true })
}

function validateAndRemove(id) {
  const item = safeItem(id); if (!item) throw new Error('Item not found')
  const project = validationProjectFor(item), validation = validateProject(project)
  recordValidation([id], validation)
  if (!validation.ok) {
    removeRegeneratedOutput(item)
    return { ok: false, validation }
  }
  removeRegeneratedOutput(item)
  remove(id)
  recordValidation([id], validation)
  return { ok: true, validation }
}

function restoreAll() {
  const results = []
  for (const item of readManifest().filter(entry => entry.status === 'recycled')) {
    try { restore(item.id); results.push({ id: item.id, ok: true }) }
    catch (error) { results.push({ id: item.id, ok: false, error: error.message }) }
  }
  return results
}

function validateAndRemoveAll() {
  const items = readManifest().filter(item => item.status === 'recycled')
  const projects = [...new Set(items.map(validationProjectFor))]
  const validations = projects.map(validateProject)
  for (const validation of validations) recordValidation(items.filter(item => validationProjectFor(item) === validation.project).map(item => item.id), validation)
  if (!validations.every(validation => validation.ok)) {
    for (const item of items) removeRegeneratedOutput(item)
    return { ok: false, deleted: 0, validations }
  }
  for (const item of items) removeRegeneratedOutput(item)
  for (const item of items) remove(item.id)
  for (const validation of validations) recordValidation(items.filter(item => validationProjectFor(item) === validation.project).map(item => item.id), validation)
  return { ok: true, deleted: items.length, validations }
}

if (process.argv.includes('--collect')) { collect(); console.log(JSON.stringify(readManifest(), null, 2)); process.exit(0) }

const responseHeaders = { 'Access-Control-Allow-Origin': 'http://127.0.0.1:8945', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }
const json = (res, status, body) => { res.writeHead(status, { ...responseHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)) }
const readJsonBody = req => new Promise((resolve, reject) => {
  let body = ''
  req.on('data', chunk => {
    body += chunk
    if (body.length > 100_000) reject(new Error('Request is too large'))
  })
  req.on('end', () => {
    try { resolve(body ? JSON.parse(body) : {}) }
    catch { reject(new Error('Invalid JSON')) }
  })
  req.on('error', reject)
})

function loadRclScreens() {
  const sandbox = { window: {} }
  vm.runInNewContext(fs.readFileSync(RCL_CATALOG, 'utf8'), sandbox)
  return (sandbox.window.RCL_SCREEN_CATALOG?.surfaces || []).flatMap(surface =>
    (surface.screens || []).map(screen => ({ ...screen, surfaceId: surface.id }))
  )
}

function safeProjectPath(relativePath) {
  if (!projectRoots.some(root => relativePath === root || relativePath.startsWith(`${root}/`))) return null
  const full = path.resolve(ROOT, relativePath)
  if (!full.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return null
  if (!codeExtensions.has(path.extname(full).toLowerCase())) return null
  return full
}

function declaredScreenSymbols(file) {
  const source = fs.readFileSync(file, 'utf8')
  const symbols = new Set()
  for (const match of source.matchAll(/\b(?:struct|class)\s+([A-Za-z][A-Za-z0-9_]*)\b/g)) {
    if (/(View|Screen|Page|Sheet|Overlay)$/.test(match[1]) || /Phone|Game|FPS/.test(match[1])) symbols.add(match[1])
  }
  for (const match of source.matchAll(/\bfun\s+([A-Za-z][A-Za-z0-9_]*(?:Screen|Page|Sheet|Overlay|View))\s*\(/g)) symbols.add(match[1])
  return [...symbols]
}

function externalReferences(files) {
  const deleting = new Set(files.map(file => path.resolve(file)))
  const references = []
  for (const file of files) {
    const projectRoot = path.join(ROOT, path.relative(ROOT, file).split(path.sep)[0])
    for (const symbol of declaredScreenSymbols(file)) {
      const result = spawnSync('rg', ['-l', '--fixed-strings', '--glob', '!node_modules/**', '--glob', '!build/**', '--glob', '!dist/**', symbol, projectRoot], { encoding: 'utf8' })
      const matches = String(result.stdout || '').split('\n').filter(Boolean).map(value => path.resolve(value)).filter(value => !deleting.has(value))
      if (matches.length) references.push({ symbol, paths: matches.map(value => path.relative(ROOT, value).split(path.sep).join('/')) })
    }
  }
  return references
}

function screenRemovalPlan(trackingKey, surfaceId) {
  const screens = loadRclScreens()
  const screen = screens.find(item => item.trackingKey === trackingKey && item.surfaceId === surfaceId)
  if (!screen) throw new Error('Screen is no longer present in Rough Copy')
  const sourcePaths = [...new Set((screen.sourcePaths || []).filter(relativePath => safeProjectPath(relativePath)))]
  const blockedPaths = sourcePaths.filter(relativePath => protectedScreenFiles.has(path.basename(relativePath)))
  const deletionPaths = sourcePaths.filter(relativePath => !blockedPaths.includes(relativePath))
  const deletionSet = new Set(deletionPaths)
  const impactedScreens = screens
    .filter(item => (item.sourcePaths || []).some(relativePath => deletionSet.has(relativePath)))
    .map(item => ({ surfaceId: item.surfaceId, label: item.label, trackingKey: item.trackingKey }))
    .filter((item, index, values) => values.findIndex(other => other.trackingKey === item.trackingKey) === index)
  const references = externalReferences(deletionPaths.map(relativePath => path.join(ROOT, relativePath)))
  return {
    screen: { label: screen.label, surfaceId, trackingKey },
    deletionPaths,
    blockedPaths,
    impactedScreens,
    references,
    canRecycle: deletionPaths.length > 0 && blockedPaths.length === 0 && references.length === 0,
    reason: blockedPaths.length
      ? 'This screen is defined in a shared core file and needs a targeted code refactor before that file can be recycled.'
      : references.length
        ? 'The screen is still referenced by other source files. Refactor those call sites before recycling it.'
        : deletionPaths.length
          ? ''
          : 'No independently owned project source file was found for this screen.'
  }
}

function recycleScreen(plan) {
  const manifest = readManifest()
  const batchId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
  const moved = []
  try {
    for (const originalPath of plan.deletionPaths) {
      const source = path.join(ROOT, originalPath)
      const itemId = `${batchId}-${moved.length + 1}`
      const storedPath = path.join(ITEMS, itemId)
      const bytes = sizeOf(source)
      fs.renameSync(source, storedPath)
      const item = {
        id: itemId,
        batchId,
        originalPath,
        storedPath: path.relative(ROOT, storedPath),
        bytes,
        type: 'file',
        kind: 'screen-source',
        screen: plan.screen,
        impactedScreens: plan.impactedScreens,
        refactorStatus: 'validated-no-external-references',
        recycledAt: new Date().toISOString(),
        status: 'recycled'
      }
      manifest.push(item)
      moved.push(item)
    }
    writeManifest(manifest)
    const refresh = spawnSync(process.execPath, [RCL_GENERATOR], { cwd: ROOT, encoding: 'utf8' })
    if (refresh.status !== 0) throw new Error(`RCL regeneration failed: ${String(refresh.stderr || refresh.stdout).trim()}`)
    return { batchId, items: moved }
  } catch (error) {
    for (const item of moved.reverse()) {
      const source = path.join(ROOT, item.storedPath)
      const destination = path.join(ROOT, item.originalPath)
      if (fs.existsSync(source) && !fs.existsSync(destination)) {
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        fs.renameSync(source, destination)
      }
    }
    writeManifest(manifest.filter(item => !moved.some(movedItem => movedItem.id === item.id)))
    throw error
  }
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, responseHeaders); res.end(); return }
  if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); fs.createReadStream(UI).pipe(res); return }
  if (req.method === 'GET' && req.url === '/api/items') { json(res, 200, readManifest()); return }
  if (req.method === 'POST' && req.url === '/api/gcl-prototype/handoff') {
    try {
      const body = await readJsonBody(req)
      if (body.confirmed !== true) { json(res, 409, { ok: false, error: 'Explicit handoff confirmation is required.' }); return }
      const result = spawnSync(process.execPath, [GCL_PROTOTYPE_HANDOFF], { cwd: ROOT, encoding: 'utf8', timeout: 30 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 })
      if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'Prototype handoff failed').trim())
      json(res, 200, JSON.parse(String(result.stdout).trim()))
    } catch (error) {
      json(res, 409, { ok: false, error: error.message })
    }
    return
  }
  if (req.method === 'POST' && req.url === '/api/restore-all') { const results = restoreAll(); json(res, results.every(x => x.ok) ? 200 : 409, { ok: results.every(x => x.ok), results }); return }
  if (req.method === 'POST' && req.url === '/api/delete-all') { const result = validateAndRemoveAll(); json(res, result.ok ? 200 : 409, result); return }
  if (req.method === 'POST' && (req.url === '/api/recycle-screen/plan' || req.url === '/api/recycle-screen')) {
    try {
      const body = await readJsonBody(req)
      const plan = screenRemovalPlan(String(body.trackingKey || ''), String(body.surfaceId || ''))
      if (req.url.endsWith('/plan')) { json(res, 200, plan); return }
      if (!plan.canRecycle) { json(res, 409, { ok: false, error: plan.reason, plan }); return }
      json(res, 200, { ok: true, plan, result: recycleScreen(plan) })
    } catch (error) {
      json(res, 409, { ok: false, error: error.message })
    }
    return
  }
  const preview = req.url?.match(/^\/api\/items\/([^/]+)\/preview$/)
  if (req.method === 'GET' && preview) {
    const item = safeItem(preview[1]); if (!item) { json(res, 404, { error: 'Item not found' }); return }
    const target = path.join(ROOT, item.storedPath)
    if (fs.statSync(target).isDirectory()) {
      const files = []
      const walk = (dir, base = '') => fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => { const rel = path.join(base, entry.name); entry.isDirectory() ? walk(path.join(dir, entry.name), rel) : files.push(rel.split(path.sep).join('/')) })
      walk(target); json(res, 200, { kind: 'folder', files: files.slice(0, 500), totalFiles: files.length }); return
    }
    const mime = mimeTypes[path.extname(item.originalPath).toLowerCase()] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': mime, 'Content-Disposition': `inline; filename="${path.basename(item.originalPath).replaceAll('"','')}"`, 'Cache-Control': 'no-store' }); fs.createReadStream(target).pipe(res); return
  }
  const match = req.url?.match(/^\/api\/items\/([^/]+)\/(restore|delete)$/)
  if (req.method === 'POST' && match) {
    try { const result = match[2] === 'restore' ? (restore(match[1]), { ok: true }) : validateAndRemove(match[1]); json(res, result.ok ? 200 : 409, result) }
    catch (error) { json(res, 409, { ok: false, error: error.message }) }
    return
  }
  json(res, 404, { error: 'Not found' })
}).listen(PORT, '127.0.0.1', () => console.log(`Garbage Collection: http://127.0.0.1:${PORT}/`))
