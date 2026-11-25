// The sources of an inner turn (src/behavior/inner/persona-sources.ts): what a wake leaves in a direct message reaches
// its partner alone, and where a wake's operations and said lines go.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { personaJournal, personaRecord } from '../../../../src/behavior/inner/persona-sources.ts';
import { createAppendStore } from '../../../../src/memory/append-store.ts';
import { createArchive } from '../../../../src/memory/archive.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { search } from '../../../../src/memory/db/recall.ts';
import { internalContext, scopeWhere } from '../../../../src/memory/db/scope.ts';
import { createMemoryDb } from '../../../../src/memory/db/service.ts';
import type { MemoryDbService } from '../../../../src/memory/db/service.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db } from '../../../../src/memory/db/types.ts';
import { createJournal } from '../../../../src/memory/journal.ts';
import type { Journal } from '../../../../src/memory/journal.ts';
import { createRecord, toRecordLine } from '../../../../src/memory/record.ts';
import { createStore } from '../../../../src/memory/store.ts';
import { createVectors } from '../../../../src/memory/vectors.ts';
import { wrongly } from '../../../fixtures/loose-types.ts';
import { addAccount, addDmPlace, addGroupPlace } from '../../../fixtures/memory-db/opaque-people.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import '../../../../src/tools/operations/index.ts';
import { PERSONA_ID } from '../../../../src/memory/db/ids.ts';

const quiet = { info() {}, debug() {}, warn() {}, error() {} };

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

const DAY = '2026-11-05';

const SECRET = 'xylophonewhisper';

const LIKE = `%${SECRET}%`;

// A first-generation DM on the home authority: the place and the person are spelled from the native id.
const PARTNER = 'n1';

const PARTNER_ACCOUNT = 'discord:n1';

const PARTNER_PERSON = 'person:discord:n1';

const DM = 'discord:dm:n1';

const DM_CHAT = 'dm-chat-n1';

// Another partner on the same interface.
const OTHER = 'n2';

const OTHER_PERSON = 'person:discord:n2';

const OTHER_DM = 'discord:dm:n2';

const GROUP = 'discord:channel:room-1';

const SERVER = 'discord:server:g1';

// A partner with the same native id under another authority of the interface: the place's id spells nothing.
const STRANGER_ACCOUNT = 'account:other-authority';

const STRANGER_PERSON = 'person:elsewhere';

const STRANGER_DM = 'place:dm-other-authority';

/** Lets the journal's unawaited writes reach the writer, which runs on this thread here. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

const opened: Array<MemoryDbService> = [];

after(async () => {
  for (const service of opened) await service.close();
});

function seedWorld(db: Db): void {
  addAccount(db, {
    id: PARTNER_ACCOUNT,
    iface: 'discord',
    authority: 'discord/global',
    native: PARTNER,
    person: PARTNER_PERSON,
  });
  addAccount(db, {
    id: 'discord:n2',
    iface: 'discord',
    authority: 'discord/global',
    native: OTHER,
    person: OTHER_PERSON,
  });
  addAccount(db, {
    id: STRANGER_ACCOUNT,
    iface: 'discord',
    authority: 'discord/other',
    native: PARTNER,
    person: STRANGER_PERSON,
  });
  addDmPlace(db, {
    id: DM,
    iface: 'discord',
    authority: 'discord/global',
    account: PARTNER_ACCOUNT,
    person: PARTNER_PERSON,
  });
  addDmPlace(db, {
    id: OTHER_DM,
    iface: 'discord',
    authority: 'discord/global',
    account: 'discord:n2',
    person: OTHER_PERSON,
  });
  addDmPlace(db, {
    id: STRANGER_DM,
    iface: 'discord',
    authority: 'discord/other',
    account: STRANGER_ACCOUNT,
    person: STRANGER_PERSON,
  });
  addGroupPlace(db, GROUP, 'discord', 'discord/global');
  db.prepare(
    `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, chat, scope_kind)
     VALUES (?, 'discord', 'server', 'g1', 'server:g1', 'discord/global', 1, 'group', 'group')`
  ).run(SERVER);
}

function world() {
  const dataDir = tempDir('nep-dm-privacy-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  seedWorld(dbOf(seed));
  seed.close();
  const hot = { config: { memoryDb: { session: { mode: 'off' } }, context: { memory: { openPrivate: false } } } };
  const memoryDb = createMemoryDb({
    hot,
    dataDir,
    log: quiet,
    worker: false,
    iface: () => 'discord',
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const read = (): Db => dbOf(wrongly<Parameters<typeof dbOf>[0]>(memoryDb.readHandle()));
  const journal = createJournal({ dataDir, memoryDb, now: () => NOW, log: quiet });
  const record = createRecord({ dataDir, memoryDb, now: () => NOW, log: quiet });
  const appendStore = createAppendStore({ fsyncMs: 0, log: quiet });
  const archive = createArchive({ appendStore, dataDir, memoryDb, now: () => NOW, log: quiet });
  const vectors = createVectors({ dataDir, memoryDb, now: () => NOW, log: quiet });
  const store = createStore({ dataDir, archive, memoryDb });
  const contexts = {
    group: memoryDb.issueContext({ kind: 'group', iface: 'discord', destination: GROUP }),
    other: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: OTHER_PERSON, place: OTHER_DM }),
    partner: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: PARTNER_PERSON, place: DM }),
    stranger: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: STRANGER_PERSON, place: STRANGER_DM }),
  };
  return { dataDir, hot, memoryDb, read, journal, record, archive, vectors, store, contexts };
}

type World = ReturnType<typeof world>;

/** The rows of `table` holding the secret that the context may read, by the rule every scoped read uses. */
function secretRows(db: Db, table: string, ctx: unknown): Array<Record<string, unknown>> {
  const scope = scopeWhere(ctx, 's');
  const columns = db
    .prepare(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((row) => String(row.name))
    .filter((name) => ['text', 'think', 'extra', 'reason', 'what'].includes(name));
  const holds = columns.map((name) => `s.${name} LIKE ?`).join(' OR ');
  return db
    .prepare(`SELECT s.* FROM ${table} s WHERE (${holds}) AND ${scope.sql}`)
    .all(...columns.map(() => LIKE), ...scope.params);
}

/** A record line of a chat: what a person said there. */
const lineSaid = (id: string, chat = DM_CHAT, by = PARTNER) =>
  toRecordLine(
    { id, placeId: chat, authorId: by, authorName: 'Partner', content: `the ${SECRET} plan`, ts: NOW - 60_000 },
    { now: () => NOW }
  );

/** Everything `search` hands a reader, as text. */
const searched = (w: World, ctx: unknown) =>
  JSON.stringify(search(w.read(), { ctx, plan: { forms: [SECRET], who: [], from: null, to: null }, now: NOW }));

/** The operation a wake's delivery writes around a send into a DM (src/behavior/inner/deliveries.ts#postOp). */
async function wakePostInDm(w: World) {
  const inner = personaJournal(w.journal, () => [], wrongly(w.store));
  const op = inner.op(
    wrongly({
      turnId: 't-wake',
      name: 'post',
      by: 'persona',
      placeId: DM_CHAT,
      privateAccountId: null,
      intent: { replyTo: null, text: `said ${SECRET} to the partner` },
    })
  );
  await op.started?.();
  await settled();
  return inner;
}

// ---- a wake's delivery into a DM ----------------------------------------------------------------------------------

test("a wake's post into a DM leaves a row a group turn cannot read", async () => {
  // Bug: the delivery's operation is written under the persona with `{ channel }`, and its intent holds the persona's words.
  const w = world();
  await wakePostInDm(w);
  assert.notEqual(secretRows(w.read(), 'day', internalContext()).length, 0);
  assert.deepEqual(secretRows(w.read(), 'day', w.contexts.group), []);
});

test("a wake's post into a DM stays out of the journal every wake reads", async () => {
  // Bug: the heartbeat's view and its `memory.journal.read` read the persona's journal.
  const w = world();
  const inner = await wakePostInDm(w);
  const lines = await inner.read({ day: DAY, n: 100 });
  assert.equal(JSON.stringify(lines).includes(SECRET), false);
});

test("a wake's said line in a DM stays out of a group's search", async () => {
  // Bug: `recordSaid` appends with no partner, so `personaRecord` files the line under a channel place of the DM's id.
  const w = world();
  const inner = personaRecord(wrongly(w.record), wrongly(w.store), () => [SERVER]);
  const line = toRecordLine(
    { id: 'said-wake', placeId: DM_CHAT, content: `the ${SECRET} plan`, ts: NOW - 60_000 },
    { kind: 'said', now: () => NOW }
  );
  await inner.append([line], {});
  await settled();
  assert.equal(searched(w, internalContext()).includes(SECRET), true);
  assert.equal(searched(w, w.contexts.group).includes(SECRET), false);
});

test("a wake's reading of the record over the top places yields no DM line", async () => {
  // Bug: the persona's iteration over every place reaches a DM, and its lines feed a wake that can post anywhere.
  const w = world();
  await w.record.append(DM, [lineSaid('m-dm')]);
  await settled();
  const inner = personaRecord(wrongly(w.record), wrongly(w.store), () => w.store.topPlaces());
  const seen: Array<unknown> = [];
  for await (const line of inner.iterate({})) seen.push(line);
  assert.equal(JSON.stringify(seen).includes(SECRET), false);
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
  // Bug: a fail-closed rule that hides the persona's posts in a real channel from the wakes that read them.
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
  // Bug: the seal reaches a real channel's line, and the group's history loses the persona's own posts.
  const { written, inner } = recorded();
  inner.append([{ scope: { channel: 'room' } }], {});
  assert.deepEqual(written, [['place:server', [{ scope: { channel: 'room' } }]]]);
});

test('the record is read from every place and a line goes to the place of its chat', async () => {
  // Bug: the inner life sees one server, or the persona's own line lands under no place anyone reads.
  const appended: Array<[string, unknown]> = [];
  const record = {
    async *iterate(placeId: string) {
      await Promise.resolve();
      yield { placeId };
    },
    append(placeId: string, lines: ReadonlyArray<unknown>) {
      appended.push([placeId, lines.length]);
    },
  };
  const source = personaRecord(record, { rootPlaceOf: (id) => (id === 'c1' ? 'top' : null) }, () => ['p1', 'p2']);
  const read: Array<unknown> = [];
  for await (const line of source.iterate?.({ from: '2026-01-01' }) ?? []) read.push(line);
  assert.deepEqual(read, [{ placeId: 'p1' }, { placeId: 'p2' }]);
  source.append?.([{ scope: { channel: 'c1' } }]);
  assert.deepEqual(appended, [['top', 1]]);
});

test("the persona's own journal lines go to the persona, and a cut-off turn is looked for in every place", async () => {
  // Bug: a restart looks for the turn in one server, and repeats what a DM's turn already did.
  const written: Array<unknown> = [];
  const journal = wrongly<Journal>({
    inner: (placeId: string) => written.push(placeId),
    turnOperations: (placeId: string) => Promise.resolve(placeId === 'p2' ? ['op'] : []),
  });
  const source = personaJournal(journal, () => ['p1', 'p2']);
  source.inner?.({ event: 'x' });
  assert.deepEqual(written, ['persona:local']);
  assert.deepEqual(await source.turnOperations?.({ turnId: 't', days: [], privateAccountId: null }), ['op']);
});

test('a cut-off private turn is looked for in the place of its direct message', async () => {
  // Bug: a DM's place is no server, so a restart found nothing of the DM turn it cut off and told the persona nothing it did.
  const journal = wrongly<Journal>({
    turnOperations: (placeId: string) => Promise.resolve(placeId === 'dm:u1' ? ['op'] : []),
  });
  const store = {
    placeOfChat: (chat: { partnerId?: string }) => `dm:${chat.partnerId}`,
  };
  const source = personaJournal(journal, () => ['p1'], store);
  assert.deepEqual(await source.turnOperations?.({ turnId: 't', days: [], privateAccountId: 'u1' }), ['op']);
  assert.deepEqual(await source.turnOperations?.({ turnId: 't', days: [], privateAccountId: null }), []);
});

// Stage T.5 of the master plan: `personaJournal.turnOperations` (src/behavior/inner/persona-sources.ts) looks for the
// operations of a cut-off DM turn in the DM's own place. A DM is keyed by its partner and the interface, so the query
// names the interface of the turn (`iface`, from the in-flight mark) and the place is resolved under it, not under the
// home interface. The store is a fake whose DM place depends on both; the journal answers only for the right place.

/** A store whose DM place is `<iface>:dm:<partner>`; an absent interface is the home interface, `discord`. */
const store = {
  placeOfChat: (chat: { kind?: string; partnerId?: string }, iface = 'discord') => `${iface}:dm:${chat.partnerId}`,
};

function journalHolding(place: string) {
  const asked: Array<string> = [];
  const journal = wrongly<Journal>({
    turnOperations: (placeId: string) => {
      asked.push(placeId);
      return Promise.resolve(placeId === place ? ['op'] : []);
    },
  });
  return { journal, asked };
}

test('a cut-off DM turn of the command line is looked for in the DM place of that interface', async () => {
  // Catches: the CLI turn is looked for under the home interface's DM place, so a restart finds nothing it did.
  const { journal } = journalHolding('cli:dm:owner');
  const source = personaJournal(journal, () => ['p1'], store);
  const found = await source.turnOperations?.({ turnId: 't', days: [], privateAccountId: 'owner', iface: 'cli' });
  assert.deepEqual(found, ['op']);
});

test('the home interface DM place is not searched for a turn of another interface', async () => {
  // Catches: the same partner id on two interfaces reads one DM's operations as the other's.
  const { journal, asked } = journalHolding('cli:dm:owner');
  const source = personaJournal(journal, () => ['p1'], store);
  await source.turnOperations?.({ turnId: 't', days: [], privateAccountId: 'owner', iface: 'cli' });
  assert.equal(asked.includes('discord:dm:owner'), false);
});

test('a turn with no interface in its mark is still looked for under the home interface', async () => {
  // Catches: a mark written before the interface was recorded stops being resolved at all.
  const { journal } = journalHolding('discord:dm:u1');
  const source = personaJournal(journal, () => ['p1'], store);
  assert.deepEqual(await source.turnOperations?.({ turnId: 't', days: [], privateAccountId: 'u1' }), ['op']);
});
