// src/memory/db/session-people.ts: the people a memory session batch names. Synthetic ids and text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observe, OBSERVATION_VERSION } from '../../../../src/memory/db/observe.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { personOfAccount } from '../../../../src/memory/db/meta-person.ts';
import { peopleOf } from '../../../../src/memory/db/session-people.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../../../../src/memory/db/types.ts';

const AT = '2026-11-08T10:00:00.000Z';
const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const OPTS = { now: () => NOW, log: quiet };
const GROUP = { authority: 'telegram/global', key: 'chat:-100', kind: 'room', chat: 'group', title: 'a group' };

type Author = { kind: string; key: string; display?: string; token_kind?: string };

/** One line of a group, by an account or a participant. */
const line = (key: string, author: Author): Row => ({
  v: OBSERVATION_VERSION,
  iface: 'telegram',
  authority: 'telegram/global',
  native: { kind: 'message', key, revision: 1 },
  place: GROUP,
  author,
  occurredAt: AT,
  observedAt: AT,
  text: `synthetic line ${key}`,
});

function withDb(body: (db: Db, handle: MemoryHandle) => void): void {
  const handle = openMemoryDb(':memory:');
  try {
    body(dbOf(handle), handle);
  } finally {
    handle.close();
  }
}

/** Observes a line and answers its source id. */
function see(handle: MemoryHandle, key: string, author: Author): string {
  const result = observe(handle, line(key, author), OPTS);
  assert.equal(result.ok, true, JSON.stringify(result));
  return String(result.sourceId);
}

const accountOfLine = (db: Db, source: string): string =>
  String(db.prepare('SELECT author_account FROM sources WHERE id = ?').get(source)?.author_account);

test("the persona's memory session reads a new member's lines as the member's meta-person", () => {
  // Bug: the batch names no person for an account nobody linked, so a claim about the member has no subject.
  withDb((db, handle) => {
    const source = see(handle, '1', { kind: 'account', key: '700', display: 'Ilse' });
    const batch = db.prepare('SELECT * FROM sources WHERE id = ?').all(source);
    const { people } = peopleOf(db, batch, 'Her');
    assert.deepEqual(
      people.map((person) => person.id),
      [personOfAccount(db, accountOfLine(db, source))]
    );
  });
});
