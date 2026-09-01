// Walk every hold-menu subscreen on every cube tab and record what actually
// rendered. Drives the same web bundle the native apps embed, through CDP, so
// items are found by aria-label instead of by pixel.
//
//   node .codex/sweep-subscreens.mjs [--out results.jsonl] [--base http://localhost:5173]
//
// Written to survive its own failure. The first version of this dumped one
// JSON blob at the end, ran for 25 minutes on fixed sleeps, and died having
// written nothing — a silent failure that looks identical to "nothing to
// report". So:
//   - every result is appended the moment it is known, never buffered
//   - waits poll for a condition with a deadline instead of sleeping blind
//   - a screen that does not open is written down as a FAILURE, not skipped
//   - a global deadline ends the run with partial results rather than hanging
import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : fallback
}
const BASE = arg('base', 'http://localhost:5173')
const OUT = arg('out', join(process.cwd(), 'subscreen-sweep.jsonl'))
const DEADLINE = Date.now() + Number(arg('minutes', 12)) * 60_000
const PORT = Number(arg('port', 9455))

// --attach <port> drives an ALREADY-RUNNING devtools endpoint instead of
// launching Chrome — that is how this runs against the real phone: the debug
// build exposes a WebView devtools socket, `adb forward` brings it to a local
// port, and the same by-label logic applies to the device. Headless Chrome
// proves the bundle; the phone proves the build.
const ATTACH = process.argv.includes('--attach') ? Number(arg('attach')) : null
const dir = ATTACH ? null : mkdtempSync(join(tmpdir(), 'poplur-sweep-'))
const chrome = ATTACH ? null : spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
  '--window-size=430,932', '--autoplay-policy=no-user-gesture-required', '--mute-audio',
  // Without these the camera tab stays behind a permission dialog that never
  // resolves, so every item under it reads as broken when it was simply never
  // reachable. Fake devices keep it deterministic — no real camera involved.
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
], { stdio: 'ignore' })
const cleanup = () => { try { chrome && chrome.kill() } catch {} ; try { dir && rmSync(dir, { recursive: true, force: true }) } catch {} }
process.on('exit', cleanup)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130) })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const record = row => { appendFileSync(OUT, JSON.stringify(row) + '\n'); console.log(JSON.stringify(row)) }
writeFileSync(OUT, '')

let target
for (let i = 0; i < 60 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${ATTACH || PORT}/json`)).json()
    // On device there are several page targets (splash, ads SDK); take the app.
    target = list.find(t => t.type === 'page' && /claymap|index\.html|localhost:5173/.test(t.url)) || list.find(t => t.type === 'page')
  } catch {}
  if (!target) await sleep(500)
}
if (!target) { record({ fatal: 'chrome never exposed a page target' }); process.exit(1) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
await new Promise(r => ws.addEventListener('open', r))
const send = (method, params = {}) => new Promise(res => {
  const i = ++id
  pending.set(i, res)
  // A CDP call that never answers must not wedge the whole run.
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); res({ timedOut: true }) } }, 20_000)
  ws.send(JSON.stringify({ id: i, method, params }))
})
const ev = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.result?.value

// Grant up front what the app gates its screens on. The map hides Search,
// Current Location and Directions without a fix, and the camera tab hides
// everything behind a roll-permission dialog — so a sweep without these reports
// working screens as missing or broken.
await send('Browser.grantPermissions', {
  origin: BASE,
  permissions: ['geolocation', 'videoCapture', 'audioCapture'],
})
// Somewhere real, so distances and "reaches you from" render like they do on
// the phone rather than collapsing to nulls. Toronto.
await send('Emulation.setGeolocationOverride', { latitude: 43.6532, longitude: -79.3832, accuracy: 20 })

/** Poll a JS predicate until true or the deadline passes. Returns whether it became true. */
const waitFor = async (expr, ms, step = 700) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await ev(`!!(${expr})`)) return true
    await sleep(step)
  }
  return false
}

// The cube needs a real held pointer, not a click: a tap changes tab instead.
const HOLD = `(() => {
  const wrap = document.querySelector('[class*=cubeWrap]')
  if (!wrap) return false
  const el = wrap.querySelector('canvas') || wrap
  const r = el.getBoundingClientRect()
  const base = { bubbles:true, cancelable:true, composed:true, pointerId:1, pointerType:'touch',
                 isPrimary:true, clientX: r.x + r.width/2, clientY: r.y + r.height/2, button:0 }
  el.dispatchEvent(new PointerEvent('pointerdown', {...base, buttons:1}))
  window.__rel = () => el.dispatchEvent(new PointerEvent('pointerup', {...base, buttons:0}))
  return true
})()`

async function openWheel() {
  if (!await ev(HOLD)) return false
  await sleep(1200)
  await ev('window.__rel && window.__rel()')
  return waitFor(`document.querySelector('[role=dialog][aria-label*="hold menu" i]')`, 8000)
}

async function gotoTab(tab) {
  // Attached to a device the app owns its own routing, so re-navigating would
  // reload the shell out from under us. Reuse whatever is on screen instead.
  if (ATTACH) return waitFor(`document.querySelector('[class*=cubeWrap]')`, 45_000)
  await send('Page.navigate', { url: `${BASE}/?view=${tab}` })
  // Mounted == the cube exists. Far quicker than a blanket sleep on the feed,
  // and genuinely patient on the map, which needs ~20s on a cold load.
  return waitFor(`document.querySelector('[class*=cubeWrap]')`, 45_000)
}

const TABS = (arg('tabs', 'feed,profile,map,camera')).split(',')
for (const tab of TABS) {
  if (Date.now() > DEADLINE) { record({ note: 'deadline reached, stopping early', tab }); break }
  if (!await gotoTab(tab)) { record({ tab, FAILURE: 'app never mounted' }); continue }
  if (!await openWheel()) { record({ tab, FAILURE: 'hold menu never opened' }); continue }

  // The wheel populates progressively, and enumerating too early under-reports:
  // the map returned 1 item where the device shows 5. Wait until the count stops
  // growing rather than trusting the first sample.
  const countExpr = `[...document.querySelectorAll('button')].filter(b => /subscreen/i.test(b.getAttribute('aria-label')||'')).length`
  let stable = 0, last = -1
  for (let i = 0; i < 25 && stable < 3; i++) {
    const n = await ev(countExpr)
    stable = n === last ? stable + 1 : 0
    last = n
    await sleep(600)
  }
  const labels = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('button')]
    .map(b => b.getAttribute('aria-label')).filter(l => l && /subscreen/i.test(l)))`) || '[]')
  record({ tab, wheel: labels, settledAfterCount: last })

  for (const label of labels) {
    if (Date.now() > DEADLINE) { record({ note: 'deadline reached', tab, pending: label }); break }
    // Capture the dialog that is ALREADY up. The camera tab sits behind a
    // persistent "Camera roll permission" dialog, and a detector that merely
    // asks "is a dialog present?" reported five straight successes for screens
    // it never opened. A subscreen only counts if the dialog CHANGED.
    const before = JSON.parse(await ev(`JSON.stringify({
      // Compare the WHOLE document, not a 120-char head. On the camera tab the
      // first 120 chars are the roll's caption strip, so starting a recording
      // or opening Games changed nothing "visible" and read as a dead button.
      // Keep a short excerpt for the report, but decide change on the full text.
      len: (document.body.innerText||'').length,
      text: (document.body.innerText||'').trim().replace(/\\s+/g,' ').slice(0,120),
      dialog: (document.querySelector('[role=dialog]') || {}).ariaLabel || null,
    })`) || '{}')
    const clicked = await ev(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === ${JSON.stringify(label)})
      if (!b) return false; b.click(); return true })()`)
    // A subscreen is open when a dialog that ISN'T the wheel is present.
    const opened = clicked && await waitFor(
      `(() => {
         const d = document.querySelector('[role=dialog]')
         if (!d) return false
         const label = d.getAttribute('aria-label') || ''
         if (/hold menu/i.test(label)) return false
         // Must be a DIFFERENT dialog than whatever was already showing.
         return label !== ${JSON.stringify(before.dialog || '')}
       })()`, 12_000)

    if (!opened) {
      // Not every wheel item is a subscreen, even though the app labels them all
      // "Open X subscreen": LIKE and CC OFF are toggles, PROFILE jumps tabs. So
      // absence of a dialog is only a failure if NOTHING happened at all —
      // otherwise report what kind of thing it actually was.
      const after = JSON.parse(await ev(`JSON.stringify({
        dialog: (document.querySelector('[role=dialog]')||{}).ariaLabel || null,
        len: (document.body.innerText||'').length,
        text: (document.body.innerText||'').trim().replace(/\\s+/g,' ').slice(0,120),
      })`) || '{}')
      // Any of these counts as "something happened": the visible head changed,
      // the document grew or shrank, or a different dialog took over.
      const changed = after.text !== before.text || after.len !== before.len || after.dialog !== before.dialog
      record(clicked
        ? { tab, item: label, kind: changed ? 'not a subscreen — acted in place (toggle/navigation)' : null,
            ...(changed ? { text: after.text } : { FAILURE: 'clicked and nothing changed' }) }
        : { tab, item: label, FAILURE: 'button vanished from wheel' })
    } else {
      const state = JSON.parse(await ev(`JSON.stringify((() => {
        const d = document.querySelector('[role=dialog]')
        return {
          dialog: d.getAttribute('aria-label'),
          nodes: document.getElementsByTagName('*').length,
          canvases: document.querySelectorAll('canvas').length,
          videos: document.querySelectorAll('video').length,
          playing: [...document.querySelectorAll('video')].filter(v => !v.paused).length,
          // Every subscreen must offer a way out. The Comment sheet did not.
          closers: [...document.querySelectorAll('button')]
            .filter(b => /close|quit|done|dismiss/i.test((b.getAttribute('aria-label')||'') + ' ' + b.textContent)).length,
          // Rough Copy subscreens render inside an iframe, so the parent's
          // innerText is the page BEHIND them. Reading only that reported the
          // profile page as though it were the subscreen's content. Reach in
          // where same-origin allows, and say so plainly when it does not.
          text: (() => {
            const f = d.querySelector('iframe')
            if (f) {
              try {
                const doc = f.contentDocument
                if (doc && doc.body) return 'IFRAME: ' + (doc.body.innerText||'').trim().replace(/\\s+/g,' ').slice(0,120)
                return 'IFRAME: (cross-origin — content not readable)'
              } catch { return 'IFRAME: (cross-origin — content not readable)' }
            }
            return (document.body.innerText||'').trim().replace(/\\s+/g,' ').slice(0,120)
          })(),
        }
      })())`) || '{}')
      record({ tab, item: label, ...state, ...(state.closers === 0 ? { WARN: 'no visible way out' } : {}) })
    }
    // Re-navigate rather than trusting each screen's own close control — relying
    // on those is exactly what strands you on device, so it must not gate the sweep.
    if (!await gotoTab(tab) || !await openWheel()) { record({ tab, FAILURE: 'could not return to wheel' }); break }
  }
}

record({ done: true, at: new Date().toISOString() })
ws.close()
process.exit(0)
