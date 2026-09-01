// Coarse perceptual image comparison for screen-parity checks.
//
// A native render and an HTML Good Copy mock never match pixel-for-pixel — text
// rasterisation and antialiasing differ — so an exact diff would fail on every run.
// This downscales both images to a small grid and compares block averages, which
// tolerates rasterisation noise while still catching gross drift (a missing
// backdrop, a wrong hue, a vanished map).
//
// !! DO NOT USE THIS AS A PASS/FAIL GATE. IT DOES NOT WORK FOR THE WELCOME REGRESSION. !!
//
// Measured 2026-07-17 against the known-bad (79c31e7, ticket deleted) and known-good
// (29226d3, ticket restored) Android renders, versus the good-copy-welcome backdrop:
//
//   whole screen : broken 0.1054  vs  fixed 0.1029   -> NO separation
//   top region   : broken 0.0582  vs  fixed 0.0440   -> both below 0.10, both "pass"
//
// A gate built on these numbers would have passed the exact regression it was written
// for. An earlier apparent separation (0.1251 vs 0.0641, against the prototype's
// welbanner) was an artifact of comparing against a differently-cropped image, not a
// working signal.
//
// Why it fails, structurally:
//   * There is no full-composition reference. Good Copy stores the BACKDROP asset
//     (885x1701 ticket); the live screen adds a logo, a cube and two large white
//     buttons that dominate any whole-screen average.
//   * The regression is fine dot TEXTURE (corner continents present vs absent).
//     Downscaling to block averages erases exactly that. Local-variance was also tried:
//     reference 0, broken 1.144, fixed 1.191 -> also no separation.
//
// This file is retained only as a coarse "is this obviously a different picture"
// helper (e.g. blank/black screen detection). Judging screen parity needs either a
// real SSIM at full resolution (requires an image library not present offline) or a
// human/vision review of the captured render. See verify-screen-parity.mjs, which
// captures evidence for review rather than pretending to a verdict.
//
// PNG decode is done via `sips` (macOS built-in) to raw RGBA; no npm deps, so this
// keeps working offline and in cron.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const GRID_W = 16
const GRID_H = 32

function toRawRgba(imagePath, w, h) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-'))
  const png = path.join(tmp, 'small.png')
  const res = spawnSync('sips', ['-z', String(h), String(w), '-s', 'format', 'png', imagePath, '--out', png], { encoding: 'utf8' })
  if (res.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true })
    throw new Error(`sips failed for ${imagePath}: ${res.stderr || res.stdout}`)
  }
  // Decode the resized PNG via sips -> TIFF-less raw path: use `sips --getProperty` is not
  // enough, so shell out to a tiny swift-free decoder: `sips` can emit BMP which is trivial.
  const bmp = path.join(tmp, 'small.bmp')
  const res2 = spawnSync('sips', ['-s', 'format', 'bmp', png, '--out', bmp], { encoding: 'utf8' })
  if (res2.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true })
    throw new Error(`sips bmp failed for ${imagePath}: ${res2.stderr || res2.stdout}`)
  }
  const buf = fs.readFileSync(bmp)
  fs.rmSync(tmp, { recursive: true, force: true })
  return decodeBmp(buf)
}

// Minimal BMP reader: handles the uncompressed 24/32-bit BI_RGB output sips produces.
function decodeBmp(buf) {
  if (buf.readUInt16LE(0) !== 0x4d42) throw new Error('not a BMP')
  const dataOffset = buf.readUInt32LE(10)
  const width = buf.readInt32LE(18)
  const height = buf.readInt32LE(22)
  const bpp = buf.readUInt16LE(28)
  if (bpp !== 24 && bpp !== 32) throw new Error(`unsupported BMP bpp ${bpp}`)
  const bytesPP = bpp / 8
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4
  const flip = height > 0
  const h = Math.abs(height)
  const out = new Float64Array(width * h * 3)
  for (let y = 0; y < h; y++) {
    const srcY = flip ? h - 1 - y : y
    let off = dataOffset + srcY * rowSize
    for (let x = 0; x < width; x++) {
      const b = buf[off], g = buf[off + 1], r = buf[off + 2]
      const i = (y * width + x) * 3
      out[i] = r; out[i + 1] = g; out[i + 2] = b
      off += bytesPP
    }
  }
  return { width, height: h, data: out }
}

/**
 * Compare two images. Returns { distance, verdict, channels }.
 * distance is a normalised 0..1 mean block difference across RGB.
 */
export function compareImages(actualPath, referencePath, { gridW = GRID_W, gridH = GRID_H } = {}) {
  const a = toRawRgba(actualPath, gridW, gridH)
  const b = toRawRgba(referencePath, gridW, gridH)
  const n = Math.min(a.data.length, b.data.length)
  if (n === 0) throw new Error('empty image data')

  let sum = 0
  const perChannel = [0, 0, 0]
  for (let i = 0; i < n; i += 3) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[i + c] - b.data[i + c]) / 255
      sum += d
      perChannel[c] += d
    }
  }
  const count = n / 3
  const distance = sum / (count * 3)
  const channels = perChannel.map(v => +(v / count).toFixed(4))

  let verdict
  if (distance < 0.10) verdict = 'match'
  else if (distance <= 0.22) verdict = 'drift'
  else verdict = 'mismatch'

  return { distance: +distance.toFixed(4), verdict, channels, grid: `${gridW}x${gridH}` }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [actual, reference] = process.argv.slice(2)
  if (!actual || !reference) {
    console.error('usage: screen-parity-compare.mjs <actual.png> <reference.png>')
    process.exit(2)
  }
  console.log(JSON.stringify(compareImages(actual, reference), null, 2))
}
