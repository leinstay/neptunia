// Tests for src/behavior/reactor-store.ts: who reacted to the persona's own messages, fed by `reaction.changed` events,
// the backfill and the reactors of a line. Fakes only: no Discord, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyReactionChanged,
  backfillPlan,
  createReactorStore,
  runBackfill,
  withReactors,
} from '../../../src/behavior/reactor-store.ts';
import { reactorIdsOf } from '../../../src/format.ts';
import type { ReactionChanged } from '../../../src/protocol/events.ts';
import {
  SELF as REACTORS_CORE_SELF,
  channelInfo,
  deliver,
  until,
  withFakeCore,
} from '../../fixtures/core-over-fake.ts';
import type { Fake } from '../../fixtures/core-over-fake.ts';

const SELF = '100';
const ROOT = '900';
const served = { isServed: (placeId: string) => placeId === ROOT, selfId: SELF };

/**
 * A `reaction.changed` event of chat `c1`: `kind` add, remove, removeEmoji or removeAll; `authorId` is the author
 * of the message when the interface knows it.
 */
function reactionEvent(
  kind: string,
  {
    messageId = 'm1',
    authorId = SELF,
    emoji = { name: '😂' },
    accountId = '2',
    rootId = ROOT,
  }: {
    messageId?: string;
    authorId?: string | null;
    emoji?: { name: string };
    accountId?: string;
    rootId?: string | null;
  } = {}
) {
  return {
    kind: 'reaction.changed' as const,
    iface: 'fake',
    at: 1,
    id: `fake:reaction:${kind}:${messageId}`,
    chat: { id: 'c1', kind: 'channel' as const, rootId },
    messageId,
    emoji: kind === 'removeAll' ? null : emoji,
    accountId: kind === 'removeEmoji' || kind === 'removeAll' ? null : accountId,
    added: kind === 'add',
    authorId,
    ...(kind === 'removeEmoji'
      ? { cleared: 'emoji' as const }
      : kind === 'removeAll'
        ? { cleared: 'all' as const }
        : {}),
  };
}

/** Apply one event of the served root. */
function feed(
  store: ReturnType<typeof createReactorStore>,
  kind: string,
  parts: Parameters<typeof reactionEvent>[1] = {},
  where: { isServed: (placeId: string) => boolean; selfId: string } = served
) {
  return applyReactionChanged(store, reactionEvent(kind, parts), where);
}

// --- the store through reaction.changed events ---------------------------------

test("reactors store: an add on the persona's message is kept in order, each user once", () => {
  const store = createReactorStore();
  assert.equal(feed(store, 'add', { accountId: '2' }), 'applied');
  feed(store, 'add', { accountId: '1' });
  assert.equal(feed(store, 'add', { accountId: '2' }), 'ignored');
  assert.deepEqual(store.reactors('m1', '😂'), ['2', '1']);
});

// An emoji and a sticker go by a stable name of the engine.
test('reactors store: remove takes one user back, removeEmoji one emoji, removeAll every emoji', () => {
  const store = createReactorStore();
  for (const [emoji, user] of [
    ['😂', '1'],
    ['😂', '2'],
    ['👍', '3'],
    ['<emoji:77>', '4'],
  ]) {
    const parsed = emoji.startsWith('<emoji:') ? { id: '77', name: 'kek' } : { name: emoji };
    feed(store, 'add', { emoji: parsed, accountId: user });
  }
  feed(store, 'remove', { emoji: { name: '😂' }, accountId: '1' });
  assert.deepEqual(store.reactors('m1', '😂'), ['2']);
  feed(store, 'removeEmoji', { emoji: { name: '👍' } });
  assert.equal(store.reactors('m1', '👍'), null);
  assert.deepEqual(store.reactors('m1', '<emoji:77>'), ['4']);
  feed(store, 'removeAll');
  assert.equal(store.reactors('m1', '😂'), null);
  assert.equal(store.reactors('m1', '<emoji:77>'), null);
  assert.equal(store.isOwn('m1'), true, "the message stays the persona's");
});

test("reactors store: the persona's own reaction is never a reactor", () => {
  const store = createReactorStore();
  assert.equal(feed(store, 'add', { accountId: SELF }), 'ignored');
  assert.equal(store.reactors('m1', '😂'), null);
});

test('reactors store: another root, another author and an unknown author are ignored', () => {
  const store = createReactorStore();
  assert.equal(feed(store, 'add', { rootId: '901' }), 'ignored');
  assert.equal(feed(store, 'add', { messageId: 'm2', authorId: '5' }), 'ignored');
  assert.equal(feed(store, 'add', { messageId: 'm3', authorId: null }), 'ignored');
  assert.deepEqual(store.counts(), { messages: 0, reactors: 0 });
  // Not served yet (no root resolved): nothing.
  assert.equal(feed(store, 'add', { messageId: 'm4' }, { isServed: () => false, selfId: SELF }), 'ignored');
});

test("reactors store: a message already known as the persona's takes live events whose author is unknown", () => {
  const store = createReactorStore();
  store.markOwn('m3');
  assert.equal(feed(store, 'add', { messageId: 'm3', authorId: null, emoji: { name: '🙂' } }), 'applied');
  assert.deepEqual(store.reactors('m3', '🙂'), ['2']);
});

test('reactors store: bounded by maxMessages read at each insertion, the oldest message evicted', () => {
  let max = 3;
  const store = createReactorStore({ maxMessages: () => max });
  for (const id of ['1005', '1001', '1003']) store.markOwn(id);
  store.add('1001', '😂', '2');
  store.markOwn('1009');
  assert.equal(store.isOwn('1001'), false, 'the oldest snowflake goes first');
  assert.deepEqual(
    ['1003', '1005', '1009'].map((id) => store.isOwn(id)),
    [true, true, true]
  );
  max = 2;
  store.markOwn('1010');
  assert.deepEqual(store.counts().messages, 2);
  assert.equal(store.isOwn('1009'), true);
  assert.equal(store.isOwn('1010'), true);
});

// --- the backfill decision -----------------------------------------------------

/** A normalized line. */
function line(
  id: string,
  {
    self = true,
    reactions = [],
    authorId = self ? SELF : '7',
    authorName = self ? 'Persona' : 'Zoé',
    bot = false,
  }: {
    self?: boolean;
    reactions?: Array<{ emoji: string; count: number; mine: boolean; users?: Array<unknown> }>;
    authorId?: string;
    authorName?: string;
    bot?: boolean;
  } = {}
) {
  return { id, placeId: 'c1', authorId, authorName, self, bot, content: 'text', ts: 1_000 + Number(id), reactions };
}

test("backfillPlan: only the persona's lines, only reactions by others the store lacks, once per message and emoji", () => {
  const store = createReactorStore();
  store.markOwn('2');
  store.add('2', '👍', '8');
  const lines = [
    line('1', { self: false, reactions: [{ emoji: '😂', count: 2, mine: false }] }),
    line('2', {
      reactions: [
        { emoji: '👍', count: 1, mine: false },
        { emoji: '😂', count: 3, mine: false },
      ],
    }),
    line('3', {
      reactions: [
        { emoji: '🙂', count: 1, mine: true },
        { emoji: '🔥', count: 2, mine: true },
      ],
    }),
    line('4'),
  ];
  const plan = backfillPlan(lines, store);
  assert.deepEqual(plan, [
    { messageId: '2', emoji: '😂' },
    { messageId: '3', emoji: '🔥' },
  ]);
  assert.equal(store.isOwn('4'), true, "every line of the persona's is kept for later events");
  assert.equal(store.isOwn('1'), false);
  for (const item of plan) store.markAttempted(item.messageId, item.emoji);
  assert.deepEqual(backfillPlan(lines, store), [], 'never asked twice');
});

test('backfillPlan: a reaction whose known reactors fall short of its count is asked again', () => {
  const store = createReactorStore();
  store.markOwn('2');
  store.add('2', '😂', '8');
  assert.deepEqual(backfillPlan([line('2', { reactions: [{ emoji: '😂', count: 3, mine: false }] })], store), [
    { messageId: '2', emoji: '😂' },
  ]);
});

test("runBackfill: fetches one at a time into the store, the persona's own id dropped, failures counted", async () => {
  const store = createReactorStore();
  store.markOwn('2');
  store.add('2', '😂', '9');
  const asked: Array<string> = [];
  const stats = await runBackfill(
    [
      { messageId: '2', emoji: '😂' },
      { messageId: '2', emoji: '👍' },
    ],
    store,
    async (item) => {
      asked.push(item.emoji);
      if (item.emoji === '👍') throw new Error('gone');
      return ['5', SELF, '6'];
    },
    { budgetMs: 1000, selfId: SELF, wait: () => new Promise(() => {}) }
  );
  assert.deepEqual(asked, ['😂', '👍']);
  assert.deepEqual(stats, { planned: 2, fetched: 1, failed: 1, timedOut: false });
  assert.deepEqual(store.reactors('2', '😂'), ['5', '6', '9'], 'fetched order first, a live one kept');
  assert.equal(store.attempted('2', '👍'), true);
});

test('runBackfill: the budget is respected, a late fetch still lands in the store', async () => {
  const store = createReactorStore();
  store.markOwn('2');
  let release: ((value?: unknown) => void) | undefined;
  const gate = new Promise((resolve) => (release = resolve));
  let waited = null;
  const stats = await runBackfill([{ messageId: '2', emoji: '😂' }], store, () => gate.then(() => ['5']), {
    budgetMs: 2000,
    wait: (ms: number) => {
      waited = ms;
      return Promise.resolve();
    },
  });
  assert.equal(waited, 2000);
  assert.equal(stats.timedOut, true);
  assert.equal(stats.fetched, 0);
  assert.equal(store.reactors('2', '😂'), null);
  release!();
  await gate;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(store.reactors('2', '😂'), ['5']);
});

test('runBackfill: an empty plan asks nothing and waits for nothing', async () => {
  const stats = await runBackfill([], createReactorStore(), () => assert.fail('no fetch'), {
    wait: () => assert.fail('no wait'),
  });
  assert.deepEqual(stats, { planned: 0, fetched: 0, failed: 0, timedOut: false });
});

// --- withReactors / reactorIdsOf ------------------------------------------------

// A bot is a person to the persona, so a bot that reacted gets a handle like a member.
test("withReactors: the persona's reactions carry the known reactors resolved to names, unknown ones left out", () => {
  const store = createReactorStore();
  store.markOwn('2');
  store.markOwn('1');
  store.set('2', '😂', ['5', '6', '404']);
  store.set('1', '😂', ['5']);
  const users: Record<string, { name: string; bot?: boolean }> = {
    5: { name: 'Zoé' },
    6: { name: 'Helper', bot: true },
  };
  const lines = [
    line('1', { self: false, reactions: [{ emoji: '😂', count: 1, mine: false }] }),
    line('2', {
      reactions: [
        { emoji: '😂', count: 3, mine: false },
        { emoji: '👍', count: 1, mine: false },
      ],
    }),
  ];
  const out = withReactors(lines, store, (id) => users[id] ?? null);
  assert.equal(out[0], lines[0], "someone else's line is untouched");
  const [laughs, thumbs] = out[1].reactions;
  assert.deepEqual(laughs.users, [
    { id: '5', name: 'Zoé', bot: false },
    { id: '6', name: 'Helper', bot: true },
  ]);
  assert.equal(thumbs.users, undefined);
  const [given] = lines[1].reactions;
  assert.equal(given.users, undefined, 'the input is not mutated');
  assert.deepEqual(reactorIdsOf(out), ['5', '6'], 'a bot gets a handle too');
});

const reactorsCoreServed = { isServed: (placeId: string) => placeId === 'g1', selfId: 'self-id' };

const NOW = Date.now();

function reaction(extra: Partial<ReactionChanged> = {}): ReactionChanged {
  return {
    kind: 'reaction.changed',
    iface: 'fake',
    at: 1,
    id: 'fake:reaction:1',
    chat: { id: 'c1', kind: 'channel', rootId: 'g1' },
    messageId: 'her1',
    emoji: { name: '😂' },
    accountId: 'u1',
    added: true,
    authorId: 'self-id',
    ...extra,
  };
}

test("keeps each reactor of the persona's message once, in the order they reacted", () => {
  const store = createReactorStore();
  assert.equal(applyReactionChanged(store, reaction({ accountId: 'u2' }), reactorsCoreServed), 'applied');
  applyReactionChanged(store, reaction({ accountId: 'u1' }), reactorsCoreServed);
  assert.equal(applyReactionChanged(store, reaction({ accountId: 'u2' }), reactorsCoreServed), 'ignored');
  assert.deepEqual(store.reactors('her1', '😂'), ['u2', 'u1']);
});

test('takes one reactor back on a removal and every reactor of one emoji on a clear', () => {
  const store = createReactorStore();
  applyReactionChanged(store, reaction({ accountId: 'u1' }), reactorsCoreServed);
  applyReactionChanged(store, reaction({ accountId: 'u2' }), reactorsCoreServed);
  applyReactionChanged(store, reaction({ accountId: 'u3', emoji: { name: '👍' } }), reactorsCoreServed);
  applyReactionChanged(store, reaction({ accountId: 'u1', added: false }), reactorsCoreServed);
  assert.deepEqual(store.reactors('her1', '😂'), ['u2']);
  applyReactionChanged(store, reaction({ added: false, cleared: 'emoji', accountId: null }), reactorsCoreServed);
  assert.equal(store.reactors('her1', '😂'), null);
  assert.deepEqual(store.reactors('her1', '👍'), ['u3']);
});

test('empties every emoji of the message on a clear of all', () => {
  const store = createReactorStore();
  applyReactionChanged(store, reaction({ accountId: 'u1' }), reactorsCoreServed);
  applyReactionChanged(store, reaction({ accountId: 'u3', emoji: { name: '👍' } }), reactorsCoreServed);
  applyReactionChanged(
    store,
    reaction({ added: false, cleared: 'all', accountId: null, emoji: null }),
    reactorsCoreServed
  );
  assert.equal(store.reactors('her1', '😂'), null);
  assert.equal(store.reactors('her1', '👍'), null);
  assert.equal(store.isOwn('her1'), true);
});

// An emoji and a sticker go by a stable name of the engine.
test('keys a custom emoji by its protocol token', () => {
  const store = createReactorStore();
  applyReactionChanged(store, reaction({ emoji: { id: '55', name: 'kek' } }), reactorsCoreServed);
  assert.deepEqual(store.reactors('her1', '<emoji:55>'), ['u1']);
});

test("ignores the persona's own reaction, a message of someone else and an event of another root", () => {
  const store = createReactorStore();
  assert.equal(applyReactionChanged(store, reaction({ accountId: 'self-id' }), reactorsCoreServed), 'ignored');
  assert.equal(
    applyReactionChanged(store, reaction({ authorId: 'u5', messageId: 'theirs' }), reactorsCoreServed),
    'ignored'
  );
  const elsewhere = reaction({ chat: { id: 'c9', kind: 'channel', rootId: 'g2' } });
  assert.equal(applyReactionChanged(store, elsewhere, reactorsCoreServed), 'ignored');
  assert.deepEqual(store.counts(), { messages: 0, reactors: 0 });
});

test('stops waiting for a backfill at the budget and keeps what it fetches afterwards', async () => {
  const store = createReactorStore();
  store.markOwn('her1');
  let release: () => void = () => {};
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = await runBackfill(
    [{ messageId: 'her1', emoji: '🔥' }],
    store,
    async () => {
      await slow;
      return ['u1'];
    },
    { budgetMs: 50, selfId: 'self-id', wait: () => Promise.resolve() }
  );
  assert.equal(result.timedOut, true);
  assert.equal(store.reactors('her1', '🔥'), null);
  release();
  await until(() => store.reactors('her1', '🔥') !== null);
  assert.deepEqual(store.reactors('her1', '🔥'), ['u1']);
});

test('plans a fetch only for reactions the store knows fewer reactors of than the count says', () => {
  const store = createReactorStore();
  const line = { id: 'her1', self: true, reactions: [{ emoji: '🔥', count: 2, mine: false }] };
  assert.deepEqual(backfillPlan([line], store), [{ messageId: 'her1', emoji: '🔥' }]);
  store.add('her1', '🔥', 'u1');
  store.add('her1', '🔥', 'u2');
  assert.deepEqual(backfillPlan([line], store), []);
});

test("attaches the known reactors to the reactions of the persona's lines by the names the resolver gives", () => {
  const store = createReactorStore();
  store.markOwn('her1');
  store.add('her1', '🔥', 'u1');
  const lines = [{ id: 'her1', self: true, reactions: [{ emoji: '🔥', count: 1, mine: false }] }];
  const named = withReactors(lines, store, (id) => (id === 'u1' ? { name: 'Dora', bot: false } : null));
  const reactions = named[0]?.reactions;
  assert.deepEqual(reactions?.[0]?.users, [{ id: 'u1', name: 'Dora', bot: false }]);
});

const CONFIG = { context: { reactions: { maxMessages: 500, maxNames: 5, fetchUsers: 3, fetchTimeoutMs: 1000 } } };

/** A request's text as `requestText` gives it (its messages as JSON) with its line breaks back. */
const plainOf = (text: string): string => text.replaceAll('\\n', '\n');

/** The request line of the persona's line `a thing she said`. */
const personaLine = (text: string): string =>
  plainOf(text)
    .split('\n')
    .find((one) => one.includes('a thing she said')) ?? '';

/** The `@u…` handles named at the reaction of the persona's line `a thing she said` in a request's text. */
function reactorHandles(text: string): Array<string> {
  const line = personaLine(text);
  return line.slice(line.indexOf('a thing she said')).match(/@u[0-9a-z]+/g) ?? [];
}

/** The `@u…` handles that open an entry of every `<people>` of a request's text. */
function entryHandles(text: string): Array<string> {
  const bodies = [...plainOf(text).matchAll(/<people>\n?([\s\S]*?)\n?<\/people>/g)].map((match) => match[1] ?? '');
  return bodies.flatMap((body) =>
    body.split(/\n\s*\n/).flatMap((entry) => /@u[0-9a-z]+/.exec(entry.split('\n')[0] ?? '')?.[0] ?? [])
  );
}

/**
 * A reaction names its reactor by a handle, never by the display name, and that handle opens an entry of `<people>`
 * (one handle per person, and everyone whose handle stands in a line has an entry).
 */
function assertReactorShown(text: string): void {
  const [reactor] = reactorHandles(text);
  assert.match(reactor ?? '', /^@u[0-9a-z]+$/, text);
  assert.equal(entryHandles(text).includes(reactor ?? ''), true, text);
  const line = personaLine(text);
  assert.equal(line.includes('Dora'), false, line);
}

function seedPersonaLine(fake: Fake): void {
  fake.seedChat(channelInfo('c1', { name: 'general' }));
  fake.seedMember('g1', {
    id: 'u9',
    name: 'Dora',
    bot: false,
    groupIds: [],
    avatar: { hash: null, url: null, largeUrl: null },
  });
  deliver(fake, {
    id: 'her1',
    text: 'a thing she said',
    at: NOW - 60_000,
    authorId: REACTORS_CORE_SELF.id,
    reactions: [{ emoji: '🔥', count: 1, mine: false }],
  });
}

test('names a reactor the persona heard of through reaction.changed without reading the reactors again', async () => {
  await withFakeCore({ config: CONFIG, seed: seedPersonaLine }, async (rig) => {
    const heard = reaction({ messageId: 'her1', accountId: 'u9', emoji: { name: '🔥' }, at: NOW - 30_000 });
    assert.equal(await rig.emit(heard), 'ok');
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'hello', at: NOW - 500, mention: true }));
    await until(() => rig.requests.length > 0);
    assertReactorShown(rig.requestText(0));
    const calls = rig.fake.calls;
    assert.equal(
      calls.some((call) => call.op === 'reactors'),
      false
    );
  });
});

test("reads the reactors of a reaction on the persona's line through the adapter at most fetchUsers names, once, when no event told it", async () => {
  await withFakeCore({ config: CONFIG, seed: seedPersonaLine }, async (rig) => {
    rig.fake.seedReactors({ iface: 'fake', chatId: 'c1', messageId: 'her1' }, '🔥', ['u9']);
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'hello', at: NOW - 500, mention: true }));
    await until(() => rig.requests.length > 0);
    const calls = rig.fake.calls;
    const asked = calls.filter((call) => call.op === 'reactors');
    assert.deepEqual(
      asked.map((call) => call.args),
      // PR 7d: context.reactions.fetchUsers is the constant 10.
      [[{ iface: 'fake', chatId: 'c1', messageId: 'her1' }, '🔥', 10]]
    );
    assertReactorShown(rig.requestText(0));
  });
});

test('still answers, leaving the names out, when the reactors read fails', async () => {
  await withFakeCore({ config: CONFIG, seed: seedPersonaLine }, async (rig) => {
    rig.fake.failNext('reactors', { status: 'failed', error: { code: 'http-500', retryable: true } });
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'hello', at: NOW - 500, mention: true }));
    await until(() => rig.posted('c1').length === 1);
    // A reactor is named by handle, so a reactor nobody read names no handle.
    assert.deepEqual(reactorHandles(rig.requestText(0)), []);
  });
});

test('keeps the reactions of every place an interface serves, not only of the first', () => {
  // Bug: a reaction in the second server is dropped because the first one is the only one read.
  const store = createReactorStore();
  store.markOwn('her1');
  const both = { isServed: (placeId: string) => placeId === 'g1' || placeId === 'g2', selfId: 'self-id' };
  const there = reaction({ chat: { id: 'c9', kind: 'channel', rootId: 'g2' }, accountId: 'u7' });
  assert.equal(applyReactionChanged(store, there, both), 'applied');
});
