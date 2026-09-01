#!/usr/bin/env node
// The governor's master switch exists in four places. They are meant to move
// together, and on 17 Aug they did — all four ON, which removed demand
// scheduling everywhere and let the phone heat at the rate the content costs.
// The danger now is the quieter failure: someone flips ONE for an experiment
// and the platforms silently disagree about whether the device is protected.
//
// Run before a release. Machine-local (like thermal-gate.mjs); no git owner.
import { readFileSync } from 'node:fs'

const DEV = '/Users/matrix/Developer'
const FLAGS = [
  { name: 'web    frameGovernor.ts',
    file: `${DEV}/poplur-clay-map/src/frameGovernor.ts`,
    re: /const\s+GOVERNOR_DISABLED\s*=\s*(true|false)/ },
  { name: 'iOS    PoplurPerformanceManager.swift',
    file: `${DEV}/Poplur2025-iOS/Poplur2025/PoplurPerformanceManager.swift`,
    re: /static\s+let\s+governorDisabled\s*=\s*(true|false)/ },
  { name: 'Android PoplurPerformanceManager.kt',
    file: `${DEV}/Poplur2025-Android/performance/src/main/java/com/apptists/poplur/performance/PoplurPerformanceManager.kt`,
    re: /const\s+val\s+GOVERNOR_DISABLED\s*=\s*(true|false)/ },
]

const found = FLAGS.map(f => {
  let value = 'UNREADABLE'
  try { value = (readFileSync(f.file, 'utf8').match(f.re) ?? [])[1] ?? 'NOT FOUND' }
  catch { value = 'FILE MISSING' }
  return { ...f, value }
})

for (const f of found) console.error(`  ${f.name.padEnd(38)} ${f.value}`)

const values = new Set(found.map(f => f.value))
if (values.size > 1) {
  console.error('\n🔥 GOVERNOR PARITY FAILED — the platforms disagree.')
  console.error('   A device whose flag is `true` has no thermal ladder: no fps demotion on')
  console.error('   thermal/power/memory signal. Flip them together, or record why not.')
  process.exit(1)
}
if (found[0].value === 'true') {
  console.error('\n⚠️  All flags are DISABLED (true). Nothing masks quality at rest anymore,')
  console.error('   so this only removes device protection — the 14 Aug camera baseline was')
  console.error('   58s-to-fair without these brakes and 25min with them. Deliberate?')
  process.exit(1)
}
console.error('\ngovernor-parity: OK — all platforms governed.')
