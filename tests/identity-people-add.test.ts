// `people:add` makes a tentative person for a stranger. The owner and she are nobody's strangers: the writer refuses the
// op for the account of the owner's command line and for her own, whatever the model answers and whichever order the
// first line and the session ran in. Real temporary databases, synthetic ids only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../src/memory/db/types.ts';
import { addAuthority } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const AT = '2026-11-05T10:00:00.000Z';
const NOW = Date.parse(AT);

function withDb(body: (handle: MemoryHandle, db: Db) => void): void {
  const handle = openMemoryDb(path.join(tempDir('nep-people-add-'), 'memory.db'));
  try {
    body(handle, dbOf(handle));
  } finally {
    handle.close();
  }
}

/** An account with no person and one line of its own, the shape a session names in `people:add`. */
function accountWithLine(db: Db, { id, iface, kind }: { id: string; iface: string; kind: string }): string {
  addAuthority(db, iface, `${iface}/global`);
  db.prepare(
    `INSERT INTO accounts (id, iface, native_id, native_key, authority_id, generation, kind)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  ).run(id, iface, id, id, `${iface}/global`, kind);
  const source = `source:${id}`;
  db.prepare(
    `INSERT INTO sources (id, kind, iface, author_account, author_kind, occurred_at, recorded_at, text, audience_id)
     VALUES (?, 'seen', ?, ?, 'account', ?, ?, 'a synthetic line', 'aud:internal')`
  ).run(source, iface, id, AT, AT);
  return source;
}

function peopleAdd(handle: MemoryHandle, run: string, subjectId: string, source: string): void {
  applyMemoryWrite(handle, {
    kind: 'session',
    mode: 'apply',
    run: {
      id: run,
      scopeKey: 'dm:synthetic',
      scope: { scope_kind: 'internal', scope_iface: null, scope_dm: null },
      startedAt: AT,
      finishedAt: AT,
      outcome: 'ok',
      counts: {},
      errors: [],
      batchKey: run,
    },
    plan: {
      claims: [],
      episodes: [],
      affinity: [],
      descriptions: [],
      people: [{ op: 'add', subjectKind: 'account', subjectId, sources: [source], reason: 'a synthetic reason' }],
    },
    now: NOW,
  });
}

const peopleCount = (db: Db): number => Number(db.prepare('SELECT COUNT(*) AS n FROM people').get()?.n);
const linkCount = (db: Db): number => Number(db.prepare('SELECT COUNT(*) AS n FROM account_person_links').get()?.n);

test('a session cannot make a person of the account of the command line', () => {
  // Bug: she tracks the owner as a new person, a duplicate of him the owner has no way to see and no way to undo.
  withDb((handle, db) => {
    const source = accountWithLine(db, { id: 'cli:owner', iface: 'cli', kind: 'user' });
    const before = peopleCount(db);
    peopleAdd(handle, 'run:cli', 'cli:owner', source);
    assert.equal(peopleCount(db), before);
    assert.equal(linkCount(db), 0);
  });
});

test('a session cannot make a person of her own account', () => {
  // Bug: nothing but `person_id` guards the op, so an account of hers with no link yet becomes a stranger she tracks.
  withDb((handle, db) => {
    const source = accountWithLine(db, { id: 'discord:her', iface: 'discord', kind: 'self' });
    const before = peopleCount(db);
    peopleAdd(handle, 'run:self', 'discord:her', source);
    assert.equal(peopleCount(db), before);
    assert.equal(linkCount(db), 0);
  });
});
