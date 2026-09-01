import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const workspace = '/Users/matrix/Developer'
const output = path.join(workspace, '.claude/artifacts/gcl-catalog-data.js')
const refreshMetaOutput = path.join(workspace, '.claude/artifacts/gcl-refresh-meta.js')
const gclHtmlOutput = path.join(workspace, '.claude/artifacts/poplur-subscreen-twins.html')

const downstreamSync = spawnSync(process.execPath, [path.join(workspace, '.codex/sync-gcl-downstream.mjs'), '--quiet'], {
  cwd: workspace,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
})
if (downstreamSync.status !== 0) {
  process.stderr.write(downstreamSync.stdout || '')
  process.stderr.write(downstreamSync.stderr || '')
  process.exit(downstreamSync.status || 1)
}

const slash = value => value.split(path.sep).join('/')
const relative = value => slash(path.relative(workspace, value))
const urlFor = value => '/' + relative(value).split('/').map(encodeURIComponent).join('/')
const exists = value => fs.existsSync(value)
const statSize = value => {
  try { return fs.statSync(value).size } catch { return 0 }
}
const htmlAttr = value => String(value)
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
const htmlText = value => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
const refreshLabel = value => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return `Last refreshed: ${value}`
  const formatted = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Toronto',
    timeZoneName: 'short'
  }).format(date)
  return `Last refreshed: ${formatted}`
}

const projectDefinitions = [
  {
    name: 'iOS + watchOS', root: 'Poplur2025-iOS', platforms: ['iPhone', 'iPad', 'Apple Watch'],
    frameworks: ['SwiftUI', 'MapKit', 'Core Location', 'AVFoundation', 'SceneKit', 'SpriteKit', 'WebKit', 'WatchKit'],
    apis: ['Firebase Auth', 'Cloud Firestore', 'Firebase Storage', 'Google Drive media', 'Picsum Photos']
  },
  {
    name: 'Android + Wear OS', root: 'Poplur2025-Android', platforms: ['Android phone', 'Android tablet', 'Wear OS'],
    frameworks: ['Kotlin', 'Jetpack Compose', 'AndroidX', 'Gradle', 'Roborazzi'],
    apis: ['Firebase Auth', 'Cloud Firestore', 'Firebase Storage', 'Google Play Services', 'Mapbox']
  },
  {
    name: 'React Native', root: 'Poplur2025-ReactNative', platforms: ['iOS', 'Android', 'Web'],
    frameworks: ['React Native', 'Expo', 'React Navigation', 'React Native Reanimated', 'Three.js'],
    apis: ['Firebase', 'Expo Camera', 'Expo Location', 'Expo Image Picker', 'React Native Maps']
  },
  {
    name: 'Clay Map', root: 'poplur-clay-map', platforms: ['Web', 'iOS web bundle'],
    frameworks: ['React', 'Vite', 'TypeScript', 'Three.js', 'Google model-viewer'],
    apis: ['Mapbox GL JS', 'WebGL']
  },
  {
    name: 'Poplur Website', root: 'PoplurLandingPage-HTML', platforms: ['Web', 'PWA'],
    frameworks: ['React', 'React Native Web', 'Expo', 'Expo Router', 'TypeScript', 'Three.js'],
    apis: ['Firebase', 'Expo Video', 'Expo Web Browser', 'PWA / Service Worker']
  }
]

const sizeIgnoredDirs = new Set(['.git', 'node_modules', 'dist', 'build', '.gradle', '.idea', '.expo', 'Pods', 'DerivedData'])
function projectSourceSize(dir) {
  if (!exists(dir)) return 0
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || sizeIgnoredDirs.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += projectSourceSize(full)
    else total += statSize(full)
  }
  return total
}

const projects = projectDefinitions.filter(item => exists(path.join(workspace, item.root))).map(item => ({
  ...item,
  bytes: projectSourceSize(path.join(workspace, item.root))
}))

const icons = []
const addIcon = ({ platform, family, label, detail, file, points = '', scale = '', pixels = '' }) => {
  if (!file || !exists(file)) return
  icons.push({ platform, family, label, detail, points, scale, pixels, path: relative(file), url: urlFor(file), bytes: statSize(file) })
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function pixelSize(size, scale) {
  const points = Number(String(size || '').split('x')[0])
  const multiplier = Number(String(scale || '1x').replace('x', ''))
  return Number.isFinite(points * multiplier) ? `${Math.round(points * multiplier)}×${Math.round(points * multiplier)} px` : ''
}

function collectAppleIconSets(root, fallbackPlatform) {
  if (!exists(root)) return
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.appiconset')) continue
    const setDir = path.join(root, entry.name)
    const json = readJson(path.join(setDir, 'Contents.json'))
    if (!json?.images) continue
    for (const image of json.images) {
      if (!image.filename) continue
      const idiom = image.idiom || ''
      const platform = idiom === 'iphone' ? 'iOS' : idiom === 'ipad' ? 'iPad' : idiom.includes('watch') || fallbackPlatform === 'watchOS' ? 'watchOS' : fallbackPlatform
      const points = image.size ? `${image.size} pt` : ''
      const scale = image.scale || '1x'
      addIcon({
        platform,
        family: entry.name.replace('.appiconset', ''),
        label: image.filename,
        detail: [idiom || platform, points, scale].filter(Boolean).join(' · '),
        points,
        scale,
        pixels: pixelSize(image.size, scale),
        file: path.join(setDir, image.filename)
      })
    }
  }
}

collectAppleIconSets(path.join(workspace, 'Poplur2025-iOS/Poplur2025/Assets.xcassets'), 'iOS')
collectAppleIconSets(path.join(workspace, 'Poplur2025-iOS/PoplurWatch/Assets.xcassets'), 'watchOS')

function collectAndroidMipmaps(root, platform, familyPrefix) {
  if (!exists(root)) return
  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory() || !dirent.name.startsWith('mipmap-') || dirent.name.includes('anydpi')) continue
    const density = dirent.name.replace('mipmap-', '')
    const dir = path.join(root, dirent.name)
    for (const fileName of fs.readdirSync(dir)) {
      if (!/\.(png|webp|jpg|jpeg)$/i.test(fileName) || !/(launcher|icon)/i.test(fileName)) continue
      const file = path.join(dir, fileName)
      addIcon({ platform, family: `${familyPrefix} · ${fileName.replace(/\.[^.]+$/, '')}`, label: fileName, detail: `${density} density`, scale: density, file })
    }
  }
}

const androidRes = path.join(workspace, 'Poplur2025-Android/app/src/main/res')
collectAndroidMipmaps(androidRes, 'Android', 'Phone')
collectAndroidMipmaps(androidRes, 'Android Tablet', 'Shared Android')
collectAndroidMipmaps(path.join(workspace, 'Poplur2025-Android/wear/src/main/res'), 'Wear OS', 'Wear')
collectAndroidMipmaps(path.join(workspace, 'Poplur2025-ReactNative/android/app/src/main/res'), 'Android', 'React Native')

const websiteIconCandidates = [
  'PoplurLandingPage-HTML/PoplurApp/assets/images/icon.png',
  'PoplurLandingPage-HTML/PoplurApp/assets/images/favicon.png',
  'PoplurLandingPage-HTML/PoplurApp/dist/client/favicon.ico',
  'PoplurLandingPage-HTML/PoplurApp/assets/images/android-icon-foreground.png',
  'PoplurLandingPage-HTML/PoplurApp/assets/images/android-icon-background.png',
  'PoplurLandingPage-HTML/PoplurApp/assets/images/android-icon-monochrome.png',
  'Poplur2025-ReactNative/assets/icon.png',
  'Poplur2025-ReactNative/assets/favicon.png'
]
const rnWebIconRoot = path.join(workspace, 'Poplur2025-ReactNative/src/assets')
if (exists(rnWebIconRoot)) {
  for (const fileName of fs.readdirSync(rnWebIconRoot)) {
    if (/^(icon-\d+(?:x\d+)?|apple-touch-icon|favicon)\.(png|ico)$/i.test(fileName)) {
      websiteIconCandidates.push(relative(path.join(rnWebIconRoot, fileName)))
    }
  }
}
for (const item of websiteIconCandidates) {
  const file = path.join(workspace, item)
  if (exists(file)) addIcon({ platform: 'Website', family: 'Web / PWA', label: path.basename(file), detail: relative(file), file })
}

const watchMaster = path.join(workspace, 'Poplur2025-iOS/PoplurWatch/Assets.xcassets/AppIcon.appiconset/AppIcon.png')
const watchDerived = [
  ['Notification Center · 38/40 mm', '24 pt', '2x', '48×48 px'],
  ['Notification Center · 42/44 mm', '27.5 pt', '2x', '55×55 px'],
  ['Companion Settings', '29 pt', '2x', '58×58 px'],
  ['Companion Settings', '29 pt', '3x', '87×87 px'],
  ['Home Screen · 38/40 mm', '40 pt', '2x', '80×80 px'],
  ['Home Screen · 41 mm', '44 pt', '2x', '88×88 px'],
  ['Home Screen · 42/44 mm', '46 pt', '2x', '92×92 px'],
  ['Home Screen · 45 mm', '50 pt', '2x', '100×100 px'],
  ['Home Screen · 49 mm', '54 pt', '2x', '108×108 px'],
  ['Short Look · 38/40 mm', '86 pt', '2x', '172×172 px'],
  ['Short Look · 42/44 mm', '98 pt', '2x', '196×196 px'],
  ['Short Look · 45/49 mm', '108 pt', '2x', '216×216 px'],
  ['App Store', '1024 pt', '1x', '1024×1024 px']
]
for (const [label, points, scale, pixels] of watchDerived) {
  addIcon({ platform: 'watchOS', family: 'AppIcon · Xcode-derived', label, detail: `${points} · ${scale}`, points, scale, pixels, file: watchMaster })
}

const mediaExtensions = new Map([
  ['.png', 'image'], ['.jpg', 'image'], ['.jpeg', 'image'], ['.gif', 'image'], ['.webp', 'image'], ['.svg', 'image'], ['.ico', 'image'],
  ['.mp4', 'video'], ['.mov', 'video'], ['.m4v', 'video'], ['.webm', 'video'],
  ['.mp3', 'sound'], ['.wav', 'sound'], ['.m4a', 'sound'], ['.aac', 'sound'], ['.ogg', 'sound'], ['.flac', 'sound'], ['.aiff', 'sound'], ['.aif', 'sound']
])

const mediaRoots = [
  ['iOS', 'Poplur2025-iOS/Poplur2025'],
  ['watchOS', 'Poplur2025-iOS/PoplurWatch'],
  ['iOS Map Bundle', 'Poplur2025-iOS/ClayMapWeb'],
  ['Android', 'Poplur2025-Android/app/src/main'],
  ['Wear OS', 'Poplur2025-Android/wear/src/main'],
  ['React Native', 'Poplur2025-ReactNative/src/assets'],
  ['React Native iOS', 'Poplur2025-ReactNative/ios/Poplur/Images.xcassets'],
  ['React Native Android', 'Poplur2025-ReactNative/android/app/src/main/res'],
  ['Clay Map Web', 'poplur-clay-map/public'],
  ['Website', 'PoplurLandingPage-HTML/PoplurApp/assets'],
  ['Website', 'PoplurLandingPage-HTML/PoplurApp/exports']
]

const assets = []
const ignoredDirs = new Set(['node_modules', 'dist', 'build', '.git', '.gradle', '.idea', '.expo', 'Pods', 'DerivedData'])

function walkMedia(project, root, dir = root) {
  if (!exists(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.imageset') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name) || entry.name.endsWith('.appiconset') || entry.name.startsWith('mipmap-')) continue
      walkMedia(project, root, full)
      continue
    }
    const type = mediaExtensions.get(path.extname(entry.name).toLowerCase())
    if (!type) continue
    const rel = relative(full)
    assets.push({ project, type, name: entry.name, folder: slash(path.relative(root, path.dirname(full))) || 'Root', path: rel, url: urlFor(full), bytes: statSize(full) })
  }
}

for (const [project, root] of mediaRoots) walkMedia(project, path.join(workspace, root))

const modelExtensions = new Set(['.glb', '.gltf', '.obj', '.fbx', '.dae', '.usdz', '.usd', '.usda', '.usdc', '.scn', '.blend', '.vox'])
const spriteExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
const sourceRoots = [
  ['iOS Runtime', 'Poplur2025-iOS/Poplur2025'],
  ['watchOS', 'Poplur2025-iOS/PoplurWatch'],
  ['iOS Map Bundle', 'Poplur2025-iOS/ClayMapWeb'],
  ['iOS Model Sources', 'Poplur2025-iOS/CubeModelSources'],
  ['iOS FPS', 'Poplur2025-iOS/PoplurFPS'],
  ['Android Runtime', 'Poplur2025-Android/app/src/main'],
  ['Wear OS', 'Poplur2025-Android/wear/src/main'],
  ['Android Model Sources', 'Poplur2025-Android/cube_model_sources'],
  ['React Native', 'Poplur2025-ReactNative/src'],
  ['React Native iOS', 'Poplur2025-ReactNative/ios/Poplur'],
  ['React Native Android', 'Poplur2025-ReactNative/android/app/src/main'],
  ['Clay Map Web', 'poplur-clay-map/public'],
  ['Website', 'PoplurLandingPage-HTML/PoplurApp/assets'],
  ['Website', 'PoplurLandingPage-HTML/PoplurApp/exports']
]

const models = []
const sprites = []
const modelSeen = new Set()
const spriteSeen = new Set()

function isSpritePath(file) {
  const normalized = relative(file).toLowerCase()
  const fileName = path.basename(file).toLowerCase()
  return /(^|\/)(sprites?|sprite[-_ ]?sheets?)(\/|$)/.test(normalized) ||
    normalized.includes('/poplurfps/sprites/') ||
    normalized.includes('/poplur_fps/assets/') ||
    /(^|[-_.])sprite([-_.]|sheet|$)/.test(fileName) ||
    /poplur_card_.+_frame_\d+/.test(fileName) ||
    /profile_talking_head_\d+/.test(fileName) ||
    normalized.includes('/profile_head/frame_') ||
    normalized.includes('particle sprite atlas.spriteatlas') ||
    fileName.includes('watch_faces_atlas') ||
    (normalized.includes('poplur2025-ios/') && /poplur_phone_battery_\d+/.test(fileName)) ||
    (normalized.includes('poplur2025-android/') && /poplur_phone_(signal|press)_/.test(fileName))
}

function walkSourceCatalog(project, root, dir = root) {
  if (!exists(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name) || entry.name === 'verification_screenshots' || entry.name === 'DesignReferences') continue
      walkSourceCatalog(project, root, full)
      continue
    }
    const ext = path.extname(entry.name).toLowerCase()
    const item = { project, name: entry.name, format: ext.slice(1).toUpperCase(), folder: slash(path.relative(root, path.dirname(full))) || 'Root', path: relative(full), url: urlFor(full), bytes: statSize(full) }
    if (modelExtensions.has(ext) && !modelSeen.has(item.path)) {
      modelSeen.add(item.path)
      models.push(item)
    }
    if (spriteExtensions.has(ext) && isSpritePath(full) && !spriteSeen.has(item.path)) {
      spriteSeen.add(item.path)
      sprites.push(item)
    }
  }
}

for (const [project, root] of sourceRoots) walkSourceCatalog(project, path.join(workspace, root))

// Feed media is remote by design, but it is still part of the app's current
// source-defined asset inventory. Read the Swift pools so the catalog stays in
// sync when demo Feed media changes without copying those large files locally.
const remoteSeen = new Set()
const addRemoteAsset = ({ type, name, label, url, sourcePath }) => {
  if (!url || remoteSeen.has(url)) return
  remoteSeen.add(url)
  assets.push({
    project: 'iOS Feed',
    type,
    name,
    label: label || name,
    folder: 'Feed / Current media',
    path: `${sourcePath} → ${url}`,
    url,
    bytes: 0,
    remote: true
  })
}

const swiftArrayBody = (source, marker) => {
  const markerIndex = source.indexOf(marker)
  if (markerIndex < 0) return ''
  const assignment = source.indexOf('=', markerIndex)
  const open = source.indexOf('[', assignment)
  const close = source.indexOf(']', open)
  return assignment >= 0 && open >= 0 && close > open ? source.slice(open + 1, close) : ''
}

const quotedURLs = source => [...source.matchAll(/"(https:\/\/[^"\s]+)"/g)].map(match => match[1])
const remoteFileName = (url, fallback, extension) => {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).at(-1) || '')
    if (name.includes('.')) return name
    if (name) return `${name}.${extension}`
  } catch { /* use fallback */ }
  return `${fallback}.${extension}`
}

const feedViewPath = path.join(workspace, 'Poplur2025-iOS/Poplur2025/FeedView.swift')
if (exists(feedViewPath)) {
  const source = fs.readFileSync(feedViewPath, 'utf8')
  quotedURLs(swiftArrayBody(source, 'reliableDemoVideoURLs')).forEach((url, index) => {
    const name = remoteFileName(url, `feed-demo-video-${index + 1}`, 'mp4')
    addRemoteAsset({ type: 'video', name, label: name.replace(/\.[^.]+$/, ''), url, sourcePath: relative(feedViewPath) })
  })

  const imageIDs = [...swiftArrayBody(source, 'reliableDemoImageIDs').matchAll(/\d+/g)].map(match => match[0])
  imageIDs.forEach(id => {
    const url = `https://picsum.photos/id/${id}/1080/1920`
    addRemoteAsset({ type: 'image', name: `feed-demo-image-${id}.jpg`, label: `Feed Demo Image ${id}`, url, sourcePath: relative(feedViewPath) })
  })

  const driveIDs = [...new Set([...source.matchAll(/googleDriveMediaURL\(fileID:\s*"([^"]+)"\)/g)].map(match => match[1]))]
  driveIDs.forEach((id, index) => {
    addRemoteAsset({
      type: 'video',
      name: `poplur-feed-creative-${String(index + 1).padStart(2, '0')}.mp4`,
      label: `Poplur Feed Creative ${String(index + 1).padStart(2, '0')}`,
      url: `https://drive.google.com/uc?export=download&id=${id}`,
      sourcePath: relative(feedViewPath)
    })
  })
}

const fakePostPath = path.join(workspace, 'Poplur2025-iOS/Poplur2025/FakePostService.swift')
if (exists(fakePostPath)) {
  const source = fs.readFileSync(fakePostPath, 'utf8')
  quotedURLs(swiftArrayBody(source, 'imagePool')).forEach((url, index) => {
    const name = remoteFileName(url, `feed-seed-image-${index + 1}`, 'jpg')
    addRemoteAsset({ type: 'image', name, label: `Feed Seed Image ${String(index + 1).padStart(2, '0')}`, url, sourcePath: relative(fakePostPath) })
  })
  quotedURLs(swiftArrayBody(source, 'videoPool')).forEach((url, index) => {
    const name = remoteFileName(url, `feed-seed-video-${index + 1}`, 'mp4')
    addRemoteAsset({ type: 'video', name, label: name.replace(/\.[^.]+$/, ''), url, sourcePath: relative(fakePostPath) })
  })
}

icons.sort((a, b) => a.platform.localeCompare(b.platform) || a.family.localeCompare(b.family) || a.label.localeCompare(b.label))
assets.sort((a, b) => a.type.localeCompare(b.type) || a.project.localeCompare(b.project) || a.path.localeCompare(b.path))
models.sort((a, b) => a.project.localeCompare(b.project) || a.path.localeCompare(b.path))
sprites.sort((a, b) => a.project.localeCompare(b.project) || a.path.localeCompare(b.path))

const generatedAt = new Date().toISOString()
const workbenchSurfaces = [
  {
    id: 'favourites',
    label: 'Favourites',
    kind: 'workbench',
    title: 'Poplur Favourites',
    description: 'Quick links to the active Good Copy, Prototype, and Rough Copy workbenches.',
    file: path.join(workspace, '.claude/artifacts/poplur-favourites.html')
  }
].filter(surface => exists(surface.file)).map(surface => ({
  id: surface.id,
  label: surface.label,
  kind: surface.kind,
  title: surface.title,
  description: surface.description,
  path: relative(surface.file),
  url: urlFor(surface.file)
}))
const data = {
  generatedAt,
  surfaces: workbenchSurfaces,
  icons,
  assets,
  models,
  sprites,
  projects,
  summary: {
    icons: icons.length,
    assets: assets.length,
    images: assets.filter(item => item.type === 'image').length,
    videos: assets.filter(item => item.type === 'video').length,
    sounds: assets.filter(item => item.type === 'sound').length,
    models: models.length,
    sprites: sprites.length
  }
}

fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, `window.GCL_CATALOG_DATA = ${JSON.stringify(data)};\n`)
fs.writeFileSync(refreshMetaOutput, `window.GCL_REFRESH_META = ${JSON.stringify({ generatedAt })};\n`)
if (exists(gclHtmlOutput)) {
  const fallbackLabel = refreshLabel(generatedAt)
  let html = fs.readFileSync(gclHtmlOutput, 'utf8')
  html = html.replace(
    /(<div class="gcl-refresh-bar" id="gclRefreshBar" aria-live="polite")(?: data-generated-at="[^"]*")?>/,
    `$1 data-generated-at="${htmlAttr(generatedAt)}">`
  )
  html = html.replace(
    /(<strong id="gclRefreshText">)([\s\S]*?)(<\/strong>)/,
    `$1${htmlText(fallbackLabel)}$3`
  )
  fs.writeFileSync(gclHtmlOutput, html)
}
console.log(JSON.stringify({ output, refreshMetaOutput, gclHtmlOutput, ...data.summary }, null, 2))
