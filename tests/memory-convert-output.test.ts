// What the offline conversion leaves on disk and what it carries that the row map alone does not: the output is readable by
// its owner alone, a failure of any kind leaves no output, the diary's day plan follows the persona, and a wake's lines that
// the shipped code filed under a group go back to their DM. Over the frozen synthetic v28 database, with no model involved.
//
// Exit: 0 converted, 1 refused or failed, 2 usage (the message names the argument).
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createMemoryDb } from '../src/memory/db/service.ts';
import { keyText, personaKey, placeCollection, storageId } from '../src/memory/db/storage-keys.ts';
import { convertFile } from '../src/memory/migration/convert.ts';
import { createStore } from '../src/memory/store.ts';
import { SCRIPT, convert, rowsOf, scene } from './fixtures/memory-db/one-server.ts';
import type { Row, Scene } from './fixtures/memory-db/one-server.ts';

const NOW = '2026-11-06T00:00:00.000Z';
const modeOf = (file: string): number => fs.statSync(file).mode & 0o777;
const optionsOf = (where: Scene) => ({
  input: where.input,
  output: where.output,
  configIn: where.configIn,
  configOut: where.configOut,
  report: where.report,
  now: NOW,
});
/** A failed conversion left nothing a cutover could take for its result. */
function assertNoOutput(where: Scene): void {
  assert.equal(fs.existsSync(where.output), false);
  assert.deepEqual(
    fs.readdirSync(path.dirname(where.output)).filter((name) => name.startsWith('.convert-')),
    []
  );
}

// ---- who can read the output ----

test('the output database is readable by its owner alone', () => {
  // Bug: the new file takes the umask, so every user of the server reads her memory.
  const where = scene();
  assert.equal(convert(where).status, 0);
  assert.equal(modeOf(where.output), 0o600);
});

test('the report is readable by its owner alone', () => {
  // Bug: the report names the ids of the people and the rows of a private database.
  const where = scene();
  assert.equal(convert(where).status, 0);
  assert.equal(modeOf(where.report), 0o600);
});

test('a report of a refusal is readable by its owner alone', () => {
  // Bug: only the successful path sets the mode.
  const where = scene();
  fs.writeFileSync(where.output, 'something');
  assert.equal(convert(where).status, 1);
  assert.equal(modeOf(where.report), 0o600);
});

test('every converted config file is readable by its owner alone', () => {
  // Bug: `cpSync` keeps the source's mode, and the written files take the umask.
  const where = scene();
  fs.mkdirSync(path.join(where.configIn, 'nested'));
  fs.writeFileSync(path.join(where.configIn, 'nested', 'extra.json'), '{}\n', { mode: 0o644 });
  assert.equal(convert(where).status, 0);
  const files = ['config.json', 'interfaces/discord/config.json', 'nested/extra.json'];
  assert.deepEqual(
    files.map((file) => modeOf(path.join(where.configOut, file))),
    [0o600, 0o600, 0o600]
  );
});

// ---- a failure leaves nothing ----

test('a file given as --config-in is a usage error that names the argument and leaves no output', () => {
  // Bug: `cpSync` throws ERR_FS_CP_NON_DIR_TO_DIR after the rename, so a crash leaves a database that looks finished.
  const where = scene();
  const file = path.join(path.dirname(where.configIn), 'config-file');
  fs.writeFileSync(file, '{}\n');
  const { status, stderr } = convert({ ...where, configIn: file });
  assert.equal(status, 2);
  assert.match(stderr, /--config-in/);
  assertNoOutput(where);
});

test('an input that does not exist is a usage error that names the argument', () => {
  // Bug: hashing the missing file throws, and the owner reads a stack trace.
  const where = scene();
  const { status, stderr } = convert({ ...where, input: `${where.input}.missing` });
  assert.equal(status, 2);
  assert.match(stderr, /--input/);
  assertNoOutput(where);
});

test('a time that is no date is a usage error that names the argument', () => {
  // Bug: the report and the conversion stamp whatever was typed.
  const where = scene();
  const { status, stderr } = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--input',
      where.input,
      '--output',
      where.output,
      '--config-in',
      where.configIn,
      '--config-out',
      where.configOut,
      '--report',
      where.report,
      '--now',
      'not-a-date',
    ],
    { env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }, encoding: 'utf8', timeout: 60000 }
  );
  assert.equal(status, 2);
  assert.match(stderr, /--now/);
  assertNoOutput(where);
});

test('a config that does not parse fails with exit 1, no output and no config folder', () => {
  // Bug: the config is converted after the database moved into place, so its failure leaves half a result.
  const where = scene();
  fs.writeFileSync(path.join(where.configIn, 'config.json'), '{ not json');
  assert.equal(convert(where).status, 1);
  assertNoOutput(where);
  assert.equal(fs.existsSync(where.configOut), false);
});

test('a config target that cannot be written leaves no output', () => {
  // Bug: the same order, with the failure coming from the disk.
  const where = scene();
  fs.writeFileSync(where.configOut, 'a file where the folder goes');
  const { status } = convert(where);
  assert.ok(status === 1 || status === 2, String(status));
  assertNoOutput(where);
});

test('a report that cannot be written leaves no output', () => {
  // Bug: the report is the last step, and the database is already in place when it fails.
  const where = scene();
  fs.mkdirSync(where.report);
  const { status } = convert(where);
  assert.ok(status === 1 || status === 2, String(status));
  assertNoOutput(where);
});

test('an input that is no database fails with exit 1 and no output', () => {
  // Bug: the failure escapes as a crash after the work folder was made.
  const where = scene();
  fs.writeFileSync(where.input, 'this is not a database');
  assert.equal(convert(where).status, 1);
  assertNoOutput(where);
});

// ---- the diary's day plan ----

type Plan = { day: string; slots: Array<number>; done: Array<number>; hunger: Array<number>; quietStreak: number };
const PLAN: Plan = { day: '2026-11-05', slots: [100, 200], done: [100], hunger: [2, 1], quietStreak: 1 };

/** A stored `state` value, in the persona's collection, with the day plan under `key`. */
function withState(db: DatabaseSync, value: object): void {
  const key = personaKey('state');
  const unit = storageId(key);
  db.prepare(
    `INSERT INTO storage_units (id, kind, subject_type, subject_id, key_json, synced_at)
     VALUES (?, 'state', 'persona', 'persona:local', ?, '2026-11-05T00:00:00.000Z')`
  ).run(unit, keyText(key));
  db.prepare(`INSERT INTO operational (kind, owner, value, owner_key) VALUES ('state', ?, ?, ?)`).run(
    unit,
    JSON.stringify(value),
    unit
  );
}

/** The state value of a converted database, read back by the store the engine uses. */
async function stateAfter(value: object): Promise<{ diary?: Record<string, Plan | undefined>; marker?: unknown }> {
  const where = scene((db) => withState(db, value));
  assert.equal(convertFile(optionsOf(where)), 0);
  const dataDir = path.dirname(where.output);
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
  });
  memoryDb.tick();
  try {
    const data: unknown = createStore({ dataDir, memoryDb }).state.data;
    return structuredClone(data) as { diary?: Record<string, Plan | undefined>; marker?: unknown };
  } finally {
    await memoryDb.close();
  }
}

test('the day plan of the served community moves to the persona, with its done marks and its hunger', async () => {
  // Bug: the plan stays under `g1`, the diary plans the cutover day afresh and posts the slots it already spoke in.
  const state = await stateAfter({ marker: 1, diary: { g1: PLAN } });
  assert.equal(state.marker, 1);
  assert.deepEqual(state.diary?.persona, PLAN);
});

test('no day plan stays under the community key', async () => {
  // Bug: a copy left behind names the server for ever and is read by nothing.
  const state = await stateAfter({ diary: { g1: PLAN } });
  assert.deepEqual(Object.keys(state.diary ?? {}), ['persona']);
});

test('the newest day plan wins when several communities held one', async () => {
  // Bug: the order of the keys decides, and the older day loses the done marks of the cutover day.
  const older = { ...PLAN, day: '2026-11-01', done: [] };
  const state = await stateAfter({ diary: { g0: older, g1: PLAN } });
  assert.deepEqual(state.diary?.persona, PLAN);
});

test('a plan already under the persona is kept', async () => {
  // Bug: converting a converted database starts the day over.
  const state = await stateAfter({ diary: { persona: PLAN } });
  assert.deepEqual(state.diary?.persona, PLAN);
});

// ---- a wake's lines filed under a group ----

// The shipped code wrote a wake's post into a DM to the community's record and journal with `{ channel }`, so its rows say
// `group`. The DM's own lines name the same conversation in their locator, which is all the repair may read.
const DM = 'discord:dm:u1';
const DM_CONVERSATION = 'dm-native';
const GUILD_RECORD = 'unit:c676dd55b9f169af18945bcc0bf315e1';
const GUILD_JOURNAL = 'unit:e1b7d6fbdaa52629a94025070f7f9d43';
const AT = '2026-10-01T12:00:00.000Z';

function saidIn(db: DatabaseSync, rowid: number, id: string, conversation: string): void {
  db.prepare(
    `INSERT INTO sources (rowid, id, kind, iface, native_id, revision, place_id, occurred_at, recorded_at, text, extra,
       scope_kind, scope_iface, origin, position, authority_id, author_kind, audience_id, native_kind, generation, owner_key)
     VALUES (?, ?, 'said', 'discord', ?, 1, ?, ?, ?, ?, ?, 'group', 'discord', 'live', 90, 'discord/global', 'self',
       'aud:group:discord', 'message', 1, ?)`
  ).run(
    rowid,
    id,
    id,
    `discord:channel:${conversation}`,
    AT,
    AT,
    `words of ${id}`,
    JSON.stringify({ v: 1, id, guildId: 'g1', participants: [], sourceMessageIds: [] }),
    GUILD_RECORD
  );
}

function misfiled(db: DatabaseSync): void {
  saidIn(db, 9001, 'wake-in-dm', DM_CONVERSATION);
  saidIn(db, 9002, 'wake-in-channel', 'c1');
  saidIn(db, 9003, 'wake-in-unknown', 'no-such-conversation');
  db.prepare(
    `INSERT INTO day (id, at, what, place_id, turn_id, extra, scope_kind, scope_iface, position, audience_id, owner_key)
     VALUES ('post-in-dm', ?, 'action', ?, 't-wake', ?, 'group', 'discord', 90, 'aud:group:discord', ?)`
  ).run(
    AT,
    `discord:channel:${DM_CONVERSATION}`,
    JSON.stringify({ v: 1, name: 'post', intent: { replyTo: null, text: 'words of the wake' } }),
    GUILD_JOURNAL
  );
  db.prepare(
    `INSERT INTO vectors (source_rowid, chunk_key, model, dims, scale, norm, bytes, occurred_at, scope_kind, scope_iface,
       audience_id, owner_key)
     VALUES (9001, 'chunk:wake-in-dm', 'test-model', 1, 1, 1, x'01', ?, 'group', 'discord', 'aud:group:discord', NULL)`
  ).run(AT);
}

let repaired: Scene | null = null;
function repairedScene(): Scene {
  if (repaired !== null) return repaired;
  const where = scene(misfiled);
  const { status, stderr } = convert(where);
  assert.equal(status, 0, stderr);
  repaired = where;
  return where;
}
const rowOf = (where: Scene, table: string, id: string, column = 'id'): Row | undefined =>
  rowsOf(where.output, table).find((row) => row[column] === id);
const scopeOfRow = (row: Row | undefined) => [row?.scope_kind, row?.scope_iface, row?.scope_dm, row?.audience_id];
const DM_SCOPE = ['dm', 'discord', 'person:discord:u1', `aud:dm:${DM}`];
const GROUP_SCOPE = ['group', 'discord', null, 'aud:group:discord'];

test("a wake's said line in a DM gets the DM's scope", () => {
  // Bug: the line stays `aud:group:discord` and every group's search finds what she told one person.
  assert.deepEqual(scopeOfRow(rowOf(repairedScene(), 'sources', 'wake-in-dm')), DM_SCOPE);
});

test("a wake's said line in a DM moves to the DM's place and record, its text as it was", () => {
  // Bug: a scope changed alone leaves the line out of the partner's record, so the DM's reads never find it.
  const row = rowOf(repairedScene(), 'sources', 'wake-in-dm');
  const unit = storageId(placeCollection('record', DM, { partition: '2026-10-01' }));
  assert.deepEqual([row?.place_id, row?.owner_key, row?.text], [DM, unit, 'words of wake-in-dm']);
});

test("a wake's post operation in a DM gets the DM's scope and journal", () => {
  // Bug: the row's intent holds up to eighty characters of her words under a group audience.
  const row = rowOf(repairedScene(), 'day', 'post-in-dm');
  const unit = storageId(placeCollection('journal', DM, { partition: '2026-10-01' }));
  assert.deepEqual([...scopeOfRow(row), row?.place_id, row?.owner_key], [...DM_SCOPE, DM, unit]);
});

test("the vector of a wake's said line in a DM gets the DM's scope", () => {
  // Bug: the meaning index keeps answering a group with a line whose text was repaired.
  assert.deepEqual(scopeOfRow(rowOf(repairedScene(), 'vectors', 'chunk:wake-in-dm', 'chunk_key')), DM_SCOPE);
});

test('a said line in a real channel stays in the group', () => {
  // Bug: a repair by `kind = said` closes the group's own history.
  const row = rowOf(repairedScene(), 'sources', 'wake-in-channel');
  assert.deepEqual([...scopeOfRow(row), row?.place_id], [...GROUP_SCOPE, 'discord:channel:c1']);
});

test('a said line in a conversation no DM names stays where it was', () => {
  // Bug: a guess from an unknown id moves a line into a stranger's DM.
  const row = rowOf(repairedScene(), 'sources', 'wake-in-unknown');
  assert.deepEqual([...scopeOfRow(row), row?.place_id], [...GROUP_SCOPE, 'discord:channel:no-such-conversation']);
});
