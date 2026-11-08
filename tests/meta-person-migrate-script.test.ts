// `scripts/meta-person-migrate.ts`, run as a process over a database closed the way a stopped core leaves it: a dry run
// writes nothing, an apply writes the database and the mapping file and prints the owner's config edit, a second apply
// finds nothing and writes no file, and a running core refuses the run. Synthetic ids only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { databaseDigest } from './fixtures/memory-db/browser-world.ts';
import { addAccount } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts', 'meta-person-migrate.ts');
const OWNER = 'person:chat:o1';

type Output = { mode: string; minted: number; map: string | null; ownerPersonEdit: Record<string, string> | null };

/** A database with the owner and one other person, and the config that names the owner; returns both paths. */
function seed(): { db: string; config: string } {
  const dir = tempDir('nep-meta-script-');
  const db = path.join(dir, 'memory.db');
  const handle = openMemoryDb(db);
  try {
    addAccount(dbOf(handle), { id: 'chat:o1', iface: 'chat', authority: 'chat/global', native: 'o1', person: OWNER });
    addAccount(dbOf(handle), {
      id: 'chat:d1',
      iface: 'chat',
      authority: 'chat/global',
      native: 'd1',
      person: 'person:chat:d1',
    });
  } finally {
    handle.close();
  }
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ bot: { ownerPerson: OWNER } }));
  return { db, config };
}

function run(db: string, config: string, ...flags: Array<string>): { status: number | null; out: Output | null } {
  const result = spawnSync(process.execPath, [SCRIPT, '--db', db, '--config', config, ...flags], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, out: result.status === 0 ? (JSON.parse(result.stdout) as Output) : null };
}

const digestOf = (file: string): Record<string, string> => {
  const handle = openMemoryDb(file, { readOnly: true });
  try {
    return databaseDigest(dbOf(handle));
  } finally {
    handle.close();
  }
};

const maps = (db: string): Array<string> =>
  fs.readdirSync(path.dirname(db)).filter((name) => name.startsWith('meta-person-map-'));

test('a dry run prints what an apply would do and writes nothing', () => {
  // Bug: the dry run commits, so a look at the numbers migrates production.
  const { db, config } = seed();
  const before = digestOf(db);
  const { status, out } = run(db, config);
  assert.equal(status, 0);
  assert.equal(out?.mode, 'dry-run');
  assert.equal(out?.minted, 2);
  assert.deepEqual(digestOf(db), before);
  assert.deepEqual(maps(db), []);
});

test('an apply writes the mapping file and prints the owner edit, and a second apply writes nothing', () => {
  // Bug: the run leaves no record of the old ids, edits nothing the operator can apply, or a second run mints again.
  const { db, config } = seed();
  const first = run(db, config, '--apply');
  assert.equal(first.status, 0);
  const written = maps(db);
  assert.equal(written.length, 1);
  const mapping = JSON.parse(fs.readFileSync(path.join(path.dirname(db), written[0] ?? ''), 'utf8')) as {
    persons: Record<string, string>;
  };
  assert.deepEqual(first.out?.ownerPersonEdit, { 'bot.ownerPerson': mapping.persons[OWNER] });
  assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')), { bot: { ownerPerson: OWNER } });
  const after = digestOf(db);
  const second = run(db, config, '--apply');
  assert.equal(second.status, 0);
  assert.equal(second.out?.minted, 0);
  assert.equal(second.out?.map, null);
  assert.deepEqual(digestOf(db), after);
});

test('a database another live process holds is refused', () => {
  // Bug: the migration runs beside a live core, which writes old ids into the rows it is moving.
  const { db, config } = seed();
  const holder = openMemoryDb(db);
  try {
    const { status } = run(db, config, '--apply');
    assert.equal(status, 1);
  } finally {
    holder.close();
  }
});
