// The rows writer (src/memory/db/rows.ts): the audience a row takes from its stored DM place, and the quarantine of a
// row whose given audience is not its scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbOf } from '../../../../src/memory/db/types.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { deriveRow, ensureAudience, insertRows } from '../../../../src/memory/db/rows.ts';
import { AUD_INTERNAL, dmScope } from '../../../../src/memory/db/scope.ts';
import type { Scope } from '../../../../src/memory/db/scope.ts';
import { dmPlaceId } from '../../../../src/memory/db/ids.ts';
import { personId } from '../../../fixtures/memory-db/spelled-ids.ts';
import { auditMemory } from '../../../fixtures/memory-audit.ts';
import { writeMediaEntry } from '../../../../src/memory/db/media-store.ts';
import { observationOf } from '../../../../src/memory/db/observe-event.ts';
import { observe } from '../../../../src/memory/db/observe.ts';
import { fillEnvAudiences } from '../../../fixtures/memory-db/audiences.ts';
import {
  ALICE as AUDIT_UNLINKED_MEDIA_ALICE,
  AT,
  SELF_ID,
  fixture,
  type Env,
  KINDS,
  observeLine,
} from '../../../fixtures/media-memory.ts';
import type { Row, Db } from '../../../../src/memory/db/types.ts';
import { DatabaseSync } from 'node:sqlite';
import { DM, GROUP, WORDS, auditWorld } from '../../../fixtures/memory-audit-world.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { openTestMemory } from '../../../fixtures/memory-db/service.ts';

const ALICE = personId('discord', 'u-alice');

// ---------- audiences by their row ----------

/** A database holding the stored DM places `places` names, with their partners' accounts. */
function placesDb(places: ReadonlyArray<Record<string, unknown>>) {
  const handle = openMemoryDb(':memory:');
  const db = dbOf(handle);
  insertRows(db, {
    accounts: [
      { id: 'discord:acc-1', iface: 'discord', native_id: 'n-777', person_id: null, link: 'verified', names: '[]' },
    ],
    places: places.map((place) => ({ iface: 'discord', kind: 'dm', native_id: null, scope_kind: 'dm', ...place })),
  });
  return { handle, db };
}
const claimOf = (scope: Scope) => ({
  id: 'k-probe',
  subject_kind: 'person',
  subject_id: ALICE,
  kind: 'detail',
  text: 'x',
  ...scope,
});

test('a DM row of an opaque person takes the audience of the stored DM place that names the person', () => {
  // Catches a writer that resolves a DM triple only through the person id's spelling, losing every meta-person's DM.
  const { handle, db } = placesDb([{ id: 'discord:dm:opaque', partner_person: 'person:0f3c-uuid' }]);
  try {
    const row = deriveRow(db, 'claims', claimOf(dmScope('person:0f3c-uuid', 'discord')));
    assert.equal(row.audience_id, 'aud:dm:discord:dm:opaque');
  } finally {
    handle.close();
  }
});

test('a DM row whose partner no stored DM place names is internal and creates no place', () => {
  // Catches a DM place and audience worked out from the person id's spelling.
  const { handle, db } = placesDb([]);
  try {
    const row = deriveRow(db, 'claims', claimOf(dmScope(ALICE, 'discord')));
    assert.equal(row.audience_id, AUD_INTERNAL);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM places').get()?.n, 0);
  } finally {
    handle.close();
  }
});

test('a DM row whose partner holds two stored DM places on the interface is internal', () => {
  // Catches picking one of several DMs of a person, which would show one chat's rows in another.
  const { handle, db } = placesDb([
    { id: dmPlaceId('discord', 'u-alice'), partner_person: ALICE },
    { id: 'discord:dm:second', partner_person: ALICE },
  ]);
  try {
    const row = deriveRow(db, 'claims', claimOf(dmScope(ALICE, 'discord')));
    assert.equal(row.audience_id, AUD_INTERNAL);
  } finally {
    handle.close();
  }
});

test('ensureAudience refuses a DM audience whose place no row holds', () => {
  // Catches a DM place created from the spelling of an audience id.
  const { handle, db } = placesDb([]);
  try {
    const audience = `aud:dm:${dmPlaceId('discord', 'u-alice')}`;
    assert.throws(() => ensureAudience(db, { ...dmScope(ALICE, 'discord'), audience_id: audience }), /no stored place/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM places').get()?.n, 0);
  } finally {
    handle.close();
  }
});

test('a stored DM place takes its native key from its partner account, not from its id', () => {
  // Catches the native key of a DM place worked out from the spelling of the place id.
  const { handle, db } = placesDb([
    { id: 'discord:dm:spelled', partner_person: null, partner_account: 'discord:acc-1' },
  ]);
  try {
    assert.equal(
      db.prepare('SELECT native_key FROM places WHERE id = ?').get('discord:dm:spelled')?.native_key,
      'dm:n-777'
    );
  } finally {
    handle.close();
  }
});

// ---------- a vector row's audience ----------

const DIMS = 4;

test('a vector row whose given audience is not its scope is still quarantined to internal', () => {
  const handle = openMemoryDb(':memory:');
  const db = dbOf(handle);
  try {
    const warned: Array<Record<string, unknown>> = [];
    const log = { warn: (_message: string, fields: Record<string, unknown>) => warned.push(fields) };
    const row = (chunk: string, audience: string) => ({
      chunk_key: chunk,
      item_id: chunk,
      model: 'test/embedder',
      dims: DIMS,
      bytes: Buffer.alloc(DIMS, 1),
      ...dmScope(personId('discord', 'u1'), 'discord'),
      audience_id: audience,
    });
    // No writer makes u1's DM place from the audience id, so it is stored first.
    insertRows(db, {
      places: [
        {
          id: 'discord:dm:u1',
          iface: 'discord',
          kind: 'dm',
          native_id: null,
          scope_kind: 'dm',
          partner_person: personId('discord', 'u1'),
          partner_account: 'discord:u1',
        },
      ],
    });
    insertRows(
      db,
      { vectors: [row('agrees', 'aud:dm:discord:dm:u1'), row('disagrees', 'aud:group:discord')] },
      { log }
    );
    const audience = (chunk: string) =>
      db.prepare('SELECT audience_id FROM vectors WHERE chunk_key = ?').get(chunk)?.audience_id;
    assert.equal(audience('agrees'), 'aud:dm:discord:dm:u1');
    assert.equal(audience('disagrees'), 'aud:internal');
    assert.deepEqual(warned, [{ table: 'vectors', code: 'AUDIENCE_CONFLICT' }]);
  } finally {
    handle.close();
  }
});

// The memory audit's count `unlinkedLineMedia` (tests/fixtures/memory-audit.ts): a live media row
// with no link whose reference `<message id>#<item>` names the message of a stored, live line that links no item of that
// reference. Such a row is a picture of a message that the describer saw and the line does not hold. A row of a message
// that is no stored line, and a row that is not message media, are not counted. Written by the observation path and the
// describer's cache write on a temp database; synthetic content.

const CHAT = { id: 'c1', kind: 'channel', rootId: 'g1', name: 'general' };
const POSTED = 'https://tenor.example.invalid/view/spinning-cat';
const TOLD = 'a grey cat spinning on a kitchen table';

const gifEmbed = (native: string, index = 0): Row => ({
  id: `${native}#e${index}`,
  kind: 'gif',
  site: 'Tenor',
  title: '',
  text: '',
  url: POSTED,
  thumbnailUrl: `https://media.example.invalid/${native}-${index}.png`,
});

/** Observes Alice's message `native` with these links; an edit observation when `edit`. */
function observed(env: Env, native: string, links: Array<Row>, edit = false): void {
  const event = {
    iface: 'discord',
    at: AT,
    chat: CHAT,
    ...(edit ? { edit: true } : {}),
    message: {
      id: native,
      at: AT,
      content: POSTED,
      author: { id: AUDIT_UNLINKED_MEDIA_ALICE, name: 'Alice' },
      attachments: [],
      links,
      stickers: [],
    },
  };
  const envelope = observationOf(event, { selfId: SELF_ID });
  assert.ok(envelope, 'the synthetic event was refused');
  assert.equal(observe(env.handle, envelope, { now: () => AT }).ok, true);
}

/** The describer's cache of these keys, each told: rows the observation of their message would find by reference. */
function described(env: Env, keys: Array<string>): void {
  for (const key of keys)
    writeMediaEntry(env.db, { placeId: 'place:test', iface: 'discord', key, entry: { text: TOLD, ts: AT }, at: AT });
}

/** The audit's count, read by its name: a report without the count gives undefined, which no expectation equals. */
function unlinkedLineMedia(env: Env): number | undefined {
  fillEnvAudiences(env);
  const checks: Record<string, number | undefined> = auditMemory(env.db).checks;
  return checks.unlinkedLineMedia;
}

function withEnv(body: (env: Env) => void) {
  const env = fixture();
  try {
    body(env);
  } finally {
    env.done();
  }
}

// Bug: a picture the describer saw stays apart from its line and nothing reports it.
test('a described embed row of a stored line that does not hold it is counted, and not once the line links it', () =>
  withEnv((env) => {
    observed(env, '8101', []);
    described(env, ['8101#e0']);
    assert.equal(unlinkedLineMedia(env), 1);
    observed(env, '8101', [gifEmbed('8101')], true);
    assert.equal(unlinkedLineMedia(env), 0);
  }));

// Bug: the count looks only at lines that link nothing, so a second embed of a line that links its first is missed.
test('a row of a second embed is counted while the line links only the first', () =>
  withEnv((env) => {
    observed(env, '8201', [gifEmbed('8201')]);
    described(env, ['8201#e1']);
    assert.equal(unlinkedLineMedia(env), 1);
  }));

// Bug: a picture of a message the persona found by a search is counted though no line of it is stored, so the audit never clears.
test('a row naming a message that is no stored line is not counted', () =>
  withEnv((env) => {
    observed(env, '8301', []);
    described(env, ['8399#e0']);
    assert.equal(unlinkedLineMedia(env), 0);
  }));

// Bug: a page preview the persona opened or a server emoji is taken for a picture of a message.
test('a row that is not message media is not counted', () =>
  withEnv((env) => {
    observed(env, '8401', []);
    described(env, ['link:9c3b1e5a7d2f4068', 'emoji:8401']);
    assert.equal(unlinkedLineMedia(env), 0);
  }));

// Bug: a retired row, which is history, keeps the audit failing after the row was replaced.
test('a retired row is not counted', () =>
  withEnv((env) => {
    observed(env, '8501', []);
    described(env, ['8501#e0']);
    env.db.prepare("UPDATE media SET retired_at = '2026-11-02T00:00:00.000Z' WHERE native_ref = '8501#e0'").run();
    assert.equal(unlinkedLineMedia(env), 0);
  }));

// Bug: a retired line, which is history, is counted as a line that should hold the picture.
test('a row naming the message of a retired line is not counted', () =>
  withEnv((env) => {
    observed(env, '8601', []);
    described(env, ['8601#e0']);
    env.db.prepare("UPDATE sources SET retired_at = '2026-11-02T00:00:00.000Z' WHERE kind = 'seen'").run();
    assert.equal(unlinkedLineMedia(env), 0);
  }));

// The memory audit (tests/fixtures/memory-audit.ts): read-only, counts only. Every check is seen clean on a world the real writers
// made, and seen failing on one kind of damage seeded there. A check that sees a row it should not, such as a retired
// one, is a false alarm a clean production run could never get past, so those cases are here too. Run over synthetic
// databases; it reads no production file.

const CHECKS = [
  'placeExists',
  'scopeMatchesPlace',
  'audienceDerived',
  'danglingLinks',
  'unexplainedNone',
  'linkedMediaKept',
  'unlinkedLineMedia',
  // What is still unnamed or undescribed, and a line of the owner's chat retired by anything but the owner's memory
  // command.
  'placeUnnamed',
  'placeUndescribed',
  'interfaceUnnamed',
  'cliLineRetired',
] as const;
type Check = (typeof CHECKS)[number];
const ZERO = Object.fromEntries(CHECKS.map((check) => [check, 0])) as Record<Check, number>;

const firstLine = (db: DatabaseSync, place: string): string =>
  String(db.prepare('SELECT id FROM sources WHERE place_id = ? ORDER BY rowid LIMIT 1').get(place)?.id);
const NONE_CLAIM = `INSERT INTO claims (id, subject_kind, subject_id, kind, text, scope_kind, scope_iface, scope_dm, audience_id)
  VALUES ('claim:none', 'self', 'person:self', 'self_fact', '${WORDS}', 'none', NULL, NULL, 'aud:none')`;
const DEAD_LINE = `INSERT INTO sources (id, kind, iface, place_id, text, scope_kind, scope_iface, scope_dm, audience_id, retired_at)
  VALUES ('src:dead', 'seen', 'discord', '${GROUP}', '${WORDS}', 'group', 'discord', NULL, 'aud:group:discord', '2026-11-03T09:00:00.000Z')`;

type Report = { findings: number; checks: Record<Check, number> };

/** The owner's chat, named on its interface, with one line retired under `origin`. */
function cliLine(db: DatabaseSync, origin: string): void {
  db.exec(`
    UPDATE interfaces SET name = 'command line' WHERE id = 'cli';
    INSERT INTO places (id, iface, kind, native_id, scope_kind, chat, authority_id, native_key, generation)
      VALUES ('cli:dm:owner', 'cli', 'dm', 'owner', 'dm', 'dm', 'cli/local', 'dm:owner', 1);`);
  db.prepare(
    `INSERT INTO sources (id, kind, iface, place_id, text, scope_kind, scope_iface, scope_dm, audience_id, origin, retired_at)
       VALUES ('src:cli', 'seen', 'cli', 'cli:dm:owner', ?, 'dm', 'cli', NULL, 'aud:dm:cli:dm:owner', ?, '2026-11-03T09:00:00.000Z')`
  ).run(WORDS, origin);
}

/** The audit's report of `file`, over a read connection. */
function reportOf(file: string): Report {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return auditMemory(db);
  } finally {
    db.close();
  }
}

// Bug: the audit flags the rows the real writers make, so it can never come back clean on production.
test('the world the writers made is clean', async () => {
  assert.deepEqual(reportOf(await auditWorld()), { findings: 0, checks: ZERO });
});

// Bug: a table that does not exist yet or holds nothing throws.
test('an empty database is clean', () => {
  const file = `${tempDir('nep-audit-empty-')}/memory.db`;
  openMemoryDb(file).close();
  assert.deepEqual(reportOf(file), { findings: 0, checks: ZERO });
});

type Case = { name: string; check: Check; count: number; edit: (db: DatabaseSync) => void };

const DAMAGE: ReadonlyArray<Case> = [
  {
    name: 'a line names a place that does not exist',
    check: 'placeExists',
    count: 1,
    edit: (db) => {
      db.prepare("UPDATE sources SET place_id = 'discord:channel:gone' WHERE id = ?").run(firstLine(db, DM));
    },
  },
  {
    name: 'an episode names a place that does not exist',
    check: 'placeExists',
    count: 1,
    edit: (db) => db.exec("UPDATE episodes SET place_id = 'discord:channel:gone' WHERE id = 'episode:good'"),
  },
  {
    name: 'a day row names a place that does not exist',
    check: 'placeExists',
    count: 1,
    edit: (db) => db.exec("UPDATE day SET place_id = 'discord:channel:gone' WHERE id = 'day:good'"),
  },
  {
    name: 'a line in a DM is scoped to the groups',
    check: 'scopeMatchesPlace',
    count: 1,
    edit: (db) => {
      db.prepare(
        "UPDATE sources SET scope_kind = 'group', scope_iface = 'discord', scope_dm = NULL, audience_id = 'aud:group:discord' WHERE id = ?"
      ).run(firstLine(db, DM));
    },
  },
  {
    name: 'an episode of a channel is scoped to a DM',
    check: 'scopeMatchesPlace',
    count: 1,
    edit: (db) => {
      const dm = db
        .prepare('SELECT scope_iface, scope_dm, audience_id FROM sources WHERE place_id = ? LIMIT 1')
        .get(DM);
      db.prepare(
        "UPDATE episodes SET scope_kind = 'dm', scope_iface = ?, scope_dm = ?, audience_id = ? WHERE id = 'episode:good'"
      ).run(String(dm?.scope_iface), dm?.scope_dm === null ? null : String(dm?.scope_dm), String(dm?.audience_id));
    },
  },
  {
    name: 'a claim of the groups stands under the internal audience',
    check: 'audienceDerived',
    count: 1,
    edit: (db) => db.exec("UPDATE claims SET audience_id = 'aud:internal' WHERE id = 'claim:good'"),
  },
  {
    name: 'a claim has no audience at all',
    check: 'audienceDerived',
    count: 1,
    edit: (db) => db.exec("UPDATE claims SET audience_id = NULL WHERE id = 'claim:good'"),
  },
  {
    name: 'a live vector stands under an audience its scope does not derive',
    check: 'audienceDerived',
    count: 1,
    edit: (db) => {
      db.prepare(
        "UPDATE vectors SET audience_id = 'aud:internal' WHERE rowid = (SELECT MIN(rowid) FROM vectors WHERE place_id IS NOT NULL)"
      ).run();
    },
  },
  {
    name: 'a claim links a line that does not exist',
    check: 'danglingLinks',
    count: 1,
    edit: (db) =>
      db.exec("INSERT INTO claim_sources (claim_id, source_id, position) VALUES ('claim:good', 'src:gone', 1)"),
  },
  {
    name: 'a claim links a retired line',
    check: 'danglingLinks',
    count: 1,
    edit: (db) => {
      db.exec(DEAD_LINE);
      db.exec("INSERT INTO claim_sources (claim_id, source_id, position) VALUES ('claim:good', 'src:dead', 1)");
    },
  },
  {
    name: 'an episode links a line that does not exist',
    check: 'danglingLinks',
    count: 1,
    edit: (db) =>
      db.exec("INSERT INTO episode_sources (episode_id, source_id, position) VALUES ('episode:good', 'src:gone', 1)"),
  },
  {
    name: 'a version belongs to a claim that does not exist',
    check: 'danglingLinks',
    count: 1,
    edit: (db) =>
      db.exec("INSERT INTO claim_versions (id, claim_id, text) VALUES ('claim:gone:v1', 'claim:gone', 'x')"),
  },
  {
    name: 'a description names a current version that does not exist',
    check: 'danglingLinks',
    count: 1,
    edit: (db) => db.exec("UPDATE descriptions SET current_version = 'desc:good:gone' WHERE id = 'desc:good'"),
  },
  {
    name: 'a claim of the persona about themselves sits under aud:none with no reason',
    check: 'unexplainedNone',
    count: 1,
    edit: (db) => db.exec(NONE_CLAIM),
  },
  {
    name: 'the reason on file for an aud:none row was retired',
    check: 'unexplainedNone',
    count: 1,
    edit: (db) => db.exec("UPDATE decisions SET retired_at = '2026-11-03T09:00:00.000Z' WHERE id = 'decision:1'"),
  },
  {
    name: 'the reason on file names another row',
    check: 'unexplainedNone',
    count: 1,
    edit: (db) => db.exec("UPDATE decisions SET target_id = 'claim:good' WHERE id = 'decision:1'"),
  },
  {
    name: 'a live line links a media row that was trimmed',
    check: 'linkedMediaKept',
    count: 1,
    edit: (db) => db.exec("UPDATE media SET retired_at = '2026-11-03T09:00:00.000Z' WHERE id = 'media:held:att-kept'"),
  },
  {
    name: 'a live room has no name',
    check: 'placeUnnamed',
    count: 1,
    edit: (db) => db.prepare('UPDATE places SET name = NULL WHERE id = ?').run(GROUP),
  },
  {
    name: 'a live root has no name',
    check: 'placeUnnamed',
    count: 1,
    edit: (db) =>
      db.exec(
        `INSERT INTO places (id, iface, kind, native_id, scope_kind, authority_id, native_key, generation)
           VALUES ('discord:server:s1', 'discord', 'server', 's1', 'group', 'discord/global', 'server:s1', 1)`
      ),
  },
  {
    name: 'an interface with places has no name',
    check: 'interfaceUnnamed',
    count: 1,
    edit: (db) => db.exec("UPDATE interfaces SET name = NULL WHERE id = 'discord'"),
  },
  {
    name: 'a line of the owner’s chat was retired by something other than the owner’s memory command',
    check: 'cliLineRetired',
    count: 1,
    edit: (db) => cliLine(db, 'session'),
  },
  {
    name: 'a live diary entry links a media row that was trimmed',
    check: 'linkedMediaKept',
    count: 1,
    edit: (db) => db.exec("UPDATE media SET retired_at = '2026-11-03T09:00:00.000Z' WHERE id = 'media:diary:1:0'"),
  },
];

for (const { name, check, count, edit } of DAMAGE) {
  // Bug: the check never fires on what it exists to catch, or another check fires too and the count misleads.
  test(`${check} finds it when ${name}`, async () => {
    const report = reportOf(await auditWorld(edit));
    assert.deepEqual(report.checks, { ...ZERO, [check]: count });
    assert.equal(report.findings, count);
  });
}

// Each of these made a row look wrong that is right, and a production run could never close.
const FINE: ReadonlyArray<{ name: string; edit: (db: DatabaseSync) => void }> = [
  {
    name: 'a direct chat with no name',
    edit: (db) => db.prepare('UPDATE places SET name = NULL WHERE id = ?').run(DM),
  },
  {
    name: 'a line of the owner’s chat retired by the owner’s memory command',
    edit: (db) => cliLine(db, 'owner'),
  },
  {
    name: 'a retired row with a broken audience',
    edit: (db) =>
      db.exec(
        "UPDATE claims SET audience_id = 'aud:internal', retired_at = '2026-11-03T09:00:00.000Z' WHERE id = 'claim:none-with-reason'"
      ),
  },
  {
    name: 'a retired link to a line that is gone',
    edit: (db) =>
      db.exec(
        "INSERT INTO claim_sources (claim_id, source_id, position, retired_at) VALUES ('claim:good', 'src:gone', 1, '2026-11-03T09:00:00.000Z')"
      ),
  },
  {
    name: 'a retired line that links a trimmed media row',
    edit: (db) => {
      db.exec(DEAD_LINE);
      db.exec(
        `INSERT INTO media (id, kind, native_ref, scope_kind, scope_iface, scope_dm, audience_id, retired_at)
           VALUES ('media:held:att-trimmed', 'image', 'att-trimmed', 'group', 'discord', NULL, 'aud:group:discord', '2026-11-03T09:00:00.000Z');
         INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('source', 'src:dead', 0, 'media:held:att-trimmed')`
      );
    },
  },
  {
    name: 'a trimmed media row no line links',
    edit: (db) =>
      db.exec(
        `INSERT INTO media (id, kind, native_ref, scope_kind, scope_iface, scope_dm, audience_id, retired_at)
           VALUES ('media:held:att-unlinked', 'image', 'att-unlinked', 'group', 'discord', NULL, 'aud:group:discord', '2026-11-03T09:00:00.000Z')`
      ),
  },
  {
    name: 'a line with no place, which the persona’s own memory session answers are',
    edit: (db) =>
      db.exec(
        `INSERT INTO sources (id, kind, place_id, text, scope_kind, scope_iface, scope_dm, audience_id)
           VALUES ('src:session', 'memory_session', NULL, '${WORDS}', 'internal', NULL, NULL, 'aud:internal')`
      ),
  },
  {
    name: 'a line vector whose bytes were evicted',
    edit: (db) => {
      db.prepare(
        "UPDATE vectors SET bytes = NULL, evicted_at = '2026-11-03T09:00:00.000Z' WHERE rowid = (SELECT MIN(rowid) FROM vectors WHERE place_id IS NOT NULL)"
      ).run();
    },
  },
];

for (const { name, edit } of FINE) {
  test(`no finding for ${name}`, async () => {
    assert.deepEqual(reportOf(await auditWorld(edit)), { findings: 0, checks: ZERO });
  });
}

/** A named room of the group with `lines` live lines and the `fields` of its description. */
function describedRoom(lines: number, fields: ReadonlyArray<string>): (db: DatabaseSync) => void {
  return (db) => {
    db.exec(`INSERT INTO places (id, iface, kind, native_id, scope_kind, chat, name, authority_id, native_key, generation)
      VALUES ('discord:channel:quiet', 'discord', 'channel', 'quiet', 'group', 'group', 'ήσυχη', 'discord/global', 'channel:quiet', 1)`);
    const line = db.prepare(
      `INSERT INTO sources (id, kind, iface, place_id, text, scope_kind, scope_iface, scope_dm, audience_id)
         VALUES (?, 'seen', 'discord', 'discord:channel:quiet', ?, 'group', 'discord', NULL, 'aud:group:discord')`
    );
    for (let i = 0; i < lines; i += 1) line.run(`src:quiet:${i}`, WORDS);
    for (const field of fields) {
      db.prepare(
        `INSERT INTO descriptions (id, subject_kind, subject_id, field, current_version, scope_kind, scope_iface, scope_dm, audience_id)
           VALUES (?, 'place', 'discord:channel:quiet', ?, ?, 'group', 'discord', NULL, 'aud:group:discord')`
      ).run(`desc:quiet:${field}`, field, `desc:quiet:${field}:v1`);
      db.prepare('INSERT INTO description_versions (id, description_id, text) VALUES (?, ?, ?)').run(
        `desc:quiet:${field}:v1`,
        `desc:quiet:${field}`,
        WORDS
      );
    }
  };
}

/** The checks of the audit over `file`. */
function checksOver(file: string): Record<Check, number> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return auditMemory(db).checks;
  } finally {
    db.close();
  }
}

// Bug: a place that has barely spoken is reported as waiting for a description, and the backfill spends on it.
test('placeUndescribed does not count a place with one line fewer than the threshold and no field', async () => {
  assert.deepEqual(checksOver(await auditWorld(describedRoom(19, []))), ZERO);
});

// Bug: a place with two of the three fields is taken as described, so the backfill never fills the third.
test('placeUndescribed counts a place at the threshold with two of the three fields', async () => {
  assert.deepEqual(checksOver(await auditWorld(describedRoom(20, ['purpose', 'tone']))), {
    ...ZERO,
    placeUndescribed: 1,
  });
});

// Bug: the check counts fields up to three inclusive, so a fully described place stays on the backfill's list.
test('placeUndescribed does not count a place at the threshold with all three fields', async () => {
  assert.deepEqual(checksOver(await auditWorld(describedRoom(20, ['purpose', 'tone', 'topics']))), ZERO);
});

// The media findings of the memory audit (tests/fixtures/memory-audit.ts): a link that points at nothing, from a message that is gone or
// to a row that is gone, and a retired row a live message links. Written by the observation path on a temp database.

function withLine(body: (env: Env, source: string) => void) {
  const env = fixture();
  try {
    const source = observeLine(env, KINDS[0], 'full');
    fillEnvAudiences(env);
    body(env, source);
  } finally {
    env.done();
  }
}

test('an observed line with its items leaves no media finding', () =>
  withLine((env) => {
    const { checks } = auditMemory(env.db);
    assert.deepEqual([checks.danglingLinks, checks.linkedMediaKept], [0, 0]);
  }));

test('a link to a media row that is gone is a finding', () =>
  withLine((env, source) => {
    env.db.prepare("UPDATE media_links SET media_id = 'nothing' WHERE owner_id = ? AND position = 0").run(source);
    assert.equal(auditMemory(env.db).checks.danglingLinks, 1);
  }));

test('a link from a message that is gone is a finding', () =>
  withLine((env, source) => {
    env.db.prepare("UPDATE media_links SET owner_id = 'nothing' WHERE owner_id = ? AND position = 0").run(source);
    assert.equal(auditMemory(env.db).checks.danglingLinks, 1);
  }));

test('a retired media row a live message links is a finding', () =>
  withLine((env) => {
    env.db.prepare("UPDATE media SET retired_at = '2026-11-01T00:00:00.000Z' WHERE native_ref = 'pic-a'").run();
    assert.equal(auditMemory(env.db).checks.linkedMediaKept, 1);
  }));

// The `legacy/local` authority is no part of the database: its keys named each person, and each account and place
// spelled the old Discord way, by its own id, and nothing read them. The writers add none.

const NOW = Date.parse('2026-11-10T10:00:00.000Z');
const LEGACY = 'legacy/local';

const legacyKeys = (db: Db): number =>
  Number(db.prepare('SELECT COUNT(*) AS n FROM external_keys WHERE authority_id = ?').get(LEGACY)?.n);

test('an observed Discord message and a profile write add no key under the legacy authority', async () => {
  // Catches: a writer that still registers a row's own id under `legacy/local`, which nothing reads.
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'discord' });
  try {
    const observed = observationOf({
      iface: 'discord',
      at: NOW,
      chat: { id: '700000000000000001', kind: 'channel', chatType: 'channel' },
      message: { id: '800000000000000001', at: NOW, content: 'a synthetic line', author: { id: '900000000000000001' } },
    });
    if (!observed) throw new Error('synthetic message rejected');
    await memory.memoryDb.observeMessage(observed, {});
    const db = dbOf(memory.memoryDb.readHandle()!);
    const account = 'discord:900000000000000001';
    assert.equal(db.prepare('SELECT id FROM accounts WHERE native_id = ?').get('900000000000000001')?.id, account);
    await memory.memoryDb.memoryWrite({
      kind: 'account-profile',
      accountId: account,
      value: { names: ['Synthetic'] },
      iface: 'discord',
      now: NOW,
    });
    // The profile wrote the account's person, the row the people branch of the key writer names.
    assert.equal(
      db.prepare("SELECT id FROM people WHERE writer = 'profile' AND holder_id = ?").get(account)?.id,
      db.prepare('SELECT person_id FROM accounts WHERE id = ?').get(account)?.person_id
    );
    assert.equal(legacyKeys(db), 0);
  } finally {
    await memory.close();
  }
});
