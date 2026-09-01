#!/usr/bin/env node
// Pre-render the hold-menu cube models to flat PNGs.
//
// WHY pre-render rather than ship the GLBs:
//
// The cubes arrive from Meshy as image-to-3d output — ~294k triangles and
// ~10MB of JPEG textures EACH. Sixteen of them is 327MB against a mobile
// bundle that is already 286MB, and sync-mobile strips `models/` precisely
// because payloads that size cannot ride to a phone. Drawing them live would
// also mean sixteen WebGL contexts in the wheel, and GL contexts are exactly
// what .codex/thermal-gate.mjs counts before it lets a build publish.
//
// A hold-menu icon is a static mark at ~56px that never animates. It has no
// business being a mesh at runtime. So we render each cube ONCE here, offline,
// and ship the PNG the existing <img> already asks for — no renderer change,
// no bundle growth, no thermal cost.
//
// Rendering happens in headless Chrome over CDP, the same way thermal-gate
// measures surfaces, because three.js needs a real GL context. The PNG comes
// back through a Runtime.evaluate of canvas.toDataURL — an EVAL, not a CDP
// screenshot, which is the lesson from the headless probing work: screenshots
// starve under load long before evals do.
//
// Usage:
//   node .codex/prerender-holdmenu-cubes.mjs <glb-dir> [--out <dir>] [--size 256]

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLAY_MAP = join(root, 'poplur-clay-map')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const args = process.argv.slice(2)
const glbDir = args.find(a => !a.startsWith('--')) ?? ''
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(CLAY_MAP, 'public/holdmenu')
const SIZE = Number(args.includes('--size') ? args[args.indexOf('--size') + 1] : 256)

if (!glbDir || !existsSync(glbDir)) {
  console.error('Usage: node .codex/prerender-holdmenu-cubes.mjs <glb-dir> [--out <dir>] [--size 256]')
  process.exit(1)
}

// Which cube becomes which hold-menu icon. Keyed by the fragment Meshy leaves
// in the filename, because its names are truncated ("camera_ro", "hey_poplu").
//
// `video` deliberately does NOT write TVGuide.png: the VIDEO tile and the
// TV GUIDE tile currently share `icon: 'TVGuide'`, so overwriting it would
// silently restyle TV GUIDE too. VIDEO gets its own mark instead.
const ICON_FOR = {
  direction: 'Directions',
  mail: 'Mail',
  news: 'News',
  live: 'YouTube',
  ar: 'AR',
  stats: 'Stats',
  map: 'MapMode',
  comment: 'Chat',
  start_tou: 'Tour',
  hey_poplu: 'HeyPoplur',
  create: 'Create',
  settings: 'Settings',
  camera_ro: 'CameraRoll',
  video: 'Video',
  store: 'Store',
  search: 'Search',
  // Aliases for the decimated filenames, where Meshy's truncated keys
  // ("camera_ro", "hey_poplu", "start_tou") have been spelled out.
  cameraroll: 'CameraRoll',
  heypoplur: 'HeyPoplur',
  tour: 'Tour',
  // Not cubes, but the same proofing path: the subscreen navigators that had
  // to be decimated out of their multi-megabyte originals.
  mixer: 'StudioMixer',
  phone: 'ClayPhone',
  pin: 'PopPin',
  mic: 'StudioMic',
  sun: 'Sun',
  moonfull: 'MoonFull',
  mooncrescent: 'MoonCrescent',
}

// Per-cube pose corrections, in radians.
//
// Meshy does not agree with itself about which way is up: most of these cubes
// arrive facing the camera, but some are laid on a side, so one global pose
// renders their face edge-on and their label unreadable. Anything absent here
// uses the default 3/4 pose. Use --probe <name> to find a correction.
const POSE_FOR = {
  // Arrived with its labelled face pointing along +X, so the default pose
  // caught it edge-on and VIDEO ran up the left border unreadably. A quarter
  // turn in YAW (not roll — roll only spun the blank face) brings it forward.
  Video: { yaw: 0.36 - Math.PI / 2, pitch: -0.14, roll: 0 },
}

function iconNameFor(file) {
  // Two shapes: Meshy's raw export (poplur_icon_<key>_<stamp>_…) and the
  // decimated models we publish (poplur_cube_<key>.glb), so the same renderer
  // can proof either one.
  const lite = /poplur_cube_([a-z0-9_]+)\.glb$/i.exec(file)
  const m = lite ?? /poplur_icon_(.+?)_(?:3d_)?\d{10}/.exec(file)
  const key = m?.[1]
  if (!key) return null
  // Longest key first so "camera_ro" wins over any shorter accidental match.
  const hit = Object.keys(ICON_FOR).sort((a, b) => b.length - a.length).find(k => key.startsWith(k))
  return hit ? ICON_FOR[hit] : null
}

const glbs = readdirSync(glbDir).filter(f => f.endsWith('.glb')).sort()
const jobs = glbs.map(f => ({ file: f, icon: iconNameFor(f) })).filter(j => j.icon)
const skipped = glbs.filter(f => !iconNameFor(f))
if (skipped.length) console.warn(`unmapped, skipping: ${skipped.join(', ')}`)
if (!jobs.length) { console.error('no cubes matched the icon map'); process.exit(1) }

// ── a tiny static server: Chrome must FETCH the glb (file:// blocks it) ─────
const THREE_DIR = join(CLAY_MAP, 'node_modules/three')
const MIME = {
  '.glb': 'model/gltf-binary', '.js': 'text/javascript', '.html': 'text/html',
  '.wasm': 'application/wasm', '.json': 'application/json',
}

const PAGE = `<!doctype html><meta charset="utf-8">
<script type="importmap">{"imports":{
  "three":"/three/build/three.module.js",
  "three/addons/":"/three/examples/jsm/"
}}</script>
<canvas id="c"></canvas>
<script type="module">
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
// Decimated cubes come back Draco-compressed, and GLTFLoader refuses them
// outright without this. The decoder is served straight out of node_modules.
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'

// Supersample: render big, let the browser downscale on write-out. A 256px
// mark straight out of the renderer has visibly crunchy bevel edges.
const SS = 4
const canvas = document.getElementById('c')
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
renderer.setClearColor(0x000000, 0)
renderer.outputColorSpace = THREE.SRGBColorSpace

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 1000)

// The SAME clay lighting as ClayMuteButton / ClayChannelArrows, so a rendered
// cube sits in the identical light as the clay marks drawn live beside it.
scene.add(new THREE.HemisphereLight(0xffd9ec, 0x2a0d1c, 0.95))
const key = new THREE.DirectionalLight(0xffffff, 1.15); key.position.set(2.4, 3.2, 4); scene.add(key)
const rim = new THREE.DirectionalLight(0xff9ecb, 0.55); rim.position.set(-3, -1.4, 2.2); scene.add(rim)

window.renderCube = async (url, size, yaw, pitch, roll = 0) => {
  renderer.setSize(size * SS, size * SS, false)
  const loader = new GLTFLoader()
  const draco = new DRACOLoader()
  draco.setDecoderPath('/three/examples/jsm/libs/draco/')
  loader.setDRACOLoader(draco)
  const gltf = await loader.loadAsync(url)
  const model = gltf.scene
  const root = new THREE.Group()
  root.add(model)
  scene.add(root)

  // Frame it from its own bounds: Meshy models arrive at arbitrary scale and
  // off-origin, so a fixed camera distance would crop half of them.
  const box = new THREE.Box3().setFromObject(model)
  const sphere = box.getBoundingSphere(new THREE.Sphere())
  model.position.sub(sphere.center)
  root.rotation.set(pitch, yaw, roll)
  // 1.15, not 1.02: a bounding SPHERE framed exactly fills the frustum only at
  // its equator, so a rotated cube's near corner still crossed the bottom edge.
  const dist = sphere.radius / Math.sin((camera.fov * Math.PI / 180) / 2)
  camera.position.set(0, 0, dist * 1.15)
  camera.lookAt(0, 0, 0)
  camera.updateProjectionMatrix()

  renderer.render(scene, camera)

  // Downscale the supersample before encoding. toDataURL reads the BACKING
  // store, so without this step every icon shipped at size*SS (1024px, ~500KB)
  // — the supersample is meant to be thrown away, not delivered.
  const out = document.createElement('canvas')
  out.width = size; out.height = size
  const ctx = out.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(canvas, 0, 0, size, size)
  const data = out.toDataURL('image/png')

  scene.remove(root)
  model.traverse(o => {
    if (o.geometry) o.geometry.dispose()
    for (const m of [o.material].flat()) {
      if (!m) continue
      for (const k of Object.keys(m)) { if (m[k]?.isTexture) m[k].dispose() }
      m.dispose?.()
    }
  })
  return data
}
window.__ready = true
</script>`

const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0])
  try {
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE)
    }
    const path = url.startsWith('/three/') ? join(THREE_DIR, url.slice(7))
      : url.startsWith('/glb/') ? join(glbDir, url.slice(5))
        : null
    if (!path || !existsSync(path)) { res.writeHead(404); return res.end('no') }
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
    res.end(readFileSync(path))
  } catch (err) {
    res.writeHead(500); res.end(String(err))
  }
})

const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)))

// ── headless Chrome, thermal-gate's flag set (angle gives us real GL) ───────
const dbg = 9800 + Math.floor(Math.random() * 90)
const profileDir = mkdtempSync(join(tmpdir(), 'poplur-prerender-'))
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${dbg}`,
  `--user-data-dir=${profileDir}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--mute-audio',
  '--use-gl=angle', '--enable-gpu-rasterization', '--window-size=512,512',
  `http://127.0.0.1:${port}/`,
], { stdio: 'ignore' })

const cleanup = () => {
  try { chrome.kill() } catch { /* */ }
  try { server.close() } catch { /* */ }
  try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* */ }
}
process.on('exit', cleanup)

let sock
try {
  let ws = null
  for (let i = 0; i < 80 && !ws; i++) {
    ws = await fetch(`http://127.0.0.1:${dbg}/json/list`)
      .then(r => r.json())
      .then(t => t.find(x => x.type === 'page')?.webSocketDebuggerUrl)
      .catch(() => null)
    if (!ws) await new Promise(r => setTimeout(r, 250))
  }
  if (!ws) throw new Error('headless Chrome never exposed a devtools socket')

  sock = new WebSocket(ws)
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error('devtools socket refused')) })

  let msgId = 0
  const pending = new Map()
  sock.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  const send = (method, params) => new Promise((res, rej) => {
    const id = ++msgId
    pending.set(id, m => m.error ? rej(new Error(m.error.message)) : res(m.result))
    sock.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression, timeoutMs = 180_000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('evaluate timed out')), timeoutMs)),
    ])
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'page threw')
    return r.result?.value
  }

  await send('Runtime.enable')
  for (let i = 0; i < 80; i++) {
    if (await evaluate('!!window.__ready', 10_000).catch(() => false)) break
    await new Promise(r => setTimeout(r, 250))
  }
  if (!await evaluate('!!window.__ready', 10_000)) throw new Error('render page never became ready')

  mkdirSync(outDir, { recursive: true })
  // A gentle 3/4 pose — the same read as ClayMuteButton's fixed rotation, so a
  // cube and a live clay mark agree about where the light is coming from.
  const YAW = 0.36, PITCH = -0.14

  const write = (name, data) => {
    if (typeof data !== 'string' || !data.startsWith('data:image/png;base64,')) {
      throw new Error(`${name}: renderer returned no PNG`)
    }
    const buf = Buffer.from(data.slice('data:image/png;base64,'.length), 'base64')
    writeFileSync(join(outDir, `${name}.png`), buf)
    return buf.length
  }

  // --probe <substring>: render ONE cube across a grid of orientations so the
  // right correction can be read off a contact sheet instead of guessed.
  const probe = args.includes('--probe') ? args[args.indexOf('--probe') + 1] : null
  if (probe) {
    const job = jobs.find(j => j.icon.toLowerCase().includes(probe.toLowerCase())
      || j.file.toLowerCase().includes(probe.toLowerCase()))
    if (!job) throw new Error(`--probe ${probe} matched no cube`)
    const url = `/glb/${encodeURIComponent(job.file)}`
    const H = Math.PI / 2
    const poses = [
      ['roll0', YAW, PITCH, 0], ['rollP90', YAW, PITCH, H], ['rollN90', YAW, PITCH, -H],
      ['roll180', YAW, PITCH, Math.PI], ['pitchP90', YAW, PITCH + H, 0], ['pitchN90', YAW, PITCH - H, 0],
      ['yawP90', YAW + H, PITCH, 0], ['yawN90', YAW - H, PITCH, 0], ['yaw180', YAW + Math.PI, PITCH, 0],
    ]
    for (const [name, y, p, r] of poses) {
      write(`${job.icon}__${name}`, await evaluate(`window.renderCube(${JSON.stringify(url)}, ${SIZE}, ${y}, ${p}, ${r})`))
    }
    console.log(`probed ${job.icon} across ${poses.length} poses → ${outDir}`)
  } else {
    for (const { file, icon } of jobs) {
      const url = `/glb/${encodeURIComponent(file)}`
      const pose = POSE_FOR[icon] ?? { yaw: YAW, pitch: PITCH, roll: 0 }
      const data = await evaluate(
        `window.renderCube(${JSON.stringify(url)}, ${SIZE}, ${pose.yaw}, ${pose.pitch}, ${pose.roll ?? 0})`
      )
      const bytes = write(icon, data)
      const note = POSE_FOR[icon] ? '  (posed)' : ''
      console.log(`${icon.padEnd(12)} ${(bytes / 1024).toFixed(0).padStart(5)} KB  ← ${file.slice(0, 40)}${note}`)
    }
    console.log(`\nrendered ${jobs.length} cubes → ${outDir}`)
  }
} finally {
  try { sock?.close() } catch { /* */ }
  cleanup()
}
