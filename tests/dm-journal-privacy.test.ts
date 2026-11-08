// What a direct message leaves in the journal, the record, the archive and the meaning index reaches its partner alone. A
// journal line of a DM names only its chat (`scope: { channel }`) and carries no private mark, so every reader
// that branched on the mark falls through to the channel rule or to none. Each test seeds one synthetic secret word through
// the writer a turn uses, over the real service and database, then reads as another reader: a group turn, another
// partner's private turn, the persona's own wake. Where the answer could be empty for want of a row, an internal context
// checks first that the row exists, so an empty answer means refused and never means unwritten. The last group asserts
// the converse: the partner's own private turn still reads their own lines.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createAdmin } from '../src/admin.ts';
import { personaJournal, personaRecord } from '../src/behavior/inner/persona-sources.ts';
import { createThinkStore } from '../src/behavior/previous-think.ts';
import { checkPull } from '../src/behavior/pull-fetch.ts';
import { createRecall } from '../src/behavior/recall-run.ts';
import { snapshotOf } from '../src/behavior/snapshot.ts';
import { createAppendStore } from '../src/memory/append-store.ts';
import { archiveEntry, createArchive } from '../src/memory/archive.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { search } from '../src/memory/db/recall.ts';
import { groupsContext, internalContext, scopeWhere } from '../src/memory/db/scope.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import type { MemoryDbService } from '../src/memory/db/service.ts';
import { PERSONA_ID } from '../src/memory/db/storage-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { createJournal } from '../src/memory/journal.ts';
import { createRecord, toRecordLine } from '../src/memory/record.ts';
import { createStore } from '../src/memory/store.ts';
import { createVectors } from '../src/memory/vectors.ts';
import { recordMessages } from '../src/tools/conversation-read.ts';
import '../src/tools/operations/index.ts';
import { labels } from './fixtures/labels.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { addAccount, addDmPlace, addGroupPlace } from './fixtures/memory-db/opaque-people.ts';
import { channel as channelInfo } from './fixtures/reads-rig.ts';
import { config as recallConfig } from './fixtures/recall-run-kit.ts';
import { tempDir } from './fixtures/tmp.ts';

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
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
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
  return { dataDir, memoryDb, read, journal, record, archive, vectors, store, contexts };
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

/** A DM turn's journal lines, as the turn runner writes them, under the place `place`. */
async function journalDmTurn(w: World, place = DM) {
  const started = w.journal.start(place, {
    placeId: DM_CHAT,
    mode: 'reply',
    participants: [PARTNER],
    sourceMessageIds: ['m-dm'],
    trigger: { kind: 'message', messageId: 'm-dm', authorId: PARTNER },
  });
  const op = w.journal.op(place, {
    placeId: DM_CHAT,
    turnId: started.turnId,
    name: 'post',
    by: 'persona',
    intent: { replyTo: null, text: `said ${SECRET} to the partner` },
  });
  await op.started();
  await op.succeeded({ messageId: 'said-1' });
  await w.journal.turn(place, {
    placeId: DM_CHAT,
    turnId: started.turnId,
    attemptId: started.attemptId,
    outcome: 'spoke',
    think: `they told me about the ${SECRET}`,
    posted: ['said-1'],
  });
  await w.journal.memory(place, {
    batchId: 'b1',
    note: 'batch',
    attitude: [{ accountId: PARTNER, delta: 1, applied: 1, reason: `shared the ${SECRET}` }],
  });
  await settled();
}

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

// ---- the journal of a DM ------------------------------------------------------------------------------------------

for (const table of ['day', 'sources', 'affinity_events']) {
  test(`a group turn reads nothing of a DM turn's journal from the ${table} rows`, async () => {
    // Bug: without the private mark `{ channel }` maps to a group scope, so her think in a DM opens to every group.
    const w = world();
    await journalDmTurn(w);
    assert.notEqual(secretRows(w.read(), table, internalContext()).length, 0);
    assert.deepEqual(secretRows(w.read(), table, w.contexts.group), []);
  });

  test(`another partner's private turn reads nothing of a DM turn's journal from the ${table} rows`, async () => {
    // Bug: a group-scoped line is open to every DM context too, because a group row is shown in a DM.
    const w = world();
    await journalDmTurn(w);
    assert.notEqual(secretRows(w.read(), table, internalContext()).length, 0);
    assert.deepEqual(secretRows(w.read(), table, w.contexts.other), []);
  });
}

test("a group's journal holds no line of a DM", async () => {
  // Bug: a turn whose place resolves to its root writes the DM's lines into the root's journal.
  const w = world();
  await journalDmTurn(w);
  const lines = await w.journal.read(GROUP, { day: DAY, n: 100 });
  assert.equal(JSON.stringify(lines).includes(SECRET), false);
});

test("the persona's journal holds no line of a DM turn", async () => {
  // Bug: a turn line under the persona is read by every wake, whoever the wake answers to.
  const w = world();
  await journalDmTurn(w);
  const lines = await w.journal.read(PERSONA_ID, { day: DAY, n: 100 });
  assert.equal(JSON.stringify(lines).includes(SECRET), false);
});

test('the turn that posted a DM message is not found from a group', async () => {
  // Bug: `memory.journal.read message:` from a group hands over the DM turn's think whole.
  const w = world();
  await journalDmTurn(w);
  const found = await w.journal.findTurn(GROUP, { messageId: 'said-1', at: NOW });
  assert.equal(found, null);
});

test('a DM journal line under another authority is out of reach of the partner with the same native id', async () => {
  // Bug: `scopeInto` spells the place from the native id, so two people with one native id share one audience.
  const w = world();
  await journalDmTurn(w, STRANGER_DM);
  assert.notEqual(secretRows(w.read(), 'sources', internalContext()).length, 0);
  assert.deepEqual(secretRows(w.read(), 'sources', w.contexts.partner), []);
});

// ---- a wake's delivery into a DM ----------------------------------------------------------------------------------

test("a wake's post into a DM leaves a row a group turn cannot read", async () => {
  // Bug: the delivery's operation is written under the persona with `{ channel }`, and its intent holds her words.
  const w = world();
  await wakePostInDm(w);
  assert.notEqual(secretRows(w.read(), 'day', internalContext()).length, 0);
  assert.deepEqual(secretRows(w.read(), 'day', w.contexts.group), []);
});

test("a wake's post into a DM stays out of the journal every wake reads", async () => {
  // Bug: the heartbeat and selfimprovement views and their `memory.journal.read` read the persona's journal.
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

// ---- the record, recall and the meaning index -----------------------------------------------------------------------

test("a group's search with quotes finds nothing of a DM", async () => {
  // Bug: a DM line scoped by its channel falls to the group rule of `whereFor`.
  const w = world();
  await w.record.append(DM, [lineSaid('m-dm')]);
  await settled();
  assert.equal(searched(w, internalContext()).includes(SECRET), true);
  assert.equal(searched(w, w.contexts.group).includes(SECRET), false);
});

test("another partner's search finds nothing of a DM", async () => {
  // Bug: widening a DM read by anything but the person shows a stranger's chat.
  const w = world();
  await w.record.append(DM, [lineSaid('m-dm')]);
  await settled();
  assert.equal(searched(w, w.contexts.other).includes(SECRET), false);
});

test('a partner under another authority finds nothing of the DM of the same native id', async () => {
  // Bug: the record mapper writes the audience of `discord:dm:<native>`, the home authority partner's own audience.
  const w = world();
  await w.record.append(STRANGER_DM, [lineSaid('m-dm')]);
  await settled();
  assert.equal(searched(w, internalContext()).includes(SECRET), true);
  assert.equal(searched(w, w.contexts.partner).includes(SECRET), false);
});

test("the diary's context finds nothing of a DM", async () => {
  // Bug: the diary's entry reads `none` and the groups, and a mislabelled DM line is a group line.
  const w = world();
  await w.record.append(DM, [lineSaid('m-dm')]);
  await settled();
  assert.equal(searched(w, groupsContext()).includes(SECRET), false);
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

test('a DM record line keeps the mark the meaning index and recall branch on', async () => {
  // Bug: `chunks.ts#layerOf` and `allowLine` read `scope.private`; a line written without it joins the place's layer.
  const w = world();
  await w.record.append(DM, [lineSaid('m-dm')]);
  await settled();
  const seen: Array<{ scope?: { private?: boolean; user?: string } }> = [];
  for await (const line of w.record.iterate(DM)) seen.push(wrongly(line));
  assert.deepEqual(
    seen.map((line) => [line.scope?.private, line.scope?.user]),
    [[true, PARTNER]]
  );
});

test("a DM's vector is out of a group's index and carries no group audience", async () => {
  // Bug: a vector row keeps the scope its month was written under, so a DM's chunk answers a group's question.
  const w = world();
  await w.record.append(DM, [lineSaid('m-dm')]);
  const unit = Float32Array.from([1, 0, 0, 0]);
  await w.vectors.append(
    DM,
    [
      {
        vector: unit,
        meta: {
          kind: 'record',
          id: 'm-dm',
          revision: 1,
          occurredAt: new Date(NOW - 60_000).toISOString(),
          placeId: DM_CHAT,
          by: PARTNER,
          participants: [PARTNER],
          sourceIds: ['m-dm'],
        },
      },
    ],
    { model: 'test-model' }
  );
  await settled();
  assert.deepEqual(await w.vectors.search(GROUP, unit, { k: 5 }), []);
  const own = await w.vectors.search(DM, unit, { k: 5 });
  assert.deepEqual(
    own.map((row) => wrongly<{ id: string }>(row.meta).id),
    ['m-dm']
  );
  const rows = w.read().prepare('SELECT audience_id FROM vectors WHERE retired_at IS NULL').all();
  assert.deepEqual(
    rows.map((row) => row.audience_id),
    [`aud:dm:${DM}`]
  );
});

// ---- the archive ----------------------------------------------------------------------------------------------------

/** One private episode evicted from the partner's store, through the real store and archive: its entry and its id. */
async function evictedPrivate(w: World, account = PARTNER_ACCOUNT) {
  const opts = { maxEpisodes: 1, maxNew: 3, now: NOW };
  w.store.addPrivateEpisodes(account, [{ date: '2026-10-01', what: `the ${SECRET} episode`, weight: 1 }], opts);
  const held = wrongly<{ episodes: Array<{ itemId: string }> }>(w.store.getPrivate(account)).episodes;
  const itemId = String(held[0]?.itemId);
  w.store.addPrivateEpisodes(account, [{ date: '2026-11-01', what: 'a later episode', weight: 3 }], opts);
  await w.store.settleArchive();
  return itemId;
}

function recaller(w: World) {
  const group = channelInfo('c1', { name: 'general', viewers: { [PARTNER]: true } });
  const snapshot = snapshotOf('g1', { chats: [group], groups: [] });
  const asked: Array<string> = [];
  const hot = {
    config: recallConfig({ llm: { analyzerTimeoutMs: 30000 }, recall: { archiveMonths: 6 } }),
    prompts: { 'recall-summary': 'You are {{name}}; {{answerChars}}.', labels },
  };
  const none = () => Promise.resolve(null);
  const recall = createRecall(
    wrongly({
      reads: { searchMessages: none, searchMembers: none, history: none },
      hot,
      store: { state: { data: {}, markDirty() {} }, listUserProfiles: () => [] },
      llm: {
        capLeft: () => 100,
        complete: (messages: Array<{ content: string }>) => {
          asked.push(messages.map((one) => one.content).join('\n'));
          return Promise.resolve({ text: 'stretch: 1\nsummary' });
        },
      },
      describer: null,
      now: () => NOW,
      archive: w.archive,
      record: w.record,
      vectors: null,
      embed: null,
    })
  );
  const dm = channelInfo(DM_CHAT, {
    kind: 'dm',
    rootId: null,
    chatType: 'dm',
    partnerId: PARTNER,
    audience: null,
  });
  const run = (over: Record<string, unknown>) =>
    recall.run(
      wrongly({
        snapshot,
        selfId: 'self',
        selfName: 'Persona',
        history: [],
        candidate: null,
        server: { forms: [SECRET], who: [], from: null, to: null },
        ...over,
      })
    );
  return { run, group, dm, asked };
}

function admin(w: World) {
  const hot = {
    config: { bot: { owners: ['42'] }, llm: { maxRequestsPerDay: 300 } },
    prompts: { labels: { locale: 'en-US' } },
    reloadConfig: () => true,
    reloadPrompts: () => true,
  };
  return createAdmin(wrongly({ hot, store: w.store, archive: w.archive, journal: w.journal, dataDir: w.dataDir }));
}

test("a group turn's recall reads no archived item of a DM", async () => {
  // Bug: an entry with neither `private` nor a channel passes `allowScope` unchecked.
  const w = world();
  await evictedPrivate(w);
  const r = recaller(w);
  await r.run({ placeId: GROUP, channel: r.group, partnerId: null });
  assert.equal(r.asked.join('\n').includes(SECRET), false);
});

test('a restored private item leaves its archive line under its DM, away from the persona', async () => {
  // Bug: `archiveHolderOf` reads `scope.user`, and a DM's item names `{ place, private }`, so its holder is the persona.
  const w = world();
  const itemId = await evictedPrivate(w);
  await admin(w).run('memory.restore', { itemId }, { placeId: DM });
  const seen: Array<unknown> = [];
  for await (const entry of w.archive.iterate(null)) seen.push(entry);
  assert.equal(JSON.stringify(seen).includes(SECRET), false);
});

test('the archive list of a group does not show a restored item of a DM', async () => {
  // Bug: a line filed under the persona with no `scope.user` passes `cmdMemoryArchive`'s member check in every place.
  const w = world();
  const itemId = await evictedPrivate(w);
  await admin(w).run('memory.restore', { itemId }, { placeId: DM });
  const listed: unknown = await admin(w).run('memory.archive.read', {}, { placeId: GROUP });
  assert.equal(JSON.stringify(listed).includes(SECRET), false);
});

test('the archive list of a group names no private item of a member who has no DM place yet', async () => {
  // Bug: the private item goes to the persona's archive as `{ user, private }`, and the list filters by `user` alone.
  const w = world();
  w.store.touchUser('discord:n9', 'Late', NOW);
  await evictedPrivate(w, 'discord:n9');
  const listed: unknown = await admin(w).run('memory.archive.read', { accountId: 'n9' }, { placeId: GROUP });
  assert.equal(JSON.stringify(listed).includes(SECRET), false);
});

test("a lesson taught in a DM is out of a group's reach", async () => {
  // Bug: the place mapper writes every lesson and in-joke `group`, whichever place holds them.
  const w = world();
  w.store.applyLearnedOps(DM, { add: [{ text: `the ${SECRET} lesson` }] }, { seenAt: NOW });
  w.store.flush();
  await settled();
  assert.notEqual(secretRows(w.read(), 'claims', internalContext()).length, 0);
  assert.deepEqual(secretRows(w.read(), 'claims', w.contexts.group), []);
});

// ---- the pull rail and conversation.read ----------------------------------------------------------------------------

const dmInfo = (id: string, partnerId: string) =>
  channelInfo(id, { kind: 'dm', rootId: null, chatType: 'dm', partnerId, audience: null });

test('the pull rail refuses a DM chat toward a group', () => {
  // Bug: a DM in the directory's snapshot passes the rail because the same-audience rule compares no audience.
  const group = channelInfo('c1', { name: 'general' });
  const snapshot = snapshotOf('g1', { chats: [group, dmInfo(DM_CHAT, PARTNER)], groups: [] });
  const verdict = checkPull({
    snapshot,
    placeId: DM_CHAT,
    destination: group,
    partnerId: null,
    config: recallConfig(),
    now: NOW,
  });
  assert.equal(verdict.skip, 'not-readable');
});

test("the pull rail refuses one partner's DM toward another partner's private turn", () => {
  // Bug: the rail's `viewers` is read on a source that has no root.
  const other = dmInfo('dm-other', OTHER);
  const snapshot = snapshotOf('g1', { chats: [dmInfo(DM_CHAT, PARTNER), other], groups: [] });
  const verdict = checkPull({
    snapshot,
    placeId: DM_CHAT,
    destination: other,
    partnerId: OTHER,
    config: recallConfig(),
    now: NOW,
  });
  assert.equal(verdict.skip, 'not-readable');
});

test("a record read of a group by a DM's chat id yields no line of that DM", async () => {
  // Bug: `recordMessages` carries no `allowLine` on `conversation.read`, so only its place keeps the DM out.
  const w = world();
  await w.record.append(DM, [lineSaid('m-dm')]);
  await settled();
  const lines = await recordMessages(wrongly(w.record), GROUP, { placeId: DM_CHAT, from: NOW - 3_600_000 });
  assert.equal(JSON.stringify(lines).includes(SECRET), false);
});

// ---- her previous think ---------------------------------------------------------------------------------------------

test('a think from a DM is not carried into a group it delivered to', () => {
  // Bug: a private turn's think tied to the place it posted into follows her into that group's next turn.
  const thinks = createThinkStore();
  thinks.record({
    turnId: 't1',
    at: NOW,
    think: `the ${SECRET} thought`,
    isDm: true,
    ran: DM,
    delivered: [GROUP],
  });
  const carried = thinks.select(GROUP, { now: NOW + 1000, minutes: 60, isDm: false });
  assert.equal(JSON.stringify(carried).includes(SECRET), false);
});

// ---- the partner's own turn -----------------------------------------------------------------------------------------

test("the partner's own journal reads their own lines", async () => {
  // Bug: a fix that drops DM lines from the place's journal takes the owner's view and the turn's own recovery with it.
  const w = world();
  await journalDmTurn(w);
  const lines = await w.journal.read(DM, { day: DAY, n: 100 });
  assert.equal(JSON.stringify(lines).includes(SECRET), true);
});

test("the partner's own context reads the rows of their own journal", async () => {
  // Bug: a fix that narrows the scope to `internal` closes the DM to its partner too.
  const w = world();
  await journalDmTurn(w);
  assert.notEqual(secretRows(w.read(), 'sources', w.contexts.partner).length, 0);
  assert.notEqual(secretRows(w.read(), 'day', w.contexts.partner).length, 0);
});

test("the partner's own search finds their own DM line", async () => {
  // Bug: the same narrowing, on the record.
  const w = world();
  await w.record.append(DM, [lineSaid('m-dm')]);
  await settled();
  assert.equal(searched(w, w.contexts.partner).includes(SECRET), true);
});

test('the partner of a DM place that spells nothing finds their own line', async () => {
  // Bug: the mapper writes `aud:dm:<iface>:dm:<native>` while the turn's context names the place it stands in.
  const w = world();
  await w.record.append(STRANGER_DM, [lineSaid('m-dm')]);
  await settled();
  assert.equal(searched(w, w.contexts.stranger).includes(SECRET), true);
});

test("the partner's own recall reads an item archived under their own id", async () => {
  // Bug: a fix that drops the member rule of `allowScope` loses the item a member with no DM place left behind.
  const w = world();
  const entry = archiveEntry(
    {
      itemId: 'ep-own',
      date: '2026-11-01',
      what: `the ${SECRET} episode`,
      weight: 3,
      addedAt: '2026-11-01T00:00:00.000Z',
    },
    { itemKind: 'episode', event: 'evicted', scope: { user: PARTNER, private: true }, now: () => NOW }
  );
  await w.archive.append(DM, [entry]);
  const r = recaller(w);
  await r.run({ placeId: DM, channel: r.dm, partnerId: PARTNER });
  assert.equal(r.asked.join('\n').includes(SECRET), true);
});

test("the partner's own recall reads an item archived from their DM", async () => {
  // Bug: `allowScope` asks `scope.user === privateAccountId`, and a DM's archived item names `{ place, private }` with no user.
  const w = world();
  await evictedPrivate(w);
  const r = recaller(w);
  await r.run({ placeId: DM, channel: r.dm, partnerId: PARTNER });
  assert.equal(r.asked.join('\n').includes(SECRET), true);
});
