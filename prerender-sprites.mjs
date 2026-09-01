#!/usr/bin/env node
// Bake the map's clay sprites at build time.
//
// WHY: modelSprite() renders a GLB to a flat PNG and throws the geometry away.
// Its output is deterministic, but producing it at runtime made the map fetch
// and Draco-decode ~113MB of models on every launch to make a few 256px
// pictures — car.glb is 32MB for one sprite. Profiled on the map at 6x CPU
// throttle that was ~40% of main-thread samples (GLTFLoader/Blob/stream/
// createObjectURL) against ~3% for Mapbox. This bakes them once instead.
//
// HOW: drives the REAL app in headless Chrome with __poplurSpriteCaptures set,
// so every sprite is produced by the same renderer, lights and camera maths as
// before — the shipped PNGs are pixel-identical to what the runtime made. No
// second implementation to drift out of sync.
//
//   node .codex/prerender-sprites.mjs [devOrigin]
//
// Writes poplur-clay-map/public/sprites/*.png and src/spritePrerender.json.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const ORIGIN = process.argv[2] ?? 'http://127.0.0.1:5173'
const ROOT = '/Users/matrix/Developer/poplur-clay-map'
const OUT_DIR = join(ROOT, 'public/sprites')
const MANIFEST = join(ROOT, 'src/spritePrerender.json')
const PORT = 9411 + (process.pid % 150)

// Every surface that asks for a sprite. The map is the big one; the zoom stages
// only appear as you cross their zoom thresholds, so we visit those too.
const ALL_ROUTES = [
  `${ORIGIN}/?map=1&front=1`,
  `${ORIGIN}/?view=home`,
  `${ORIGIN}/?view=map`,
  // Profile requests the camera and seven 640px Mark-head yaw views. Baking
  // them prevents a second WebGL context and GLB decode on the parked screen.
  `${ORIGIN}/?view=profile`,
  // The studio's mic and mixing desk. Deep-linked with holdScreen because the
  // studio is a hold-menu subscreen, and driving that wheel from a script is
  // far more brittle than naming the screen.
  `${ORIGIN}/?view=holdmenu&holdScreen=camera-studio`,
]
const ROUTES = process.argv.includes('--profile-only')
  ? [`${ORIGIN}/?view=profile`]
  : ALL_ROUTES

const profileDir = mkdtempSync(join(tmpdir(), 'poplur-bake-'))
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required', '--use-gl=angle',
  '--enable-gpu-rasterization', 'about:blank',
], { stdio: 'ignore' })
const cleanup = () => { try { rmSync(profileDir, { recursive: true, force: true }) } catch {} }
process.on('exit', cleanup)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function target() {
  for (let i = 0; i < 100; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = t.find(x => x.type === 'page')
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl
    } catch { /* booting */ }
    await sleep(150)
  }
  throw new Error('Chrome DevTools endpoint never came up')
}
function connect(ws) {
  const s = new WebSocket(ws); let id = 1; const pend = new Map()
  s.addEventListener('message', e => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id); pend.delete(m.id)
      m.error ? rej(new Error(m.error.message)) : res(m.result)
    }
  })
  return {
    ready: new Promise((res, rej) => { s.addEventListener('open', res); s.addEventListener('error', rej) }),
    send: (method, params = {}) => new Promise((res, rej) => {
      const i = id++; pend.set(i, { res, rej }); s.send(JSON.stringify({ id: i, method, params }))
    }),
  }
}

const cdp = connect(await target())
await cdp.ready
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 3, mobile: true })
// Install the collector before any app code runs, on every navigation.
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: 'window.__poplurSpriteCaptures = {};',
})

const ev = async expression => {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  })
  if (exceptionDetails) throw new Error(exceptionDetails.text)
  return result.value
}

const captured = {}
for (const route of ROUTES) {
  process.stdout.write(`  visiting ${route.replace(ORIGIN, '')} … `)
  await cdp.send('Page.navigate', { url: route })
  // Wait for the app to settle, then sweep zoom levels so every zoom-stage
  // model (globe → cloud → airplane → buildings) is asked for at least once.
  await sleep(18000)
  if (route.includes('view=map') || route.includes('map=1')) {
    for (const zoom of [3, 6, 10, 14]) {
      await ev(`(() => { const m = window.__map; if (m && m.setZoom) m.setZoom(${zoom}); return 1 })()`).catch(() => {})
      await sleep(6000)
    }
  }
  const got = await ev('window.__poplurSpriteCaptures || {}')
  Object.assign(captured, got)
  console.log(`${Object.keys(got).length} sprites`)
}

chrome.kill()

const keys = Object.keys(captured)
if (!keys.length) {
  console.error('\nNo sprites captured — is the dev server up at ' + ORIGIN + '?')
  process.exit(1)
}

mkdirSync(OUT_DIR, { recursive: true })
const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {}
let written = 0
let bytes = 0
for (const key of keys.sort()) {
  const dataUrl = captured[key]
  if (!dataUrl?.startsWith('data:image/png;base64,')) continue
  // A stable, readable filename: car.glb|90|68|256 → car_y90_p68_s256.png
  const [url, yaw, pitch, size] = key.split('|')
  const base = url.split('/').pop().replace(/\.glb$/, '')
  const file = `${base}_y${yaw}_p${pitch}_s${size}.png`.replace(/[^\w.-]/g, '_')
  const buf = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64')
  writeFileSync(join(OUT_DIR, file), buf)
  manifest[key] = `sprites/${file}`
  written++
  bytes += buf.length
}
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')

console.log(`\nBaked ${written} sprites → public/sprites/ (${(bytes / 1024).toFixed(0)} KB total)`)
console.log(`Manifest: src/spritePrerender.json (${Object.keys(manifest).length} entries)`)
console.log('These replace ~113MB of runtime GLB downloads on every launch.')
cleanup()
