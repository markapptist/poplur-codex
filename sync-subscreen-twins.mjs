#!/usr/bin/env node
// Copies the Rough Copy subscreen twins into the clay-map bundle so the hold
// menu can open them on a phone.
//
// The app's web home is served from poplur-clay://app out of the built dist,
// which has no artifact server behind it — so a tile that embeds
// `.claude/artifacts/poplur-subscreen-twins.html` finds nothing there and the
// screen goes black. Shipping a copy inside the bundle is what makes those
// screens exist on device at all.
//
// Only three files are needed. Every image in the twins is already an inline
// data URI, and in embed mode the sidebar and the refresh bar are hidden — so
// the 1.6 MB logo and the 1 MB GCL catalog are dropped. The catalog is read
// as `window.GCL_CATALOG_DATA?.generatedAt`, so its absence is safe.
//
// READ-ONLY on Rough Copy: this copies, it never writes back. Re-run it after
// Rough Copy regenerates, or the bundled copy silently goes stale.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, '.claude/artifacts')
const out = join(root, 'poplur-clay-map/public/subscreens')

mkdirSync(out, { recursive: true })

// The twins draw an iPhone: a status bar with a fake time, and a Dynamic
// Island. That is right on a desktop, where the frame is the point. Inside the
// app it runs ON a phone that already has both — a notch drawn inside the real
// notch, with a clock that disagrees with the real one two millimetres above
// it. Both are absolutely positioned overlays and .screen is inset:0, so
// dropping them moves no content: every captured screen reserves its own top
// space. Bundled copy only; the artifact keeps its frame.
const css = readFileSync(join(src, 'poplur-subscreen-twins.css'), 'utf8')
  + '\n\n/* --- bundled copy: the phone is real, so it brings its own --- */\n'
  + 'body.embed .status,\nbody.embed .island { display: none !important; }\n'
writeFileSync(join(out, 'poplur-subscreen-twins.css'), css)

// The twins reach out of the artifact folder for their icons — up into the
// iOS asset catalog and into the clay map's public dir. Neither is reachable
// from inside the bundle, so carry the iOS ones along and re-point both roots.
// `ios()` composes `<set>.imageset/<file>`, so that shape has to survive.
let js = readFileSync(join(src, 'poplur-subscreen-twins.js'), 'utf8')

const iosRoot = "'../../Poplur2025-iOS/Poplur2025/Assets.xcassets/'"
const clayRoot = "'../../poplur-clay-map/public/'"
if (!js.includes(iosRoot) || !js.includes(clayRoot)) {
  console.error('sync-subscreen-twins: the twins asset roots changed — update this script')
  process.exit(1)
}
// public/ IS the bundle root, one level up from subscreens/.
js = js.replace(iosRoot, "'assets/'").replace(clayRoot, "'../'")

const catalog = join(root, 'Poplur2025-iOS/Poplur2025/Assets.xcassets')

// Don't try to model how the twins build their paths. Only some go through
// `ios('set', 'file')`; others are assembled at runtime from names sitting in
// data tables (`create_ic_${name}`, the bling phone finishes). Chasing each
// pattern means missing one and shipping a broken image to a phone, where
// nobody can open a console to find out why.
//
// Instead: an imageset ships if the twins mention its name anywhere. Match on
// a quoted or path-delimited boundary so a short name can't match half a word,
// and take the whole imageset — spritesheets and @2x variants included.
const wanted = new Set()
for (const dir of readdirSync(catalog)) {
  if (!dir.endsWith('.imageset')) continue
  const name = dir.slice(0, -'.imageset'.length)
  const boundary = new RegExp(`['"\`/]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`./]`)
  if (!boundary.test(js)) continue
  for (const file of readdirSync(join(catalog, dir))) {
    if (file !== 'Contents.json') wanted.add(`${dir}/${file}`)
  }
}

// Naming an imageset is not the same as showing it, so heavy art is capped and
// the skips are printed: a cap nobody is told about reads as "everything
// shipped" right up until an image is missing on a device.
const MAX_BYTES = 1_200_000
// Over the cap but genuinely on screen.
//
// PHONE is the reason this list is not just silver. The screen steps through
// ten bling finishes, and each step plays that finish's boot spritesheet before
// revealing its resting image — so shipping only the first finish meant nine of
// the ten colours showed nothing at all in the app. (The earlier assumption
// here was that the other nine "wait for a tap the twins don't get"; they do
// get that tap, from a user browsing colours.) ~41 MB for the full set: 16.6 MB
// of finishes, 24.5 MB of boot sheets.
const PHONE_COLOURWAY = /^poplur_(bling_phone_\d+|phone_bootup)_/
const KEEP = new Set([
  // The logo bug every feed screen stamps in its corner (feedBase).
  'logo_rubber.imageset/logo_rubber.png',
])
const keep = rel => KEEP.has(rel) || PHONE_COLOURWAY.test(rel.split('/')[0])
let bytes = 0
const skipped = []
for (const rel of wanted) {
  const from = join(catalog, rel)
  const size = statSync(from).size
  if (size > MAX_BYTES && !keep(rel)) {
    skipped.push(`${rel} (${(size / 1048576).toFixed(1)} MB)`)
    continue
  }
  const dest = join(out, 'assets', rel)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(from, dest)
  bytes += size
}
if (skipped.length) {
  console.log(`sync-subscreen-twins: skipped ${skipped.length} files over ${MAX_BYTES / 1e6} MB:`)
  for (const s of skipped) console.log(`  - ${s}`)
}

writeFileSync(join(out, 'poplur-subscreen-twins.js'), js)
console.log(`sync-subscreen-twins: ${wanted.size} icons, ${(bytes / 1048576).toFixed(2)} MB`)

// Strip what only the standalone artifact page needs: the refresh bar's data
// scripts and the sidebar's logo. Both are invisible in embed mode and cost
// 2.6 MB between them.
const html = readFileSync(join(src, 'poplur-subscreen-twins.html'), 'utf8')
  .replace(/^\s*<script src="\.\/gcl-(refresh-meta|catalog-data)\.js"><\/script>\n/gm, '')
  .replace(/^\s*<img src="\.\.\/\.\.\/[^"]*logo_rubber\.png" alt="" \/>\n/gm, '')

if (html.includes('gcl-catalog-data.js') || html.includes('logo_rubber.png')) {
  console.error('sync-subscreen-twins: the artifact markup changed — update the strip rules')
  process.exit(1)
}

writeFileSync(join(out, 'index.html'), html)
console.log(`sync-subscreen-twins: wrote ${out}`)
