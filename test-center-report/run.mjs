#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, validate } from './render.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = '/Users/matrix/Developer/.claude/artifacts/test-center-reports'
const date = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date())
const result = spawnSync(process.execPath, [join(here, 'gather.mjs'), '--date', date, '--out', out], { stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status || 1)
const dataPath = join(out, `${date}.json`)
const data = JSON.parse(readFileSync(dataPath, 'utf8'))
const proposalsPath = join(out, `${date}.proposals.json`)
if (existsSync(proposalsPath)) {
  const saved = JSON.parse(readFileSync(proposalsPath, 'utf8'))
  if (saved.date !== date || !Array.isArray(saved.proposals)) throw new Error('Proposal date or format does not match this report')
  data.proposals = saved.proposals.map(({ title, why, evidence, change, risk }) => ({ title, why, evidence, change, risk }))
}
const errors = validate(data)
if (errors.length) throw new Error(errors.join('\n'))
const html = render(data)
writeFileSync(dataPath, JSON.stringify(data, null, 2) + '\n')
for (const name of [`${date}.html`, 'latest.html']) writeFileSync(join(out, name), html)
console.log(`Report ready: ${join(out, 'latest.html')}; ${data.proposals.length} proposals for review.`)
