#!/usr/bin/env node
import { watch } from 'node:fs';
import { open } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const root = '/Users/matrix/Developer';
const syncScript = `${root}/.codex/watch-gcl-on-change.sh`;
const logPath = `${root}/.codex/gcl-change-sync.log`;

let debounceTimer;
let running = false;
let queued = false;

function schedule() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runSync, 30_000);
}

async function runSync() {
  if (running) {
    queued = true;
    return;
  }

  running = true;
  const log = await open(logPath, 'a');
  const child = spawn('/bin/zsh', [syncScript], {
    detached: false,
    stdio: ['ignore', log.fd, log.fd],
  });

  child.once('exit', async () => {
    await log.close();
    running = false;
    if (queued) {
      queued = false;
      schedule();
    }
  });
}

watch(root, { persistent: true }, (_eventType, filename) => {
  if (typeof filename === 'string' && /^good-copy.*\.html$/.test(filename)) {
    schedule();
  }
});
