// The stored-turn mode of scripts/replay.ts (scripts/lib/replay-stored.ts): the spend gate a run that spends passes
// first, the one setup it runs, and the stop between samples.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { storedTurnMain } from '../../../scripts/lib/replay-stored.ts';
import { REFUSED_EXIT } from '../../../scripts/lib/cli.ts';
import { freshMemoryDb } from '../../fixtures/memory-db-copy.ts';
import { tempDir } from '../../fixtures/tmp.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ONE_SETUP = [{ routes: {} }];

/** A data copy whose memory holds one stored command line turn, `t-stored-1`. */
function copyWithTurn(): string {
  const handle = freshMemoryDb();
  (handle.db as InstanceType<typeof DatabaseSync>)
    .prepare(
      `INSERT INTO day (id, at, what, place_id, turn_id, scope_iface, extra)
       VALUES ('day:1', '2026-03-04T10:02:30.000Z', 'turn.start', NULL, 't-stored-1', 'cli', '{"mode":"reply"}')`
    )
    .run();
  const file = handle.path;
  handle.close();
  const dataDir = tempDir('nep-replay-stored-');
  fs.copyFileSync(file, path.join(dataDir, 'memory.db'));
  return dataDir;
}

test('refuses a stored turn that would spend without --spend covering its estimate', async () => {
  const dataDir = tempDir('nep-replay-stored-');
  await assert.rejects(
    storedTurnMain(['--data', dataDir, '--turn', 't-x', '--samples', '2'], ONE_SETUP, { root: ROOT }),
    (err: unknown) => (err as { exitCode?: number }).exitCode === REFUSED_EXIT && /--spend/.test(String(err))
  );
});

test('refuses several variants for a stored turn, which runs one setup', async () => {
  const dataDir = tempDir('nep-replay-stored-');
  await assert.rejects(
    storedTurnMain(['--data', dataDir, '--turn', 't-x', '--answers', 'archive'], [...ONE_SETUP, ...ONE_SETUP], {
      root: ROOT,
    }),
    /variant-unsupported/
  );
});

test('starts no sample after the stop signal and says how many of the asked samples finished', async () => {
  const dataDir = copyWithTurn();
  const answers = path.join(tempDir('nep-replay-answers-'), 'answers');
  const stop = new AbortController();
  stop.abort();
  const out = await storedTurnMain(
    ['--data', dataDir, '--turn', 't-stored', '--samples', '2', '--answers-dir', answers, '--out', tempDir('nep-out-')],
    ONE_SETUP,
    { root: ROOT, signal: stop.signal }
  );
  assert.equal(out.code, 1);
  assert.deepEqual(out.result.reports, []);
  assert.deepEqual(out.result.cut, { asked: 2, finished: 0 });
  assert.equal(fs.readFileSync(path.join(answers, 'done'), 'utf8'), 'exit 1\n');
});

test('refuses --compare without the archived memory database to compare with', async () => {
  const dataDir = tempDir('nep-replay-stored-');
  await assert.rejects(
    storedTurnMain(['--data', dataDir, '--turn', 't-x', '--answers', 'archive', '--compare'], ONE_SETUP, {
      root: ROOT,
    }),
    /--compare needs --oracle/
  );
});

/** Runs `body` with `fetch` replaced by a fake provider that counts the requests it gets and answers none. */
async function countingFetch(body: () => Promise<void>): Promise<number> {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    return Promise.reject(new Error('no provider in a test'));
  };
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
  return calls;
}

for (const answers of [
  ['--answers-dir', 'answers'],
  ['--answers', 'archive'],
]) {
  test(`refuses ${answers.join(' ')} with --embed live before any provider call when --spend does not cover the embeddings`, async () => {
    const dataDir = copyWithTurn();
    const given = answers[0] === '--answers-dir' ? ['--answers-dir', path.join(tempDir('nep-answers-'), 'a')] : answers;
    for (const spend of [[], ['--spend', '0.0001']]) {
      const calls = await countingFetch(() =>
        assert.rejects(
          storedTurnMain(
            [
              '--data',
              dataDir,
              '--turn',
              't-stored',
              ...given,
              '--embed',
              'live',
              ...spend,
              '--out',
              tempDir('nep-out-'),
            ],
            ONE_SETUP,
            { root: ROOT }
          ),
          (err: unknown) => (err as { exitCode?: number }).exitCode === REFUSED_EXIT && /--spend/.test(String(err))
        )
      );
      assert.equal(calls, 0);
    }
  });
}

test('runs a turn answered from the archive without --spend when it embeds nothing', async () => {
  const stop = new AbortController();
  stop.abort();
  const out = await storedTurnMain(
    ['--data', copyWithTurn(), '--turn', 't-stored', '--answers', 'archive', '--out', tempDir('nep-out-')],
    ONE_SETUP,
    { root: ROOT, signal: stop.signal }
  );
  assert.deepEqual(out.result.cut, { asked: 1, finished: 0 });
});
