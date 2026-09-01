#!/usr/bin/env node
// Drive the clay map headlessly and report what the CAMERA actually does.
//
// The Browser pane pauses rAF whenever it is hidden, so Mapbox camera
// animations freeze there and every observation is fiction — this is the same
// lesson as profile-screen.mjs, applied to behaviour instead of fps. Headless
// Chrome runs rAF, so flights fly.
//
//   node .codex/drive-map.mjs <url> --do "<js>" [--settle N] [--seconds N] [--hz N]
//
// Samples zoom/center/pitch/bearing every tick, prints the path and a verdict
// on whether the camera ANIMATED (many distinct intermediate states) or
// JUMPED (one discontinuity, then stasis).

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9765 + (process.pid % 200)

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const url = args.find(a => !a.startsWith('--')) || 'http://127.0.0.1:5199/?map=1&front=1'
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const DO = flag('do', '')
const SETTLE = Number(flag('settle', 20)) * 1000
const SECONDS = Number(flag('seconds', 6)) * 1000
const HZ = Number(flag('hz', 5))

const profileDir = mkdtempSync(join(tmpdir(), 'poplur-drive-'))
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profileDir}`,
  '--headless=new',
  '--no-first-run', '--no-default-browser-check', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
  '--use-gl=angle', '--enable-gpu-rasterization',
  '--window-size=393,852',
  'about:blank',
], { stdio: 'ignore' })

let removed = false
const cleanup = () => { if (!removed) { removed = true; try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* */ } } }
process.on('exit', cleanup)
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { try { chrome.kill() } catch { /* */ } cleanup(); process.exit(130) })

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const page = (await res.json()).find(t => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* booting */ }
    await sleep(150)
  }
  throw new Error('DevTools endpoint never came up')
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
  })
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    }),
    ready: new Promise(r => ws.addEventListener('open', r)),
    close: () => ws.close(),
  }
}

const cdp = connect(await findTarget())
await cdp.ready
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Page.navigate', { url })

const evalJs = async (expression, awaitPromise = false) => {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (exceptionDetails) throw new Error(exceptionDetails.text + ' ' + (exceptionDetails.exception?.description || ''))
  return result.value
}

// Wait for the map, up to settle budget. --no-map drives map-less surfaces
// (the feed, profile): settle is then a plain wait and the camera sampler
// reports nothing.
const NO_MAP = args.includes('--no-map')
const t0 = Date.now()
if (!NO_MAP) {
  let loaded = false
  while (Date.now() - t0 < SETTLE) {
    loaded = await evalJs('!!(window.__poplurMap && window.__poplurMap.loaded && window.__poplurMap.loaded())').catch(() => false)
    if (loaded) break
    await sleep(500)
  }
  if (!loaded) { console.error('map never loaded'); chrome.kill(); process.exit(1) }
}
// Let the intro finish flying (or the surface finish booting).
await sleep(Math.max(0, SETTLE - (Date.now() - t0)))

const cam = NO_MAP
  ? `null`
  : `(m=>({z:+m.getZoom().toFixed(2),lng:+m.getCenter().lng.toFixed(4),lat:+m.getCenter().lat.toFixed(4),p:+m.getPitch().toFixed(1),b:+m.getBearing().toFixed(1)}))(window.__poplurMap)`
const before = await evalJs(cam)
if (DO) {
  const doResult = await evalJs(DO, true)
  if (doResult !== undefined) console.log('DO →', typeof doResult === 'string' ? doResult : JSON.stringify(doResult))
}

const samples = []
if (NO_MAP) {
  // Nothing to sample — --seconds is just a window for the --do effect to land.
  await sleep(SECONDS)
} else {
  const period = 1000 / HZ
  const sEnd = Date.now() + SECONDS
  while (Date.now() < sEnd) {
    samples.push(await evalJs(cam))
    await sleep(period)
  }
}

const after = NO_MAP ? null : await evalJs(`({tripping: !!window.__poplurMap.__tripping, cinematic: !!window.__poplurMap.__cinematic})`)
chrome.kill(); cleanup()

// --no-map has no camera path to summarise, and no verdict to reach.
if (NO_MAP) {
  console.log(JSON.stringify({ before, flags: after }, null, 1))
} else {
  const key = s => `${s.z}|${s.lng}|${s.lat}|${s.p}|${s.b}`
  const distinct = new Set(samples.map(key)).size
  const zPath = samples.map(s => s.z)
  console.log(JSON.stringify({ before, distinct, of: samples.length, zPath, pitchPath: samples.map(s => s.p), final: samples[samples.length - 1], flags: after }, null, 1))
  const verdict = distinct >= samples.length * 0.6 ? 'ANIMATED — the camera travelled' : distinct <= 2 ? 'JUMPED — one cut, then stasis' : 'PARTIAL — some motion, then froze'
  console.log(verdict)
}
