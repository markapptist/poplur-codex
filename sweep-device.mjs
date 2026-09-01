// Sweep every hold-menu subscreen on every cube tab, on a REAL DEVICE.
//
//   adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>
//   node .codex/sweep-device.mjs --port 9223 --out device-sweep.jsonl
//
// The headless sweep proves the bundle; this proves the build that is actually
// installed. It drives the app's own WebView over CDP, so items are found by
// aria-label rather than by pixel — which is what makes this reliable where
// iPhone Mirroring was not (mirroring could not synthesise the cube gesture at
// all, and its coordinates drifted every time the window rescaled).
import { appendFileSync, writeFileSync } from 'node:fs'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d }
const PORT = Number(arg('port', 9223))
const OUT = arg('out', 'device-sweep.jsonl')
const DEADLINE = Date.now() + Number(arg('minutes', 20)) * 60_000
const sleep = ms => new Promise(r => setTimeout(r, ms))
const record = row => { appendFileSync(OUT, JSON.stringify(row) + '\n'); console.log(JSON.stringify(row)) }
writeFileSync(OUT, '')

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
// Several page targets exist on device (splash, the ads SDK). Take the app.
const t = list.find(x => x.type === 'page' && /claymap/.test(x.url))
if (!t) { record({ fatal: 'app WebView target not found', saw: list.map(x => x.url) }); process.exit(1) }

const ws = new WebSocket(t.webSocketDebuggerUrl)
let id = 0; const pending = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
await new Promise(r => ws.addEventListener('open', r))
const send = (method, params = {}) => new Promise(res => {
  const i = ++id; pending.set(i, res)
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); res({ timedOut: true }) } }, 20_000)
  ws.send(JSON.stringify({ id: i, method, params }))
})
const ev = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))?.result?.result?.value
const waitFor = async (expr, ms, step = 700) => {
  const until = Date.now() + ms
  while (Date.now() < until) { if (await ev(`!!(${expr})`)) return true; await sleep(step) }
  return false
}

// The cube distinguishes a tab-swipe from a hold from a tap by gesture shape:
// it needs pointerdown, real movement of more than ~18px, then pointerup. A
// click is a tap; a slow press is a hold. Mirroring could produce only those
// two, which is why tab switching was impossible there.
const cubeGesture = (dx, holdMs) => `(() => {
  const wrap = document.querySelector('[class*=cubeWrap]')
  if (!wrap) return false
  const el = wrap.querySelector('canvas') || wrap
  const r = el.getBoundingClientRect()
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2
  const mk = (type, x, buttons) => new PointerEvent(type, { bubbles:true, cancelable:true, composed:true,
    pointerId:1, pointerType:'touch', isPrimary:true, clientX:x, clientY:cy, button:0, buttons })
  el.dispatchEvent(mk('pointerdown', cx, 1))
  if (${dx} !== 0) for (let i = 1; i <= 6; i++) el.dispatchEvent(mk('pointermove', cx + (${dx} * i) / 6, 1))
  window.__end = () => el.dispatchEvent(mk('pointerup', cx + ${dx}, 0))
  return true
})()`

async function swipeTab() {
  if (!await ev(cubeGesture(-90, 0))) return false
  await sleep(120)
  await ev('window.__end && window.__end()')
  return waitFor(`document.querySelector('[class*=cubeWrap]')`, 20_000)
}
async function openWheel() {
  if (!await ev(cubeGesture(0, 1))) return false
  await sleep(1300)
  await ev('window.__end && window.__end()')
  return waitFor(`document.querySelector('[role=dialog][aria-label*="hold menu" i]')`, 9000)
}
const closeAny = () => ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => /close|quit/i.test((x.getAttribute('aria-label')||'') + ' ' + x.textContent))
  if (b) { b.click(); return true } return false })()`)

// A stable-ish fingerprint of which tab is showing, so the report says what was
// actually swept rather than assuming the swipe order.
const whoami = `(() => {
  const t = (document.body.innerText||'').slice(0, 400)
  if (/Camera Roll|captures/i.test(t)) return 'camera'
  if (/Media\\s+Messages\\s+Saved|USERNAME/i.test(t)) return 'profile'
  if (/RADIUS/i.test(t) && /CH\\s*\\d/i.test(t)) return 'feed'
  return 'map'
})()`

for (let pass = 0; pass < 4; pass++) {
  if (Date.now() > DEADLINE) { record({ note: 'deadline reached' }); break }
  const tab = await ev(whoami)
  if (!await openWheel()) { record({ tab, FAILURE: 'hold menu never opened' }); await swipeTab(); await sleep(4000); continue }

  let stable = 0, last = -1
  const countExpr = `[...document.querySelectorAll('button')].filter(b => /subscreen/i.test(b.getAttribute('aria-label')||'')).length`
  for (let i = 0; i < 20 && stable < 3; i++) { const n = await ev(countExpr); stable = n === last ? stable + 1 : 0; last = n; await sleep(600) }
  const labels = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('button')]
    .map(b => b.getAttribute('aria-label')).filter(l => l && /subscreen/i.test(l)))`) || '[]')
  record({ tab, wheel: labels })

  for (const label of labels) {
    if (Date.now() > DEADLINE) break
    const before = JSON.parse(await ev(`JSON.stringify({ len:(document.body.innerText||'').length,
      dialog:(document.querySelector('[role=dialog]')||{}).ariaLabel || null })`) || '{}')
    const clicked = await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')===${JSON.stringify(label)})
      if(!b) return false; b.click(); return true })()`)
    const opened = clicked && await waitFor(`(() => { const d=document.querySelector('[role=dialog]'); if(!d) return false
      const l=d.getAttribute('aria-label')||''; return !/hold menu/i.test(l) && l !== ${JSON.stringify(before.dialog || '')} })()`, 12_000)
    if (opened) {
      record({ tab, item: label, ...JSON.parse(await ev(`JSON.stringify((() => { const d=document.querySelector('[role=dialog]')
        return { dialog:d.getAttribute('aria-label'), nodes:document.getElementsByTagName('*').length,
          canvases:document.querySelectorAll('canvas').length, videos:document.querySelectorAll('video').length,
          closers:[...document.querySelectorAll('button')].filter(b=>/close|quit|done|dismiss/i.test((b.getAttribute('aria-label')||'')+' '+b.textContent)).length,
          text:(document.body.innerText||'').trim().replace(/\\s+/g,' ').slice(0,110) } })())`) || '{}') })
      await closeAny(); await sleep(2500)
    } else {
      const after = JSON.parse(await ev(`JSON.stringify({ len:(document.body.innerText||'').length,
        dialog:(document.querySelector('[role=dialog]')||{}).ariaLabel || null })`) || '{}')
      const changed = after.len !== before.len || after.dialog !== before.dialog
      record({ tab, item: label, ...(changed ? { kind: 'acted in place (toggle/navigation)' } : { FAILURE: 'clicked and nothing changed' }) })
    }
    if (!await openWheel()) { record({ tab, note: 'wheel did not reopen; moving on' }); break }
  }
  await closeAny(); await sleep(1500)
  await swipeTab(); await sleep(5000)
}
record({ done: true, at: new Date().toISOString() })
ws.close()
process.exit(0)
