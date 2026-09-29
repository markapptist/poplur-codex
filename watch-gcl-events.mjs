#!/usr/bin/env node
import { readdirSync, readFileSync, watch } from 'node:fs';
import { appendFile, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = '/Users/matrix/Developer';
const syncScript = `${root}/.codex/watch-gcl-on-change.sh`;
const logPath = `${root}/.codex/gcl-change-sync.log`;
const goodCopyFile = /^good-copy.*\.html$/;
// The sync script records gcl-watch-hashes only once Codex has taken a change
// and exits non-zero otherwise, so a failed wake-up is retried on this schedule
// rather than waiting for the next Good Copy edit.
const retryDelays = [10 * 60_000, 60 * 60_000, 6 * 60 * 60_000];

let debounceTimer;
let retryTimer;
let failures = 0;
// Digest of the Good Copy content whose wake-up failed. Change events that leave
// it unchanged (such as the failed run's own chmods) wait for the retry schedule;
// re-running on them would wake Codex in a loop.
let failedDigest = null;
let running = false;
let queued = false;
let queuedRetry = false;

function goodCopyDigest() {
  try {
    const hash = createHash('sha256');
    for (const name of readdirSync(root).filter((entry) => goodCopyFile.test(entry)).sort()) {
      hash.update(name).update(readFileSync(`${root}/${name}`));
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

function schedule() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runSync, 30_000);
}

async function runSync(retry = false) {
  if (running) {
    queued = true;
    queuedRetry ||= retry;
    return;
  }
  const digest = goodCopyDigest();
  if (!retry && failedDigest && digest === failedDigest) return;

  running = true;
  clearTimeout(retryTimer);
  const log = await open(logPath, 'a');
  const child = spawn('/bin/zsh', [syncScript], {
    detached: false,
    stdio: ['ignore', log.fd, log.fd],
  });

  child.once('exit', async (code, signal) => {
    await log.close();
    running = false;
    if (code === 0) {
      failures = 0;
      failedDigest = null;
    } else {
      if (digest !== failedDigest) failures = 0;
      failedDigest = digest;
      let note = 'no retries left; waiting for the next Good Copy change';
      if (failures < retryDelays.length) {
        note = `retry ${failures + 1}/${retryDelays.length} in ${retryDelays[failures] / 60_000} min`;
        retryTimer = setTimeout(runSync, retryDelays[failures++], true);
      }
      await appendFile(
        logPath,
        `[${new Date().toISOString()}] GCL watcher: sync exited ${code ?? signal}; ${note}\n`,
      ).catch(() => {});
    }
    if (queued) {
      const retryNext = queuedRetry;
      queued = false;
      queuedRetry = false;
      if (retryNext) runSync(true);
      else schedule();
    }
  });
}

watch(root, { persistent: true }, (_eventType, filename) => {
  if (typeof filename === 'string' && goodCopyFile.test(filename)) {
    schedule();
  }
});
