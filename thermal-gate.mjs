#!/usr/bin/env node
// The thermal gate: after EVERY bundle build, re-measure the surfaces that
// have burned the phone before, and refuse to publish a regression.
//
// Ran automatically by poplur-clay-map/scripts/sync-mobile.sh between the
// build and the publish rsync (fail closed; POPLUR_THERMAL_SKIP=1 to override
// in an emergency, which prints loudly so the skip is never silent). That
// release path serves the just-built snapshot on a throwaway loopback port
// and passes it as POPLUR_THERMAL_BASE (with POPLUR_THERMAL_REQUIRE=1), so
// the gate measures the exact bytes being published. The 5199 default below
// exists for ad-hoc manual runs against the live workbench dev server only —
// gating a release on 5199 let concurrent editing sessions' HMR orphan rAF
// loops/WebGL contexts and fail builds that had not changed.
//
// What it measures, per surface, in headless Chrome (rAF runs there; the
// Browser pane pauses it) with ?iosTier=1 so the page is in the same tier the
// iPhone shell runs:
//   - INFINITE animations actually running (the 6 Aug device trace: per-frame
//     style recalc from exactly these was 49% of the visible process)
//   - renderer-thread CPU duration over an idle window (main-thread heat),
//     plus wall-clock long tasks as a diagnostic only
//   - live WebGL contexts (each is a renderer; leaks grow without bound)
//   - RUNNING AudioContexts (a running context keeps the audio render thread
//     mixing silence forever)
//   - playing, data-ready <video> elements (each is an actual decoder owner;
//     WebKit/Chrome can report a failed or not-yet-loaded element as unpaused)
//
// Budgets live in .codex/thermal-budgets.json. First run writes the baseline
// from what it measures (with stated headroom); later runs compare. Raise a
// budget deliberately by editing the file in the same commit as the feature
// that needs it — that is the whole point: heat becomes a reviewed change,
// not a surprise.

import { spawn, execSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUDGETS_PATH = join(HERE, 'thermal-budgets.json')
/**
 * Mapbox frames allowed while the map sits parked and untouched for 60s.
 *
 * Read here, not from the `budgets` object further down, because the idle
 * PRECONDITION needs it long before that object is parsed. See the
 * `_idleRendersNote` in thermal-budgets.json for why this is no longer a
 * hardcoded 2: a live board legitimately changes shape while nobody is
 * touching it, and each real change has to draw or the map is lying.
 */
const MAP_IDLE_RENDER_BUDGET = (() => {
  try {
    const value = Number(JSON.parse(readFileSync(BUDGETS_PATH, 'utf8'))?.budgets?.map?.maxIdleRenders)
    return Number.isFinite(value) && value >= 0 ? value : 2
  } catch {
    return 2
  }
})()
/** The same allowance pro-rated over the 10s quiescence window. Demanding
 *  EXACTLY zero renders there assumed a static board, so on a live one the
 *  heap leg could never start and reported "unmeasurable" instead of a number. */
const MAP_QUIESCENCE_RENDER_ALLOWANCE = Math.ceil((MAP_IDLE_RENDER_BUDGET * 10_000) / 60_000)
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = process.env.POPLUR_THERMAL_BASE || 'http://127.0.0.1:5199'
// Set by callers that own the server BASE points at (sync-mobile's snapshot
// server): an unreachable BASE is then a hard failure, never a soft skip — a
// release must not publish unmeasured because its own server died.
const REQUIRE_BASE = process.env.POPLUR_THERMAL_REQUIRE === '1'

// Settle times measure the TRULY idle state:
//  - home/feed settle past CHROME_IDLE_MS (30s): the stat-card beat and its
//    money-counter ticks sleep with the chrome, and a shorter settle catches
//    the awake drumbeat and flakes on its AudioContext wake.
//  - map uses front=0 to skip the cinematic intro outright; front=1 runs a
//    ~30s flight whose tile parsing bleeds long tasks into the sample window
//    (measured 2311ms vs 0ms on consecutive runs).
//
// PRE-LOGIN is measured only when POPLUR_PRELOGIN_BASE names a server for it.
// It lives outside the clay-map build this gate normally measures — it is built
// by the iOS prelogin script from the approved Good Copy source — so it needs a
// base of its own rather than a path under BASE. Unset (the default, and what
// sync-mobile does) leaves this file behaving exactly as before.
//
// It could not be measured at all until the pre-login document learned to
// declare idle: measure() below waits for `poplur-ambient-sleep` plus
// __poplurChromeIdle, and pre-login ran three permanent rAF loops, so it never
// rested and could never be sampled at rest. That is now fixed at the source.
const PRELOGIN_BASE = process.env.POPLUR_PRELOGIN_BASE || ''
const ROOT_SURFACES = [
  { name: 'home', path: '/?view=home&iosTier=1', settle: 36 },
  { name: 'feed', path: '/?view=feed&iosTier=1', settle: 36 },
  { name: 'map', path: '/?map=1&front=0&mapMode=3d&iosTier=1', settle: 26, isMap: true },
  // THE MAP AS USERS ACTUALLY ARRIVE AT IT. `map` above deliberately passes
  // front=0 to skip the cinematic intro, because the intro's tile parsing
  // bleeds long tasks into the IDLE census. That is the right call for idle —
  // and it is exactly why the arrival cost stayed invisible: front=0 is a map
  // no user ever sees. Tapping the map tab mounts front=1 (see HomeTwin's
  // iframe src), which flies the intro and pays the full warm-up.
  //
  // So measure that one too, for its arrival only: its budget entry carries
  // maxArrivalCpuMs and nothing else, and every idle check skips an absent
  // budget. Same settle as the heap surface, which already runs front=1 and
  // reaches a parked state there.
  { name: 'map-arrival', path: '/?map=1&front=1&mapMode=3d&iosTier=1', settle: 45, isMap: true },
  // PROFILE. Added after a device soak attributed the heat here: in the 32
  // minutes that ended in `fair` on an iPhone 16, dwell was 70.5% profile,
  // 13% map, 9% post, 7% feed — and profile had never been on this gate.
  //
  // It is the surface with the most video DECODERS in the app (eight <video>
  // elements; the avatar loop is a real decoder, not decorative CSS), which is
  // exactly what maxPlayingVideos exists to bound — a budget that was being
  // enforced on home and feed and never on the surface that actually carries
  // the decoders. Same settle as home/feed: it is the same shell chrome.
  { name: 'profile', path: '/?view=profile&iosTier=1', settle: 36 },
  // 24s: past the screen's own 20s quiet window, so the census lands on the
  // parked state rather than on the tail of the intro.
  ...(PRELOGIN_BASE
    ? [{ name: 'prelogin', path: '/welcome.html', settle: 24, base: PRELOGIN_BASE }]
    : []),
]

// ── SUBSCREENS: the hole this gate shipped two regressions through ─────────
// Everything above is a ROOT screen — a tab you land on. The hold menu opens
// EIGHTEEN subscreens that no root surface's census can see, and on 22 Aug 2026
// that blind spot shipped StatsScreen running SEVEN infinite
// background-position animations (repaint, not composite) on an idle screen:
// measured 793ms of renderer CPU per 8s idle window, against 6-9ms for every
// one of its siblings — the same shader-text class the 6 Aug device trace put
// at 49% of the visible WebContent process. No sampled surface could have
// caught it. (The same blind spot also hid libertyLandmark's per-render
// map.triggerRepaint, fa69dba, which was only visible at map near-zoom.)
//
// Measuring all of them on every publish is not affordable: each surface costs
// ~50-60s, and sync-mobile runs on every device push and on every watcher
// auto-sync. So the selection is CHANGE-AWARE — the property that actually
// matters is not "measure everything every time", it is "a subscreen whose own
// source changed is measured in the SAME publish that ships the change", which
// is exactly the Stats case and is caught with zero latency and zero average
// cost. A rotating slot covers the rest (a shared-CSS or governor regression
// that heats a screen whose own files never moved) at a bounded ~55s per run.
//
// Selection, per run:
//   · every subscreen whose owned sources hash differently than the last
//     PASSING measurement — capped, so a wide refactor cannot add ten minutes;
//     uncapped leftovers stay dirty and drain over the next runs
//   · if none are dirty, exactly ONE: the least-recently-measured screen
// Steady-state cost is therefore ONE extra surface (~55s) on a quiet publish
// and at most three (~3min) on a busy one — not the ~6 minutes a full sweep
// would add to every device push.
// Overrides: POPLUR_THERMAL_SUBSCREENS=all forces the full sweep (use it after
// a broad refactor, and for a deliberate audit), =off disables the leg loudly,
// POPLUR_THERMAL_SUBSCREEN_CAP raises/lowers the per-run cap (default 3).
//
// ADDING A SUBSCREEN: put it in the list below and give it a HAND-SET budget in
// thermal-budgets.json in the same commit. A surface with no budget falls to
// the generic first-run baseline further down, which records max(250,
// threadMs*1.5) from whatever that one run measured — on a screen that should
// be inert (these six measure 6-9ms) that is a 28x-loose budget, and if the
// screen happens to be regressed at that moment the regression becomes the
// budget. That is exactly what a budget must never be.
const SUBSCREEN_SOURCE_ROOT = process.env.POPLUR_THERMAL_SRC
  || '/Users/matrix/Developer/poplur-clay-map/src'
const SUBSCREEN_STATE_PATH = join(HERE, 'thermal-subscreen-state.json')
const SUBSCREEN_CAP = Math.max(1, Number(process.env.POPLUR_THERMAL_SUBSCREEN_CAP || 3))

// settle 36 — the home/feed number, not the map's 26. A subscreen is the same
// shell chrome as home, and its census must land past CHROME_IDLE_MS (30s) or
// it reads the awake drumbeat instead of the parked screen. Verified: all six
// reach `__poplurChromeIdle` plus `poplur-ambient-sleep` at this settle.
//
// `sources` is what makes a screen "dirty". Keep it to the files that can only
// affect THAT screen; shared files deliberately do not appear here, because
// HomeTwin/index.css change on nearly every publish and would dirty all six
// every time — turning the cheap leg back into the five-minute one. The
// rotating slot is what covers shared-code heat.
//
// STILL UNCOVERED, and honestly so: map-radio, map-ipod, map-show-me,
// feed-news, feed-tvguide, feed-games, camera-studio, camera-ai-chat,
// profile-store, profile-phone, profile-avatar, profile-settings. These six
// are the ones measured and budgeted on 22 Aug 2026; the rest need the same
// treatment (measure the honest idle number FIRST, then write the budget) and
// several of them — radio, iPod, games, camera — own media or a live device
// and will not simply read zero. Add them one at a time, with numbers.
const SUBSCREENS = [
  { name: 'profile-stats', sources: ['StatsScreen.tsx', 'StatsScreen.module.css'] },
  { name: 'profile-wallet', sources: ['WalletScreen.tsx', 'WalletScreen.module.css'] },
  { name: 'feed-casino', sources: ['CasinoScreen.tsx', 'CasinoScreen.module.css'] },
  { name: 'profile-trophies', sources: ['TrophyRoomScreen.tsx', 'TrophyRoomScreen.module.css'] },
  { name: 'profile-messages', sources: ['MailScreen.tsx', 'MailScreen.module.css'] },
  { name: 'feed-apps', sources: ['AppsScreen.tsx', 'AppsScreen.module.css'] },
].map(s => ({
  ...s,
  settle: 36,
  path: `/?view=holdmenu&holdScreen=${s.name}&iosTier=1`,
  isSubscreen: true,
}))

const subscreenHash = surface => {
  try {
    const h = createHash('sha256')
    for (const file of surface.sources) h.update(readFileSync(join(SUBSCREEN_SOURCE_ROOT, file)))
    return h.digest('hex').slice(0, 16)
  } catch {
    // Unreadable source tree (a release built from an isolated worktree, say):
    // dirt cannot be judged, so fall back to rotation rather than either
    // measuring everything or measuring nothing.
    return null
  }
}

const readSubscreenState = () => {
  try { return JSON.parse(readFileSync(SUBSCREEN_STATE_PATH, 'utf8')).screens || {} } catch { return {} }
}

const pickSubscreens = () => {
  const mode = (process.env.POPLUR_THERMAL_SUBSCREENS || '').toLowerCase()
  if (mode === 'off') {
    console.error('⚠️  THERMAL GATE: subscreens DISABLED (POPLUR_THERMAL_SUBSCREENS=off).')
    console.error('   Hold-menu screens were NOT measured this build. This is the exact blind')
    console.error('   spot that shipped the Stats shimmer regression on 22 Aug 2026.')
    return []
  }
  if (mode === 'all') {
    console.error(`thermal-gate: FULL subscreen sweep (POPLUR_THERMAL_SUBSCREENS=all) → ${SUBSCREENS.length} surfaces, ~${SUBSCREENS.length} minutes`)
    return SUBSCREENS
  }
  const state = readSubscreenState()
  const dirty = SUBSCREENS.filter(s => {
    const h = subscreenHash(s)
    return h != null && h !== state[s.name]?.hash
  })
  if (dirty.length) {
    const picked = dirty.slice(0, SUBSCREEN_CAP)
    const held = dirty.slice(SUBSCREEN_CAP).map(s => s.name)
    console.error(`thermal-gate: subscreen sources changed → measuring ${picked.map(s => s.name).join(', ')}` +
      (held.length ? ` (deferred to the next run: ${held.join(', ')})` : ''))
    return picked
  }
  // Nothing changed under any subscreen. Rotate the stalest one through anyway
  // — a regression can reach a screen through shared CSS or the governor
  // without its own files moving, and an unmeasured screen drifts silently.
  const stalest = [...SUBSCREENS].sort((a, b) =>
    (Date.parse(state[a.name]?.measuredAt ?? 0) || 0) - (Date.parse(state[b.name]?.measuredAt ?? 0) || 0))[0]
  if (stalest) console.error(`thermal-gate: no subscreen source changed → rotating in ${stalest.name}`)
  return stalest ? [stalest] : []
}

const SUBSCREEN_PICKS = pickSubscreens()
const SURFACES = [...ROOT_SURFACES, ...SUBSCREEN_PICKS]

const SAMPLE_MS = 8_000

// ARRIVAL WINDOW. Every budget above this line measures a SETTLED surface, and
// that blind spot cost real device heat: re-measured 21 Aug, the map costs
// ~6.75s of renderer CPU in the 30s after it mounts (44.3% of a core over
// 0-5s, 48.0% over 10-15s) and then parks at a genuine 0.0%. The map settle is
// 26s, so the idle census opens in the 4.9% window and never counts any of it
// — a surface could pass this gate cleanly and still cook the phone through
// repeated visits, which is exactly what "go on every screen" does.
//
// So sample the arrival too: renderer-thread CPU from navigation to +30s,
// budgeted separately as maxArrivalCpuMs. The settle then runs its remaining
// time as before (a surface whose settle is shorter than the window simply
// gets a longer, and therefore idler, settle — never a shorter one).
const ARRIVAL_MS = 30_000

if (process.env.POPLUR_THERMAL_SKIP === '1') {
  console.error('⚠️  THERMAL GATE SKIPPED (POPLUR_THERMAL_SKIP=1) — this build was NOT measured.')
  process.exit(0)
}

// On the ad-hoc default (the workbench's 5199): if it is down there is
// nothing to measure against — fail soft with a loud warning rather than
// blocking on infrastructure, but say exactly what was not checked. Under
// POPLUR_THERMAL_REQUIRE=1 the caller owns the base, so fail closed instead.
const up = await fetch(BASE + '/', { signal: AbortSignal.timeout(3000) }).then(r => r.ok).catch(() => false)
if (!up) {
  if (REQUIRE_BASE) {
    console.error(`🔥 THERMAL GATE: required base ${BASE} is not serving — failing closed (POPLUR_THERMAL_REQUIRE=1).`)
    process.exit(1)
  }
  console.error(`⚠️  THERMAL GATE: ${BASE} is not serving — surfaces were NOT measured this build.`)
  console.error('   Start the workbench (.codex/start-poplur-artifacts.sh) to restore the gate.')
  process.exit(0)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// The build under test can declare its frame governor deliberately OFF
// (frameGovernor's GOVERNOR_DISABLED sets data-poplur-governor="off" on the
// root element). Every budget this gate enforces assumes the governor's idle
// machinery — ambient sleep, the renderer park, the quality ladder — and an
// ungoverned build can never acknowledge idle/park, so measuring it produces
// only unmeasurable-leg failures. Distinguish that DELIBERATE state from
// broken idle machinery by asking the page, and pass loudly instead of
// pretending the budgets still apply. Re-enabling the governor restores the
// gate with no change here.
async function governorDeclaredOff() {
  const port = 9890 + Math.floor(Math.random() * 9)
  const profileDir = mkdtempSync(join(tmpdir(), 'poplur-gate-gov-'))
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--window-size=393,852', 'about:blank',
  ], { stdio: 'ignore' })
  try {
    let ws = null
    for (let i = 0; i < 60 && !ws; i++) {
      ws = await fetch(`http://127.0.0.1:${port}/json/list`)
        .then(r => r.json())
        .then(t => t.find(x => x.type === 'page')?.webSocketDebuggerUrl)
        .catch(() => null)
      if (!ws) await sleep(150)
    }
    if (!ws) return false
    const sock = new WebSocket(ws)
    await new Promise(r => sock.addEventListener('open', r))
    const pending = new Map()
    let id = 0
    const send = (method, params = {}) => new Promise(resolve => {
      const mid = ++id
      pending.set(mid, resolve)
      sock.send(JSON.stringify({ id: mid, method, params }))
    })
    sock.addEventListener('message', ev => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    })
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Page.navigate', { url: BASE + '/?view=home' })
    // The flag is set before first paint; a short settle covers module load.
    for (let i = 0; i < 20; i++) {
      await sleep(500)
      const res = await send('Runtime.evaluate', {
        expression: "document.documentElement.dataset.poplurGovernor === 'off'",
        returnByValue: true,
      })
      if (res?.result?.result?.value === true) return true
      // A loaded page without the flag is a governed build — stop early.
      const loaded = await send('Runtime.evaluate', {
        expression: "document.readyState === 'complete' && !!document.querySelector('canvas')",
        returnByValue: true,
      })
      if (loaded?.result?.result?.value === true && i > 6) return false
    }
    return false
  } catch {
    return false
  } finally {
    try { chrome.kill() } catch { /* */ }
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* */ }
  }
}

if (await governorDeclaredOff()) {
  console.error('⚠️  THERMAL GATE: build declares its frame governor OFF (data-poplur-governor="off").')
  console.error('   Idle/park budgets do not apply to an ungoverned build — passing WITHOUT measurement.')
  console.error('   This build heats the phone at the rate the content actually costs.')
  process.exit(0)
}

// 1-minute load average. Long-task duration is WALL CLOCK, so a task that needs
// 40ms of CPU is reported as 400ms on a box fighting for cores — this workbench
// routinely runs several agent sessions at once, and a busy one manufactures
// "thermal regressions" in code that did not change. Recorded with every sample
// so a number taken on a loud machine is visibly a number taken on a loud
// machine, rather than silently becoming a build failure.
const load1 = () => {
  try { return Number(execSync('sysctl -n vm.loadavg').toString().split(' ')[1]) } catch { return NaN }
}

async function measure(surface) {
  const port = 9900 + Math.floor(Math.random() * 90)
  const profileDir = mkdtempSync(join(tmpdir(), 'poplur-gate-'))
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--use-gl=angle', '--enable-gpu-rasterization', '--window-size=393,852',
    '--js-flags=--expose-gc',
    'about:blank',
  ], { stdio: 'ignore' })
  const cleanup = () => { try { chrome.kill() } catch { /* */ } try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* */ } }

  try {
    let ws = null
    for (let i = 0; i < 60 && !ws; i++) {
      ws = await fetch(`http://127.0.0.1:${port}/json/list`)
        .then(r => r.json())
        .then(t => t.find(x => x.type === 'page')?.webSocketDebuggerUrl)
        .catch(() => null)
      if (!ws) await sleep(150)
    }
    if (!ws) throw new Error('devtools never came up')

    const sock = new WebSocket(ws)
    await new Promise(r => sock.addEventListener('open', r))
    const pending = new Map()
    const runtimeErrors = []
    let id = 0
    sock.addEventListener('message', ev => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') {
        const detail = m.params?.exceptionDetails
        runtimeErrors.push(detail?.exception?.description || detail?.text || 'unknown runtime exception')
      }
    })
    const send = (method, params = {}) => new Promise(res => {
      const mid = ++id
      pending.set(mid, res)
      sock.send(JSON.stringify({ id: mid, method, params }))
    })
    const evalJs = async (expression, awaitPromise = false) => {
      const { result } = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
      return result?.result?.value
    }

    await send('Page.enable')
    await send('Runtime.enable')
    await send('Performance.enable', { timeDomain: 'timeTicks' })
    // A surface may bring its own base (see PRELOGIN_BASE); everything else
    // measures against the snapshot the caller is publishing.
    const metricValue = (response, name) => response?.result?.metrics
      ?.find(metric => metric.name === name)?.value ?? 0

    await send('Page.navigate', { url: (surface.base || BASE) + surface.path })

    // Arrival census: the warm-up nobody was measuring. Bracketed from the
    // navigate itself so it counts style/tile/model boot, not just whatever
    // survives into the settle.
    const metricsAtNav = await send('Performance.getMetrics')
    const threadAtNav = metricValue(metricsAtNav, 'ThreadTime')
    await sleep(ARRIVAL_MS)
    const metricsAtArrival = await send('Performance.getMetrics')
    const arrivalMs = Math.max(0, Math.round(
      (metricValue(metricsAtArrival, 'ThreadTime') - threadAtNav) * 1000))

    await sleep(Math.max(0, surface.settle * 1000 - ARRIVAL_MS))

    // A fixed wall-clock settle is not sufficient on a saturated workbench:
    // the process can be starved long enough that its 30s idle transition has
    // not actually executed. Wait for the app's own idle/park acknowledgement,
    // then give deferred teardown a short quiescence tail.
    const idleDeadline = Date.now() + 120_000
    let idleAcknowledged = false
    while (Date.now() < idleDeadline) {
      const idle = await evalJs(`JSON.stringify({
        body: !!document.body && document.body.querySelectorAll('*').length >= 20,
        ambient: document.documentElement.classList.contains('poplur-ambient-sleep'),
        chromeIdle: window.__poplurChromeIdle === true,
        mapParked: document.documentElement.dataset.poplurMapPark === '1',
      })`)
      const state = JSON.parse(idle || '{}')
      idleAcknowledged = state.body === true
        && state.ambient === true
        && (surface.isMap
          ? state.mapParked === true
          : state.chromeIdle === true)
      if (idleAcknowledged) break
      await sleep(500)
    }
    if (!idleAcknowledged) throw new Error(`${surface.name} never acknowledged idle/park`)

    // The Map's park edge can arrive while Mapbox is still draining a bounded
    // asynchronous style/tile boot tail. Counting that one-time startup tail as
    // recurring idle work both hides the real question and made the gate flaky
    // under host contention. Demand ten seconds with no Mapbox render before
    // opening the census; Home/Feed retain the shorter teardown tail.
    if (surface.isMap) {
      const quiescenceDeadline = Date.now() + 120_000
      let lastRenderCount = -1
      let stableSince = 0
      while (Date.now() < quiescenceDeadline) {
        const snapshot = JSON.parse(await evalJs(`JSON.stringify({
          parked: document.documentElement.dataset.poplurMapPark === '1',
          count: Number(window.__poplurMapRenderCount || 0),
        })`) || '{}')
        if (snapshot.parked === true
          && stableSince
          && Number(snapshot.count || 0) - lastRenderCount <= MAP_QUIESCENCE_RENDER_ALLOWANCE) {
          if (Date.now() - stableSince >= 10_000) break
        } else if (snapshot.parked === true) {
          lastRenderCount = Number(snapshot.count || 0)
          stableSince = Date.now()
        } else {
          lastRenderCount = Number(snapshot.count || 0)
          stableSince = 0
        }
        await sleep(500)
      }
      if (!stableSince || Date.now() - stableSince < 10_000) {
        throw new Error('map never reached a 10s render-quiescent parked state')
      }
    } else {
      await sleep(3_000)
    }

    // PerformanceObserver long-task duration and CDP TaskDuration are WALL
    // CLOCK: a 40ms task can appear as seconds when the process is preempted.
    // CDP ThreadTime is renderer-thread CPU time and remains stable under host
    // contention, so it is the quantity the release decision uses. Keep both
    // wall-clock values in the report for responsiveness diagnostics.
    const metricsBefore = await send('Performance.getMetrics')
    const taskBefore = metricValue(metricsBefore, 'TaskDuration')
    const threadBefore = metricValue(metricsBefore, 'ThreadTime')

    const report = await evalJs(`
      new Promise(done => {
        let longMs = 0, longN = 0
        try {
          new PerformanceObserver(list => {
            for (const e of list.getEntries()) { longMs += e.duration; longN += 1 }
          }).observe({ entryTypes: ['longtask'] })
        } catch {}
        setTimeout(() => {
          let infinite = 0, running = 0
          try {
            for (const a of document.getAnimations()) {
              if (a.playState !== 'running') continue
              running += 1
              const t = a.effect && a.effect.getTiming ? a.effect.getTiming() : null
              if (t && t.iterations === Infinity) infinite += 1
            }
          } catch {}
          const canvases = document.querySelectorAll('canvas').length
          const elements = document.body ? document.body.querySelectorAll('*').length : 0
          const title = document.title
          const webgl = [...document.querySelectorAll('canvas')].filter(c => {
            try { return !!(c.getContext('webgl2') || c.getContext('webgl')) } catch { return false }
          }).length
          const audio = (window.__poplurAudioDebug ? window.__poplurAudioDebug() : 'n/a')
          const states = a => (a.match(/\\[(.*)\\]/) || [,''])[1]
          const first = states(audio)
          const videos = [...document.querySelectorAll('video')]
            .filter(v => !v.paused && v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)
            .length
          // A context caught mid-sound (an ambient pop lasts ~300ms and parks
          // on sample end) is not a leak. Only a context RUNNING at two reads
          // 2.5s apart counts: a stuck one runs at both, a popping one is
          // parked again by the second.
          setTimeout(() => {
            const second = states(window.__poplurAudioDebug ? window.__poplurAudioDebug() : '')
            let runningCtx = 0
            for (let i = 0; i < Math.min(first.length, second.length); i++) {
              if (first[i] === 'r' && second[i] === 'r') runningCtx += 1
            }
            done(JSON.stringify({ infinite, running, longMs: Math.round(longMs), longN, elements, canvases, webgl, runningCtx, audio: audio + '->[' + second + ']', videos, title }))
          }, 2500)
        }, ${SAMPLE_MS})
      })`, true)
    const metricsAfter = await send('Performance.getMetrics')
    const taskAfter = metricValue(metricsAfter, 'TaskDuration')
    const threadAfter = metricValue(metricsAfter, 'ThreadTime')
    sock.close()
    return {
      ...JSON.parse(report),
      taskMs: Math.max(0, Math.round((taskAfter - taskBefore) * 1000)),
      threadMs: Math.max(0, Math.round((threadAfter - threadBefore) * 1000)),
      arrivalMs,
      runtimeErrors: runtimeErrors.slice(-4),
    }
  } finally {
    cleanup()
  }
}

// A surface with no rendered body did not load, and all-zero counts would sail
// under every budget. Home/Feed are allowed to shed every canvas when parked;
// only the MAP must own a WebGL context. Requiring a renderer on an inactive
// screen would turn the exact thermal win this gate protects into a failure.
const plausible = (surface, r) => r
  && r.elements >= 20
  && (surface.isMap ? r.webgl >= 1 : true)

// A wedged Chrome (devtools socket that answers nothing) must never hang the
// build forever — a hung gate is worse than a failed one. Every measurement
// races a hard deadline; on timeout the surface is retried once, then failed.
const DEADLINE_MS = 240_000
const withDeadline = p => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`measurement exceeded ${DEADLINE_MS / 1000}s`)), DEADLINE_MS)),
])

const results = {}
for (const s of SURFACES) {
  process.stderr.write(`thermal-gate: measuring ${s.name}… `)
  try {
    let r = await withDeadline(measure(s)).catch(() => null)
    if (!plausible(s, r)) {
      process.stderr.write(`(implausible ${JSON.stringify(r) ?? 'no report'} — retrying) `)
      r = await withDeadline(measure(s))
    }
    if (!plausible(s, r)) throw new Error('surface never mounted (canvas/webgl check failed)')
    results[s.name] = r
    console.error(JSON.stringify({ ...r, load: load1() }))
  } catch (e) {
    console.error(`unmeasurable (${e.message}) — treated as a gate failure`)
    results[s.name] = null
  }
}

// Deadline-abandoned Chromes are killed by their own cleanup() in measure()'s
// finally only when measure returns; a raced-out measure leaks its Chrome
// until process exit. Sweep them on the way out rather than leaving headless
// processes warming the MAC's thermals.
process.on('exit', () => { try { spawn('pkill', ['-f', 'poplur-gate-']) } catch { /* best effort */ } })

// ── retained-heap growth: is anything accumulating? ─────────────────────────
// The 7 Aug map GC storm hid from every count above: animations, contexts and
// videos all read clean while the claims recolor allocated megabytes per
// second and retained +40MB per 2 minutes — 86% of the device's WebContent CPU
// went to JSC garbage collection and the phone pinned Serious. The tell is
// GC-to-GC heap growth on the map in its REAL front state: front=1, so the
// ambient orbit (whose camera motion drove the storm) actually runs — front=0
// parks the governor and hides the whole class of bug. Heap bytes are not
// wall-clock, so unlike long tasks this number does not inflate on a busy Mac.
const HEAP_SURFACE = { name: 'map-heap', path: '/?map=1&front=1&mapMode=3d&iosTier=1', settle: 45 }
const HEAP_DWELL_MS = 60_000
const HEAP_DEADLINE_MS = 200_000

async function measureHeapGrowth() {
  const port = 9900 + Math.floor(Math.random() * 90)
  const profileDir = mkdtempSync(join(tmpdir(), 'poplur-gate-'))
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--use-gl=angle', '--enable-gpu-rasterization', '--window-size=393,852',
    '--js-flags=--expose-gc',
    'about:blank',
  ], { stdio: 'ignore' })
  const cleanup = () => { try { chrome.kill() } catch { /* */ } try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* */ } }
  try {
    let ws = null
    for (let i = 0; i < 60 && !ws; i++) {
      ws = await fetch(`http://127.0.0.1:${port}/json/list`)
        .then(r => r.json())
        .then(t => t.find(x => x.type === 'page')?.webSocketDebuggerUrl)
        .catch(() => null)
      if (!ws) await sleep(150)
    }
    if (!ws) throw new Error('devtools never came up')
    const sock = new WebSocket(ws)
    await new Promise(r => sock.addEventListener('open', r))
    const pending = new Map()
    let id = 0
    sock.addEventListener('message', ev => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    })
    const send = (method, params = {}) => new Promise(res => {
      const mid = ++id
      pending.set(mid, res)
      sock.send(JSON.stringify({ id: mid, method, params }))
    })
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Page.navigate', { url: BASE + HEAP_SURFACE.path })
    await sleep(HEAP_SURFACE.settle * 1000)
    const gcAll = async () => {
      for (let i = 0; i < 3; i++) {
        await send('Runtime.evaluate', { expression: 'window.gc && window.gc()' })
        await sleep(300)
      }
    }
    const heapMB = async () => {
      const u = await send('Runtime.getHeapUsage')
      const used = u?.result?.usedSize
      if (typeof used !== 'number') throw new Error('heap usage unreadable')
      return used / 1048576
    }
    // A page with no window.gc means the expose flag failed — that would turn
    // the whole leg into noise, so demand it.
    const hasGc = await send('Runtime.evaluate', { expression: 'typeof window.gc', returnByValue: true })
    if (hasGc?.result?.result?.value !== 'function') throw new Error('window.gc unavailable (expose-gc flag missing)')
    // As above, do not start a retained-growth dwell inside Mapbox's bounded
    // boot tail. The test is looking for accumulating idle work, not startup.
    const quiescenceDeadline = Date.now() + 120_000
    let lastRenderCount = -1
    let stableSince = 0
    while (Date.now() < quiescenceDeadline) {
      const state = await send('Runtime.evaluate', {
        expression: `JSON.stringify({
          count: Number(window.__poplurMapRenderCount || 0),
          parked: document.documentElement.dataset.poplurMapPark === '1',
        })`,
        returnByValue: true,
      })
      const snapshot = JSON.parse(state?.result?.result?.value || '{}')
      if (snapshot.parked === true
        && stableSince
        && Number(snapshot.count || 0) - lastRenderCount <= MAP_QUIESCENCE_RENDER_ALLOWANCE) {
        if (Date.now() - stableSince >= 10_000) break
      } else if (snapshot.parked === true) {
        lastRenderCount = Number(snapshot.count || 0)
        stableSince = Date.now()
      } else {
        lastRenderCount = Number(snapshot.count || 0)
        stableSince = 0
      }
      await sleep(500)
    }
    if (!stableSince || Date.now() - stableSince < 10_000) {
      throw new Error('map heap leg never reached a 10s render-quiescent parked state')
    }

    await gcAll()
    const before = await heapMB()
    const idleBefore = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        renderCount: Number(window.__poplurMapRenderCount || 0),
        parked: document.documentElement.dataset.poplurMapPark === '1',
        staticIdlePass: typeof window.__assertPoplurMapStaticIdle === 'function'
          ? window.__assertPoplurMapStaticIdle()
          : false,
        diagnostics: window.__poplurMapIdleDiagnostics || null,
      })`,
      returnByValue: true,
    })
    await sleep(HEAP_DWELL_MS)
    // Read the render/idle state before the diagnostic GC. Forced collection
    // is not part of a real untouched dwell and must not manufacture frames in
    // the count whose purpose is to detect autonomous rendering.
    const idleAfter = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        renderCount: Number(window.__poplurMapRenderCount || 0),
        parked: document.documentElement.dataset.poplurMapPark === '1',
        staticIdlePass: typeof window.__assertPoplurMapStaticIdle === 'function'
          ? window.__assertPoplurMapStaticIdle()
          : false,
        diagnostics: window.__poplurMapIdleDiagnostics || null,
      })`,
      returnByValue: true,
    })
    await gcAll()
    const after = await heapMB()
    const beforeIdle = JSON.parse(idleBefore?.result?.result?.value || '{}')
    const afterIdle = JSON.parse(idleAfter?.result?.result?.value || '{}')
    sock.close()
    return {
      beforeMB: Math.round(before * 10) / 10,
      afterMB: Math.round(after * 10) / 10,
      growthMB: Math.round((after - before) * 10) / 10,
      idleRenderCount: Math.max(0, Number(afterIdle.renderCount || 0) - Number(beforeIdle.renderCount || 0)),
      parkedBefore: beforeIdle.parked === true,
      parkedAfter: afterIdle.parked === true,
      staticIdlePass: beforeIdle.staticIdlePass === true && afterIdle.staticIdlePass === true,
      idleDiagnostics: afterIdle.diagnostics || null,
    }
  } finally {
    cleanup()
  }
}

const heapDeadline = p => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`heap measurement exceeded ${HEAP_DEADLINE_MS / 1000}s`)), HEAP_DEADLINE_MS)),
])

process.stderr.write('thermal-gate: measuring map retained-heap growth (60s dwell, orbit running)… ')
let heapGrowth = null
try {
  heapGrowth = await heapDeadline(measureHeapGrowth()).catch(() => null)
  if (!heapGrowth) {
    process.stderr.write('(failed or timed out — retrying) ')
    heapGrowth = await heapDeadline(measureHeapGrowth())
  }
  console.error(JSON.stringify({ ...heapGrowth, load: load1() }))
} catch (e) {
  console.error(`unmeasurable (${e.message}) — treated as a gate failure`)
  heapGrowth = null
}

// ── budgets ─────────────────────────────────────────────────────────────────
const HEADROOM = { infinite: 1, longMs: 1.5, arrivalMs: 1.25, webgl: 1, runningCtx: 0, videos: 0 }

if (!existsSync(BUDGETS_PATH)) {
  const budgets = {}
  for (const [name, r] of Object.entries(results)) {
    if (!r) continue
    budgets[name] = {
      maxInfiniteAnimations: r.infinite + HEADROOM.infinite,
      maxLongTaskMs: Math.max(250, Math.round((r.threadMs ?? r.taskMs ?? r.longMs) * HEADROOM.longMs)),
      maxArrivalCpuMs: Math.max(1000, Math.round((r.arrivalMs ?? 0) * HEADROOM.arrivalMs)),
      maxWebGL: r.webgl + HEADROOM.webgl,
      maxRunningAudioContexts: r.runningCtx + HEADROOM.runningCtx,
      maxPlayingVideos: r.videos + HEADROOM.videos,
    }
  }
  writeFileSync(BUDGETS_PATH, JSON.stringify({
    note: 'Thermal budgets per surface. Raising a number is a deliberate, reviewed act — do it in the same commit as the feature that needs the heat.',
    recordedAt: new Date().toISOString(),
    budgets,
  }, null, 2) + '\n')
  console.error(`thermal-gate: baseline recorded → ${BUDGETS_PATH}`)
  process.exit(0)
}

const { budgets } = JSON.parse(readFileSync(BUDGETS_PATH, 'utf8'))

// ── confirm a long-task breach before believing it ──────────────────────────
// Contention is ONE-DIRECTIONAL: a busy machine can only ever ADD main-thread
// time to a sample, never remove it, so it cannot make a genuinely hot page
// look cool. That makes the MINIMUM across samples the right estimator — a real
// regression is hot in every sample and still fails, while a machine that was
// merely busy for one 8s window stops being busy.
//
// Measured 7 Aug 2026, poplur-clay-map at a pinned commit, varying ONLY machine
// load: 0ms at load 6, 456ms at load 68, 1601ms at load 73. Same code every
// time. Before this pass those readings failed the build and sent people
// hunting a map regression that did not exist.
//
// Only longMs/longN are re-estimated. The other budgets are COUNTS — running
// animations, WebGL contexts, audio contexts, videos — and a count does not
// inflate under load, so a retry must not be allowed to paper one over.
const mainThreadWorkMs = result => result?.threadMs ?? result?.taskMs ?? result?.longMs ?? Number.POSITIVE_INFINITY

// Re-measure and keep the lowest. Both CPU quantities are noisy for their own
// reasons: idle CPU inflates under workbench contention, and ARRIVAL varies on
// its own even at load 4 — the map's warm-up measured 5918ms and 13734ms on two
// otherwise identical quiet runs, because how much of the cinematic intro and
// tile work lands inside the 30s window is not deterministic. A single sample
// of either would make this gate flake, so each keeps its own best-of-3.
const overIdle = (name, r) => budgets[name]?.maxLongTaskMs != null
  && mainThreadWorkMs(r) > budgets[name].maxLongTaskMs
const overArrival = (name, r) => budgets[name]?.maxArrivalCpuMs != null
  && r?.arrivalMs != null && r.arrivalMs > budgets[name].maxArrivalCpuMs

for (const name of Object.keys(results)) {
  if (!budgets[name] || !results[name]) continue
  const surface = SURFACES.find(s => s.name === name)
  if (!surface) continue
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = results[name]
    const why = [
      overIdle(name, r) ? `idle ${mainThreadWorkMs(r)}ms` : null,
      overArrival(name, r) ? `arrival ${r.arrivalMs}ms` : null,
    ].filter(Boolean)
    if (!why.length) break
    process.stderr.write(
      `thermal-gate: ${name} over budget (${why.join(', ')}, load ${load1()}) — re-measuring ${attempt}/2… `)
    const again = await withDeadline(measure(surface)).catch(() => null)
    if (!plausible(surface, again)) { console.error('unusable sample — keeping the lowest so far'); continue }
    console.error(JSON.stringify({ ...again, load: load1() }))
    // Each quantity keeps its own minimum: a run can be the better idle sample
    // and the worse arrival sample, and taking them as a pair would throw away
    // the good half.
    if (mainThreadWorkMs(again) < mainThreadWorkMs(r)) {
      results[name] = {
        ...results[name],
        threadMs: again.threadMs,
        taskMs: again.taskMs,
        longMs: again.longMs,
        longN: again.longN,
      }
    }
    if (again.arrivalMs != null && (r.arrivalMs == null || again.arrivalMs < r.arrivalMs)) {
      results[name] = { ...results[name], arrivalMs: again.arrivalMs }
    }
  }
}

// The retained-growth budget self-installs on its first measured run (the
// same first-run-baseline behavior the whole file uses), so older budget
// files gain the key without a by-hand edit. 8MB floor: the fixed map
// measured -13.5 to +0.1MB per dwell; the storm measured +20 to +40MB.
if (heapGrowth && budgets.map && budgets.map.maxRetainedGrowthMB == null) {
  budgets.map.maxRetainedGrowthMB = Math.max(8, Math.round(heapGrowth.growthMB * 1.5 + 4))
  const full = JSON.parse(readFileSync(BUDGETS_PATH, 'utf8'))
  full.budgets.map.maxRetainedGrowthMB = budgets.map.maxRetainedGrowthMB
  writeFileSync(BUDGETS_PATH, JSON.stringify(full, null, 2) + '\n')
  console.error(`thermal-gate: retained-growth budget recorded (map ≤ ${budgets.map.maxRetainedGrowthMB}MB/60s) → ${BUDGETS_PATH}`)
}

const failures = []
if (!heapGrowth) {
  failures.push('map-heap: retained-heap growth could not be measured')
} else if (budgets.map?.maxRetainedGrowthMB != null && heapGrowth.growthMB > budgets.map.maxRetainedGrowthMB) {
  failures.push(`map-heap: retained heap grew ${heapGrowth.growthMB}MB over 60s idle-front dwell (budget ${budgets.map.maxRetainedGrowthMB}MB) — something is accumulating; see 5b2a1fa for the last hunt`)
}
if (heapGrowth && !heapGrowth.staticIdlePass) {
  failures.push(`map-idle: static-idle assertion failed — ${JSON.stringify(heapGrowth.idleDiagnostics)}`)
}
if (heapGrowth && (!heapGrowth.parkedBefore || !heapGrowth.parkedAfter)) {
  failures.push(`map-idle: renderer was not parked for the complete 60s dwell (before=${heapGrowth.parkedBefore}, after=${heapGrowth.parkedAfter})`)
}
if (heapGrowth && heapGrowth.idleRenderCount > MAP_IDLE_RENDER_BUDGET) {
  failures.push(`map-idle: Mapbox drew ${heapGrowth.idleRenderCount} frames while parked for 60s (budget ${MAP_IDLE_RENDER_BUDGET})`)
}
// A surface measured for the first time has no budget yet. Record one from
// this run rather than silently never enforcing it — the same first-run
// baseline behaviour the rest of this file uses, applied per surface so a new
// surface can be added without discarding the budgets already earned.
const newlyBudgeted = []
for (const [name, r] of Object.entries(results)) {
  if (budgets[name] || !r) continue
  budgets[name] = {
    maxInfiniteAnimations: r.infinite + HEADROOM.infinite,
    maxLongTaskMs: Math.max(250, Math.round((r.threadMs ?? r.taskMs ?? r.longMs) * HEADROOM.longMs)),
    maxArrivalCpuMs: Math.max(1000, Math.round((r.arrivalMs ?? 0) * HEADROOM.arrivalMs)),
    maxWebGL: r.webgl + HEADROOM.webgl,
    maxRunningAudioContexts: r.runningCtx + HEADROOM.runningCtx,
    maxPlayingVideos: r.videos + HEADROOM.videos,
  }
  newlyBudgeted.push(name)
}
if (newlyBudgeted.length) {
  const full = JSON.parse(readFileSync(BUDGETS_PATH, 'utf8'))
  for (const name of newlyBudgeted) full.budgets[name] = budgets[name]
  writeFileSync(BUDGETS_PATH, JSON.stringify(full, null, 2) + '\n')
  console.error(`thermal-gate: baseline recorded for ${newlyBudgeted.join(', ')} → ${BUDGETS_PATH}`)
}

for (const [name, r] of Object.entries(results)) {
  const b = budgets[name]
  if (!b) continue
  if (!r) { failures.push(`${name}: could not be measured`); continue }
  if (r.infinite > b.maxInfiniteAnimations) failures.push(`${name}: ${r.infinite} infinite animations (budget ${b.maxInfiniteAnimations})`)
  if (mainThreadWorkMs(r) > b.maxLongTaskMs) failures.push(`${name}: ${mainThreadWorkMs(r)}ms renderer-thread CPU over idle census (budget ${b.maxLongTaskMs}ms; wall-clock tasks ${r.taskMs}ms, long tasks ${r.longMs}ms)`)
  // Absent budget = a surface baselined before the arrival census existed. It
  // is recorded on the next --record, not failed here.
  if (b.maxArrivalCpuMs != null && r.arrivalMs != null && r.arrivalMs > b.maxArrivalCpuMs) {
    failures.push(`${name}: ${r.arrivalMs}ms renderer-thread CPU in the first ${ARRIVAL_MS / 1000}s after mount (budget ${b.maxArrivalCpuMs}ms) — this is per-VISIT heat the idle census cannot see`)
  }
  if (r.webgl > b.maxWebGL) failures.push(`${name}: ${r.webgl} WebGL contexts (budget ${b.maxWebGL})`)
  if (r.runningCtx > b.maxRunningAudioContexts) failures.push(`${name}: ${r.runningCtx} RUNNING AudioContexts (budget ${b.maxRunningAudioContexts}) — ${r.audio}`)
  if (r.videos > b.maxPlayingVideos) failures.push(`${name}: ${r.videos} playing videos (budget ${b.maxPlayingVideos})`)
  if (r.runtimeErrors?.length) {
    failures.push(`${name}: ${r.runtimeErrors.length} uncaught runtime error(s) — ${r.runtimeErrors[0]}`)
  }
}

if (failures.length) {
  console.error('\n🔥 THERMAL GATE FAILED — this build heats the phone more than the last accepted one:')
  for (const f of failures) console.error('   · ' + f)
  const load = load1()
  if (load > 8) {
    console.error(`\n⚠️  Machine load is ${load}. Wall-clock long-task diagnostics may inflate under`)
    console.error('   contention. Gate decisions use renderer-thread CPU duration plus the')
    console.error('   contention-independent counts (animations, WebGL, audio and video).')
  }
  console.error('Fix the regression, or raise the budget in .codex/thermal-budgets.json in the same commit, on purpose.')
  process.exit(1)
}
// A subscreen that was measured and did not fail is now KNOWN GOOD at this
// source hash: record it, so the next run only pays for what actually changed.
// Written on the PASS path only — recording a failing run would mark the very
// regression that just failed as clean, and it would ship on the retry.
if (SUBSCREEN_PICKS.length) {
  const screens = readSubscreenState()
  const now = new Date().toISOString()
  for (const s of SUBSCREEN_PICKS) {
    if (!results[s.name]) continue
    const hash = subscreenHash(s)
    screens[s.name] = { hash, measuredAt: now, ...(hash == null ? { hashUnavailable: true } : {}) }
  }
  try {
    writeFileSync(SUBSCREEN_STATE_PATH, JSON.stringify({
      note: 'Which hold-menu subscreen sources were last measured PASSING by the thermal gate, and when. Delete this file to force a full re-measurement; it drains at the per-run cap.',
      screens,
    }, null, 2) + '\n')
  } catch (e) {
    console.error(`thermal-gate: could not record subscreen state (${e.message}) — the next run re-measures them.`)
  }
}
console.error('thermal-gate: PASS — no thermal regression.')
// The heap deadline is a Promise.race timeout. Once the measurement wins, its
// losing timer (and, on some Chrome builds, a lingering CDP handle) can keep
// Node alive long after PASS. A successful gate is terminal; return control to
// sync-mobile immediately just as the baseline and failure paths already do.
process.exit(0)
