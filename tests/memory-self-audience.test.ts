// The claims about herself under `aud:none` (master plan V.5). Their writer is `toRows` of the place mapper,
// src/memory/db/map/place.ts:119, which gives a place's `self` list `SCOPE_NONE`: a self fact noted in a DM could be shown
// anywhere. The correction: a self fact takes the scope of the notes it stands in, the groups on a server or channel and
// the partner's DM on a DM, and `scripts/memory-repair-self-audience.ts` brings the stored rows to it, leaving a row with
// a recorded reason alone. Synthetic data on a real temporary database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { OBSERVATION_VERSION } from '../src/memory/db/observe.ts';
import { placeCollection } from '../src/memory/db/storage-keys.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { runAudit } from './fixtures/memory-audit-world.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts', 'memory-repair-self-audience.ts');
const GROUP = 'discord:channel:room';
const DM = 'discord:dm:owner';
const FACT_WORDS = 'likes-rain-synthetic';

const observed = (key: string, kind: 'dm' | 'channel', native: string) => ({
  v: OBSERVATION_VERSION,
  iface: 'discord',
  authority: 'discord/global',
  native: { kind: 'message', key: native, revision: 1 },
  place: {
    authority: 'discord/global',
    key,
    kind,
    conversation: kind === 'dm' ? 'dm' : 'group',
    // Slice 3 (9 d): the audit counts an unnamed room, so the room carries its title as a live one does.
    ...(kind === 'dm' ? {} : { title: 'αίθουσα' }),
  },
  author: { kind: 'account', key: 'owner' },
  occurredAt: '2026-11-03T09:00:00.000Z',
  observedAt: '2026-11-03T09:00:01.000Z',
  text: 'a synthetic opening line',
  mentions: [],
  direct: kind === 'dm',
  relations: [],
});

/** A stopped core's database whose #room and whose DM each hold one self fact, written by the place's own writer. */
async function withSelfFacts(): Promise<string> {
  const env = await openTestMemory();
  await env.memoryDb.observe(observed('channel:room', 'channel', 'room-first'), null);
  await env.memoryDb.observe(observed('dm:owner', 'dm', 'dm-first'), null);
  for (const place of [GROUP, DM])
    await env.memoryDb.writeUnit({
      op: 'value',
      key: placeCollection('place', place),
      value: { self: [`${FACT_WORDS} ${place}`] },
    });
  const file = path.join(env.dataDir, 'memory.db');
  await env.close();
  // Slice 3 (9 d): the audit counts an unnamed interface; the name arrives with the interface's hello, absent here.
  const db = new DatabaseSync(file);
  db.exec("UPDATE interfaces SET name = 'Discord' WHERE id = 'discord'");
  db.close();
  return file;
}

type SelfRow = { place: string; scope_kind: string; audience_id: string };

/** The live self facts, each with the place whose notes hold it. */
function selfRows(file: string): Array<SelfRow> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT u.subject_id AS place, c.scope_kind, c.audience_id FROM claims c JOIN storage_units u ON u.id = c.owner_key
         WHERE c.kind = 'self_fact' AND c.retired_at IS NULL ORDER BY place`
      )
      .all()
      .map((row) => ({ ...row }) as SelfRow);
  } finally {
    db.close();
  }
}

/** What the old writer left: every self fact of the file under `aud:none`, in its row and in the graph. */
function asTheOldWriterLeftIt(file: string): void {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`UPDATE claims SET scope_kind = 'none', scope_iface = NULL, scope_dm = NULL, audience_id = 'aud:none' WHERE kind = 'self_fact';
    UPDATE OR REPLACE node_access SET audience_id = 'aud:none'
      WHERE node_id IN (SELECT n.id FROM graph_nodes n JOIN claims c ON c.id = n.row_id WHERE c.kind = 'self_fact');`);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

const repair = (file: string, ...flags: ReadonlyArray<string>) => {
  const done = spawnSync(process.execPath, [SCRIPT, '--db', file, ...flags], { encoding: 'utf8', env: {} });
  return { status: done.status, stdout: done.stdout, stderr: done.stderr };
};
const hashOf = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// ---------- the writer ----------

// Bug: a new self fact is written under aud:none, the row the audit has to find again after every repair.
test('a self fact in the notes of a channel is written for the groups', async () => {
  const rows = selfRows(await withSelfFacts());
  const row = rows.find((one) => one.place === GROUP);
  assert.equal(row?.scope_kind, 'group');
  assert.equal(row?.audience_id, 'aud:group:discord');
});

// Bug: what she noted about herself in a private chat can be shown in any channel.
test('a self fact in the notes of a DM stays in that DM', async () => {
  const rows = selfRows(await withSelfFacts());
  const row = rows.find((one) => one.place === DM);
  assert.equal(row?.scope_kind, 'dm');
  assert.equal(row?.audience_id, `aud:dm:${DM}`);
});

// ---------- the stored rows ----------

// Bug: the repair runs on production without having shown what it would do.
test('the repair without --apply writes nothing and prints what it would do', async () => {
  const file = await withSelfFacts();
  asTheOldWriterLeftIt(file);
  const before = hashOf(file);
  const run = repair(file);
  assert.equal(run.status, 0);
  assert.deepEqual(JSON.parse(run.stdout), { group: 1, dm: 1, internal: 0, kept: 0, applied: false });
  assert.equal(hashOf(file), before);
});

// Bug: the rows are moved but keep their old audience in the graph, so a read through it still shows them anywhere.
test('the repair gives each stored row the audience of its place, in the graph too, and the audit is clean', async () => {
  const file = await withSelfFacts();
  asTheOldWriterLeftIt(file);
  const run = repair(file, '--apply');
  assert.equal(run.status, 0);
  assert.deepEqual(JSON.parse(run.stdout), { group: 1, dm: 1, internal: 0, kept: 0, applied: true });
  assert.deepEqual(
    selfRows(file).map((row) => [row.place, row.scope_kind, row.audience_id]),
    [
      [GROUP, 'group', 'aud:group:discord'],
      [DM, 'dm', `aud:dm:${DM}`],
    ]
  );
  const db = new DatabaseSync(file, { readOnly: true });
  const stale = db
    .prepare(
      `SELECT COUNT(*) AS n FROM node_access a JOIN graph_nodes n ON n.id = a.node_id JOIN claims c ON c.id = n.row_id
       WHERE c.kind = 'self_fact' AND a.audience_id = 'aud:none'`
    )
    .get();
  db.close();
  assert.equal(stale?.n, 0);
  assert.equal(runAudit(['--db', file]).status, 0);
});

// Bug: a row with no place to read a scope from is guessed into the groups and shown.
test('a stored row whose place cannot be found becomes internal, never shown', async () => {
  const file = await withSelfFacts();
  asTheOldWriterLeftIt(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`INSERT INTO claims (id, subject_kind, subject_id, kind, text, scope_kind, audience_id)
    VALUES ('claim:orphan', 'self', 'person:self', 'self_fact', '${FACT_WORDS}', 'none', 'aud:none')`);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  assert.equal((JSON.parse(repair(file, '--apply').stdout) as { internal: number }).internal, 1);
  const read = new DatabaseSync(file, { readOnly: true });
  assert.equal(
    read.prepare("SELECT audience_id FROM claims WHERE id = 'claim:orphan'").get()?.audience_id,
    'aud:internal'
  );
  read.close();
});

// Bug: the repair overrides the owner's recorded word that none is right for this row.
test('a row with a recorded reason stays under aud:none', async () => {
  const file = await withSelfFacts();
  asTheOldWriterLeftIt(file);
  const db = new DatabaseSync(file);
  const row = db.prepare("SELECT id FROM claims WHERE kind = 'self_fact' ORDER BY id LIMIT 1").get();
  db.prepare(
    `INSERT INTO decisions (id, at, by, target_kind, target_id, action, reason)
     VALUES ('decision:1', '2026-11-05T00:00:00.000Z', 'owner', 'claims', ?, 'audience-none-kept', 'source free')`
  ).run(String(row?.id));
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  const report = JSON.parse(repair(file, '--apply').stdout) as { kept: number };
  assert.equal(report.kept, 1);
  const read = new DatabaseSync(file, { readOnly: true });
  assert.equal(
    read.prepare('SELECT audience_id FROM claims WHERE id = ?').get(String(row?.id))?.audience_id,
    'aud:none'
  );
  read.close();
});

// Bug: a second run after a crash fails or moves something again.
test('a second run finds nothing to do', async () => {
  const file = await withSelfFacts();
  asTheOldWriterLeftIt(file);
  repair(file, '--apply');
  const before = hashOf(file);
  const again = repair(file, '--apply');
  assert.equal(again.status, 0);
  assert.deepEqual(JSON.parse(again.stdout), { group: 0, dm: 0, internal: 0, kept: 0, applied: true });
  assert.equal(hashOf(file), before);
});

// Bug: the repair prints the facts about her into a log.
test('the output holds no words of a row', async () => {
  const file = await withSelfFacts();
  asTheOldWriterLeftIt(file);
  const run = repair(file, '--apply');
  assert.equal(run.status, 0);
  assert.equal(`${run.stdout}${run.stderr}`.includes(FACT_WORDS), false);
  assert.equal(`${run.stdout}${run.stderr}`.includes(DM), false);
});
