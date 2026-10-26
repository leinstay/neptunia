// Schema v7 (spec 2026-10-24-memory-schema-v7, stage 1): the migration of a database the unit writers filled at v6, a
// replay of the unit writes after v7 (the derived columns re-derived, links and DM places kept, nothing nulled), the new ids (canonical keys, node ids, aliases with generations and event time), the
// recorded execution contexts and turn reads, and the access classification of every table (docs/memory.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIGRATIONS, openMemoryDb, schemaVersion } from '../src/memory/db/open.js';
import { SCOPED_TABLES } from '../src/memory/db/schema.js';
import { seedUnits } from './fixtures/memory-db/seed.js';
import { insertRows } from '../src/memory/db/rows.js';
import { applyMemoryWrite } from '../src/memory/db/session-write.js';
import { insertTurnReads } from '../src/memory/db/service.js';
import {
  AUD_INTERNAL,
  audienceOf,
  contextRow,
  dmScope,
  groupScope,
  issueContext,
  wellFormed,
} from '../src/memory/db/scope.ts';
import { applyDiaryUpdate } from '../src/memory/db/diary-media.js';
import { canonicalKey, dmPlaceId, linkId, newPersonId, nodeId, personId, resolveAlias } from '../src/memory/db/ids.ts';
import { main } from '../tools/memory-db.mjs';
import { GUILD, MEMBER, buildDataDir, guildDir, seen, writeJson, writeLines } from './fixtures/memory-db/datadir.js';

const PROPOSED = '100000000000000007';
const STRANGER = '100000000000000008';
const NEWCOMER = '100000000000000009';
const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const count = (db, sql, ...params) => db.prepare(sql).get(...params).n;

/** A data directory written into a database at schema v6 (the unit writers of today, on the old schema), with a few rows the units never make. */
function importedAtV6() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-v7-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const file = path.join(root, 'memory.db');
  const old = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 6) });
  const result = seedUnits(old, data, { log: quiet });
  assert.equal(result.errors, 0);
  const db = old.db;
  // An account whose link is not verified, a DM row of a partner no file has a DM place for, malformed triples, and a
  // turn read of the old shape.
  db.prepare("INSERT INTO people (id, kind) VALUES (?, 'member')").run(personId('discord', PROPOSED));
  db.prepare(
    "INSERT INTO accounts (id, iface, native_id, person_id, link) VALUES (?, 'discord', ?, ?, 'proposed')"
  ).run(`discord:${PROPOSED}`, PROPOSED, personId('discord', PROPOSED));
  const claim = (id, kind, iface, dm) =>
    db
      .prepare(
        `INSERT INTO claims (id, subject_kind, subject_id, kind, text, scope_kind, scope_iface, scope_dm, created_at)
    VALUES (?, 'person', ?, 'detail', 'synthetic', ?, ?, ?, '2026-10-01T00:00:00.000Z')`
      )
      .run(id, personId('discord', MEMBER), kind, iface, dm);
  claim('k-dm-stranger', 'dm', 'discord', personId('discord', STRANGER));
  claim('k-bad-dm', 'dm', 'discord', 'not-a-person');
  claim('k-bad-kind', 'whatever', 'discord', null);
  claim('k-group-null', 'group', null, null);
  db.prepare(
    "INSERT INTO turn_reads (turn_id, step, row_kind, row_id, block, ord) VALUES ('t-old', 's0', 'claims', 'k-dm-stranger', 'people', 1)"
  ).run();
  old.close();
  return { root, data, file, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const run = (...argv) => {
  const lines = [];
  const code = main(argv, { out: (line) => lines.push(line), err: (line) => lines.push(line) });
  return { code, text: lines.join('\n') };
};

/** Every scoped row's audience is the resolver's answer for its triple. */
function assertAudiences(db) {
  for (const table of SCOPED_TABLES) {
    for (const row of db.prepare(`SELECT scope_kind, scope_iface, scope_dm, audience_id FROM "${table}"`).all()) {
      assert.equal(row.audience_id, audienceOf(row).audience_id, `${table}: ${JSON.stringify({ ...row })}`);
    }
  }
}

function migrate(env) {
  const started = performance.now();
  const handle = openMemoryDb(env.file);
  const ms = performance.now() - started;
  return { handle, ms };
}

test('v7 migration of an imported database: audiences, DM places, links, her row, keys, integrity', (t) => {
  const env = importedAtV6();
  const { handle, ms } = migrate(env);
  const { db } = handle;
  try {
    t.diagnostic(`v7 migration of the fixture database: ${ms.toFixed(1)} ms`);
    // The database goes to the newest schema; v7 is the seventh entry (tests/memory-db-v8.test.js pins the count).
    assert.equal(schemaVersion(db), MIGRATIONS.length);
    assert.ok(MIGRATIONS.length >= 7);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assertAudiences(db);

    // The DM places of every partner a row names, with their audience.
    for (const user of [MEMBER, STRANGER]) {
      const place = db.prepare('SELECT * FROM places WHERE id = ?').get(dmPlaceId('discord', user));
      assert.ok(place, `the DM place of ${user}`);
      assert.deepEqual(
        [
          place.kind,
          place.conversation,
          place.partner_person,
          place.partner_account,
          place.owner_file,
          place.authority_id,
          place.native_key,
        ],
        ['dm', 'dm', personId('discord', user), `discord:${user}`, null, 'discord/global', `dm:${user}`]
      );
      assert.equal(
        count(
          db,
          'SELECT COUNT(*) AS n FROM audiences WHERE id = ? AND place_id = ?',
          `aud:dm:${dmPlaceId('discord', user)}`,
          dmPlaceId('discord', user)
        ),
        1
      );
    }
    assert.equal(
      db.prepare("SELECT conversation FROM places WHERE kind = 'guild'").get().conversation,
      null,
      'a server is a container'
    );
    assert.equal(db.prepare("SELECT conversation FROM places WHERE kind = 'channel'").get().conversation, 'group');

    // Malformed triples: internal, and one quarantine decision per table and triple.
    for (const id of ['k-bad-dm', 'k-bad-kind', 'k-group-null'])
      assert.equal(db.prepare('SELECT audience_id FROM claims WHERE id = ?').get(id).audience_id, AUD_INTERNAL, id);
    const quarantined = db
      .prepare("SELECT target_id, extra FROM decisions WHERE action = 'migration:scope_quarantined' ORDER BY id")
      .all();
    assert.equal(quarantined.length, 3);
    assert.ok(quarantined.every((row) => row.target_id === 'claims' && JSON.parse(row.extra).rows === 1));

    // Links: verified only where the account said verified.
    const links = db
      .prepare('SELECT account_id, person_id, state, by FROM account_person_links ORDER BY account_id')
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(links, [
      { account_id: `discord:${MEMBER}`, person_id: personId('discord', MEMBER), state: 'verified', by: 'migration' },
      {
        account_id: `discord:${PROPOSED}`,
        person_id: personId('discord', PROPOSED),
        state: 'proposed',
        by: 'migration',
      },
    ]);

    // Her own row, and keys for every person, account and place.
    assert.deepEqual(
      { ...db.prepare("SELECT kind, status FROM people WHERE id = 'person:self'").get() },
      { kind: 'self', status: 'active' }
    );
    assert.equal(
      db
        .prepare(
          "SELECT node_id FROM external_keys WHERE authority_id = 'core/local' AND object_kind = 'person' AND native_key = 'self'"
        )
        .get().node_id,
      'person:self'
    );
    for (const [table, kind] of [
      ['people', 'person'],
      ['accounts', 'account'],
      ['places', 'place'],
    ]) {
      for (const { id } of db.prepare(`SELECT id FROM ${table}`).all()) {
        const keys = db
          .prepare('SELECT authority_id FROM external_keys WHERE node_id = ? AND object_kind = ? ORDER BY authority_id')
          .all(id, kind)
          .map((row) => row.authority_id);
        assert.ok(keys.length >= 1, `${id} has a key`);
        if (id !== 'person:self')
          assert.ok(
            keys.includes('legacy/local') && keys.some((key) => key !== 'legacy/local'),
            `${id}: native and legacy keys (${keys})`
          );
      }
    }
    assert.equal(
      db
        .prepare(
          "SELECT node_id FROM external_keys WHERE authority_id = 'discord/global' AND object_kind = 'person' AND native_key = ?"
        )
        .get(MEMBER).node_id,
      personId('discord', MEMBER)
    );
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM authorities WHERE id = ?', `discord/guild:${GUILD}`), 1);

    // Accounts and sources: authority, native key, author kind, observed time.
    const account = db
      .prepare('SELECT authority_id, native_key, generation, kind FROM accounts WHERE id = ?')
      .get(`discord:${MEMBER}`);
    assert.deepEqual(
      { ...account },
      { authority_id: 'discord/global', native_key: MEMBER, generation: 1, kind: 'user' }
    );
    assert.equal(
      count(
        db,
        "SELECT COUNT(*) AS n FROM sources WHERE kind = 'seen' AND (author_kind IS NOT 'account' OR authority_id IS NOT 'discord/global' OR observed_at IS NOT recorded_at)"
      ),
      0
    );
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM sources WHERE kind = 'answer' AND author_kind IS NOT 'self'"), 0);

    // turn_reads: rebuilt, the old row kept with an empty context, the context now part of the key.
    assert.deepEqual(
      { ...db.prepare("SELECT context_id, reader_kind, block, ord FROM turn_reads WHERE turn_id = 't-old'").get() },
      { context_id: '', reader_kind: 'turn', block: 'people', ord: 1 }
    );
    db.prepare(
      "INSERT INTO turn_reads (turn_id, step, context_id, row_kind, row_id) VALUES ('t-old', 's0', 'ctx:2', 'claims', 'k-dm-stranger')"
    ).run();
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM turn_reads WHERE turn_id = 't-old'"), 2);
    // A FTS row still follows its text after the trigger was narrowed.
    db.prepare("UPDATE sources SET text = 'ein Kaffeehaus' WHERE native_id = '400000000000000002'").run();
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM sources_tri WHERE sources_tri MATCH \'"Kaffeehaus"\''), 1);
  } finally {
    handle.close();
    env.done();
  }
});

test('v7: the stats after the migration count the audiences of the sources', () => {
  const env = importedAtV6();
  try {
    migrate(env).handle.close();
    const stats = run('stats', '--db', env.file);
    assert.equal(stats.code, 0);
    assert.match(stats.text, /sources .* audience dm=1 \(1 places\) group:discord=4/);
  } finally {
    env.done();
  }
});

/** The v7 columns that a remap must keep (or re-derive to the same values). */
function derivedSnapshot(db) {
  const all = (sql) =>
    db
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  return {
    scoped: SCOPED_TABLES.map((table) =>
      all(`SELECT '${table}' AS t, rowid AS r, audience_id FROM "${table}" ORDER BY rowid`)
    ),
    accounts: all('SELECT id, authority_id, native_key, generation, kind FROM accounts ORDER BY id'),
    places: all(
      'SELECT id, authority_id, native_key, conversation, partner_person, partner_account FROM places ORDER BY id'
    ),
    sources: all('SELECT id, authority_id, author_kind, observed_at FROM sources ORDER BY id'),
    links: all('SELECT * FROM account_person_links ORDER BY id'),
    keys: all(
      'SELECT authority_id, object_kind, native_key, generation, node_id FROM external_keys ORDER BY 1, 2, 3, 4'
    ),
  };
}

test('v7: a replay of the unit writes re-derives the new columns, keeps links and DM places, nulls nothing', () => {
  const env = importedAtV6();
  const { handle } = migrate(env);
  const { db } = handle;
  try {
    // A link the database changed (revoked) is the database's own: a remap never rewrites it.
    db.prepare(
      "UPDATE account_person_links SET state = 'revoked', valid_to_at = '2026-10-24T00:00:00.000Z' WHERE account_id = ?"
    ).run(`discord:${MEMBER}`);
    const before = derivedSnapshot(db);
    assert.equal(seedUnits(handle, env.data, { log: quiet }).errors, 0);
    const replay = seedUnits(handle, env.data, { log: quiet });
    assert.equal(replay.errors, 0);
    assert.ok(replay.units > 10, 'every unit was written again');
    assert.deepEqual(derivedSnapshot(db), before, 'the replay over the same files leaves every v7 column as it was');

    // A changed file: the profile renames the member and a private record of a new partner arrives.
    const profileFile = path.join(guildDir(env.data), 'users', `${MEMBER}.json`);
    writeJson(profileFile, { ...JSON.parse(fs.readFileSync(profileFile, 'utf8')), names: ['Zoé'] });
    writeLines(path.join(guildDir(env.data), 'private', NEWCOMER, 'record', '2026-10', '2026-10-21.jsonl'), [
      seen('400000000000000031', 1, 'a word in private', {
        by: NEWCOMER,
        scope: { channel: '200000000000000097' },
        direct: true,
      }),
    ]);
    const changed = seedUnits(handle, env.data, { log: quiet });
    assert.equal(changed.errors, 0);
    assertAudiences(db);
    for (const table of SCOPED_TABLES)
      assert.equal(
        count(db, `SELECT COUNT(*) AS n FROM "${table}" WHERE audience_id IS NULL`),
        0,
        `${table}: no audience nulled`
      );
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM accounts WHERE authority_id IS NULL OR native_key IS NULL'), 0);
    assert.equal(
      count(
        db,
        "SELECT COUNT(*) AS n FROM places WHERE authority_id IS NULL OR (kind = 'channel' AND conversation IS NOT 'group')"
      ),
      0
    );
    assert.equal(
      db.prepare('SELECT state FROM account_person_links WHERE account_id = ?').get(`discord:${MEMBER}`).state,
      'revoked',
      'the link row is never rewritten'
    );
    const fresh = db
      .prepare('SELECT kind, conversation, partner_person, owner_file FROM places WHERE id = ?')
      .get(dmPlaceId('discord', NEWCOMER));
    assert.deepEqual(
      { ...fresh },
      { kind: 'dm', conversation: 'dm', partner_person: personId('discord', NEWCOMER), owner_file: null },
      'a DM line of a new partner brings its DM place'
    );
    assert.equal(
      db.prepare("SELECT audience_id FROM sources WHERE native_id = '400000000000000031'").get().audience_id,
      `aud:dm:${dmPlaceId('discord', NEWCOMER)}`
    );
    for (const user of [MEMBER, STRANGER])
      assert.ok(
        db.prepare('SELECT 1 AS ok FROM places WHERE id = ?').get(dmPlaceId('discord', user)),
        `the DM place of ${user} is kept`
      );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    handle.close();
    env.done();
  }
});

test("v7 writers: a given audience that is not the triple's is quarantined; her session rows and media carry their audience", () => {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
  try {
    const warned = [];
    const log = { warn: (message, fields) => warned.push({ message, fields }) };
    insertRows(
      db,
      {
        claims: [
          {
            id: 'k-ok',
            subject_kind: 'person',
            subject_id: personId('discord', 'u1'),
            kind: 'detail',
            text: 'x',
            ...dmScope(personId('discord', 'u1'), 'discord'),
          },
          {
            id: 'k-given',
            subject_kind: 'person',
            subject_id: personId('discord', 'u1'),
            kind: 'detail',
            text: 'x',
            ...dmScope(personId('discord', 'u1'), 'discord'),
            audience_id: `aud:dm:${dmPlaceId('discord', 'u1')}`,
          },
          {
            id: 'k-conflict',
            subject_kind: 'person',
            subject_id: personId('discord', 'u1'),
            kind: 'detail',
            text: 'x',
            ...dmScope(personId('discord', 'u1'), 'discord'),
            audience_id: 'aud:group:discord',
          },
        ],
      },
      { log }
    );
    const row = (id) => ({ ...db.prepare('SELECT scope_kind, audience_id FROM claims WHERE id = ?').get(id) });
    assert.deepEqual(row('k-ok'), { scope_kind: 'dm', audience_id: `aud:dm:${dmPlaceId('discord', 'u1')}` });
    assert.deepEqual(row('k-given'), { scope_kind: 'dm', audience_id: `aud:dm:${dmPlaceId('discord', 'u1')}` });
    assert.deepEqual(row('k-conflict'), { scope_kind: 'internal', audience_id: AUD_INTERNAL });
    assert.deepEqual(
      warned.map((entry) => entry.fields),
      [{ table: 'claims', code: 'AUDIENCE_CONFLICT' }],
      'the conflict is logged, with a code only'
    );

    // Her session answer (internal) and a context write.
    applyMemoryWrite(handle, {
      kind: 'session',
      mode: 'shadow',
      now: Date.parse('2026-10-24T12:00:00.000Z'),
      run: {
        id: 'run:1',
        scopeKey: `dm:discord:${personId('discord', 'u1')}`,
        scope: dmScope(personId('discord', 'u1'), 'discord'),
        startedAt: 'a',
        finishedAt: 'b',
        outcome: 'ok',
        counts: {},
        errors: [],
      },
      plan: null,
      answer: { text: '<think>t</think><memory>{}</memory>' },
    });
    assert.deepEqual(
      {
        ...db.prepare("SELECT audience_id, author_kind, authority_id FROM sources WHERE kind = 'memory_session'").get(),
      },
      { audience_id: AUD_INTERNAL, author_kind: 'self', authority_id: 'core/local' }
    );
    assert.equal(
      db.prepare("SELECT audience_id FROM session_runs WHERE id = 'run:1'").get().audience_id,
      `aud:dm:${dmPlaceId('discord', 'u1')}`
    );
    // A diary picture takes the diary row's audience.
    insertRows(db, { diary: [{ id: 'd-1', at_ms: 1, kind: 'day', gist: 'g', ...groupScope('discord') }] });
    applyDiaryUpdate(handle, {
      id: 'd-1',
      text: 'the post',
      media: [
        { id: 'media:d-1:1', path: 'media/diary/d-1-1.png', nativeRef: 'r', sha1: 's', bytes: 1, mime: 'image/png' },
      ],
    });
    assert.equal(
      db.prepare("SELECT audience_id FROM media WHERE id = 'media:d-1:1'").get().audience_id,
      'aud:group:discord'
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    handle.close();
  }
});

test('v7 contexts: an issued context is recorded once, and turn reads carry its id and the reader kind', () => {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
  try {
    const ctx = issueContext({
      kind: 'dm',
      person: personId('discord', 'u1'),
      now: () => Date.parse('2026-10-24T12:00:00.000Z'),
      newId: () => 'ctx:one',
    });
    assert.deepEqual(applyMemoryWrite(handle, { kind: 'context', context: contextRow(ctx) }), { written: 1 });
    assert.deepEqual(
      applyMemoryWrite(handle, { kind: 'context', context: contextRow(ctx) }),
      { written: 0 },
      'a context is recorded once'
    );
    assert.deepEqual(
      { ...db.prepare('SELECT * FROM execution_contexts').get() },
      {
        id: 'ctx:one',
        mode: 'outward',
        iface: 'discord',
        destination_place_id: dmPlaceId('discord', 'u1'),
        partner_person_id: personId('discord', 'u1'),
        policy_version: 1,
        issued_at: '2026-10-24T12:00:00.000Z',
      }
    );
    insertTurnReads(handle, 't-1', 's0', [
      { row_kind: 'claims', row_id: 'k1', block: 'people', ord: 1, context_id: 'ctx:one', reader_kind: 'turn' },
      { row_kind: 'claims', row_id: 'k1', block: 'people', ord: 1 },
      { row_kind: 'claims', row_id: 'k2', ord: 2, context_id: 'ctx:one', reader_kind: 'nonsense' },
    ]);
    assert.deepEqual(
      db
        .prepare('SELECT row_id, context_id, reader_kind FROM turn_reads ORDER BY row_id, context_id')
        .all()
        .map((row) => ({ ...row })),
      [
        { row_id: 'k1', context_id: '', reader_kind: 'turn' },
        { row_id: 'k1', context_id: 'ctx:one', reader_kind: 'turn' },
        { row_id: 'k2', context_id: 'ctx:one', reader_kind: 'turn' },
      ]
    );
    assert.throws(() => applyMemoryWrite(handle, { kind: 'context', context: { id: '' } }), /BAD_CONTEXT/);
  } finally {
    handle.close();
  }
});

test('ids: canonical keys and node ids are stable spellings; a NUL is refused; new persons are uuids', () => {
  assert.equal(canonicalKey('account', ['discord/global', '123', 1]), '["account","discord/global","123",1]');
  assert.equal(canonicalKey('participant', ['site/x', undefined, '']), '["participant","site/x",null,""]');
  assert.throws(() => canonicalKey('account', ['a\u0000b']), /NUL/);
  const a = nodeId('account', ['discord/global', '123', 1]);
  assert.match(a, /^account:[0-9a-f]{32}$/);
  assert.equal(nodeId('account', ['discord/global', '123', 1]), a);
  assert.notEqual(
    nodeId('account', ['discord/global', '123', 2]),
    a,
    'a reused native key in a new generation is a new node'
  );
  assert.notEqual(
    nodeId('place', ['discord/global', '123', 1]).slice('place:'.length),
    a.slice('account:'.length),
    'the kind is part of the key'
  );
  assert.equal(
    newPersonId(() => '0b5c6a1e-8f7d-4c2b-9a3e-1d2c3b4a5f60'),
    'person:0b5c6a1e-8f7d-4c2b-9a3e-1d2c3b4a5f60'
  );
  assert.match(newPersonId(), /^person:[0-9a-f-]{36}$/);
  assert.equal(linkId('discord:1', 'person:discord:1'), 'link:discord:1:person:discord:1');
});

test('resolveAlias: event time picks the generation; overlapping windows and times outside every window are unresolved', () => {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
  try {
    const key = (generation, node, from, to, native = 'handle-1') =>
      db
        .prepare(
          `INSERT INTO external_keys (authority_id, object_kind, native_key, generation, node_id, valid_from_at, valid_to_at, recorded_at)
      VALUES ('discord/global', 'account', ?, ?, ?, ?, ?, '2026-10-24T00:00:00.000Z')`
        )
        .run(native, generation, node, from, to);
    // A handle sold on 2026-06-01: the first owner's account until then, a new node after.
    key(
      1,
      nodeId('account', ['discord/global', 'handle-1', 1]),
      '2026-01-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z'
    );
    key(2, nodeId('account', ['discord/global', 'handle-1', 2]), '2026-06-01T00:00:00.000Z', null);
    assert.equal(
      resolveAlias(db, 'discord/global', 'account', 'handle-1', '2026-03-01T00:00:00.000Z'),
      nodeId('account', ['discord/global', 'handle-1', 1])
    );
    assert.equal(
      resolveAlias(db, 'discord/global', 'account', 'handle-1', '2026-07-01T00:00:00.000Z'),
      nodeId('account', ['discord/global', 'handle-1', 2])
    );
    assert.equal(
      resolveAlias(db, 'discord/global', 'account', 'handle-1', null),
      nodeId('account', ['discord/global', 'handle-1', 2]),
      'no time: the open alias'
    );
    const before = resolveAlias(db, 'discord/global', 'account', 'handle-1', '2025-01-01T00:00:00.000Z');
    assert.equal(before.unresolved, true, 'a time outside every window is never "the latest"');
    assert.equal(before.candidates.length, 2);
    // Two windows that overlap.
    key(1, 'account:a', '2026-01-01T00:00:00.000Z', null, 'handle-2');
    key(2, 'account:b', '2026-05-01T00:00:00.000Z', null, 'handle-2');
    assert.equal(resolveAlias(db, 'discord/global', 'account', 'handle-2', '2026-03-01T00:00:00.000Z'), 'account:a');
    const both = resolveAlias(db, 'discord/global', 'account', 'handle-2', '2026-06-01T00:00:00.000Z');
    assert.equal(both.unresolved, true);
    assert.deepEqual(
      both.candidates.map((row) => row.node_id),
      ['account:a', 'account:b']
    );
    assert.equal(resolveAlias(db, 'discord/global', 'account', 'never-seen', null), null);
    assert.ok(wellFormed(dmScope(personId('discord', 'u1'), 'discord')));
  } finally {
    handle.close();
  }
});
