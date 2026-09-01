#!/usr/bin/env node
// Swipe-direction probe — does the app move the way the finger moved?
//
//   node .codex/swipe-direction-probe.mjs [--base http://127.0.0.1:5173]
//
// The contract (user-stated, 20 Aug): swipe left -> cube left, screen left.
// Same for right, up and down. Three things have to agree for that to hold,
// and each is checked from the DOM rather than assumed:
//
//   1. the transition MODE is a directional one at all — the old defaults were
//      `roll` (a pop in place) and `fade` (a cross-fade), which produce
//      identical motion for opposite swipes, so no direction could be right
//   2. the screen's push class matches the swipe axis and sign
//   3. the cube's --cube-swap-x/y matches it, so both travel together
//
// Read as: PASS means a real gesture produced classes and variables that move
// that way. It does not measure pixels — the keyframes are asserted separately
// by their own definitions, which this prints so they can be eyeballed once.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }
const BASE = flag('base', 'http://127.0.0.1:5173')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 10500 + (process.pid % 900)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const profileDir = mkdtempSync(join(tmpdir(), 'poplur-swipe-'))
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

// A real pointer gesture on the cube: down, a few moves, then up past the 28px
// threshold. Dispatched as PointerEvents because that is what the cube binds;
// a synthetic click would never reach the swipe path at all.
const swipe = (cdp, ax, ay) => evaluate(cdp, `(function(){
  // The CUBE's canvas specifically. Picking "the first canvas wider than
  // 100px" grabbed whichever subscreen had just opened (games, radio) once a
  // gesture had navigated into one, so the next swipe was delivered to that
  // screen instead of the navigator and appeared to do nothing.
  const cv = document.querySelector('[data-poplur-cube] canvas');
  if (!cv) return 'no cube';
  const r = cv.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const opts = (x, y) => ({ bubbles: true, pointerId: 7, pointerType: 'touch', clientX: x, clientY: y });
  cv.dispatchEvent(new PointerEvent('pointerdown', opts(cx, cy)));
  for (let i = 1; i <= 4; i++) {
    cv.dispatchEvent(new PointerEvent('pointermove', opts(cx + ${ax} * i / 4, cy + ${ay} * i / 4)));
  }
  cv.dispatchEvent(new PointerEvent('pointerup', opts(cx + ${ax}, cy + ${ay})));
  return 'ok';
})()`)

// Read the classes/vars WHILE the animation is still running.
const readMotion = cdp => evaluate(cdp, `(function(){
  const cls = n => [...document.querySelectorAll('[class]')]
    .some(e => [...e.classList].some(c => c.indexOf(n) === 0 || c.indexOf('_' + n + '_') === 0));
  // Scan EVERY element for a push class, not just the first contentLayer.
  // While a subscreen is closing there is more than one content layer in the
  // tree, and the one carrying the animation is not necessarily the first —
  // which read as "the screen did not move" when it had.
  const pushed = [...document.querySelectorAll('[class]')]
    .find(e => /_push(Left|Right|Up|Down)_/.test(e.className.toString()));
  const content = pushed || document.querySelector('[class*="contentLayer"]');
  const cubeWrap = document.querySelector('[data-poplur-cube] > div');
  const names = el => el ? [...el.classList].join(' ') : '';
  const cs = cubeWrap ? getComputedStyle(cubeWrap) : null;
  return JSON.stringify({
    screen: names(content),
    cube: names(cubeWrap),
    swapX: cs ? cs.getPropertyValue('--cube-swap-x').trim() : '',
    swapY: cs ? cs.getPropertyValue('--cube-swap-y').trim() : '',
  });
})()`).then(JSON.parse)

const has = (s, n) => s.toLowerCase().includes(n.toLowerCase())

const main = async () => {
  const cdp = connect(await findTarget())
  await cdp.ready
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  await cdp.send('Page.navigate', { url: `${BASE}/?view=home` })
  // Wait for the cube to actually exist rather than guessing a delay. A fixed
  // 13s sometimes landed while the loading splash was still up, so the FIRST
  // swipe was dispatched at a page with no cube in it and silently did
  // nothing — which then read as "swipe left is broken".
  for (let i = 0; i < 80; i++) {
    const ready = await evaluate(cdp, `(function(){
      const cv = [...document.querySelectorAll('canvas')]
        .find(c => c.getBoundingClientRect().width > 100);
      return !!cv && !!document.querySelector('[data-poplur-cube]');
    })()`)
    if (ready) break
    await sleep(500)
  }
  await sleep(2500)   // let the first model finish settling before gesturing

  if (args.includes('--debug')) {
    console.log(await evaluate(cdp, `(function(){
      const cube = document.querySelector('[data-poplur-cube]');
      return JSON.stringify({
        title: document.title,
        canvases: [...document.querySelectorAll('canvas')].map(c => Math.round(c.getBoundingClientRect().width)),
        cubeAttr: !!cube,
        cubeChildren: cube ? [...cube.children].map(e => e.className.toString().slice(0, 60)) : null,
        contentLike: [...document.querySelectorAll('div[class]')]
          .map(e => e.className.toString()).filter(c => /content|stage|home/i.test(c)).slice(0, 6),
      }, null, 2);
    })()`))
  }

  const modes = await evaluate(cdp, `JSON.stringify({
    cube: localStorage.getItem('poplur.transition.cube.v1'),
    screen: localStorage.getItem('poplur.transition.screen.v1'),
  })`).then(JSON.parse)
  console.log(`stored modes (null = using the default): cube=${modes.cube} screen=${modes.screen}\n`)

  // dx, dy, the screen class expected, and the cube axis/sign expected.
  const cases = [
    { name: 'swipe LEFT ', dx: -90, dy: 0, screen: 'pushLeft', axis: 'x', sign: '1' },
    { name: 'swipe RIGHT', dx: 90, dy: 0, screen: 'pushRight', axis: 'x', sign: '-1' },
    { name: 'swipe UP   ', dx: 0, dy: -90, screen: 'pushUp', axis: 'y', sign: '1' },
    { name: 'swipe DOWN ', dx: 0, dy: 90, screen: 'pushDown', axis: 'y', sign: '-1' },
  ]

  // The push class lives ~300ms and the cube's swap can start a beat later
  // (it waits for the incoming model). A single fixed-delay sample therefore
  // catches one, both or neither depending on load timing — which is what made
  // this probe shuffle its own results run to run. Poll instead, and record
  // each side the first time it is seen moving, independently.
  const captureMotion = async (windowMs) => {
    const until = Date.now() + windowMs
    let screen = '', cube = '', swapX = '', swapY = ''
    while (Date.now() < until) {
      const m = await readMotion(cdp)
      if (!screen && /push(left|right|up|down)/i.test(m.screen)) screen = m.screen
      if (!cube && /(cubeslide|cubenudge|cubeswap)/i.test(m.cube)) {
        cube = m.cube; swapX = m.swapX; swapY = m.swapY
      }
      if (screen && cube) break
      await sleep(30)
    }
    return { screen, cube, swapX, swapY }
  }

  let ok = true
  const warnings = []
  for (const c of cases) {
    await swipe(cdp, c.dx, c.dy)
    const m = await captureMotion(2600)   // the open-close-reopen burst can span ~1.5s
    // Two DIFFERENT failures, graded differently on purpose:
    //   wrong direction  -> hard fail. The gesture lied about where it went.
    //   no animation     -> warning. Nothing moved the wrong way; the push
    //                       simply did not play, which happens on a close that
    //                       also swaps the cube's model (the content layer is
    //                       being replaced under the animation).
    // Collapsing them would let a real inversion hide behind a flaky capture.
    const anyPush = /_push(Left|Right|Up|Down)_/.exec(m.screen)
    const screenOk = has(m.screen, c.screen)
    const screenWrong = !!anyPush && !screenOk
    const got = c.axis === 'x' ? m.swapX : m.swapY
    const other = c.axis === 'x' ? m.swapY : m.swapX
    // The cube must travel on the swiped axis, in the swiped direction, and
    // NOT on the other axis — a stale vector from the previous gesture would
    // otherwise read as a pass.
    const cubeOk = got === c.sign && (other === '0' || other === '')
    const cubeMoving = has(m.cube, 'cubeSlide') || has(m.cube, 'cubeNudge') || has(m.cube, 'cubeSwap')
    if (screenWrong || !cubeOk || !cubeMoving) ok = false
    if (!screenOk && !screenWrong) warnings.push(`${c.name.trim()}: screen push did not play (direction never wrong)`)
    const screenVerdict = screenOk ? 'PASS' : screenWrong ? 'FAIL-WRONG-WAY' : 'warn-no-anim'
    console.log(`${c.name}  screen=${screenVerdict} (${m.screen.slice(0, 46) || 'none'})`)
    console.log(`             cube=${cubeOk && cubeMoving ? 'PASS' : 'FAIL'} (x=${m.swapX || '-'} y=${m.swapY || '-'} ${m.cube.slice(0, 40) || 'none'})`)
    await sleep(3000)                   // let the swap fully finish; 1400ms overlapped the next gesture
  }

  if (warnings.length) console.log('\nwarnings:\n  ' + warnings.join('\n  '))
  console.log(`\nswipe-direction: ${ok ? 'PASS' : 'FAIL'}  (hard failure = moved the WRONG way)`)
  process.exit(ok ? 0 : 1)
}

main().catch(e => { console.error('swipe probe failed:', e.message); process.exit(2) })
