// Verifies the username actually reaches the account.
//
// Two paths, both of which used to lead nowhere: the EDITOR (there wasn't one —
// the only one was the orphaned native EditProfileView) and the BACKFILL (a
// handle stranded in this device's localStorage, which native cannot read).
// Both must end in a saveProfileUsername crossing the bridge.
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9333 + (process.pid % 400)
const URL = process.env.PROBE_URL ?? 'http://127.0.0.1:5173/?view=profile'

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const profileDir = mkdtempSync(join(tmpdir(), 'poplur-user-'))
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--mute-audio',
  'about:blank',
], { stdio: 'ignore' })
const cleanup = () => { try { chrome.kill() } catch {} ; try { rmSync(profileDir, { recursive: true, force: true }) } catch {} }
process.on('exit', cleanup)
for (const s of ['SIGINT','SIGTERM']) process.on(s, () => { cleanup(); process.exit(130) })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function findTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = t.find(x => x.type === 'page')
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl
    } catch {}
    await sleep(150)
  }
  throw new Error('Chrome never came up')
}
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl); let nextId = 1; const pending = new Map()
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id)
      m.error ? reject(new Error(m.error.message)) : resolve(m.result)
    }
  })
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  return { ready, send(method, params = {}) {
    const id = nextId++
    return new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })) })
  }, close: () => ws.close() }
}

const cdp = connect(await findTarget())
await cdp.ready
await cdp.send('Runtime.enable'); await cdp.send('Page.enable')

// The native shell, stubbed before any app code runs. isNativeShell() keys off
// exactly this, and every postNativeEvent lands in __bridge.
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__bridge = [];
  window.PoplurNative = { onEvent: s => window.__bridge.push(JSON.parse(s)) };
` })

const evaluate = async expr => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval threw')
  return r.result.value
}

async function load(url) {
  await cdp.send('Page.navigate', { url })
  for (let i = 0; i < 120; i++) {
    await sleep(250)
    // Poll the DOM for the verdict rather than screenshotting: under load the
    // screenshot starves long before an eval does, and the silence reads as a
    // page hang that isn't one.
    if (await evaluate(`!!document.querySelector('h1')`)) return true
  }
  return false
}

const results = []
const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

// ── 1. The editor exists and saves.
if (!await load(URL)) { console.log('FAIL  profile never rendered'); process.exit(1) }
await evaluate(`localStorage.removeItem('poplur.username'); window.__bridge.length = 0`)
await load(URL)

const before = await evaluate(`document.querySelector('h1')?.innerText?.trim() ?? ''`)
const clicked = await evaluate(`(() => {
  const el = [...document.querySelectorAll('h1 span')].find(s => s.onclick || s.title);
  if (!el) return false; el.click(); return true;
})()`)
check('handle is tappable', clicked, clicked ? `showed "${before}"` : 'no editable span found')

await sleep(300)
const typed = await evaluate(`(() => {
  const input = document.querySelector('h1 input');
  if (!input) return 'no input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'markapptist');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return 'ok';
})()`)
check('editing opens an input', typed === 'ok', typed)

await sleep(400)
const saved = await evaluate(`JSON.stringify(window.__bridge.filter(m => m.type === 'saveProfileUsername'))`)
const savedMsgs = JSON.parse(saved)
check('editor reaches the bridge', savedMsgs.some(m => m.username === 'markapptist'), saved)
const shown = await evaluate(`document.querySelector('h1')?.innerText?.trim() ?? ''`)
check('name updates on screen', shown.includes('MARKAPPTIST'), `shows "${shown}"`)
const persisted = await evaluate(`localStorage.getItem('poplur.username')`)
check('persists locally', persisted === 'markapptist', String(persisted))

// ── 2. Illegal characters cannot be typed in.
await evaluate(`window.__bridge.length = 0`)
const sanitized = await evaluate(`(() => {
  const el = [...document.querySelectorAll('h1 span')].find(s => s.onclick || s.title);
  if (!el) return 'no span'; el.click(); return 'ok';
})()`)
await sleep(300)
const dirty = await evaluate(`(() => {
  const input = document.querySelector('h1 input');
  if (!input) return 'no input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, '@bad name/../<script>');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return document.querySelector('h1 input').value;
})()`)
check('rejects illegal characters', dirty === 'badname..script', `typed "@bad name/../<script>" -> "${dirty}"`)
await evaluate(`document.querySelector('h1 input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

// ── 3. The backfill: a handle stranded on this device, account has none.
await evaluate(`localStorage.setItem('poplur.username', 'strandedhandle')`)
await load(URL)
await evaluate(`window.__bridge.length = 0`)
await evaluate(`window.dispatchEvent(new CustomEvent('poplur-native-profile', { detail: { photo: '', video: '' } }))`)
await sleep(400)
const backfill = await evaluate(`JSON.stringify(window.__bridge.filter(m => m.type === 'saveProfileUsername'))`)
check('backfills a stranded handle', JSON.parse(backfill).some(m => m.username === 'strandedhandle'), backfill)

// ── 4. An account that HAS a username must not be overwritten by the device.
await evaluate(`window.__bridge.length = 0`)
await evaluate(`window.dispatchEvent(new CustomEvent('poplur-native-profile', { detail: { username: 'accountwins' } }))`)
await sleep(400)
const noClobber = await evaluate(`JSON.stringify(window.__bridge.filter(m => m.type === 'saveProfileUsername'))`)
const nowShown = await evaluate(`document.querySelector('h1')?.innerText?.trim() ?? ''`)
check('account handle wins, no write back', JSON.parse(noClobber).length === 0 && nowShown.includes('ACCOUNTWINS'), `${noClobber}, shows "${nowShown}"`)

cdp.close(); chrome.kill()
const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
