const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { chromium } = require('playwright')

const workspace = '/Users/matrix/Developer'
const catalogPath = path.join(workspace, '.claude/artifacts/rcl-screen-catalog.js')
const refreshPath = path.join(workspace, '.claude/artifacts/rcl-refresh-meta.json')
const captureStateDir = path.join(workspace, '.codex/artifact-workbench')
const captureLockPath = path.join(captureStateDir, 'rcl-capture.lock')
const captureOwnerPath = path.join(captureLockPath, 'owner.json')
const missingOnly = process.argv.includes('--missing')
const captureLabels = new Set(
  String(process.env.RCL_CAPTURE_LABELS || '')
    .split(',')
    .map(label => label.trim())
    .filter(Boolean)
)
const captureConcurrency = Number(process.env.RCL_CAPTURE_CONCURRENCY || 1)
const operationTimeoutMs = Number(process.env.RCL_CAPTURE_OPERATION_TIMEOUT_MS || 15000)
const taskTimeoutMs = Number(process.env.RCL_CAPTURE_TASK_TIMEOUT_MS || 45000)
const runTimeoutMs = Number(process.env.RCL_CAPTURE_RUN_TIMEOUT_MS || 900000)
const lockWaitTimeoutMs = Number(process.env.RCL_CAPTURE_LOCK_WAIT_TIMEOUT_MS || runTimeoutMs)
const ownerlessLockGraceMs = 5000

let ownsCaptureLock = false

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function releaseCaptureLock() {
  if (!ownsCaptureLock) return
  ownsCaptureLock = false
  fs.rmSync(captureLockPath, { recursive: true, force: true })
}

function lockState() {
  let stats = null
  try {
    stats = fs.statSync(captureLockPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing'
    throw error
  }

  let owner = null
  try {
    owner = JSON.parse(fs.readFileSync(captureOwnerPath, 'utf8'))
  } catch {}
  if (Number.isInteger(Number(owner?.pid)) && Number(owner.pid) > 0) {
    return processIsRunning(Number(owner.pid)) ? 'active' : 'stale'
  }
  return Date.now() - stats.mtimeMs < ownerlessLockGraceMs ? 'active' : 'stale'
}

async function acquireCaptureLock() {
  fs.mkdirSync(captureStateDir, { recursive: true })
  const deadline = Date.now() + lockWaitTimeoutMs
  while (true) {
    try {
      fs.mkdirSync(captureLockPath)
      ownsCaptureLock = true
      fs.writeFileSync(captureOwnerPath, JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        mode: missingOnly ? 'missing' : 'full'
      }, null, 2) + '\n')
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const state = lockState()
      if (state === 'missing') continue
      if (state === 'stale') {
        fs.rmSync(captureLockPath, { recursive: true, force: true })
        continue
      }
      if (missingOnly) {
        console.log('RCL preview capture already running; skipping overlapping missing-only job.')
        return false
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting ${lockWaitTimeoutMs}ms for the RCL preview capture lock.`)
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
}

process.on('exit', releaseCaptureLock)

function loadTasks() {
  const sandbox = { window: {} }
  vm.runInNewContext(fs.readFileSync(catalogPath, 'utf8'), sandbox)
  const tasksByPoster = new Map()
  for (const surface of sandbox.window.RCL_SCREEN_CATALOG?.surfaces || []) {
    if (surface.kind) continue
    for (const screen of surface.screens || []) {
      if (!screen.posterPath || !screen.src) continue
      if (captureLabels.size && !captureLabels.has(screen.label)) continue
      const output = path.join(workspace, screen.posterPath)
      if (missingOnly && fs.existsSync(output)) continue
      tasksByPoster.set(output, {
        output,
        url: screen.src,
        label: screen.label,
        width: surface.sourceWidth,
        height: surface.sourceHeight
      })
    }
  }
  return [...tasksByPoster.values()]
}

async function capture(browser, task) {
  fs.mkdirSync(path.dirname(task.output), { recursive: true })
  const page = await browser.newPage({
    viewport: { width: task.width, height: task.height },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce'
  })
  page.setDefaultTimeout(operationTimeoutMs)
  page.setDefaultNavigationTimeout(operationTimeoutMs)
  await page.addInitScript(() => {
    window.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('audio, video').forEach(media => {
        media.muted = true
        media.volume = 0
      })
    })
  })

  let timedOut = false
  let deadlineTimer = null
  const work = (async () => {
    try {
      await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: operationTimeoutMs })
      await page.waitForTimeout(1200)
      await page.evaluate(() => {
        document.querySelectorAll('audio, video').forEach(media => {
          media.muted = true
          media.volume = 0
          media.pause?.()
        })
        const style = document.createElement('style')
        style.textContent = '*,*::before,*::after{animation-play-state:paused!important;caret-color:transparent!important}'
        document.head.appendChild(style)
      })
      await page.screenshot({ path: task.output, type: 'png', timeout: operationTimeoutMs })
    } catch (error) {
      if (timedOut) throw error
      console.warn(`Using fallback preview for ${task.label}: ${error.message}`)
      const safeLabel = task.label.replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[character])
      await page.setContent(`<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:#18080c;color:#fff7fb;font-family:system-ui;display:grid;place-items:center}main{padding:32px;text-align:center}b{display:block;color:#ff7e9a;font-size:12px;letter-spacing:.12em;text-transform:uppercase}h1{font-size:36px;letter-spacing:0}</style><main><b>Rough Copy</b><h1>${safeLabel}</h1></main>`)
      await page.screenshot({ path: task.output, type: 'png', timeout: operationTimeoutMs })
    }
  })()
  const deadline = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => {
      timedOut = true
      void page.close({ runBeforeUnload: false }).catch(() => {})
      reject(new Error(`Timed out after ${taskTimeoutMs}ms capturing ${task.label}.`))
    }, taskTimeoutMs)
  })

  try {
    await Promise.race([work, deadline])
  } finally {
    clearTimeout(deadlineTimer)
    await Promise.race([
      page.close({ runBeforeUnload: false }).catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 5000))
    ])
  }
}

async function runWithDeadline(work, browser) {
  let timer = null
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      void browser.close().catch(() => {})
      reject(new Error(`Timed out after ${runTimeoutMs}ms capturing RCL previews.`))
    }, runTimeoutMs)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  if (!await acquireCaptureLock()) return
  let browser = null
  try {
    const tasks = loadTasks()
    if (!tasks.length) {
      console.log('RCL static previews are current.')
      return
    }

    browser = await chromium.launch({
      headless: true,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    })
    let nextTask = 0
    const worker = async () => {
      while (nextTask < tasks.length) {
        const task = tasks[nextTask]
        nextTask += 1
        await capture(browser, task)
      }
    }
    const workers = Promise.all(Array.from({ length: Math.min(captureConcurrency, tasks.length) }, worker))
    await runWithDeadline(workers, browser)
    // rough-copy-live.html seeds its generation from the catalog and polls the refresh
    // meta, reloading on any mismatch. Stamping one without the other leaves the two
    // permanently unequal, which reloads the page every poll forever. Move both together.
    const capturedAt = new Date().toISOString()
    if (fs.existsSync(refreshPath)) {
      const refresh = JSON.parse(fs.readFileSync(refreshPath, 'utf8'))
      refresh.generatedAt = capturedAt
      fs.writeFileSync(refreshPath, JSON.stringify(refresh, null, 2) + '\n')
    }
    if (fs.existsSync(catalogPath)) {
      const catalogSource = fs.readFileSync(catalogPath, 'utf8')
      const stamped = catalogSource.replace(
        /("generatedAt":\s*)"[^"]*"/,
        `$1${JSON.stringify(capturedAt)}`
      )
      if (stamped !== catalogSource) fs.writeFileSync(catalogPath, stamped)
    }
    console.log(`Captured ${tasks.length} RCL static previews.`)
  } finally {
    if (browser) {
      await Promise.race([
        browser.close().catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 5000))
      ])
    }
    releaseCaptureLock()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
