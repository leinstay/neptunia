// Schema v17, the data step that repairs what the unit sync undid (spec 2026-10-31-memory-two-writers, rule 6). A
// database at v16 holds a member's file as the sync left it after her session's work: a revise and a confirm of two
// of the file's claims, a description review and an attitude reason, each kept only in its version or event row
// while the row itself shows the file's state again. One open sets each row back to the latest session state, takes
// the row over for the session, and asks nothing of anyone; a second open changes nothing. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MIGRATIONS, openMemoryDb } from '../src/memory/db/open.js';
import { exportOne } from '../src/memory/db/export.js';
import { applyUnitWrite } from '../src/memory/db/unit-write.js';
import { seedUnits } from './fixtures/memory-db/seed.js';
import { GUILD, MEMBER, seen, writeJson, writeLines } from './fixtures/memory-db/datadir.js';
import { tempDir } from './fixtures/tmp.js';

type Row = Record<string, unknown>;
type Statement = {
  all(...params: Array<unknown>): Array<Row>;
  get(...params: Array<unknown>): Row | undefined;
  run(...params: Array<unknown>): unknown;
};
type Db = { prepare(sql: string): Statement };
type Item = { itemId?: unknown; text?: unknown; lastSeen?: unknown };
type Profile = { details?: Array<Item>; character?: unknown; affinity?: { score?: unknown; reason?: unknown } };

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const PERSON = `person:discord:${MEMBER}`;
const USER_REL = `guilds/${GUILD}/users/${MEMBER}.json`;
const DESCRIPTION = `desc:${PERSON}:character`;
const REVIEW = `${DESCRIPTION}:review-1`;
const REVISED = 'drinks a freddo café at ten';
const REVIEWED = 'Calm, answers slowly, and laughs at her own jokes.';
const REASON = 'fixed the net with me';
const REVISED_AT = '2026-10-26T09:00:00.000Z';
const CONFIRMED_AT = '2026-10-27T09:00:00.000Z';
const REVIEWED_AT = '2026-10-28T09:00:00.000Z';
const MOVED_AT = '2026-10-29T09:00:00.000Z';

/** The member's file: three details, a character text and an attitude with one old move. */
const PROFILE = {
  id: MEMBER,
  names: ['Ada'],
  firstSeen: '2026-09-01T00:00:00.000Z',
  lastSeen: '2026-10-20T00:00:00.000Z',
  messageCount: 10,
  details: [
    { itemId: 'det-cafe', text: 'drinks a café at nine', weight: 1, lastSeen: '2026-09-02T00:00:00.000Z' },
    { itemId: 'det-sea', text: 'swims in the sea', weight: 1, lastSeen: '2026-09-03T00:00:00.000Z' },
    { itemId: 'det-plain', text: 'keeps a red bicycle', weight: 1, lastSeen: '2026-09-04T00:00:00.000Z' },
  ],
  character: 'Calm, answers slowly.',
  affinity: {
    score: 12,
    reason: 'shared a swim story',
    history: [{ ts: '2026-09-20T00:00:00.000Z', delta: 2, appliedDelta: 2, score: 10, reason: 'shared a swim story' }],
  },
};

/** The node:sqlite connection of a handle (open.js is untyped JS). */
const dbOf = (handle: unknown): Db => (handle as { db: Db }).db;

/** A database file at v16 with the member's file seeded and the undone session state laid over it, as production has it. */
function undoneV16(): string {
  const data = path.join(tempDir('nep-v17-'), 'data');
  writeJson(path.join(data, 'guilds', GUILD, 'users', `${MEMBER}.json`), PROFILE);
  writeLines(path.join(data, 'guilds', GUILD, 'record', '2026-10', '2026-10-20.jsonl'), [
    seen('400000000000000001', 1, 'Πάμε για μπάνιο αύριο;'),
  ]);
  const file = path.join(data, 'memory.db');
  const handle = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 16) });
  try {
    assert.equal(seedUnits(handle, data, { now: () => NOW - 86_400_000 }).errors, 0);
    const db = dbOf(handle);
    const audience = db.prepare("SELECT audience_id FROM claims WHERE id = 'det-cafe'").get()?.audience_id;
    const version = db.prepare(
      `INSERT INTO claim_versions (id, claim_id, revision_id, text, extra, recorded_at, event, by, origin, owner_file, position, retired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'her', 'session', NULL, NULL, NULL)`
    );
    version.run(
      'cv:det-cafe:s1',
      'det-cafe',
      'rv:s1',
      REVISED,
      JSON.stringify({ before: 'drinks a café at nine', reason: 'she said it herself' }),
      REVISED_AT,
      'revise'
    );
    version.run('cv:det-sea:s2', 'det-sea', 'rv:s2', 'swims in the sea', null, CONFIRMED_AT, 'confirm');
    db.prepare(
      `INSERT INTO description_versions (id, description_id, text, author, written_at, chars, origin, extra, owner_file, position, retired_at)
       VALUES (?, ?, ?, 'her', ?, ?, 'review', '{}', NULL, NULL, NULL)`
    ).run(REVIEW, DESCRIPTION, REVIEWED, REVIEWED_AT, [...REVIEWED].length);
    db.prepare(
      `INSERT INTO affinity_events (id, person_id, at, delta, applied, score, reason, scope_kind, scope_iface, scope_dm, extra, owner_file, position, retired_at, audience_id)
       VALUES ('aff:run-s4:1', ?, ?, 2, 2, 12, ?, 'group', 'discord', NULL, '{"run":"run-s4"}', NULL, NULL, NULL, ?)`
    ).run(PERSON, MOVED_AT, REASON, audience);
  } finally {
    handle.close();
  }
  return file;
}

/** The member's profile rebuilt from the database alone (export.js#exportOne). */
function profileOf(handle: unknown): Profile {
  const out = exportOne(handle, USER_REL);
  assert.ok(out.found, 'the member file is in the database');
  // exportOne's value is the unit's JSON (`any` in its JSDoc); for a users file it is a profile.
  return out.value as Profile;
}

const detailsOf = (profile: Profile): Map<unknown, Item> =>
  new Map((profile.details ?? []).map((item) => [item.itemId, item]));

/** The rows the step may change, in a fixed order. */
function snapshot(db: Db): Record<string, Array<Row>> {
  const out: Record<string, Array<Row>> = {};
  for (const table of ['claims', 'claim_versions', 'descriptions', 'description_versions', 'people', 'affinity_events'])
    out[table] = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  return out;
}

test('the step sets back the latest session state of each claim, description and attitude reason the sync undid', () => {
  const handle = openMemoryDb(undoneV16());
  try {
    const profile = profileOf(handle);
    const details = detailsOf(profile);
    assert.equal(details.get('det-cafe')?.text, REVISED, 'the revised text');
    assert.equal(details.get('det-sea')?.lastSeen, CONFIRMED_AT, 'the confirmed time');
    assert.equal(profile.character, REVIEWED, 'the reviewed description');
    assert.equal(profile.affinity?.reason, REASON, 'the attitude reason');
    const db = dbOf(handle);
    assert.equal(
      db.prepare('SELECT current_version FROM descriptions WHERE id = ?').get(DESCRIPTION)?.current_version,
      REVIEW
    );
    const plain = db.prepare("SELECT text, owner_file FROM claims WHERE id = 'det-plain'").get();
    assert.deepEqual(
      [plain?.text, plain?.owner_file],
      ['keeps a red bicycle', USER_REL],
      'a claim the session never changed stays the file'
    );
  } finally {
    handle.close();
  }
});

test('the repaired rows belong to the session: a flush of the stale file leaves them as the step set them', () => {
  const handle = openMemoryDb(undoneV16());
  try {
    applyUnitWrite(handle, { kind: 'unit', op: 'value', owner: USER_REL, value: PROFILE, now: NOW });
    const profile = profileOf(handle);
    const details = detailsOf(profile);
    assert.equal(details.get('det-cafe')?.text, REVISED, 'the revised text');
    assert.equal(details.get('det-sea')?.lastSeen, CONFIRMED_AT, 'the confirmed time');
    assert.equal(profile.character, REVIEWED, 'the reviewed description');
    assert.equal(profile.affinity?.reason, REASON, 'the attitude reason');
  } finally {
    handle.close();
  }
});

test('a second open after the step changes nothing', () => {
  const file = undoneV16();
  const first = openMemoryDb(file);
  let before: Record<string, Array<Row>>;
  try {
    before = snapshot(dbOf(first));
    assert.equal(detailsOf(profileOf(first)).get('det-cafe')?.text, REVISED, 'the first open repaired the claim');
  } finally {
    first.close();
  }
  const second = openMemoryDb(file);
  try {
    assert.deepEqual(snapshot(dbOf(second)), before);
  } finally {
    second.close();
  }
});
