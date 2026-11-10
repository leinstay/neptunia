// The owner columns of the profile tables (src/memory/db/profile-owner.ts): every row an account's profile, a private
// layer or a history of prose writes names its writer and its holder, and every row her memory session writes is
// `session`, so the profile readers, the retirement of what a profile no longer holds and her session's rows need no
// unit. The tests read with the units' ownership taken away, rewrite a profile, and check that the writers register no
// unit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkedProfileUnit } from '../src/memory/db/person-links.ts';
import { unitValue } from '../src/memory/db/readers/common.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { accountCollection, placeCollection } from '../src/memory/db/storage-keys.ts';
import type { Db, MemoryHandle, Row } from '../src/memory/db/types.ts';
import { NOW, fixture, personOf } from './fixtures/memory-db/session-rig.ts';

// A member the fixture seeds no person for, so the profile owns its person's row.
const MEMBER = 'u-carol';
const ACCOUNT = `discord:${MEMBER}`;
const LINKED = 'discord:u-linked';
const ROOT = 'discord:guild:300000000000000001';
const PROFILE_TABLES = [
  'people',
  'accounts',
  'memberships',
  'claims',
  'descriptions',
  'description_versions',
  'episodes',
  'affinity_events',
  'operational',
];

const profile = (extra: Row = {}): Row => ({
  firstSeen: '2026-10-01T10:00:00.000Z',
  messageCount: 3,
  character: 'Warm.',
  relationship: 'Friendly.',
  interests: [
    { topic: 'chess', weight: 2, firstSeen: '2026-10-01', lastSeen: '2026-10-02', itemId: 'i1' },
    { topic: 'tea', weight: 1, firstSeen: '2026-10-01', lastSeen: '2026-10-01', itemId: 'i2' },
  ],
  episodes: [{ date: '2026-10-01', what: 'joked', weight: 1, itemId: 'e1' }],
  affinity: { score: 5, reason: 'kind', history: [{ ts: '2026-10-01T00:00:00.000Z', delta: 5, score: 5 }] },
  names: ['Ada'],
  addressedAs: { Ada: { score: 1 } },
  ...extra,
});

const history = (texts: ReadonlyArray<string>): Row => ({
  character: texts.map((text, i) => ({ at: `2026-10-0${i + 1}T00:00:00.000Z`, by: 'analyzer', text, itemId: `v${i}` })),
});

/** A session run that adds a claim about the member and moves the attitude toward them, from one line. */
function sessionRun(handle: MemoryHandle, source: string, group: Row): void {
  applyMemoryWrite(handle, {
    kind: 'session',
    mode: 'apply',
    now: NOW,
    maxDelta: 5,
    run: {
      id: 'run:owner',
      sweepId: 'sweep:owner',
      scopeKey: 'group:discord',
      scope: group,
      batchKey: 'owner',
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
          subjectId: personOf(MEMBER),
          kind: 'detail',
          text: 'session fact',
          how: 'said',
          sources: [source],
          when: null,
        },
      ],
      episodes: [],
      descriptions: [],
      affinity: [{ personId: personOf(MEMBER), delta: 3, reason: 'session reason', sources: [source] }],
    },
  });
}

/** A profile, a linked account's own facts, a private layer, histories of prose and a session run. */
function writeAll(env: ReturnType<typeof fixture>): void {
  const write = (update: Row) => applyMemoryWrite(env.handle, { now: NOW, iface: 'discord', ...update });
  write({ kind: 'account-profile', accountId: ACCOUNT, value: profile() });
  const source = env.say({ native: 'owner-evidence', minutesAgo: 1, text: 'a synthetic line' });
  sessionRun(env.handle, source, env.group);
  write({ kind: 'account-profile', accountId: ACCOUNT, value: profile({ interests: [] }) });
  write({ kind: 'account-profile', accountId: LINKED, value: { names: ['Linked'] } });
  write({ kind: 'private-layer', accountId: ACCOUNT, value: { relationship: 'Close.', replies: { count: 1 } } });
  write({ kind: 'prose-versions', versionKind: 'users', subjectId: ACCOUNT, itemId: ACCOUNT, value: history(['a']) });
  write({ kind: 'prose-versions', versionKind: 'place', subjectId: ROOT, itemId: 'guild', value: history(['b']) });
  write({ kind: 'prose-versions', versionKind: 'lore', subjectId: ROOT, itemId: 'title-1', value: history(['c']) });
}

test('the profile, the private layer, the histories and the linked unit read the same once no unit owns the rows', () => {
  const env = fixture();
  try {
    writeAll(env);
    env.db
      .prepare('UPDATE accounts SET person_id = (SELECT person_id FROM accounts WHERE id = ?) WHERE id = ?')
      .run(ACCOUNT, LINKED);
    const read = () => ({
      profile: unitValue(env.db, accountCollection('user', ACCOUNT)),
      linkedOwn: unitValue(env.db, accountCollection('user', LINKED)),
      private: unitValue(env.db, accountCollection('private', ACCOUNT)),
      users: unitValue(
        env.db,
        accountCollection('versions', ACCOUNT, { selector: { versionKind: 'users', itemId: ACCOUNT } })
      ),
      lore: unitValue(
        env.db,
        placeCollection('versions', ROOT, { selector: { versionKind: 'lore', itemId: 'title-1' } })
      ),
      linked: linkedProfileUnit(env.db, LINKED)?.key ?? null,
    });
    const before = read();
    assert.equal((before.profile as { value?: { character?: unknown } }).value?.character, 'Warm.');
    for (const table of PROFILE_TABLES) env.db.exec(`UPDATE "${table}" SET owner_key = NULL WHERE writer != 'session'`);
    assert.deepEqual(read(), before);
  } finally {
    env.done();
  }
});

test('a profile rewrite retires what it no longer holds and leaves her session rows about the person', () => {
  const env = fixture();
  try {
    writeAll(env);
    const live = (id: string) =>
      env.db.prepare('SELECT retired_at FROM claims WHERE id = ?').get(id)?.retired_at === null;
    assert.equal(live('i1'), false);
    assert.equal(
      env.db.prepare("SELECT COUNT(*) AS n FROM claims WHERE writer = 'session' AND retired_at IS NULL").get()?.n,
      1
    );
  } finally {
    env.done();
  }
});

/** The storage units and the rows naming a unit or a file the writes left: none once the rows own themselves. */
function legacyOwners(db: Db): Array<string> {
  const found: Array<string> = [];
  if (Number(db.prepare('SELECT COUNT(*) AS n FROM storage_units').get()?.n) > 0) found.push('storage_units');
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    if (name === 'graph_edges') continue; // its owner_key is the graph's own key, not a unit
    const columns = db
      .prepare(`PRAGMA table_info("${String(name)}")`)
      .all()
      .map((column) => String(column.name));
    for (const column of ['owner_key', 'owner_file', 'origin_file'].filter((col) => columns.includes(col)))
      if (db.prepare(`SELECT 1 FROM "${String(name)}" WHERE "${column}" IS NOT NULL LIMIT 1`).get())
        found.push(`${String(name)}.${column}`);
  }
  return found;
}

test('the profile writers register no storage unit and name no unit in a row', () => {
  const env = fixture();
  try {
    writeAll(env);
    assert.deepEqual(legacyOwners(env.db), []);
  } finally {
    env.done();
  }
});
