// `scripts/memory-convert-places.ts`: the one offline rebuild of the one existing database (plan 2026-11-04-cli-and-memory,
// task 5, S0, S1, S10). It reads a closed v28 database, ideally a copy, and writes a new one beside it with no community
// partition left. The input is never written. Run as a process over a frozen synthetic database.
//
// Command: --input <memory.db> --output <new memory.db> --config-in <dir> --config-out <dir> --report <json> --now <iso>
// Exit: 0 converted, 1 refused (with `failures` in the report and no output), 2 usage.
// Report: { input: { sha256, schemaVersion }, output: { schemaVersion }, changed, contentHash,
//   tables: { <table>: { input, preserved, transformed, merged, removed, added, output } },
//   contradictions: [{ table, ids }], failures: [{ code, table?, id? }], config: { removed, moved } }
// `input = preserved + transformed + merged + removed`, `output = preserved + transformed + added`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openMemoryDb, schemaVersion } from '../src/memory/db/open.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import { storageId } from '../src/memory/db/storage-keys.ts';
import type { StorageKey } from '../src/memory/db/storage-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { CONFIG, convert, rowsOf, scene, sha256, tablesOf } from './fixtures/memory-db/one-server.ts';
import type { Row, Scene } from './fixtures/memory-db/one-server.ts';

type Counts = {
  input: number;
  preserved: number;
  transformed: number;
  merged: number;
  removed: number;
  added: number;
  output: number;
};
type Report = {
  input: { sha256: string; schemaVersion: number };
  output: { schemaVersion: number };
  changed: boolean;
  contentHash: string;
  tables: Record<string, Counts>;
  contradictions: Array<{ table: string; ids: Array<string> }>;
  failures: Array<{ code: string; table?: string; id?: string }>;
  config: { removed: Array<string>; moved: Array<{ from: string; to: string }> };
};

const reportOf = (where: Scene): Report => JSON.parse(fs.readFileSync(where.report, 'utf8')) as Report;

let shared: Scene | null = null;
/** The one successful conversion most tests read. */
function done(): Scene {
  if (shared !== null) return shared;
  const where = scene();
  const { status, stderr } = convert(where);
  assert.equal(status, 0, stderr);
  shared = where;
  return where;
}

const DAY = '2026-10-01';
const unitsOf = (file: string): Array<Row> => rowsOf(file, 'storage_units');
const keysOf = (file: string): Array<StorageKey> =>
  unitsOf(file).map((unit) => JSON.parse(String(unit.key_json)) as StorageKey);
const hasKey = (file: string, key: StorageKey): boolean => {
  const wanted = JSON.stringify(key, Object.keys(key).sort());
  return keysOf(file).some((one) => JSON.stringify(one, Object.keys(one).sort()) === wanted);
};
const place = (id: string) => ({ type: 'place' as const, id });
const account = (id: string) => ({ type: 'account' as const, id });
const PERSONA = { type: 'persona' as const, id: 'persona:local' };
const SERVER = 'discord:guild:g1';

// ---- the map of the collections ----

const MAPPED: ReadonlyArray<[string, StorageKey]> = [
  ['a user unit goes to its account', { kind: 'user', subject: account('discord:u1') }],
  ['a private unit goes to its account', { kind: 'private', subject: account('discord:u1') }],
  ['a no-community private unit goes to its account', { kind: 'private', subject: account('discord:u2') }],
  [
    'a private journal day goes to the actual DM place',
    { kind: 'journal', subject: place('discord:dm:u1'), partition: DAY },
  ],
  [
    'a no-community journal day goes to the actual DM place',
    { kind: 'journal', subject: place('discord:dm:u2'), partition: DAY },
  ],
  ['an empty-guild journal day goes to the persona', { kind: 'journal', subject: PERSONA, partition: DAY }],
  ['a server journal day stays with the server place', { kind: 'journal', subject: place(SERVER), partition: DAY }],
  ['a private record day goes to the DM place', { kind: 'record', subject: place('discord:dm:u1'), partition: DAY }],
  [
    'a no-community record day goes to the DM place',
    { kind: 'record', subject: place('discord:dm:u2'), partition: DAY },
  ],
  ['a public record day stays with the server place', { kind: 'record', subject: place(SERVER), partition: DAY }],
  [
    'a private archive month goes to the DM place',
    { kind: 'archive', subject: place('discord:dm:u1'), partition: '2026-10' },
  ],
  [
    'a public archive month stays with the server place',
    { kind: 'archive', subject: place(SERVER), partition: '2026-10' },
  ],
  ['a channel unit stays with its own place', { kind: 'channel', subject: place('discord:channel:c1') }],
  ['lore stays with the server place', { kind: 'lore', subject: place(SERVER) }],
  ['the gif library stays with the server place', { kind: 'gifs', subject: place(SERVER) }],
  ['the media cache stays with the server place', { kind: 'media', subject: place(SERVER) }],
  ['recent lines stay with the server place', { kind: 'recent', subject: place(SERVER) }],
  ['participation stays with the server place', { kind: 'participation', subject: place(SERVER) }],
  ['missed answers stay with the server place', { kind: 'missed', subject: place(SERVER) }],
  ['the notes of a server have a place kind', { kind: 'place', subject: place(SERVER) }],
  ['the diary goes to the persona', { kind: 'selfreflection', subject: PERSONA }],
  ['intentions go to the persona', { kind: 'intentions', subject: PERSONA, selector: { collection: 'active' } }],
  ['inner state stays with the persona', { kind: 'inner', subject: PERSONA }],
];

for (const [name, key] of MAPPED) {
  test(name, () => {
    // Bug: this collection keeps its community partition, and the neutral reader never finds it.
    assert.ok(hasKey(done().output, key), JSON.stringify(key));
  });
}

test('no unit keeps a community scope or a fabricated subject', () => {
  // Bug: a kind nobody listed stays under `discord:guild:no-community`, a place that does not exist.
  const units = unitsOf(done().output);
  assert.deepEqual(
    units.filter((unit) => unit.scope_place_id !== null).map((unit) => unit.key_json),
    []
  );
  assert.deepEqual(
    units.filter((unit) => /no-community|:guild:$/.test(String(unit.subject_id))).map((unit) => unit.key_json),
    []
  );
});

test('every place subject answers a stored place', () => {
  // Bug: a unit points at a place nobody can open from the browser.
  const known = new Set(rowsOf(done().output, 'places').map((row) => row.id));
  for (const unit of unitsOf(done().output)) {
    if (unit.subject_type === 'place') assert.ok(known.has(unit.subject_id), String(unit.key_json));
  }
});

test('every unit id is the storage id of its own key, and its columns agree with it', () => {
  // Bug: a rewritten key keeps its old id, so the reader's `storageId(key)` misses the row.
  for (const unit of unitsOf(done().output)) {
    const key = JSON.parse(String(unit.key_json)) as StorageKey;
    assert.equal(unit.id, storageId(key), String(unit.key_json));
    assert.equal(unit.kind, key.kind);
    assert.equal(unit.subject_type, key.subject.type);
    assert.equal(unit.subject_id, key.subject.id);
  }
});

test('the two partitions of one account become one unit that owns the rows of both', () => {
  // Bug: the second partition overwrites the first, or its rows point at a unit that is gone.
  const report = reportOf(done());
  assert.ok(report.tables.storage_units.merged >= 1);
  const owners = rowsOf(done().output, 'descriptions')
    .filter((row) => String(row.id).startsWith('description:said-'))
    .map((row) => row.owner_key);
  const unit = storageId({ kind: 'private', subject: account('discord:u2') });
  assert.deepEqual(owners, [unit, unit]);
});

// ---- owners and aliases ----

const OWNED = ['sources', 'claims', 'claim_versions', 'descriptions', 'description_versions', 'operational', 'people'];

test('every owner key answers a unit, and a row keeps its owner through the map', () => {
  // Bug: `owner_key` keeps the hash of the old key, so unit reads and exports lose the row.
  const known = new Set(unitsOf(done().output).map((unit) => unit.id));
  for (const table of OWNED) {
    for (const row of rowsOf(done().output, table)) {
      if (row.owner_key !== null) assert.ok(known.has(row.owner_key), `${table} ${String(row.id)}`);
    }
  }
  const owned = (id: string): unknown => rowsOf(done().output, 'sources').find((row) => row.id === id)?.owner_key;
  assert.equal(
    owned('src:discord:m2:1:seen'),
    storageId({ kind: 'record', subject: place('discord:dm:u1'), partition: DAY })
  );
  assert.equal(
    owned('src:discord:m3:1:seen'),
    storageId({ kind: 'record', subject: place('discord:dm:u2'), partition: DAY })
  );
});

test('an operational row owned by a unit id follows the unit', () => {
  // Bug: `operational.owner` holds the old unit id in its primary key, so state values read as absent.
  const known = new Set(unitsOf(done().output).map((unit) => unit.id));
  for (const row of rowsOf(done().output, 'operational')) {
    if (String(row.owner).startsWith('unit:')) assert.ok(known.has(row.owner), String(row.kind));
  }
});

test('a legacy path keeps its alias and points at the new unit', () => {
  // Bug: the alias table is dropped, or it refers to a unit id that no longer exists.
  const aliases = new Map(rowsOf(done().output, 'legacy_unit_aliases').map((row) => [row.path, row.unit_id]));
  assert.equal(aliases.get('guilds/g1/lore.json'), storageId({ kind: 'lore', subject: place(SERVER) }));
  assert.equal(
    aliases.get('guilds/g1/private/u1.json'),
    storageId({ kind: 'private', subject: account('discord:u1') })
  );
});

// ---- stored words and scopes ----

test('an archive scope names the place of its conversation', () => {
  // Bug: `{ guild: true }` and `{ user }` stay in stored entries, and the neutral reader decodes them for ever.
  const scopeOf = (claim: string): unknown => {
    const row = rowsOf(done().output, 'claim_versions').find((one) => one.claim_id === claim);
    return (JSON.parse(String(row?.extra)) as { scope: unknown }).scope;
  };
  assert.deepEqual(scopeOf('ar1'), { place: SERVER });
  assert.deepEqual(scopeOf('ar2'), { place: 'discord:dm:u1', private: true });
});

test('the stored guild words become place words, and the ids that spell them stay', () => {
  // Bug: a stored `guild` kind survives and the reader needs a decoder, or an id is rewritten and every reference breaks.
  const places = rowsOf(done().output, 'places');
  const server = places.find((row) => row.id === SERVER);
  assert.equal(server?.kind, 'server');
  assert.equal(server?.native_key, 'guild:g1');
  const kinds = rowsOf(done().output, 'operational').map((row) => row.kind);
  assert.equal(kinds.includes('guild'), false);
  assert.ok(kinds.includes('place'));
  assert.deepEqual(
    unitsOf(done().output).filter((unit) => unit.kind === 'guild'),
    []
  );
});

test('a line keeps its text and loses the community named in its extra', () => {
  // Bug: conversion rewrites what somebody said, or `extra.guildId` keeps `no-community` alive in a stored value.
  const before = rowsOf(done().input, 'sources');
  const after = rowsOf(done().output, 'sources');
  for (const row of before) {
    const next = after.find((one) => one.id === row.id);
    assert.equal(next?.text, row.text, String(row.id));
    assert.equal(next?.audience_id, row.audience_id, String(row.id));
    if (typeof row.extra !== 'string') continue;
    const given = JSON.parse(row.extra) as Row;
    const kept = JSON.parse(String(next?.extra)) as Row;
    assert.equal('guildId' in kept, false, String(row.id));
    assert.deepEqual(kept.sourceMessageIds, given.sourceMessageIds);
  }
});

test('a wake belongs to the persona and keeps its payload', () => {
  // Bug: the queue keeps `community`, and the persona's drain of a neutral core never picks the wake up.
  const wake = rowsOf(done().output, 'wakes').find((row) => row.id === 'inner.wake:heartbeat:1');
  assert.equal(wake?.community, null);
  assert.equal(wake?.state, 'queued');
  assert.equal(wake?.payload, '{"kind":"heartbeat"}');
});

// ---- what must not change ----

const UNCHANGED: ReadonlyArray<[string, ReadonlyArray<string>]> = [
  ['account_person_links', []],
  ['people_merges', []],
  ['audiences', []],
  ['authorities', []],
  ['interfaces', []],
  ['external_keys', []],
  ['people', ['owner_key']],
  ['accounts', ['owner_key']],
  ['memberships', ['owner_key']],
  ['claims', ['owner_key']],
  ['descriptions', ['owner_key']],
  ['episodes', ['owner_key']],
  ['affinity_events', ['owner_key']],
  ['publications', ['owner_key']],
  ['publication_grants', []],
  ['mirrors', []],
  ['selfreflection_mirrors', ['owner_key']],
  ['model_requests', []],
  ['execution_contexts', []],
];

/** B10 of the master plan: the output holds the rename of the last schema step, the frozen v28 input the old names. */
const OLD_TABLE: Readonly<Record<string, string>> = {
  selfreflection: 'diary',
  selfreflection_mirrors: 'diary_mirrors',
};

function inputRows(input: string, table: string, except: ReadonlyArray<string>): Array<Row> {
  return rowsOf(input, OLD_TABLE[table] ?? table, except).map(({ diary_id: entry, ...row }) => ({
    ...row,
    ...(entry === undefined ? {} : { selfreflection_id: entry }),
    ...(row.row_kind === 'diary' ? { row_kind: 'selfreflection' } : {}),
    ...(typeof row.idempotency_key === 'string'
      ? { idempotency_key: row.idempotency_key.replace(/^diary:/, 'selfreflection:') }
      : {}),
  }));
}

for (const [table, except] of UNCHANGED) {
  test(`${table} comes through row for row`, () => {
    // Bug: an id, an audience, a link's validity or a delivery state changes during the rebuild.
    assert.deepEqual(rowsOf(done().output, table, except), inputRows(done().input, table, except));
  });
}

test('places keep every id, parent and partner, and only the server kind changes', () => {
  // Bug: the hierarchy or a DM partner is lost, so `rootPlaceOf` and the person view stop answering.
  const except = ['kind', 'owner_key'];
  assert.deepEqual(rowsOf(done().output, 'places', except), rowsOf(done().input, 'places', except));
});

test('every publication state survives with its claim, receipts and reconciliation', () => {
  // Bug: conversion turns an uncertain send into an unsent entry, so the rebuilt database posts twice.
  const states = rowsOf(done().output, 'publications')
    .map((row) => row.status)
    .sort();
  assert.deepEqual(states, ['failed', 'incomplete', 'queued', 'sending', 'sent', 'unknown']);
  const sending = rowsOf(done().output, 'publications').find((row) => row.status === 'sending');
  assert.equal(sending?.claimed_by, 'worker-1');
  assert.equal(sending?.receipts, '[{"part":1,"id":"native-1"}]');
});

test('a request keeps its v28 links', () => {
  // Bug: the archive of requests loses its service, backend, run or outcome, and the watcher's evidence goes with it.
  const [request] = rowsOf(done().output, 'model_requests');
  assert.equal(request?.service, 'watcher');
  assert.equal(request?.backend, 'claude');
  assert.equal(request?.run_id, 'run-1');
  assert.equal(request?.outcome, 'done');
});

test('a retired row stays retired', () => {
  // Bug: a rebuild from current readers resurrects what the writer retired, or loses it.
  const row = rowsOf(done().output, 'claims').find((one) => one.id === 'claim:retired');
  assert.equal(row?.retired_at, '2026-10-01T12:00:00.000Z');
});

test('the output is a healthy database of the current schema, with the immutable triggers in place', () => {
  // Bug: a target built by hand lacks a CHECK or a trigger, and the opener migrates it again on the first start.
  const db = new DatabaseSync(done().output, { readOnly: true });
  try {
    assert.equal((db.prepare('PRAGMA integrity_check').get() as Row).integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<Row>).map(
      (row) => row.name
    );
    for (const name of ['publications_content_fixed', 'publication_grants_fixed', 'source_relations_no_delete']) {
      assert.ok(triggers.includes(name), name);
    }
    assert.equal(db.prepare("SELECT text FROM sources_fts WHERE sources_fts MATCH 'recorded'").all().length, 2);
  } finally {
    db.close();
  }
  const empty = openMemoryDb(':memory:');
  const latest = schemaVersion(dbOf(empty));
  empty.close();
  assert.equal(reportOf(done()).output.schemaVersion, latest);
});

// ---- the running engine over the output ----

test('the engine opens the output and reads the converted memory through its neutral readers', async () => {
  // Bug: the map and the readers disagree on a key, so she wakes up after the cutover remembering nothing.
  const dataDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'nep-converted-'));
  fs.copyFileSync(done().output, path.join(dataDir, 'memory.db'));
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
  });
  memoryDb.tick();
  try {
    const store = createStore({ dataDir, memoryDb });
    const details = (store.getPrivate('discord:u1') as { details: Array<{ text: string }> }).details;
    assert.deepEqual(
      details.map((one) => one.text),
      ['told in the server partition']
    );
    assert.equal(Reflect.get(store.getPlace(SERVER), 'patterns'), 'short synthetic lines');
    assert.deepEqual(
      store.getLore(SERVER).map((one): unknown => Reflect.get(one, 'title')),
      ['a synthetic fact']
    );
    assert.equal(store.rootPlaceOf('discord:channel:c1'), SERVER);
    assert.equal(store.rootPlaceOf('discord:dm:u1'), 'discord:dm:u1');
  } finally {
    await memoryDb.close();
  }
});

// ---- the report ----

test('every table of the input and the output is reconciled row for row', () => {
  // Bug: a table nobody listed is dropped in silence, and the report still reads as a success.
  const { input, output } = done();
  const { tables } = reportOf(done());
  for (const table of tablesOf(input)) {
    // B10 of the master plan: the report names a table as the output does.
    const counts = tables[table.replace(/^diary/, 'selfreflection')];
    assert.ok(counts, `no counts for ${table}`);
    assert.equal(counts.input, rowsOf(input, table).length, `input of ${table}`);
    assert.equal(counts.preserved + counts.transformed + counts.merged + counts.removed, counts.input, table);
  }
  for (const table of tablesOf(output)) {
    const counts = tables[table];
    assert.ok(counts, `no counts for ${table}`);
    assert.equal(counts.output, rowsOf(output, table).length, `output of ${table}`);
    assert.equal(counts.preserved + counts.transformed + counts.added, counts.output, table);
  }
});

test('nothing is removed from any table', () => {
  // Bug: a malformed or awkward row disappears, the one loss a rebuild cannot show later.
  const removed = Object.entries(reportOf(done()).tables).filter(([, counts]) => counts.removed !== 0);
  assert.deepEqual(removed, []);
});

test('the report holds counts and hashes and no memory', () => {
  // Bug: the report of a real database is pasted into a task and carries private text with it.
  const text = fs.readFileSync(done().report, 'utf8');
  for (const words of [
    'told in the server partition',
    'a teacher',
    'a sailor',
    'the roof holds bees',
    'a recorded line',
  ]) {
    assert.equal(text.includes(words), false, words);
  }
  assert.equal(reportOf(done()).input.schemaVersion, 28);
  assert.equal(reportOf(done()).input.sha256, sha256(done().input));
});

// ---- contradictions ----

test('contradictory records both stay, and the report names them', () => {
  // Bug: the last partition wins, and what she was told under the server is gone without a trace.
  const { output } = done();
  const versions = rowsOf(output, 'description_versions').map((row) => row.text);
  assert.ok(versions.includes('a teacher, said under the server'));
  assert.ok(versions.includes('a sailor, said with no community'));
  const named = reportOf(done()).contradictions.find((one) => one.table === 'descriptions');
  assert.deepEqual(named?.ids.slice().sort(), ['description:said-under-server', 'description:said-with-no-community']);
});

// ---- repetition ----

test('the same input converts to the same rows', () => {
  // Bug: a timestamp or a random id makes two rehearsals incomparable, so the hash proves nothing.
  const first = done();
  const again = scene();
  assert.equal(convert(again).status, 0);
  assert.equal(reportOf(again).contentHash, reportOf(first).contentHash);
  for (const table of tablesOf(first.output)) {
    assert.deepEqual(rowsOf(again.output, table), rowsOf(first.output, table), table);
  }
});

test('converting the output changes nothing', () => {
  // Bug: a second run moves a converted key again, or merges what the first run left apart.
  const first = done();
  const again: Scene = {
    ...scene(),
    input: first.output,
    configIn: first.configOut,
  };
  assert.equal(convert(again).status, 0);
  const report = reportOf(again);
  assert.equal(report.changed, false);
  assert.equal(report.contentHash, reportOf(first).contentHash);
  for (const [table, counts] of Object.entries(report.tables)) {
    assert.deepEqual([counts.transformed, counts.merged, counts.removed, counts.added], [0, 0, 0, 0], table);
  }
  assert.deepEqual(reportOf(again).config.removed, []);
});

// ---- the input is never touched ----

test('a successful run leaves the input bytes and folder as they were', () => {
  // Bug: opening the closed WAL file writes to it, or leaves `-wal` and `-shm` beside what was to be the rollback copy.
  const where = scene();
  const before = sha256(where.input);
  const folder = fs.readdirSync(path.dirname(where.input)).sort();
  assert.equal(convert(where).status, 0);
  assert.equal(sha256(where.input), before);
  assert.deepEqual(fs.readdirSync(path.dirname(where.input)).sort(), folder);
});

const REFUSALS: ReadonlyArray<[string, string, (where: Scene) => void, (db: DatabaseSync) => void]> = [
  [
    'a row owned by a unit nobody registered',
    'ORPHAN_OWNER',
    () => {},
    (db) => db.exec("UPDATE claims SET owner_key = 'unit:missing' WHERE id = 'ar1'"),
  ],
  [
    'a unit whose key does not parse',
    'BAD_UNIT_KEY',
    () => {},
    (db) => db.exec("UPDATE storage_units SET key_json = '{not json' WHERE kind = 'lore'"),
  ],
  [
    'a private partition of an account with no DM place to go to',
    'NO_DM_PLACE',
    () => {},
    (db) => db.exec("DELETE FROM places WHERE id = 'discord:dm:u1'"),
  ],
  [
    'a schema this conversion does not know',
    'UNSUPPORTED_SCHEMA',
    () => {},
    (db) => db.exec('DELETE FROM schema_version WHERE version = 28'),
  ],
  [
    'a database some process still holds',
    'DATABASE_OPEN',
    (where) => fs.writeFileSync(`${where.input}.lock`, JSON.stringify({ pid: process.pid, startedAt: 'now' })),
    () => {},
  ],
  [
    'a write-ahead log not yet checkpointed',
    'DATABASE_OPEN',
    (where) => fs.writeFileSync(`${where.input}-wal`, 'pending frames'),
    () => {},
  ],
  ['a target that already exists', 'TARGET_EXISTS', (where) => fs.writeFileSync(where.output, 'something'), () => {}],
];

for (const [name, code, prepare, edit] of REFUSALS) {
  test(`${name} is refused with ${code}, the input untouched and no output left`, () => {
    // Bug: a partial target looks activatable, or a failure repairs the input in place.
    const where = scene(edit);
    prepare(where);
    const before = sha256(where.input);
    const existing = fs.existsSync(where.output) ? sha256(where.output) : null;
    assert.equal(convert(where).status, 1);
    assert.equal(sha256(where.input), before);
    assert.ok(
      reportOf(where).failures.some((failure) => failure.code === code),
      code
    );
    if (existing !== null) assert.equal(sha256(where.output), existing);
    else {
      assert.deepEqual(
        fs.readdirSync(where.outDir).filter((name2) => name2 !== 'report.json'),
        []
      );
    }
  });
}

test('a run with no arguments is a usage error and touches nothing', () => {
  // Bug: a default path sends the conversion at the live database.
  const where = scene();
  const { status } = convert({ ...where, input: '' });
  assert.equal(status, 2);
  assert.equal(fs.existsSync(where.output), false);
});

// ---- config ----

test('the config loses the two retired keys and keeps everything else', () => {
  // Bug: a hand edit at cutover forgets one, or the conversion drops a setting of the owner's.
  const out = JSON.parse(fs.readFileSync(path.join(done().configOut, 'config.json'), 'utf8')) as typeof CONFIG;
  assert.deepEqual(out, {
    bot: { timezone: 'UTC', owners: ['u1'] },
    memory: { aliasHalfLifeDays: 3 },
    selfreflection: { enabled: true },
  });
  assert.deepEqual(reportOf(done()).config.removed, ['memory.mainChannelIds']);
});

test('the server moves to the settings of the Discord interface', () => {
  // Bug: `bot.guildId` is deleted, and the adapter no longer knows which server it serves.
  const file = path.join(done().configOut, 'interfaces', 'discord', 'config.json');
  assert.deepEqual((JSON.parse(fs.readFileSync(file, 'utf8')) as { servers: Array<string> }).servers, ['g1']);
  assert.deepEqual(reportOf(done()).config.moved, [
    { from: 'bot.guildId', to: 'interfaces/discord/config.json#servers' },
  ]);
});

test('a server list the interface already holds is kept, with the server added once', () => {
  // Bug: the owner's list is replaced by the one id, and a second server drops out.
  const where = scene();
  fs.mkdirSync(path.join(where.configIn, 'interfaces', 'discord'), { recursive: true });
  fs.writeFileSync(
    path.join(where.configIn, 'interfaces', 'discord', 'config.json'),
    '{"servers":["g1","g2"],"intents":[]}'
  );
  assert.equal(convert(where).status, 0);
  const out = JSON.parse(
    fs.readFileSync(path.join(where.configOut, 'interfaces', 'discord', 'config.json'), 'utf8')
  ) as object;
  assert.deepEqual(out, { servers: ['g1', 'g2'], intents: [] });
});

test('the input config files stay as they were', () => {
  // Bug: the cutover cannot roll back because the old config is gone.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(done().configIn, 'config.json'), 'utf8')), CONFIG);
});
