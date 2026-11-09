// The write kinds `account-profile` (src/memory/db/account-profile.ts) and `prose-versions`
// (src/memory/db/prose-versions.ts): an account's profile and the previous texts of a prose owner written as their rows
// directly instead of through the user and versions mappers of a unit write. The first tests write the same values
// through the unit write and through the write kind, over copies of one seeded database, and compare every table
// column by column. Then the store over a reopen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { accountCollection, placeCollection } from '../src/memory/db/storage-keys.ts';
import type { StorageKey } from '../src/memory/db/storage-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { unitValue } from '../src/memory/db/readers/common.ts';
import { generated, plain } from './fixtures/memory-db/roundtrip.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';

const NOW = Date.parse('2026-11-09T10:00:00.000Z');
const ROOT = 'discord:guild:300000000000000001';
const CHANNEL = 'discord:channel:400000000000000001';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;
/** One write of a test: an account's profile, or the version history of one prose owner. */
type Write =
  | { of: 'profile'; accountId: string; value: Row }
  | {
      of: 'versions';
      versionKind: 'users' | 'channels' | 'place' | 'lore';
      subjectId: string;
      itemId: string;
      value: Row;
    };

const profile = (extra: Row = {}): Row => ({
  firstSeen: '2026-09-01T10:00:00.000Z',
  lastSeen: '2026-10-20T10:00:00.000Z',
  messageCount: 120,
  character: 'Warm and quick to joke.',
  style: 'Short lines.',
  relationship: 'Friendly regular.',
  relationshipWrittenAt: '2026-10-01T00:00:00.000Z',
  interests: [
    { topic: 'chess', note: 'plays blitz', weight: 3, firstSeen: '2026-09-01', lastSeen: '2026-10-01', itemId: 'i1' },
    { topic: 'gardening', note: '', weight: 1, firstSeen: '2026-09-05', lastSeen: '2026-09-05' },
  ],
  details: [{ id: 1, text: 'has a cat', weight: 2, firstSeen: '2026-09-01', lastSeen: '2026-10-02', itemId: 'd1' }],
  detailsSeq: 1,
  aliases: [{ name: 'Alex', weight: 2, firstSeen: '2026-09-01', lastSeen: '2026-09-09', itemId: 'a1' }],
  affinity: {
    score: 20,
    reason: 'kind',
    history: [{ ts: '2026-09-10T00:00:00.000Z', delta: 5, appliedDelta: 5, score: 5, reason: 'first', itemId: 'f1' }],
    decayedAt: '2026-10-01T00:00:00.000Z',
  },
  episodes: [{ date: '2026-10-01', what: 'told a joke', quote: 'q', feeling: 'amused', weight: 2, itemId: 'e1' }],
  names: ['Αλέξης', 'Zoë'],
  avatar: { hash: null, text: 'a blue circle', describedAt: '2026-09-02T00:00:00.000Z', default: true },
  addressedAs: { Plain: { score: 1, last: '2026-10-02' } },
  closed: [
    {
      kind: 'detail',
      id: 9,
      text: 'was in school',
      weight: 1,
      firstSeen: '2026-09-01',
      lastSeen: '2026-09-02',
      validTo: '2026-10-01',
      itemId: 'c1',
    },
  ],
  updatedAt: '2026-10-20T10:00:00.000Z',
  ...extra,
});

const versions = (field: string, texts: ReadonlyArray<string>): Row => ({
  [field]: texts.map((text, i) => ({
    at: `2026-10-0${i + 1}T00:00:00.000Z`,
    by: 'analyzer',
    chars: [...text].length,
    kept: 1,
    removed: 0,
    added: 1,
    text,
    itemId: `vs-${field}-${i}`,
  })),
  note: 'kept whole',
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
  return JSON.stringify(out, null, 1);
}

/** The unit key of one write. */
function keyOf(write: Write): StorageKey {
  if (write.of === 'profile') return accountCollection('user', write.accountId);
  const selector = { versionKind: write.versionKind, itemId: write.itemId };
  return write.versionKind === 'users'
    ? accountCollection('versions', write.subjectId, { selector })
    : placeCollection('versions', write.subjectId, { selector });
}

/**
 * A database with four accounts: 111 holds its profile, 222 is linked to 111's person, 333 has a person and no
 * profile yet, 444 no row at all. Her session moved 111's attitude once and wrote the current version of its
 * character. Returns the data directory; each test copies its file.
 */
async function seeded(): Promise<string> {
  const dataDir = tempDataDir('nep-profile-seed-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  const db = dbOf(seed);
  for (const native of ['111', '222', '333'])
    db.prepare("INSERT INTO accounts (id, iface, native_id, native_key, kind) VALUES (?, 'discord', ?, ?, 'user')").run(
      `discord:${native}`,
      native,
      native
    );
  db.prepare("INSERT INTO people (id, kind) VALUES ('person:p333', 'member')").run();
  db.prepare("UPDATE accounts SET person_id = 'person:p333', link = 'verified' WHERE id = 'discord:333'").run();
  seed.close();
  const memory = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  try {
    await memory.memoryDb.writeUnit({ op: 'value', key: accountCollection('user', 'discord:111'), value: profile() });
    await memory.memoryDb.personLink({
      op: 'bind',
      accountId: 'discord:222',
      target: { accountId: 'discord:111' },
      now: NOW,
    });
    const person = String(
      dbOf(memory.memoryDb.readHandle()!).prepare("SELECT person_id FROM accounts WHERE id = 'discord:111'").get()
        ?.person_id
    );
    const raw = dbOf(memory.memoryDb.readHandle()!);
    raw
      .prepare(
        `INSERT INTO affinity_events (id, person_id, at, delta, applied, score, reason, scope_kind, scope_iface)
         VALUES ('aff:session:1', ?, '2026-10-21T00:00:00.000Z', 4, 4, 24, 'her move', 'group', 'discord')`
      )
      .run(person);
    raw
      .prepare(
        `INSERT INTO description_versions (id, description_id, text, author, written_at, origin)
         VALUES ('desc-session-1', ?, 'Her own words.', 'session', '2026-10-21T00:00:00.000Z', 'session')`
      )
      .run(`desc:${person}:character`);
    raw
      .prepare("UPDATE descriptions SET current_version = 'desc-session-1' WHERE id = ?")
      .run(`desc:${person}:character`);
  } finally {
    await memory.close();
  }
  return dataDir;
}

async function copyOf(seedDir: string): Promise<Memory> {
  const dataDir = tempDataDir('nep-profile-copy-');
  fs.copyFileSync(path.join(seedDir, 'memory.db'), path.join(dataDir, 'memory.db'));
  return openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
}

function directWrite(memory: Memory, write: Write): Promise<unknown> {
  if (write.of === 'profile')
    return memory.memoryDb.writeAccountProfile({ accountId: write.accountId, value: write.value });
  const { versionKind, subjectId, itemId, value } = write;
  return memory.memoryDb.writeProseVersions({ versionKind, subjectId, itemId, value });
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
      unitAnswers.push(await viaUnit.memoryDb.writeUnit({ op: 'value', key: keyOf(write), value: write.value }));
    const directAnswers: Array<unknown> = [];
    for (const write of writes) directAnswers.push(await directWrite(direct, write));
    return {
      unit: [tablesOf(dbOf(viaUnit.memoryDb.readHandle()!)), unitAnswers],
      direct: [tablesOf(dbOf(direct.memoryDb.readHandle()!)), directAnswers],
    };
  } finally {
    await viaUnit.close();
    await direct.close();
  }
}

test('profiles of an owning, a linked, a first-time and an unknown account store the same rows both ways', async () => {
  const { unit, direct } = await writeBoth([
    {
      of: 'profile',
      accountId: 'discord:111',
      value: profile({ interests: [], character: 'Her own words.', messageCount: 121 }),
    },
    { of: 'profile', accountId: 'discord:222', value: { names: ['Second'], addressedAs: { Two: { score: 1 } } } },
    { of: 'profile', accountId: 'discord:333', value: profile({ aliases: [], closed: [] }) },
    { of: 'profile', accountId: 'discord:444', value: { names: ['Nobody'], odd: [1, { two: 2 }], affinity: 'flat' } },
  ]);
  assert.equal(direct[0], unit[0]);
  assert.deepEqual(direct[1], unit[1]);
});

test('version histories of an account, a channel, a place and a lore entry store the same rows both ways', async () => {
  const { unit, direct } = await writeBoth([
    {
      of: 'versions',
      versionKind: 'users',
      subjectId: 'discord:111',
      itemId: 'discord:111',
      value: versions('character', ['one', 'two']),
    },
    {
      of: 'versions',
      versionKind: 'channels',
      subjectId: CHANNEL,
      itemId: CHANNEL,
      value: versions('purpose', ['a room']),
    },
    { of: 'versions', versionKind: 'place', subjectId: ROOT, itemId: ROOT, value: versions('patterns', ['p']) },
    {
      of: 'versions',
      versionKind: 'lore',
      subjectId: ROOT,
      itemId: 'a-title-0123456789ab',
      value: versions('text', []),
    },
    {
      of: 'versions',
      versionKind: 'users',
      subjectId: 'discord:111',
      itemId: 'discord:111',
      value: versions('character', ['two']),
    },
  ]);
  assert.equal(direct[0], unit[0]);
  assert.deepEqual(direct[1], unit[1]);
});

test('a profile write that names no account is refused with a code', async () => {
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'discord' });
  try {
    await assert.rejects(memory.memoryDb.writeAccountProfile({ accountId: '', value: {} }), {
      code: 'ACCOUNT_PROFILE_ACCOUNT',
    });
  } finally {
    await memory.close();
  }
});

test('a version write of a kind outside the prose kinds is refused with a code', async () => {
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'discord' });
  try {
    await assert.rejects(
      memory.memoryDb.writeProseVersions({
        versionKind: 'media' as never,
        subjectId: ROOT,
        itemId: 'x',
        value: {},
      }),
      { code: 'PROSE_VERSIONS_KIND' }
    );
  } finally {
    await memory.close();
  }
});

test('the store reads back a profile and its versions after the database is closed and opened again', async () => {
  const dataDir = tempDataDir('nep-profile-reopen-');
  const first = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  let written: unknown;
  let history: unknown;
  try {
    const store = createStore({ dataDir, memoryDb: first.memoryDb });
    store.touchUser('discord:555', 'Fifth', NOW);
    store.updateUser('discord:555', { character: 'Calm.' }, { by: 'analyzer' });
    store.updateUser('discord:555', { character: 'Calm and dry.' }, { by: 'analyzer' });
    store.flush();
    await store.flushSettled({});
    written = store.getUser('discord:555');
    history = store.listVersions(ROOT, 'users', 'discord:555');
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: second.memoryDb });
    assert.equal((store.getUser('discord:555') as { character?: unknown } | null)?.character, 'Calm and dry.');
    assert.deepEqual(store.getUser('discord:555'), written);
    assert.deepEqual(store.listVersions(ROOT, 'users', 'discord:555'), history);
    assert.equal((history as { character?: Array<{ text?: unknown }> }).character?.[0]?.text, 'Calm.');
  } finally {
    await second.close();
  }
});

test('the generated profiles with every key path of the live user files come back as they were written', async () => {
  // The fixtures share one native id, so each goes into a database of its own.
  for (const [index, given] of generated('user').entries()) {
    const memory = await openTestMemory({ now: () => NOW, iface: () => 'discord' });
    try {
      const value = plain(given) as Row;
      await memory.memoryDb.writeAccountProfile({ accountId: 'discord:900', value });
      const read = unitValue(dbOf(memory.memoryDb.readHandle()!), accountCollection('user', 'discord:900'));
      assert.ok(read.found, `generated user ${index}`);
      assert.deepEqual(plain(read.value), value, `generated user ${index}`);
    } finally {
      await memory.close();
    }
  }
});
