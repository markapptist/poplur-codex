import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const workspace = '/Users/matrix/Developer'
const goodCopyPath = path.join(workspace, 'good-copy-live.html')
const roughCopyPath = path.join(workspace, 'rough-copy-live.html')
const catalogPath = path.join(workspace, '.claude/artifacts/rcl-screen-catalog.js')
const refreshPath = path.join(workspace, '.claude/artifacts/rcl-refresh-meta.json')
const pendingApprovalPath = path.join(workspace, '.claude/artifacts/rcl-pending-approval.js')
const artifactBase = 'http://127.0.0.1:8945/.claude/artifacts/'
const pausedPreviewDirectory = path.join(workspace, '.claude/artifacts/rcl-paused')
const approvedRun = process.argv.includes('--approved')
const bootstrapRun = process.argv.includes('--bootstrap') && (!fs.existsSync(roughCopyPath) || !fs.existsSync(catalogPath))

const preloginScreens = platform => [
  { group: 'Pre-login', label: 'Sign In · Face ID', src: `${artifactBase}poplur-prelogin-flow.html?embed=Sign%20In`, poster: `${artifactBase}gcl-paused/${platform}-sign-in-face-id.png`, trackingKey: 'prelogin-auth' },
  { group: 'Pre-login', label: 'Log in · Email', src: `${artifactBase}poplur-prelogin-flow.html?embed=Log%20in`, poster: `${artifactBase}gcl-paused/${platform}-log-in-email.png`, trackingKey: 'prelogin-auth' },
  { group: 'Pre-login', label: 'Sign up · Choose Account', src: `${artifactBase}poplur-prelogin-flow.html?embed=Sign%20up%20%C2%B7%201`, poster: `${artifactBase}gcl-paused/${platform}-sign-up-choose-account.png`, trackingKey: 'prelogin-auth' },
  { group: 'Pre-login', label: 'Sign up · Create Login', src: `${artifactBase}poplur-prelogin-flow.html?embed=Sign%20up%20%C2%B7%202`, poster: `${artifactBase}gcl-paused/${platform}-sign-up-create-login.png`, trackingKey: 'prelogin-auth' },
  { group: 'Pre-login', label: 'Sign up · Business Profile', src: `${artifactBase}poplur-prelogin-flow.html?embed=Sign%20up%20%C2%B7%203`, poster: `${artifactBase}gcl-paused/${platform}-sign-up-business-profile.png`, trackingKey: 'prelogin-auth' },
  { group: 'Pre-login', label: 'Sign up · Verify Business', src: `${artifactBase}poplur-prelogin-flow.html?embed=Sign%20up%20%C2%B7%204`, poster: `${artifactBase}gcl-paused/${platform}-sign-up-verify-business.png`, trackingKey: 'prelogin-auth' },
  { group: 'Pre-login', label: 'Sign up · Review & Submit', src: `${artifactBase}poplur-prelogin-flow.html?embed=Sign%20up%20%C2%B7%205`, poster: `${artifactBase}gcl-paused/${platform}-sign-up-review-submit.png`, trackingKey: 'prelogin-auth' },
  { group: 'Pre-login', label: 'Camera Permission', src: `${artifactBase}poplur-prelogin-flow.html?embed=Permission`, poster: `${artifactBase}gcl-paused/${platform}-camera-permission.png`, trackingKey: 'prelogin-auth' },
  { group: 'Pre-login', label: 'Location Permission', src: `${artifactBase}poplur-prelogin-flow.html?embed=Location%20Permission`, poster: `${artifactBase}gcl-paused/${platform}-location-permission.png`, trackingKey: 'prelogin-auth' }
]

if (!approvedRun && !bootstrapRun) {
  throw new Error('Rough Copy regeneration requires explicit approval. Re-run with --approved after the user approves the named change.')
}

const exists = value => fs.existsSync(value)
const slash = value => value.split(path.sep).join('/')
const relative = value => slash(path.relative(workspace, value))
const slug = value => String(value)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')

function walkFiles(root, include) {
  const files = []
  if (!exists(root)) return files
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ['node_modules', 'build', 'dist', 'DerivedData', 'Pods'].includes(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (include(full)) files.push(full)
    }
  }
  visit(root)
  return files
}

function extractArray(source, marker) {
  const markerIndex = source.indexOf(marker)
  if (markerIndex < 0) throw new Error(`Unable to find ${marker}`)
  const start = source.indexOf('[', markerIndex)
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '[') depth += 1
    if (char === ']') {
      depth -= 1
      if (depth === 0) return { start, end: index + 1, value: source.slice(start, index + 1) }
    }
  }
  throw new Error(`Unable to close ${marker}`)
}

function titleFromStem(stem) {
  let value = stem
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\bDemo\b/g, '')
    .replace(/\b(PreviewProvider|Previews?)\b/g, '')
    .trim()

  const removableSuffixes = ['Activity', 'Container', 'Coordinator', 'Overlay', 'Screen', 'Sheet', 'Page', 'View']
  let changed = true
  while (changed) {
    changed = false
    for (const suffix of removableSuffixes) {
      if (value.endsWith(` ${suffix}`)) {
        value = value.slice(0, -(suffix.length + 1)).trim()
        changed = true
      }
    }
  }

  value = value
    .replace(/^Poplur\s+/, '')
    .replace(/^D Ms\b/, 'DMs')
    .replace(/^D M S?\b/, 'DMs')
    .replace(/^D M\b/, 'DM')
    .replace(/^A I\b/, 'AI')
    .replace(/^F P S\b/, 'FPS')
    .replace(/^T V\b/, 'TV')
    .replace(/\s+/g, ' ')
    .trim()

  const aliases = new Map([
    ['App Settings', 'Settings'],
    ['Welcome Auth', 'Welcome'],
    ['Clay Splash', 'Splash'],
    ['Clay Map', 'Map'],
    ['Radius Watch', 'Radius'],
    ['DM', 'DMs'],
    ['DMs List', 'DMs'],
    ['Messages Views', 'Messages'],
    ['Popular Phone', 'Phone'],
    ['AI Create', 'Creator'],
    ['Feed Fullscreen Page', 'Feed Fullscreen'],
    ['Feed Fullscreen Page View', 'Feed Fullscreen']
  ])
  return aliases.get(value) || value
}

function swiftScreenDeclarations(source) {
  const names = []
  const expression = /^(?:(?:public|internal)\s+)?struct\s+([A-Za-z][A-Za-z0-9_]*)\s*:\s*View\b/gm
  for (const match of source.matchAll(expression)) {
    const name = match[1]
    if (/(View|Views|Page|Overlay|Sheet)$/.test(name) || ['PopularPhone', 'FPSGame', 'PoplurFPSGameSheet'].includes(name)) names.push(name)
  }
  return [...new Set(names)]
}

function kotlinScreenDeclarations(source) {
  const names = []
  const expression = /^(?:(?:public|internal)\s+)?fun\s+([A-Za-z][A-Za-z0-9_]*(?:Screen|Page|Overlay|Sheet|View))\s*\(/gm
  for (const match of source.matchAll(expression)) {
    if (!/Preview$/.test(match[1])) names.push(match[1])
  }
  return [...new Set(names)]
}

function approvalKey(label) {
  const value = String(label).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (/^(poplur )?clay splash$/.test(value) || value === 'splash') return 'splash'
  if (/^(welcome auth|welcome)$/.test(value)) return 'welcome'
  if (/^(poplur )?(clay )?map$/.test(value) || value === 'map demo') return 'map'
  if (/^(radius watch|radius)$/.test(value)) return 'radius'
  return value
}

function groupFor(label) {
  const value = label.toLowerCase()
  if (/(login|sign up|auth|wallet|permission)/.test(value)) return 'Pre-login'
  if (/^(home|feed|camera|profile|hold menu)$/.test(value)) return 'Core'
  if (/(dm|message|chat|call|notification|comment)/.test(value)) return 'Social'
  if (/(create|creator|studio|capture|media picker|image picker|audio setup|record)/.test(value)) return 'Create'
  if (/(game|fps|runner|quest|blast|hoops|pet)/.test(value)) return 'Games'
  if (/(settings|edit profile|profile stats|head scanner|account)/.test(value)) return 'Account'
  if (/(store|cart|music|search|browser|street|look around|delivery|tv|news)/.test(value)) return 'Explore'
  return 'Other'
}

function platformFor(sourcePath) {
  if (sourcePath.startsWith('Poplur2025-iOS/PoplurWatch/')) return 'watchOS'
  if (sourcePath.startsWith('Poplur2025-iOS/')) return 'iOS'
  if (sourcePath.startsWith('Poplur2025-Android/wear/')) return 'Wear OS'
  if (sourcePath.startsWith('Poplur2025-Android/')) return 'Android'
  if (sourcePath.startsWith('Poplur2025-ReactNative/')) return 'React Native'
  if (sourcePath.startsWith('PoplurLandingPage-HTML/')) return 'Website'
  if (sourcePath.startsWith('poplur-clay-map/')) return 'Clay Map'
  return 'Artifact'
}

function repoFor(sourcePath) {
  return sourcePath.split('/')[0].startsWith('.') ? 'Poplur artifacts' : sourcePath.split('/')[0]
}

function fileRevision(sourcePath) {
  const full = path.join(workspace, sourcePath)
  if (!exists(full)) return null
  const stat = fs.statSync(full)
  if (!stat.isFile()) return null
  return {
    path: sourcePath,
    platform: platformFor(sourcePath),
    repo: repoFor(sourcePath),
    updatedAt: new Date(stat.mtimeMs).toISOString(),
    bytes: stat.size,
    hash: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
  }
}

function sourceUrl(sourcePath) {
  return '/' + sourcePath.split('/').map(encodeURIComponent).join('/')
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function posterData(screen, surfaceId) {
  const isWeb = surfaceId === 'web'
  const width = isWeb ? 1440 : surfaceId === 'ipad' ? 834 : surfaceId === 'watch' ? 198 : 390
  const height = isWeb ? 900 : surfaceId === 'ipad' ? 1194 : surfaceId === 'watch' ? 242 : 845
  const labelSize = isWeb ? 56 : surfaceId === 'ipad' ? 44 : 30
  const detailSize = isWeb ? 22 : surfaceId === 'ipad' ? 18 : 13
  const platforms = screen.platforms.join(' / ') || 'Poplur source'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#09070d"/><circle cx="${Math.round(width * .18)}" cy="${Math.round(height * .16)}" r="${Math.round(width * .19)}" fill="#29101f"/><circle cx="${Math.round(width * .87)}" cy="${Math.round(height * .82)}" r="${Math.round(width * .28)}" fill="#190d18"/><rect x="${Math.round(width * .09)}" y="${Math.round(height * .09)}" width="${Math.round(width * .13)}" height="${Math.round(width * .13)}" rx="${Math.round(width * .03)}" fill="#f72686"/><text x="${Math.round(width * .155)}" y="${Math.round(height * .09 + width * .092)}" fill="#fff7fb" text-anchor="middle" font-family="Arial,sans-serif" font-size="${Math.round(width * .08)}" font-weight="900">P</text><text x="${Math.round(width * .09)}" y="${Math.round(height * .45)}" fill="#ffb9da" font-family="Arial,sans-serif" font-size="${detailSize}" font-weight="800" letter-spacing="2">ROUGH COPY / LIVE SOURCE</text><text x="${Math.round(width * .09)}" y="${Math.round(height * .53)}" fill="#fff7fb" font-family="Arial,sans-serif" font-size="${labelSize}" font-weight="900">${xml(screen.label)}</text><text x="${Math.round(width * .09)}" y="${Math.round(height * .59)}" fill="#a89da7" font-family="Arial,sans-serif" font-size="${detailSize}" font-weight="700">${xml(platforms)}</text><rect x="${Math.round(width * .09)}" y="${Math.round(height * .67)}" width="${Math.round(width * .82)}" height="2" fill="#4b1c36"/><text x="${Math.round(width * .09)}" y="${Math.round(height * .73)}" fill="#f72686" font-family="Arial,sans-serif" font-size="${detailSize}" font-weight="800">Hover to open the current repo view</text></svg>`
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
}

const goodCopySource = fs.readFileSync(goodCopyPath, 'utf8')
const goodCopyArray = extractArray(goodCopySource, 'const surfaces = [')
const goodCopySurfaces = vm.runInNewContext(`(${goodCopyArray.value})`, {
  workspace: 'http://127.0.0.1:8945/',
  artifacts: 'http://127.0.0.1:8945/.claude/artifacts/',
  preloginScreens,
  window: {}
})

const approvedBySurface = new Map(goodCopySurfaces.map(surface => [
  surface.id,
  new Set((surface.screens || []).filter(screen => screen.src || screen.image).map(screen => approvalKey(screen.label)))
]))

const candidates = new Map()

function addCandidate({ id, label, group, sourcePaths = [], surfaceIds = ['iphone', 'ipad'], preview = '', approvalLabel = '' }) {
  if (!label) return
  const key = id || slug(label)
  const current = candidates.get(key) || {
    id: key,
    label,
    group: group || groupFor(label),
    sourcePaths: [],
    surfaceIds: [],
    preview: '',
    approvalLabel: approvalLabel || label
  }
  current.sourcePaths = [...new Set([...current.sourcePaths, ...sourcePaths.filter(Boolean)])]
  current.surfaceIds = [...new Set([...current.surfaceIds, ...surfaceIds])]
  if (preview) current.preview = preview
  if (group) current.group = group
  if (approvalLabel) current.approvalLabel = approvalLabel
  candidates.set(key, current)
}

const iosRoot = path.join(workspace, 'Poplur2025-iOS/Poplur2025')
for (const file of walkFiles(iosRoot, value => value.endsWith('.swift'))) {
  const stem = path.basename(file, '.swift')
  const source = fs.readFileSync(file, 'utf8')
  const declarations = swiftScreenDeclarations(source)
  if (!declarations.length && (/(View|Views|Page|Overlay|Sheet)$/.test(stem) || ['FPSGame', 'PopularPhone'].includes(stem))) declarations.push(stem)
  for (const declaration of declarations) {
    const label = titleFromStem(declaration)
    const preview = /FPS/.test(declaration)
      ? 'http://127.0.0.1:8945/Poplur2025-iOS/Poplur2025/PoplurFPS/index.html'
      : ''
    addCandidate({ label, sourcePaths: [relative(file)], preview })
  }
}

const androidRoots = [
  path.join(workspace, 'Poplur2025-Android/app/src/main/java')
]
for (const root of androidRoots) {
  for (const file of walkFiles(root, value => value.endsWith('.kt'))) {
    const stem = path.basename(file, '.kt')
    const source = fs.readFileSync(file, 'utf8')
    const declarations = kotlinScreenDeclarations(source)
    const isScreenFile = /\/ui\/(?:games\/)?screens\//.test(slash(file)) || /(Activity|Fragment)$/.test(stem)
    if (!declarations.length && isScreenFile) declarations.push(stem)
    for (const declaration of declarations) {
      addCandidate({ label: titleFromStem(declaration), sourcePaths: [relative(file)] })
    }
  }
}
const androidSheet = path.join(workspace, 'Poplur2025-Android/app/src/main/java/com/apptists/poplur2025/ui/components/MusicSearchSheet.kt')
if (exists(androidSheet)) addCandidate({ label: titleFromStem('MusicSearchSheet'), sourcePaths: [relative(androidSheet)] })

// Keep watch surfaces discoverable too. The phone/tablet scan intentionally
// stays scoped to the main app target, while watchOS and Wear OS have their
// own source roots and therefore need explicit surface ownership.
const watchIosRoot = path.join(workspace, 'Poplur2025-iOS/PoplurWatch')
for (const file of walkFiles(watchIosRoot, value => value.endsWith('.swift'))) {
  const stem = path.basename(file, '.swift')
  const isScreenShaped = /(View|Views|Page|Overlay|Sheet)$/.test(stem)
  if (!isScreenShaped) continue
  addCandidate({ label: titleFromStem(stem), sourcePaths: [relative(file)], surfaceIds: ['watch'] })
}

const wearRoot = path.join(workspace, 'Poplur2025-Android/wear/src/main')
for (const file of walkFiles(wearRoot, value => value.endsWith('.kt'))) {
  const stem = path.basename(file, '.kt')
  const isScreenShaped = /(Activity|Screen|View|Fragment)$/.test(stem)
  if (!isScreenShaped) continue
  addCandidate({ label: titleFromStem(stem), sourcePaths: [relative(file)], surfaceIds: ['watch'] })
}

const rnRoot = path.join(workspace, 'Poplur2025-ReactNative/src/screens')
for (const file of walkFiles(rnRoot, value => /\.(tsx|ts|jsx|js)$/.test(value))) {
  const stem = path.basename(file).replace(/\.(tsx|ts|jsx|js)$/, '').replace(/\.web$/, '')
  addCandidate({ label: titleFromStem(stem), sourcePaths: [relative(file)] })
}

const webRoot = path.join(workspace, 'PoplurLandingPage-HTML/PoplurApp/src/app')
for (const file of walkFiles(webRoot, value => /\.(tsx|jsx)$/.test(value))) {
  const stem = path.basename(file).replace(/\.(tsx|jsx)$/, '')
  if (stem.startsWith('_') || stem === 'index' || stem === 'email-preview') continue
  addCandidate({ label: titleFromStem(stem), sourcePaths: [relative(file)], surfaceIds: ['web'] })
}

const clayRoot = path.join(workspace, 'poplur-clay-map/src')
for (const file of walkFiles(clayRoot, value => /Map\.tsx$/.test(value))) {
  addCandidate({ label: titleFromStem(path.basename(file, '.tsx')), sourcePaths: [relative(file)], surfaceIds: ['web'] })
}

const artifactSources = [
  '.claude/artifacts/poplur-subscreen-twins.html',
  '.claude/artifacts/poplur-subscreen-twins.css',
  '.claude/artifacts/poplur-subscreen-twins.js'
]

const mainRoutes = [
  ['Home', 'home'],
  ['Feed', 'feed'],
  ['Camera', 'camera'],
  ['Profile', 'profile'],
  ['Hold Menu', 'holdmenu']
]
for (const [label, route] of mainRoutes) {
  addCandidate({ label, group: 'Core', preview: `http://127.0.0.1:5173/?view=${route}` })
}

addCandidate({
  label: 'Login',
  group: 'Pre-login',
  sourcePaths: ['Poplur2025-iOS/Poplur2025/LoginView.swift', 'Poplur2025-ReactNative/src/screens/LoginScreen.tsx', '.claude/artifacts/poplur-prelogin-flow.html'],
  preview: `${artifactBase}poplur-prelogin-flow.html?embed=Log%20in`
})
addCandidate({
  label: 'Sign Up',
  group: 'Pre-login',
  sourcePaths: ['Poplur2025-iOS/Poplur2025/SignUpView.swift', 'Poplur2025-ReactNative/src/screens/SignUpScreen.tsx', '.claude/artifacts/poplur-prelogin-flow.html'],
  preview: `${artifactBase}poplur-prelogin-flow.html?embed=Sign%20up%20%C2%B7%201`
})
addCandidate({
  id: 'location-permission',
  label: 'Location Permission',
  group: 'Pre-login',
  sourcePaths: [
    'Poplur2025-iOS/Poplur2025/LocationProvider.swift',
    'Poplur2025-iOS/Poplur2025/LocationManager.swift',
    '.claude/artifacts/poplur-prelogin-flow.html'
  ],
  preview: `${artifactBase}poplur-prelogin-flow.html?embed=Location%20Permission`
})

const subscreens = {
  Feed: [
    ['feed-tvguide', 'TV Guide'], ['feed-comments', 'Comments'], ['feed-news', 'News'],
    ['feed-music', 'Music'], ['feed-games', 'Games'], ['feed-like', 'Like'], ['feed-cc', 'CC On/Off']
  ],
  Camera: [
    ['camera-capture', 'Capture'], ['camera-roll', 'Camera Roll'], ['camera-create', 'Create'],
    ['camera-preview', 'Preview'], ['camera-chat', 'Chat'], ['camera-store', 'Store']
  ],
  Map: [
    ['map-locate', 'Locate'], ['map-post', 'Post'], ['map-tour', 'Tour'],
    ['map-search', 'Search'], ['map-claims', 'Claims'], ['map-chat', 'Chat']
  ],
  Profile: [
    ['profile-messages', 'Messages'], ['profile-settings', 'Settings'], ['profile-stats', 'Stats'],
    ['profile-alerts', 'Notifications'], ['profile-store', 'Store'], ['profile-phone', 'Phone'], ['profile-creator', 'Creator']
  ]
}
const parentSource = {
  Feed: 'Poplur2025-iOS/Poplur2025/FeedView.swift',
  Camera: 'Poplur2025-iOS/Poplur2025/HomeView.swift',
  Map: 'Poplur2025-iOS/Poplur2025/MapView.swift',
  Profile: 'Poplur2025-iOS/Poplur2025/ProfileView.swift'
}
for (const [parent, items] of Object.entries(subscreens)) {
  for (const [embed, label] of items) {
    addCandidate({
      id: `${slug(parent)}-${slug(label)}`,
      label,
      group: `${parent} Subscreens`,
      sourcePaths: [parentSource[parent], ...artifactSources],
      preview: `${artifactBase}poplur-subscreen-twins.html?embed=${encodeURIComponent(embed)}&rcl=1`,
      approvalLabel: label
    })
  }
}

const subscreenPreview = id => `${artifactBase}poplur-subscreen-twins.html?embed=${encodeURIComponent(id)}&rcl=1`
// Each rule must name the one screen its target actually depicts. A screen with no
// truthful twin falls through to the rough-copy-preview.html placeholder below rather
// than borrowing another screen's preview. Where a twin is ambiguous between two
// same-named screens (Chat: camera-chat vs map-chat), no rule is given on purpose.
const previewRules = [
  [/^settings$/i, subscreenPreview('profile-settings')],
  [/^messages$/i, subscreenPreview('profile-messages')],
  [/^profile stats$/i, subscreenPreview('profile-stats')],
  [/^store$/i, subscreenPreview('profile-store')],
  [/^notifications$/i, subscreenPreview('profile-alerts')],
  [/^phone$/i, subscreenPreview('profile-phone')],
  [/^creator$/i, subscreenPreview('profile-creator')],
  [/^camera roll$/i, subscreenPreview('camera-roll')],
  [/^capture$/i, subscreenPreview('camera-capture')],
  [/^create$/i, subscreenPreview('camera-create')],
  [/^preview$/i, subscreenPreview('camera-preview')],
  [/^games$/i, subscreenPreview('feed-games')],
  [/^tv guide$/i, subscreenPreview('feed-tvguide')],
  [/^music$/i, subscreenPreview('feed-music')],
  [/^comments$/i, subscreenPreview('feed-comments')],
  [/^news$/i, subscreenPreview('feed-news')],
  [/^like$/i, subscreenPreview('feed-like')],
  [/^cc on\/off$/i, subscreenPreview('feed-cc')],
  [/^locate$/i, subscreenPreview('map-locate')],
  [/^post$/i, subscreenPreview('map-post')],
  [/^tour$/i, subscreenPreview('map-tour')],
  [/^map search$/i, subscreenPreview('map-search')],
  [/^claims$/i, subscreenPreview('map-claims')],
  [/^feed$/i, 'http://127.0.0.1:5173/?view=feed'],
  [/^home$/i, 'http://127.0.0.1:5173/?view=home'],
  [/^profile$/i, 'http://127.0.0.1:5173/?view=profile'],
  [/^camera$/i, 'http://127.0.0.1:5173/?view=camera'],
  [/^hold menu$/i, 'http://127.0.0.1:5173/?view=holdmenu'],
  [/^fps game$/i, 'http://127.0.0.1:8945/Poplur2025-iOS/Poplur2025/PoplurFPS/index.html'],
  [/^login cube$/i, `${artifactBase}poplur-prelogin-flow.html?embed=Login%20Cube`],
  [/^location permission$/i, `${artifactBase}poplur-prelogin-flow.html?embed=Location%20Permission`],
  [/^permission$/i, `${artifactBase}poplur-prelogin-flow.html?embed=Permission`],
  // Wear OS watch face — Main renders the clay face; Globe Gdx Fragment is its globe.
  // Third element scopes the rule to the watch surface so phone/tablet "Main" screens
  // (which share the label) don't wrongly borrow this preview.
  [/^main$/i, `${artifactBase}poplur-watch-twin.html?face=wear`, 'watch'],
  [/^globe gdx fragment$/i, `${artifactBase}poplur-watch-twin.html?face=wear`, 'watch']
]

for (const candidate of candidates.values()) {
  if (candidate.preview) continue
  const rule = previewRules.find(([pattern, , surface]) =>
    pattern.test(candidate.label) && (!surface || (candidate.surfaceIds || []).includes(surface)))
  if (rule) { candidate.preview = rule[1]; candidate.previewSurface = rule[2] || null }
}

const frameDefaults = {
  iphone: { label: 'Phone Screens', frameClass: 'phone', sourceWidth: 390, sourceHeight: 845, frameChrome: 14 },
  ipad: { label: 'Tablet Screens', frameClass: 'ipad', sourceWidth: 834, sourceHeight: 1194, frameChrome: 14 },
  watch: { label: 'Watch Screens', frameClass: 'watch', sourceWidth: 1136, sourceHeight: 1385, frameChrome: 18 },
  web: { label: 'Web Screens', frameClass: 'web', sourceWidth: 1440, sourceHeight: 900, frameChrome: 16 }
}

const screenRevisions = new Map()
const builtScreens = []
for (const candidate of candidates.values()) {
  const revisions = candidate.sourcePaths.map(fileRevision).filter(Boolean)
  const platforms = [...new Set(revisions.map(item => item.platform))]
  const updatedAt = revisions.reduce((latest, item) => Date.parse(item.updatedAt) > Date.parse(latest || 0) ? item.updatedAt : latest, '')
  builtScreens.push({ ...candidate, revisions, platforms, updatedAt })
}

function trackingFor(screen) {
  const grouped = new Map()
  for (const revision of screen.revisions) {
    const current = grouped.get(revision.platform)
    if (!current || Date.parse(revision.updatedAt) > Date.parse(current.updatedAt)) grouped.set(revision.platform, revision)
  }
  return {
    source: {
      files: screen.revisions.map(item => item.path),
      hash: crypto.createHash('sha256').update(screen.revisions.map(item => item.hash).join(':')).digest('hex'),
      updatedAt: screen.updatedAt
    },
    targets: [...grouped.values()].map(item => ({
      platform: item.platform,
      status: 'pushed',
      at: item.updatedAt,
      timestampKind: 'verification',
      repo: item.repo,
      subject: 'Live repository source',
      reason: 'Rough Copy follows this source automatically'
    }))
  }
}

const tracking = {}
const surfaces = []
for (const surfaceId of ['iphone', 'ipad', 'watch', 'web']) {
  const approved = approvedBySurface.get(surfaceId) || new Set()
  const screens = builtScreens
    .filter(screen => screen.surfaceIds.includes(surfaceId))
    .filter(screen => !approved.has(approvalKey(screen.approvalLabel)))
    .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label))
    .map(screen => {
      const trackingKey = `rcl-${surfaceId}-${screen.id}`
      tracking[trackingKey] = trackingFor(screen)
      const fallback = `${artifactBase}rough-copy-preview.html?surface=${encodeURIComponent(surfaceId)}&screen=${encodeURIComponent(screen.id)}`
      // A surface-scoped preview only applies on its own surface; a shared-label
      // screen (e.g. phone + wear "Main") keeps the placeholder on other surfaces.
      const preview = (screen.preview && (!screen.previewSurface || screen.previewSurface === surfaceId))
        ? screen.preview
        : fallback
      const posterKey = crypto.createHash('sha256')
        .update(`${surfaceId}:${frameDefaults[surfaceId].sourceWidth}x${frameDefaults[surfaceId].sourceHeight}:${preview}`)
        .digest('hex')
        .slice(0, 16)
      const posterFile = `rcl-${surfaceId}-${posterKey}.png`
      const firstSource = screen.revisions
        .slice()
        .sort((a, b) => ['iOS', 'Android', 'React Native', 'Website', 'Clay Map', 'Artifact'].indexOf(a.platform) - ['iOS', 'Android', 'React Native', 'Website', 'Clay Map', 'Artifact'].indexOf(b.platform))[0]
      return {
        id: screen.id,
        group: screen.group,
        label: screen.label,
        src: preview,
        sourceUrl: firstSource ? sourceUrl(firstSource.path) : fallback,
        sourcePaths: screen.revisions.map(item => item.path),
        platforms: screen.platforms,
        updatedAt: screen.updatedAt,
        trackingKey,
        poster: `${artifactBase}rcl-paused/${posterFile}`,
        posterPath: `.claude/artifacts/rcl-paused/${posterFile}`
      }
    })
  surfaces.push({ id: surfaceId, ...frameDefaults[surfaceId], screens })
}

surfaces.push(
  { id: 'assets', label: 'Assets', kind: 'library', screens: [] },
  { id: 'misc', label: 'MISC', kind: 'misc', screens: [] }
)

const generatedAt = new Date().toISOString()

// Approved change (user-directed): the RCL Pre-login area shows the approved
// prototype flow (9 screens: Sign In, Log in, the 5 sign-up steps, and the 2
// permission screens), overriding the usual approved-exclusion for this one
// section. Replaces the generic source-derived entries (Login, Sign Up, Login
// Cube, Permission). Posters are RCL hash-based so `capture --missing` grabs
// fresh captures of the now-textured live embeds.
for (const surface of surfaces) {
  if (surface.id !== 'iphone' && surface.id !== 'ipad') continue
  const others = surface.screens.filter(screen => screen.group !== 'Pre-login')
  const injected = preloginScreens(surface.id).map(screen => {
    const id = slug(screen.label)
    const preview = screen.src
    const posterKey = crypto.createHash('sha256')
      .update(`${surface.id}:${frameDefaults[surface.id].sourceWidth}x${frameDefaults[surface.id].sourceHeight}:${preview}`)
      .digest('hex')
      .slice(0, 16)
    const posterFile = `rcl-${surface.id}-${posterKey}.png`
    const trackingKey = `rcl-${surface.id}-${id}`
    tracking[trackingKey] = {
      source: { files: ['.claude/artifacts/poplur-prelogin-flow.html'], hash: '', updatedAt: generatedAt },
      targets: []
    }
    return {
      id,
      group: 'Pre-login',
      label: screen.label,
      src: preview,
      sourceUrl: '/.claude/artifacts/poplur-prelogin-flow.html',
      sourcePaths: ['.claude/artifacts/poplur-prelogin-flow.html'],
      platforms: ['Artifact'],
      updatedAt: generatedAt,
      trackingKey,
      poster: `${artifactBase}rcl-paused/${posterFile}`,
      posterPath: `.claude/artifacts/rcl-paused/${posterFile}`
    }
  })
  // stable sort by group only → pre-login keeps flow order, other groups keep their label order
  surface.screens = [...injected, ...others].sort((a, b) => a.group.localeCompare(b.group))
}

const payload = {
  version: 1,
  generatedAt,
  source: 'Live Poplur repositories minus approved Good Copy screens',
  surfaces,
  summary: Object.fromEntries(surfaces.filter(surface => !surface.kind).map(surface => [surface.id, surface.screens.length]))
}
const trackingPayload = { version: 1, generatedAt, screens: tracking }

fs.mkdirSync(path.dirname(catalogPath), { recursive: true })
fs.mkdirSync(pausedPreviewDirectory, { recursive: true })
fs.writeFileSync(catalogPath, `window.RCL_SCREEN_CATALOG = ${JSON.stringify(payload, null, 2)};\nwindow.GCL_SCREEN_TRACKING = ${JSON.stringify(trackingPayload, null, 2)};\n`)
fs.writeFileSync(refreshPath, JSON.stringify({ generatedAt, summary: payload.summary }, null, 2) + '\n')

let roughCopySource = goodCopySource
roughCopySource = roughCopySource.slice(0, goodCopyArray.start) + 'window.RCL_SCREEN_CATALOG?.surfaces || []' + roughCopySource.slice(goodCopyArray.end)
roughCopySource = roughCopySource
  .replace('<title>Good Copy — Live</title>', '<title>Rough Copy — Live</title>')
  .replace('<!-- PROTECTED SOURCE: changing approved slots or republishing requires explicit user approval in the current conversation. -->', '<!-- PROTECTED ROUGH COPY SOURCE: changing screens, routes, or previews requires explicit user approval in the current conversation. -->')
  .replace('<h1>Good <span>Copy</span> · Live</h1>', '<h1>Rough <span>Copy</span> · Live</h1>')
  .replace('Approved screens are the source of truth for iOS and Android.', 'Every app screen not yet approved in Good Copy, held for review before Rough Copy edits are applied.')
  .replace('<div class="protected"><span class="lock">⌾</span> Protected · approval required to change</div>', '<div class="protected" id="rclApprovalStatus"><span class="lock">⌾</span> Protected · approval required to edit</div>')
  .replace('aria-label="Good Copy surfaces"', 'aria-label="Rough Copy surfaces"')
  .replace('<button class="screen-filter-button" type="button" data-screen-filter="approved" aria-pressed="false">Approved</button>', '<button class="screen-filter-button" type="button" data-screen-filter="approved" aria-pressed="false">Rough Copy</button>')
  .replace('Approved screens rest on a paused frame, then become live with animation and sound while active. Empty slots remain intentionally unapproved.', 'Rough screens show a static preview first, then open the current repository view only while active. Approved Good Copy screens disappear automatically.')
  .replace('background: radial-gradient(1000px 600px at 50% -10%, #123b27 0%, #07130d 63%);', 'background: radial-gradient(1000px 600px at 50% -10%, #4b111b 0%, #18080c 63%);')
  // Scroll-performance pass (approved): cards render poster-only — the live
  // iframe is created on activation and fully removed on stop, so 150+ idle
  // browsing contexts never mount and scrolling never fights embed loads.
  .replace(
    '<iframe title="${escapeCatalog(screen.label)}" data-src="${escapeCatalog(screenSource)}" allow="autoplay"></iframe><img class="paused-preview" src="${escapeCatalog(posterSource)}"',
    '<img class="paused-preview" data-live-src="${escapeCatalog(screenSource)}" data-live-title="${escapeCatalog(screen.label)}" src="${escapeCatalog(posterSource)}"'
  )
  .replace(
    '      const iframe = figure.querySelector("iframe[data-src]");\n      if (iframe) {\n        setPreviewAudio(iframe, false);\n        iframe.removeAttribute("src");\n      }',
    '      const iframe = figure.querySelector("iframe");\n      if (iframe) {\n        setPreviewAudio(iframe, false);\n        iframe.remove();\n      }'
  )
  .replace(
    '      const iframe = figure.querySelector("iframe[data-src]");\n      if (!iframe) return;\n      activePreview = figure;',
    '      const iframe = ensurePreviewFrame(figure);\n      if (!iframe) return;\n      activePreview = figure;'
  )
  .replace(
    '    function bindLivePreview(figure) {\n      const iframe = figure.querySelector("iframe[data-src]");\n      iframe.addEventListener("load", () => {\n        if (activePreview === figure) {\n          figure.classList.add("preview-active");\n          setPreviewAudio(iframe, true);\n        }\n      });\n      const activatePreview = () => startPreview(figure);\n      const deactivatePreview = event => {\n        if (!event.relatedTarget || !figure.contains(event.relatedTarget)) stopPreview(figure);\n      };',
    '    function ensurePreviewFrame(figure) {\n      let iframe = figure.querySelector("iframe");\n      if (iframe) return iframe;\n      const poster = figure.querySelector(".paused-preview");\n      const viewport = figure.querySelector(".viewport");\n      if (!poster || !viewport) return null;\n      iframe = document.createElement("iframe");\n      iframe.title = poster.dataset.liveTitle || "";\n      iframe.allow = "autoplay";\n      iframe.dataset.src = poster.dataset.liveSrc || "";\n      iframe.addEventListener("load", () => {\n        if (activePreview === figure) {\n          figure.classList.add("preview-active");\n          setPreviewAudio(iframe, true);\n        }\n      });\n      viewport.insertBefore(iframe, poster);\n      return iframe;\n    }\n\n    function bindLivePreview(figure) {\n      // Hover activation debounced so scrolling the cursor across the grid\n      // does not fire embed load/unload storms; clicks stay immediate.\n      let hoverTimer = 0;\n      const activatePreview = () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(() => startPreview(figure), 350); };\n      const deactivatePreview = event => {\n        if (!event.relatedTarget || !figure.contains(event.relatedTarget)) { clearTimeout(hoverTimer); stopPreview(figure); }\n      };'
  )
  .replace(
    'figure.preview-active .paused-preview { opacity: 0; pointer-events: none; }',
    'figure.preview-active .paused-preview { opacity: 0; pointer-events: none; }\n    .grid figure { content-visibility: auto; contain-intrinsic-size: auto 620px; }'
  )
  .replace('<span class="approval-label">CEO approval</span>', '<span class="approval-label">Rough Copy approval</span>')
  .replace('<span class="approval-title">Good Copy Library approved for Poplur production reference</span>', '<span class="approval-title" id="rclApprovalTitle">Rough Copy edits require approval before they are applied</span>')
  .replace('<div class="signature">Mark</div>', '<div class="signature">Review</div>')
  .replace('<div class="signature-role">CEO of Poplur</div>', '<div class="signature-role">Approval gate</div>')
  // Catalog script URL is versioned per generation so a stale browser cache can
  // never pair an old catalog with fresh refresh-meta (the 2s reload-loop bug).
  .replace('<script src="/.claude/artifacts/gcl-screen-tracking.js"></script>', `<script src="/.claude/artifacts/rcl-screen-catalog.js?v=${Date.parse(generatedAt)}"></script>\n  <script src="/.claude/artifacts/rcl-pending-approval.js?v=${Date.parse(generatedAt)}"></script>`)
  .replace('const collapsedGroupStorageKey = "gclCollapsedGroups.v1";', 'const collapsedGroupStorageKey = "rclCollapsedGroups.v1";')
  .replace('return `gcl-group-${slug}-${Math.abs(hashString(key))}`;', 'return `rcl-group-${slug}-${Math.abs(hashString(key))}`;')
  .replace('next.searchParams.set("gclRefresh", String(surfaceRefreshNonce));', 'next.searchParams.set("rclRefresh", String(surfaceRefreshNonce));')
  .replace('return `${url}${separator}gclRefresh=${surfaceRefreshNonce}`;', 'return `${url}${separator}rclRefresh=${surfaceRefreshNonce}`;')
  .replace('if (!url) return "";\n      try {', 'if (!url) return "";\n      if (String(url).startsWith("data:")) return url;\n      try {')
  .replace('function pausedPoster(surface, screen) {\n      const prefix', 'function pausedPoster(surface, screen) {\n      if (screen.poster) return screen.poster;\n      const prefix')
  .replace('`${visibleCount} of ${total} screens · ${approved} approved · ${recent} recently changed${sectionText}`', '`${visibleCount} of ${total} screens · ${approved} rough copy · ${recent} recently changed${sectionText}`')
  .replace('<span class="state">Approved · Tracked</span>', '<span class="state">Rough Copy · Live</span>')
  .replace('<span class="state unapproved">Not approved · Tracked</span>', '<span class="state unapproved">Source-only · Live</span>')
  .replace('const state = figure.classList.contains("live") ? "approved screen" : "unapproved slot";', 'const state = figure.classList.contains("live") ? "rough copy screen" : "source-only screen";')
  .replace('Tracking · awaiting approval', 'Tracking · source unavailable')
  .replace('figure { margin: 0; min-width: 0; }', `figure { position: relative; margin: 0; min-width: 0; }
    .delete-screen {
      position: absolute;
      top: 0;
      right: 0;
      z-index: 6;
      width: 30px;
      height: 30px;
      padding: 0;
      display: grid;
      place-items: center;
      border: 1px solid rgba(255, 116, 130, .58);
      border-radius: 50%;
      color: #ffd4d9;
      background: rgba(91, 13, 24, .9);
      font: 900 17px/1 system-ui, sans-serif;
      cursor: pointer;
      transition: color .16s ease, background .16s ease, transform .16s ease;
    }
    .delete-screen:hover,
    .delete-screen:focus-visible { color: #fff; background: #a4142c; transform: scale(1.06); }
    .delete-screen:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }`)
  .replace('figure.innerHTML = approved\n            ? `<figcaption>', 'figure.innerHTML = approved\n            ? `<button class="delete-screen" type="button" title="Move screen source to Recycling Bin" aria-label="Recycle ${escapeCatalog(screen.label)}">×</button><figcaption>')
  .replace('figure.querySelector(".edit-screen")?.addEventListener("click", event => event.stopPropagation());', 'figure.querySelector(".edit-screen")?.addEventListener("click", event => event.stopPropagation());\n          figure.querySelector(".delete-screen")?.addEventListener("click", event => { event.stopPropagation(); recycleRoughScreen(screen, surface); });')
  .replace(
    'figure.addEventListener("pointerenter", () => startPreview(figure));\n      figure.addEventListener("pointerleave", () => stopPreview(figure));\n      figure.addEventListener("click", () => startPreview(figure, true));',
    'const activatePreview = () => startPreview(figure);\n      const deactivatePreview = event => { if (!event.relatedTarget || !figure.contains(event.relatedTarget)) stopPreview(figure); };\n      figure.addEventListener("pointerenter", activatePreview);\n      figure.addEventListener("mouseenter", activatePreview);\n      figure.addEventListener("pointerleave", deactivatePreview);\n      figure.addEventListener("mouseleave", deactivatePreview);\n      figure.addEventListener("focusin", activatePreview);\n      figure.addEventListener("focusout", deactivatePreview);\n      figure.addEventListener("click", () => startPreview(figure, true));'
  )

const recycleScreenScript = `
    async function recycleRoughScreen(screen, surface) {
      const payload = { trackingKey: screen.trackingKey, surfaceId: surface.id };
      let planResponse;
      try {
        planResponse = await fetch("http://127.0.0.1:8946/api/recycle-screen/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
      } catch {
        alert("Recycling Bin is unavailable. Restart the Poplur artifact workbench and try again.");
        return;
      }
      const plan = await planResponse.json();
      if (!planResponse.ok || !plan.canRecycle) {
        const references = (plan.references || []).flatMap(item => item.paths || []).slice(0, 5);
        const detail = references.length ? "\\n\\nReferenced by:\\n" + references.join("\\n") : "";
        alert((plan.reason || plan.error || "This screen cannot be recycled safely.") + detail);
        return;
      }
      const paths = plan.deletionPaths.join("\\n");
      const impacted = plan.impactedScreens.length;
      const message = "Approve this Rough Copy deletion?\\n\\nMove " + screen.label + " to the Recycling Bin:\\n\\n" + paths + "\\n\\n" + impacted + " RCL screen entr" + (impacted === 1 ? "y" : "ies") + " will be removed. This approval applies only to this deletion, and the source remains restorable from Recycling Bin.";
      if (!confirm(message)) return;
      const response = await fetch("http://127.0.0.1:8946/api/recycle-screen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok) {
        alert(result.error || "The screen could not be recycled. No project files were left removed.");
        return;
      }
      location.reload();
    }
`
roughCopySource = roughCopySource.replace('    function renderBoard(surface) {', `${recycleScreenScript}\n    function renderBoard(surface) {`)

const liveRefreshScript = `\n  <script>\n    (() => {\n      // Restore the scroll position a refresh-reload saved, then let future\n      // regens reload through a cache-busted URL (never the 2s reload loop:\n      // the reload target re-fetches a versioned catalog, so stamps re-align).\n      try {\n        const savedY = Number(sessionStorage.getItem("rclScrollY") || "");\n        if (savedY > 0) {\n          sessionStorage.removeItem("rclScrollY");\n          window.setTimeout(() => window.scrollTo(0, savedY), 140);\n        }\n      } catch {}\n      let currentRclGeneration = window.RCL_SCREEN_CATALOG?.generatedAt || "";\n      let reloading = false;\n      window.setInterval(async () => {\n        if (reloading) return;\n        try {\n          const response = await fetch("/.claude/artifacts/rcl-refresh-meta.json?refresh=" + Date.now(), { cache: "no-store" });\n          const next = await response.json();\n          if (next.generatedAt && currentRclGeneration && next.generatedAt !== currentRclGeneration) {\n            reloading = true;\n            try { sessionStorage.setItem("rclScrollY", String(window.scrollY)); } catch {}\n            location.replace(location.pathname + "?rclv=" + Date.now() + location.hash);\n            return;\n          }\n          currentRclGeneration = next.generatedAt || currentRclGeneration;\n        } catch {}\n      }, 2000);\n    })();\n  </script>\n`
roughCopySource = roughCopySource.replace('</body>', `${liveRefreshScript}</body>`)
fs.writeFileSync(roughCopyPath, roughCopySource)

console.log(JSON.stringify({
  roughCopyPath: relative(roughCopyPath),
  catalogPath: relative(catalogPath),
  refreshPath: relative(refreshPath),
  generatedAt,
  screens: payload.summary,
  approvedExcluded: Object.fromEntries([...approvedBySurface].map(([surface, labels]) => [surface, labels.size]))
}, null, 2))
