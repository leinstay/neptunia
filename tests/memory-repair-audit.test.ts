// `scripts/memory-repair-audit.ts`, run as a process over a closed database shaped like production (the fixture holds the
// shape): the owner's command-line DM with three values of `scope_dm`, and history rows whose owners the store's expiry
// deleted. The repair is dry by default, counts only, and harmless to run twice. Synthetic ids and text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { WORDS, auditWorld, runAudit } from './fixtures/memory-audit-world.ts';
import {
  CLI_AUDIENCE,
  OWNER,
  addExpiredHistory,
  addGenuineDangling,
  productionWorld,
} from './fixtures/memory-audit-production.ts';
import { databaseDigest } from './fixtures/memory-db/browser-world.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts', 'memory-repair-audit.ts');

type Counts = { mode: string; scopeRows: number; versionsRetired: number };

/** The script as a process with an empty environment, so nothing of a deployment can reach it. */
function repair(file: string, ...flags: Array<string>) {
  const done = spawnSync(process.execPath, [SCRIPT, '--db', file, ...flags], { cwd: ROOT, encoding: 'utf8', env: {} });
  return { status: done.status, stdout: done.stdout, stderr: done.stderr };
}

function applied(file: string): Counts {
  const done = repair(file, '--apply');
  assert.equal(done.status, 0, done.stderr);
  return JSON.parse(done.stdout) as Counts;
}

function read<T>(file: string, body: (db: Db) => T): T {
  const handle = openMemoryDb(file, { readOnly: true });
  try {
    return body(dbOf(handle));
  } finally {
    handle.close();
  }
}

const rows = (db: Db, sql: string, ...args: Array<unknown>): Array<Row> =>
  db
    .prepare(sql)
    .all(...args)
    .map((row) => ({ ...row }));

const SCOPED = ['sources', 'vectors', 'day'] as const;

/** Every row of the DM's audience with its table and audience, the map a repair must leave as it found it. */
const audienceMap = (db: Db) =>
  Object.fromEntries(
    SCOPED.map((table) => [table, rows(db, `SELECT rowid, audience_id FROM ${table} ORDER BY rowid`)])
  );

test('a dry run counts what an apply would change and writes nothing', async () => {
  // Bug: a repair that cannot be rehearsed is run blind on the one copy of her memory.
  const file = await productionWorld();
  const before = read(file, databaseDigest);
  const done = repair(file);
  assert.equal(done.status, 0, done.stderr);
  const report = JSON.parse(done.stdout) as Counts;
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.scopeRows, 62);
  assert.equal(report.versionsRetired, 5);
  assert.deepEqual(read(file, databaseDigest), before);
});

test('the output is counts and a mode, no word and no id of a row', async () => {
  // Bug: a log of the repair carries what the owner said in his chat.
  const file = await productionWorld();
  const done = repair(file, '--apply');
  const report = JSON.parse(done.stdout) as Record<string, unknown>;
  for (const [key, value] of Object.entries(report)) assert.ok(key === 'mode' || typeof value === 'number', key);
  const everything = done.stdout + done.stderr;
  for (const secret of [WORDS, OWNER, 'src:cli', 'cv:expired', 'dv:legacy'])
    assert.equal(everything.includes(secret), false, secret);
});

test('after an apply the DM place has one scope_dm, its partner, on every table that has the column', async () => {
  // Bug: one DM holds none, the importer's spelling and the owner's person, so a session that reads by the triple forks it.
  const file = await productionWorld();
  const counts = applied(file);
  assert.equal(counts.mode, 'apply');
  assert.equal(counts.scopeRows, 62);
  read(file, (db) => {
    for (const table of SCOPED)
      assert.deepEqual(
        rows(db, `SELECT DISTINCT scope_dm FROM ${table} WHERE audience_id = ?`, CLI_AUDIENCE),
        [{ scope_dm: OWNER }],
        table
      );
    assert.deepEqual(rows(db, "SELECT partner_person FROM places WHERE id = 'cli:dm:owner'"), [
      { partner_person: OWNER },
    ]);
  });
});

test('the repair keeps every audience as it was and every row where it was', async () => {
  // Bug: normalising the person moves a line into a wider audience or drops a row.
  const file = await productionWorld();
  const before = read(file, audienceMap);
  applied(file);
  assert.deepEqual(read(file, audienceMap), before);
});

test('the audit reads zero on the repaired database', async () => {
  // Bug: the findings of the production audit stay, and the watcher reports them every night for good.
  const file = await productionWorld();
  assert.equal(runAudit(['--db', file]).status, 1, 'the fixture has the findings');
  applied(file);
  const after = runAudit(['--db', file]);
  assert.equal(after.status, 0, after.stdout);
  assert.equal((JSON.parse(after.stdout) as { findings: number }).findings, 0);
});

test('a version whose owner the store deleted is retired with its bytes kept, and no other row is touched', async () => {
  // Bug: deleting the history loses it, and a repair that retires more than the orphans hides real damage.
  const file = await auditWorld(addExpiredHistory);
  const before = read(file, (db) => ({
    digest: databaseDigest(db),
    versions: rows(db, 'SELECT * FROM claim_versions ORDER BY id'),
    descriptions: rows(db, 'SELECT * FROM description_versions ORDER BY id'),
  }));
  const counts = applied(file);
  assert.equal(counts.versionsRetired, 5);
  read(file, (db) => {
    const digest = databaseDigest(db);
    for (const table of Object.keys(digest))
      if (table !== 'claim_versions' && table !== 'description_versions')
        assert.equal(digest[table], before.digest[table], table);
    const orphanIds = ['cv:expired:1', 'cv:expired:2', 'cv:expired:3', 'dv:legacy:1', 'dv:legacy:2'];
    const after = {
      versions: rows(db, 'SELECT * FROM claim_versions ORDER BY id'),
      descriptions: rows(db, 'SELECT * FROM description_versions ORDER BY id'),
    };
    for (const [stored, now] of [
      [before.versions, after.versions],
      [before.descriptions, after.descriptions],
    ] as const) {
      assert.equal(now.length, stored.length, 'no version row is deleted');
      for (const [i, row] of now.entries()) {
        const { retired_at: was, ...old } = stored[i] ?? {};
        const { retired_at: is, ...rest } = row;
        assert.deepEqual(rest, old, `${String(row.id)} keeps its bytes`);
        if (orphanIds.includes(String(row.id)))
          assert.ok(typeof is === 'string' && is !== '', `${String(row.id)} is retired`);
        else assert.equal(is, was, `${String(row.id)} is untouched`);
      }
    }
  });
});

test('a version with no owner and no expiry behind it stays a finding after the repair', async () => {
  // Bug: a repair that retires every orphan makes the audit green over damage nobody explained.
  const file = await auditWorld((db) => {
    addExpiredHistory(db);
    addGenuineDangling(db);
  });
  applied(file);
  read(file, (db) => {
    assert.deepEqual(rows(db, "SELECT retired_at FROM claim_versions WHERE id = 'cv:real'"), [{ retired_at: null }]);
    assert.deepEqual(rows(db, "SELECT retired_at FROM description_versions WHERE id = 'dv:real'"), [
      { retired_at: null },
    ]);
  });
  const audit = runAudit(['--db', file]);
  assert.equal(audit.status, 1);
  const report = JSON.parse(audit.stdout) as { checks: { danglingLinks: number } };
  assert.equal(report.checks.danglingLinks, 2);
});

test('a second apply finds nothing and writes nothing', async () => {
  // Bug: a repair that is not idempotent is never safe to run again after a crash or a restore.
  const file = await productionWorld();
  applied(file);
  const once = read(file, databaseDigest);
  const again = applied(file);
  assert.equal(again.scopeRows, 0);
  assert.equal(again.versionsRetired, 0);
  assert.deepEqual(read(file, databaseDigest), once);
});

test('a database with nothing to repair reports zeros and exits 0', async () => {
  // Boundary: the clean world the writers made.
  const file = await auditWorld();
  const before = read(file, databaseDigest);
  const done = repair(file);
  assert.equal(done.status, 0, done.stderr);
  const report = JSON.parse(done.stdout) as Counts;
  assert.equal(report.scopeRows, 0);
  assert.equal(report.versionsRetired, 0);
  assert.deepEqual(read(file, databaseDigest), before);
});

test('without --db it prints a usage line and exits 2', () => {
  // Error path: the same exit codes as the other repair scripts (0 done, 1 refused, 2 usage).
  const done = repair('');
  assert.equal(done.status, 2);
  assert.equal(done.stdout, '');
});
