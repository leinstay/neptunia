// The owner's commands on the quarantined pending writes (stage AM): `/memory pending list` lists them with code and
// time, `/memory pending replay` replays them through the one writer and reports the counts. The service side is
// tests/memory-pending-quarantine.test.ts; here the console reaches the service's methods `quarantinedPending()` and
// `replayQuarantinedPending()`. The console serves the `cli` principal only, so the commands are the owner's by
// construction. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseRequest } from '../bin/neptunia-request.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../src/interface/commands/console.ts';
import { commandLineWords, parseCommandLine } from '../src/interface/commands/table.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { tempDir } from './fixtures/tmp.ts';

const NOW = Date.parse('2026-11-06T09:00:00Z');
const FILES = [{ name: `${'a'.repeat(40)}.json`, code: 'UNIT_UNMAPPED', at: '2026-11-06T05:13:00.000Z' }];

function rig(memory: Record<string, unknown>) {
  const dir = tempDir('nep-pending-console-');
  mkdirSync(join(dir, 'config'), { recursive: true });
  const file = join(dir, 'memory.db');
  openMemoryDb(file).close();
  const reader = openMemoryDb(file, { readOnly: true });
  const deps: ConsoleDeps = {
    runOp: () => Promise.resolve({ status: 'failed', code: 'NOT_AN_OP', summary: '', data: null }),
    ownerReads: { lessons: () => '', aliases: () => '' },
    places: () => [],
    selfId: () => null,
    hot: {
      config: {
        memoryDb: {
          file: 'memory.db',
          inspection: { pageRows: 50, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 },
        },
      },
    },
    privateDir: dir,
    dataDir: dir,
    memoryDb: { database: () => dbOf(reader), ...memory },
    usage: null,
    metrics: { samples: () => [] },
    chatLines: () => [],
    now: () => NOW,
  };
  const desk = createConsole(deps);
  return async (line: string) => {
    const parsed = parseCommandLine(line);
    assert.ok(parsed.ok, parsed.ok ? '' : `${line}: ${parsed.reason}`);
    return desk.run(parsed.name, parsed.args, { id: 'owner' });
  };
}

test('/memory pending list and replay parse the same from the chat and from argv', () => {
  for (const [line, name] of [
    ['/memory pending list', 'memory.pending.list'],
    ['/memory pending replay', 'memory.pending.replay'],
  ]) {
    const fromChat = parseCommandLine(line);
    assert.ok(fromChat.ok, fromChat.ok ? '' : fromChat.reason);
    assert.equal(fromChat.name, name);
    assert.deepEqual(parseRequest(commandLineWords(line)).parsed, fromChat);
  }
});

test('/memory pending list answers each quarantined file with its code and time', async () => {
  // Bug: the owner cannot see what waits in the quarantine or why it failed.
  const say = rig({ quarantinedPending: () => FILES });
  const answer = await say('/memory pending list');
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual((JSON.parse(answer.text) as { files: unknown }).files, FILES);
});

test('/memory pending list over an empty quarantine answers ok with no files', async () => {
  const say = rig({ quarantinedPending: () => [] });
  const answer = await say('/memory pending list');
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual((JSON.parse(answer.text) as { files: unknown }).files, []);
});

test('/memory pending replay goes through the one writer and answers the counts', async () => {
  // Bug: the command replays over its own connection, a second writer on her memory, or hides how many stayed.
  let calls = 0;
  const say = rig({
    replayQuarantinedPending: () => {
      calls += 1;
      return Promise.resolve({ replayed: 2, kept: 1 });
    },
  });
  const answer = await say('/memory pending replay');
  assert.equal(answer.status, 'ok', answer.text);
  const body = JSON.parse(answer.text) as { replayed: number; kept: number };
  assert.deepEqual([body.replayed, body.kept], [2, 1]);
  assert.equal(calls, 1);
});

test('/memory pending replay does not answer ok when the writer is closed', async () => {
  // Bug: a closed database reads as "nothing to replay" and the owner thinks the files were applied.
  const say = rig({
    replayQuarantinedPending: () => Promise.reject(Object.assign(new Error('closed'), { code: 'DB_CLOSED' })),
  });
  const answer = await say('/memory pending replay');
  assert.notEqual(answer.status, 'ok');
});
