// Does the keyboard lift the pre-login screen, or bury it?
//
// Simulates what the native fix now does: shrink the web viewport by a
// keyboard's height while a field has focus, and check the focused field ends
// up ABOVE the keyboard line instead of under it.
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9733 + (process.pid % 200)
const PAGE = process.env.PROBE_PAGE
  ?? 'file:///Users/matrix/Developer/Poplur2025-iOS/PreloginWeb/welcome.html'
const FULL_H = 1180, KEY_H = 470, W = 820   // iPad portrait, iPad keyboard

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'poplur-kb-'))
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, '--headless=new',
  '--no-first-run', '--no-default-browser-check', '--mute-audio',
  '--allow-file-access-from-files', 'about:blank',
], { stdio: 'ignore' })
const cleanup = () => { try { chrome.kill() } catch {} ; try { rmSync(dir, { recursive: true, force: true }) } catch {} }
process.on('exit', cleanup)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function target() {
  for (let i = 0; i < 80; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = t.find(x => x.type === 'page')
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl
    } catch {}
    await sleep(150)
  }
  throw new Error('chrome never came up')
}
function connect(u) {
  const ws = new WebSocket(u); let id = 1; const pending = new Map()
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result) }
  })
  const ready = new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
  return { ready, send: (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) }), close: () => ws.close() }
}
const cdp = connect(await target()); await cdp.ready
await cdp.send('Runtime.enable'); await cdp.send('Page.enable')
const evaluate = async e => {
  const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.slice(0, 200) ?? 'threw')
  return r.result.value
}
const setViewport = h => cdp.send('Emulation.setDeviceMetricsOverride',
  { width: W, height: h, deviceScaleFactor: 2, mobile: true })

await setViewport(FULL_H)
await cdp.send('Page.navigate', { url: PAGE })
for (let i = 0; i < 100; i++) { await sleep(250); if (await evaluate(`!!document.querySelector('.fieldMail')`)) break }

// Reveal the sign-in pane, whatever drives it, then focus the email field.
await evaluate(`(() => {
  const f = document.querySelector('.fieldMail');
  if (!f) return 'no field';
  let n = f;
  while (n && n !== document.body) { n.style.removeProperty('display'); n.style.removeProperty('visibility'); n = n.parentElement; }
  f.focus(); return 'focused';
})()`)
await sleep(300)

const read = async () => evaluate(`(() => {
  const f = document.querySelector('.fieldMail');
  const r = f.getBoundingClientRect();
  return { bottom: Math.round(r.bottom), top: Math.round(r.top),
           layoutH: getComputedStyle(document.documentElement).getPropertyValue('--poplur-layout-height').trim(),
           focused: document.activeElement === f, innerH: window.innerHeight };
})()`)

const before = await read()
await setViewport(FULL_H - KEY_H)     // the keyboard opens
await sleep(600)
const after = await read()

const keyboardLine = FULL_H - KEY_H
console.log('full viewport :', JSON.stringify(before))
console.log('keyboard up   :', JSON.stringify(after))
console.log('')
const lifted = after.bottom < before.bottom
const clear = after.bottom <= keyboardLine
console.log(`${lifted ? 'PASS' : 'FAIL'}  field lifted (${before.bottom} -> ${after.bottom})`)
console.log(`${clear ? 'PASS' : 'FAIL'}  field clears the keyboard (bottom ${after.bottom} <= ${keyboardLine})`)
cdp.close(); chrome.kill()
process.exit(lifted && clear ? 0 : 1)
