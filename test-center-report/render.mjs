#!/usr/bin/env node
// Poplur Test Center Daily — renderer.
//
//   node render.mjs <data.json> [--out FILE]
//
// Reads one JSON document that conforms to the schemaVersion 1 contract (see
// fixture.json for a complete example) and writes the daily report as a single
// self-contained HTML page. Pure: no network, no other inputs. By default the
// page is written next to the JSON as <date>.html and again as latest.html in
// the same directory; --out FILE writes only FILE. Every written path is
// printed, one per line.
//
// The JSON is data, never markup: every string it carries is HTML-escaped on
// the way out. Anything that is not exactly the contract is refused with a
// list of the problems (exit 2) rather than rendered half-right.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

// ───────────────────────────── contract ─────────────────────────────
const TOP_LEVEL = ['schemaVersion', 'date', 'generatedAt', 'generatedAtLocal', 'project', 'tiles', 'answer', 'services', 'runner', 'simulation', 'postsByClass', 'accounts', 'engagementByClass', 'radiusMoves', 'analytics', 'feedback', 'signals', 'gaps', 'numbers', 'previous', 'proposals']
const TILE_KEYS = ['human_testers', 'human_posts', 'feedback_received', 'analytics_events', 'pops_moved_24h', 'synthetic_events_24h']
const SERVICE_STATES = ['up', 'down', 'error', 'not loaded', 'unknown']
const SIGNAL_STATUSES = ['fixed', 'open', 'undetermined', 'mitigated', 'info']
const ACCOUNT_CLASSES = ['owner', 'synthetic', 'human']
const CAUSES = ['engagement', 'decay', 'boost', 'synthetic', 'lab', 'create', 'backfill']
const POST_CLASSES = ['official', 'cohort', 'lab', 'human', 'total']

export function validate(d) {
  const problems = []
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  const isNum = v => typeof v === 'number' && Number.isFinite(v)
  const fail = (path, what) => problems.push(`${path}: ${what}`)
  const str = (v, path) => { if (typeof v !== 'string') fail(path, 'expected a string') }
  const num = (v, path) => { if (!isNum(v)) fail(path, 'expected a finite number') }
  const bool = (v, path) => { if (typeof v !== 'boolean') fail(path, 'expected true or false') }
  const one = (v, path, list) => { if (!list.includes(v)) fail(path, `expected one of ${list.map(x => JSON.stringify(x)).join(' | ')}, got ${JSON.stringify(v)}`) }
  const nullable = (fn) => (v, path) => { if (v !== null) fn(v, path) }
  const obj = (v, path, keys, body) => {
    if (!isObj(v)) { fail(path, 'expected an object'); return }
    for (const k of Object.keys(v)) if (!keys.includes(k)) fail(`${path}.${k}`, 'not in the contract')
    for (const k of keys) if (!(k in v)) fail(`${path}.${k}`, 'missing')
    if (body && keys.every(k => k in v)) body(v)
  }
  const arr = (v, path, each) => {
    if (!Array.isArray(v)) { fail(path, 'expected an array'); return }
    v.forEach((x, i) => each(x, `${path}[${i}]`))
  }
  const strArr = (v, path) => arr(v, path, str)
  const numOrStr = (v, path) => { if (!isNum(v) && typeof v !== 'string') fail(path, 'expected a number or a string') }

  obj(d, '$', TOP_LEVEL, (d) => {
    if (d.schemaVersion !== 1) fail('$.schemaVersion', `expected 1, got ${JSON.stringify(d.schemaVersion)}`)
    str(d.date, '$.date')
    if (typeof d.date === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) fail('$.date', 'expected YYYY-MM-DD')
    str(d.generatedAt, '$.generatedAt')
    if (typeof d.generatedAt === 'string' && Number.isNaN(Date.parse(d.generatedAt))) fail('$.generatedAt', 'expected an ISO timestamp')
    str(d.generatedAtLocal, '$.generatedAtLocal')
    str(d.project, '$.project')

    arr(d.tiles, '$.tiles', (t, p) => obj(t, p, ['key', 'label', 'value', 'note', 'zero'], (t) => {
      one(t.key, `${p}.key`, TILE_KEYS); str(t.label, `${p}.label`); numOrStr(t.value, `${p}.value`); str(t.note, `${p}.note`); bool(t.zero, `${p}.zero`)
    }))
    if (Array.isArray(d.tiles)) {
      const keys = d.tiles.map(t => t && t.key)
      for (const k of TILE_KEYS) if (!keys.includes(k)) fail('$.tiles', `no tile with key "${k}"`)
      if (new Set(keys).size !== keys.length) fail('$.tiles', 'duplicate tile keys')
    }

    str(d.answer, '$.answer')

    arr(d.services, '$.services', (s, p) => obj(s, p, ['name', 'port', 'state', 'detail'], (s) => {
      str(s.name, `${p}.name`); str(s.port, `${p}.port`); one(s.state, `${p}.state`, SERVICE_STATES); str(s.detail, `${p}.detail`)
    }))

    obj(d.runner, '$.runner', ['mode', 'status', 'error', 'startedAtMs', 'actorErrors'], (r) => {
      str(r.mode, '$.runner.mode'); str(r.status, '$.runner.status'); nullable(str)(r.error, '$.runner.error'); nullable(num)(r.startedAtMs, '$.runner.startedAtMs')
      arr(r.actorErrors, '$.runner.actorErrors', (a, p) => obj(a, p, ['actorId', 'error'], (a) => { str(a.actorId, `${p}.actorId`); str(a.error, `${p}.error`) }))
    })

    obj(d.simulation, '$.simulation', ['ranInWindow', 'windowHours', 'eventsInWindow', 'sessionsInWindow', 'postsInWindow', 'newestEventAt', 'actorsSeen'], (s) => {
      bool(s.ranInWindow, '$.simulation.ranInWindow'); num(s.windowHours, '$.simulation.windowHours')
      if (s.windowHours !== 24) fail('$.simulation.windowHours', `expected 24, got ${JSON.stringify(s.windowHours)}`)
      num(s.eventsInWindow, '$.simulation.eventsInWindow'); num(s.sessionsInWindow, '$.simulation.sessionsInWindow'); num(s.postsInWindow, '$.simulation.postsInWindow')
      nullable(str)(s.newestEventAt, '$.simulation.newestEventAt'); strArr(s.actorsSeen, '$.simulation.actorsSeen')
    })

    obj(d.postsByClass, '$.postsByClass', POST_CLASSES, (c) => { for (const k of POST_CLASSES) num(c[k], `$.postsByClass.${k}`) })

    arr(d.accounts, '$.accounts', (a, p) => obj(a, p, ['label', 'what', 'posts', 'class'], (a) => {
      str(a.label, `${p}.label`); str(a.what, `${p}.what`); num(a.posts, `${p}.posts`); one(a.class, `${p}.class`, ACCOUNT_CLASSES)
    }))

    arr(d.engagementByClass, '$.engagementByClass', (e, p) => obj(e, p, ['cls', 'posts', 'views', 'likes', 'comments', 'origin'], (e) => {
      str(e.cls, `${p}.cls`); num(e.posts, `${p}.posts`); num(e.views, `${p}.views`); num(e.likes, `${p}.likes`); num(e.comments, `${p}.comments`); str(e.origin, `${p}.origin`)
    }))

    obj(d.radiusMoves, '$.radiusMoves', ['windowHours', 'entriesInWindow', 'postsWithHistory', 'totalEntries', 'top', 'byCause'], (r) => {
      num(r.windowHours, '$.radiusMoves.windowHours')
      if (r.windowHours !== 24) fail('$.radiusMoves.windowHours', `expected 24, got ${JSON.stringify(r.windowHours)}`)
      num(r.entriesInWindow, '$.radiusMoves.entriesInWindow'); num(r.postsWithHistory, '$.radiusMoves.postsWithHistory'); num(r.totalEntries, '$.radiusMoves.totalEntries')
      arr(r.top, '$.radiusMoves.top', (m, p) => obj(m, p, ['postId', 'owner', 'cls', 'fromMeters', 'toMeters', 'deltaMeters', 'causes'], (m) => {
        str(m.postId, `${p}.postId`); str(m.owner, `${p}.owner`); str(m.cls, `${p}.cls`); num(m.fromMeters, `${p}.fromMeters`); num(m.toMeters, `${p}.toMeters`); num(m.deltaMeters, `${p}.deltaMeters`)
        if (!isObj(m.causes)) fail(`${p}.causes`, 'expected an object of cause → count')
        else for (const [k, v] of Object.entries(m.causes)) num(v, `${p}.causes.${k}`)
      }))
      if (Array.isArray(r.top) && r.top.length > 10) fail('$.radiusMoves.top', `at most 10 movers, got ${r.top.length}`)
      obj(r.byCause, '$.radiusMoves.byCause', CAUSES, (c) => { for (const k of CAUSES) num(c[k], `$.radiusMoves.byCause.${k}`) })
    })

    obj(d.analytics, '$.analytics', ['projectLinked', 'propertyId', 'streams', 'clientsShipped', 'eventsEverSent', 'note'], (a) => {
      bool(a.projectLinked, '$.analytics.projectLinked'); nullable(str)(a.propertyId, '$.analytics.propertyId'); num(a.streams, '$.analytics.streams'); strArr(a.clientsShipped, '$.analytics.clientsShipped')
      if (a.eventsEverSent !== 'unknown' && !isNum(a.eventsEverSent)) fail('$.analytics.eventsEverSent', 'expected "unknown" or a number')
      str(a.note, '$.analytics.note')
    })

    arr(d.feedback, '$.feedback', (f, p) => obj(f, p, ['channel', 'exists', 'received', 'notes'], (f) => {
      str(f.channel, `${p}.channel`); str(f.exists, `${p}.exists`); numOrStr(f.received, `${p}.received`); str(f.notes, `${p}.notes`)
    }))

    arr(d.signals, '$.signals', (s, p) => obj(s, p, ['title', 'status', 'body', 'evidence'], (s) => {
      str(s.title, `${p}.title`); one(s.status, `${p}.status`, SIGNAL_STATUSES); str(s.body, `${p}.body`); str(s.evidence, `${p}.evidence`)
    }))

    strArr(d.gaps, '$.gaps')

    arr(d.numbers, '$.numbers', (n, p) => obj(n, p, ['label', 'value', 'query'], (n) => { str(n.label, `${p}.label`); str(n.value, `${p}.value`); str(n.query, `${p}.query`) }))

    obj(d.previous, '$.previous', ['date', 'diffs'], (pv) => {
      nullable(str)(pv.date, '$.previous.date')
      if (typeof pv.date === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(pv.date)) fail('$.previous.date', 'expected YYYY-MM-DD or null')
      arr(pv.diffs, '$.previous.diffs', (x, p) => obj(x, p, ['label', 'before', 'after'], (x) => { str(x.label, `${p}.label`); str(x.before, `${p}.before`); str(x.after, `${p}.after`) }))
    })

    arr(d.proposals, '$.proposals', (x, p) => obj(x, p, ['title', 'why', 'evidence', 'change', 'risk'], (x) => {
      for (const k of ['title', 'why', 'evidence', 'change', 'risk']) str(x[k], `${p}.${k}`)
    }))
  })
  return problems
}

// ───────────────────────────── formatting ─────────────────────────────
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmtNum = (n) => typeof n === 'number'
  ? (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 2 }))
  : String(n)
const fmtMeters = (m) => Math.abs(m) >= 10_000 ? `${fmtNum(Math.round(m / 100) / 10)} km` : `${fmtNum(Math.round(m))} m`
const fmtDelta = (m) => (m === 0 ? '±0 m' : (m > 0 ? '+' : '−') + fmtMeters(Math.abs(m)))
const fmtWhen = (iso) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }).format(d)
}
const fmtDate = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(dt)
}
const chip = (cls, text) => `<span class="chip ${cls}">${esc(text)}</span>`
const serviceChip = (state) => chip({ up: 'good', down: 'down', error: 'warn', 'not loaded': 'down', unknown: 'muted' }[state], state)
const signalChip = (status) => chip({ fixed: 'good', mitigated: 'good', open: 'down', undetermined: 'warn', info: 'muted' }[status], status)
const accountChip = (cls) => chip(cls === 'synthetic' ? 'synthetic' : 'human', cls)
const classTone = (cls) => {
  const c = String(cls).toLowerCase()
  if (/human|person/.test(c)) return 'var(--accent)'
  if (/synthetic|cohort|lab|runner|sim/.test(c)) return 'var(--synthetic)'
  return 'var(--muted)'
}
const plural = (n, one, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`

// ───────────────────────────── pieces ─────────────────────────────
function tiles(d) {
  return `<div class="strip" aria-label="What the desk can count today">${d.tiles.map(t =>
    `<div class="tile${t.zero ? ' zero' : ''}"><div class="k">${esc(t.label)}</div><div class="v">${esc(fmtNum(t.value))}</div><div class="s">${esc(t.note)}</div></div>`).join('')}</div>`
}

function changed(d) {
  const pv = d.previous
  if (pv.date === null) return `<p class="empty">First report — nothing to compare.</p>`
  if (pv.diffs.length === 0) return `<p class="empty">Nothing counted differently from ${esc(fmtDate(pv.date))}.</p>`
  return `<div class="tablewrap"><table>
    <thead><tr><th>What</th><th class="n">${esc(fmtDate(pv.date))}</th><th class="n">Today</th></tr></thead>
    <tbody>${pv.diffs.map(x => `<tr><td>${esc(x.label)}</td><td class="n">${esc(x.before)}</td><td class="n"><b>${esc(x.after)}</b></td></tr>`).join('')}</tbody>
  </table></div>`
}

function services(d) {
  const rows = d.services.length
    ? d.services.map(s => `<tr><td>${esc(s.name)}</td><td class="mono">${esc(s.port)}</td><td>${serviceChip(s.state)}</td><td>${esc(s.detail)}</td></tr>`).join('')
    : `<tr><td colspan="4" class="empty">No services were probed.</td></tr>`
  const r = d.runner
  const started = r.startedAtMs === null ? 'not recorded' : fmtWhen(new Date(r.startedAtMs).toISOString())
  const actorRows = r.actorErrors.length
    ? `<div class="tablewrap"><table><thead><tr><th>Actor</th><th>Current error</th></tr></thead><tbody>${r.actorErrors.map(a => `<tr><td class="mono">${esc(a.actorId)}</td><td>${esc(a.error)}</td></tr>`).join('')}</tbody></table></div>`
    : `<p class="empty">No actor reports an error.</p>`
  return `<div class="tablewrap"><table>
    <thead><tr><th>Service</th><th>Port</th><th>State</th><th>Detail</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <h3>Synthetic runner</h3>
  <div class="kv">
    <div><div class="k">Mode</div><div class="v mono">${esc(r.mode)}</div></div>
    <div><div class="k">Status</div><div class="v mono">${esc(r.status)}</div></div>
    <div><div class="k">Run started</div><div class="v small">${esc(started)}</div></div>
  </div>
  ${r.error === null ? `<p>The runner reports no error.</p>` : `<div class="callout crit"><p><b>Runner error:</b> ${esc(r.error)}</p></div>`}
  ${actorRows}`
}

function simulation(d) {
  const s = d.simulation
  const ran = s.ranInWindow ? chip('good', `ran in the last ${s.windowHours} h`) : chip('down', `did not run in the last ${s.windowHours} h`)
  const actors = s.actorsSeen.length ? s.actorsSeen.map(a => chip('synthetic', a)).join(' ') : '<span class="empty">none</span>'
  return `<p>${ran}</p>
  <div class="kv">
    <div><div class="k">Synthetic events, ${esc(s.windowHours)} h</div><div class="v">${esc(fmtNum(s.eventsInWindow))}</div></div>
    <div><div class="k">Sessions</div><div class="v">${esc(fmtNum(s.sessionsInWindow))}</div></div>
    <div><div class="k">Posts made by the runner</div><div class="v">${esc(fmtNum(s.postsInWindow))}</div></div>
    <div><div class="k">Newest event</div><div class="v small">${s.newestEventAt === null ? 'none' : esc(fmtWhen(s.newestEventAt))}</div></div>
  </div>
  <p>Actors seen ${chip('synthetic', 'synthetic')}: ${actors}</p>`
}

function postsChart(d) {
  const c = d.postsByClass
  const rows = [
    { label: 'Official seed content', n: c.official, fill: 'var(--muted)', opacity: '0.55' },
    { label: 'Synthetic cohort', n: c.cohort, fill: 'var(--synthetic)', opacity: '1' },
    { label: 'Radius Lab pins', n: c.lab, fill: 'var(--synthetic)', opacity: '0.6' },
    { label: 'A person', n: c.human, fill: 'var(--accent)', opacity: '1' },
  ]
  const X0 = 190, W = 420, max = Math.max(0, ...rows.map(r => r.n))
  const width = n => (max > 0 && n > 0 ? Math.max(2, Math.round(n / max * W)) : 0)
  const labels = rows.map((r, i) => `<text x="0" y="${26 + i * 36}">${esc(r.label)}</text>`).join('')
  const bars = rows.map((r, i) => `<rect x="${X0}" y="${12 + i * 36}" width="${width(r.n)}" height="20" rx="6" fill="${r.fill}" fill-opacity="${r.opacity}"/>`).join('')
  const values = rows.map((r, i) => {
    const w = width(r.n), y = 27 + i * 36
    return w >= 60
      ? `<text x="${X0 + w - 8}" y="${y}" text-anchor="end" fill="#fff">${esc(fmtNum(r.n))}</text>`
      : `<text x="${X0 + w + 8}" y="${y}">${esc(fmtNum(r.n))}</text>`
  }).join('')
  const mid = Math.round(max / 2)
  const aria = `Posts by class: ${rows.map(r => `${fmtNum(r.n)} ${r.label.toLowerCase()}`).join(', ')}; ${fmtNum(c.total)} in total`
  return `<div class="chart" role="img" aria-label="${esc(aria)}">
    <svg viewBox="0 0 640 176" xmlns="http://www.w3.org/2000/svg">
      <g font-family="IBM Plex Sans, system-ui, sans-serif" font-size="13" fill="var(--ink-2)">${labels}</g>
      <g>${bars}</g>
      <g font-family="Nunito, system-ui, sans-serif" font-weight="800" font-size="13" fill="var(--ink)">${values}</g>
      <g stroke="var(--rule)" stroke-width="1"><line x1="${X0}" y1="4" x2="${X0}" y2="150"/></g>
      <g font-family="IBM Plex Sans, system-ui, sans-serif" font-size="11" fill="var(--muted)">
        <text x="${X0}" y="168">0</text>
        <text x="${X0 + W / 2}" y="168" text-anchor="middle">${esc(fmtNum(mid))}</text>
        <text x="${X0 + W}" y="168" text-anchor="end">${esc(fmtNum(max))} posts</text>
      </g>
    </svg>
    <div class="cap">Posts by class, production <code>posts</code> collection, ${esc(d.generatedAtLocal)}. ${esc(fmtNum(c.total))} posts in total; one bar scale.</div>
  </div>`
}

function accounts(d) {
  if (!d.accounts.length) return `<p class="empty">No accounts were listed.</p>`
  return `<div class="tablewrap"><table>
    <thead><tr><th>Account</th><th>What it is</th><th class="n">Posts</th><th>Class</th></tr></thead>
    <tbody>${d.accounts.map(a => `<tr><td class="mono">${esc(a.label)}</td><td>${esc(a.what)}</td><td class="n">${esc(fmtNum(a.posts))}</td><td>${accountChip(a.class)}</td></tr>`).join('')}</tbody>
  </table></div>`
}

function engagement(d) {
  if (!d.engagementByClass.length) return `<p class="empty">No engagement counters were summed.</p>`
  return `<div class="tablewrap"><table>
    <thead><tr><th>Post class</th><th class="n">Posts</th><th class="n">Views</th><th class="n">Likes</th><th class="n">Comments</th><th>Where the numbers come from</th></tr></thead>
    <tbody>${d.engagementByClass.map(e => `<tr><td>${esc(e.cls)}</td><td class="n">${esc(fmtNum(e.posts))}</td><td class="n">${esc(fmtNum(e.views))}</td><td class="n">${esc(fmtNum(e.likes))}</td><td class="n">${esc(fmtNum(e.comments))}</td><td>${esc(e.origin)}</td></tr>`).join('')}</tbody>
  </table></div>`
}

function radius(d) {
  const r = d.radiusMoves
  const maxAbs = Math.max(0, ...r.top.map(m => Math.abs(m.deltaMeters)))
  const causeRow = `<div class="tablewrap"><table class="causes">
    <thead><tr>${CAUSES.map(c => `<th class="n">${esc(c)}</th>`).join('')}</tr></thead>
    <tbody><tr>${CAUSES.map(c => `<td class="n${r.byCause[c] === 0 ? ' dim' : ''}">${esc(fmtNum(r.byCause[c]))}</td>`).join('')}</tr></tbody>
  </table></div>`
  const top = r.top.length
    ? `<div class="tablewrap"><table>
    <thead><tr><th>Pop</th><th>Owner</th><th>Class</th><th class="n">From</th><th class="n">To</th><th class="n">Δ</th><th>|Δ| to scale</th><th>Causes</th></tr></thead>
    <tbody>${r.top.map(m => {
      const pct = maxAbs > 0 ? Math.max(1, Math.round(Math.abs(m.deltaMeters) / maxAbs * 100)) : 0
      const causes = Object.entries(m.causes).map(([k, v]) => `${esc(k)}&nbsp;×${esc(fmtNum(v))}`).join(', ') || '<span class="empty">none recorded</span>'
      return `<tr><td class="mono">${esc(m.postId)}</td><td class="mono">${esc(m.owner)}</td><td>${esc(m.cls)}</td><td class="n">${esc(fmtMeters(m.fromMeters))}</td><td class="n">${esc(fmtMeters(m.toMeters))}</td><td class="n${m.deltaMeters < 0 ? ' neg' : ''}">${esc(fmtDelta(m.deltaMeters))}</td><td class="barcell"><span class="bar" style="width:${pct}%;background:${classTone(m.cls)}" aria-label="${esc(fmtMeters(Math.abs(m.deltaMeters)))}"></span></td><td class="mono small">${causes}</td></tr>`
    }).join('')}</tbody>
  </table></div>`
    : `<p class="empty">No pop moved in the last ${esc(r.windowHours)} h.</p>`
  return `<p><b>${esc(plural(r.entriesInWindow, 'radiusHistory entry', 'radiusHistory entries'))}</b> in the last ${esc(r.windowHours)} h, across <b>${esc(plural(r.postsWithHistory, 'post'))}</b> that carry a history; ${esc(fmtNum(r.totalEntries))} entries all time.</p>
  <h3>Entries in the window, by cause</h3>${causeRow}
  <h3>Biggest movers</h3>${top}`
}

function analytics(d) {
  const a = d.analytics
  const linked = a.projectLinked ? chip('good', 'project linked') : chip('down', 'project not linked')
  const shipped = a.clientsShipped.length ? a.clientsShipped.map(c => chip('good', c)).join(' ') : chip('unknown', 'delivery unverified')
  return `<p>${linked} ${a.propertyId === null ? '' : `property <code>${esc(a.propertyId)}</code>, `}${esc(plural(a.streams, 'data stream'))}. Clients shipping it: ${shipped}.</p>
  <div class="kv">
    <div><div class="k">Events ever sent</div><div class="v${a.eventsEverSent === 0 ? ' crit' : ''}">${esc(fmtNum(a.eventsEverSent))}</div></div>
    <div><div class="k">Data streams</div><div class="v">${esc(fmtNum(a.streams))}</div></div>
    <div><div class="k">Clients shipped</div><div class="v${a.clientsShipped.length === 0 ? ' crit' : ''}">${a.clientsShipped.length ? esc(fmtNum(a.clientsShipped.length)) : 'unknown'}</div></div>
  </div>
  <p>${esc(a.note)}</p>`
}

function feedback(d) {
  if (!d.feedback.length) return `<p class="empty">No feedback channels were listed.</p>`
  return `<div class="tablewrap"><table>
    <thead><tr><th>Channel</th><th>Exists?</th><th class="n">Received</th><th>Notes</th></tr></thead>
    <tbody>${d.feedback.map(f => `<tr><td>${esc(f.channel)}</td><td>${esc(f.exists)}</td><td class="n">${esc(fmtNum(f.received))}</td><td>${esc(f.notes)}</td></tr>`).join('')}</tbody>
  </table></div>`
}

function signals(d) {
  if (!d.signals.length) return `<p class="empty">The evidence supports no improvement signal today.</p>`
  return d.signals.map(s => `<div class="signal">
    <h3>${esc(s.title)} ${signalChip(s.status)}</h3>
    <p>${esc(s.body)}</p>
    ${s.evidence ? `<div class="ev">Evidence: <code>${esc(s.evidence)}</code></div>` : ''}
  </div>`).join('')
}

function proposals(d) {
  const gate = `<p class="gate">Nothing here changes anything until it is approved: these are proposals for review, derived from the evidence above, and none of them came from a user.</p>`
  if (!d.proposals.length) return `<div class="await"><div class="k">Awaiting study</div><p>The studying step has not filled this section yet. When it does, each proposal appears here with its reasoning, evidence, the change it asks for, and its risk.</p></div>${gate}`
  return `<ol class="props">${d.proposals.map(p => `<li class="prop">
    <h3>${esc(p.title)}</h3>
    <dl>
      <dt>Why</dt><dd>${esc(p.why)}</dd>
      <dt>Evidence</dt><dd><code>${esc(p.evidence)}</code></dd>
      <dt>Change</dt><dd>${esc(p.change)}</dd>
      <dt>Risk</dt><dd>${esc(p.risk)}</dd>
    </dl>
  </li>`).join('')}</ol>${gate}`
}

function gaps(d) {
  if (!d.gaps.length) return `<p class="empty">No data gap was recorded.</p>`
  return `<ul>${d.gaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul>`
}

function method(d) {
  const rows = d.numbers.length
    ? d.numbers.map(n => `<div class="qrow"><div class="l"><b>${esc(n.label)}</b> = ${esc(n.value)}</div><p class="q">${esc(n.query)}</p></div>`).join('')
    : `<div class="qrow"><div class="l empty">The script recorded no numbers with their queries.</div></div>`
  return `<p>Read-only queries against production Firestore over the REST API with the workstation's application-default credentials, the local runner's state endpoint, port probes, and greps over the runner log. Aggregations use <code>runAggregationQuery</code>; listings are paged. Every number shown above is listed here with the exact query that produced it.</p>
  <details>
    <summary>Every number, with its query (${esc(fmtNum(d.numbers.length))})</summary>
    <div class="in">${rows}</div>
  </details>`
}

// ───────────────────────────── page ─────────────────────────────
const CSS = `
  :root {
    --ground: #FBF7F9;
    --panel: #FFFFFF;
    --ink: #25131F;
    --ink-2: #4E3A46;
    --muted: #8A7A83;
    --rule: #EADDE3;
    --accent: #E23A85;
    --accent-soft: #FBE3EE;
    --synthetic: #1D8FB0;
    --synthetic-soft: #DDF1F7;
    --good: #2F9E6F;
    --warn: #C98416;
    --crit: #C42E3E;
    --crit-soft: #FBE4E6;
    --shadow: 0 1px 2px rgba(37, 19, 31, 0.06), 0 8px 24px rgba(37, 19, 31, 0.05);
    --display: "Nunito", "SF Pro Rounded", system-ui, sans-serif;
    --body: "IBM Plex Sans", system-ui, -apple-system, sans-serif;
    --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground: #17111A;
      --panel: #1F1721;
      --ink: #F6EEF3;
      --ink-2: #D9C9D2;
      --muted: #A394A0;
      --rule: #3A2C36;
      --accent: #FF6CAD;
      --accent-soft: #3A1F2E;
      --synthetic: #5FC4E3;
      --synthetic-soft: #16303A;
      --good: #4FC08D;
      --warn: #E1A445;
      --crit: #F06A78;
      --crit-soft: #3D1F25;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.3);
    }
  }
  :root[data-theme="dark"] {
    --ground: #17111A;
    --panel: #1F1721;
    --ink: #F6EEF3;
    --ink-2: #D9C9D2;
    --muted: #A394A0;
    --rule: #3A2C36;
    --accent: #FF6CAD;
    --accent-soft: #3A1F2E;
    --synthetic: #5FC4E3;
    --synthetic-soft: #16303A;
    --good: #4FC08D;
    --warn: #E1A445;
    --crit: #F06A78;
    --crit-soft: #3D1F25;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.3);
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font-family: var(--body);
    font-size: 16px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  .page { max-width: 880px; margin: 0 auto; padding: 40px 24px 80px; }
  h1, h2, h3 { font-family: var(--display); font-weight: 900; letter-spacing: -0.01em; text-wrap: balance; margin: 0; }
  h1 { font-size: clamp(30px, 5vw, 44px); line-height: 1.05; }
  h2 { font-size: 22px; line-height: 1.2; margin-top: 56px; margin-bottom: 14px; }
  h3 { font-size: 16px; font-weight: 800; margin-top: 22px; margin-bottom: 6px; }
  p { max-width: 68ch; margin: 0 0 12px; }
  .eyebrow { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; font-family: var(--display); font-weight: 800; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); margin-bottom: 10px; }
  .tag { font-family: var(--display); font-weight: 800; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; padding: 2px 8px; border-radius: 999px; background: var(--synthetic-soft); color: var(--synthetic); }
  .lede { font-size: 18px; color: var(--ink-2); max-width: 62ch; margin-top: 14px; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 18px; color: var(--muted); font-size: 13px; }
  .meta b { color: var(--ink-2); font-weight: 600; }
  code, .mono { font-family: var(--mono); font-size: 0.86em; }
  code { background: var(--accent-soft); color: var(--ink); padding: 1px 5px; border-radius: 4px; }
  a { color: var(--accent); }
  .small { font-size: 13px; }
  .empty { color: var(--muted); font-style: italic; }

  /* The strip: six things the desk can count today. Their zeros are the point. */
  .strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 30px; }
  .tile { background: var(--panel); border: 1px solid var(--rule); border-radius: 14px; padding: 16px 16px 14px; box-shadow: var(--shadow); min-width: 0; }
  .tile .k { font-family: var(--display); font-weight: 800; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
  .tile .v { font-family: var(--display); font-weight: 900; font-size: 40px; line-height: 1; margin-top: 8px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .tile .s { font-size: 12.5px; color: var(--ink-2); margin-top: 8px; line-height: 1.35; }
  .tile.zero .v { color: var(--crit); }
  @media (max-width: 640px) { .strip { grid-template-columns: repeat(2, minmax(0, 1fr)); } .tile .v { font-size: 32px; } }

  .chip { display: inline-block; font-family: var(--display); font-weight: 800; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; padding: 2px 8px; border-radius: 999px; vertical-align: middle; white-space: nowrap; }
  .chip.human { background: var(--accent-soft); color: var(--accent); }
  .chip.synthetic { background: var(--synthetic-soft); color: var(--synthetic); }
  .chip.down { background: var(--crit-soft); color: var(--crit); }
  .chip.good { background: color-mix(in srgb, var(--good) 16%, transparent); color: var(--good); }
  .chip.warn { background: color-mix(in srgb, var(--warn) 16%, transparent); color: var(--warn); }
  .chip.muted { background: color-mix(in srgb, var(--muted) 16%, transparent); color: var(--muted); }

  .callout { border-left: 3px solid var(--accent); padding: 10px 16px; background: var(--panel); border-radius: 0 12px 12px 0; margin: 18px 0; box-shadow: var(--shadow); }
  .callout.crit { border-left-color: var(--crit); }
  .callout p:last-child { margin-bottom: 0; }

  table { width: 100%; border-collapse: collapse; font-size: 14px; margin: 12px 0 6px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--rule); vertical-align: top; }
  th { font-family: var(--display); font-weight: 800; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.dim { color: var(--muted); }
  td.neg { color: var(--crit); }
  .tablewrap { overflow-x: auto; }
  tr.total td { font-weight: 600; border-bottom: 2px solid var(--ink); }
  table.causes td { font-family: var(--display); font-weight: 900; font-size: 20px; }
  td.barcell { width: 150px; min-width: 130px; vertical-align: middle; }
  .bar { display: block; height: 10px; border-radius: 5px; min-width: 2px; }

  .kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin: 12px 0 14px; }
  .kv > div { background: var(--panel); border: 1px solid var(--rule); border-radius: 12px; padding: 10px 12px; min-width: 0; }
  .kv .k { font-family: var(--display); font-weight: 800; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
  .kv .v { font-family: var(--display); font-weight: 900; font-size: 24px; line-height: 1.1; margin-top: 4px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .kv .v.small { font-size: 15px; font-family: var(--body); font-weight: 600; margin-top: 8px; }
  .kv .v.mono { font-size: 15px; font-weight: 500; margin-top: 8px; }
  .kv .v.crit { color: var(--crit); }

  /* Posts by class: one bar chart drawn to one scale. */
  .chart { background: var(--panel); border: 1px solid var(--rule); border-radius: 14px; padding: 18px 18px 10px; box-shadow: var(--shadow); margin: 16px 0; }
  .chart svg { width: 100%; height: auto; display: block; }
  .chart .cap { font-size: 12.5px; color: var(--muted); margin-top: 6px; }

  ul, ol { padding-left: 20px; margin: 6px 0 14px; max-width: 70ch; }
  li { margin-bottom: 7px; }
  li b, p b { font-weight: 600; }

  .signal { background: var(--panel); border: 1px solid var(--rule); border-radius: 14px; padding: 14px 18px; margin: 12px 0; box-shadow: var(--shadow); }
  .signal h3 { margin-top: 0; }
  .signal .ev { font-size: 13px; color: var(--muted); margin-top: 6px; }
  .signal .ev code { background: transparent; padding: 0; color: var(--ink-2); }

  ol.props { padding-left: 0; max-width: none; counter-reset: prop; list-style: none; }
  .prop { background: var(--panel); border: 1px solid var(--rule); border-radius: 14px; padding: 14px 18px 8px; margin: 12px 0; box-shadow: var(--shadow); counter-increment: prop; }
  .prop h3 { margin-top: 0; }
  .prop h3::before { content: counter(prop) ". "; color: var(--accent); }
  .prop dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 14px; margin: 8px 0; font-size: 14px; }
  .prop dt { font-family: var(--display); font-weight: 800; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); padding-top: 3px; }
  .prop dd { margin: 0; }
  .prop dd code { background: transparent; padding: 0; color: var(--ink-2); }
  .await { border: 1px dashed var(--rule); border-radius: 14px; padding: 18px 20px; margin: 12px 0; background: var(--panel); color: var(--muted); }
  .await .k { font-family: var(--display); font-weight: 800; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--warn); }
  .await p { margin: 6px 0 0; }
  .gate { font-size: 13px; color: var(--muted); }

  details { border: 1px solid var(--rule); border-radius: 12px; background: var(--panel); margin: 10px 0; }
  summary { cursor: pointer; padding: 12px 16px; font-family: var(--display); font-weight: 800; }
  summary::-webkit-details-marker { color: var(--accent); }
  details .in { padding: 0 16px 14px; }
  .q { font-family: var(--mono); font-size: 12px; color: var(--ink-2); white-space: pre-wrap; word-break: break-word; margin: 0; }
  .qrow { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; padding: 10px 0; border-bottom: 1px solid var(--rule); }
  .qrow:last-child { border-bottom: 0; }
  .qrow .l { font-size: 13.5px; }
  .qrow .l b { font-family: var(--display); font-weight: 800; }
  .foot { margin-top: 56px; padding-top: 18px; border-top: 1px solid var(--rule); color: var(--muted); font-size: 13px; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`

export function render(d) {
  const problems = validate(d)
  if (problems.length) throw new Error(`data does not match the contract:\n  ${problems.join('\n  ')}`)
  const since = d.previous.date === null ? 'the previous report' : fmtDate(d.previous.date)
  let n = 0
  const section = (title) => `<h2>${++n}. ${title}</h2>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Poplur Test Center Daily</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nunito:wght@700;800;900&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>${CSS}</style>
</head>
<body>
<div class="page">
  <div class="eyebrow"><span>Beta Control Room · ${esc(d.generatedAtLocal)}</span><span class="tag">Daily · from the test simulation</span></div>
  <h1>Poplur Test Center Daily</h1>
  <p class="lede">${esc(d.answer)}</p>
  <div class="meta">
    <span>Project <b>${esc(d.project)}</b></span>
    <span>Source <b>production Firestore, read-only</b></span>
    <span>Report date <b>${esc(fmtDate(d.date))}</b></span>
    <span>Generated <b><time datetime="${esc(d.generatedAt)}">${esc(d.generatedAtLocal)}</time></b></span>
  </div>

  ${tiles(d)}
  <div class="callout"><p><b>Nothing in this report quotes a tester.</b> Synthetic, owner-controlled and human activity are labelled as such everywhere, and every number on this page is paired with the query that produced it in the Method section at the end.</p></div>

  ${section(`What changed since ${esc(since)}`)}
  ${changed(d)}

  ${section('Test Center state')}
  ${services(d)}

  ${section('Did the simulation run?')}
  ${simulation(d)}

  ${section('How the app is being used: human versus synthetic')}
  <p>Production holds ${esc(fmtNum(d.postsByClass.total))} posts. Four classes, ${d.postsByClass.human === 1 ? 'one of them a person' : `${esc(fmtNum(d.postsByClass.human))} of them from people`}.</p>
  ${postsChart(d)}
  <h3>Accounts ${chip('human', 'human')} ${chip('synthetic', 'synthetic')}</h3>
  ${accounts(d)}
  <h3>Engagement counters, and where they come from</h3>
  ${engagement(d)}

  ${section('How pops moved')}
  ${radius(d)}

  ${section('Firebase Analytics')}
  ${analytics(d)}

  ${section('Feedback: what channels exist, and what has arrived')}
  ${feedback(d)}

  ${section('Improvement signals the evidence supports')}
  <p>The closest things to "how the app could be improved" that exist. Each comes from a machine or a developer, and says so.</p>
  ${signals(d)}

  ${section('Proposed improvements — for review')}
  ${proposals(d)}

  ${section('Data gaps, stated plainly')}
  ${gaps(d)}

  ${section('Method')}
  ${method(d)}

  <div class="foot">Prepared from the Beta Control Room's own sources, ${esc(d.generatedAtLocal)}. Synthetic and owner-controlled data are labelled as such throughout; no figure here should be read as a real person's behaviour.</div>
</div>
</body>
</html>
`
}

// ───────────────────────────── cli ─────────────────────────────
function main(argv) {
  const args = argv.slice(2)
  const outIx = args.indexOf('--out')
  const outArg = outIx >= 0 ? args[outIx + 1] : null
  const positional = args.filter((a, i) => a !== '--out' && (outIx < 0 || i !== outIx + 1))
  if (positional.length !== 1 || (outIx >= 0 && !outArg)) {
    process.stderr.write('usage: node render.mjs <data.json> [--out FILE]\n')
    process.exit(1)
  }
  const inPath = resolve(positional[0])
  let data
  try { data = JSON.parse(readFileSync(inPath, 'utf8')) } catch (e) { process.stderr.write(`cannot read ${inPath}: ${e.message}\n`); process.exit(1) }
  const problems = validate(data)
  if (problems.length) {
    process.stderr.write(`${inPath} does not match the schemaVersion 1 contract (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n`)
    for (const p of problems) process.stderr.write(`  - ${p}\n`)
    process.exit(2)
  }
  const html = render(data)
  const targets = outArg ? [resolve(outArg)] : [join(dirname(inPath), `${data.date}.html`), join(dirname(inPath), 'latest.html')]
  for (const t of targets) {
    mkdirSync(dirname(t), { recursive: true })
    writeFileSync(t, html)
    process.stdout.write(`${t}\n`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) main(process.argv)
