#!/usr/bin/env node
// Poplur Test Center report — the GATHERER.
//
//   node gather.mjs [--date YYYY-MM-DD] [--out DIR]
//
// Writes <DIR>/<date>.json in the report contract (schemaVersion 1) and prints
// one summary line. Read-only everywhere: production Firestore over the REST
// API with the workstation's application-default token (aggregation queries for
// counts, paged runQuery/list for listings — never a count from one unpaged
// page), the local runner's /state, curl status codes on the Test Center ports,
// and grep -c over the runner log. It never writes to Firestore, never starts a
// server, never opens a browser, and never prints the local runner token.
//
// Honesty rules carried from the hand-made 4 Sep 2026 report: every count is
// labelled synthetic / owner / human; no opinion is invented; every number that
// appears in the output also appears in numbers[] with the exact query that
// produced it. `proposals` is always empty here — the studying step fills it.
//
// --date only relabels the report and its file name; the 24 h window is always
// anchored at the moment the script runs (the summary line says so).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const PROJECT = 'poplur2025';
const FS_DOCS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const ANALYTICS_URL = `https://firebase.googleapis.com/v1beta1/projects/${PROJECT}/analyticsDetails`;
const WINDOW_HOURS = 24;
const DEFAULT_OUT = '/Users/matrix/Developer/.claude/artifacts/test-center-reports';
const POPLUR_DIR = path.join(homedir(), '.poplur');
const RUNNER_LOG = path.join(POPLUR_DIR, 'synthetic-runner.log');
const SCHEDULER_LOG = path.join(POPLUR_DIR, 'synthetic-scheduler.log');
const TOKEN_FILE = path.join(POPLUR_DIR, 'test-control-token');
const SCHEDULER_LABEL = 'com.poplur.synthetic-live-scheduler';
const PAGE_SIZE = 1000;      // runQuery page (cursor paging)
const LIST_PAGE_SIZE = 300;  // documents.list page (pageToken paging)
const EVENT_CAP = 20000;     // windowed synthetic events fetched for actor/session folds
const HISTORY_CAP = 20000;   // radiusHistory collection-group entries fetched
// Owner-controlled accounts (the App Review demo account and the owner's own).
const OWNER_UIDS = {
  LiEG6SNtKEZN6eEGeybf0afZnHm1: 'PoplurTest',
  eoP2Z0ElxIa0Eua7xpFxNlr6tur1: 'mark',
};
const RADIUS_CAUSES = ['engagement', 'decay', 'boost', 'synthetic', 'lab', 'create', 'backfill'];

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const outDir = arg('--out') || DEFAULT_OUT;
const dateArg = arg('--date');
if (dateArg && !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
  console.error('--date must be YYYY-MM-DD');
  process.exit(2);
}

// ---------------------------------------------------------------- time
const now = new Date();
const nowMs = now.getTime();
const windowStartMs = nowMs - WINDOW_HOURS * 3600 * 1000;
const windowStartIso = new Date(windowStartMs).toISOString();
const localDate = d => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
function localLong(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).map(x => [x.type, x.value]));
  const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d).find(x => x.type === 'timeZoneName')?.value || '';
  return `${p.day} ${p.month} ${p.year} ${p.hour}:${p.minute} ${zone}`.trim();
}
const reportDate = dateArg || localDate(now);
const fmt = n => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n));
const short = uid => (uid.length > 8 ? `${uid.slice(0, 6)}…` : uid);

// ---------------------------------------------------------------- numbers[]
const numbers = [];
function N(label, value, query) {
  numbers.push({ label, value: String(value), query });
  return value;
}

// ---------------------------------------------------------------- Firestore REST
let accessToken = null;
function token() {
  if (!accessToken) {
    accessToken = execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  }
  return accessToken;
}
async function api(url, body) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status} non-JSON from ${url.slice(0, 120)}`); }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}
function decode(v) {
  if (v == null || typeof v !== 'object') return undefined;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('referenceValue' in v) return v.referenceValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, decode(x)]));
  return undefined;
}
const fieldsOf = doc => Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, decode(v)]));
const idOf = doc => doc.name.split('/').pop();
const eq = (field, value) => ({ fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value } });
const gte = (field, value) => ({ fieldFilter: { field: { fieldPath: field }, op: 'GREATER_THAN_OR_EQUAL', value } });
const ts = iso => ({ timestampValue: iso });

/** Exact count via runAggregationQuery (0 for a collection that does not exist). */
async function count(collectionId, where, allDescendants = false) {
  const body = {
    structuredAggregationQuery: {
      structuredQuery: { from: [{ collectionId, allDescendants }], ...(where ? { where } : {}) },
      aggregations: [{ count: {}, alias: 'n' }],
    },
  };
  const res = await api(`${FS_DOCS}:runAggregationQuery`, body);
  const n = Number(res?.[0]?.result?.aggregateFields?.n?.integerValue ?? 0);
  return { n, query: `POST documents:runAggregationQuery ${JSON.stringify(body)} -> ${n}` };
}

/** Every document of a collection through documents.list, paged by nextPageToken. */
async function listAll(collectionId, mask) {
  const docs = [];
  let pageToken = '';
  let pages = 0;
  do {
    const qs = new URLSearchParams({ pageSize: String(LIST_PAGE_SIZE) });
    for (const m of mask) qs.append('mask.fieldPaths', m);
    if (pageToken) qs.set('pageToken', pageToken);
    const res = await api(`${FS_DOCS}/${collectionId}?${qs}`);
    for (const d of res.documents || []) docs.push(d);
    pageToken = res.nextPageToken || '';
    pages += 1;
  } while (pageToken);
  const query = `GET documents/${collectionId}?pageSize=${LIST_PAGE_SIZE}&${mask.map(m => `mask.fieldPaths=${m}`).join('&')} paged by nextPageToken (${pages} page${pages === 1 ? '' : 's'}, ${docs.length} docs)`;
  return { docs, pages, query };
}

/** runQuery with cursor paging (limit + startAt after the last row of each page). */
async function queryAll({ from, select, where, orderBy, cap, pageSize = PAGE_SIZE }) {
  const docs = [];
  let startAt = null;
  let pages = 0;
  let capped = false;
  for (;;) {
    const structuredQuery = {
      from,
      ...(select ? { select: { fields: select.map(f => ({ fieldPath: f })) } } : {}),
      ...(where ? { where } : {}),
      orderBy: orderBy.map(([f, direction]) => ({ field: { fieldPath: f }, direction })),
      limit: pageSize,
      ...(startAt ? { startAt } : {}),
    };
    const res = await api(`${FS_DOCS}:runQuery`, { structuredQuery });
    const page = res.filter(r => r.document).map(r => r.document);
    pages += 1;
    docs.push(...page);
    if (page.length < pageSize) break;
    if (docs.length >= cap) { capped = true; break; }
    const last = page[page.length - 1];
    startAt = { values: orderBy.map(([f]) => (f === '__name__' ? { referenceValue: last.name } : last.fields[f])), before: false };
  }
  const describe = `POST documents:runQuery from=${JSON.stringify(from)}${select ? ` select=[${select.join(',')}]` : ''}${where ? ` where=${JSON.stringify(where)}` : ''} orderBy=${orderBy.map(o => o.join(' ')).join(', ')} limit=${pageSize}, paged by startAt cursor (${pages} page${pages === 1 ? '' : 's'}, ${docs.length} docs${capped ? `, CAPPED at ${cap}` : ''})`;
  return { docs, pages, capped, query: describe };
}

// ---------------------------------------------------------------- local probes
function curlStatus(port) {
  const args = ['-s', '-o', '/dev/null', '-m', '3', '-w', '%{http_code}', `http://127.0.0.1:${port}/`];
  try {
    return execFileSync('curl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || '000';
  } catch (e) {
    const out = (e.stdout || '').toString().trim();
    return /^\d{3}$/.test(out) ? out : '000';
  }
}
function grepCount(pattern) {
  if (!existsSync(RUNNER_LOG)) return null;
  try {
    return Number(execFileSync('grep', ['-c', '-F', '--', pattern, RUNNER_LOG], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch (e) {
    const out = (e.stdout || '').toString().trim();
    return /^\d+$/.test(out) ? Number(out) : null; // grep exits 1 on a zero count
  }
}
function logHasTimestamps() {
  if (!existsSync(RUNNER_LOG)) return false;
  try {
    const out = execFileSync('grep', ['-c', '-E', '^\\[?20[0-9]{2}-[0-9]{2}-[0-9]{2}T', RUNNER_LOG], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return Number(out) > 0;
  } catch (e) {
    return Number((e.stdout || '').toString().trim()) > 0;
  }
}
function schedulerState() {
  let text = '';
  try {
    text = execFileSync('launchctl', ['print', `gui/${process.getuid()}/${SCHEDULER_LABEL}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    text = `${(e.stdout || '').toString()}${(e.stderr || '').toString()}`;
  }
  if (/Could not find service/i.test(text) || text.trim() === '') return 'not loaded';
  return /state = running/.test(text) ? 'up' : 'down';
}
function lastLine(file) {
  try {
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    return lines[lines.length - 1] || '';
  } catch {
    return '';
  }
}
async function runnerState() {
  if (!existsSync(TOKEN_FILE)) return { known: false, why: 'token file absent' };
  let tokenValue;
  try { tokenValue = readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return { known: false, why: 'token file unreadable' }; }
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch('http://127.0.0.1:8097/state', { headers: { 'x-poplur-local-runner-token': tokenValue }, signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return { known: false, why: `HTTP ${res.status}` };
    return { known: true, state: await res.json() };
  } catch {
    return { known: false, why: '8097 not answering' };
  }
}

// ---------------------------------------------------------------- classification
// Order matters: the Radius Lab pins also carry syntheticBeta=true, so the id
// prefix must be tested before the cohort rule or every lab pin becomes cohort.
// (official 29 / cohort 23 / lab 10 / human 1 on 4 Sep 2026 depends on this.)
function postClass(id, f) {
  if (f.officialContent === true) return 'official';
  if (id.startsWith('post-radius-lab-')) return 'lab';
  if (f.syntheticBeta === true || String(f.userID || '').startsWith('sim-') || f.source === 'synthetic-browser') return 'cohort';
  return 'human';
}
function userClass(uid, f) {
  if (OWNER_UIDS[uid]) return 'owner';
  if (f.syntheticBeta === true || uid.startsWith('sim-')) return 'synthetic';
  return 'human';
}

// ================================================================= main
async function main() {
  // ---- users --------------------------------------------------------------
  const usersList = await listAll('users', ['username', 'displayName', 'syntheticBeta', 'accountType', 'createdAt', 'testActivityConsent']);
  const users = usersList.docs.map(d => ({ uid: idOf(d), ...fieldsOf(d) })).map(u => ({ ...u, cls: userClass(u.uid, u) }));
  const usersCount = await count('users');
  const consentCount = await count('users', eq('testActivityConsent', { booleanValue: true }));
  const testActivityCount = await count('testActivity');
  const ownerUsers = users.filter(u => u.cls === 'owner');
  const syntheticUsers = users.filter(u => u.cls === 'synthetic');
  const humanUsers = users.filter(u => u.cls === 'human');
  N('users (total)', usersCount.n, usersCount.query);
  N('users by class: owner / synthetic / human', `${ownerUsers.length} / ${syntheticUsers.length} / ${humanUsers.length}`,
    `${usersList.query}; owner = uids ${Object.keys(OWNER_UIDS).map(short).join(', ')}; synthetic = syntheticBeta==true or uid sim-*; human = the rest`);
  N('users with testActivityConsent == true', consentCount.n, consentCount.query);
  N('testActivity documents (human telemetry)', testActivityCount.n, testActivityCount.query);

  // ---- posts --------------------------------------------------------------
  const postMask = ['userID', 'username', 'syntheticBeta', 'officialContent', 'source', 'syntheticSource', 'createdAt', 'viewCount', 'likeCount', 'commentCount', 'radiusMeters', 'mediaType'];
  const postsList = await listAll('posts', postMask);
  const posts = postsList.docs.map(d => { const f = fieldsOf(d); const id = idOf(d); return { id, ...f, cls: postClass(id, f) }; });
  const postsCount = await count('posts');
  const officialCount = await count('posts', eq('officialContent', { booleanValue: true }));
  const postsByClass = { official: 0, cohort: 0, lab: 0, human: 0, total: posts.length };
  const eng = {};
  for (const c of ['official', 'cohort', 'lab', 'human']) eng[c] = { posts: 0, views: 0, likes: 0, comments: 0 };
  const postsByUid = {};
  for (const p of posts) {
    postsByClass[p.cls] += 1;
    eng[p.cls].posts += 1;
    eng[p.cls].views += Number(p.viewCount || 0);
    eng[p.cls].likes += Number(p.likeCount || 0);
    eng[p.cls].comments += Number(p.commentCount || 0);
    const uid = String(p.userID || '');
    postsByUid[uid] = (postsByUid[uid] || 0) + 1;
  }
  if (postsCount.n !== posts.length) {
    console.error(`warning: posts aggregation ${postsCount.n} != listed ${posts.length}`);
  }
  N('posts (total)', postsCount.n, postsCount.query);
  N('posts officialContent == true', officialCount.n, officialCount.query);
  N('posts: official / cohort / lab / human', `${postsByClass.official} / ${postsByClass.cohort} / ${postsByClass.lab} / ${postsByClass.human}`,
    `${postsList.query}; classified officialContent==true -> official; id prefix post-radius-lab- -> lab (tested before the cohort rule: lab pins carry syntheticBeta too); syntheticBeta==true or userID sim-* or source synthetic-browser -> cohort; remainder -> human`);
  const engagementOrigin = {
    official: 'Like counts were seeded to match the figures printed on the card artwork; not engagement.',
    cohort: 'The cohort and the simulation engaging with each other; a like-farm defect inflated these before 1 Sep 2026.',
    lab: 'Lab engagement from the desk.',
    human: 'Viewers not identified anywhere.',
  };
  const engagementByClass = ['official', 'cohort', 'lab', 'human'].map(cls => ({ cls, ...eng[cls], origin: engagementOrigin[cls] }));
  N('engagement sums by class (views / likes / comments)',
    engagementByClass.map(e => `${e.cls} ${fmt(e.views)} / ${fmt(e.likes)} / ${fmt(e.comments)}`).join('; '),
    `${postsList.query}; viewCount, likeCount, commentCount summed per class in code`);
  const humanPosts = posts.filter(p => p.cls === 'human');
  const thirdPartyHumanPosts = humanPosts.filter(p => !OWNER_UIDS[String(p.userID || '')]);
  for (const p of humanPosts) {
    const who = OWNER_UIDS[String(p.userID || '')] ? `owner account '${OWNER_UIDS[p.userID]}'` : `uid ${short(String(p.userID || ''))} (third party)`;
    N(`human-class post ${p.id}`, `${who}, ${p.createdAt || '?'}, ${p.mediaType || '?'}, radius ${fmt(p.radiusMeters ?? '?')} m, views ${fmt(p.viewCount || 0)}, likes ${fmt(p.likeCount || 0)}, comments ${fmt(p.commentCount || 0)}`,
      `GET documents/posts/${p.id} (fields from the paged posts listing above)`);
  }

  // ---- accounts (users folded by class + posting identities without a users doc)
  const accounts = [];
  for (const [uid, name] of Object.entries(OWNER_UIDS)) {
    const what = name === 'PoplurTest' ? 'The App Review demo account; owns the official seed posts.' : "The owner's own account.";
    accounts.push({ label: name, what, posts: postsByUid[uid] || 0, class: 'owner' });
  }
  if (syntheticUsers.length) {
    const kinds = [...new Set(syntheticUsers.map(u => u.accountType || 'user'))].join('/');
    accounts.push({
      label: syntheticUsers.map(u => u.username || u.uid).join(' · '),
      what: `${syntheticUsers.length} synthetic ${kinds} tester${syntheticUsers.length === 1 ? '' : 's'} in users (syntheticBeta=true).`,
      posts: syntheticUsers.reduce((s, u) => s + (postsByUid[u.uid] || 0), 0),
      class: 'synthetic',
    });
  }
  const userUids = new Set(users.map(u => u.uid));
  const runnerUids = Object.keys(postsByUid).filter(uid => uid.startsWith('sim-') && !userUids.has(uid)).sort();
  if (runnerUids.length) {
    accounts.push({
      label: runnerUids.length > 1 ? `${runnerUids[0]} … ${runnerUids[runnerUids.length - 1]}` : runnerUids[0],
      what: `${runnerUids.length} runner persona${runnerUids.length === 1 ? '' : 's'} driven by the browser runner; they post but own no users document.`,
      posts: runnerUids.reduce((s, uid) => s + postsByUid[uid], 0),
      class: 'synthetic',
    });
  }
  const labOwners = [...new Set(posts.filter(p => p.cls === 'lab').map(p => String(p.userID || '')))].sort();
  if (postsByClass.lab) {
    accounts.push({ label: 'Radius Lab', what: `Pins dropped from the Test Center's Radius Lab, owned by ${labOwners.join(', ')}.`, posts: postsByClass.lab, class: 'synthetic' });
  }
  for (const u of humanUsers) {
    accounts.push({ label: u.username || u.uid, what: `Third-party account in users (created ${u.createdAt || 'unknown'}).`, posts: postsByUid[u.uid] || 0, class: 'human' });
  }
  const strayUids = Object.keys(postsByUid).filter(uid => !userUids.has(uid) && !uid.startsWith('sim-') && !labOwners.includes(uid) && !OWNER_UIDS[uid]);
  for (const uid of strayUids) {
    const cls = posts.some(p => p.userID === uid && p.cls === 'human') ? 'human' : 'synthetic';
    accounts.push({ label: short(uid), what: 'Posts by an identity with no users document.', posts: postsByUid[uid], class: cls });
  }
  N('posts per account row', accounts.map(a => `${a.label} (${a.class}) ${a.posts}`).join('; '), `${postsList.query}; posts grouped by userID in code; users from ${usersList.query}`);

  // ---- dmThreads ----------------------------------------------------------
  const dmCount = await count('dmThreads');
  const dmList = await listAll('dmThreads', ['participants', 'updatedAt']);
  const syntheticUidSet = new Set(syntheticUsers.map(u => u.uid));
  const dmKinds = dmList.docs.map(d => {
    const parts = (fieldsOf(d).participants || []).map(String);
    const kinds = parts.map(uid => (OWNER_UIDS[uid] ? 'owner' : (syntheticUidSet.has(uid) || uid.startsWith('sim-') ? 'synthetic' : 'human')));
    return kinds.sort().join(' ↔ ');
  });
  const humanToHumanThreads = dmKinds.filter(k => k === 'human ↔ human').length;
  N('dmThreads', `${dmCount.n} (${dmKinds.join('; ') || 'none'})`, `${dmCount.query}; ${dmList.query}; participants classified owner / synthetic / human in code`);

  // ---- simulation window --------------------------------------------------
  const eventsWindowCount = await count('testSyntheticBrowserEvents', gte('receivedAt', ts(windowStartIso)));
  const eventsAllCount = await count('testSyntheticBrowserEvents');
  const eventsWindow = await queryAll({
    from: [{ collectionId: 'testSyntheticBrowserEvents' }],
    select: ['actorId', 'sessionId', 'receivedAt'],
    where: gte('receivedAt', ts(windowStartIso)),
    orderBy: [['receivedAt', 'DESCENDING'], ['__name__', 'DESCENDING']],
    cap: EVENT_CAP,
  });
  const eventRows = eventsWindow.docs.map(fieldsOf);
  const actorsSeen = [...new Set(eventRows.map(e => e.actorId).filter(Boolean))].sort();
  const sessionIdsSeen = new Set(eventRows.map(e => e.sessionId).filter(Boolean));
  const newestEventAt = eventRows.length ? eventRows[0].receivedAt || null : null;
  const sessionsWindowCount = await count('testSyntheticBrowserSessions', gte('lastEventAt', ts(windowStartIso)));
  const sessionsAllCount = await count('testSyntheticBrowserSessions');
  const simEventsCount = await count('testSimulationEvents');
  const actorsCount = await count('testSyntheticRunnerActors');
  const betaPostsCount = await count('testBetaPosts');
  const postsWindowCount = await count('posts', gte('createdAt', ts(windowStartIso)));
  const postsInWindowByClass = { official: 0, cohort: 0, lab: 0, human: 0 };
  for (const p of posts) if (p.createdAt && Date.parse(p.createdAt) >= windowStartMs) postsInWindowByClass[p.cls] += 1;
  const syntheticPostsInWindow = postsInWindowByClass.cohort + postsInWindowByClass.lab;
  const simulation = {
    ranInWindow: eventsWindowCount.n > 0 || syntheticPostsInWindow > 0,
    windowHours: WINDOW_HOURS,
    eventsInWindow: eventsWindowCount.n,
    sessionsInWindow: sessionsWindowCount.n,
    postsInWindow: syntheticPostsInWindow,
    newestEventAt,
    actorsSeen,
  };
  N(`testSyntheticBrowserEvents received in the last ${WINDOW_HOURS} h`, eventsWindowCount.n, `${eventsWindowCount.query} (window start ${windowStartIso})`);
  N('testSyntheticBrowserEvents (all-time)', eventsAllCount.n, eventsAllCount.query);
  N('newest synthetic browser event', newestEventAt || 'none in window', eventsWindow.query);
  N('distinct actorIds / sessionIds in windowed events', `${actorsSeen.length} (${actorsSeen.join(', ') || 'none'}) / ${sessionIdsSeen.size}`, `${eventsWindow.query}; distinct actorId and sessionId in code`);
  N(`testSyntheticBrowserSessions with lastEventAt in the last ${WINDOW_HOURS} h`, sessionsWindowCount.n, sessionsWindowCount.query);
  N('testSimulationEvents / testSyntheticBrowserSessions / testSyntheticRunnerActors / testBetaPosts (all-time)',
    `${simEventsCount.n} / ${sessionsAllCount.n} / ${actorsCount.n} / ${betaPostsCount.n}`,
    [simEventsCount, sessionsAllCount, actorsCount, betaPostsCount].map(c => c.query).join('; '));
  N(`posts created in the last ${WINDOW_HOURS} h by class (official / cohort / lab / human)`,
    `${postsInWindowByClass.official} / ${postsInWindowByClass.cohort} / ${postsInWindowByClass.lab} / ${postsInWindowByClass.human} (aggregation ${postsWindowCount.n}); simulation.postsInWindow = cohort + lab = ${syntheticPostsInWindow}`,
    `${postsWindowCount.query}; ${postsList.query} filtered createdAt >= ${windowStartIso} in code`);

  // ---- radiusHistory (collection group) -----------------------------------
  // The group has no collection-group index on atMillis (orderBy or fieldFilter
  // on it fails with FAILED_PRECONDITION), so the whole group is paged by
  // __name__ and the window is applied in code. One pass serves both the
  // totals and the window; the cap is stated wherever it bites.
  const historyCount = await count('radiusHistory', undefined, true);
  const history = await queryAll({
    from: [{ collectionId: 'radiusHistory', allDescendants: true }],
    select: ['atMillis', 'cause', 'radiusMeters', 'delta', 'writer'],
    orderBy: [['__name__', 'ASCENDING']],
    cap: HISTORY_CAP,
  });
  const byPost = new Map();
  for (const d of history.docs) {
    const f = fieldsOf(d);
    const postId = d.name.split('/documents/posts/')[1]?.split('/')[0] || 'unknown';
    if (!byPost.has(postId)) byPost.set(postId, []);
    byPost.get(postId).push({ atMillis: Number(f.atMillis || 0), cause: String(f.cause || 'unknown'), radiusMeters: Number(f.radiusMeters || 0), delta: Number(f.delta || 0) });
  }
  const byCause = Object.fromEntries(RADIUS_CAUSES.map(c => [c, 0]));
  const folds = [];
  let entriesInWindow = 0;
  const postMap = new Map(posts.map(p => [p.id, p]));
  for (const [postId, entries] of byPost) {
    entries.sort((a, b) => a.atMillis - b.atMillis);
    const w = entries.filter(e => e.atMillis >= windowStartMs);
    if (!w.length) continue;
    entriesInWindow += w.length;
    const causes = {};
    for (const e of w) { causes[e.cause] = (causes[e.cause] || 0) + 1; byCause[e.cause] = (byCause[e.cause] || 0) + 1; }
    const first = w[0];
    const last = w[w.length - 1];
    const fromMeters = first.radiusMeters - first.delta; // the reach as it stood entering the window
    const toMeters = last.radiusMeters;
    const post = postMap.get(postId);
    folds.push({
      postId,
      owner: post ? String(post.userID || 'unknown') : 'unknown (post document absent)',
      cls: post ? post.cls : 'unknown',
      fromMeters, toMeters, deltaMeters: toMeters - fromMeters,
      causes,
      moved: w.some(e => e.delta !== 0),
    });
  }
  folds.sort((a, b) => Math.abs(b.deltaMeters) - Math.abs(a.deltaMeters) || a.postId.localeCompare(b.postId));
  const popsMoved = folds.filter(f => f.moved).length;
  const radiusMoves = {
    windowHours: WINDOW_HOURS,
    entriesInWindow,
    postsWithHistory: byPost.size,
    totalEntries: historyCount.n,
    top: folds.slice(0, 10).map(({ moved, ...rest }) => rest),
    byCause,
  };
  const historyNote = `${history.query}; window atMillis >= ${windowStartMs} applied in code (no collection-group index on atMillis exists, so orderBy/fieldFilter on it is impossible)${history.capped ? `; CAPPED at ${HISTORY_CAP} of ${historyCount.n} — window figures are lower bounds` : ''}`;
  N('radiusHistory entries (collection group, all-time)', historyCount.n, historyCount.query);
  N('posts with radiusHistory', byPost.size, `${historyNote}; distinct parent post ids in code`);
  N(`radiusHistory entries in the last ${WINDOW_HOURS} h`, entriesInWindow, historyNote);
  N(`pops moved in the last ${WINDOW_HOURS} h`, popsMoved, `${historyNote}; a pop counts as moved when at least one in-window entry has delta != 0`);
  N(`radiusHistory entries in the window by cause`, RADIUS_CAUSES.map(c => `${c} ${byCause[c]}`).join(', '), historyNote);
  N('top radius moves (|delta| desc)', radiusMoves.top.map(t => `${t.postId} (${t.cls}) ${fmt(t.fromMeters)} -> ${fmt(t.toMeters)} m (${t.deltaMeters >= 0 ? '+' : ''}${fmt(t.deltaMeters)})`).join('; ') || 'none',
    `${historyNote}; per post: fromMeters = first in-window entry radiusMeters - delta, toMeters = last in-window radiusMeters`);

  // ---- services -----------------------------------------------------------
  const portStatus = Object.fromEntries([8081, 8084, 8096, 8097, 8098].map(p => [p, curlStatus(p)]));
  const portQuery = `for p in 8081 8084 8096 8097 8098; do curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:$p/; done -> ${Object.entries(portStatus).map(([p, s]) => `${p}:${s}`).join(' ')}`;
  N('Test Center ports (HTTP status)', Object.entries(portStatus).map(([p, s]) => `${p}=${s}`).join(' '), portQuery);
  const rs = await runnerState();
  const st = rs.known ? rs.state : null;
  const actorErrors = st ? (st.actors || []).filter(a => a.lastError).map(a => ({ actorId: a.actorId, error: String(a.lastError).split('\n')[0].slice(0, 200) })) : [];
  const runner = {
    mode: st ? String(st.mode || 'unknown') : 'unknown',
    status: st ? String(st.status || 'unknown') : 'unknown',
    error: st ? (st.error ? String(st.error) : null) : null,
    startedAtMs: st && Number(st.startedAtMs) > 0 ? Number(st.startedAtMs) : null,
    actorErrors,
  };
  const runnerQuery = `GET http://127.0.0.1:8097/state with header x-poplur-local-runner-token from ~/.poplur/test-control-token (token never printed)${rs.known ? '' : ` -> unknown (${rs.why})`}`;
  N('Synthetic runner state', rs.known ? `mode ${runner.mode}, status ${runner.status}${runner.error ? `, error '${runner.error}'` : ''}${runner.startedAtMs ? `, started ${new Date(runner.startedAtMs).toISOString()}` : ''}, ${actorErrors.length} actor error${actorErrors.length === 1 ? '' : 's'}` : 'unknown', runnerQuery);
  const sched = schedulerState();
  const schedLast = lastLine(SCHEDULER_LOG);
  N('Scheduler (launchd)', sched, `launchctl print gui/$UID/${SCHEDULER_LABEL} -> ${sched}; tail -1 ~/.poplur/synthetic-scheduler.log -> '${schedLast || 'no log'}'`);
  const stateOf = code => (code === '000' ? 'down' : 'up');
  const gatedDetail = code => (code === '403' ? 'Answers 403 without a token (token-gated).' : code === '200' ? 'Answers 200.' : `Answers ${code}.`);
  const services = [
    { name: 'Beta Control Room page', port: '8084', state: stateOf(portStatus[8084]), detail: portStatus[8084] === '000' ? 'Not answering; nothing automated starts it.' : gatedDetail(portStatus[8084]) },
    { name: 'Owner proxy', port: '8096', state: stateOf(portStatus[8096]), detail: portStatus[8096] === '000' ? 'Not answering; it refuses to start without the two local tokens.' : gatedDetail(portStatus[8096]) },
    {
      name: 'Synthetic app runner', port: '8097',
      state: portStatus[8097] === '000' ? 'down' : (rs.known ? (runner.status === 'error' ? 'error' : 'up') : 'unknown'),
      detail: portStatus[8097] === '000' ? 'Not answering.' : (rs.known
        ? `${runner.mode}, status ${runner.status}${runner.error ? `: "${runner.error}"` : ''}${runner.startedAtMs ? ` (run began ${new Date(runner.startedAtMs).toISOString()})` : ''}${actorErrors.length ? `; ${actorErrors.length} actor${actorErrors.length === 1 ? '' : 's'} carry an error` : ''}.`
        : `Answers ${portStatus[8097]}; state unknown (${rs.why}).`),
    },
    { name: 'Radius Lab server', port: '8098', state: stateOf(portStatus[8098]), detail: portStatus[8098] === '000' ? 'Not answering.' : gatedDetail(portStatus[8098]) },
    { name: 'RN web shell (what the runner drives)', port: '8081', state: stateOf(portStatus[8081]), detail: portStatus[8081] === '000' ? 'Not answering.' : gatedDetail(portStatus[8081]) },
    { name: 'Scheduler (launchd)', port: '—', state: sched, detail: schedLast ? `Last log line: "${schedLast}".` : 'No scheduler log.' },
  ];

  // ---- analytics ----------------------------------------------------------
  let analytics;
  try {
    const j = await api(ANALYTICS_URL);
    const streams = (j.streamMappings || []).length;
    analytics = {
      projectLinked: Boolean(j.analyticsProperty && j.analyticsProperty.id),
      propertyId: j.analyticsProperty?.id ? String(j.analyticsProperty.id) : null,
      streams,
      // TODO: proof that a client ships the SDK would be an event count from the
      // GA4 Data API (runReport on the property), which needs the
      // analytics.readonly scope the ADC token lacks. Until then nothing here may
      // claim a client shipped, and eventsEverSent stays 'unknown', not 0.
      clientsShipped: [],
      eventsEverSent: 'unknown',
      note: `Project ${j.analyticsProperty?.id ? 'linked' : 'not linked'} to Google Analytics${j.analyticsProperty?.id ? ` (property ${j.analyticsProperty.id}, ${streams} stream${streams === 1 ? '' : 's'})` : ''}. Client delivery has not been verified by this report, and the GA4 Data API was not queried (the ADC token lacks the scope), so the number of events ever sent is unknown — not zero.`,
    };
    N('Analytics link', `${analytics.projectLinked ? `property ${analytics.propertyId}` : 'not linked'}, ${streams} streams`, `GET ${ANALYTICS_URL}`);
  } catch (e) {
    analytics = { projectLinked: false, propertyId: null, streams: 0, clientsShipped: [], eventsEverSent: 'unknown', note: `analyticsDetails request failed (${e.message.slice(0, 120)}); link state unknown.` };
    N('Analytics link', 'request failed', `GET ${ANALYTICS_URL} -> ${e.message.slice(0, 120)}`);
  }
  N('Analytics events ever sent', 'unknown', 'not queried: the GA4 Data API needs analytics.readonly, which the ADC token lacks; clientsShipped is empty so SDK absence must not be inferred');

  // Source wiring is distinct from delivered binaries or observed GA4 events.
  const wiring = [
    ['iOS', '/Users/matrix/Developer/Poplur2025-iOS/Poplur2025/PoplurAnalyticsRelay.swift', 'Analytics.logEvent'],
    ['Android', '/Users/matrix/Developer/Poplur2025-Android/app/build.gradle.kts', 'com.google.firebase:firebase-analytics'],
    ['Web bridge', '/Users/matrix/Developer/poplur-clay-map/src/analytics.ts', 'analyticsEvent'],
  ].filter(([, file, marker]) => existsSync(file) && readFileSync(file, 'utf8').includes(marker));
  const wiringNote = wiring.length ? ` Source wiring found for ${wiring.map(([name]) => name).join(', ')}; this does not establish delivery or collected events.` : ' Source wiring was not found at the checked paths.';
  analytics.note += wiringNote;
  N('Analytics source wiring', wiring.map(([name]) => name).join(', ') || 'not found', wiring.map(([,file,marker]) => `${file}: contains ${marker}`).join('; ') || 'checked configured source paths');

  // ---- feedback -----------------------------------------------------------
  const collectionIds = (await api(`${FS_DOCS}:listCollectionIds`, { pageSize: 300 })).collectionIds || [];
  const fb = {};
  for (const c of ['testFeedback', 'feedback', 'reports', 'betaSignups']) fb[c] = await count(c);
  const exists = c => (collectionIds.includes(c) ? 'exists' : 'absent');
  N('testFeedback / feedback / reports / betaSignups documents',
    `${fb.testFeedback.n} / ${fb.feedback.n} / ${fb.reports.n} / ${fb.betaSignups.n} (collections ${['testFeedback', 'feedback', 'reports', 'betaSignups'].map(c => `${c}: ${exists(c)}`).join(', ')})`,
    `${Object.values(fb).map(c => c.query).join('; ')}; POST documents:listCollectionIds {"pageSize":300}`);
  const feedbackReceived = fb.testFeedback.n + fb.feedback.n + fb.reports.n + fb.betaSignups.n;
  const ascPaths = [path.join(homedir(), '.appstoreconnect'), path.join(homedir(), '.config', 'asc'), path.join(homedir(), '.private_keys')];
  const ascFound = ascPaths.filter(p => existsSync(p));
  N('App Store Connect credentials at the checked paths', ascFound.length ? ascFound.join(', ') : 'none', `existsSync over ${ascPaths.join(', ')}`);
  const feedback = [
    { channel: 'In-app "Send feedback"', exists: 'No', received: 0, notes: 'No app has a feedback row, form or mail link (as of the 4 Sep 2026 source review); the in-app browser blocks mailto:.' },
    { channel: 'Beta feedback backend (testFeedback)', exists: collectionIds.includes('testFeedback') ? 'Yes, unwired' : 'Yes, unwired (collection never created)', received: fb.testFeedback.n, notes: `The cloud function testActivityControl stores finding / liked / improve and the desk renders them; nothing calls it. Legacy 'feedback' collection: ${fb.feedback.n}.` },
    { channel: 'Block and Report on a profile (reports)', exists: collectionIds.includes('reports') ? 'Committed 4 Sep 2026 (iOS fccf6bf4)' : 'Committed 4 Sep 2026 (iOS fccf6bf4); collection never created', received: fb.reports.n, notes: 'Reports counted from production. Client handler coverage and the currently deployed rule release are not checked by this gatherer.' },
    { channel: 'Beta invite email ("reply to this email")', exists: 'Yes', received: 'unknown', notes: "Replies live only in the owner's inbox; nothing is stored anywhere this script can read." },
    { channel: 'Landing-page beta signup (betaSignups)', exists: collectionIds.includes('betaSignups') ? 'Collection present' : 'Collection absent', received: fb.betaSignups.n, notes: 'No signup flow was exercised; deployed write permissions and failed attempts are unknown.' },
    { channel: 'TestFlight feedback and crash logs', exists: ascFound.length ? 'Credentials present; not pulled by this script' : 'Unreachable', received: '—', notes: ascFound.length ? `Found ${ascFound.join(', ')}; pulling TestFlight feedback is not implemented here.` : 'No App Store Connect API key at the checked paths on this Mac.' },
  ];

  // ---- runner-log signals -------------------------------------------------
  const logExists = existsSync(RUNNER_LOG);
  const timestamped = logHasTimestamps();
  let logScope = logExists ? (timestamped ? `lines newer than ${windowStartIso}` : 'all-time (the log carries no timestamps)') : 'no log';
  const patterns = {
    dmFailed: 'step send-dm failed', dmSent: ' messaged ', holdFailed: 'step open-hold-menu failed', holdSawFeed: 'did not settle on hold-menu (saw feed)',
    pageerror: 'pageerror', consoleError: 'console.error', refused: 'ERR_CONNECTION_REFUSED',
    prodBlocked: 'live-production-blocked', extBlocked: 'external-write-blocked', fsBlocked: 'live-firestore-blocked',
  };
  const g = {};
  if (logExists && timestamped) {
    // Only lines whose leading timestamp falls inside the window are counted.
    const lines = readFileSync(RUNNER_LOG, 'utf8').split('\n').filter(l => { const m = l.match(/^\[?(20\d{2}-\d{2}-\d{2}T[^\s\]]+)/); return m && Date.parse(m[1]) >= windowStartMs; });
    for (const [k, p] of Object.entries(patterns)) g[k] = lines.filter(l => l.includes(p)).length;
  } else {
    for (const [k, p] of Object.entries(patterns)) g[k] = grepCount(p);
  }
  const gq = p => (logExists ? (timestamped ? `lines of ~/.poplur/synthetic-runner.log with a timestamp >= ${windowStartIso} containing '${p}'` : `grep -c -F -- '${p}' ~/.poplur/synthetic-runner.log (all-time; the log has no timestamps)`) : '~/.poplur/synthetic-runner.log absent');
  const show = v => (v == null ? 'unknown' : fmt(v));
  N('Synthetic DM send failures / successes', `${show(g.dmFailed)} / ${show(g.dmSent)} (${logScope})`, `${gq(patterns.dmFailed)} -> ${show(g.dmFailed)}; ${gq(patterns.dmSent)} -> ${show(g.dmSent)}`);
  N('Synthetic hold-menu failures', `${show(g.holdFailed)} (${show(g.holdSawFeed)} 'saw feed') (${logScope})`, `${gq(patterns.holdFailed)} -> ${show(g.holdFailed)}; ${gq(patterns.holdSawFeed)} -> ${show(g.holdSawFeed)}`);
  N('Runner page errors / console errors', `${show(g.pageerror)} / ${show(g.consoleError)} (${logScope})`, `${gq(patterns.pageerror)} -> ${show(g.pageerror)}; ${gq(patterns.consoleError)} -> ${show(g.consoleError)}`);
  N('8081 connection refusals in the runner log', `${show(g.refused)} (${logScope})`, `${gq(patterns.refused)} -> ${show(g.refused)}`);
  N('Sandbox block verdicts (production / external / firestore)', `${show(g.prodBlocked)} / ${show(g.extBlocked)} / ${show(g.fsBlocked)} (${logScope})`, `${gq(patterns.prodBlocked)} -> ${show(g.prodBlocked)}; ${gq(patterns.extBlocked)} -> ${show(g.extBlocked)}; ${gq(patterns.fsBlocked)} -> ${show(g.fsBlocked)}`);
  N('Current runner actor errors', actorErrors.length ? actorErrors.map(a => `${a.actorId}: ${a.error}`).join('; ') : (rs.known ? 'none' : 'unknown'), runnerQuery);

  const holdNow = actorErrors.filter(a => /hold-menu/.test(a.error)).length;
  const signals = [
    {
      title: 'The first message to anyone never sent',
      status: 'info',
      body: `The synthetic testers' direct-message step failed ${show(g.dmFailed)} times and succeeded ${show(g.dmSent)} times in the runner log (${logScope}). The reference report of 4 Sep 2026 traced the cause to the app (the client read the message document before writing the batch, the participant lookup returned nothing for a thread that did not exist, and the rules denied it) and recorded it fixed in iOS commit 8f28662b; production holds ${dmCount.n} DM thread${dmCount.n === 1 ? '' : 's'} today (${dmKinds.join('; ') || 'none'}). Machine evidence, not tester feedback.`,
      evidence: `synthetic-runner.log 'step send-dm failed' ×${show(g.dmFailed)}, ' messaged ' ×${show(g.dmSent)} (${logScope}); iOS commit 8f28662b; dmThreads = ${dmCount.n}`,
    },
    {
      title: 'Testers never reach the hold menu',
      status: 'undetermined',
      body: `The hold gesture failed ${show(g.holdFailed)} times in the synthetic journeys, ${show(g.holdSawFeed)} of them "did not settle on hold-menu (saw feed)" (${logScope})${holdNow ? `; it is the current error of ${holdNow} runner actor${holdNow === 1 ? '' : 's'}` : ''}. Whether this is a runner selector problem or a real discoverability problem for a person holding the cube is not established by any evidence here. Worth a human test.`,
      evidence: `synthetic-runner.log 'step open-hold-menu failed' ×${show(g.holdFailed)}, 'saw feed' ×${show(g.holdSawFeed)}${holdNow ? `; runner /state actor lastError matches hold-menu ×${holdNow}` : ''}`,
    },
    {
      title: 'A newcomer with nothing nearby sees an empty app',
      status: 'info',
      body: `Apple rejected the app as "not complete" because radius-gated delivery meant a reviewer outside every post's radius saw nothing; the ${officialCount.n} official posts reach the whole planet to mask that (the reference report marked this mitigated). The reviewer's own words are not stored in any repository; only a developer's paraphrase survives. The same emptiness awaits any first user in a quiet area.`,
      evidence: `qa/official-launch-content/seed-official-posts.mjs header; ${officialCount.n} posts with officialContent == true (${officialCount.query.split(' -> ')[0].slice(0, 80)}…)`,
    },
    {
      title: 'Silent front-end failures would be invisible to the desk',
      status: 'info',
      body: `The runner keeps console errors and page errors in memory only (a 20-line tail) and the session documents carry no such fields. The log records ${show(g.pageerror)} page errors and ${show(g.consoleError)} console errors (${logScope}), which is either good news or a blind spot; today it cannot tell which.`,
      evidence: `synthetic-runner.log 'pageerror' ×${show(g.pageerror)}, 'console.error' ×${show(g.consoleError)}; testSyntheticBrowserSessions schema has no consoleTail/pageErrors fields`,
    },
    {
      title: 'Infrastructure, not product',
      status: 'info',
      body: `${show(g.refused)} connection refusals to the RN shell on 8081 and ${show(g.prodBlocked)} / ${show(g.extBlocked)} / ${show(g.fsBlocked)} sandbox "blocked" verdicts (production / external / firestore) are the runner's environment and its safety net doing their jobs (${logScope}). The scheduler cannot restart a runner that is down by design, so once the cohort stops it stays stopped until someone starts it.`,
      evidence: `synthetic-runner.log 'ERR_CONNECTION_REFUSED' ×${show(g.refused)}, 'live-production-blocked' ×${show(g.prodBlocked)}, 'external-write-blocked' ×${show(g.extBlocked)}, 'live-firestore-blocked' ×${show(g.fsBlocked)}; scheduler ${sched}`,
    },
    {
      title: 'Synthetic runner right now',
      status: rs.known ? (runner.status === 'error' ? 'open' : 'info') : 'undetermined',
      body: rs.known
        ? `Mode ${runner.mode}, status ${runner.status}${runner.error ? `: "${runner.error}"` : ''}${runner.startedAtMs ? ` (run began ${new Date(runner.startedAtMs).toISOString()}; the runner records no time for a failure itself)` : ''}. ${actorErrors.length ? `Actor errors: ${actorErrors.map(a => `${a.actorId} — ${a.error}`).join('; ')}.` : 'No actor carries an error.'}`
        : `The runner's state is unknown (${rs.why}).`,
      evidence: runnerQuery,
    },
  ];

  // ---- tiles --------------------------------------------------------------
  const humanTesters = humanUsers.length;
  const tiles = [
    { key: 'human_testers', label: 'Human testers', value: humanTesters, note: `${usersCount.n} accounts exist: ${ownerUsers.length} owner-controlled, ${syntheticUsers.length} synthetic (syntheticBeta=true), ${humanTesters} third-party human. ${consentCount.n} of ${usersCount.n} have switched on "Share closed-beta activity".`, zero: humanTesters === 0 },
    { key: 'human_posts', label: 'Human posts', value: postsByClass.human, note: `Of ${postsByClass.total}. ${humanPosts.length - thirdPartyHumanPosts.length} by owner-controlled accounts${humanPosts.length ? ` (${humanPosts.map(p => `${OWNER_UIDS[String(p.userID || '')] || short(String(p.userID || ''))}, ${(p.createdAt || '').slice(0, 10)}, ${fmt(p.viewCount || 0)} views, radius ${fmt(p.radiusMeters ?? '?')} m`).join('; ')})` : ''}; ${thirdPartyHumanPosts.length} by a third party.`, zero: thirdPartyHumanPosts.length === 0 },
    { key: 'feedback_received', label: 'Feedback received', value: feedbackReceived, note: `testFeedback ${fb.testFeedback.n}, feedback ${fb.feedback.n}, reports ${fb.reports.n}, betaSignups ${fb.betaSignups.n}. No in-app channel exists; invite-email replies are not stored.`, zero: feedbackReceived === 0 },
    { key: 'analytics_events', label: 'Analytics events', value: 'unknown', note: `${analytics.projectLinked ? `Project linked to Google Analytics (property ${analytics.propertyId}, ${analytics.streams} streams)` : 'Analytics link state unknown'}; client delivery has not been verified by this report, and the GA4 Data API was not queried, so this is unknown rather than zero.`, zero: true },
    { key: 'pops_moved_24h', label: `Pops moved, ${WINDOW_HOURS} h`, value: popsMoved, note: `${fmt(entriesInWindow)} radiusHistory entries in the window across ${folds.length} posts (${RADIUS_CAUSES.filter(c => byCause[c]).map(c => `${c} ${byCause[c]}`).join(', ') || 'no causes'}); window filtered in code over ${fmt(history.docs.length)} of ${fmt(historyCount.n)} entries${history.capped ? ' (capped)' : ''}.`, zero: popsMoved === 0 },
    { key: 'synthetic_events_24h', label: `Synthetic events, ${WINDOW_HOURS} h`, value: eventsWindowCount.n, note: `testSyntheticBrowserEvents received since ${windowStartIso}: ${sessionsWindowCount.n} session${sessionsWindowCount.n === 1 ? '' : 's'}, ${actorsSeen.length} actor${actorsSeen.length === 1 ? '' : 's'}${newestEventAt ? `, newest ${newestEventAt}` : ''}. Synthetic only — no human telemetry exists.`, zero: eventsWindowCount.n === 0 },
  ];

  // ---- answer -------------------------------------------------------------
  const answer = [
    humanTesters === 0
      ? `No third-party human has used the app: users holds ${usersCount.n} account${usersCount.n === 1 ? '' : 's'} (${ownerUsers.length} owner-controlled, ${syntheticUsers.length} synthetic, 0 human)`
      : `${humanTesters} third-party human account${humanTesters === 1 ? '' : 's'} exist${humanTesters === 1 ? 's' : ''} in users (${ownerUsers.length} owner-controlled, ${syntheticUsers.length} synthetic)`,
    `and the only non-synthetic activity in production is ${postsByClass.human} post${postsByClass.human === 1 ? '' : 's'} of ${postsByClass.total}${thirdPartyHumanPosts.length === 0 && postsByClass.human ? ", all by owner-controlled accounts" : ''}${humanToHumanThreads ? `; ${humanToHumanThreads} human-to-human DM thread${humanToHumanThreads === 1 ? '' : 's'}` : `; ${dmCount.n} DM thread${dmCount.n === 1 ? '' : 's'}, none human-to-human`}.`,
    `The accessible feedback collections contain testFeedback ${fb.testFeedback.n}, feedback ${fb.feedback.n}, reports ${fb.reports.n} and betaSignups ${fb.betaSignups.n} records; no feedback text was retrieved.`,
    `Firebase Analytics is ${analytics.projectLinked ? `linked (property ${analytics.propertyId}, ${analytics.streams} streams)` : 'of unknown link state'} but client delivery has not been verified by this report, so the events-ever-sent figure is unknown, not zero.`,
    simulation.ranInWindow
      ? `The synthetic cohort was active in the last ${WINDOW_HOURS} h: ${fmt(eventsWindowCount.n)} synthetic browser events across ${sessionsWindowCount.n} session${sessionsWindowCount.n === 1 ? '' : 's'} and ${actorsSeen.length} actor${actorsSeen.length === 1 ? '' : 's'}, ${syntheticPostsInWindow} synthetic post${syntheticPostsInWindow === 1 ? '' : 's'} created${newestEventAt ? `, newest event ${newestEventAt}` : ''}.`
      : `The synthetic cohort did not run in the last ${WINDOW_HOURS} h (0 synthetic browser events, 0 synthetic posts).`,
    `${popsMoved} pop${popsMoved === 1 ? '' : 's'} moved in the window (${fmt(entriesInWindow)} radiusHistory entries: ${RADIUS_CAUSES.filter(c => byCause[c]).map(c => `${c} ${byCause[c]}`).join(', ') || 'none'}).`,
    rs.known ? `The runner is ${runner.status}${runner.error ? ` ("${runner.error}")` : ''}.` : 'The runner state is unknown.',
  ].join(' ');

  // ---- gaps ---------------------------------------------------------------
  const gaps = [
    `Firebase Analytics: ${analytics.projectLinked ? `the project is linked (property ${analytics.propertyId})` : 'link state unknown'}, but client delivery has not been verified by this report and the GA4 Data API was not queried (the ADC token lacks analytics.readonly), so events ever sent is 'unknown', not 0; DAU, retention, screen-view, funnel and crash figures were not retrieved.`,
    `No human feedback text was retrieved: testFeedback ${fb.testFeedback.n}, feedback ${fb.feedback.n}, reports ${fb.reports.n}, betaSignups ${fb.betaSignups.n}; invite-email replies, if any, live only in the owner's inbox; TestFlight feedback ${ascFound.length ? 'was not pulled' : 'is unreachable without an App Store Connect key'}.`,
    humanTesters === 0
      ? `Human activity is ${postsByClass.human} post${postsByClass.human === 1 ? '' : 's'} by owner-controlled accounts; no third-party human account exists in users, so "how users are using the app" cannot be described beyond that.`
      : `${humanTesters} third-party human account${humanTesters === 1 ? '' : 's'} exist${humanTesters === 1 ? 's' : ''}; their activity is ${thirdPartyHumanPosts.length} post${thirdPartyHumanPosts.length === 1 ? '' : 's'}.`,
    `${consentCount.n} of ${usersCount.n} users have testActivityConsent = true and testActivity holds ${testActivityCount.n} documents, so the Test Center's tester-activity panels have ${testActivityCount.n ? 'few' : 'never had a'} human row${testActivityCount.n === 1 ? '' : 's'}.`,
    logExists ? (timestamped ? 'Runner-log counts are limited to lines with a timestamp inside the window.' : 'The runner log carries no timestamps, so its grep counts are all-time, not the 24 h window.') : 'The runner log is absent, so the step-failure counts are unknown.',
    `radiusHistory has no collection-group index on atMillis, so the window was filtered in code over ${fmt(history.docs.length)} of ${fmt(historyCount.n)} entries${history.capped ? ' (capped — window figures are lower bounds)' : ''}.`,
    'The App Review rejection survives only as a developer paraphrase (seed-official-posts.mjs); the guideline number and Resolution Center thread are not stored.',
    `Like and view counts on official (${fmt(eng.official.likes)} likes) and cohort (${fmt(eng.cohort.likes)} likes) posts are seeded or simulation-driven; they must not be read as human engagement.`,
    'Whether the hold-menu failures reflect a human discoverability problem or a runner selector problem is undetermined.',
  ];
  if (portStatus[8084] === '000') gaps.push('The Test Center page (8084) was down, so its rendered dashboard was not inspected; this report is built from the same collections it reads.');
  if (!rs.known) gaps.push(`The synthetic runner's state is unknown (${rs.why}).`);
  if (eventsWindow.capped) gaps.push(`Windowed synthetic events were capped at ${EVENT_CAP} of ${fmt(eventsWindowCount.n)}; actorsSeen may be incomplete.`);

  // ---- previous -----------------------------------------------------------
  mkdirSync(outDir, { recursive: true });
  const earlier = readdirSync(outDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).filter(d => d < reportDate).sort();
  let previous = { date: null, diffs: [] };
  if (earlier.length) {
    const prevDate = earlier[earlier.length - 1];
    try {
      const prev = JSON.parse(readFileSync(path.join(outDir, `${prevDate}.json`), 'utf8'));
      const diffs = [];
      const prevTiles = new Map((prev.tiles || []).map(t => [t.key, t]));
      for (const t of tiles) {
        const before = prevTiles.get(t.key);
        if (before && String(before.value) !== String(t.value)) diffs.push({ label: t.label, before: String(before.value), after: String(t.value) });
      }
      const prevNumbers = new Map((prev.numbers || []).map(n => [n.label, n.value]));
      for (const n of numbers) {
        if (prevNumbers.has(n.label) && prevNumbers.get(n.label) !== n.value) diffs.push({ label: n.label, before: prevNumbers.get(n.label), after: n.value });
      }
      previous = { date: prevDate, diffs };
    } catch (e) {
      previous = { date: prevDate, diffs: [] };
      console.error(`warning: could not diff against ${prevDate}.json (${e.message})`);
    }
  }

  // ---- report -------------------------------------------------------------
  const report = {
    schemaVersion: 1,
    date: reportDate,
    generatedAt: now.toISOString(),
    generatedAtLocal: localLong(now),
    project: PROJECT,
    tiles,
    answer,
    services,
    runner,
    simulation,
    postsByClass,
    accounts,
    engagementByClass,
    radiusMoves,
    analytics,
    feedback,
    signals,
    gaps,
    numbers,
    previous,
    proposals: [],
  };
  const outFile = path.join(outDir, `${reportDate}.json`);
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  const tileLine = tiles.map(t => `${t.key}=${t.value}`).join(' ');
  console.log(`test-center-report ${reportDate} (${report.generatedAtLocal}; window = last ${WINDOW_HOURS} h from now): wrote ${outFile} — ${tileLine}; runner ${runner.status}; ${numbers.length} numbers; previous ${previous.date || 'none'}${previous.diffs.length ? ` (${previous.diffs.length} diffs)` : ''}`);
}

main().catch(error => {
  console.error(`gather failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
