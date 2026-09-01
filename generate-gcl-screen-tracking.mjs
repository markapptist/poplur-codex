import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const workspace = '/Users/matrix/Developer'
const output = path.join(workspace, '.claude/artifacts/gcl-screen-tracking.js')
const syncStatePath = path.join(workspace, '.codex/gcl-sync-state.json')

let syncState = {}
try {
  syncState = JSON.parse(fs.readFileSync(syncStatePath, 'utf8'))
} catch {
  syncState = {}
}

const gitTargets = {
  ios: {
    repo: 'Poplur2025-iOS',
    platform: 'iOS'
  },
  android: {
    repo: 'Poplur2025-Android',
    platform: 'Android'
  },
  reactNative: {
    repo: 'Poplur2025-ReactNative',
    platform: 'React Native'
  },
  website: {
    repo: 'PoplurLandingPage-HTML',
    platform: 'Website'
  },
  clayMapWeb: {
    repo: 'poplur-clay-map',
    platform: 'Web source'
  }
}

const gitTarget = (target, paths, verification = 'verified', platform = target.platform) => ({
  type: 'git',
  platform,
  repo: target.repo,
  paths,
  verification
})

const pendingTarget = (platform, reason) => ({ type: 'pending', platform, reason })

const screens = [
  {
    key: 'prelogin-launch',
    sourcePaths: ['good-copy-launch.html'],
    enforceSourceFreshness: true,
    targets: [
      gitTarget(gitTargets.ios, ['Poplur2025/LaunchScreen.storyboard', 'Poplur2025/Poplur2025App.swift']),
      gitTarget(gitTargets.android, ['app/src/main/res/drawable/launch_screen.xml', 'app/src/main/AndroidManifest.xml', 'app/src/main/res/values/styles.xml']),
      gitTarget(gitTargets.reactNative, ['ios/Poplur/SplashScreen.storyboard', 'android/app/src/main/res/values/styles.xml'])
    ]
  },
  {
    key: 'prelogin-splash',
    sourcePaths: ['good-copy-splash.html'],
    enforceSourceFreshness: true,
    targets: [
      gitTarget(gitTargets.ios, ['Poplur2025/PoplurClaySplashView.swift', 'Poplur2025/poplur_splash.mp4']),
      gitTarget(gitTargets.android, ['app/src/main/java/com/apptists/poplur2025/ui/components/PoplurClaySplashOverlay.kt', 'app/src/main/res/raw/poplur_splash.mp4']),
      gitTarget(gitTargets.reactNative, ['src/screens/SplashScreen.tsx', 'src/assets/poplur_splash.mp4'])
    ]
  },
  {
    key: 'prelogin-welcome',
    sourcePaths: ['good-copy-welcome.html'],
    enforceSourceFreshness: true,
    targets: [
      gitTarget(gitTargets.ios, ['Poplur2025/WelcomeView.swift']),
      gitTarget(gitTargets.android, ['app/src/main/java/com/apptists/poplur2025/ui/screens/WelcomeAuthScreen.kt']),
      gitTarget(gitTargets.reactNative, [
        'src/screens/WelcomeScreen.tsx',
        'src/components/PoplurConfetti.tsx',
        'src/components/PoplurConfetti.web.tsx',
        'ios/Poplur/PoplurNativeConfettiManager.m',
        'android/app/src/main/java/com/apptist/poplur2025/reactnative/PoplurNativeConfettiView.kt'
      ])
    ]
  },
  {
    key: 'prelogin-auth',
    sourcePaths: [
      '.claude/artifacts/poplur-prelogin-flow.html',
      'Poplur2025-iOS/Poplur2025/WelcomeView.swift',
      'Poplur2025-iOS/Poplur2025/LoginView.swift',
      'Poplur2025-iOS/Poplur2025/SignUpView.swift',
      'Poplur2025-iOS/Poplur2025/PermissionOverlay.swift',
      'Poplur2025-iOS/Poplur2025/LocationProvider.swift',
      'Poplur2025-iOS/Poplur2025/LocationManager.swift'
    ],
    enforceSourceFreshness: true,
    targets: [
      gitTarget(gitTargets.ios, [
        'Poplur2025/WelcomeView.swift',
        'Poplur2025/LoginView.swift',
        'Poplur2025/SignUpView.swift',
        'Poplur2025/PermissionOverlay.swift',
        'Poplur2025/LocationProvider.swift',
        'Poplur2025/LocationManager.swift'
      ]),
      gitTarget(gitTargets.android, [
        'app/src/main/java/com/apptists/poplur2025/ui/screens/WelcomeAuthScreen.kt',
        'app/src/main/java/com/apptists/poplur2025/location/LocationProvider.kt'
      ]),
      gitTarget(gitTargets.reactNative, [
        'src/screens/WelcomeScreen.tsx',
        'src/screens/LoginScreen.tsx',
        'src/screens/SignUpScreen.tsx'
      ])
    ]
  },
  {
    key: 'map',
    sourcePaths: [
      'poplur-clay-map/index.html',
      'poplur-clay-map/package-lock.json',
      'poplur-clay-map/package.json',
      'poplur-clay-map/public',
      'poplur-clay-map/src',
      'poplur-clay-map/tsconfig.json',
      'poplur-clay-map/vite.config.ts',
      'poplur-clay-map/scripts/sync-mobile.sh'
    ],
    enforceSourceFreshness: true,
    targets: [
      gitTarget(gitTargets.ios, ['Poplur2025/PoplurClayMapView.swift', 'ClayMapWeb']),
      gitTarget(gitTargets.android, ['app/src/main/java/com/apptists/poplur2025/ClayMapActivity.kt', 'app/src/main/assets/claymap']),
      gitTarget(gitTargets.reactNative, ['src/screens/MapScreen.tsx', 'src/screens/MapScreen.web.tsx', 'src/assets/claymap/claymap.zip', 'src/screens/PostLoginHomeWebScreen.tsx']),
      gitTarget(gitTargets.clayMapWeb, ['index.html', 'package-lock.json', 'package.json', 'public', 'src', 'tsconfig.json', 'vite.config.ts', 'scripts/sync-mobile.sh'])
    ]
  },
  {
    key: 'watch-radius',
    sourcePaths: ['good-copy-watch-radius.html'],
    targets: [
      gitTarget(gitTargets.ios, ['PoplurWatch/RadiusWatchView.swift'], 'baseline', 'watchOS'),
      gitTarget(gitTargets.android, ['wear/src/main/java/com/apptists/poplur2025/wear/MainActivity.kt'], 'baseline', 'Wear OS')
    ]
  },
  {
    key: 'web-live-site',
    sourcePaths: ['PoplurLandingPage-HTML/PoplurApp/src/app/index.tsx', 'PoplurLandingPage-HTML/PoplurApp/src/global.css'],
    targets: [
      gitTarget(gitTargets.website, ['PoplurApp/src/app/index.tsx', 'PoplurApp/src/global.css'])
    ]
  },
  {
    key: 'web-beta-invite',
    sourcePaths: ['PoplurLandingPage-HTML/PoplurApp/src/app/email-preview.tsx', 'PoplurLandingPage-HTML/PoplurApp/src/emails/betaInviteEmail.ts'],
    targets: [
      gitTarget(gitTargets.website, ['PoplurApp/src/app/email-preview.tsx', 'PoplurApp/src/emails/betaInviteEmail.ts'])
    ]
  },
  {
    key: 'web-forgot-password',
    sourcePaths: ['Poplur2025-iOS/Docs/forgot-password-email-preview.html'],
    targets: [
      gitTarget(gitTargets.ios, ['Docs/forgot-password-email-preview.html'], 'verified', 'Web preview')
    ]
  }
]

function runGit(repo, args) {
  try {
    return execFileSync('git', ['-C', path.join(workspace, repo), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return ''
  }
}

function gitSucceeds(repo, args) {
  try {
    execFileSync('git', ['-C', path.join(workspace, repo), ...args], {
      stdio: ['ignore', 'ignore', 'ignore']
    })
    return true
  } catch {
    return false
  }
}

function sourceRevision(sourcePaths) {
  const ignoredDirs = new Set(['.git', 'node_modules', 'dist', 'build', 'tmp', 'models'])
  const files = []
  const visit = file => {
    if (!fs.existsSync(file)) return
    const stat = fs.statSync(file)
    if (stat.isDirectory()) {
      if (ignoredDirs.has(path.basename(file))) return
      for (const entry of fs.readdirSync(file)) visit(path.join(file, entry))
      return
    }
    if (stat.isFile()) files.push(file)
  }
  sourcePaths.forEach(file => visit(path.join(workspace, file)))
  files.sort((a, b) => path.relative(workspace, a).localeCompare(path.relative(workspace, b)))
  const hash = crypto.createHash('sha256')
  let latestMtime = 0
  for (const file of files) {
    const stat = fs.statSync(file)
    latestMtime = Math.max(latestMtime, stat.mtimeMs)
    hash.update(path.relative(workspace, file))
    hash.update(fs.readFileSync(file))
  }
  return {
    files: files.map(file => path.relative(workspace, file)),
    hash: files.length ? hash.digest('hex') : '',
    updatedAt: latestMtime ? new Date(latestMtime).toISOString() : ''
  }
}

function latestRemoteCommit(target) {
  const value = runGit(target.repo, [
    'log', '-1', '--format=%H%x1f%cI%x1f%s', '--remotes=origin', '--', ...target.paths
  ])
  if (!value) return null
  const [commit, committedAt, subject] = value.split('\x1f')
  return { commit, committedAt, subject }
}

function remotePushes(repo) {
  return runGit(repo, ['reflog', 'show', '--all', '--date=iso-strict', '--format=%H%x1f%gD%x1f%gs'])
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [head, selector, action] = line.split('\x1f')
      const match = selector.match(/^(refs\/remotes\/origin\/[^@]+)@\{(.+)\}$/)
      if (!match || action !== 'update by push') return null
      return { head, ref: match[1], pushedAt: match[2] }
    })
    .filter(Boolean)
}

const pushCache = new Map()
const ancestorCache = new Map()

function earliestConfirmedPush(repo, commit, committedAt) {
  if (!pushCache.has(repo)) pushCache.set(repo, remotePushes(repo))
  const committedMs = Date.parse(committedAt)
  const pushes = [...pushCache.get(repo)]
    .filter(push => !Number.isFinite(committedMs) || Date.parse(push.pushedAt) >= committedMs)
    .sort((a, b) => Date.parse(a.pushedAt) - Date.parse(b.pushedAt))
  for (const push of pushes) {
    const cacheKey = `${repo}:${commit}:${push.head}`
    if (!ancestorCache.has(cacheKey)) {
      ancestorCache.set(cacheKey, gitSucceeds(repo, ['merge-base', '--is-ancestor', commit, push.head]))
    }
    if (ancestorCache.get(cacheKey)) return push
  }
  return null
}

function buildGitTarget(screenKey, target, source, enforceSourceFreshness) {
  const revision = latestRemoteCommit(target)
  if (!revision) {
    return {
      platform: target.platform,
      status: 'pending',
      reason: 'No remote commit is recorded for this screen mapping'
    }
  }

  const pushed = earliestConfirmedPush(target.repo, revision.commit, revision.committedAt)
  let at = pushed?.pushedAt || revision.committedAt
  let timestampKind = pushed ? (pushed.head === revision.commit ? 'push' : 'confirmed') : 'commit'
  let status = target.verification === 'baseline' ? 'baseline' : pushed ? 'pushed' : 'baseline'
  let reason = target.verification === 'baseline'
    ? 'Historical native baseline; parity with the current approved source still needs verification'
    : pushed
      ? ''
      : 'Remote commit verified; exact push time is unavailable'

  const freshnessGraceMs = 2 * 60 * 1000
  if (enforceSourceFreshness && source.updatedAt && Date.parse(source.updatedAt) > Date.parse(at) + freshnessGraceMs) {
    status = 'pending'
    reason = 'Approved source changed after the latest tracked platform push'
  }

  const receipt = syncState.no_diff_verifications?.[screenKey]
  const platformReceipt = receipt?.platforms?.[target.platform]
  if (platformReceipt && receipt.source_hash === source.hash) {
    status = 'pushed'
    at = platformReceipt.verified_at || receipt.verified_at || at
    timestampKind = 'verification'
    reason = platformReceipt.reason || 'Exact source parity verified; no platform diff required'
  }

  return {
    platform: target.platform,
    status,
    at,
    timestampKind,
    repo: target.repo,
    ref: pushed?.ref || '',
    commit: revision.commit,
    subject: revision.subject,
    reason
  }
}

const screenTracking = {}
for (const screen of screens) {
  const source = sourceRevision(screen.sourcePaths)
  screenTracking[screen.key] = {
    source,
    targets: screen.targets.map(target => target.type === 'git'
      ? buildGitTarget(screen.key, target, source, screen.enforceSourceFreshness)
      : { platform: target.platform, status: 'pending', reason: target.reason })
  }
}

const payload = {
  version: 1,
  generatedAt: new Date().toISOString(),
  screens: screenTracking
}

fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, `window.GCL_SCREEN_TRACKING = ${JSON.stringify(payload, null, 2)};\n`)
console.log(`Wrote ${path.relative(workspace, output)} with ${Object.keys(screenTracking).length} tracked screens.`)
