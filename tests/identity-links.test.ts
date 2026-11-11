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
import { adoptNativeAuthority, ownerConsoleName, ownerConsolePlace } from '../src/memory/db/identity-links.ts';
import { createRecord, toRecordLine } from '../src/memory/record.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
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

// Her own lines of the command line recorded before their echo, under the authority the record used to give them
// (src/memory/db/identity-links.ts#adoptNativeAuthority). Until 2026-11-11 the record reserved such a line's family under
// `cli/global` while the command line's account and place sit under `cli/local`, so the database keeps the line and its
// family there, and an echo of the line fails the replay. The adoption moves them to `cli/local` with the rest of the
// command line's rows. Real services over temporary databases, synthetic ids and words only.

const CONSOLE_CHAT = 'cli:dm:owner';
const CONSOLE_AT = Date.UTC(2026, 10, 10, 21, 40, 0);
const CONSOLE_WORDS = 'ein Licht am Hafen';

/** A line of `iface` as its interface hands it, from her (`self`) or from the other side of the DM. */
function lineEnvelope(iface: string, chat: string, id: string, at: number, self: boolean) {
  const envelope = observationOf(
    {
      iface,
      at,
      chat: { id: chat, kind: 'dm', chatType: 'dm', partnerId: 'owner', rootId: null },
      message: { id, at, content: CONSOLE_WORDS, author: { id: self ? 'self' : 'owner', self } },
    },
    { selfId: 'self' }
  );
  if (!envelope) throw new Error('the synthetic event was refused');
  return envelope;
}

type StoredLine = { id: string; authority_id: string; place_id: string; text: string; author_account: unknown };

/** Her line `said-1` and its family as the record wrote them before its echo: under `cli/global`. */
async function consoleLineUnderGlobal(log?: ReturnType<typeof warnings>) {
  const memory = await openTestMemory({ iface: () => 'cli', now: () => CONSOLE_AT + 60_000, log });
  // Her echo of an earlier line makes her account and the owner's chat under `cli/local`.
  const echoed = await memory.memoryDb.observeMessage(
    lineEnvelope('cli', CONSOLE_CHAT, 'said-0', CONSOLE_AT - 60_000, true),
    {
      placeId: CONSOLE_CHAT,
    }
  );
  assert.equal((echoed as { ok?: unknown } | null)?.ok, true, 'the scene makes her account');
  const line = toRecordLine(
    {
      id: 'said-1',
      placeId: CONSOLE_CHAT,
      content: CONSOLE_WORDS,
      ts: CONSOLE_AT,
      replyToId: null,
      mentionedAccountIds: [],
    },
    { kind: 'said', now: () => CONSOLE_AT, turnId: 't-1', opId: 'op-1' }
  );
  await createRecord({ ...memory, now: () => CONSOLE_AT }).append(CONSOLE_CHAT, [line], {});
  const db = memory.memoryDb.database();
  if (!db) throw new Error('the test memory database is not open');
  // The record of that time differed in the authority alone, which it registered: the line's id spells no authority.
  db.exec(
    `INSERT OR IGNORE INTO authorities (id, iface, namespace) VALUES ('cli/global', 'cli', 'global');
     UPDATE message_families SET authority_id = 'cli/global' WHERE message_id = 'said-1';
     UPDATE sources SET authority_id = 'cli/global' WHERE kind = 'said' AND author_account IS NULL`
  );
  const stored = db
    .prepare(
      "SELECT id, authority_id, place_id, text, author_account FROM sources WHERE kind = 'said' AND author_account IS NULL"
    )
    .all() as Array<StoredLine>;
  assert.equal(stored.length, 1, 'the scene holds her one recorded line');
  assert.equal(stored[0].authority_id, 'cli/global');
  return { memory, db, before: stored[0] };
}

function warnings() {
  const out: Array<Record<string, unknown>> = [];
  const add = (level: string) => (message: string, fields?: object) => out.push({ level, message, ...fields });
  return { out, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

const familyAuthority = (db: Db, message: string): unknown =>
  db.prepare('SELECT authority_id FROM message_families WHERE message_id = ?').get(message)?.authority_id;

test('her command line line and its family recorded under cli/global move to cli/local with their id, text and place', async () => {
  // Bug: the adoption's check looks at accounts, places and external keys alone. On a database whose accounts and places
  // already moved, it finds nothing and never moves the 34 lines and families the record left under `cli/global`.
  const { memory, db, before } = await consoleLineUnderGlobal();
  try {
    adoptNativeAuthority(db, 'cli');
    assert.equal(familyAuthority(db, 'said-1'), 'cli/local');
    const after = db
      .prepare('SELECT id, authority_id, place_id, text, author_account FROM sources WHERE id = ?')
      .get(before.id) as StoredLine | undefined;
    assert.deepEqual({ ...after }, { ...before, authority_id: 'cli/local' });
  } finally {
    await memory.close();
  }
});

test('the echo of her line recorded under cli/global is observed onto it, with her one account', async () => {
  // Bug: the echo resolves the family under `cli/global`, looks for her account there, misses and inserts `cli:self` a
  // second time, so the observation fails on `accounts.id` on every history read, as before the writer was fixed.
  const log = warnings();
  const { memory, db, before } = await consoleLineUnderGlobal(log);
  try {
    const replayed = await memory.memoryDb.observeMessage(
      lineEnvelope('cli', CONSOLE_CHAT, 'said-1', CONSOLE_AT, true),
      {
        placeId: CONSOLE_CHAT,
      }
    );
    assert.deepEqual(
      log.out.filter((entry) => entry.message === 'memory db: observe failed'),
      [],
      'the echo fails no statement'
    );
    assert.equal((replayed as { ok?: unknown } | null)?.ok, true);
    assert.equal((replayed as { sourceId?: unknown }).sourceId, before.id, 'the echo lands on the recorded line');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE kind = 'self' AND iface = 'cli'").get()?.n, 1);
    assert.equal(
      db.prepare('SELECT author_account FROM sources WHERE id = ?').get(before.id)?.author_account,
      'cli:self',
      'the line names her account'
    );
  } finally {
    await memory.close();
  }
});

test('a line under the global authority of an interface whose native authority it is stays there', async () => {
  // Bug: an adoption that moves every `<iface>/global` row would move the lines of a chat interface, whose rows belong
  // under `<iface>/global` (src/protocol/identity.ts#nativeAuthorityOf), away from the accounts and places they name.
  const { memory, db } = await consoleLineUnderGlobal();
  try {
    const chat = await memory.memoryDb.observeMessage(
      lineEnvelope('chat', 'chat:dm:owner', 'chat-1', CONSOLE_AT, false),
      {
        placeId: 'chat:dm:owner',
      }
    );
    assert.equal((chat as { ok?: unknown } | null)?.ok, true, 'the scene stores a chat line');
    adoptNativeAuthority(db, 'cli');
    adoptNativeAuthority(db, 'chat');
    assert.equal(familyAuthority(db, 'chat-1'), 'chat/global');
    assert.deepEqual(
      db
        .prepare("SELECT DISTINCT authority_id FROM sources WHERE iface = 'chat'")
        .all()
        .map((row) => row.authority_id),
      ['chat/global']
    );
  } finally {
    await memory.close();
  }
});

test('a family whose key cli/local already holds stays under cli/global with its line, and the others move', async () => {
  // Bug: `UPDATE OR IGNORE` leaves a family whose key collides under `cli/global` but moves its lines, which carry no
  // unique key, to `cli/local`. The line then names a family no row holds under its authority, and the echo's join of
  // line and family (observe.ts#fillOwnAuthor) never finds it. A family and its lines move together or not at all.
  const { memory, db, before } = await consoleLineUnderGlobal();
  try {
    const collides = db
      .prepare("SELECT native_kind, native_key FROM message_families WHERE message_id = 'said-1'")
      .get();
    db.prepare(
      `INSERT INTO message_families (iface, conversation_id, message_id, generation, authority_id, native_kind, native_key)
       VALUES ('cli', ?, 'said-other', 1, 'cli/local', ?, ?)`
    ).run(CONSOLE_CHAT, collides?.native_kind, collides?.native_key);
    // A second recorded line of hers under `cli/global`, whose key nothing else holds.
    const line = toRecordLine(
      {
        id: 'said-2',
        placeId: CONSOLE_CHAT,
        content: CONSOLE_WORDS,
        ts: CONSOLE_AT + 1000,
        replyToId: null,
        mentionedAccountIds: [],
      },
      { kind: 'said', now: () => CONSOLE_AT + 1000, turnId: 't-2', opId: 'op-2' }
    );
    await createRecord({ ...memory, now: () => CONSOLE_AT + 1000 }).append(CONSOLE_CHAT, [line], {});
    db.exec(
      `UPDATE message_families SET authority_id = 'cli/global' WHERE message_id = 'said-2';
       UPDATE sources SET authority_id = 'cli/global' WHERE kind = 'said' AND author_account IS NULL`
    );
    adoptNativeAuthority(db, 'cli');
    assert.equal(familyAuthority(db, 'said-1'), 'cli/global', 'the colliding family stays');
    assert.equal(
      db.prepare('SELECT authority_id FROM sources WHERE id = ?').get(before.id)?.authority_id,
      'cli/global',
      'its line stays with it'
    );
    assert.equal(familyAuthority(db, 'said-other'), 'cli/local', 'the family already under cli/local is untouched');
    assert.equal(familyAuthority(db, 'said-2'), 'cli/local', 'a family with a free key moves');
    assert.equal(
      db
        .prepare("SELECT authority_id FROM sources WHERE kind = 'said' AND id <> ? AND author_account IS NULL")
        .get(before.id)?.authority_id,
      'cli/local',
      'and its line with it'
    );
  } finally {
    await memory.close();
  }
});
