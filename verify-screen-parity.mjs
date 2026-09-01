#!/usr/bin/env node
// Render-parity gate: does the app, as it ACTUALLY RENDERS, still match the GCL prototype?
//
// Why this exists
// ---------------
// generate-gcl-screen-tracking.mjs decides a screen is "baseline" from git ancestry
// (merge-base --is-ancestor). That is a claim about history, not about pixels. On
// 2026-07-17 it reported Android prelogin-welcome as baseline on both platforms while
// the screen was visibly wrong on device: commit 79c31e7 had deleted the ticket
// substrate, and nothing in the git-based check could see it. Source reading did not
// catch it either. Only building, installing and LOOKING did.
//
// So this gate renders and compares. It never trusts a commit as evidence of a screen.
//
// THIS TOOL CAPTURES EVIDENCE. IT DOES NOT RETURN A VERDICT.
// -----------------------------------------------------------
// An automatic pass/fail was attempted on 2026-07-17 and measurably does not work.
// Against the known-bad and known-good Welcome renders, every metric tried scored them
// the same (whole-screen 0.1054 vs 0.1029; top-region 0.0582 vs 0.0440, both "passing";
// texture 1.144 vs 1.191). A gate built on any of them would have passed the regression
// it existed to catch. Two structural reasons:
//
//   * No full-composition reference exists. Good Copy stores the BACKDROP asset only;
//     good-copy-welcome.html renders a board mock, not a device-accurate screen. So
//     there is nothing to diff a real screenshot against, like for like.
//   * The regression is fine dot texture, which every downscale erases.
//
// What DID catch the bug was building, installing and LOOKING at the render. So this
// harness automates the expensive, reliable part — build/install/launch/capture — and
// emits the render next to its reference for a human (or vision model) to judge. It
// reports `review`, never `pass`.
//
// Other limits, always reported explicitly, never folded into a green:
//  * A screen with no reference cannot be checked at all.
//  * A platform with no attached device/simulator cannot be checked.
// Every such case is `uncovered` WITH A REASON, and counted.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { compareImages } from './screen-parity-compare.mjs'

const ROOT = '/Users/matrix/Developer'
const ARTIFACTS = path.join(ROOT, '.claude/artifacts')
const REPORT = path.join(ROOT, '.codex/screen-parity-report.json')
const WORK = '/private/tmp/poplur-screen-parity'
const ANDROID_SETTLE_SECONDS = Number(process.env.ANDROID_SETTLE_SECONDS || 20)

const ADB = '/Users/matrix/Library/Android/sdk/platform-tools/adb'
const PKG = 'com.apptists.poplur2025'

// --- screen registry -------------------------------------------------------
// reference.kind:
//   'baked' -> an approved PNG is embedded in the Good Copy source; extract it
//   'html'  -> the Good Copy source RENDERS the design; must be rasterised first
//   'none'  -> no approved artwork exists; this screen is NOT render-checkable
const SCREENS = [
  {
    id: 'prelogin-welcome',
    reference: { kind: 'baked', src: path.join(ROOT, 'good-copy-welcome.html') },
    targets: [
      // Capture the production entry point. WelcomeDemoActivity is a debug-only
      // harness and can render a simplified fallback that is not what users see.
      { platform: 'Android', launch: { type: 'activity', component: `${PKG}/.MainActivity` } },
      { platform: 'iOS', launch: { type: 'simulator', args: ['-UITestHooks'] } }
    ]
  },
  {
    id: 'prelogin-launch',
    reference: { kind: 'html', src: path.join(ROOT, 'good-copy-launch.html') },
    targets: [{ platform: 'Android', launch: { type: 'transient' } }],
    note: 'launch screen is transient; capture timing is inherently racy'
  },
  {
    id: 'prelogin-splash',
    reference: { kind: 'html', src: path.join(ROOT, 'good-copy-splash.html') },
    targets: [{ platform: 'Android', launch: { type: 'transient' } }],
    note: 'splash is transient; capture timing is inherently racy'
  },
  {
    id: 'prelogin-auth',
    reference: { kind: 'html', src: path.join(ARTIFACTS, 'poplur-prelogin-flow.html') },
    targets: [{ platform: 'Android', launch: { type: 'tap-from-welcome' } }]
  },
  {
    id: 'map',
    reference: { kind: 'none', why: 'backed by poplur-clay-map source (index.html/package.json), no approved reference image' },
    targets: [{ platform: 'Android', launch: { type: 'activity', component: `${PKG}/.ClayMapActivity` } }],
    note: 'clay map fetches its Mapbox stylesheet and style over the network; renders incorrectly offline'
  },
  {
    id: 'watch-radius',
    reference: { kind: 'html', src: path.join(ROOT, 'good-copy-watch-radius.html') },
    targets: [{ platform: 'Wear', launch: { type: 'wear' } }]
  },
  { id: 'web-live-site', reference: { kind: 'none', why: 'backed by .tsx/.css source; a web page, not a native screen' }, targets: [] },
  { id: 'web-beta-invite', reference: { kind: 'none', why: 'backed by .ts email template; not a native screen' }, targets: [] },
  { id: 'web-forgot-password', reference: { kind: 'none', why: 'backed by a Docs HTML preview; not a native screen' }, targets: [] }
]

// --- helpers ---------------------------------------------------------------
function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
}

// Pick the hero artwork out of a Good Copy page's embedded images.
//
// Do NOT select by byte size. good-copy-welcome.html embeds 8 PNGs: the hero ticket is
// 885x1701 but only 23K (flat pink + dots compresses hard), while the clay P logo is
// 256x254 and 117K (a photographic clay render). "Largest" picks the logo, and the gate
// then compares a whole screen against a logo and reports a false regression — which is
// exactly what happened on the first run.
//
// Aspect ratio is the honest discriminator: the hero is portrait (~1.9), every other
// asset is square (~1.0).
const MIN_HERO_ASPECT = 1.6

function pngSize(buf) {
  // IHDR width/height live at fixed offsets in every PNG.
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function extractBakedReference(htmlPath, outPath) {
  const html = fs.readFileSync(htmlPath, 'utf8')
  const candidates = []
  for (const m of html.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]{2000,})/g)) {
    const buf = Buffer.from(m[1], 'base64')
    const dim = pngSize(buf)
    if (!dim || !dim.width) continue
    candidates.push({ buf, ...dim, aspect: dim.height / dim.width })
  }
  const heroes = candidates.filter(c => c.aspect >= MIN_HERO_ASPECT)
  if (!heroes.length) return null
  // tallest portrait asset is the full-bleed backdrop
  heroes.sort((a, b) => b.height - a.height)
  fs.writeFileSync(outPath, heroes[0].buf)
  return outPath
}

function androidDevice() {
  const out = sh(ADB, ['devices']).stdout || ''
  const line = out.split('\n').find(l => /\tdevice$/.test(l))
  return line ? line.split('\t')[0] : null
}

function bootedSimulator() {
  const out = sh('xcrun', ['simctl', 'list', 'devices', 'booted']).stdout || ''
  const m = out.match(/\(([0-9A-F-]{36})\)\s*\(Booted\)/)
  return m ? m[1] : null
}

function captureAndroid(serial, outPath) {
  const res = spawnSync(ADB, ['-s', serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 })
  if (res.status !== 0 || !res.stdout?.length) return null
  fs.writeFileSync(outPath, res.stdout)
  return outPath
}

function captureSimulator(udid, outPath) {
  const res = sh('xcrun', ['simctl', 'io', udid, 'screenshot', outPath])
  return res.status === 0 && fs.existsSync(outPath) ? outPath : null
}

const IOS_BUNDLE = 'com.apptists.poplur2025'

// Launch the app on the simulator and confirm it actually came up. Returns
// {ok:false, reason} rather than throwing, so a missing install is reported as
// `uncovered` (honest) instead of `fail` (a lie about the screen).
function launchSimulatorApp(udid, args) {
  const listed = sh('xcrun', ['simctl', 'listapps', udid]).stdout || ''
  if (!listed.includes(IOS_BUNDLE)) {
    return { ok: false, reason: `${IOS_BUNDLE} is not installed on the simulator — build+install before trusting an iOS verdict` }
  }
  sh('xcrun', ['simctl', 'terminate', udid, IOS_BUNDLE])
  const res = sh('xcrun', ['simctl', 'launch', udid, IOS_BUNDLE, ...args])
  if (res.status !== 0) {
    return { ok: false, reason: `simctl launch failed: ${(res.stderr || res.stdout || '').trim().slice(0, 200)}` }
  }
  return { ok: true }
}

// --- main ------------------------------------------------------------------
function run() {
  fs.mkdirSync(WORK, { recursive: true })
  const serial = androidDevice()
  const udid = bootedSimulator()

  const results = []
  for (const screen of SCREENS) {
    // 1. reference availability gates everything
    if (screen.reference.kind === 'none') {
      results.push({ screen: screen.id, status: 'uncovered', reason: screen.reference.why })
      continue
    }
    let refPath = null
    if (screen.reference.kind === 'baked') {
      refPath = extractBakedReference(screen.reference.src, path.join(WORK, `${screen.id}.ref.png`))
      if (!refPath) {
        results.push({ screen: screen.id, status: 'uncovered', reason: `no embedded PNG found in ${path.basename(screen.reference.src)}` })
        continue
      }
    } else if (screen.reference.kind === 'html') {
      results.push({
        screen: screen.id,
        status: 'uncovered',
        reason: `reference is HTML (${path.basename(screen.reference.src)}) and must be rasterised; headless rasterisation not wired up yet`
      })
      continue
    }

    // 2. per-target capture + compare
    for (const target of screen.targets) {
      const base = { screen: screen.id, platform: target.platform }
      if (target.platform === 'Android') {
        if (!serial) { results.push({ ...base, status: 'uncovered', reason: 'no Android device attached' }); continue }
        if (target.launch.type !== 'activity') {
          results.push({ ...base, status: 'uncovered', reason: `launch type '${target.launch.type}' not automated (${screen.note || ''})`.trim() })
          continue
        }
        sh(ADB, ['-s', serial, 'shell', 'am', 'force-stop', PKG])
        const start = sh(ADB, ['-s', serial, 'shell', 'am', 'start', '-n', target.launch.component])
        if ((start.stdout || '').includes('Error') || start.status !== 0) {
          results.push({ ...base, status: 'error', reason: `am start failed: ${(start.stdout || start.stderr || '').trim().slice(0, 200)}` })
          continue
        }
        // MainActivity loads the GCL cube and splash assets asynchronously. Eight
        // seconds can capture the black GL handoff instead of the rendered screen.
        sh(ADB, ['-s', serial, 'shell', 'sleep', String(ANDROID_SETTLE_SECONDS)])
        const shot = captureAndroid(serial, path.join(WORK, `${screen.id}.android.png`))
        if (!shot) { results.push({ ...base, status: 'error', reason: 'screencap produced no data' }); continue }
        // Coarse distance is recorded as a WEAK hint only — it demonstrably cannot
        // separate this screen's regressions. The captured image is the real output.
        let hint = null
        try { hint = compareImages(shot, refPath) } catch { /* hint is optional */ }
        results.push({ ...base, status: 'review', actual: shot, reference: refPath, coarseHint: hint })
      } else if (target.platform === 'iOS') {
        if (!udid) { results.push({ ...base, status: 'uncovered', reason: 'no booted iOS simulator' }); continue }
        // The first version screenshotted whatever happened to be on screen — including
        // the springboard — and compared THAT to the reference. A capture is only evidence
        // if we launched the app ourselves and confirmed it is frontmost.
        const launched = launchSimulatorApp(udid, target.launch.args || [])
        if (!launched.ok) { results.push({ ...base, status: 'uncovered', reason: launched.reason }); continue }
        sh('sleep', ['6'])
        const shot = captureSimulator(udid, path.join(WORK, `${screen.id}.ios.png`))
        if (!shot) { results.push({ ...base, status: 'error', reason: 'simctl screenshot failed' }); continue }
        // Coarse distance is recorded as a WEAK hint only — it demonstrably cannot
        // separate this screen's regressions. The captured image is the real output.
        let hint = null
        try { hint = compareImages(shot, refPath) } catch { /* hint is optional */ }
        results.push({ ...base, status: 'review', actual: shot, reference: refPath, coarseHint: hint })
      } else {
        results.push({ ...base, status: 'uncovered', reason: `${target.platform} target not attached / not automated` })
      }
    }
  }

  const tally = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc }, {})
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    method: 'render-and-capture for review; git status is NOT accepted as evidence, and no automatic parity verdict is claimed',
    verdictPolicy: 'coarseHint is unreliable for this screen (measured: broken 0.1054 vs fixed 0.1029). A human or vision model must judge the captured image.',
    devices: { android: serial || null, iosSimulator: udid || null },
    tally,
    results
  }
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`)

  for (const r of results) {
    const tag = { review: 'REVIEW', uncovered: 'UNCOVERED', error: 'ERROR' }[r.status] || r.status.toUpperCase()
    const detail = r.actual ? `captured -> ${r.actual}` : (r.reason || '')
    console.log(`${tag.padEnd(10)} ${r.screen}${r.platform ? ` [${r.platform}]` : ''}  ${detail}`)
  }
  console.log(`\ntally: ${JSON.stringify(tally)}`)
  console.log(`report: ${REPORT}`)
  if (tally.uncovered) console.log(`NOTE: ${tally.uncovered} target(s) uncovered — this run verified nothing about them.`)
  if (tally.review) console.log(`NOTE: ${tally.review} capture(s) need a human/vision review. This tool does NOT decide parity.`)

  // Exit non-zero only on harness errors. There is no automatic verdict to gate on.
  process.exit(tally.error ? 1 : 0)
}

run()
