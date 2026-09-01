#!/usr/bin/env node
// Poplur leak probe — answers "is memory growing and not being unloaded?" with
// numbers. Two modes:
//
//   node .codex/leak-probe.mjs dwell  [--minutes 3]   stay on the map and watch
//   node .codex/leak-probe.mjs cycle  [--cycles 8]    map→feed→map→camera… loop
//
// Each sample records: JS heap, WebGL context creations vs losses, live/detached
// <canvas> count, DOM nodes, event-listener count, video elements, AudioContexts,
// and (dwell) Mapbox tile/source counts if reachable. Growth that survives GC in
// dwell mode, or per-cycle growth that never returns to baseline in cycle mode,
// is a leak.
//
// Same zero-dependency CDP approach as profile-screen.mjs (which see): headless
// Chrome, Node's global WebSocket.

const args = process.argv.slice(2)
const MODE = args.find(a => !a.startsWith('--')) || 'dwell'
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const MINUTES = Number(flag('minutes', 3))
const CYCLES = Number(flag('cycles', 8))
const BASE = flag('url', 'http://127.0.0.1:5173/')
const JSON_ONLY = args.includes('--json')
// --no-loss: stub WEBGL_lose_context so forceContextLoss() becomes a no-op.
// This reproduces the pre-releaseWebGL behaviour on identical code — the
// honest "before" leg of an A/B without touching the worktree.
const NO_LOSS = args.includes('--no-loss')

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9733 + (process.pid % 200)

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const profileDir = mkdtempSync(join(tmpdir(), 'poplur-leak-'))
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profileDir}`,
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
  '--use-gl=angle',
  '--enable-gpu-rasterization',
  '--js-flags=--expose-gc',
  'about:blank',
], { stdio: 'ignore' })

let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  try { chrome.kill() } catch {}
  try { rmSync(profileDir, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { cleanup(); process.exit(130) })

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find(t => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(150)
  }
  throw new Error('Chrome DevTools endpoint never came up')
}

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

// Injected before any document script in EVERY frame (the map is an iframe):
// tallies WebGL context creations and losses, AudioContexts, and keeps weak
// track of every canvas ever made so detached ones can be counted.
const INSTRUMENT = `(() => {
  if (window.__leakProbe) return
  const P = window.__leakProbe = {
    glCreated: 0, glLost: 0, glRestored: 0,
    audioCtxCreated: 0,
    canvases: [],          // WeakRef<HTMLCanvasElement>
  }
  const wrapGL = (proto) => {
    if (!proto) return
    const orig = proto.getContext
    proto.getContext = function (type, ...rest) {
      const ctx = orig.call(this, type, ...rest)
      if (ctx && /webgl/i.test(String(type))) {
        P.glCreated++
        try { P.canvases.push(new WeakRef(this)) } catch (e) {}
        this.addEventListener('webglcontextlost', () => { P.glLost++ }, { once: false })
        this.addEventListener('webglcontextrestored', () => { P.glRestored++ }, { once: false })
      } else if (ctx && type === '2d') {
        try { P.canvases.push(new WeakRef(this)) } catch (e) {}
      }
      return ctx
    }
  }
  wrapGL(HTMLCanvasElement.prototype)
  if (window.OffscreenCanvas) wrapGL(OffscreenCanvas.prototype)
  if (${NO_LOSS}) {
    for (const proto of [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype]) {
      if (!proto) continue
      const origExt = proto.getExtension
      proto.getExtension = function (name, ...rest) {
        if (name === 'WEBGL_lose_context') return { loseContext() {}, restoreContext() {} }
        return origExt.call(this, name, ...rest)
      }
    }
  }
  const NativeAC = window.AudioContext || window.webkitAudioContext
  if (NativeAC) {
    const Patched = function (...a) { P.audioCtxCreated++; return new NativeAC(...a) }
    Patched.prototype = NativeAC.prototype
    window.AudioContext = Patched
    if (window.webkitAudioContext) window.webkitAudioContext = Patched
  }
})()`

// Runs in a frame: one census sample. gc() first so only real retention counts.
const CENSUS = `(async () => {
  if (window.gc) { try { window.gc(); await new Promise(r => setTimeout(r, 50)); window.gc() } catch (e) {} }
  const P = window.__leakProbe || {}
  let live = 0, detached = 0, glCanvasPixels = 0
  for (const ref of (P.canvases || [])) {
    const c = ref.deref && ref.deref()
    if (!c) continue
    if (c instanceof HTMLCanvasElement && !c.isConnected) detached++
    else { live++; glCanvasPixels += (c.width || 0) * (c.height || 0) }
  }
  const videos = document.querySelectorAll('video').length
  const domCanvas = document.querySelectorAll('canvas').length
  const mem = performance.memory || {}
  // Mapbox internals, if this frame is the map
  let tiles = null
  try {
    const map = window.__poplurMap || window.map
    if (map && map.style && map.style._sourceCaches) {
      tiles = 0
      for (const k in map.style._sourceCaches) {
        tiles += Object.keys(map.style._sourceCaches[k]._tiles || {}).length
      }
    }
  } catch (e) {}
  return JSON.stringify({
    heapMB: mem.usedJSHeapSize ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null,
    glCreated: P.glCreated || 0, glLost: P.glLost || 0,
    audioCtx: P.audioCtxCreated || 0,
    canvasLive: live, canvasDetached: detached, domCanvas,
    glCanvasMPix: +(glCanvasPixels / 1e6).toFixed(1),
    domNodes: document.getElementsByTagName('*').length,
    videos,
    tiles,
  })
})()`

async function frames(cdp) {
  // Every execution context (top page + iframes). Returns unique frame ids.
  const { frameTree } = await cdp.send('Page.getFrameTree')
  const out = []
  const walk = t => { out.push(t.frame); (t.childFrames || []).forEach(walk) }
  walk(frameTree)
  return out
}

// Frame id → MAIN-world execution context id. The census must read
// window.__leakProbe, which the instrument created in the main world; an
// isolated world shares the DOM but NOT JS globals, so evaluating there
// silently reads zeros for everything the instrument counted.
const mainWorlds = new Map()
function trackContexts(cdp) {
  cdp.on(msg => {
    if (msg.method === 'Runtime.executionContextCreated') {
      const ctx = msg.params.context
      if (ctx.auxData?.isDefault && ctx.auxData.frameId) mainWorlds.set(ctx.auxData.frameId, ctx.id)
    }
    if (msg.method === 'Runtime.executionContextsCleared') mainWorlds.clear()
  })
}

async function evalInFrame(cdp, frameId, expr) {
  const contextId = mainWorlds.get(frameId)
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true,
    ...(contextId ? { contextId } : {}), // top frame falls back to the default target context
  })
  if (exceptionDetails) throw new Error(exceptionDetails.text)
  return result.value
}

async function sampleAll(cdp) {
  const fs = await frames(cdp)
  const rows = []
  for (const f of fs) {
    try {
      const raw = await evalInFrame(cdp, f.id, CENSUS)
      rows.push({ url: (f.url || '').slice(0, 60), ...JSON.parse(raw) })
    } catch { /* frame mid-navigation */ }
  }
  return rows
}

function printSample(label, rows) {
  if (JSON_ONLY) { console.log(JSON.stringify({ label, rows })); return }
  console.log(`\n── ${label} ` + '─'.repeat(Math.max(1, 68 - label.length)))
  for (const r of rows) {
    const tag = r.url.includes('map=1') ? 'map-frame' : 'top'
    console.log(
      `  [${tag}] heap=${r.heapMB}MB gl: +${r.glCreated}/-${r.glLost}` +
      ` canvas live=${r.canvasLive} detached=${r.canvasDetached} dom=${r.domCanvas} (${r.glCanvasMPix}MPix)` +
      ` dom=${r.domNodes} video=${r.videos} audioCtx=${r.audioCtx}` +
      (r.tiles !== null && r.tiles !== undefined ? ` tiles=${r.tiles}` : '')
    )
  }
}

// Deterministic tab switch: the same event the native voice assistant uses to
// change tabs (PoplurVoiceAssistant listens for 'poplur-native-voice-command'
// and calls setActiveTab). Text-matched clicking proved unreliable — a run
// that never actually left Home reads as a spotless leak report.
// App tab ids: map | feed | post (camera) | profile.
const SWITCH_TAB = tab => `(() => {
  window.dispatchEvent(new CustomEvent('poplur-native-voice-command', {
    detail: { tab: ${JSON.stringify(tab)} }
  }))
  return 'requested ' + ${JSON.stringify(tab)}
})()`

// Which tab is actually front, read from the DOM (the map iframe only exists
// while Map is front; other tabs are inferred from their marquee elements).
const ACTIVE_TAB = `(() => {
  if (document.querySelector('iframe[src*="map=1"]')) return 'map'
  if (document.querySelector('video')) return 'feed-or-camera'
  return 'other'
})()`

async function main() {
  const cdp = connect(await findTarget())
  await cdp.ready
  trackContexts(cdp)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 2, mobile: true })
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT, runImmediately: true })

  if (MODE === 'dwell') {
    const url = BASE + '?view=map'
    console.log(`leak-probe dwell: ${url} for ${MINUTES}min, sampling every 20s`)
    await cdp.send('Page.navigate', { url })
    await sleep(15000) // let the map boot + intro land
    printSample('t=0 (map settled)', await sampleAll(cdp))
    const samples = Math.max(1, Math.round((MINUTES * 60) / 20))
    for (let i = 1; i <= samples; i++) {
      await sleep(20000)
      printSample(`t=${i * 20}s`, await sampleAll(cdp))
    }
  } else {
    const url = BASE + '?view=home'
    console.log(`leak-probe cycle: ${url}, ${CYCLES}× map→feed→map→camera`)
    await cdp.send('Page.navigate', { url })
    await sleep(15000)
    printSample('baseline (home, settled)', await sampleAll(cdp))
    const seq = ['map', 'feed', 'map', 'post']
    for (let c = 1; c <= CYCLES; c++) {
      const visited = []
      for (const tab of seq) {
        const top = (await frames(cdp))[0]
        await evalInFrame(cdp, top.id, SWITCH_TAB(tab))
        await sleep(5000) // MAP_SETTLE(350ms) + mount/unmount + map boot
        try { visited.push(await evalInFrame(cdp, (await frames(cdp))[0].id, ACTIVE_TAB)) } catch { visited.push('?') }
      }
      if (!JSON_ONLY) console.log(`  route check: ${seq.join('→')} observed as ${visited.join('→')}`)
      printSample(`after cycle ${c}`, await sampleAll(cdp))
    }
  }
  cdp.close()
  cleanup()
}

main().catch(e => { console.error(e.message); cleanup(); process.exit(1) })
