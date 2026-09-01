#!/usr/bin/env node
// Globe rest/resume probe — does the map globe's authored spin actually turn
// while the screen is attended, and actually stop when it is not?
//
//   node .codex/globe-rest-probe.mjs [--base http://127.0.0.1:5173]
//
// WHY THIS EXISTS: the in-app browser pane keeps its page `hidden`, and a
// hidden page never fires requestAnimationFrame at all — so the cube's entire
// render loop is dormant there and every reading is a flat zero, whether the
// spin is correctly rested or completely broken. Chrome with backgrounding
// disabled is the only local surface that runs the loop honestly.
//
// WHAT IT MEASURES: `window.__poplurGlobeSpin` (written by CubeTab3D's loop:
// `spinning` plus the `gate` naming which precondition holds it) alongside a
// count of real WebGL draw calls, which is the spin actually reaching the
// screen rather than a flag claiming it did. The three phases are:
//
//   AWAKE  — just touched: expect spinning=true and draws climbing
//   IDLE   — 34s untouched, past the 30s chrome-idle beat (CHROME_IDLE_MS):
//            spinning=false, gate='chrome-idle', draws flat
//   RESUME — one touch: expect spinning=true and draws climbing again
//
// Exits non-zero if any phase disagrees, so this can gate a release.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }
const BASE = flag('base', 'http://127.0.0.1:5173')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9733 + (process.pid % 400)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const profileDir = mkdtempSync(join(tmpdir(), 'poplur-globe-'))
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profileDir}`,
  '--headless=new',
  '--no-first-run', '--no-default-browser-check', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
  '--use-gl=angle', '--enable-gpu-rasterization',
  // The whole point: a throttled/backgrounded page does not run rAF, and this
  // probe exists to measure an rAF-driven turn.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--window-size=390,844',
  'about:blank',
], { stdio: 'ignore' })

const cleanup = () => { try { chrome.kill() } catch {} try { rmSync(profileDir, { recursive: true, force: true }) } catch {} }
process.on('exit', cleanup)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130) })

async function findTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = targets.find(t => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* still booting */ }
    await sleep(150)
  }
  throw new Error('Chrome DevTools endpoint never came up')
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
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve); ws.addEventListener('error', reject)
  })
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++
      ws.send(JSON.stringify({ id, method, params }))
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    },
  }
}

const evaluate = async (cdp, expression) => {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  })
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'eval failed')
  return result.value
}

// Counts real GPU draws. Installed as an init script so it is in place before
// the app's renderer ever takes a context — a hook added afterwards misses the
// binding three.js already captured.
const DRAW_COUNTER = `
  window.__draws = 0;
  for (const C of [self.WebGLRenderingContext, self.WebGL2RenderingContext]) {
    if (!C) continue;
    for (const m of ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced']) {
      const orig = C.prototype[m];
      if (!orig) continue;
      C.prototype[m] = function(){ window.__draws++; return orig.apply(this, arguments); };
    }
  }
`

const sample = async (cdp, label, seconds) => {
  await evaluate(cdp, 'window.__draws = 0')
  const t0 = Date.now()
  await sleep(seconds * 1000)
  const out = await evaluate(cdp, `JSON.stringify({
    draws: window.__draws,
    spin: window.__poplurGlobeSpin ?? null,
    idle: window.__poplurChromeIdle ?? null,
    vis: document.visibilityState,
  })`)
  const v = JSON.parse(out)
  const dt = (Date.now() - t0) / 1000
  return { label, drawsPerSec: +(v.draws / dt).toFixed(1), ...v }
}

const touch = cdp => evaluate(cdp, `
  document.body.dispatchEvent(new PointerEvent('pointerdown',
    { bubbles: true, pointerId: 1, pointerType: 'touch' }));
  'ok'
`)

const main = async () => {
  const cdp = connect(await findTarget())
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: DRAW_COUNTER })
  await cdp.send('Page.navigate', { url: `${BASE}/?view=map` })
  await sleep(14000)  // model load + first paint (the globe GLB is not instant)

  // The globe GLB decode time varies run to run, so a fixed offset races it:
  // sampling too early catches a parked loop with nothing loaded to turn and
  // reports a spin failure that is really a probe failure. Wait for the spin
  // to actually come up (bounded), THEN measure it.
  const waitForSpin = async (limitMs) => {
    const until = Date.now() + limitMs
    while (Date.now() < until) {
      await touch(cdp)
      const s = await evaluate(cdp, 'JSON.stringify(window.__poplurGlobeSpin ?? null)')
      if (JSON.parse(s)?.spinning === true) return true
      await sleep(1000)
    }
    return false
  }

  const phases = []
  const cameUp = await waitForSpin(25000)
  if (!cameUp) console.log('note: globe never reported spinning within 25s of touching')
  phases.push(await sample(cdp, 'AWAKE', 4))
  await sleep(34000)  // outlast CHROME_IDLE_MS (30s), touching nothing
  phases.push(await sample(cdp, 'IDLE', 4))
  await touch(cdp)
  phases.push(await sample(cdp, 'RESUME', 4))

  for (const p of phases) {
    console.log(`${p.label.padEnd(7)} draws/s=${String(p.drawsPerSec).padStart(6)}  spinning=${String(p.spin?.spinning ?? 'n/a').padEnd(5)} gate=${(p.spin?.gate ?? 'n/a').padEnd(12)} chromeIdle=${p.idle} vis=${p.vis}`)
  }

  const [awake, idle, resume] = phases
  const checks = [
    ['page actually runs its loop', awake.spin !== null],
    ['AWAKE spins', awake.spin?.spinning === true && awake.drawsPerSec > 5],
    // 'parked' is the better of the two resting outcomes: 'chrome-idle' means
    // the loop still runs each frame and declines to turn, 'parked' means it
    // stopped scheduling altogether. Either is a rest; neither is a stall,
    // which would show as spinning=false with some OTHER gate (a lost context
    // reads 'not-globe', a stale tab ref reads 'not-map-tab').
    ['IDLE rests, and rests for the RIGHT reason',
      idle.spin?.spinning === false && ['chrome-idle', 'parked'].includes(idle.spin?.gate)],
    ['IDLE draws stop', idle.drawsPerSec < 1],
    ['RESUME spins again', resume.spin?.spinning === true && resume.drawsPerSec > 5],
  ]
  console.log()
  let ok = true
  for (const [name, pass] of checks) {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`)
    if (!pass) ok = false
  }
  console.log(`\nglobe-rest: ${ok ? 'PASS' : 'FAIL'}`)
  process.exit(ok ? 0 : 1)
}

main().catch(err => { console.error('globe-rest probe failed:', err.message); process.exit(2) })
