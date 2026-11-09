// Who the persona is in a replayed turn (scripts/lib/turn-wiring.ts `identityIn`): her account on the turn's interface,
// else her first account elsewhere, as the core takes her id and name from the hello of the interface it serves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { identityIn } from '../scripts/lib/turn-wiring.ts';
import { freshMemoryDb } from './fixtures/memory-db-copy.ts';

type Db = InstanceType<typeof DatabaseSync>;

function seed(db: Db): void {
  const account = db.prepare(
    `INSERT INTO accounts (id, iface, native_id, person_id, names, kind) VALUES (?, ?, ?, ?, ?, ?)`
  );
  account.run('fake:9001', 'fake', '9001', 'person:self', '["Αθηνά"]', 'self');
  account.run('fake:9002', 'fake', '9002', 'person:other', '["Νίκος"]', 'user');
}

test('takes her account on the interface of the turn', () => {
  const handle = freshMemoryDb();
  seed(handle.db as Db);
  assert.deepEqual(identityIn(handle.db as Db, 'fake'), { selfId: '9001', selfName: 'Αθηνά' });
  handle.close();
});

// Regression: a command line turn read her as `self` named `bot`, so her grants (keyed by her account) gave her no tool
// and the system text named her wrongly.
test('takes her account on another interface for a turn of an interface where she has none', () => {
  const handle = freshMemoryDb();
  seed(handle.db as Db);
  assert.deepEqual(identityIn(handle.db as Db, 'cli'), { selfId: '9001', selfName: 'Αθηνά' });
  handle.close();
});
