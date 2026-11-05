// A name the owner gives a person (`/memory users names add`, the writer's `owner-name` op) is an `alias` claim like the
// ones a member's profile holds, so it carries the audience those have: the groups of the person's interface. The repair
// script gives the rows stored without one that same audience. Synthetic ids and names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditMemory } from '../src/memory/db/audit.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { ownerNamesOf } from '../src/memory/db/people-read.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../src/memory/db/types.ts';
import { applyUnitWrite } from '../src/memory/db/unit-write.ts';
import { auditWorld } from './fixtures/memory-audit-world.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPAIR = path.join(ROOT, 'scripts', 'memory-repair-audit.ts');
const NOW = Date.parse('2026-11-05T10:00:00.000Z');
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
  applyUnitWrite(handle, { op: 'owner-name', personId, name, now: NOW, ...(iface ? { iface } : {}) });

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
  // Boundary: her record on a raw install holds no account yet.
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

const repair = (file: string, ...flags: Array<string>) =>
  spawnSync(process.execPath, [REPAIR, '--db', file, ...flags], { cwd: ROOT, encoding: 'utf8', env: {} });

const report = (done: ReturnType<typeof repair>): { aliases: number } => {
  assert.equal(done.status, 0, done.stderr);
  return JSON.parse(done.stdout) as { aliases: number };
};

test('the repair gives a stored owner name the audience the writer gives it, once, and the door still reads it', async () => {
  // Bug: the names already written stay findings for good, or a repair hides them from the door.
  const file = await auditWorld((raw) => {
    raw.exec(`
      INSERT OR IGNORE INTO people (id, kind, status) VALUES ('person:self', 'self', 'active');
      INSERT INTO accounts (id, iface, native_id, native_key, authority_id, generation, kind, person_id, link, linked_by)
        VALUES ('discord:n9', 'discord', 'n9', 'n9', 'discord/global', 1, 'self', 'person:self', 'verified', 'observation');
      INSERT INTO claims (id, subject_kind, subject_id, kind, text, weight, how, author, truth, created_at)
        VALUES ('claim:one', 'person', 'person:self', 'alias', 'Zefira', 1, 'owner', 'owner', 'current', '2026-11-01'),
               ('claim:two', 'person', 'person:self', 'alias', 'Mirella', 1, 'owner', 'owner', 'current', '2026-11-02');
    `);
  });
  assert.equal(report(repair(file)).aliases, 2, 'the dry run counts them');
  assert.equal(report(repair(file, '--apply')).aliases, 2);
  assert.equal(report(repair(file, '--apply')).aliases, 0, 'a second run finds nothing');
  const handle = openMemoryDb(file, { readOnly: true });
  try {
    const db = dbOf(handle);
    assert.equal(scopeOf(db, 'Zefira').audience_id, 'aud:group:discord');
    assert.equal(auditMemory(db).findings, 0);
    assert.deepEqual(ownerNamesOf(db, SELF), ['Zefira', 'Mirella']);
  } finally {
    handle.close();
  }
});
