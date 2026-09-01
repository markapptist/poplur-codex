// Bake AR filter carousel icons: the portrait, wearing the grade, wearing the
// effect. Renders the REAL AR_FILTERS data and the REAL EffectMark component in
// the browser and screenshots each swatch, so an icon cannot drift from the
// effect it advertises the way a hand-drawn asset would.
//
//   node bake-filter-icons.mjs <outDir> [size]
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = process.argv[2]
const SIZE = Number(process.argv[3] || 256)
if (!OUT) throw new Error('usage: bake-filter-icons.mjs <outDir> [size]')
mkdirSync(OUT, { recursive: true })

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9600 + (process.pid % 80)
const dir = mkdtempSync(join(tmpdir(), 'bake-'))
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
  '--headless=new', '--no-first-run', '--mute-audio', 'about:blank',
], { stdio: 'ignore' })

const sleep = ms => new Promise(r => setTimeout(r, ms))
let targets = null
for (let i = 0; i < 40 && !targets; i += 1) {
  await sleep(250)
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json() } catch {}
}
const tab = targets.find(t => t.type === 'page' && !String(t.url).startsWith('chrome-extension://'))
const ws = new WebSocket(tab.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (m, p) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method: m, params: p })) })
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
await new Promise(r => { ws.onopen = r })
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: SIZE, height: SIZE, deviceScaleFactor: 2, mobile: false })
await send('Page.navigate', { url: 'http://127.0.0.1:5199/?map=0' })
await sleep(6000)

const mount = `(async()=>{ try {
  const arSrc = await (await fetch('/src/ARFilters.tsx')).text()
  const mainSrc = await (await fetch('/src/main.tsx')).text()
  const grab = (t, re) => (t.match(re)||[])[1]
  const React = (await import(grab(arSrc, /from "([^"]*\\/deps\\/react\\.js[^"]*)"/))).default
  const domMod = await import(grab(mainSrc, /from "([^"]*react-dom_client[^"]*)"/))
  const createRoot = domMod.createRoot || domMod.default?.createRoot
  const mod = await import('/src/ARFilters.tsx')
  window.__filters = mod.AR_FILTERS
  window.__React = React
  window.__EffectMark = mod.EffectMark
  // The app is still mounted and painting; without hiding it the screenshot
  // is of the feed, not of the swatch.
  document.querySelectorAll('body > *').forEach(n => { n.style.display = 'none' })
  window.__root = createRoot(Object.assign(document.body.appendChild(document.createElement('div')),
    { id: 'bake', style: 'position:fixed;left:0;top:0;z-index:2147483647;width:${SIZE}px;height:${SIZE}px;background:#000' }))
  document.body.style.cssText = 'margin:0;background:#000;overflow:hidden'
  return window.__filters.map(f => f.id).join(',')
} catch(e) { return 'THREW: ' + (e && e.stack || e) } })()`
const m = await send('Runtime.evaluate', { expression: mount, awaitPromise: true, returnByValue: true, timeout: 40000 })
const ids = String(m.result?.result?.value || '')
if (ids.startsWith('THREW')) { console.log(ids); ws.close(); chrome.kill(); process.exit(1) }
console.log('filters:', ids)

for (const fid of ids.split(',')) {
  const draw = `(async()=>{
    const React = window.__React, f = window.__filters.find(x => x.id === ${JSON.stringify('%ID%').replace('%ID%', fid)})
    window.__root.render(
      React.createElement('div', { style: { position:'relative', width:'${SIZE}px', height:'${SIZE}px', overflow:'hidden' } }, [
        React.createElement('div', { key:'p', style: {
          position:'absolute', inset:0,
          backgroundImage:'url(' + f.thumbnail + ')', backgroundSize:'cover', backgroundPosition:'center',
          filter: f.css === 'none' ? undefined : f.css } }),
        React.createElement('div', { key:'e', style: { position:'absolute', inset:0 } },
          React.createElement(window.__EffectMark, { id: f.id })),
      ]))
    await new Promise(r => setTimeout(r, 450))
    return 'ok'
  })()`
  await send('Runtime.evaluate', { expression: draw, awaitPromise: true, returnByValue: true, timeout: 20000 })
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(join(OUT, `${fid}.png`), Buffer.from(shot.result.data, 'base64'))
  console.log('baked', fid)
}
ws.close(); chrome.kill(); try { rmSync(dir, { recursive: true, force: true }) } catch {}
