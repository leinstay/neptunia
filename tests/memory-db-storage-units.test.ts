// Semantic ownership preserves migrated collections, session changes and accepted pending writes.
import { legacyServerPlaceId } from '../src/memory/migration/paths.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb, MIGRATIONS } from '../src/memory/db/open.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import { applyUnitWrite } from '../src/memory/db/unit-write.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { unitLines } from '../src/memory/db/readers/common.ts';
import { unitRows } from '../src/memory/db/export.ts';
import { listUnits } from '../src/memory/db/storage-units.ts';
import type { StorageKey } from '../src/memory/db/storage-keys.ts';
import { personId } from '../src/memory/db/ids.ts';
import { dbOf, type Db } from '../src/memory/db/types.ts';
import { buildDataDir, GUILD, MEMBER } from './fixtures/memory-db/datadir.ts';
import { seedUnits } from './fixtures/memory-db/seed.ts';
import { fixture, NOW } from './fixtures/memory-db/session-rig.ts';
import { tempDir } from './fixtures/tmp.ts';
import { a, profile } from './fixtures/memory-db/storage-ownership.ts';

// A second collection of the same account: its scope by community is gone, so a partition keeps the two owners apart.
const b: StorageKey = { ...a, partition: 'second' };
const day: StorageKey = {
  kind: 'record',
  subject: { type: 'place', id: legacyServerPlaceId('discord', 'g1') },
  partition: '2026-10-20',
};
const owner = `guilds/${GUILD}/users/${MEMBER}.json`;
const recordOwner = `guilds/${GUILD}/record/2026-10/2026-10-20.jsonl`;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function json(text: string): unknown {
  return JSON.parse(text);
}

function evidence(db: Db, id: unknown) {
  return db
    .prepare('SELECT source_id, position, retired_at FROM claim_sources WHERE claim_id = ? ORDER BY rowid')
    .all(id)
    .map((row) => [row.source_id, row.position, row.retired_at]);
}

function preserved(db: Db) {
  return Object.fromEntries(
    ['sources', 'claims', 'claim_sources', 'episodes', 'episode_sources', 'media'].map((table) => [
      table,
      db
        .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
        .all()
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).filter(
              ([key]) =>
                !['media', 'stems', 'tier', 'availability'].includes(key) && key !== 'owner_file' && key !== 'owner_key'
            )
          )
        ),
    ])
  );
}

test('migration and reopening preserve populated rows, ownership, evidence and append positions', () => {
  const dataDir = tempDir('neutral-owner-migration-');
  buildDataDir(dataDir);
  const file = path.join(dataDir, 'memory.db');
  const old = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 24) });
  let before: ReturnType<typeof preserved>;
  let positions: { lines: unknown; offset: unknown };
  const expectedLines: Array<unknown> = fs
    .readFileSync(path.join(dataDir, recordOwner), 'utf8')
    .trim()
    .split('\n')
    .map((line) => json(line))
    // A line with no media has no links, so it reads back with no `media` key.
    .map((line) => {
      const { media, ...rest } = line as { media?: Array<unknown> };
      return media && media.length > 0 ? line : rest;
    });
  try {
    assert.equal(seedUnits(old, dataDir).errors, 0);
    const db = dbOf(old);
    db.prepare("INSERT INTO files(path,kind,synced_at) VALUES (?, 'user', '2026-10-20T00:00:00Z')").run(
      `guilds/g2/users/${MEMBER}.json`
    );
    const shared = db.prepare('SELECT id FROM claims WHERE owner_file = ? LIMIT 1').get(owner);
    assert.ok(shared);
    db.prepare("INSERT INTO co_owners(tbl,key,owner_file) VALUES ('claims',?,?)").run(
      shared.id,
      `guilds/g2/users/${MEMBER}.json`
    );
    db.prepare("UPDATE claims SET retired_at = '2026-10-21T00:00:00Z' WHERE id = ?").run(shared.id);
    const source = db.prepare('SELECT id FROM sources ORDER BY rowid LIMIT 1').get();
    assert.ok(source);
    db.prepare('INSERT INTO claim_sources(claim_id,source_id,position,owner_file) VALUES (?,?,0,?)').run(
      shared.id,
      source.id,
      owner
    );
    db.prepare(
      "INSERT INTO claims(id,subject_kind,subject_id,kind,text,owner_file) VALUES ('session-kept','person',?,'detail','session-owned legacy claim',NULL)"
    ).run(personId('discord', MEMBER));
    for (const [suffix, kind] of [
      ['intentions.json', 'intentions'],
      ['intentions-archive.jsonl', 'intentions'],
      ['errands.json', 'errands'],
      ['errands.jsonl', 'errands'],
      ['journal/requests/2026-10-20/turn-1-s1.json', 'requests'],
    ])
      db.prepare('INSERT OR IGNORE INTO files(path,kind,synced_at) VALUES (?,?,?)').run(
        `guilds/${GUILD}/${suffix}`,
        kind,
        new Date(NOW).toISOString()
      );
    assert.equal(
      db
        .prepare('UPDATE files SET gone_at = ? WHERE path = ?')
        .run(new Date(NOW).toISOString(), `guilds/${GUILD}/media.json`).changes,
      1
    );
    before = preserved(db);
    const position = db.prepare('SELECT lines, offset FROM files WHERE path = ?').get(recordOwner);
    positions = { lines: position?.lines, offset: position?.offset };
  } finally {
    old.close();
  }
  for (let opening = 0; opening < 2; opening += 1) {
    const current = openMemoryDb(file);
    try {
      const db = dbOf(current);
      assert.deepEqual(preserved(db), before);
      const retired: StorageKey = {
        kind: 'media',
        subject: { type: 'place', id: legacyServerPlaceId('discord', GUILD) },
      };
      assert.deepEqual(listUnits(db, retired), []);
      const key: StorageKey = {
        kind: 'record',
        subject: { type: 'place', id: legacyServerPlaceId('discord', GUILD) },
        partition: '2026-10-20',
      };
      const [unit] = listUnits(db, key);
      assert.ok(unit);
      assert.deepEqual({ lines: unit.lines, offset: unit.offset }, { ...positions });
      assert.equal(
        db.prepare('SELECT COUNT(*) AS n FROM co_owners c JOIN storage_units u ON u.id=c.owner_key').get()?.n,
        1
      );
      assert.deepEqual(
        unitLines(db, key).map((line) => json(line)),
        expectedLines
      );
      assert.deepEqual(
        listUnits(db, { kind: 'intentions' })
          .map((unit) => unit.key.selector?.collection)
          .sort(),
        ['active', 'archive']
      );
      assert.deepEqual(
        listUnits(db, { kind: 'errands' })
          .map((unit) => unit.key.selector?.collection)
          .sort(),
        ['history', 'value']
      );
      assert.deepEqual(listUnits(db, { kind: 'requests' })[0].key.selector, { requestId: 'turn-1-s1' });
      assert.equal(listUnits(db, { kind: 'versions' })[0].key.selector?.versionKind, 'users');
    } finally {
      current.close();
    }
  }
});

test('collection replacement retains session-owned rows, evidence and held affinity fields', () => {
  const env = fixture();
  try {
    applyUnitWrite(env.handle, { op: 'value', key: a, value: profile });
    const source = env.say({ native: 'session-evidence', minutesAgo: 1, text: 'a synthetic source', author: 'u1' });
    applyMemoryWrite(env.handle, {
      kind: 'session',
      mode: 'apply',
      now: NOW,
      maxDelta: 5,
      run: {
        id: 'run:ownership',
        sweepId: 'sweep:ownership',
        scopeKey: 'group:discord',
        scope: env.group,
        batchKey: 'ownership',
        startedAt: new Date(NOW).toISOString(),
        finishedAt: new Date(NOW).toISOString(),
        cursorFrom: 0,
        cursorTo: 1,
        sourcesN: 1,
        outcome: 'ok',
        counts: {},
        errors: [],
      },
      plan: {
        claims: [
          {
            op: 'add',
            subjectKind: 'person',
            subjectId: personId('discord', 'u1'),
            kind: 'detail',
            text: 'session fact',
            how: 'said',
            sources: [source],
            when: null,
          },
        ],
        episodes: [],
        descriptions: [],
        affinity: [{ personId: personId('discord', 'u1'), delta: 3, reason: 'session reason', sources: [source] }],
      },
    });
    const claim = env.db.prepare("SELECT id, owner_key FROM claims WHERE text = 'session fact'").get();
    assert.ok(claim);
    assert.equal(claim.owner_key, null);
    const links = evidence(env.db, claim.id);
    assert.deepEqual(
      links.map((row) => row[0]),
      [source]
    );
    applyUnitWrite(env.handle, { op: 'value', key: a, value: profile });
    assert.deepEqual(evidence(env.db, claim.id), links);
    assert.equal(
      env.db.prepare('SELECT affinity FROM people WHERE id = ?').get(personId('discord', 'u1'))?.affinity,
      5
    );
    assert.equal(
      unitRows(env.db, a).claims.some((row) => row.id === claim.id),
      true
    );
  } finally {
    env.done();
  }
});

test('replacement omitting a shared primary claim preserves its surviving co-owner and evidence', () => {
  const env = fixture();
  const handle = env.handle;
  try {
    applyUnitWrite(handle, { op: 'value', key: a, value: profile });
    applyUnitWrite(handle, { op: 'value', key: b, value: profile });
    const db = dbOf(handle);
    const claim = db.prepare("SELECT id FROM claims WHERE text = 'likes café mornings'").get();
    assert.ok(claim);
    const source = env.say({
      native: 'shared-evidence',
      minutesAgo: 1,
      text: 'evidence of the shared claim',
      author: 'u1',
    });
    const [ownerUnit] = listUnits(db, b);
    assert.ok(ownerUnit);
    db.prepare('INSERT INTO claim_sources(claim_id,source_id,position,owner_key) VALUES (?,?,0,?)').run(
      claim.id,
      source,
      ownerUnit.id
    );
    const links = evidence(db, claim.id);
    assert.deepEqual(links, [[source, 0, null]]);
    applyUnitWrite(handle, { op: 'value', key: a, value: { ...profile, details: [] } });
    const [survivor] = listUnits(db, b);
    assert.ok(survivor);
    const saved = db.prepare('SELECT owner_key,retired_at FROM claims WHERE id = ?').get(claim.id);
    assert.deepEqual([saved?.owner_key, saved?.retired_at], [survivor.id, null]);
    assert.deepEqual(evidence(db, claim.id), links);
    assert.equal(
      unitRows(db, b).claims.some((row) => row.id === claim.id),
      true
    );
  } finally {
    handle.close();
  }
});

test('accepted legacy pending append translates once and keeps order across semantic append and reopen', async () => {
  const dataDir = tempDir('neutral-owner-pending-');
  const hot = { config: { memoryDb: { session: { mode: 'off' } } } };
  const first = {
    v: 1,
    id: 'legacy-row',
    kind: 'seen',
    messageId: 'm1',
    placeId: 'g1',
    scope: { channel: 'c1' },
    occurredAt: new Date(NOW).toISOString(),
    recordedAt: new Date(NOW).toISOString(),
    text: 'legacy accepted line',
  };
  const second = { ...first, id: 'semantic-row', messageId: 'm2', text: 'semantic appended line' };
  let service = createMemoryDb({ hot, dataDir, log: quiet, worker: false, now: () => NOW });
  service.keepPending({ op: 'lines', owner: 'guilds/g1/record/2026-10/2026-10-20.jsonl', lines: [first] });
  try {
    await service.open();
    assert.deepEqual(
      unitLines(service.database(), day).map((line) => json(line)),
      [first]
    );
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'memory-pending')), []);
    await service.writeUnit({ op: 'lines', key: day, lines: [second] });
    await service.close();
    service = createMemoryDb({ hot, dataDir, log: quiet, worker: false, now: () => NOW });
    await service.open();
    assert.deepEqual(
      unitLines(service.database(), day).map((line) => json(line)),
      [first, second]
    );
    assert.equal(listUnits(service.database()!, day)[0].lines, 2);
  } finally {
    await service.close();
  }
});
