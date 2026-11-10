// The links the observation writes for the owner's command line (src/memory/db/identity-links.ts): a line carries the
// owner's person, and the writer links the chat's account to it and folds her proposals for that account into him. Real
// temporary databases, synthetic ids only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { observe } from '../src/memory/db/observe.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { mergePeople } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { addAccount, addDmPlace, addPerson } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';
import { ownerConsoleName, ownerConsolePlace } from '../src/memory/db/identity-links.ts';
import type { Db } from '../src/memory/db/types.ts';

const OWNER = 'person:0w0w0w0w-synthetic';
const PROPOSED = 'person:9r9r9r9r-synthetic';
const ELSEWHERE = 'person:e1e1e1e1-synthetic';
const AT = Date.parse('2026-11-05T10:00:00Z');

test('a line of the command line is stored when her proposal for it was merged into somebody else', () => {
  // Bug: the observation folds her tentative person into the owner, the merge refuses a person already merged
  // elsewhere, and the refusal rolls back the line, so every line of the owner's chat is lost.
  const handle = openMemoryDb(path.join(tempDir('nep-identity-links-'), 'memory.db'));
  try {
    const db = dbOf(handle);
    addPerson(db, OWNER);
    addPerson(db, ELSEWHERE);
    addAccount(db, {
      id: 'cli:owner',
      iface: 'cli',
      authority: 'cli/local',
      native: 'owner',
      person: PROPOSED,
      link: 'proposed',
    });
    db.prepare("UPDATE account_person_links SET by = 'her' WHERE account_id = 'cli:owner'").run();
    mergePeople(handle, PROPOSED, ELSEWHERE, { by: 'session', now: AT });
    const envelope = observationOf(
      {
        kind: 'message.received',
        iface: 'cli',
        at: AT,
        chat: { id: 'cli:dm:owner', kind: 'dm', chatType: 'dm', partnerId: 'owner' },
        message: { id: 'line-1', at: AT, content: 'a synthetic line', author: { id: 'owner', name: 'owner' } },
      },
      { connection: 'conn:cli', direct: true }
    );
    assert.ok(envelope);
    const result = observe(handle, { ...envelope, consoleOwner: { person: OWNER, listed: [] } }, { now: () => AT });
    assert.equal(result.ok, true);
    assert.equal(db.prepare("SELECT person_id FROM accounts WHERE id = 'cli:owner'").get()?.person_id, OWNER);
    assert.equal(
      db.prepare('SELECT into_person FROM people_merges WHERE from_person = ?').get(PROPOSED)?.into_person,
      ELSEWHERE
    );
  } finally {
    handle.close();
  }
});

// The name of the owner on his command line (src/memory/db/identity-links.ts#ownerConsoleName): the command line's
// account goes by `owner`, so her chat, the line she answers and `<people>` named him `owner` or `cli:owner`. The name
// comes from the person the command line's account links to: a name of one of his other verified accounts, else his
// real name. Real temporary databases, synthetic ids and names only.

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

test("the owner's command line chat is the DM place of his command line account, whatever its id spells", (t) => {
  // Bug: the chat's sessions named the place `cli:dm:owner`, a place no row holds when the stored place has another id.
  const db = dbWithConsole(t);
  addAccount(db, { id: 'cli:guest', iface: 'cli', authority: 'cli/local', native: 'guest', person: OTHER });
  addDmPlace(db, { id: 'place:cli-guest', iface: 'cli', authority: 'cli/local', account: 'cli:guest', person: OTHER });
  addDmPlace(db, { id: 'place:cli-7f3a', iface: 'cli', authority: 'cli/local', account: 'cli:owner', person: OWNER });
  assert.equal(ownerConsolePlace(db), 'place:cli-7f3a');
});

test("the owner's command line chat is none while no place of his command line account is stored", (t) => {
  // Bug: a missing chat answered as the spelled `cli:dm:owner`, which no row holds.
  assert.equal(ownerConsolePlace(dbWithConsole(t)), null);
});
