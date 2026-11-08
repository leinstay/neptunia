// A pending unit write whose replay fails is moved aside (spec: stage AM of the master plan). The file goes to
// `memory-pending-quarantine/` (folder mode 700, files mode 600) with `<name>.error.json` beside it (`{ code, at }`),
// the open goes on and the database is used, an error line names the count and the code and never the content, and
// `onPendingQuarantined({ count, code: 'memory-pending-quarantined', cause })` tells the core, which tells her like any
// failure. `status().pending` counts what the folder holds. `quarantinedPending()` lists the files and
// `replayQuarantinedPending()` replays them through the writer: a file that applies goes with its error file, one that
// fails stays. Files that replay keep being deleted. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMemoryDb } from '../src/memory/db/service.ts';
import { unitLines } from '../src/memory/db/readers/common.ts';
import type { StorageKey } from '../src/memory/db/storage-keys.ts';
import { CATALOGUE } from '../src/tools/codes.ts';
import { memoryDbStatusLine } from '../src/tools/operations/status.ts';
import { tempDir } from './fixtures/tmp.ts';

const NOW = Date.parse('2026-11-06T09:00:00.000Z');
const LATER = Date.parse('2026-11-06T10:30:00.000Z');
const hot = { config: { memoryDb: { session: { mode: 'off' } } } };
const QUARANTINE = 'memory-pending-quarantine';
// Content that must never reach a log line.
const SECRET = 'the synthetic secret sentence';

const day: StorageKey = { kind: 'record', subject: { type: 'place', id: 'discord:guild:g1' }, partition: '2026-10-20' };
const line = (id: string, text: string) => ({
  v: 1,
  id,
  kind: 'seen',
  messageId: id,
  placeId: 'g1',
  scope: { channel: 'c1' },
  occurredAt: new Date(NOW).toISOString(),
  recordedAt: new Date(NOW).toISOString(),
  text,
});
const GOOD = {
  op: 'lines',
  owner: 'guilds/g1/record/2026-10/2026-10-20.jsonl',
  lines: [line('good-1', 'a good line')],
};
// A write the writer refuses: its owner path maps to no unit (UNIT_UNMAPPED).
const BAD = { op: 'value', owner: 'guilds/g1/nothing.json', value: { text: SECRET } };

function logs() {
  const out: Array<Record<string, unknown>> = [];
  const add = (level: string) => (message: string, fields?: object) => out.push({ level, message, ...fields });
  return { out, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

function rig(now: () => number = () => NOW) {
  const dataDir = tempDir('nep-pending-quarantine-');
  const log = logs();
  const told: Array<Record<string, unknown>> = [];
  const make = () =>
    createMemoryDb({
      hot,
      dataDir,
      log,
      worker: false,
      now,
      onPendingQuarantined: (info: Record<string, unknown>) => told.push(info),
    });
  return { dataDir, log, told, make };
}

/** Keeps `writes` pending the way a shutdown does, with a service that never opens, and returns the file names in order. */
function keepAll(make: () => ReturnType<typeof createMemoryDb>, writes: Array<Record<string, unknown>>): Array<string> {
  const keeper = make();
  return writes.map((write) => path.basename(keeper.keepPending(write)));
}

const names = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const modeOf = (file: string) => fs.statSync(file).mode & 0o777;
const errorName = (name: string) => name.replace('.json', '.error.json');
const errorOf = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as { code: string; at: string };

test('a pending write that fails its replay moves to the quarantine and the database opens', async () => {
  // Bug: one bad pending write fails every open (PENDING_REPLAY), so the core restarts in a loop and she stays offline.
  const { dataDir, log, make } = rig();
  const [bad] = keepAll(make, [BAD]);
  const original = fs.readFileSync(path.join(dataDir, 'memory-pending', bad), 'utf8');
  const service = make();
  try {
    await service.open();
    assert.equal(service.status().open, true);
    assert.deepEqual(names(path.join(dataDir, 'memory-pending')), []);
    assert.deepEqual(names(path.join(dataDir, QUARANTINE)), [errorName(bad), bad].sort());
    assert.equal(fs.readFileSync(path.join(dataDir, QUARANTINE, bad), 'utf8'), original);
    const error = errorOf(path.join(dataDir, QUARANTINE, errorName(bad)));
    assert.equal(error.code, 'UNIT_UNMAPPED');
    assert.equal(error.at, new Date(NOW).toISOString());
    assert.equal(
      log.out.some((entry) => entry.message === 'memory db: open failed'),
      false
    );
  } finally {
    await service.close();
  }
});

test('the quarantine folder is mode 700 and its files are mode 600', async () => {
  // Bug: a quarantined write holds her memory text, and a world-readable copy leaks it.
  const { dataDir, make } = rig();
  const [bad] = keepAll(make, [BAD]);
  const service = make();
  try {
    await service.open();
    const dir = path.join(dataDir, QUARANTINE);
    assert.equal(modeOf(dir), 0o700);
    assert.equal(modeOf(path.join(dir, bad)), 0o600);
    assert.equal(modeOf(path.join(dir, errorName(bad))), 0o600);
  } finally {
    await service.close();
  }
});

test('an error line names the count and the code and carries no content', async () => {
  // Bug: the failure is silent, or the log line repeats the lines she was to remember.
  const { log, make } = rig();
  keepAll(make, [BAD]);
  const service = make();
  try {
    await service.open();
    const lines = log.out.filter((entry) => entry.message === 'memory db: pending quarantined');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, 'error');
    assert.equal(lines[0].count, 1);
    assert.equal(lines[0].code, 'UNIT_UNMAPPED');
    assert.equal(JSON.stringify(log.out).includes(SECRET), false);
  } finally {
    await service.close();
  }
});

test('the core is told once with the memory-pending-quarantined code and the cause', async () => {
  // Bug: the quarantine happens without a trace for her and for the owner (no silent failure).
  const { told, make } = rig();
  keepAll(make, [BAD]);
  const service = make();
  try {
    await service.open();
    assert.deepEqual(told, [{ count: 1, code: 'memory-pending-quarantined', cause: 'UNIT_UNMAPPED' }]);
  } finally {
    await service.close();
  }
});

test('files that replay are still applied and deleted beside a quarantined one', async () => {
  // Bug: the quarantine skips the whole replay, or leaves the good file to be applied twice at the next open.
  const { dataDir, told, make } = rig();
  const [bad, good] = keepAll(make, [BAD, GOOD]);
  assert.notEqual(bad, good);
  const service = make();
  try {
    await service.open();
    assert.deepEqual(names(path.join(dataDir, 'memory-pending')), []);
    assert.equal(unitLines(service.database()!, day).length, 1);
    assert.equal(told.length, 1);
    assert.equal(told[0].count, 1);
    assert.deepEqual(names(path.join(dataDir, QUARANTINE)), [errorName(bad), bad].sort());
  } finally {
    await service.close();
  }
});

test('a replay with no failure quarantines nothing and tells nobody', async () => {
  // Bug: the folder is made, or the core is told, when every pending write applied.
  const { dataDir, told, make } = rig();
  keepAll(make, [GOOD]);
  const service = make();
  try {
    await service.open();
    assert.equal(fs.existsSync(path.join(dataDir, QUARANTINE)), false);
    assert.deepEqual(told, []);
    assert.deepEqual(service.status().pending, { quarantined: 0, lastCode: null });
  } finally {
    await service.close();
  }
});

test('the status counts the quarantined files and names the code, also after a restart', async () => {
  // Bug: the owner sees a healthy database while a write of hers waits in the quarantine.
  const { make } = rig();
  keepAll(make, [BAD]);
  const first = make();
  await first.open();
  assert.deepEqual(first.status().pending, { quarantined: 1, lastCode: 'UNIT_UNMAPPED' });
  await first.close();
  const second = make();
  try {
    await second.open();
    assert.deepEqual(second.status().pending, { quarantined: 1, lastCode: 'UNIT_UNMAPPED' });
  } finally {
    await second.close();
  }
});

test('a write that cannot be moved aside stays pending and the open fails as before', async () => {
  // Bug: a failed move loses the write, or lets the database open behind a write it has not taken.
  const { dataDir, log, make } = rig();
  const [bad] = keepAll(make, [BAD]);
  // A regular file where the folder should be: the move cannot be made.
  fs.writeFileSync(path.join(dataDir, QUARANTINE), 'in the way');
  const service = make();
  try {
    await service.tick();
    assert.equal(service.status().open, false);
    assert.deepEqual(names(path.join(dataDir, 'memory-pending')), [bad]);
    assert.ok(log.out.some((entry) => entry.message === 'memory db: open failed' && entry.code === 'PENDING_REPLAY'));
  } finally {
    await service.close();
  }
});

test('quarantinedPending lists each file with its code and the time it was moved', async () => {
  // Bug: the owner cannot tell which writes wait or why they failed.
  let time = NOW;
  const { make } = rig(() => time);
  const [bad] = keepAll(make, [BAD]);
  const service = make();
  try {
    await service.open();
    time = LATER;
    assert.deepEqual(service.quarantinedPending(), [
      { name: bad, code: 'UNIT_UNMAPPED', at: new Date(NOW).toISOString() },
    ]);
  } finally {
    await service.close();
  }
});

test('quarantinedPending is empty when nothing was quarantined', async () => {
  const { make } = rig();
  const service = make();
  try {
    await service.open();
    assert.deepEqual(service.quarantinedPending(), []);
  } finally {
    await service.close();
  }
});

/** A quarantined file as the open leaves it: the write and its error file beside it. */
function quarantine(dataDir: string, name: string, write: Record<string, unknown>, code: string): void {
  const dir = path.join(dataDir, QUARANTINE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const at = new Date(NOW).toISOString();
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ ...write, at }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, errorName(name)), JSON.stringify({ code, at }), { mode: 0o600 });
}

test('replayQuarantinedPending applies a file that works and deletes it with its error file', async () => {
  // Bug: the owner fixes the writer and the quarantined write still never reaches her memory.
  const { dataDir, make } = rig();
  quarantine(dataDir, `${'a'.repeat(40)}.json`, GOOD, 'SOME_OLD_CODE');
  const service = make();
  try {
    await service.open();
    assert.deepEqual(await service.replayQuarantinedPending(), { replayed: 1, kept: 0 });
    assert.deepEqual(names(path.join(dataDir, QUARANTINE)), []);
    assert.equal(unitLines(service.database()!, day).length, 1);
    assert.deepEqual(service.status().pending, { quarantined: 0, lastCode: null });
  } finally {
    await service.close();
  }
});

test('replayQuarantinedPending keeps a file that fails, with its code, and reports the counts', async () => {
  // Bug: a failing file is deleted with the rest, or the run stops at the first failure and skips the good ones.
  const { dataDir, make } = rig();
  const bad = `${'1'.repeat(40)}.json`;
  quarantine(dataDir, bad, BAD, 'UNIT_UNMAPPED');
  quarantine(dataDir, `${'2'.repeat(40)}.json`, GOOD, 'SOME_OLD_CODE');
  const service = make();
  try {
    await service.open();
    assert.deepEqual(await service.replayQuarantinedPending(), { replayed: 1, kept: 1 });
    assert.deepEqual(names(path.join(dataDir, QUARANTINE)), [bad, errorName(bad)].sort());
    assert.equal(errorOf(path.join(dataDir, QUARANTINE, errorName(bad))).code, 'UNIT_UNMAPPED');
  } finally {
    await service.close();
  }
});

test('replayQuarantinedPending over an empty quarantine does nothing', async () => {
  const { make } = rig();
  const service = make();
  try {
    await service.open();
    assert.deepEqual(await service.replayQuarantinedPending(), { replayed: 0, kept: 0 });
  } finally {
    await service.close();
  }
});

test('the catalogue holds the memory-pending-quarantined code as a failure', () => {
  // Bug: the code reaches her fact without a catalogue entry, so the emitter throws at its first use.
  const entry = (CATALOGUE as Record<string, { status: string; group: string }>)['memory-pending-quarantined'];
  assert.equal(entry?.status, 'failed');
  assert.equal(entry?.group, 'wake');
});

test('the status line of the memory field adds the quarantine when files wait in it', () => {
  // Bug: the owner's status shows "ok" while a write waits in the quarantine.
  const labels = {
    status: { memoryDb: { unavailable: 'db down', ok: 'db up {rows} {files}', quarantined: '{n} quarantined {code}' } },
  };
  const waiting = memoryDbStatusLine(
    { open: true, rows: 5, files: 7, pending: { quarantined: 2, lastCode: 'UNIT_UNMAPPED' } },
    labels
  );
  assert.ok(waiting?.includes('db up 5 7'));
  assert.ok(waiting?.includes('2 quarantined UNIT_UNMAPPED'));
  const clean = memoryDbStatusLine(
    { open: true, rows: 5, files: 7, pending: { quarantined: 0, lastCode: null } },
    labels
  );
  assert.equal(clean, 'db up 5 7');
});
