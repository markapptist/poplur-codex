import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = '/Users/matrix/Developer'
const prototype = path.join(root, '.claude/artifacts/gcl-prototype.html')
const reportPath = path.join(root, '.codex/gcl-prototype-handoff-state.json')

function run(script, args = []) {
  const result = spawnSync(process.execPath, [path.join(root, script), ...args], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || `${script} failed`).trim())
  return String(result.stdout || '').trim()
}

const source = fs.readFileSync(prototype)
const mode = fs.statSync(prototype).mode & 0o777
if (mode & 0o222) throw new Error('Prototype handoff is blocked because the protected source is writable.')

const handedOffAt = new Date().toISOString()
run('.codex/sync-gcl-downstream.mjs', ['--force', '--quiet'])
run('.codex/generate-gcl-screen-tracking.mjs')
run('.codex/generate-gcl-catalog-data.mjs')

const report = {
  version: 1,
  protected: true,
  prototype: '.claude/artifacts/gcl-prototype.html',
  prototypeHash: crypto.createHash('sha256').update(source).digest('hex'),
  handedOffAt,
  commands: ['sync-gcl-downstream --force', 'generate-gcl-screen-tracking', 'generate-gcl-catalog-data'],
  summary: 'Known automated iOS, iPad, Android, Android Tablet, map, and catalog sync gates were refreshed; manual-parity platforms remain explicitly tracked by their existing reports.'
}
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ ok: true, ...report }))
