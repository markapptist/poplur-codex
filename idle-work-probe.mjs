#!/usr/bin/env node
// Idle-work probe — what is still running on a screen nobody is touching.
//
// Heat is continuous work, not retained bytes. A leak profiler will not find
// this and neither will a frame profile: every individual wake is ~0ms, and
// what costs power is that there are thousands of them over a quiet minute.
// The only way to see it is to count the wakes themselves.
//
//   node .codex/idle-work-probe.mjs <url> [--seconds 60] [--settle 8] [--json]
//
// HOW: `setInterval`, `setTimeout` and `requestAnimationFrame` are wrapped in
// an init script — before a line of app code runs, so nothing can register
// behind the probe's back. Each registration records its call site; every fire
// is counted against that site. Then the page is left completely alone (no
// input of any kind, which is what lets the app's own idle gates close) and the
// counters are read afterwards.
//
// Read the output as: any site with a non-trivial per-second rate is work the
// phone is doing for a user who is not there. Self-rescheduling `setTimeout`
// chains show up too — they are intervals wearing a disguise, and grouping by
// call site is what makes them visible as one thing.

const args = process.argv.slice(2)
const url = args.find(a => !a.startsWith('--'))
if (!url) {
  console.error('usage: node .codex/idle-work-probe.mjs <url> [--seconds 60] [--settle 8] [--json]')
  process.exit(1)
}
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const SECONDS = Number(flag('seconds', 60))
const SETTLE = Number(flag('settle', 8))
const WIDTH = Number(flag('width', 393))
const HEIGHT = Number(flag('height', 852))
const DPR = Number(flag('dpr', 3))
const LABEL = flag('label', url)
const JSON_ONLY = args.includes('--json')

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9733 + (process.pid % 400)

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const profileDir = mkdtempSync(join(tmpdir(), 'poplur-idle-'))
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
  // Headless Chrome throttles timers in backgrounded pages. This probe is
  // measuring precisely those timers, so the throttle would report the fix we
  // have not made yet.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  // A camera surface with no camera never starts its stream, and every timer
  // downstream of the stream then reads as "does not run at idle" when the
  // truth is "was never given the chance to". A fake device is far closer to
  // the phone than no device at all.
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  'about:blank',
], { stdio: 'ignore' })

let profileDirRemoved = false
function cleanupProfileDir() {
  if (profileDirRemoved) return
  profileDirRemoved = true
  try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* best effort */ }
}
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

// ── the instrument ───────────────────────────────────────────────────────────
// Installed on every new document, including the map iframe, before app code.
// It must be cheap: the probe counting the work has to cost less than the work,
// so a fire does an integer increment and nothing else. All the expensive part
// (capturing and parsing a stack) happens once per REGISTRATION.
const INSTRUMENT = `(() => {
  const sites = new Map()   // key -> { kind, site, delay, fires, registrations }
  const live = new Set()    // registration keys still armed, for the census

  // The frame at registration that belongs to app code rather than to us.
  function callSite() {
    const raw = (new Error().stack || '').split('\\n').slice(1)
    for (const line of raw) {
      if (line.includes('__idleProbe') || line.includes('<anonymous>:')) continue
      const m = line.match(/((?:https?:\\/\\/|blob:|file:)[^\\s)]+)/)
      if (!m) continue
      // Trim the query strings vite hangs off every module URL.
      return m[1].replace(/\\?[^:]*(?=:\\d+:\\d+$)/, '')
    }
    return raw[0] ? raw[0].trim() : '(unknown)'
  }

  function bucket(kind, delay) {
    const site = callSite()
    const key = kind + ' ' + delay + ' ' + site
    let b = sites.get(key)
    if (!b) { b = { kind, site, delay, fires: 0, registrations: 0 }; sites.set(key, b) }
    b.registrations++
    return b
  }

  const rawSetInterval = window.setInterval.bind(window)
  const rawSetTimeout = window.setTimeout.bind(window)
  const rawRaf = window.requestAnimationFrame.bind(window)

  window.setInterval = function (fn, delay, ...rest) {
    if (typeof fn !== 'function') return rawSetInterval(fn, delay, ...rest)
    const b = bucket('interval', Math.round(delay || 0))
    const id = rawSetInterval(function (...a) { b.fires++; return fn.apply(this, a) }, delay, ...rest)
    live.add(b)
    return id
  }

  // Included because a self-rescheduling timeout IS an interval, and it is the
  // shape a polling loop takes when someone has been told not to use intervals.
  window.setTimeout = function (fn, delay, ...rest) {
    if (typeof fn !== 'function') return rawSetTimeout(fn, delay, ...rest)
    const b = bucket('timeout', Math.round(delay || 0))
    return rawSetTimeout(function (...a) { b.fires++; return fn.apply(this, a) }, delay, ...rest)
  }

  window.requestAnimationFrame = function (fn) {
    if (typeof fn !== 'function') return rawRaf(fn)
    const b = bucket('raf', 0)
    return rawRaf(function (...a) { b.fires++; return fn.apply(this, a) })
  }

  window.__idleProbe = {
    reset() { for (const b of sites.values()) b.fires = 0 },
    read() {
      const rows = []
      for (const b of sites.values()) {
        if (!b.fires) continue
        rows.push({ kind: b.kind, delay: b.delay, site: b.site, fires: b.fires })
      }
      rows.sort((x, y) => y.fires - x.fires)
      return rows
    },
  }
})()`

// Ask the app itself what state it thinks it is in, so a low tick count can be
// distinguished from a probe that simply measured the wrong document.
const GOVERNOR_STATE = `(() => {
  const el = document.documentElement
  return {
    href: location.href,
    hidden: document.hidden,
    ambient_sleep_class: el.classList.contains('poplur-ambient-sleep'),
    thermal: el.dataset.poplurThermal || '(none)',
    iframes: document.querySelectorAll('iframe').length,
  }
})()`

async function main() {
  const ws = await findTarget()
  const cdp = connect(ws)
  await cdp.ready

  // Collect execution contexts from the very first event: the map iframe's
  // timers are the ones worth finding, and a context that appeared before the
  // listener existed is a document this probe would silently skip.
  const contexts = new Map()
  cdp.on(msg => {
    if (msg.method === 'Runtime.executionContextCreated') {
      const ctx = msg.params.context
      if (ctx.auxData?.isDefault !== false) contexts.set(ctx.id, ctx)
    } else if (msg.method === 'Runtime.executionContextDestroyed') {
      contexts.delete(msg.params.executionContextId)
    } else if (msg.method === 'Runtime.executionContextsCleared') {
      contexts.clear()
    }
  })

  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: DPR, mobile: true,
  })
  // Before app code, and inherited by child frames — the map lives in an iframe
  // on most of these surfaces, and that is where the timers are.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: INSTRUMENT,
    runImmediately: true,
  })

  await cdp.send('Page.navigate', { url })
  await sleep(SETTLE * 1000)

  // Evaluate in every live document — the shell AND the map iframe.
  const evalEach = async expression => {
    const out = []
    for (const ctx of contexts.values()) {
      try {
        const res = await cdp.send('Runtime.evaluate', {
          expression, returnByValue: true, contextId: ctx.id,
        })
        if (res?.result?.value !== undefined && res.result.value !== null) {
          out.push({ origin: ctx.origin, name: ctx.name, value: res.result.value })
        }
      } catch { /* context went away mid-run */ }
    }
    return out
  }

  const states = await evalEach(GOVERNOR_STATE)
  await evalEach('window.__idleProbe ? (window.__idleProbe.reset(), 1) : 0')

  // TRUE idle: not one synthetic event from here on. Any input at all reopens
  // the app's ambient gate, and the measurement becomes a measurement of the
  // probe poking the page.
  await sleep(SECONDS * 1000)

  const reads = await evalEach(
    'window.__idleProbe ? JSON.stringify(window.__idleProbe.read()) : null',
  )
  // Read the gate again at the END. Reading it only at the start says whether
  // the gate had closed by the time settling finished, which is a different
  // question from whether it was closed for the window being reported.
  const statesAfter = await evalEach(GOVERNOR_STATE)

  // One site can exist in two documents (the shell and the map both load the
  // governor). Keep them separate — which document is awake is the finding.
  const rows = []
  for (const r of reads) {
    const doc = (r.value && JSON.parse(r.value)) || []
    for (const row of doc) rows.push({ ...row, doc: r.name || r.origin || '(main)' })
  }
  rows.sort((a, b) => b.fires - a.fires)

  const total = rows.reduce((a, r) => a + r.fires, 0)
  const report = {
    label: LABEL,
    url,
    seconds: SECONDS,
    documents: statesAfter.map((s, i) => ({
      ...s.value,
      // The gate as it was when settling ended, so a surface that only fell
      // idle partway through the window is visible as such rather than being
      // reported as a clean idle measurement.
      ambient_sleep_at_start: states[i]?.value?.ambient_sleep_class ?? null,
    })),
    total_fires: total,
    total_per_second: +(total / SECONDS).toFixed(2),
    rows: rows.map(r => ({ ...r, per_second: +(r.fires / SECONDS).toFixed(2) })),
  }
  const state = states[0]?.value ?? null

  cdp.close()
  chrome.kill()
  cleanupProfileDir()

  if (JSON_ONLY) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  const short = s => s.replace(/^https?:\/\/[^/]+\//, '')
  console.log(`\n  ${LABEL}`)
  console.log(`  ${SECONDS}s of true idle`)
  for (const d of report.documents) {
    const gate = d.ambient_sleep_at_start === d.ambient_sleep_class
      ? `ambient-sleep=${d.ambient_sleep_class}`
      : `ambient-sleep=${d.ambient_sleep_at_start}->${d.ambient_sleep_class} (WOKE MID-WINDOW)`
    console.log(`    ${short(d.href) || '/'} — ${gate} thermal=${d.thermal} iframes=${d.iframes}`)
  }
  console.log(`  ${report.total_fires} wakes total — ${report.total_per_second}/s\n`)
  console.log(`  ${'per sec'.padStart(8)}  ${'fires'.padStart(6)}  ${'kind'.padEnd(9)} ${'every'.padStart(6)}  site`)
  for (const r of report.rows) {
    const every = r.kind === 'raf' ? '-' : `${r.delay}ms`
    console.log(`  ${String(r.per_second).padStart(8)}  ${String(r.fires).padStart(6)}  ${r.kind.padEnd(9)} ${every.padStart(6)}  ${short(r.site)}`)
  }
  console.log()
  void state
}

main().catch(err => {
  console.error(err)
  try { chrome.kill() } catch {}
  cleanupProfileDir()
  process.exit(1)
})
