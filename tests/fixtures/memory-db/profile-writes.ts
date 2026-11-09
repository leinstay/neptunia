// Writes of account profiles and prose histories through the unit write and through their write kinds, over copies of
// one seeded database (tests/memory-db-account-profile.test.ts, tests/memory-db-prose-versions.test.ts).
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { accountCollection, placeCollection } from '../../../src/memory/db/storage-keys.ts';
import type { StorageKey } from '../../../src/memory/db/storage-keys.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import type { Db, Row } from '../../../src/memory/db/types.ts';
import { openTestMemory, tempDataDir } from './service.ts';

export const NOW = Date.parse('2026-11-09T10:00:00.000Z');
export const ROOT = 'discord:guild:300000000000000001';
export const CHANNEL = 'discord:channel:400000000000000001';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;
/** One write of a test: an account's profile, or the version history of one prose owner. */
export type Write =
  | { of: 'profile'; accountId: string; value: Row }
  | {
      of: 'versions';
      versionKind: 'users' | 'channels' | 'place' | 'lore';
      subjectId: string;
      itemId: string;
      value: Row;
    };

export const profile = (extra: Row = {}): Row => ({
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

export const versions = (field: string, texts: ReadonlyArray<string>): Row => ({
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
export async function writeBoth(
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
