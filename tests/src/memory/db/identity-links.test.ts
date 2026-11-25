// Tests for src/memory/db/identity-links.ts: the links the observation writes for the owner's command line, the name
// and the chat of the owner there, and the adoption of the persona's command line lines into the native authority. A
// line carries the owner's person, and the writer links the chat's account to it and folds the persona's proposals for
// that account into that person. Real temporary databases, synthetic ids only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { observationOf } from '../../../../src/memory/db/observe-event.ts';
import { observe } from '../../../../src/memory/db/observe.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import { addAccount, addDmPlace, addPerson, recordMerge } from '../../../fixtures/memory-db/opaque-people.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { adoptNativeAuthority, ownerConsoleName, ownerConsolePlace } from '../../../../src/memory/db/identity-links.ts';
import { createRecord, toRecordLine } from '../../../../src/memory/record.ts';
import { openTestMemory } from '../../../fixtures/memory-db/service.ts';
import type { Db } from '../../../../src/memory/db/types.ts';
import { readFileSync } from 'node:fs';
import { withIface } from '../../../../src/memory/db/current-iface.ts';
import { isOwnerId } from '../../../../src/tools/operations/grants.ts';
import { query, spawnCli, startUnitsCore, until, withRig } from '../../../fixtures/core-units.ts';
import type { Dirs, Rig } from '../../../fixtures/core-units.ts';

const OWNER = 'person:0w0w0w0w-synthetic';
const PROPOSED = 'person:9r9r9r9r-synthetic';
const ELSEWHERE = 'person:e1e1e1e1-synthetic';
const AT = Date.parse('2026-11-05T10:00:00Z');

test("a line of the command line is stored when the persona's proposal for it was merged into somebody else", () => {
  // Bug: the observation folds the persona's tentative person into the owner, the merge refuses a person already merged
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
    recordMerge(dbOf(handle), PROPOSED, ELSEWHERE, 'session');
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

// The name of the owner on the command line (src/memory/db/identity-links.ts#ownerConsoleName). The command line's
// account goes by `owner`, so the persona's chat, the line they answer and `<people>` would name the owner `owner` or
// `cli:owner`. The name comes from the person the command line's account links to: a name of one of that person's other
// verified accounts, else their real name. Real temporary databases, synthetic ids and names only.

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

test("the owner's name is the name of their other account, never the command line's own", (t) => {
  // Bug: the persona read the owner as `owner` in their chat and as `cli:owner` among the people they know.
  const db = dbWithConsole(t);
  addChatAccount(db, 'chat:41', OWNER, ['Robin']);
  assert.equal(ownerConsoleName(db), 'Robin');
});

test('an account of somebody else never names the owner', (t) => {
  const db = dbWithConsole(t);
  addChatAccount(db, 'chat:52', OTHER, ['Kim']);
  assert.equal(ownerConsoleName(db), null);
});

test("with no other account, the owner's stored real name names them", (t) => {
  const db = dbWithConsole(t);
  db.prepare('UPDATE people SET real_name = ? WHERE id = ?').run('Robin Example', OWNER);
  assert.equal(ownerConsoleName(db), 'Robin Example');
});

test('a command line account with no verified link has no name of a person', (t) => {
  // Bug: the persona's proposal for the account named the owner after somebody they only guessed.
  const db = dbWithConsole(t, 'proposed');
  addChatAccount(db, 'chat:41', OWNER, ['Robin']);
  assert.equal(ownerConsoleName(db), null);
});

test("the owner's command line chat is the DM place of the owner's command line account, whatever its id spells", (t) => {
  // Bug: the chat's sessions named the place `cli:dm:owner`, a place no row holds when the stored place has another id.
  const db = dbWithConsole(t);
  addAccount(db, { id: 'cli:guest', iface: 'cli', authority: 'cli/local', native: 'guest', person: OTHER });
  addDmPlace(db, { id: 'place:cli-guest', iface: 'cli', authority: 'cli/local', account: 'cli:guest', person: OTHER });
  addDmPlace(db, { id: 'place:cli-7f3a', iface: 'cli', authority: 'cli/local', account: 'cli:owner', person: OWNER });
  assert.equal(ownerConsolePlace(db), 'place:cli-7f3a');
});

test("the owner's command line chat is none while no place of the owner's command line account is stored", (t) => {
  // Bug: a missing chat answered as the spelled `cli:dm:owner`, which no row holds.
  assert.equal(ownerConsolePlace(dbWithConsole(t)), null);
});

// The persona's own lines of the command line that a database holds with their families under `cli/global`, while the
// command line's account and place sit under `cli/local` (src/memory/db/identity-links.ts#adoptNativeAuthority). An
// echo of such a line fails the replay, so the adoption moves the line and its family to `cli/local` with the rest of
// the command line's rows. Real services over temporary databases, synthetic ids and words only.

const CONSOLE_CHAT = 'cli:dm:owner';
const CONSOLE_AT = Date.UTC(2026, 10, 10, 21, 40, 0);
const CONSOLE_WORDS = 'ein Licht am Hafen';

/** A line of `iface` as its interface hands it, from the persona (`self`) or from the other side of the DM. */
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

/** The persona's line `said-1` and its family under `cli/global`, as a database holds them before the line's echo. */
async function consoleLineUnderGlobal(log?: ReturnType<typeof warnings>) {
  const memory = await openTestMemory({ iface: () => 'cli', now: () => CONSOLE_AT + 60_000, log });
  // The persona's echo of an earlier line makes the persona's account and the owner's chat under `cli/local`.
  const echoed = await memory.memoryDb.observeMessage(
    lineEnvelope('cli', CONSOLE_CHAT, 'said-0', CONSOLE_AT - 60_000, true),
    {
      placeId: CONSOLE_CHAT,
    }
  );
  assert.equal((echoed as { ok?: unknown } | null)?.ok, true, 'the scene makes the account of the persona');
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
  // Such a record differs in the authority alone, which it registers: the line's id spells no authority.
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
  assert.equal(stored.length, 1, 'the scene holds the one recorded line of the persona');
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

test("the persona's command line line and its family recorded under cli/global move to cli/local with their id, text and place", async () => {
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

test("the echo of the persona's line recorded under cli/global is observed onto it, with the persona's one account", async () => {
  // Bug: the echo resolves the family under `cli/global`, looks for the persona's account there, misses and inserts
  // `cli:self` a second time, so the observation fails on `accounts.id` on every history read.
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
      'the line names the account of the persona'
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
    // A second recorded line of the persona under `cli/global`, whose key nothing else holds.
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

const CLI_OWNER = 'person:0wner-synthetic';
const STALE = 'person:d0ub1e-synthetic';

const configOf = (dirs: Dirs): { bot: { ownerPerson: string } } =>
  JSON.parse(readFileSync(path.join(dirs.privateDir, 'config', 'config.json'), 'utf8')) as {
    bot: { ownerPerson: string };
  };

const cliAccount = (dirs: Dirs) =>
  query(dirs, "SELECT id, person_id, link FROM accounts WHERE iface = 'cli' AND native_key = 'owner'")[0];

/** The owner types one line in their chat; returns once the line is stored. */
async function firstLine({ dirs, clis }: Pick<Rig, 'dirs' | 'clis'>): Promise<void> {
  const chat = spawnCli(dirs, []);
  clis.push(chat);
  chat.type('the first line of a new install');
  await until(
    () => query(dirs, "SELECT 1 FROM sources WHERE iface = 'cli' AND kind = 'seen'").length > 0,
    () => chat.stderr()
  );
}

const ownerOn = (iface: string, native: string, config: object): boolean =>
  withIface(iface, () => isOwnerId(config, native));

test('with an owner person set, the first line of the command line joins it and creates nobody', async () => {
  // Bug: an install whose owner was bound on another interface first ends up with two people for the owner.
  await withRig({ config: { bot: { ownerPerson: CLI_OWNER } } }, async ({ dirs, llm, clis, cores }) => {
    const seed = openMemoryDb(path.join(dirs.dataDir, 'memory.db'));
    addAccount(dbOf(seed), { id: 'fake:u1', iface: 'fake', authority: 'fake/global', native: 'u1', person: CLI_OWNER });
    seed.close();
    cores.push(await startUnitsCore(dirs, llm));
    const before = query(dirs, "SELECT id FROM people WHERE id <> 'person:self'");
    await firstLine({ dirs, clis });
    assert.equal(cliAccount(dirs)?.person_id, CLI_OWNER);
    assert.deepEqual(query(dirs, "SELECT id FROM people WHERE id <> 'person:self'"), before);
    assert.equal(ownerOn('cli', 'owner', configOf(dirs)), true);
    assert.equal(ownerOn('fake', 'u1', configOf(dirs)), true);
  });
});

test("a proposal of the persona's for the command line resolves to the owner at the next line", async () => {
  // Bug: an install that already ran has the tracked person the persona made for the owner, and that proposal stands for good.
  await withRig({ config: { bot: { ownerPerson: CLI_OWNER } } }, async ({ dirs, llm, clis, cores }) => {
    const seed = openMemoryDb(path.join(dirs.dataDir, 'memory.db'));
    const db = dbOf(seed);
    addAccount(db, { id: 'fake:u1', iface: 'fake', authority: 'fake/global', native: 'u1', person: CLI_OWNER });
    addAccount(db, {
      id: 'cli:owner',
      iface: 'cli',
      authority: 'cli/global',
      native: 'owner',
      person: null,
      link: 'proposed',
    });
    db.prepare("INSERT INTO people (id, kind, status) VALUES (?, 'person', 'active')").run(STALE);
    db.prepare(
      `INSERT INTO account_person_links (id, account_id, person_id, state, by, reason, valid_from_at, recorded_at)
       VALUES ('link:stale', 'cli:owner', ?, 'proposed', 'her', 'synthetic', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`
    ).run(STALE);
    seed.close();
    cores.push(await startUnitsCore(dirs, llm));
    await firstLine({ dirs, clis });

    assert.equal(cliAccount(dirs)?.id, 'cli:owner');
    assert.equal(query(dirs, "SELECT id FROM accounts WHERE iface = 'cli'").length, 1, 'no second account of the chat');
    assert.equal(cliAccount(dirs)?.person_id, CLI_OWNER);
    assert.equal(
      query(dirs, "SELECT 1 FROM account_person_links WHERE id = 'link:stale' AND valid_to_at IS NULL").length,
      0,
      'the proposal is closed'
    );
    assert.deepEqual(query(dirs, 'SELECT from_person, into_person FROM people_merges'), [
      { from_person: STALE, into_person: CLI_OWNER },
    ]);
  });
});
