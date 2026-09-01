#!/usr/bin/env node
// Source a reference photo for a landmark from Wikimedia Commons, with its
// licence checked BEFORE anything is downloaded.
//
// WHY NOT GOOGLE IMAGES: image-to-3D produces a derivative of its input, and
// that model would ship inside a commercial app. Search results are
// overwhelmingly copyrighted photographs, so the obvious pipeline quietly
// creates a licensing liability on an asset shown to every user. Commons
// carries machine-readable licence metadata, so the filter is exact rather
// than hopeful — and it is easier to automate than scraping a search page.
//
// TWO-STEP BY DESIGN. Licence and aspect ratio are checkable from metadata;
// "is the ENTIRE building in frame" is not, and that is the thing that decides
// whether the generated model looks like the landmark. Proof: the top-scoring
// CN Tower result was a black-and-white close-up of the pod and antenna with a
// neighbouring facade — perfect licence, perfect 3:2 portrait, useless as a
// reference. So shortlist, LOOK, then fetch by title:
//
//   node .codex/fetch-landmark-image.mjs "CN Tower" --shortlist 6 --out /tmp/shortlist
//   (inspect the thumbnails — reject anything cropped, nocturnal, or partial)
//   node .codex/fetch-landmark-image.mjs "CN Tower" --title "CN Tower, Toronto, Canada9.jpg" --out .codex/landmark-refs
//
// Writes <slug>.jpg plus <slug>.attribution.json, which travels with the model:
// CC-BY and CC-BY-SA REQUIRE attribution, and a credit nobody recorded is a
// licence nobody honoured.
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const subject = args.find(a => !a.startsWith('--'))
const dryRun = args.includes('--dry-run')
const shortlist = args.includes('--shortlist') ? Number(args[args.indexOf('--shortlist') + 1] || 6) : 0
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : '/tmp'
if (!subject) {
  console.error('usage: fetch-landmark-image.mjs "CN Tower" [--out DIR] [--dry-run]')
  process.exit(2)
}

// Wikimedia asks for a descriptive User-Agent and blocks generic ones.
const UA = 'PoplurLandmarkFetcher/1.0 (https://poplur.com; contact via app) node-fetch'
const API = 'https://commons.wikimedia.org/w/api.php'

/** Licences whose terms allow shipping a derivative in a commercial app.
 *  Deliberately excludes NonCommercial and NoDerivatives — both would forbid
 *  exactly what this image is for. */
const ALLOWED = [
  /^cc0/i, /^public domain/i, /^pd/i,
  /^cc[- ]by([- ]sa)?([- ]\d)/i, /^cc[- ]by([- ]sa)?$/i,
]
const FORBIDDEN = [/nc\b/i, /noncommercial/i, /nd\b/i, /noderiv/i, /fair use/i, /non-free/i]

function licenceIsUsable(short) {
  if (!short) return false
  if (FORBIDDEN.some(re => re.test(short))) return false
  return ALLOWED.some(re => re.test(short))
}

const params = new URLSearchParams({
  action: 'query', format: 'json', origin: '*',
  generator: 'search',
  gsrsearch: `${subject} filetype:bitmap`,
  gsrnamespace: '6',          // File: namespace
  gsrlimit: '30',
  prop: 'imageinfo',
  iiprop: 'url|size|extmetadata|mime',
})
const res = await fetch(`${API}?${params}`, { headers: { 'user-agent': UA } })
if (!res.ok) { console.error(`Commons search failed: ${res.status}`); process.exit(1) }
const data = await res.json()
const pages = Object.values(data.query?.pages ?? {})
if (!pages.length) { console.error(`No Commons results for "${subject}".`); process.exit(1) }

const candidates = pages.map(page => {
  const info = page.imageinfo?.[0] ?? {}
  const meta = info.extmetadata ?? {}
  const licence = meta.LicenseShortName?.value ?? ''
  const strip = html => String(html ?? '').replace(/<[^>]*>/g, '').trim()
  return {
    title: page.title,
    url: info.url,
    width: info.width ?? 0,
    height: info.height ?? 0,
    mime: info.mime ?? '',
    licence,
    usable: licenceIsUsable(licence),
    artist: strip(meta.Artist?.value),
    credit: strip(meta.Credit?.value),
    usageTerms: strip(meta.UsageTerms?.value),
    descriptionUrl: info.descriptionurl,
  }
})
  .filter(c => c.url && /^image\/(jpeg|png)$/.test(c.mime))
  // Score for what image-to-3D actually needs, which is NOT "biggest" or
  // "most portrait". The first run of this script ranked a 9871x25148 stitched
  // panorama top: technically the most portrait image on Commons, and useless
  // as a reference because the subject is a sliver in a 1:2.5 frame.
  .map(c => {
    const ratio = c.height / Math.max(1, c.width)
    // A whole tower photographed cleanly lands near 3:2 portrait. Fall away
    // from that in both directions, and reject panoramas outright below.
    const shape = 1 - Math.min(1, Math.abs(ratio - 1.5) / 1.5)
    const pixels = c.width * c.height
    // Enough detail to matter, not so much that it is a stitched composite.
    const size = pixels >= 2_000_000 && pixels <= 60_000_000 ? 1 : 0.3
    // Night shots lose the silhouette and surface that the generator needs.
    const dark = /night|nacht|noche|sunset|dusk|illuminat|fireworks/i.test(c.title) ? 0.35 : 1
    return { ...c, ratio: Number(ratio.toFixed(2)), score: Number((shape * size * dark).toFixed(3)) }
  })
  .filter(c => c.ratio >= 0.8 && c.ratio <= 2.2)   // no panoramas, no letterboxes
  .sort((a, b) => b.score - a.score)

const usable = candidates.filter(c => c.usable)
console.log(`Commons returned ${candidates.length} image(s); ${usable.length} usable licence(s).\n`)
for (const c of candidates.slice(0, 8)) {
  console.log(` ${c.usable ? '✓' : '✗'} score ${String(c.score).padEnd(6)} ${c.licence.padEnd(16)} ${String(c.width)}x${String(c.height)} (${c.ratio}) ${c.title.replace(/^File:/, '').slice(0, 44)}`)
}
if (!usable.length) {
  console.error(`\nNothing with a licence that permits a commercial derivative. Do NOT fall back to a search engine — supply an image you own instead.`)
  process.exit(1)
}

const wantTitle = args.includes('--title') ? args[args.indexOf('--title') + 1] : null
const pick = wantTitle
  ? (usable.find(c => c.title.replace(/^File:/, '') === wantTitle.replace(/^File:/, '')) ?? usable[0])
  : usable[0]
const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
console.log(`\nchosen: ${pick.title}`)
console.log(`  licence: ${pick.licence}   ${pick.width}x${pick.height}`)
console.log(`  by:      ${pick.artist || 'unattributed'}`)
console.log(`  source:  ${pick.descriptionUrl}`)

if (dryRun) { console.log('\n--dry-run: nothing downloaded.'); process.exit(0) }

// --shortlist: thumbnails of the top N, for judging framing by eye. Licence and
// aspect ratio are checkable from metadata; "is the entire building in shot" is
// not, and a close-up of the pod scores identically to a full elevation.
if (shortlist > 0) {
  mkdirSync(outDir, { recursive: true })
  const picks = usable.slice(0, shortlist)
  for (const [i, c] of picks.entries()) {
    const thumb = `${API}?${new URLSearchParams({
      action: 'query', format: 'json', titles: c.title,
      prop: 'imageinfo', iiprop: 'url', iiurlwidth: '640',
    })}`
    const meta = await (await fetch(thumb, { headers: { 'user-agent': UA } })).json()
    const url = Object.values(meta.query?.pages ?? {})[0]?.imageinfo?.[0]?.thumburl
    if (!url) continue
    const img = await fetch(url, { headers: { 'user-agent': UA } })
    if (!img.ok) continue
    const file = join(outDir, `candidate-${i + 1}.jpg`)
    writeFileSync(file, Buffer.from(await img.arrayBuffer()))
    console.log(`candidate-${i + 1}.jpg  ${c.licence}  ${c.width}x${c.height}  ${c.title.replace(/^File:/, '')}`)
  }
  writeFileSync(join(outDir, 'candidates.json'), JSON.stringify(picks, null, 2) + '\n')
  console.log(`\nwrote ${picks.length} thumbnails to ${outDir} — inspect, then fetch the chosen one by title.`)
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
const image = await fetch(pick.url, { headers: { 'user-agent': UA } })
if (!image.ok) { console.error(`download failed: ${image.status}`); process.exit(1) }
const bytes = Buffer.from(await image.arrayBuffer())
const ext = pick.mime === 'image/png' ? 'png' : 'jpg'
const imagePath = join(outDir, `${slug}.${ext}`)
writeFileSync(imagePath, bytes)
writeFileSync(join(outDir, `${slug}.attribution.json`), JSON.stringify({
  subject, title: pick.title, licence: pick.licence, usageTerms: pick.usageTerms,
  artist: pick.artist, credit: pick.credit, source: pick.descriptionUrl,
  fetchedAt: new Date().toISOString(),
  note: 'Attribution must ship with any model derived from this image.',
}, null, 2) + '\n')
console.log(`\nwrote ${imagePath} (${(bytes.length / 1024).toFixed(0)} KB)`)
console.log(`wrote ${join(outDir, `${slug}.attribution.json`)}`)
