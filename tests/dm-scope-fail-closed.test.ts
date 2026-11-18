// The rules behind the journal's DM privacy that a turn cannot reach alone: a scope that names a DM never opens to a group,
// a private layer's closed claim stays private, and the core's recent lines of a channel leave out what is not the group's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partnerOfDelivery } from '../src/behavior/inner/deliveries.ts';
import { personaJournal, personaRecord } from '../src/behavior/inner/persona-sources.ts';
import { recentPlaceLines } from '../src/memory/db/chat-lines.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { directChatPlaceOf } from '../src/memory/db/places-read.ts';
import { addDmPlace } from './fixtures/memory-db/opaque-people.ts';
import { SCOPE_INTERNAL, groupScope, scopeColumns } from '../src/memory/db/scope.ts';
import { PERSONA_ID } from '../src/memory/db/ids.ts';
import type { Db } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { tempDir } from './fixtures/tmp.ts';
import { memoryAt } from './fixtures/store-kit.ts';

type Scoped = { scope: Record<string, unknown>; itemKind: string };

test('a DM place id named as a channel is scoped internal', () => {
  // Bug: `{ channel }` maps to a group scope whatever it names, so a DM line opens to every group.
  assert.deepEqual(scopeColumns({ channel: 'discord:dm:n1' }, { iface: 'discord' }), SCOPE_INTERNAL);
});

test('a DM place named without the private mark is scoped internal', () => {
  // Bug: an archived lesson of a DM carries `{ place }`, and a place maps to a group scope.
  assert.deepEqual(scopeColumns({ place: 'discord:dm:n1' }, { iface: 'discord' }), SCOPE_INTERNAL);
});

test('a line with the private mark and only a channel is scoped internal', () => {
  // Bug: the private mark is read only beside a place, so the channel rule opens the line.
  assert.deepEqual(scopeColumns({ channel: 'c1', private: true }, { iface: 'discord' }), SCOPE_INTERNAL);
});

test('a chat no place holds is scoped internal', () => {
  // Bug: a wake's line into a chat nobody can name as a group is filed as a group's.
  assert.deepEqual(scopeColumns({ channel: 'c1', unresolved: true }, { iface: 'discord' }), SCOPE_INTERNAL);
});

test('a real channel and a real place stay the group', () => {
  // Bug: a fail-closed rule that also closes every group's own history.
  assert.deepEqual(scopeColumns({ channel: 'c1' }, { iface: 'discord' }), groupScope('discord'));
  assert.deepEqual(scopeColumns({ place: 'discord:server:g1' }, { iface: 'discord' }), groupScope('discord'));
});

// Changed: the private layer alone, since the profile's item writer left with `alias.add`.
function closing() {
  const entries: Array<Scoped> = [];
  const archive = {
    append(_home: string | null, lines: Array<Scoped>) {
      entries.push(...lines);
      return Promise.resolve();
    },
  };
  const store = createStore({ ...memoryAt(tempDir('nep-closed-')), archive }) as never as Record<
    string,
    (...args: Array<unknown>) => unknown
  >;
  const opts = (n: number) => ({ now: 1_790_000_000_000 + n * 1000, maxClosedStored: 0 });
  const held = () => (store.getPrivate('a1') as { interests: Array<{ itemId: string }> }).interests[0];
  store.applyPrivateOps('a1', { interests: { add: [{ topic: 'first', note: '' }] } }, opts(0));
  store.applyPrivateOps(
    'a1',
    { interests: { add: [{ topic: 'second', note: '', supersedes: held().itemId }] } },
    opts(1)
  );
  return { store, entries };
}

test('a private claim closed out of the private layer is archived as private', async () => {
  // Bug: `storeClosed` scopes every closed claim `{ user }`, so a private one passes the group's archive read.
  const { store, entries } = closing();
  await store.settleArchive();
  assert.notEqual(entries.length, 0);
  assert.deepEqual(
    entries.map((entry) => entry.scope.private),
    entries.map(() => true)
  );
});

function linesRig(t: { after: (fn: () => void) => void }) {
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  const db = handle.db as Db;
  db.exec("INSERT INTO audiences (id, kind, iface) VALUES ('aud:group:discord', 'group', 'discord')");
  const add = db.prepare(
    `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, occurred_at, text, scope_kind, scope_iface, audience_id)
     VALUES (?, ?, 'discord', ?, 1, 'discord:channel:c1', ?, ?, ?, ?, ?)`
  );
  return { db, add };
}

test("a channel's recent lines leave out a line that is not the group's", (t) => {
  // Bug: `recentChannelLines` reads by the spelled place alone, so a wake's DM line under that place reaches an errand.
  const { db, add } = linesRig(t);
  const at = '2026-11-05T00:00:00.000Z';
  add.run('s1', 'seen', 'n1', at, 'for the room', 'group', 'discord', 'aud:group:discord');
  add.run('s2', 'said', 'n2', at, 'for one person', 'internal', null, 'aud:internal');
  assert.deepEqual(
    recentPlaceLines(db, 'discord:channel:c1', 10).map((row) => row.text),
    ['for the room']
  );
});

test("a direct chat's recent lines are its own lines, found by its chat id", (t) => {
  // Bug: an errand asked in a direct chat reads the channel place of the chat's id and gets no line.
  const { db, add } = linesRig(t);
  addDmPlace(db, {
    id: 'discord:dm:n1',
    iface: 'discord',
    authority: 'discord/global',
    account: 'discord:n1',
    person: null,
  });
  db.prepare("UPDATE places SET native_id = 'dm-chat-1' WHERE id = 'discord:dm:n1'").run();
  db.exec(
    "INSERT INTO audiences (id, kind, iface, place_id) VALUES ('aud:dm:discord:dm:n1', 'dm', 'discord', 'discord:dm:n1')"
  );
  const at = '2026-11-05T00:00:00.000Z';
  add.run('s1', 'seen', 'n1', at, 'for one person', 'dm', 'discord', 'aud:dm:discord:dm:n1');
  db.prepare("UPDATE sources SET place_id = 'discord:dm:n1' WHERE id = 's1'").run();
  const place = directChatPlaceOf(db, 'dm-chat-1');
  assert.equal(place, 'discord:dm:n1');
  assert.deepEqual(
    recentPlaceLines(db, String(place), 10).map((row) => row.text),
    ['for one person']
  );
});

/** A store that names a DM by its partner and holds one channel as a group's. */
const addressing = {
  placeOfChat: (chat: { id?: string; partnerId?: string }) =>
    chat.partnerId ? `place:dm-${chat.partnerId}` : `place:${String(chat.id)}`,
  rootPlaceOf: (place: string) => (place === 'place:room' ? 'place:server' : null),
  holdsSharedChat: (id: string) => id === 'room',
};

function journalled() {
  const holders: Array<string> = [];
  const journal = {
    op(holder: string) {
      holders.push(holder);
      return {};
    },
  };
  return { holders, inner: personaJournal(journal as never, () => [], addressing) };
}

test("a wake's operation with a partner goes to that partner's DM", () => {
  // Bug: the delivery's partner is dropped on the way, and the operation lands in the journal every wake reads.
  const { holders, inner } = journalled();
  inner.op({ placeId: 'dm-native', privateAccountId: 'n1' });
  assert.deepEqual(holders, ['place:dm-n1']);
});

test("a wake's operation in a held channel stays in the persona's journal", () => {
  // Bug: a fail-closed rule that hides her posts in a real channel from the wakes that read them.
  const { holders, inner } = journalled();
  inner.op({ placeId: 'room', privateAccountId: null });
  assert.deepEqual(holders, [PERSONA_ID]);
});

function recorded() {
  const written: Array<[string, Array<{ scope: Record<string, unknown> }>]> = [];
  const record = {
    append(place: string, lines: never) {
      written.push([place, lines]);
    },
  };
  return { written, inner: personaRecord(record as never, addressing, () => []) };
}

test("a wake's said line with a partner goes to that partner's DM", () => {
  // Bug: `recordSaid` appends with no partner, and the line goes to the spelled channel place of the chat.
  const { written, inner } = recorded();
  inner.append([{ scope: { channel: 'dm-native' } }], { privateAccountId: 'n1' });
  assert.deepEqual(written, [['place:dm-n1', [{ scope: { channel: 'dm-native' } }]]]);
});

test("a wake's said line in a held channel goes to its tree with its scope as written", () => {
  // Bug: the seal reaches a real channel's line, and the group's history loses her own posts.
  const { written, inner } = recorded();
  inner.append([{ scope: { channel: 'room' } }], {});
  assert.deepEqual(written, [['place:server', [{ scope: { channel: 'room' } }]]]);
});

const asking = (answer: unknown) => ({
  log: { warn() {} },
  reads: {
    chatInfo: () => {
      if (answer instanceof Error) throw answer;
      return Promise.resolve(answer);
    },
  },
});
const CHAT = { iface: 'fake', chatId: 'c' };

test("a delivery's partner comes from the chat the interface describes", async () => {
  // Bug: `privateAccountId: null` on every delivery files a DM's line away from its partner.
  const life = asking({ chat: { rootId: null, partnerId: 'n1' } });
  assert.equal(await partnerOfDelivery(life as never, CHAT), 'n1');
});

test("a root's chat has no partner, whatever it names", async () => {
  // Bug: a channel with a stray partner field files a group's line under one person's DM.
  const life = asking({ chat: { rootId: 'g1', partnerId: 'n1' } });
  assert.equal(await partnerOfDelivery(life as never, CHAT), null);
});

test('an interface that cannot describe the chat gives no partner and no throw', async () => {
  // Bug: a failed read after the send loses the said line of a message already sent.
  assert.equal(await partnerOfDelivery(asking(new Error('gone')) as never, CHAT), null);
});
