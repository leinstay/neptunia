// Who reacted to her messages, kept by the core (src/behavior/reactor-store.ts) from `reaction.changed` events and
// from the `message.reactors` read, and named on her lines in the history. The store is the one of the Discord package
// (interfaces/discord/reactors.js) over protocol events: `applyReactionChanged(store, event, { communityId, selfId })`.
// The last tests run the core over the fake interface and read the request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReactionChanged } from '../src/protocol/events.js';
import {
  applyReactionChanged,
  backfillPlan,
  createReactorStore,
  runBackfill,
  withReactors,
} from '../src/behavior/reactor-store.ts';
import { SELF, channelInfo, deliver, until, withFakeCore } from './fixtures/core-over-fake.ts';
import type { Fake } from './fixtures/core-over-fake.ts';

const served = { communityId: 'g1', selfId: 'self-id' };
const NOW = Date.now();

function reaction(extra: Partial<ReactionChanged> = {}): ReactionChanged {
  return {
    kind: 'reaction.changed',
    iface: 'fake',
    at: 1,
    id: 'fake:reaction:1',
    conversation: { id: 'c1', kind: 'channel', communityId: 'g1' },
    messageId: 'her1',
    emoji: { name: '😂' },
    userId: 'u1',
    added: true,
    authorId: 'self-id',
    ...extra,
  };
}

test('keeps each reactor of her message once, in the order they reacted', () => {
  const store = createReactorStore();
  assert.equal(applyReactionChanged(store, reaction({ userId: 'u2' }), served), 'applied');
  applyReactionChanged(store, reaction({ userId: 'u1' }), served);
  assert.equal(applyReactionChanged(store, reaction({ userId: 'u2' }), served), 'ignored');
  assert.deepEqual(store.reactors('her1', '😂'), ['u2', 'u1']);
});

test('takes one reactor back on a removal and every reactor of one emoji on a clear', () => {
  const store = createReactorStore();
  applyReactionChanged(store, reaction({ userId: 'u1' }), served);
  applyReactionChanged(store, reaction({ userId: 'u2' }), served);
  applyReactionChanged(store, reaction({ userId: 'u3', emoji: { name: '👍' } }), served);
  applyReactionChanged(store, reaction({ userId: 'u1', added: false }), served);
  assert.deepEqual(store.reactors('her1', '😂'), ['u2']);
  applyReactionChanged(store, reaction({ added: false, cleared: 'emoji', userId: null }), served);
  assert.equal(store.reactors('her1', '😂'), null);
  assert.deepEqual(store.reactors('her1', '👍'), ['u3']);
});

test('empties every emoji of the message on a clear of all', () => {
  const store = createReactorStore();
  applyReactionChanged(store, reaction({ userId: 'u1' }), served);
  applyReactionChanged(store, reaction({ userId: 'u3', emoji: { name: '👍' } }), served);
  applyReactionChanged(store, reaction({ added: false, cleared: 'all', userId: null, emoji: null }), served);
  assert.equal(store.reactors('her1', '😂'), null);
  assert.equal(store.reactors('her1', '👍'), null);
  assert.equal(store.isOwn('her1'), true);
});

test('names a custom emoji by its name between colons', () => {
  const store = createReactorStore();
  applyReactionChanged(store, reaction({ emoji: { id: '55', name: 'kek' } }), served);
  assert.deepEqual(store.reactors('her1', ':kek:'), ['u1']);
});

test('ignores her own reaction, a message of someone else and an event of another community', () => {
  const store = createReactorStore();
  assert.equal(applyReactionChanged(store, reaction({ userId: 'self-id' }), served), 'ignored');
  assert.equal(applyReactionChanged(store, reaction({ authorId: 'u5', messageId: 'theirs' }), served), 'ignored');
  const elsewhere = reaction({ conversation: { id: 'c9', kind: 'channel', communityId: 'g2' } });
  assert.equal(applyReactionChanged(store, elsewhere, served), 'ignored');
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

test('attaches the known reactors to the reactions of her lines by the names the resolver gives', () => {
  const store = createReactorStore();
  store.markOwn('her1');
  store.add('her1', '🔥', 'u1');
  const lines = [{ id: 'her1', self: true, reactions: [{ emoji: '🔥', count: 1, mine: false }] }];
  const named = withReactors(lines, store, (id) => (id === 'u1' ? { name: 'Dora', bot: false } : null));
  assert.deepEqual(named[0]?.reactions[0]?.users, [{ id: 'u1', name: 'Dora', bot: false }]);
});

const CONFIG = { context: { reactions: { maxMessages: 500, maxNames: 5, fetchUsers: 3, fetchTimeoutMs: 1000 } } };

function seedHerLine(fake: Fake): void {
  fake.seedConversation(channelInfo('c1', { name: 'general' }));
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
    authorId: SELF.id,
    reactions: [{ emoji: '🔥', count: 1, mine: false }],
  });
}

test('names a reactor she heard of through reaction.changed without reading the reactors again', async () => {
  await withFakeCore({ config: CONFIG, seed: seedHerLine }, async (rig) => {
    const heard = reaction({ messageId: 'her1', userId: 'u9', emoji: { name: '🔥' }, at: NOW - 30_000 });
    assert.equal(await rig.emit(heard), 'ok');
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'hello', at: NOW - 500, mention: true }));
    await until(() => rig.requests.length > 0);
    assert.equal(rig.requestText(0).includes('Dora'), true);
    assert.equal(
      rig.fake.calls.some((call) => call.op === 'reactors'),
      false
    );
  });
});

test('reads the reactors of her reaction through the adapter at most fetchUsers names, once, when no event told it', async () => {
  await withFakeCore({ config: CONFIG, seed: seedHerLine }, async (rig) => {
    rig.fake.seedReactors({ iface: 'fake', conversationId: 'c1', messageId: 'her1' }, '🔥', ['u9']);
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'hello', at: NOW - 500, mention: true }));
    await until(() => rig.requests.length > 0);
    const asked = rig.fake.calls.filter((call) => call.op === 'reactors');
    assert.deepEqual(
      asked.map((call) => call.args),
      [[{ iface: 'fake', conversationId: 'c1', messageId: 'her1' }, '🔥', 3]]
    );
    assert.equal(rig.requestText(0).includes('Dora'), true);
  });
});

test('still answers, leaving the names out, when the reactors read fails', async () => {
  await withFakeCore({ config: CONFIG, seed: seedHerLine }, async (rig) => {
    rig.fake.failNext('reactors', { status: 'failed', error: { code: 'http-500', retryable: true } });
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'hello', at: NOW - 500, mention: true }));
    await until(() => rig.posted('c1').length === 1);
    assert.equal(rig.requestText(0).includes('Dora'), false);
  });
});
