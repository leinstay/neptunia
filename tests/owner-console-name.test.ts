// The name of the owner on his command line (src/memory/db/identity-links.ts#ownerConsoleName): the command line's
// account goes by `owner`, so her chat, the line she answers and `<people>` named him `owner` or `cli:owner`. The name
// comes from the person the command line's account links to: a name of one of his other verified accounts, else his
// real name. Real temporary databases, synthetic ids and names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ownerConsoleName } from '../src/memory/db/identity-links.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { addAccount } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const OWNER = 'person:0w0w0w0w-synthetic';
const OTHER = 'person:o7o7o7o7-synthetic';

type Context = { after: (fn: () => void) => void };

/** A fresh memory database with the command line's account linked to `person` (null: not linked). */
function dbWithConsole(t: Context, link: 'verified' | 'proposed' = 'verified'): Db {
  const handle = openMemoryDb(path.join(tempDir('nep-owner-name-'), 'memory.db'));
  t.after(() => handle.close());
  const db = dbOf(handle);
  addAccount(db, { id: 'cli:owner', iface: 'cli', authority: 'cli/local', native: 'owner', person: OWNER, link });
  db.prepare("UPDATE accounts SET names = '[\"owner\"]' WHERE id = 'cli:owner'").run();
  return db;
}

/** Another account of `person` on a chat interface, going by `names`. */
function addChatAccount(db: Db, id: string, person: string, names: Array<string>): void {
  addAccount(db, { id, iface: 'chat', authority: 'chat/global', native: id, person });
  db.prepare('UPDATE accounts SET names = ? WHERE id = ?').run(JSON.stringify(names), id);
}

test("the owner's name is the name of his other account, never the command line's own", (t) => {
  // Bug: she read the owner as `owner` in her chat and as `cli:owner` among the people she knows.
  const db = dbWithConsole(t);
  addChatAccount(db, 'chat:41', OWNER, ['Robin']);
  assert.equal(ownerConsoleName(db), 'Robin');
});

test('an account of somebody else never names the owner', (t) => {
  const db = dbWithConsole(t);
  addChatAccount(db, 'chat:52', OTHER, ['Kim']);
  assert.equal(ownerConsoleName(db), null);
});

test('with no other account, his stored real name names him', (t) => {
  const db = dbWithConsole(t);
  db.prepare('UPDATE people SET real_name = ? WHERE id = ?').run('Robin Example', OWNER);
  assert.equal(ownerConsoleName(db), 'Robin Example');
});

test('a command line account with no verified link has no name of a person', (t) => {
  // Bug: her proposal for the account named the owner after somebody she only guessed.
  const db = dbWithConsole(t, 'proposed');
  addChatAccount(db, 'chat:41', OWNER, ['Robin']);
  assert.equal(ownerConsoleName(db), null);
});
