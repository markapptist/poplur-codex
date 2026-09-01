#!/usr/bin/env node
// Tile a directory of PNGs into one labelled grid, so a whole icon set can be
// judged in a single look instead of opened one file at a time.
//
// Uses the same headless-Chrome-over-CDP route as prerender-holdmenu-cubes:
// macOS ships `sips`, which cannot montage, and ImageMagick is not installed.
//
//   node .codex/contact-sheet.mjs <png-dir> <out.png> [--cell 220]

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const args = process.argv.slice(2)
const [dir, out] = args.filter(a => !a.startsWith('--'))
const CELL = Number(args.includes('--cell') ? args[args.indexOf('--cell') + 1] : 220)
if (!dir || !out || !existsSync(dir)) {
  console.error('Usage: node .codex/contact-sheet.mjs <png-dir> <out.png> [--cell 220]')
  process.exit(1)
}

const files = readdirSync(dir).filter(f => f.toLowerCase().endsWith('.png')).sort()
if (!files.length) { console.error('no PNGs'); process.exit(1) }

const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0])
  if (url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE) }
  const p = join(dir, url.slice(1))
  if (!existsSync(p) || extname(p) !== '.png') { res.writeHead(404); return res.end('no') }
  res.writeHead(200, { 'content-type': 'image/png' }); res.end(readFileSync(p))
})

const PAGE = `<!doctype html><meta charset="utf-8"><canvas id="c"></canvas><script>
const FILES = ${JSON.stringify(files)}, CELL = ${CELL}
const cols = Math.ceil(Math.sqrt(FILES.length)), rows = Math.ceil(FILES.length / cols)
const LABEL = 26
const c = document.getElementById('c')
c.width = cols * CELL; c.height = rows * (CELL + LABEL)
const x = c.getContext('2d')
// Mid grey, not white or black: these marks have both pale text and dark
// bevels, and either extreme hides one of them.
x.fillStyle = '#4a4a52'; x.fillRect(0, 0, c.width, c.height)
window.build = async () => {
  for (let i = 0; i < FILES.length; i++) {
    const col = i % cols, row = (i / cols) | 0
    const px = col * CELL, py = row * (CELL + LABEL)
    const img = new Image()
    await new Promise(r => { img.onload = r; img.onerror = r; img.src = '/' + FILES[i] })
    x.drawImage(img, px, py, CELL, CELL)
    x.fillStyle = '#0d0d12'; x.fillRect(px, py + CELL, CELL, LABEL)
    x.fillStyle = '#fff'; x.font = '600 15px ui-monospace, Menlo, monospace'
    x.textAlign = 'center'; x.textBaseline = 'middle'
    x.fillText(FILES[i].replace(/\\.png$/, ''), px + CELL / 2, py + CELL + LABEL / 2)
  }
  return c.toDataURL('image/png')
}
window.__ready = true
</script>`

const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const dbg = 9700 + Math.floor(Math.random() * 90)
const profileDir = mkdtempSync(join(tmpdir(), 'poplur-sheet-'))
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${dbg}`, `--user-data-dir=${profileDir}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check',
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
    ws = await fetch(`http://127.0.0.1:${dbg}/json/list`).then(r => r.json())
      .then(t => t.find(x => x.type === 'page')?.webSocketDebuggerUrl).catch(() => null)
    if (!ws) await new Promise(r => setTimeout(r, 250))
  }
  if (!ws) throw new Error('no devtools socket')
  sock = new WebSocket(ws)
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error('socket refused')) })
  let id = 0
  const pending = new Map()
  sock.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, m => m.error ? rej(new Error(m.error.message)) : res(m.result))
    sock.send(JSON.stringify({ id: i, method, params }))
  })
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'page threw')
    return r.result?.value
  }
  await send('Runtime.enable')
  for (let i = 0; i < 60; i++) {
    if (await evaluate('!!window.__ready').catch(() => false)) break
    await new Promise(r => setTimeout(r, 250))
  }
  const data = await evaluate('window.build()')
  writeFileSync(out, Buffer.from(String(data).split(',')[1], 'base64'))
  console.log(`contact sheet: ${files.length} tiles → ${out}`)
} finally {
  try { sock?.close() } catch { /* */ }
  cleanup()
}
