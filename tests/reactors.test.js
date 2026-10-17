// Tests for src/discord/reactors.js (who reacted to the persona's own messages), its use in
// src/discord/collect.js#fetchHistory (the backfill and the names) and the rendering of those
// names in src/format.js#formatTranscript. Fakes only: no Discord, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyReactionEvent,
  backfillPlan,
  createReactorStore,
  reactionEventOf,
  reactionKey,
  reactorIdsOf,
  runBackfill,
  withReactors,
} from '../src/discord/reactors.js';
import { fetchHistory, fetchMessage } from '../src/discord/collect.js';
import { formatTranscript } from '../src/format.js';
import { buildRequest } from '../src/behavior/prompt.js';
import { labels as fixtureLabels } from './fixtures/labels.js';

const SELF = '100';
const GUILD = '900';
const served = { guildId: GUILD, selfId: SELF };

/** A discord.js-shaped reaction on message `message` with emoji `emoji` (`{ id, name }`). */
function rawReaction(message, emoji, extra = {}) {
  return { message, emoji, ...extra };
}

/** A discord.js-shaped message of the served guild: whole by default, by `authorId`. */
function rawMsg(id, authorId = SELF, extra = {}) {
  return { id, guildId: GUILD, partial: false, author: { id: authorId }, ...extra };
}

/** Apply one event built from discord.js-shaped parts. */
function feed(store, kind, parts, where = served) {
  return applyReactionEvent(store, reactionEventOf(kind, parts), where);
}

// --- reactionKey ---------------------------------------------------------------

test('reactionKey: a unicode emoji reads as itself, a custom one as :name:, none without a name', () => {
  assert.equal(reactionKey({ id: null, name: '🔥' }), '🔥');
  assert.equal(reactionKey({ id: '55', name: 'kek' }), ':kek:');
  assert.equal(reactionKey({ id: '55', name: null }), null);
  assert.equal(reactionKey(null), null);
});

// --- the store through gateway events -----------------------------------------

test('reactors store: an add on her message is kept in order, each user once', () => {
  const store = createReactorStore();
  const message = rawMsg('m1');
  assert.equal(feed(store, 'add', { reaction: rawReaction(message, { name: '😂' }), user: { id: '2' } }), 'applied');
  feed(store, 'add', { reaction: rawReaction(message, { name: '😂' }), user: { id: '1' } });
  assert.equal(feed(store, 'add', { reaction: rawReaction(message, { name: '😂' }), user: { id: '2' } }), 'ignored');
  assert.deepEqual(store.reactors('m1', '😂'), ['2', '1']);
});

test('reactors store: remove takes one user back, removeEmoji one emoji, removeAll every emoji', () => {
  const store = createReactorStore();
  const message = rawMsg('m1');
  for (const [emoji, user] of [['😂', '1'], ['😂', '2'], ['👍', '3'], [':kek:', '4']]) {
    const parsed = emoji.startsWith(':') ? { id: '77', name: 'kek' } : { name: emoji };
    feed(store, 'add', { reaction: rawReaction(message, parsed), user: { id: user } });
  }
  feed(store, 'remove', { reaction: rawReaction(message, { name: '😂' }), user: { id: '1' } });
  assert.deepEqual(store.reactors('m1', '😂'), ['2']);
  feed(store, 'removeEmoji', { reaction: rawReaction(message, { name: '👍' }) });
  assert.equal(store.reactors('m1', '👍'), null);
  assert.deepEqual(store.reactors('m1', ':kek:'), ['4']);
  feed(store, 'removeAll', { message });
  assert.equal(store.reactors('m1', '😂'), null);
  assert.equal(store.reactors('m1', ':kek:'), null);
  assert.equal(store.isOwn('m1'), true, 'the message stays hers');
});

test('reactors store: her own reaction is never a reactor', () => {
  const store = createReactorStore();
  const message = rawMsg('m1');
  assert.equal(feed(store, 'add', { reaction: rawReaction(message, { name: '😂' }), user: { id: SELF } }), 'ignored');
  assert.equal(store.reactors('m1', '😂'), null);
});

test('reactors store: another guild, another author and an unknown partial message are ignored', () => {
  const store = createReactorStore();
  const elsewhere = rawMsg('m1', SELF, { guildId: '901' });
  assert.equal(feed(store, 'add', { reaction: rawReaction(elsewhere, { name: '😂' }), user: { id: '2' } }), 'ignored');
  const theirs = rawMsg('m2', '5');
  assert.equal(feed(store, 'add', { reaction: rawReaction(theirs, { name: '😂' }), user: { id: '2' } }), 'ignored');
  const partial = { id: 'm3', guildId: GUILD, partial: true, author: null };
  assert.equal(feed(store, 'add', { reaction: rawReaction(partial, { name: '😂' }), user: { id: '2' } }), 'ignored');
  assert.deepEqual(store.counts(), { messages: 0, reactors: 0 });
  // Not served yet (no guild resolved): nothing.
  assert.equal(feed(store, 'add', { reaction: rawReaction(rawMsg('m4'), { name: '😂' }), user: { id: '2' } }, { guildId: null, selfId: SELF }), 'ignored');
});

test('reactors store: a partial message already known as hers takes live events', () => {
  const store = createReactorStore();
  store.markOwn('m3');
  const partial = { id: 'm3', guildId: GUILD, partial: true, author: null };
  assert.equal(feed(store, 'add', { reaction: rawReaction(partial, { name: '🙂' }), user: { id: '2' } }), 'applied');
  assert.deepEqual(store.reactors('m3', '🙂'), ['2']);
});

test('reactors store: an emoji getter that throws leaves the event without an emoji, never fatal', () => {
  const store = createReactorStore();
  const reaction = {
    message: rawMsg('m1'),
    get emoji() {
      throw new Error('no emoji cache');
    },
  };
  assert.equal(feed(store, 'add', { reaction, user: { id: '2' } }), 'ignored');
});

test('reactors store: bounded by maxMessages read at each insertion, the oldest message evicted', () => {
  let max = 3;
  const store = createReactorStore({ maxMessages: () => max });
  for (const id of ['1005', '1001', '1003']) store.markOwn(id);
  store.add('1001', '😂', '2');
  store.markOwn('1009');
  assert.equal(store.isOwn('1001'), false, 'the oldest snowflake goes first');
  assert.deepEqual(['1003', '1005', '1009'].map((id) => store.isOwn(id)), [true, true, true]);
  max = 2;
  store.markOwn('1010');
  assert.deepEqual(store.counts().messages, 2);
  assert.equal(store.isOwn('1009'), true);
  assert.equal(store.isOwn('1010'), true);
});

// --- the backfill decision -----------------------------------------------------

/** A normalized line. */
function line(id, { self = true, reactions = [], authorId = self ? SELF : '7', authorName = self ? 'Persona' : 'Zoé', bot = false } = {}) {
  return { id, channelId: 'c1', authorId, authorName, self, bot, content: 'text', ts: 1_000 + Number(id), reactions };
}

test('backfillPlan: only her lines, only reactions by others the store lacks, once per message and emoji', () => {
  const store = createReactorStore();
  store.markOwn('2');
  store.add('2', '👍', '8');
  const lines = [
    line('1', { self: false, reactions: [{ emoji: '😂', count: 2, mine: false }] }),
    line('2', { reactions: [{ emoji: '👍', count: 1, mine: false }, { emoji: '😂', count: 3, mine: false }] }),
    line('3', { reactions: [{ emoji: '🙂', count: 1, mine: true }, { emoji: '🔥', count: 2, mine: true }] }),
    line('4'),
  ];
  const plan = backfillPlan(lines, store);
  assert.deepEqual(plan, [
    { messageId: '2', emoji: '😂' },
    { messageId: '3', emoji: '🔥' },
  ]);
  assert.equal(store.isOwn('4'), true, 'every line of hers is kept for later events');
  assert.equal(store.isOwn('1'), false);
  for (const item of plan) store.markAttempted(item.messageId, item.emoji);
  assert.deepEqual(backfillPlan(lines, store), [], 'never asked twice');
});

test('backfillPlan: a reaction whose known reactors fall short of its count is asked again', () => {
  const store = createReactorStore();
  store.markOwn('2');
  store.add('2', '😂', '8');
  assert.deepEqual(backfillPlan([line('2', { reactions: [{ emoji: '😂', count: 3, mine: false }] })], store), [{ messageId: '2', emoji: '😂' }]);
});

test('runBackfill: fetches one at a time into the store, her own id dropped, failures counted', async () => {
  const store = createReactorStore();
  store.markOwn('2');
  store.add('2', '😂', '9');
  const asked = [];
  const stats = await runBackfill(
    [{ messageId: '2', emoji: '😂' }, { messageId: '2', emoji: '👍' }],
    store,
    async (item) => {
      asked.push(item.emoji);
      if (item.emoji === '👍') throw new Error('gone');
      return ['5', SELF, '6'];
    },
    { budgetMs: 1000, selfId: SELF, wait: () => new Promise(() => {}) },
  );
  assert.deepEqual(asked, ['😂', '👍']);
  assert.deepEqual(stats, { planned: 2, fetched: 1, failed: 1, timedOut: false });
  assert.deepEqual(store.reactors('2', '😂'), ['5', '6', '9'], 'fetched order first, a live one kept');
  assert.equal(store.attempted('2', '👍'), true);
});

test('runBackfill: the budget is respected, a late fetch still lands in the store', async () => {
  const store = createReactorStore();
  store.markOwn('2');
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let waited = null;
  const stats = await runBackfill([{ messageId: '2', emoji: '😂' }], store, () => gate.then(() => ['5']), {
    budgetMs: 2000,
    wait: (ms) => {
      waited = ms;
      return Promise.resolve();
    },
  });
  assert.equal(waited, 2000);
  assert.equal(stats.timedOut, true);
  assert.equal(stats.fetched, 0);
  assert.equal(store.reactors('2', '😂'), null);
  release();
  await gate;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(store.reactors('2', '😂'), ['5']);
});

test('runBackfill: an empty plan asks nothing and waits for nothing', async () => {
  const stats = await runBackfill([], createReactorStore(), () => assert.fail('no fetch'), { wait: () => assert.fail('no wait') });
  assert.deepEqual(stats, { planned: 0, fetched: 0, failed: 0, timedOut: false });
});

// --- withReactors / reactorIdsOf ------------------------------------------------

test('withReactors: her reactions carry the known reactors resolved to names, unknown ones left out', () => {
  const store = createReactorStore();
  store.markOwn('2');
  store.markOwn('1');
  store.set('2', '😂', ['5', '6', '404']);
  store.set('1', '😂', ['5']);
  const users = { 5: { name: 'Zoé' }, 6: { name: 'Helper', bot: true } };
  const lines = [line('1', { self: false, reactions: [{ emoji: '😂', count: 1, mine: false }] }), line('2', { reactions: [{ emoji: '😂', count: 3, mine: false }, { emoji: '👍', count: 1, mine: false }] })];
  const out = withReactors(lines, store, (id) => users[id] ?? null);
  assert.equal(out[0], lines[0], 'someone else\'s line is untouched');
  assert.deepEqual(out[1].reactions[0].users, [{ id: '5', name: 'Zoé', bot: false }, { id: '6', name: 'Helper', bot: true }]);
  assert.equal(out[1].reactions[1].users, undefined);
  assert.equal(lines[1].reactions[0].users, undefined, 'the input is not mutated');
  assert.deepEqual(reactorIdsOf(out), ['5'], 'bots get no handle');
});

// --- fetchHistory with reactors ---------------------------------------------------

/** A discord.js-shaped history message with a reaction cache. */
function historyMessage(id, authorId, reactions, ts) {
  return {
    id,
    channelId: 'c1',
    channel: { name: 'general' },
    author: { id: authorId, bot: false, globalName: authorId === SELF ? 'Persona' : 'Zoé', username: 'u' },
    member: { displayName: authorId === SELF ? 'Persona' : 'Zoé' },
    cleanContent: 'hello',
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    messageSnapshots: new Map(),
    flags: { has: () => false },
    reactions: { cache: new Map(reactions.map((reaction, i) => [String(i), reaction])) },
  };
}

test('fetchHistory: with reactors, her missing reactors are fetched once and named like authors', async () => {
  const calls = [];
  const laugh = {
    emoji: { id: null, name: '😂' },
    count: 2,
    me: false,
    users: {
      fetch: async (query) => {
        calls.push(query);
        return new Map([['7', {}], ['8', {}]]);
      },
    },
  };
  const own = historyMessage('2', SELF, [laugh], 2000);
  const theirs = historyMessage('1', '7', [{ emoji: { name: '👍' }, count: 1, me: false, users: { fetch: async () => assert.fail('not hers') } }], 1000);
  const members = new Map([
    ['7', { displayName: 'Zoé', user: { id: '7', bot: false } }],
  ]);
  const channel = {
    id: 'c1',
    guild: { members: { cache: members } },
    client: { users: { cache: new Map([['8', { id: '8', bot: true, globalName: null, username: 'helperbot' }]]) } },
    messages: { fetch: async () => new Map([['2', own], ['1', theirs]]) },
  };
  const store = createReactorStore();
  const options = { limit: 10, selfId: SELF, reactors: { store, budgetMs: 2000, fetchUsers: 10 } };
  const lines = await fetchHistory(channel, options);
  assert.deepEqual(calls, [{ limit: 10 }]);
  assert.deepEqual(lines[1].reactions[0].users, [{ id: '7', name: 'Zoé', bot: false }, { id: '8', name: 'helperbot', bot: true }]);
  assert.equal(lines[0].reactions[0].users, undefined);
  await fetchHistory(channel, options);
  assert.equal(calls.length, 1, 'once per message and emoji');
  const plain = await fetchHistory(channel, { limit: 10, selfId: SELF });
  assert.equal(plain[1].reactions[0].users, undefined, 'no reactors option: counts only');
});

test('fetchMessage: a partial message in the cache is fetched whole', async () => {
  const whole = { id: 'm1', partial: false, author: { id: SELF } };
  const channel = { messages: { cache: new Map([['m1', { id: 'm1', partial: true, author: null }]]), fetch: async () => whole } };
  assert.equal(await fetchMessage(channel, 'm1'), whole);
});

// --- rendering ---------------------------------------------------------------------

const labels = {
  ...fixtureLabels,
  transcript: { ...fixtureLabels.transcript, author: '{name} [{handle}]' },
};
const base = { timezone: 'UTC', gapMinutes: 20, maxChars: 500, selfName: 'Persona', labels, mode: 'chat' };

/** Her line with one reaction by the given users. */
function reacted(users, { count = users.length, mine = false, emoji = '😂' } = {}) {
  return { ...line('2'), reactions: [{ emoji, count, mine, users }] };
}

test('formatTranscript: her line names its reactors instead of counting them', () => {
  const users = [{ id: '7', name: 'Zoé', bot: false }, { id: '8', name: 'Helper', bot: true }];
  const [item] = formatTranscript([reacted(users)], { ...base, reactionNames: true });
  assert.ok(item.text.endsWith('[reactions: 😂 by Zoé, Helper]'), item.text);
});

test('formatTranscript: a reactor reads exactly like an author with the same id, handle included', () => {
  const handles = new Map([['7', 'u1abc'], ['8', 'u2def']]);
  const author = { ...line('1', { self: false, authorId: '7', authorName: 'Zoé' }) };
  const users = [{ id: '7', name: 'Zoé', bot: false }];
  const items = formatTranscript([author, reacted(users)], { ...base, handles, reactionNames: true });
  const authorForm = items[0].text.match(/\] (.+): text$/)[1];
  assert.equal(authorForm, 'Zoé [@u1abc]');
  assert.ok(items[1].text.endsWith(`[reactions: 😂 by ${authorForm}]`), items[1].text);
  // A bot reactor, like a bot author, never carries a handle.
  const botItems = formatTranscript([{ ...line('1', { self: false, authorId: '8', authorName: 'Helper', bot: true }) }, reacted([{ id: '8', name: 'Helper', bot: true }])], { ...base, handles, reactionNames: true });
  assert.ok(botItems[0].text.includes('] Helper: text'));
  assert.ok(botItems[1].text.endsWith('[reactions: 😂 by Helper]'), botItems[1].text);
});

test('formatTranscript: past reactionNamesMax the rest is counted, and unknown reactors too', () => {
  const users = ['Ana', 'Bé', 'Cé', 'Dé'].map((name, i) => ({ id: String(i + 10), name, bot: false }));
  const [capped] = formatTranscript([reacted(users, { count: 4 })], { ...base, reactionNames: true, reactionNamesMax: 2 });
  assert.ok(capped.text.endsWith('[reactions: 😂 by Ana, Bé and 2 more]'), capped.text);
  const [partly] = formatTranscript([reacted(users.slice(0, 1), { count: 4, mine: true })], { ...base, reactionNames: true });
  assert.ok(partly.text.endsWith('[reactions: 😂 by Ana, Persona (you) and 2 more]'), partly.text);
});

test('formatTranscript: counts stay on others\' lines, for unknown reactors and with the switch off', () => {
  const users = [{ id: '7', name: 'Zoé', bot: false }];
  const theirs = { ...line('1', { self: false }), reactions: [{ emoji: '😂', count: 1, mine: false, users }] };
  const [other] = formatTranscript([theirs], { ...base, reactionNames: true });
  assert.ok(other.text.endsWith('[reactions: 😂 x1]'), other.text);
  const [unknown] = formatTranscript([reacted([], { count: 2 })], { ...base, reactionNames: true });
  assert.ok(unknown.text.endsWith('[reactions: 😂 x2]'), unknown.text);
  const [off] = formatTranscript([reacted(users)], { ...base, reactionNames: false });
  assert.ok(off.text.endsWith('[reactions: 😂 x1]'), off.text);
  const [noLabel] = formatTranscript([reacted(users)], { ...base, reactionNames: true, labels: { ...labels, transcript: { ...labels.transcript, reactionNames: '' } } });
  assert.ok(noLabel.text.endsWith('[reactions: 😂 x1]'), noLabel.text);
  const [memory] = formatTranscript([reacted(users)], { ...base, mode: 'memory', reactionNames: true });
  assert.ok(memory.text.endsWith('[reactions: 😂 x1]'), memory.text);
});

// --- the persona's request ---------------------------------------------------------

test('buildRequest: a reactor on her line gets a handle like an author, only in the tail, and the switch turns it off', () => {
  const now = Date.UTC(2026, 9, 15, 10, 0, 0);
  const author = { id: '650000000000000123', name: 'Zoé' };
  const reactor = { id: '650000000000000456', name: 'Ἑλένη' };
  const history = [
    { id: '1', ts: now - 3 * 60_000, authorId: author.id, authorName: author.name, self: false, content: 'line 1', attachments: [], stickers: [], replyToId: null },
    {
      id: '2',
      ts: now - 2 * 60_000,
      authorId: SELF,
      authorName: 'Persona',
      self: true,
      content: 'line 2',
      attachments: [],
      stickers: [],
      replyToId: null,
      reactions: [{ emoji: '😂', count: 2, mine: false, users: [{ id: reactor.id, name: reactor.name, bot: false }, { id: author.id, name: author.name, bot: false }] }],
    },
  ];
  const plain = history.map((message) => ({ ...message, reactions: (message.reactions ?? []).map(({ users, ...rest }) => rest) }));
  const config = (features = {}) => ({
    bot: { timezone: 'UTC' },
    context: {
      gapMarkerMinutes: 20,
      maxMessageChars: 800,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500 },
      vision: { maxImages: 0, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
      tempo: { liveMessages10min: 4, deadSilenceMinutes: 45 },
    },
    features: { vision: false, ...features },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
    lore: { scanMessages: 30, maxMatches: 8 },
    memory: { recentHours: 72 },
  });
  const input = (lines, features) => ({
    config: config(features),
    prompts: { 'system-prompt': 'SYSTEM', 'character-card': 'CARD', rules: 'RULES', format: 'FORMAT', reply: 'REPLY', interject: 'INTERJECT', labels },
    calibrator: { ratio: 1, apply: (n) => n },
    mode: 'interject',
    now,
    selfName: 'Persona',
    selfId: SELF,
    history: lines,
    neighbors: [],
    trigger: null,
    triggerKind: null,
    guildMemory: {},
    interlocutor: null,
    otherProfiles: [],
    candidateProfiles: [{ id: author.id, names: [author.name], aliases: [] }],
  });
  const textOf = (request) => request.messages[1].content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  const stableOf = (request) => request.messages[1].content.filter((part) => part.cacheSegment).map((part) => part.text).join('\n');

  const named = buildRequest(input(history));
  const handleOfId = new Map([...named.handles].map(([handle, id]) => [id, handle]));
  assert.ok(handleOfId.has(reactor.id), 'the reactor is in view');
  const authorForm = `${author.name} [@${handleOfId.get(author.id)}]`;
  const text = textOf(named);
  assert.ok(text.includes(`] ${authorForm}: line 1`), text);
  assert.ok(text.includes(`[reactions: 😂 by ${reactor.name} [@${handleOfId.get(reactor.id)}], ${authorForm}]`), text);
  assert.equal(stableOf(named), stableOf(buildRequest(input(plain))), 'nothing of it in a cached part');

  const off = textOf(buildRequest(input(history, { reactionNames: false })));
  assert.ok(off.includes('[reactions: 😂 x2]'), off);
});
