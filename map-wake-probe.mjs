#!/usr/bin/env node
// MAP WAKE PROBE — what does a RETURN to a parked map actually spend?
//
// The thermal gate's `map-arrival` surface says a visit costs ~5-9s of
// renderer CPU and draws hundreds of Mapbox frames. It cannot say WHY. This
// probe brackets the unpark itself: settle the map until it parks, park it
// harder via `poplur-map-front:false`, then wake it and record, for exactly
// ARRIVAL_MS, both a V8 CPU profile (self-time by function) and a census of
// the Mapbox-level work that drives frames.
//
// Usage: node .codex/map-wake-probe.mjs [--base http://127.0.0.1:5199] [--window 30]
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : fallback
}
const BASE = arg('base', 'http://127.0.0.1:5199')
const PATH_ = arg('path', '/?map=1&front=1&mapMode=3d&iosTier=1')
const WINDOW_MS = Number(arg('window', '30')) * 1000
const OUT = arg('out', '')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const load1 = () => {
  try { return Number(execSync('sysctl -n vm.loadavg').toString().split(' ')[1]) } catch { return NaN }
}

// ── Page-side instrumentation ────────────────────────────────────────────────
// Installed while the map is PARKED, so nothing here is measured as arrival
// work, and every counter starts from the parked baseline.
const INSTRUMENT = `(() => {
  const map = window.__poplurMap || window.__map
  if (!map) return 'no map'
  const w = window
  if (w.__wakeProbe) return 'already'
  const c = {
    renders: 0, idles: 0, movestart: 0, move: 0, moveend: 0,
    zoom: 0, pitch: 0, rotate: 0, dataEvents: 0, sourcedata: 0, styledata: 0,
    sourcedataloading: 0, tileLoads: 0,
    triggerRepaint: 0, setBearing: 0, setPitch: 0, jumpTo: 0, easeTo: 0, flyTo: 0,
    setPaintProperty: 0, setLayoutProperty: 0, setFeatureState: 0,
    setData: 0, queryRenderedFeatures: 0, toDataURL: 0, toDataURLms: 0,
    isStyleLoaded: 0, isStyleLoadedFalse: 0, mapLoaded: 0, setFilter: 0,
    getImageData: 0, rafCallbacks: 0, timeouts: 0, intervals: 0,
  }
  // Where do repaints come from? Bucket by the calling frame.
  const repaintCallers = Object.create(null)
  const bump = (obj, key) => { obj[key] = (obj[key] || 0) + 1 }
  const callerOf = depth => {
    const lines = (new Error().stack || '').split('\\n').slice(depth, depth + 3)
    return lines.map(l => l.trim().replace(/^at /, '').replace(/\\?[a-z0-9=&.]+(?=:)/gi, '')).join(' < ') || 'unknown'
  }

  const on = (ev, key) => map.on(ev, () => { c[key]++ })
  on('render', 'renders'); on('idle', 'idles')
  on('movestart', 'movestart'); on('move', 'move'); on('moveend', 'moveend')
  on('zoom', 'zoom'); on('pitch', 'pitch'); on('rotate', 'rotate')
  on('styledata', 'styledata'); on('sourcedataloading', 'sourcedataloading')
  map.on('data', e => { c.dataEvents++; if (e.dataType === 'source') { c.sourcedata++; if (e.tile) c.tileLoads++ } })

  const wrap = (obj, name, key, extra) => {
    if (!obj || typeof obj[name] !== 'function') return
    const orig = obj[name]
    obj[name] = function (...a) {
      c[key]++
      if (extra) extra(a)
      return orig.apply(this, a)
    }
  }
  wrap(map, 'triggerRepaint', 'triggerRepaint', () => { bump(repaintCallers, callerOf(2)) })
  wrap(map, 'setBearing', 'setBearing'); wrap(map, 'setPitch', 'setPitch')
  wrap(map, 'jumpTo', 'jumpTo'); wrap(map, 'easeTo', 'easeTo'); wrap(map, 'flyTo', 'flyTo')
  wrap(map, 'setPaintProperty', 'setPaintProperty'); wrap(map, 'setLayoutProperty', 'setLayoutProperty')
  wrap(map, 'setFilter', 'setFilter')
  wrap(map, 'setFeatureState', 'setFeatureState')
  wrap(map, 'queryRenderedFeatures', 'queryRenderedFeatures')
  // isStyleLoaded() walks every source cache and every tile. A source that is
  // perpetually reloading keeps it FALSE, which is also why the map can never
  // reach idle and park.
  const origStyleLoaded = map.isStyleLoaded
  map.isStyleLoaded = function (...a) {
    c.isStyleLoaded++
    const v = origStyleLoaded.apply(this, a)
    if (!v) c.isStyleLoadedFalse++
    return v
  }
  const origLoaded = map.loaded
  map.loaded = function (...a) { c.mapLoaded++; return origLoaded.apply(this, a) }

  // Every live GeoJSON source, so ambient decoration that re-feeds features
  // (cars, boats, flyers, claims) is visible as source churn rather than as
  // an anonymous repaint.
  try {
    const style = map.style || map._style
    const sources = style && (style.sourceCaches || style._sourceCaches)
    const seen = new Set()
    Object.keys(sources || {}).forEach(id => {
      const src = (style.getSource ? style.getSource(id.replace(/^other:/, '')) : null)
      if (!src || seen.has(src)) return
      seen.add(src)
      wrap(src, 'setData', 'setData')
    })
  } catch (e) { /* style shape differs across versions */ }

  const cproto = HTMLCanvasElement.prototype
  const origToDataURL = cproto.toDataURL
  cproto.toDataURL = function (...a) {
    const t0 = performance.now()
    const out = origToDataURL.apply(this, a)
    c.toDataURL++; c.toDataURLms += performance.now() - t0
    return out
  }
  const ctxProto = CanvasRenderingContext2D.prototype
  wrap(ctxProto, 'getImageData', 'getImageData')

  const origRaf = w.requestAnimationFrame
  w.requestAnimationFrame = function (cb) { c.rafCallbacks++; return origRaf.call(w, cb) }
  const origTimeout = w.setTimeout
  w.setTimeout = function (...a) { c.timeouts++; return origTimeout.apply(w, a) }
  const origInterval = w.setInterval
  w.setInterval = function (...a) { c.intervals++; return origInterval.apply(w, a) }

  w.__wakeProbe = {
    counters: c,
    repaintCallers,
    zero() { Object.keys(c).forEach(k => { c[k] = 0 }); Object.keys(repaintCallers).forEach(k => delete repaintCallers[k]) },
    read() {
      return {
        counters: { ...c },
        repaintCallers: { ...repaintCallers },
        mapRenderCount: w.__poplurMapRenderCount,
        park: document.documentElement.dataset.poplurMapPark || '0',
        ambientAsleep: document.documentElement.classList.contains('poplur-ambient-sleep'),
        surfaceFront: document.documentElement.dataset.poplurSurfaceFront || '?',
        staticFrame: document.documentElement.dataset.poplurMapStaticFrame || '?',
        snapshot: w.__poplurMapIdleSnapshot ? { ...w.__poplurMapIdleSnapshot } : null,
        center: map.getCenter ? [ +map.getCenter().lng.toFixed(5), +map.getCenter().lat.toFixed(5) ] : null,
        zoom: map.getZoom ? +map.getZoom().toFixed(3) : null,
        bearing: map.getBearing ? +map.getBearing().toFixed(3) : null,
        pitch: map.getPitch ? +map.getPitch().toFixed(3) : null,
      }
    },
  }
  return 'ok'
})()`


const NEUTRALIZE = {
  // Traffic is a SYMBOL layer on a GeoJSON source. Every setData re-tiles the
  // source and re-runs symbol placement, and each finished tile independently
  // calls Map._update() -> triggerRepaint(). Stub the source's setData to
  // measure the wake without it, with everything else untouched.
  cars: `(() => {
    const map = window.__poplurMap || window.__map
    const src = map.getSource('poplur-cars')
    if (!src) return 'no cars source'
    src.setData = function () { return this }
    return 'cars neutralized'
  })()`,
  // Deny the ambient layer any lease at all: the governor's quality ceiling
  // goes to 0, so a front edge grants 0ms and parks immediately.
  ambient: `(() => {
    window.dispatchEvent(new CustomEvent('poplur-memory-pressure', { detail: 'critical' }))
    return 'ambient ceiling 0'
  })()`,
}

async function main() {
  const port = 9800 + Math.floor(Math.random() * 90)
  const profileDir = mkdtempSync(join(tmpdir(), 'poplur-wake-'))
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--use-gl=angle', '--enable-gpu-rasterization', '--window-size=393,852',
    '--js-flags=--expose-gc',
    'about:blank',
  ], { stdio: 'ignore' })
  const cleanup = () => {
    try { chrome.kill() } catch { /* */ }
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* */ }
  }

  try {
    let ws = null
    for (let i = 0; i < 60 && !ws; i++) {
      ws = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json())
        .then(t => t.find(x => x.type === 'page')?.webSocketDebuggerUrl).catch(() => null)
      if (!ws) await sleep(150)
    }
    if (!ws) throw new Error('devtools never came up')
    const sock = new WebSocket(ws)
    await new Promise(r => sock.addEventListener('open', r))
    const pending = new Map()
    let id = 0
    const runtimeErrors = []
    sock.addEventListener('message', ev => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params?.exceptionDetails
        runtimeErrors.push((d?.exception?.description || d?.text || 'unknown').split('\n')[0])
      }
    })
    const send = (method, params = {}) => new Promise(res => {
      const mid = ++id
      pending.set(mid, res)
      sock.send(JSON.stringify({ id: mid, method, params }))
    })
    const evalJs = async (expression, awaitPromise = false) => {
      const { result } = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
      return result?.result?.value
    }
    await send('Page.enable'); await send('Runtime.enable')
    await send('Performance.enable', { timeDomain: 'timeTicks' })
    const metric = (r, n) => r?.result?.metrics?.find(m => m.name === n)?.value ?? 0
    const threadTime = async () => metric(await send('Performance.getMetrics'), 'ThreadTime')

    console.log(`▸ base ${BASE}${PATH_}   load1 ${load1()}`)
    await send('Page.navigate', { url: BASE + PATH_ })

    // ARRIVAL, for comparison against the gate's own number.
    const tNav = await threadTime()
    await sleep(WINDOW_MS)
    const arrivalMs = Math.round((await threadTime() - tNav) * 1000)
    const arrivalRenders = await evalJs('window.__poplurMapRenderCount ?? -1')
    console.log(`  arrival(${WINDOW_MS / 1000}s): ${arrivalMs}ms cpu, ${arrivalRenders} mapbox frames`)

    if (process.argv.includes('--touch-census')) {
      // The ONLY clean way to price the traffic layer: a map that has already
      // parked, so the basemap is fully resident and the camera is static —
      // every tile load in the window then belongs to the cars source, not to
      // the arrival still streaming terrain. Then wake ambient with a real
      // touch and PHASE-LOCK on traffic actually running before the window
      // opens, so a starved box measures the same phase as a quiet one instead
      // of reporting zeros as an improvement.
      const parkDeadline = Date.now() + 180_000
      let didPark = false
      while (Date.now() < parkDeadline) {
        didPark = await evalJs(`document.documentElement.dataset.poplurMapPark === '1'`)
        if (didPark) break
        await sleep(1000)
      }
      if (!didPark) { console.log(JSON.stringify({ error: 'never parked' })); return }
      await sleep(2000)
      await evalJs(INSTRUMENT)
      // Wake ambient WITHOUT touching the map. A tap is the obvious way and it
      // is wrong: at 393px wide the HUD's zoom rail is under much of the lower half of
      // the canvas, so a synthetic tap zoomed the camera in one arm (measured
      // z15.07 against z17.6) and started the idle orbit in another, leaving
      // the two arms comparing different cameras. The governor's gesture
      // listener also takes `keydown`, and an ordinary character key moves
      // nothing — Mapbox's keyboard handler only acts on arrows, +/- and Esc.
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
      })
      await sleep(60)
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'a', code: 'KeyA', text: 'a', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
      })
      // Wait for traffic to be demonstrably running before opening the window.
      const armDeadline = Date.now() + 150_000
      let armed = false
      while (Date.now() < armDeadline) {
        armed = await evalJs('window.__wakeProbe.counters.setData >= 2')
        if (armed) break
        await sleep(500)
      }
      // Arming costs real time — every poll is a CDP round trip, and on a busy
      // box it can eat most of the 15s ambient lease the wake bought, which is
      // why the first camera-stable attempt measured a flat zero for both arms.
      // Refresh the lease immediately before the window opens, then keep the
      // window comfortably inside it.
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
      })
      await sleep(60)
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'a', code: 'KeyA', text: 'a', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
      })
      await evalJs('window.__wakeProbe.zero()')
      const camBefore = await evalJs('JSON.stringify(window.__wakeProbe.read())').then(JSON.parse)
      const t0 = await threadTime()
      await sleep(10_000)
      const cpu = Math.round((await threadTime() - t0) * 1000)
      const r = await evalJs('JSON.stringify(window.__wakeProbe.read())').then(JSON.parse)
      const c = r.counters
      // FUNCTIONAL assertion, not a timing one: capping the source's maxzoom
      // must not stop the cars being drawn. Over-zoomed tiles plus
      // `symbol-z-elevate` is the combination worth proving, and a count of
      // rendered car symbols answers it at any host load.
      const carsRendered = await evalJs(`(() => {
        const m = window.__poplurMap || window.__map
        try { return m.queryRenderedFeatures(undefined, { layers: ['poplur-road-cars'] }).length }
        catch (e) { return 'error: ' + e.message }
      })()`)
      const cameraStable = JSON.stringify([camBefore.center, camBefore.zoom, camBefore.bearing, camBefore.pitch])
        === JSON.stringify([r.center, r.zoom, r.bearing, r.pitch])
      const out = {
        armed, cameraStable, carsRendered, cpu,
        ambientAsleepAtWindowStart: camBefore.ambientAsleep, setData: c.setData, tileLoads: c.tileLoads,
        tilesPerSetData: c.setData ? +(c.tileLoads / c.setData).toFixed(1) : null,
        triggerRepaint: c.triggerRepaint, renders: c.renders,
        moveend: c.moveend, setFilter: c.setFilter, jpeg: c.toDataURL,
        zoom: r.zoom, load1: load1(),
      }
      console.log(JSON.stringify(out))
      if (OUT) writeFileSync(OUT, JSON.stringify(out))
      return
    }

    if (process.argv.includes('--arrival-census')) {
      // The showcase runs in full on an ARRIVAL, so this is the cheap way to
      // A/B the decoration layer itself: install the census as soon as the map
      // object exists, then watch one 30s arrival. ~45s per sample instead of
      // waiting out a park/wake cycle.
      for (let i = 0; i < 60; i++) {
        if (await evalJs('!!(window.__poplurMap || window.__map)')) break
        await sleep(500)
      }
      const ok = await evalJs(INSTRUMENT)
      const t0 = await threadTime()
      await sleep(30_000)
      const cpu = Math.round((await threadTime() - t0) * 1000)
      const r = await evalJs('JSON.stringify(window.__wakeProbe.read())').then(JSON.parse)
      const c = r.counters
      const out = {
        instrument: ok, cpu,
        setData: c.setData, tileLoads: c.tileLoads, sourcedata: c.sourcedata,
        triggerRepaint: c.triggerRepaint, renders: c.renders, moveend: c.moveend,
        qRF: c.queryRenderedFeatures, jpeg: c.toDataURL, jpegMs: Math.round(c.toDataURLms),
        setFilter: c.setFilter ?? null, load1: load1(),
      }
      console.log(JSON.stringify(out))
      if (OUT) writeFileSync(OUT, JSON.stringify(out))
      return
    }

    if (process.argv.includes('--arrival-only')) {
      // Attribution mode: just the 30s arrival census, for pairing one build
      // against another under whatever contention the workbench happens to
      // have. Interleaving the arms is the only way to compare on this box.
      const o = { arrivalMs, arrivalRenders, errors: runtimeErrors.length, firstError: runtimeErrors[0] || null, load1: load1() }
      console.log(JSON.stringify(o))
      if (OUT) writeFileSync(OUT, JSON.stringify(o))
      return
    }

    // Settle until the map declares its own park.
    const deadline = Date.now() + 150_000
    let parked = false
    while (Date.now() < deadline) {
      parked = await evalJs(`document.documentElement.dataset.poplurMapPark === '1'`)
      if (parked) break
      await sleep(1000)
    }
    if (!parked) throw new Error('map never parked — cannot measure a wake')
    await sleep(3000)
    console.log(`  parked at +${Math.round((Date.now() - (deadline - 150_000)) / 1000)}s after arrival window`)

    console.log(`  instrument: ${await evalJs(INSTRUMENT)}`)

    const mode = arg('neutralize', '')
    if (mode) console.log(`  neutralize ${mode}: ${await evalJs(NEUTRALIZE[mode] || `'unknown mode'`)}`)

    // Park it the way the shell does: the home tab leaving posts front:false.
    await evalJs(`window.postMessage({ type: 'poplur-map-front', front: false }, '*'); 'sent'`)
    await sleep(4000)
    const before = await evalJs('JSON.stringify(window.__wakeProbe.read())').then(JSON.parse)
    console.log(`  pre-wake: park=${before.park} surfaceFront=${before.surfaceFront} static=${before.staticFrame} renders=${before.mapRenderCount}`)

    // ── THE WAKE ─────────────────────────────────────────────────────────────
    await evalJs('window.__wakeProbe.zero()')
    await send('Profiler.enable')
    await send('Profiler.setSamplingInterval', { interval: 200 })
    await send('Profiler.start')
    const tWake = await threadTime()
    await evalJs(`window.postMessage({ type: 'poplur-map-front', front: true }, '*'); 'sent'`)
    // A cheap return is only correct if the LIVE canvas is actually revealed.
    // Sample the static-frame state early: `hidden` means WebGL repainted and
    // the retained still was swapped out; `visible` at +1.5s would mean the
    // user is looking at a stretched JPEG instead of the map.
    await sleep(250)
    const at250ms = await evalJs('JSON.stringify(window.__wakeProbe.read())').then(JSON.parse)
    await sleep(1250)
    const at1_5s = await evalJs('JSON.stringify(window.__wakeProbe.read())').then(JSON.parse)
    await sleep(3500)
    const at5s = await evalJs('JSON.stringify(window.__wakeProbe.read())').then(JSON.parse)
    await sleep(WINDOW_MS - 5000)
    const wakeMs = Math.round((await threadTime() - tWake) * 1000)
    const prof = await send('Profiler.stop')
    const after = await evalJs('JSON.stringify(window.__wakeProbe.read())').then(JSON.parse)

    // ── Self-time attribution ────────────────────────────────────────────────
    const profile = prof?.result?.profile
    const byFn = new Map()
    let totalSamples = 0
    if (profile) {
      const nodes = new Map(profile.nodes.map(n => [n.id, n]))
      const parentOf = new Map()
      profile.nodes.forEach(n => (n.children || []).forEach(ch => parentOf.set(ch, n.id)))
      const label = n => {
        const f = n.callFrame
        const url = (f.url || '').split('/').pop() || ''
        return `${f.functionName || '(anonymous)'} @ ${url}:${f.lineNumber + 1}`
      }
      const chainOf = nid => {
        const out = []
        let cur = nid
        for (let i = 0; i < 12 && cur != null; i++) {
          const n = nodes.get(cur)
          if (!n) break
          out.push(label(n))
          cur = parentOf.get(cur)
        }
        return out
      }
      const counts = new Map()
      profile.samples.forEach(s => { counts.set(s, (counts.get(s) || 0) + 1); totalSamples++ })
      for (const [nid, n] of counts) {
        const node = nodes.get(nid)
        if (!node) continue
        const key = label(node)
        const prev = byFn.get(key) || { samples: 0, chain: chainOf(parentOf.get(nid)) }
        prev.samples += n
        byFn.set(key, prev)
      }
    }
    const durMs = profile ? (profile.endTime - profile.startTime) / 1000 : 0
    const msPer = totalSamples ? durMs / totalSamples : 0
    const top = [...byFn.entries()].sort((a, b) => b[1].samples - a[1].samples).slice(0, 25)

    const report = {
      base: BASE, path: PATH_, neutralize: mode || null, load1: load1(), windowMs: WINDOW_MS,
      arrivalMs, arrivalRenders,
      wakeMs,
      wakeRenders: (after.mapRenderCount ?? 0) - (before.mapRenderCount ?? 0),
      before, at250ms, at1_5s, at5s, after,
      earlyRenders: (at1_5s.mapRenderCount ?? 0) - (before.mapRenderCount ?? 0),
      rendersTo5s: (at5s.mapRenderCount ?? 0) - (before.mapRenderCount ?? 0),
      cameraMoved: JSON.stringify(before.center) !== JSON.stringify(after.center)
        || before.zoom !== after.zoom || before.bearing !== after.bearing || before.pitch !== after.pitch,
      counters: after.counters,
      repaintCallers: after.repaintCallers,
      top: top.map(([fn, v]) => ({ fn, ms: Math.round(v.samples * msPer), pct: +(100 * v.samples / (totalSamples || 1)).toFixed(1), via: v.chain.slice(0, 4) })),
      profileSelfMs: Math.round(totalSamples * msPer),
    }
    console.log('\n=== WAKE REPORT ===')
    console.log(`cpu ${wakeMs}ms over ${WINDOW_MS / 1000}s | mapbox frames ${report.wakeRenders} | camera moved: ${report.cameraMoved}`)
    console.log(`camera before ${JSON.stringify([before.center, before.zoom, before.bearing, before.pitch])}`)
    console.log(`camera after  ${JSON.stringify([after.center, after.zoom, after.bearing, after.pitch])}`)
    console.log(`frames: +1.5s ${report.earlyRenders} | +5s ${report.rendersTo5s} | +30s ${report.wakeRenders}`)
    console.log(`static frame: pre=${before.staticFrame} +250ms=${at250ms.staticFrame} +1.5s=${at1_5s.staticFrame} +5s=${at5s.staticFrame} +30s=${after.staticFrame}`)
    console.log(`park flag:    pre=${before.park} +250ms=${at250ms.park} +1.5s=${at1_5s.park} +5s=${at5s.park} +30s=${after.park}`)
    console.log('\n-- mapbox-level work during the wake --')
    Object.entries(after.counters).filter(([, v]) => v).sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => console.log(`   ${String(k).padEnd(22)} ${typeof v === 'number' ? Math.round(v) : v}`))
    console.log('\n-- who called triggerRepaint --')
    Object.entries(after.repaintCallers).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .forEach(([k, v]) => console.log(`   ${String(v).padStart(5)}  ${k}`))
    console.log(`\n-- JS self time (${report.profileSelfMs}ms sampled) --`)
    report.top.forEach(t => console.log(`   ${String(t.ms).padStart(6)}ms ${String(t.pct).padStart(5)}%  ${t.fn}\n              via ${t.via.join(' < ')}`))
    // ── the other half of the contract ───────────────────────────────────────
    // A cheap return is only acceptable if a real touch still brings the world
    // back. The governor wakes ambient from a document-level capture listener
    // on pointerdown, so this exercises the exact path a finger takes.
    await evalJs(`window.__wakeProbe.zero(); 'zeroed'`)
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: 196, y: 500, button: 'left', clickCount: 1, buttons: 1,
    })
    await sleep(120)
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: 196, y: 500, button: 'left', clickCount: 1, buttons: 0,
    })
    await sleep(6000)
    const touched = await evalJs('JSON.stringify(window.__wakeProbe.read())').then(JSON.parse)
    report.afterTouch = {
      ambientAsleep: touched.ambientAsleep, park: touched.park,
      staticFrame: touched.staticFrame,
      renders: (touched.mapRenderCount ?? 0) - (after.mapRenderCount ?? 0),
      setData: touched.counters.setData, triggerRepaint: touched.counters.triggerRepaint,
      tileLoads: touched.counters.tileLoads, sourcedata: touched.counters.sourcedata,
      qRF: touched.counters.queryRenderedFeatures, toDataURL: touched.counters.toDataURL,
      moveend: touched.counters.moveend, setFilterUpdates: touched.counters.setBearing,
    }
    console.log(`\n-- after a touch (6s) --`)
    console.log(`   ambientAsleep=${touched.ambientAsleep} park=${touched.park} static=${touched.staticFrame}`)
    console.log(`   renders ${report.afterTouch.renders} | setData ${report.afterTouch.setData} | repaints ${report.afterTouch.triggerRepaint} | tileLoads ${report.afterTouch.tileLoads} | moveend ${report.afterTouch.moveend} | jpeg ${report.afterTouch.toDataURL}`)

    if (OUT) { writeFileSync(OUT, JSON.stringify(report, null, 2)); console.log(`\nwrote ${OUT}`) }
  } finally {
    cleanup()
  }
}
main().catch(e => { console.error('probe failed:', e.message); process.exit(1) })
