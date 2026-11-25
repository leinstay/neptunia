// The writer's kind `owner-name` (src/memory/db/owner-names.ts): a name the owner gives a person. Synthetic ids and
// names over a fresh memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { applyMemoryWrite } from '../../../../src/memory/db/session-write.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../../../../src/memory/db/types.ts';
import { freshMemoryDb } from '../../../fixtures/memory-db-copy.ts';
import { auditMemory } from '../../../fixtures/memory-audit.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { ownerNamesOf } from '../../../../src/memory/db/people-read.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { createConsole } from '../../../../src/interface/commands/console.ts';
import { parseCommandLine } from '../../../../src/interface/commands/table.ts';
import { openTestMemory } from '../../../fixtures/memory-db/service.ts';

const NOW = Date.parse('2026-11-10T10:00:00.000Z');

const ownerAliases = (db: Db, person: string): Array<unknown> =>
  db
    .prepare(
      "SELECT text FROM claims WHERE subject_id = ? AND kind = 'alias' AND author = 'owner' AND retired_at IS NULL"
    )
    .all(person)
    .map((row) => row.text);

test('the owner-name kind adds an owner alias once and retires it on a remove', () => {
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    applyMemoryWrite(handle, { kind: 'owner-name', personId: 'person:self', name: 'Zefira', now: NOW });
    applyMemoryWrite(handle, { kind: 'owner-name', personId: 'person:self', name: 'zefira', now: NOW + 1 });
    assert.deepEqual(ownerAliases(db, 'person:self'), ['Zefira']);
    applyMemoryWrite(handle, { kind: 'owner-name', personId: 'person:self', name: 'ZEFIRA', remove: true, now: NOW });
    assert.deepEqual(ownerAliases(db, 'person:self'), []);
  } finally {
    handle.close();
  }
});

test('the owner-name kind refuses a write with no person or no name', () => {
  const handle = freshMemoryDb();
  try {
    assert.throws(
      () => applyMemoryWrite(handle, { kind: 'owner-name', personId: 'person:self', name: '  ', now: NOW }),
      (error: unknown) => (error as { code?: unknown }).code === 'OWNER_NAME_BAD'
    );
  } finally {
    handle.close();
  }
});

// A name the owner gives a person (`/memory users names add`, the writer's kind `owner-name`) is an `alias` claim like the
// ones a member's profile holds, so it carries the audience those have: the groups of the person's interface. Synthetic
// ids and names only.

const AUDIENCE_NOW = Date.parse('2026-11-05T10:00:00.000Z');
const SELF = 'person:self';

function withMemory(body: (handle: MemoryHandle, db: Db) => void): void {
  const handle = openMemoryDb(path.join(tempDir('nep-owner-name-'), 'memory.db'));
  try {
    body(handle, dbOf(handle));
  } finally {
    handle.close();
  }
}

/** A person with one verified account on `iface`. */
function addPerson(db: Db, person: string, iface: string): void {
  db.exec(`
    INSERT OR IGNORE INTO interfaces (id, name, contract) VALUES ('${iface}', '${iface}', 1);
    INSERT OR IGNORE INTO authorities (id, iface, namespace) VALUES ('${iface}/global', '${iface}', 'global');
    INSERT OR IGNORE INTO people (id, first_seen_at) VALUES ('${person}', '2026-11-01T00:00:00.000Z');
    INSERT INTO accounts (id, iface, native_id, native_key, authority_id, generation, kind, person_id, link, linked_by)
      VALUES ('${iface}:n1', '${iface}', 'n1', 'n1', '${iface}/global', 1, 'user', '${person}', 'verified', 'owner');
  `);
}

const named = (handle: MemoryHandle, personId: string, name: string, iface?: string) =>
  applyMemoryWrite(handle, { kind: 'owner-name', personId, name, now: AUDIENCE_NOW, ...(iface ? { iface } : {}) });

const scopeOf = (db: Db, name: string) => {
  const row = db.prepare('SELECT scope_kind, scope_iface, scope_dm, audience_id FROM claims WHERE text = ?').get(name);
  return { ...row };
};

test('an owner name on a person with an account takes the groups of that account, as a profile alias does', () => {
  // Bug: the row is stored with no scope and no audience, so the audit reports it and a recall by alias never finds it.
  withMemory((handle, db) => {
    addPerson(db, SELF, 'chat');
    named(handle, SELF, 'Zefira', 'other');
    assert.deepEqual(scopeOf(db, 'Zefira'), {
      scope_kind: 'group',
      scope_iface: 'chat',
      scope_dm: null,
      audience_id: 'aud:group:chat',
    });
    assert.equal(auditMemory(db).checks.audienceDerived, 0);
    assert.deepEqual(ownerNamesOf(db, SELF), ['Zefira'], 'the door still reads it');
  });
});

test('an owner name on a person with no account takes the groups of the interface the command came from', () => {
  // Boundary: the persona's record on a raw install holds no account yet.
  withMemory((handle, db) => {
    named(handle, SELF, 'Zefira', 'cli');
    assert.equal(scopeOf(db, 'Zefira').audience_id, 'aud:group:cli');
    assert.equal(auditMemory(db).findings, 0);
  });
});

test('an owner name with no interface to name is internal, and the door still reads it', () => {
  // Bug: an invented interface would show the name in the groups of a platform nobody chose.
  withMemory((handle, db) => {
    named(handle, SELF, 'Zefira');
    assert.equal(scopeOf(db, 'Zefira').audience_id, 'aud:internal');
    assert.equal(auditMemory(db).findings, 0);
    assert.deepEqual(ownerNamesOf(db, SELF), ['Zefira']);
  });
});

test('an owner name on a person whose id spells an interface but who has no account is internal without a command interface', () => {
  // Bug: the interface was cut out of the person id's text instead of read from a stored account.
  withMemory((handle, db) => {
    db.prepare("INSERT INTO people (id, first_seen_at) VALUES ('person:chat:42', '2026-11-01T00:00:00.000Z')").run();
    named(handle, 'person:chat:42', 'Orestis');
    assert.equal(scopeOf(db, 'Orestis').audience_id, 'aud:internal');
  });
});

// The persona's aliases are the names the owner gives their own person record, `person:self`, with `/memory users names add|remove`.
// The door reads only those: a name the persona's memory session or the analyzer writes about them has another `author` and never
// widens it. The writer's `owner-name` op, the reader `ownerNamesOf` and the command over a person, together.

const namesDbOf = (memoryDb: { readHandle(): unknown }): Db => (memoryDb.readHandle() as { db: Db }).db;

/** A console over the test memory, for the owner's command lines. */
function consoleOver(memoryDb: unknown) {
  const dir = tempDir('nep-owner-names-');
  const desk = createConsole({
    runOp: () => Promise.reject(new Error('a name on a person runs no operation')),
    ownerReads: { lessons: () => '' },
    places: () => [],
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => Date.now(),
  });
  return async (line: string) => {
    const parsed = parseCommandLine(line);
    assert.ok(parsed.ok, line);
    return desk.run(parsed.name, parsed.args, { id: 'owner-1' });
  };
}

test('the owner removes a name, and adding the same name twice keeps one', async () => {
  // Bug: a repeated add doubles the alias, or a remove leaves it behind.
  const { memoryDb, close } = await openTestMemory();
  try {
    const run = consoleOver(memoryDb);
    await run('/memory users names add person:self Zefira');
    await run('/memory users names add person:self zefira');
    assert.deepEqual(ownerNamesOf(namesDbOf(memoryDb), 'person:self'), ['Zefira']);
    await run('/memory users names remove person:self ZEFIRA');
    assert.deepEqual(ownerNamesOf(namesDbOf(memoryDb), 'person:self'), []);
  } finally {
    await close();
  }
});
