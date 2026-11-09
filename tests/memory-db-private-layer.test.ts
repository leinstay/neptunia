// The write kind `private-layer` (src/memory/db/private-layer.ts): what she learned about a member in their direct chat,
// written as its rows directly instead of through the private mapper of a unit write. The first test writes the same
// layers through the unit write and through the write kind, over copies of one seeded database, and compares every
// table column by column. Then the codes, the store over a reopen and the generated layers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { accountCollection } from '../src/memory/db/storage-keys.ts';
import { dmAudienceId } from '../src/memory/db/scope.ts';
import { unitValue } from '../src/memory/db/readers/common.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { generated, plain } from './fixtures/memory-db/roundtrip.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';

const NOW = Date.parse('2026-11-09T10:00:00.000Z');
const DM = 'discord:dm:111';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;
/** One write of a test: the private layer of one account. */
type Write = { accountId: string; value: Row };

const layer = (extra: Row = {}): Row => ({
  relationship: 'Trusted.',
  relationshipScore: 30,
  relationshipWrittenAt: '2026-10-02T00:00:00.000Z',
  interests: [{ topic: 'music', note: 'n', weight: 1, firstSeen: '2026-10-01', lastSeen: '2026-10-02' }],
  details: [{ id: 1, text: 'secret plan', weight: 1, firstSeen: '2026-10-01', lastSeen: '2026-10-02', itemId: 'pd-1' }],
  detailsSeq: 1,
  episodes: [{ date: '2026-10-02', what: 'confided', quote: 'q', feeling: 'f', weight: 1, itemId: 'pe-1' }],
  affinity: {
    score: 10,
    reason: 'r',
    history: [{ ts: '2026-10-02T00:00:00.000Z', delta: 1, appliedDelta: 1, score: 1, reason: 'x' }],
    decayedAt: '2026-10-03T00:00:00.000Z',
  },
  firstSeen: '2026-10-01T00:00:00.000Z',
  lastSeen: '2026-10-02T00:00:00.000Z',
  replies: { day: '2026-10-02', count: 2, noticedDay: '2026-10-01' },
  buffer: [{ any: 'thing' }],
  ...extra,
});

/** Every table but the full-text indexes, each row as stored, in rowid order. */
function tablesOf(db: Db): string {
  const out: Record<string, Array<Row>> = {};
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name")
    .all()
    .map((row) => String(row.name))
    .filter((name) => !/_(fts|tri)(_|$)/.test(name));
  for (const name of names) out[name] = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  // The meta-person of an account no row holds is minted on each copy with a random uuid, and the graph's ids hash it:
  // each minted id is named by the order it first appears in, so two databases written alike name theirs alike.
  const minted = new Map<string, string>();
  return JSON.stringify(out, null, 1).replace(MINTED, (id) => {
    if (!minted.has(id)) minted.set(id, `minted-${minted.size}`);
    return minted.get(id)!;
  });
}

/** A minted id: a meta-person's uuid, or a hash over one (a node, an edge). */
const MINTED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}/g;

/**
 * A database with three accounts: 111 has a person and a direct chat whose layer is stored, 222 a person and no direct
 * chat, 333 no row at all. Her session moved 111's attitude in the direct chat once. Returns the data directory.
 */
async function seeded(): Promise<string> {
  const dataDir = tempDataDir('nep-private-seed-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  const db = dbOf(seed);
  for (const native of ['111', '222']) {
    db.prepare(`INSERT INTO people (id, kind) VALUES ('person:p${native}', 'member')`).run();
    db.prepare(
      `INSERT INTO accounts (id, iface, native_id, native_key, kind, person_id, link) VALUES (?, 'discord', ?, ?, 'user', ?, 'verified')`
    ).run(`discord:${native}`, native, native, `person:p${native}`);
  }
  db.prepare(
    `INSERT INTO places (id, iface, kind, chat, native_key, partner_account, partner_person) VALUES (?, 'discord', 'dm', 'dm', 'dm:111', 'discord:111', 'person:p111')`
  ).run(DM);
  seed.close();
  const memory = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  try {
    await memory.memoryDb.writeUnit({ op: 'value', key: accountCollection('private', 'discord:111'), value: layer() });
    dbOf(memory.memoryDb.readHandle()!)
      .prepare(
        `INSERT INTO affinity_events (id, person_id, at, delta, applied, score, reason, scope_kind, scope_iface, scope_dm, audience_id)
         VALUES ('aff:session:dm', 'person:p111', '2026-10-21T00:00:00.000Z', 2, 2, 12, 'her move', 'dm', 'discord', 'person:p111', ?)`
      )
      .run(dmAudienceId(DM));
  } finally {
    await memory.close();
  }
  return dataDir;
}

async function copyOf(seedDir: string): Promise<Memory> {
  const dataDir = tempDataDir('nep-private-copy-');
  fs.copyFileSync(path.join(seedDir, 'memory.db'), path.join(dataDir, 'memory.db'));
  return openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
}

/** Runs the writes through both paths over copies of the seed; returns every table of each and the answers. */
async function writeBoth(
  writes: ReadonlyArray<Write>
): Promise<{ unit: [string, Array<unknown>]; direct: [string, Array<unknown>] }> {
  const seedDir = await seeded();
  const viaUnit = await copyOf(seedDir);
  const direct = await copyOf(seedDir);
  try {
    const unitAnswers: Array<unknown> = [];
    for (const write of writes)
      unitAnswers.push(
        await viaUnit.memoryDb.writeUnit({
          op: 'value',
          key: accountCollection('private', write.accountId),
          value: write.value,
        })
      );
    const directAnswers: Array<unknown> = [];
    for (const write of writes) directAnswers.push(await direct.memoryDb.writePrivateLayer(write));
    return {
      unit: [tablesOf(dbOf(viaUnit.memoryDb.readHandle()!)), unitAnswers],
      direct: [tablesOf(dbOf(direct.memoryDb.readHandle()!)), directAnswers],
    };
  } finally {
    await viaUnit.close();
    await direct.close();
  }
}

test('layers of an account with a direct chat, one without and one with no row store the same rows both ways', async () => {
  const { unit, direct } = await writeBoth([
    { accountId: 'discord:111', value: layer({ interests: [], relationship: 'Closer now.' }) },
    { accountId: 'discord:222', value: layer({ episodes: [] }) },
    { accountId: 'discord:333', value: { odd: [1, { two: 2 }], affinity: 'flat' } },
    { accountId: 'discord:111', value: {} },
  ]);
  assert.equal(direct[0], unit[0]);
  assert.deepEqual(direct[1], unit[1]);
});

test('a private layer write that names no account is refused with a code', async () => {
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'discord' });
  try {
    await assert.rejects(memory.memoryDb.writePrivateLayer({ accountId: '', value: {} }), {
      code: 'PRIVATE_LAYER_ACCOUNT',
    });
  } finally {
    await memory.close();
  }
});

test('the store reads back a private layer after the database is closed and opened again', async () => {
  const dataDir = tempDataDir('nep-private-reopen-');
  const first = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  let written: unknown;
  try {
    const store = createStore({ dataDir, memoryDb: first.memoryDb });
    store.touchUser('discord:555', 'Fifth', NOW);
    store.addPrivateEpisodes('discord:555', [{ date: '2026-11-01', what: 'told a secret', weight: 2 }], {
      maxEpisodes: 10,
    });
    store.flush();
    await store.flushSettled({});
    written = store.getPrivate('discord:555');
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: second.memoryDb });
    const read = store.getPrivate('discord:555') as { episodes?: Array<{ what?: unknown }> } | null;
    const [episode] = read?.episodes ?? [];
    assert.equal(episode?.what, 'told a secret');
    assert.deepEqual(read, written);
  } finally {
    await second.close();
  }
});

test('the generated layers with every key path of the live private files come back as they were written', async () => {
  for (const [index, given] of generated('private').entries()) {
    const memory = await openTestMemory({ now: () => NOW, iface: () => 'discord' });
    try {
      const value = plain(given) as Row;
      await memory.memoryDb.writePrivateLayer({ accountId: 'discord:900', value });
      const read = unitValue(dbOf(memory.memoryDb.readHandle()!), accountCollection('private', 'discord:900'));
      assert.ok(read.found, `generated private ${index}`);
      assert.deepEqual(plain(read.value), value, `generated private ${index}`);
    } finally {
      await memory.close();
    }
  }
});
