#!/usr/bin/env node
// Tab-churn probe — how many WebGL contexts does one lap of the tabs create?
//
//   node .codex/tab-churn-probe.mjs [--laps 4] [--base http://127.0.0.1:5173]
//
// WHY: every clay control used to own a GL context, so a feed or camera visit
// created (and shader-compiled) several per lap. That is not a leak — they are
// all released — which is exactly why a leak probe reports it as clean while
// the phone still gets warm: the cost is the create/compile churn itself, and
// the only way to see it is to count creations rather than survivors.
//
// The counter is installed as an init script, before app code runs, wrapping
// HTMLCanvasElement.prototype.getContext. `created` counts contexts handed out;
// `live` is created minus lost. A shared-context design should keep `created`
// roughly flat as laps increase, where per-button contexts made it climb with
// every lap.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }
const BASE = flag('base', 'http://127.0.0.1:5173')
const LAPS = Number(flag('laps', 4))
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9733 + (process.pid % 400)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const profileDir = mkdtempSync(join(tmpdir(), 'poplur-churn-'))
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--enable-gpu-rasterization',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--use-fake-ui-for-media-stream',
  '--window-size=390,844', 'about:blank',
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
    } catch { /* booting */ }
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
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  return { ready, send(method, params = {}) {
    const id = nextId++
    ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  } }
}

const evaluate = async (cdp, expression) => {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'eval failed')
  return result.value
}

const CTX_COUNTER = `
  window.__ctx = { created: 0, lost: 0, sites: {}, recoveries: 0 };
  // The UI recovery watchdog remounts the cube and the channel arrows when it
  // judges them broken, which recreates their GL contexts. If it fires during
  // ordinary tab changes, that is churn caused by the safety net, not by the
  // screens — worth telling apart.
  addEventListener('poplur-ui-recovered', function(){ window.__ctx.recoveries++; });
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, ...rest) {
    const ctx = orig.call(this, type, ...rest);
    // Only NEW webgl contexts count: getContext on the same canvas returns the
    // same object, and counting those would report re-reads as churn.
    if (ctx && String(type).indexOf('webgl') >= 0 && !this.__counted) {
      this.__counted = true;
      window.__ctx.created++;
      // Attribute to the nearest /src/ frame. No regex and no escapes here on
      // purpose: this string is injected through a template literal, and an
      // escape that survives one hop and not the other silently breaks the
      // whole init script (which then reads as "the page has no counter").
      var owner = 'unknown';
      var lines = String(new Error().stack || '').split(String.fromCharCode(10));
      for (var i = 1; i < lines.length; i++) {
        var at = lines[i].indexOf('/src/');
        if (at >= 0) { owner = lines[i].slice(at + 5).split('?')[0].split(':')[0]; break; }
      }
      window.__ctx.sites[owner] = (window.__ctx.sites[owner] || 0) + 1;
      this.addEventListener('webglcontextlost', function(){ window.__ctx.lost++; });
    }
    return ctx;
  };
`

const read = cdp => evaluate(cdp, 'JSON.stringify(window.__ctx)').then(JSON.parse)

const main = async () => {
  const cdp = connect(await findTarget())
  await cdp.ready
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CTX_COUNTER })
  await cdp.send('Page.navigate', { url: `${BASE}/?view=home` })
  await sleep(12000)

  const settled = await read(cdp)
  console.log(`after first paint:      created=${settled.created} lost=${settled.lost}`)

  // A lap walks the four tabs THE WAY THE APP DOES: the cube's own
  // ArrowLeft/ArrowRight gesture, which calls setActiveTab inline.
  //
  // NOT hash navigation. ViewHarness keys its surface `key={baseView}`, so a
  // hash change remounts the whole HomeTwin subtree — cube, arrows, map and
  // all — and every one of those remounts takes fresh GL contexts. Driving the
  // probe that way measures the test harness's remount, not the app's tab
  // change, and reports churn a real user never pays.
  const perLap = []
  for (let lap = 1; lap <= LAPS; lap++) {
    const before = (await read(cdp)).created
    for (let step = 0; step < 4; step++) {
      await evaluate(cdp, `(function(){
        const cv = [...document.querySelectorAll('canvas')]
          .find(c => c.getBoundingClientRect().width > 100);
        if (!cv) return 'no cube';
        cv.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        return 'ok';
      })()`)
      await sleep(2500)
    }
    const after = await read(cdp)
    perLap.push(after.created - before)
    console.log(`lap ${lap}: +${String(after.created - before).padStart(3)} contexts   (total created=${after.created}, lost=${after.lost}, live=${after.created - after.lost}, uiRecoveries=${after.recoveries})`)
    if (lap === LAPS) {
      console.log('\nattribution (contexts created, whole run):')
      for (const [site, n] of Object.entries(after.sites).sort((a,b)=>b[1]-a[1])) {
        console.log(`  ${String(n).padStart(3)}  ${site}`)
      }
    }
  }

  const late = perLap.slice(1)                       // lap 1 still mounts first-visit surfaces
  const worst = Math.max(...late)
  console.log(`\nsteady-state contexts per lap (laps 2+): ${late.join(', ')}`)
  // Threshold, not zero: the map iframe and the cube legitimately take contexts
  // when a tab is genuinely mounted for the first time in a while. What must
  // NOT happen is a handful of button contexts on every single lap.
  const ok = worst <= 4
  console.log(`tab-churn: ${ok ? 'PASS' : 'FAIL'} (worst lap +${worst}, budget 4)`)
  process.exit(ok ? 0 : 1)
}

main().catch(e => { console.error('tab-churn probe failed:', e.message); process.exit(2) })
