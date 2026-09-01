#!/usr/bin/env node

import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const ROOT = '/Users/matrix/Developer'
const REPORT = `${ROOT}/.codex/physical-parity-report.json`
const ANDROID_ADB = `${ROOT}/../Library/Android/sdk/platform-tools/adb`
const ANDROID_PACKAGE = 'com.apptists.poplur2025'
const IOS_BUNDLE = 'com.apptist.Poplur2025'
const IOS_DEVICE = process.env.IOS_DEVICE_CORE_ID || '339089BF-8115-5788-B719-5967E503A27B'

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || '')
  }
}

function firstMatch(text, pattern) {
  const match = text.match(pattern)
  return match ? match[1] : null
}

function androidExpectedVersion() {
  const build = fs.readFileSync(`${ROOT}/Poplur2025-Android/app/build.gradle.kts`, 'utf8')
  return firstMatch(build, /versionCode\s*=\s*(\d+)/)
}

function androidGate() {
  const devices = run(ANDROID_ADB, ['devices']).stdout
  const serial = devices.split('\n').map(line => line.match(/^([^\s]+)\s+device$/)).find(Boolean)?.[1] || null
  if (!serial) return { status: 'blocked', reason: 'no authorized Android device' }

  const packageInfo = run(ANDROID_ADB, ['-s', serial, 'shell', 'dumpsys', 'package', ANDROID_PACKAGE]).stdout
  const installedVersion = firstMatch(packageInfo, /versionCode=(\d+)/)
  const launcherOutput = run(ANDROID_ADB, ['-s', serial, 'shell', 'cmd', 'package', 'query-activities', '--components', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER']).stdout
  const launchers = launcherOutput.split('\n').map(line => line.trim()).filter(line => line.startsWith(`${ANDROID_PACKAGE}/`))
  const expectedVersion = androidExpectedVersion()
  if (!installedVersion) return { status: 'blocked', serial, reason: 'Android package is not installed' }
  if (expectedVersion && installedVersion !== expectedVersion) {
    return { status: 'stale', serial, expectedVersion, installedVersion, reason: 'installed Android versionCode does not match main' }
  }
  if (launchers.length !== 1 || launchers[0] !== `${ANDROID_PACKAGE}/.MainActivity`) {
    return { status: 'stale', serial, expectedVersion, installedVersion, launchers, reason: 'Android launcher is not the single production MainActivity entry' }
  }
  return { status: 'current', serial, expectedVersion, installedVersion, launchers }
}

function iosExpectedVersion() {
  const project = fs.readFileSync(`${ROOT}/Poplur2025-iOS/Poplur2025.xcodeproj/project.pbxproj`, 'utf8')
  return firstMatch(project, /CURRENT_PROJECT_VERSION\s*=\s*(\d+)\s*;/)
}

function iosGate() {
  const apps = run('xcrun', ['devicectl', 'device', 'info', 'apps', '--device', IOS_DEVICE])
  const row = apps.stdout.split('\n').find(line => line.includes(IOS_BUNDLE)) || ''
  const installedVersion = row ? firstMatch(row, new RegExp(`${IOS_BUNDLE}\\s+\\S+\\s+(\\d+)`)) : null
  const lock = run('xcrun', ['devicectl', 'device', 'info', 'lockState', '--device', IOS_DEVICE])
  const passcodeRequired = /passcodeRequired:\s*true/i.test(lock.stdout)
  const expectedVersion = iosExpectedVersion()
  if (!row || !installedVersion) return { status: 'blocked', expectedVersion, reason: `iOS app ${IOS_BUNDLE} is not installed or device is unavailable` }
  if (passcodeRequired) {
    return { status: 'blocked', expectedVersion, installedVersion, reason: 'iOS device is passcode-locked; build/install cannot be verified' }
  }
  if (expectedVersion && installedVersion !== expectedVersion) {
    return { status: 'stale', expectedVersion, installedVersion, reason: 'installed iOS CFBundleVersion does not match main' }
  }
  return { status: 'current', expectedVersion, installedVersion }
}

const report = {
  generatedAt: new Date().toISOString(),
  source: 'main project build numbers and physical device package metadata',
  android: androidGate(),
  ios: iosGate()
}
report.status = report.android.status === 'current' && report.ios.status === 'current' ? 'current' : 'blocked-or-stale'
fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
process.exitCode = report.status === 'current' ? 0 : 1
