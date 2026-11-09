// The watcher's worker as `/doctor watcher run` starts it (src/watcher/doctor.ts, bin/neptunia-watcher.ts): the core
// claims the run, `workerStarter` spawns `neptunia worker watcher` of this checkout, and the worker adopts that claim,
// asks the agent and commits the report, with no switch in the settings. The backend is a stand-in binary that answers a
// canned report; nothing connects to a provider or a core.
// Changed: `services watcher trigger`, `cancel` and `status`, the timer and the unit are gone (owner, 2026-11-09), and
// their tests with them; this file keeps the real worker and starts it the doctor's way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localConfigPath } from '../src/config/files.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { watcherList, watcherOpen, watcherRun, workerStarter } from '../src/watcher/doctor.ts';
import { readRun, runStoreOf } from '../src/watcher/lifecycle.ts';
import { readSessionMap } from '../src/subharness/sessions.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';
import { answerOf } from './fixtures/watcher-inspection-rig.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/** A persona folder with an empty local config and a stand-in claude that answers `answerOf` with `mark`. */
function persona(mark: string) {
  const data = tempDir('nep-watcher-worker-');
  fs.mkdirSync(path.dirname(localConfigPath(data)), { recursive: true });
  fs.writeFileSync(localConfigPath(data), '{}');
  const dir = path.join(data, 'agents', 'watcher');
  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  writeKeysFile(data, {
    subharness: { backends: ['claude'], key: null, modes: {}, models: {}, uses: { watcher: 'claude' } },
  });
  const answer = path.join(data, 'answer.txt');
  fs.writeFileSync(answer, answerOf({ Memory: mark }));
  const { binary } = subharnessPlace(data, 'claude');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(
    binary,
    `#!/bin/sh\nif [ "$1" = --help ]; then echo '  --session-id <uuid>'; exit 0; fi\ncat > /dev/null\ncat ${JSON.stringify(answer)}\n`,
    { mode: 0o755 }
  );
  return { data, dir, reportsDir: path.join(dir, 'reports') };
}

test('the worker the doctor starts adopts its run, commits the report and maps its session to the run', async () => {
  // Bug: the worker claims a second run beside the core's, waits for a switch that no longer exists, or its session
  // reaches the evidence unattributed.
  const where = persona('MARK-FROM-WORKER');
  const store = runStoreOf(where.dir);
  let ended: Promise<number | null> = Promise.resolve(null);
  const start = workerStarter({
    rootDir: REPO,
    dataDir: where.data,
    env: { PATH: '/usr/bin:/bin', HOME: tempDir('nep-watcher-worker-home-'), TMPDIR: process.env.TMPDIR },
    spawn: (command, args, options) => {
      const child = spawn(command, [...args], { ...options, detached: false });
      ended = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('the worker did not end in time'));
        }, 8_000);
        child.once('close', (exit) => {
          clearTimeout(timer);
          resolve(exit);
        });
      });
      return child;
    },
  });
  let runId = '';
  const asked = watcherRun({
    store,
    reportsDir: where.reportsDir,
    start: (id) => ((runId = id), start(id)),
  });
  assert.equal(asked.status, 'ok', asked.text);
  const code = await ended;
  assert.equal(code, 0);
  assert.equal(readRun(store, runId)?.state, 'succeeded');
  assert.equal(watcherList({ store, reportsDir: where.reportsDir }).text.split('\n').length, 1, 'one run, not two');
  assert.ok(watcherOpen({ store, reportsDir: where.reportsDir }, 1).text.includes('MARK-FROM-WORKER'));
  const [session] = readSessionMap(where.data);
  assert.equal(session?.agent, 'watcher');
  assert.equal(session?.runId, runId);
});
