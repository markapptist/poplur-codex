#!/usr/bin/env node
// Poplur screen profiler — measures real frame pacing for any app surface.
//
// The in-app Browser pane pauses rAF/timers whenever it is hidden, so FPS read
// from there is meaningless. This drives a headless Chrome over the DevTools
// Protocol instead (no npm deps — Node's global WebSocket does the talking),
// where rAF runs regardless of window visibility.
//
//   node .codex/profile-screen.mjs <url> [--seconds 5] [--width 393] [--height 852]
//                                        [--dpr 3] [--cpu 4] [--label name] [--json]
//
// --cpu N slows the CPU by N× to stand in for a phone; 4 is roughly an iPhone
// against this Mac. Defaults match an iPhone 15 viewport.
//
// Reports: average / median / worst-1% FPS, long frames, long tasks, the
// heaviest recurring work, and a ranked list of likely lag sources (playing
// videos, running CSS animations, WebGL contexts, layer count, DOM size).

const args = process.argv.slice(2)
const url = args.find(a => !a.startsWith('--'))
if (!url) {
  console.error('usage: node .codex/profile-screen.mjs <url> [--seconds 5] [--cpu 4] [--json]')
  process.exit(1)
}
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const SECONDS = Number(flag('seconds', 5))
const WIDTH = Number(flag('width', 393))
const HEIGHT = Number(flag('height', 852))
const DPR = Number(flag('dpr', 3))
const CPU = Number(flag('cpu', 4))
const LABEL = flag('label', url)
const JSON_ONLY = args.includes('--json')

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9333 + (process.pid % 400)

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const profileDir = mkdtempSync(join(tmpdir(), 'poplur-prof-'))
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profileDir}`,
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
  '--use-gl=angle',            // real GPU raster, like the device
  '--enable-gpu-rasterization',
  'about:blank',
], { stdio: 'ignore' })

let profileDirRemoved = false
function cleanupProfileDir() {
  if (profileDirRemoved) return
  profileDirRemoved = true
  try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* best effort */ }
}
// Crashes, Ctrl-C and thrown errors must not leak the directory either.
process.on('exit', cleanupProfileDir)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { try { chrome.kill() } catch {} cleanupProfileDir(); process.exit(130) })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find(t => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* chrome still booting */ }
    await sleep(150)
  }
  throw new Error('Chrome DevTools endpoint never came up')
}

// Minimal CDP client over the built-in WebSocket.
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  const listeners = []
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    } else if (msg.method) {
      listeners.forEach(fn => fn(msg))
    }
  })
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  return {
    ready,
    on: fn => listeners.push(fn),
    send(method, params = {}) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close: () => ws.close(),
  }
}

// Runs inside the page: samples every frame for `ms`, then reports pacing plus
// a census of the things that usually cost frames on these screens.
const SAMPLER = ms => `new Promise(resolve => {
  const gaps = []
  let last = performance.now()
  const start = last
  let longTasks = 0, longTaskMs = 0
  let po
  try {
    po = new PerformanceObserver(list => {
      for (const e of list.getEntries()) { longTasks++; longTaskMs += e.duration }
    })
    po.observe({ entryTypes: ['longtask'] })
  } catch (e) {}
  function tick(now) {
    gaps.push(now - last)
    last = now
    if (now - start < ${ms}) requestAnimationFrame(tick)
    else {
      if (po) po.disconnect()
      gaps.shift() // first gap includes scheduling latency
      const sorted = [...gaps].sort((a, b) => a - b)
      const at = q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
      const videos = [...document.querySelectorAll('video')]
      const playing = videos.filter(v => !v.paused && !v.ended && v.readyState > 2)
      const decoded = videos.reduce((a, v) => {
        try { return a + (v.getVideoPlaybackQuality().totalVideoFrames || 0) } catch (e) { return a }
      }, 0)
      const anims = (document.getAnimations ? document.getAnimations() : []).filter(a => a.playState === 'running')
      const canvases = [...document.querySelectorAll('canvas')]
      const gl = canvases.filter(c => {
        try { return !!(c.getContext('webgl2', {failIfMajorPerformanceCaveat:false}) || c.getContext('webgl')) } catch (e) { return false }
      })
      const px = el => { const r = el.getBoundingClientRect(); return Math.round(r.width * r.height) }
      resolve({
        seconds: +((last - start) / 1000).toFixed(2),
        fps_avg: +(1000 / mean).toFixed(1),
        fps_median: +(1000 / at(0.5)).toFixed(1),
        fps_worst1pct: +(1000 / at(0.99)).toFixed(1),
        longest_frame_ms: +sorted[sorted.length - 1].toFixed(1),
        frames_over_32ms: gaps.filter(g => g > 32).length,
        frames_total: gaps.length,
        long_tasks: longTasks,
        long_task_ms: +longTaskMs.toFixed(1),
        videos_total: videos.length,
        videos_playing: playing.length,
        video_pixels_onscreen: playing.reduce((a, v) => a + px(v), 0),
        video_frames_decoded: decoded,
        css_animations_running: anims.length,
        canvases: canvases.length,
        webgl_contexts: gl.length,
        dom_nodes: document.getElementsByTagName('*').length,
        backdrop_filters: [...document.querySelectorAll('*')].filter(el => {
          const s = getComputedStyle(el)
          return (s.backdropFilter && s.backdropFilter !== 'none') || (s.webkitBackdropFilter && s.webkitBackdropFilter !== 'none')
        }).length,
        heap_mb: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
      })
    }
  }
  requestAnimationFrame(tick)
})`

// Turns the census into ranked, actionable suspects.
function diagnose(m) {
  const out = []
  if (m.videos_playing > 4) {
    out.push({
      severity: m.videos_playing > 10 ? 'high' : 'medium',
      cost: `${m.videos_playing} videos decoding at once (${(m.video_pixels_onscreen / 1e6).toFixed(1)} MP on screen)`,
      fix: 'Decode only what is visible: pause offscreen <video> via IntersectionObserver, or use poster/first-frame images and start playback on tap.',
    })
  }
  if (m.css_animations_running > 12) {
    out.push({
      severity: m.css_animations_running > 30 ? 'high' : 'medium',
      cost: `${m.css_animations_running} CSS animations running`,
      fix: 'Animate only transform/opacity, and stop animations on offscreen elements. Background-position sweeps repaint the whole element every frame.',
    })
  }
  if (m.backdrop_filters > 0) {
    out.push({
      severity: m.backdrop_filters > 2 ? 'high' : 'medium',
      cost: `${m.backdrop_filters} live backdrop-filter layers`,
      fix: 'backdrop-filter re-blurs everything beneath it each frame; swap for a flat translucent fill unless the blur is the point.',
    })
  }
  if (m.webgl_contexts > 1) {
    out.push({
      severity: 'medium',
      cost: `${m.webgl_contexts} WebGL contexts alive`,
      fix: 'Share one renderer across clay widgets, or drop to a pre-rendered sprite (modelSprite) when the object is static.',
    })
  }
  if (m.dom_nodes > 2500) {
    out.push({ severity: 'low', cost: `${m.dom_nodes} DOM nodes`, fix: 'Virtualise long lists/grids so offscreen rows are not laid out.' })
  }
  if (m.long_tasks > 0) {
    out.push({
      severity: m.long_task_ms > 300 ? 'high' : 'low',
      cost: `${m.long_tasks} long tasks blocking the main thread for ${m.long_task_ms} ms`,
      fix: 'Break the work up or move it off the first frames — this is what makes taps feel unresponsive.',
    })
  }
  return out.sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.severity] - ({ high: 0, medium: 1, low: 2 })[b.severity])
}

const wsUrl = await findTarget()
const cdp = connect(wsUrl)
await cdp.ready

await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH, height: HEIGHT, deviceScaleFactor: DPR, mobile: true,
})
if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU })

const loaded = new Promise(resolve => {
  cdp.on(msg => { if (msg.method === 'Page.loadEventFired') resolve() })
})
await cdp.send('Page.navigate', { url })
await Promise.race([loaded, sleep(20000)])
// --settle N waits N seconds before acting (use it to let the map's intro
// finish, so a tab switch is measured warm — the way a real user reaches it).
await sleep(Number(flag('settle', 2.5)) * 1000)

// --do "<js>" runs in the page before sampling: switch tabs, open a sheet,
// scroll — whatever puts the screen in the state you want to measure.
const DO = flag('do', null)
if (DO) {
  await cdp.send('Runtime.evaluate', { expression: DO, awaitPromise: true })
  await sleep(Number(flag('after', 1.5)) * 1000)
}

// --expect "<text>" refuses to report a number unless the text is actually on
// screen. Without it a mistyped route, a subscreen that never opened, or an app
// that failed to mount all sample an empty page and come back a confident 59.9
// — the most dangerous result this tool can produce, because it looks like good
// news. Checks rendered text and the aria-labels that name dialogs and screens.
const EXPECT = flag('expect', null)
if (EXPECT) {
  const { result: seen } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const labels = [...document.querySelectorAll('[aria-label]')].map(n => n.getAttribute('aria-label'))
      return (document.body.innerText + ' ' + labels.join(' ')).toLowerCase()
    })()`,
    returnByValue: true,
  })
  if (!String(seen.value || '').includes(EXPECT.toLowerCase())) {
    console.error(`profile-screen: expected ${JSON.stringify(EXPECT)} on screen, but it never appeared.`)
    console.error(`  url: ${url}`)
    console.error(`  Nothing was measured. The screen did not open — fix the route/--do, or raise --settle.`)
    cdp.close()
    chrome.kill()
    process.exit(2)
  }
}

// --js also runs the CPU sampler, so the report can name the functions eating
// the frame instead of only counting the symptoms.
const WANT_JS = args.includes('--js')
if (WANT_JS) {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.send('Profiler.start')
}

const { result } = await cdp.send('Runtime.evaluate', {
  expression: SAMPLER(SECONDS * 1000),
  awaitPromise: true,
  returnByValue: true,
})
const metrics = result.value

let hotFunctions = null
if (WANT_JS) {
  const { profile } = await cdp.send('Profiler.stop')
  const byId = new Map(profile.nodes.map(n => [n.id, n]))
  const selfTicks = new Map()
  for (const node of profile.nodes) {
    if (!node.hitCount) continue
    const f = node.callFrame
    const key = `${f.functionName || '(anonymous)'} — ${(f.url || '').split('/').pop()}:${f.lineNumber + 1}`
    selfTicks.set(key, (selfTicks.get(key) || 0) + node.hitCount)
  }
  const totalTicks = [...selfTicks.values()].reduce((a, b) => a + b, 0) || 1
  const spanMs = (profile.endTime - profile.startTime) / 1000
  hotFunctions = [...selfTicks.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, ticks]) => ({
      name,
      self_ms: +(spanMs * (ticks / totalTicks)).toFixed(1),
      share: +((ticks / totalTicks) * 100).toFixed(1),
    }))
  void byId
}
const suspects = diagnose(metrics)
const report = { label: LABEL, url, viewport: `${WIDTH}x${HEIGHT}@${DPR}x`, cpu_throttle: `${CPU}x`, ...metrics, suspects, hot_functions: hotFunctions }

cdp.close()
chrome.kill()
// Chrome gets a throwaway --user-data-dir per run, and it is not small. Left
// behind, a long profiling session fills the disk — which then shows up as
// mysterious fps variance and pages that fail to mount, i.e. the profiler
// corrupting its own measurements. Always take the temp dir back out.
// Wait for Chrome to actually die first: its helper processes keep writing
// through shutdown and will recreate the directory underneath a single rm, so
// retry until it stays gone.
await new Promise(resolve => {
  chrome.once('exit', resolve)
  setTimeout(resolve, 2000)
})
for (let attempt = 0; attempt < 12; attempt++) {
  try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* retry */ }
  if (!existsSync(profileDir)) break
  await sleep(250)
}
profileDirRemoved = true

if (JSON_ONLY) {
  console.log(JSON.stringify(report, null, 2))
} else {
  // Headless Chrome composites at 30Hz, so a screen with nothing wrong reads as
  // a metronomic 30fps. Detect that (median ~30 AND the worst frames are just
  // as regular) and call it what it is instead of reporting phantom lag.
  const vsyncCapped = metrics.fps_median > 28 && metrics.fps_median < 31.5 && metrics.fps_worst1pct > 25
  const verdict = vsyncCapped ? 'SMOOTH (at the headless 30Hz cap — no jank)'
    : metrics.fps_median >= 55 ? 'SMOOTH'
    : metrics.fps_median >= 40 ? 'SOFT'
    : metrics.fps_median >= 25 ? 'LAGGY'
    : 'BAD'
  console.log(`\n  ${LABEL}  —  ${verdict}`)
  console.log(`  ${WIDTH}x${HEIGHT}@${DPR}x, CPU ${CPU}x slower, ${metrics.seconds}s sample\n`)
  console.log(`  fps        avg ${metrics.fps_avg}   median ${metrics.fps_median}   worst 1% ${metrics.fps_worst1pct}`)
  console.log(`  frames     ${metrics.frames_over_32ms}/${metrics.frames_total} over 32ms, longest ${metrics.longest_frame_ms}ms`)
  console.log(`  main thread ${metrics.long_tasks} long tasks / ${metrics.long_task_ms}ms blocked`)
  console.log(`  on screen  ${metrics.videos_playing}/${metrics.videos_total} videos, ${metrics.css_animations_running} animations, ${metrics.webgl_contexts} webgl, ${metrics.dom_nodes} nodes\n`)
  if (!suspects.length) console.log('  No obvious suspects.\n')
  suspects.forEach(s => {
    console.log(`  [${s.severity.toUpperCase()}] ${s.cost}`)
    console.log(`          ${s.fix}\n`)
  })
  if (hotFunctions) {
    console.log('  hottest JS (self time):')
    hotFunctions.forEach(f => console.log(`    ${String(f.share).padStart(5)}%  ${String(f.self_ms).padStart(7)}ms  ${f.name}`))
    console.log('')
  }
}
