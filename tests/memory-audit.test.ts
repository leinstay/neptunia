// `scripts/memory-audit.ts` (master plan V.1): read-only, counts only, exit 1 on a finding. Every check is seen clean on a
// world the real writers made, and seen failing on one kind of damage seeded there. A check that sees a row it should
// not, such as a retired one, is a false alarm a clean production run could never get past, so those cases are here too.
// Run as a process over synthetic databases; it reads no production file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { auditMemory as auditOver } from '../src/memory/db/audit.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { DM, GROUP, WORDS, auditWorld, runAudit } from './fixtures/memory-audit-world.ts';
import { tempDir } from './fixtures/tmp.ts';

const CHECKS = [
  'placeExists',
  'scopeMatchesPlace',
  'audienceDerived',
  'danglingLinks',
  'unexplainedNone',
  'linkedMediaKept',
  // The lead: the audit gained `unlinkedLineMedia` with the late embeds slice (owner, 2026-11-06).
  'unlinkedLineMedia',
  // Plan 2026-11-06-turn-frame, slice 9 (d): what is still unnamed or undescribed, and a line of the owner's chat retired
  // by anything but his memory command.
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

/** The audit's report of `file`, with its exit code checked against what it reports. */
function reportOf(file: string): Report {
  const run = runAudit(['--db', file]);
  assert.equal(run.stderr, '');
  const report = JSON.parse(run.stdout) as Report;
  assert.equal(run.status, report.findings > 0 ? 1 : 0);
  return report;
}

// Bug: the audit flags the rows the real writers make, so it can never come back clean on production.
test('the world the writers made is clean, exit 0', async () => {
  const run = runAudit(['--db', await auditWorld()]);
  assert.equal(run.status, 0);
  assert.deepEqual(JSON.parse(run.stdout), { findings: 0, checks: ZERO });
});

// Bug: a table that does not exist yet or holds nothing throws.
test('an empty database is clean', () => {
  const file = `${tempDir('nep-audit-empty-')}/memory.db`;
  openMemoryDb(file).close();
  assert.deepEqual(reportOf(file), { findings: 0, checks: ZERO });
});

// Bug: the audit writes while it reads, on the one database she lives in.
test('a run leaves the file as it was, whatever it found', async () => {
  const file = await auditWorld((db) => {
    db.exec(NONE_CLAIM);
  });
  const before = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(reportOf(file).checks.unexplainedNone, 1);
  assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), before);
});

// Bug: a missing file is created empty and reads as a clean memory.
test('a database that is not there is a usage error and is not created', () => {
  const file = `${tempDir('nep-audit-missing-')}/memory.db`;
  const run = runAudit(['--db', file]);
  assert.equal(run.status, 2);
  assert.equal(fs.existsSync(file), false);
  assert.equal(runAudit([]).status, 2);
});

// Bug: the watcher has to spawn a process and parse a line to read the same counts.
test('auditMemory answers the counts over an open read connection', async () => {
  const file = await auditWorld((db) => {
    db.exec(NONE_CLAIM);
  });
  // Imported here so that the process tests above and below fail one by one until the script exists.
  const { auditMemory } = await import('../scripts/memory-audit.ts');
  const db = new DatabaseSync(file, { readOnly: true });
  assert.deepEqual(auditMemory(db, { describeAfterLines: 20 }), {
    findings: 1,
    checks: { ...ZERO, unexplainedNone: 1 },
  });
  db.close();
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
    name: 'a claim about herself sits under aud:none with no reason',
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
    name: 'a line of the owner’s chat was retired by something other than his memory command',
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
    name: 'a line of the owner’s chat retired by his memory command',
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
    name: 'a line with no place, which her own memory session answers are',
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

// Bug: an audit run on production copies chat lines, ids or names into a log the watcher reads.
test('nothing of a row reaches the output, on a clean run or a damaged one', async () => {
  const damaged = await auditWorld((db) => {
    db.exec(NONE_CLAIM);
    db.exec("UPDATE claims SET audience_id = 'aud:internal' WHERE id = 'claim:good'");
    db.exec("INSERT INTO claim_sources (claim_id, source_id, position) VALUES ('claim:good', 'src:gone', 1)");
  });
  for (const file of [await auditWorld(), damaged]) {
    const run = runAudit(['--db', file]);
    assert.equal((JSON.parse(run.stdout) as Report).findings, file === damaged ? 3 : 0);
    const output = `${run.stdout}${run.stderr}`;
    for (const secret of [WORDS, GROUP, DM, 'claim:', 'person:', 'src:', 'desc:', 'media:', 'owner', file])
      assert.equal(output.includes(secret), false, secret);
  }
});

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

/** The checks of the audit over `file` with the threshold of lines given. */
function checksOver(file: string, describeAfterLines: number): Record<Check, number> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return auditOver(db, { describeAfterLines }).checks;
  } finally {
    db.close();
  }
}

// Bug: a place that has barely spoken is reported as waiting for a description, and the backfill spends on it.
test('placeUndescribed does not count a place with one line fewer than the threshold and no field', async () => {
  assert.deepEqual(checksOver(await auditWorld(describedRoom(19, [])), 20), ZERO);
});

// Bug: a place with two of the three fields is taken as described, so the backfill never fills the third.
test('placeUndescribed counts a place at the threshold with two of the three fields', async () => {
  assert.deepEqual(checksOver(await auditWorld(describedRoom(20, ['purpose', 'tone'])), 20), {
    ...ZERO,
    placeUndescribed: 1,
  });
});

// Bug: the check counts fields up to three inclusive, so a fully described place stays on the backfill's list.
test('placeUndescribed does not count a place at the threshold with all three fields', async () => {
  assert.deepEqual(checksOver(await auditWorld(describedRoom(20, ['purpose', 'tone', 'topics'])), 20), ZERO);
});
