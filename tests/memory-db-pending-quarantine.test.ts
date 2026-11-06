// The pending write quarantine on the worker path (stage AM of the master plan): with `worker: true` the replay of the
// open runs through the writer thread, and a write that fails it is moved aside the same way as on the calling
// thread (tests/memory-pending-quarantine.test.ts). A second failure of the same owner keeps the first file and gets a
// time suffix. The core's notices of an open wait until her inner life can be told. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMemoryDb } from '../src/memory/db/service.ts';
import { quarantineNotices } from '../src/memory/db/pending-quarantine.ts';
import { tempDir } from './fixtures/tmp.ts';

const NOW = Date.parse('2026-11-06T09:00:00.000Z');
const hot = { config: { memoryDb: { session: { mode: 'off' } } } };
const QUARANTINE = 'memory-pending-quarantine';
// A write the writer refuses: its owner path maps to no unit (UNIT_UNMAPPED).
const BAD = { op: 'value', owner: 'guilds/g1/nothing.json', value: { text: 'synthetic' } };

function rig(worker: boolean) {
  const dataDir = tempDir('nep-pending-quarantine-worker-');
  const told: Array<Record<string, unknown>> = [];
  const make = () =>
    createMemoryDb({
      hot,
      dataDir,
      worker,
      now: () => NOW,
      onPendingQuarantined: (info: Record<string, unknown>) => told.push(info),
    });
  return { dataDir, told, make };
}

const names = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

test('on the worker path a pending write that fails its replay moves to the quarantine and the database opens', async () => {
  // Bug: the threaded open still fails on the bad write, so production (which runs the worker) stays offline.
  const { dataDir, told, make } = rig(true);
  const bad = path.basename(make().keepPending(BAD));
  const service = make();
  try {
    await service.open();
    assert.equal(service.status().open, true);
    assert.deepEqual(names(path.join(dataDir, 'memory-pending')), []);
    assert.deepEqual(names(path.join(dataDir, QUARANTINE)), [bad.replace('.json', '.error.json'), bad].sort());
    assert.deepEqual(told, [{ count: 1, code: 'memory-pending-quarantined', cause: 'UNIT_UNMAPPED' }]);
  } finally {
    await service.close();
  }
});

test('a second failure of the same owner keeps the first quarantined file and gets a time suffix', async () => {
  // Bug: both pending files carry the owner's hash, so the second move overwrites the first write.
  const { dataDir, make } = rig(false);
  const bad = path.basename(make().keepPending(BAD));
  const first = make();
  await first.open();
  await first.close();
  make().keepPending({ ...BAD, value: { text: 'the second synthetic value' } });
  const second = make();
  try {
    await second.open();
    const held = second.quarantinedPending().map(({ name }) => name);
    assert.equal(held.length, 2);
    const later = held.find((name) => name !== bad) ?? '';
    assert.ok(held.includes(bad));
    assert.match(later, new RegExp(`^${bad.replace('.json', '')}-.+\\.json$`));
    const textOf = (name: string) => {
      const kept = JSON.parse(fs.readFileSync(path.join(dataDir, QUARANTINE, name), 'utf8')) as {
        value: { text: string };
      };
      return kept.value.text;
    };
    assert.deepEqual([textOf(bad), textOf(later)], ['synthetic', 'the second synthetic value']);
  } finally {
    await second.close();
  }
});

test('a quarantine notice made before the core can tell her waits, and one made after goes at once', () => {
  // Bug: the open runs before her inner life exists, so the notice of its quarantine is lost at every start.
  let time = NOW;
  const notices = quarantineNotices(() => time, { warn: () => {} });
  const told: Array<unknown> = [];
  notices.hold({ count: 2, code: 'memory-pending-quarantined', cause: 'UNIT_UNMAPPED' });
  assert.equal(told.length, 0);
  time = NOW + 1000;
  notices.tellWith((notice) => told.push(notice));
  notices.hold({ count: 1, code: 'memory-pending-quarantined', cause: 'UNIT_BAD_OP' });
  const fact = { kind: 'pendingQuarantined', placeId: null, privateChat: false };
  assert.deepEqual(told, [
    { ...fact, waiting: 2, code: 'UNIT_UNMAPPED', at: NOW },
    { ...fact, waiting: 1, code: 'UNIT_BAD_OP', at: NOW + 1000 },
  ]);
});
