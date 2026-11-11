// Tests for the reactor store of the core (src/behavior/reactor-store.ts: who reacted to the persona's own messages,
// fed by `reaction.changed` events), the backfill and the rendering of the names in src/format.ts#formatTranscript.
// Fakes only: no Discord, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyReactionChanged,
  backfillPlan,
  createReactorStore,
  runBackfill,
  withReactors,
} from '../src/behavior/reactor-store.ts';
import { formatTranscript, reactorIdsOf } from '../src/format.ts';
import { labels as fixtureLabels } from './fixtures/labels.ts';
import { buildRequest, type Built, type Part } from './fixtures/built-request.ts';
import { framed } from './fixtures/prompt-rig.ts';

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

test('reactors store: an add on her message is kept in order, each user once', () => {
  const store = createReactorStore();
  assert.equal(feed(store, 'add', { accountId: '2' }), 'applied');
  feed(store, 'add', { accountId: '1' });
  assert.equal(feed(store, 'add', { accountId: '2' }), 'ignored');
  assert.deepEqual(store.reactors('m1', '😂'), ['2', '1']);
});

test('reactors store: remove takes one user back, removeEmoji one emoji, removeAll every emoji', () => {
  const store = createReactorStore();
  for (const [emoji, user] of [
    ['😂', '1'],
    ['😂', '2'],
    ['👍', '3'],
    [':kek:', '4'],
  ]) {
    const parsed = emoji.startsWith(':') ? { id: '77', name: 'kek' } : { name: emoji };
    feed(store, 'add', { emoji: parsed, accountId: user });
  }
  feed(store, 'remove', { emoji: { name: '😂' }, accountId: '1' });
  assert.deepEqual(store.reactors('m1', '😂'), ['2']);
  feed(store, 'removeEmoji', { emoji: { name: '👍' } });
  assert.equal(store.reactors('m1', '👍'), null);
  assert.deepEqual(store.reactors('m1', ':kek:'), ['4']);
  feed(store, 'removeAll');
  assert.equal(store.reactors('m1', '😂'), null);
  assert.equal(store.reactors('m1', ':kek:'), null);
  assert.equal(store.isOwn('m1'), true, 'the message stays hers');
});

test('reactors store: her own reaction is never a reactor', () => {
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

test('reactors store: a message already known as hers takes live events whose author is unknown', () => {
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

test('backfillPlan: only her lines, only reactions by others the store lacks, once per message and emoji', () => {
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
  assert.equal(store.isOwn('4'), true, 'every line of hers is kept for later events');
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

test('runBackfill: fetches one at a time into the store, her own id dropped, failures counted', async () => {
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

// Owner's rule of 2026-11-10: a bot is a person to her, so a bot that reacted gets a handle like a member.
test('withReactors: her reactions carry the known reactors resolved to names, unknown ones left out', () => {
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
  assert.deepEqual(out[1].reactions[0].users, [
    { id: '5', name: 'Zoé', bot: false },
    { id: '6', name: 'Helper', bot: true },
  ]);
  assert.equal(out[1].reactions[1].users, undefined);
  assert.equal(lines[1].reactions[0].users, undefined, 'the input is not mutated');
  assert.deepEqual(reactorIdsOf(out), ['5', '6'], 'a bot gets a handle too');
});

// --- rendering ---------------------------------------------------------------------

// The owner's decision of 2026-11-10: one handle per person, a line's author is the handle alone (authors.line).
const labels = {
  ...fixtureLabels,
  authors: { line: '{handle}', lineAccount: '{handle} ({iface} {id})', unknown: 'someone' },
};
const base = { timezone: 'UTC', gapMinutes: 20, maxChars: 500, selfName: 'Persona', labels, mode: 'chat' as const };

/** Her line with one reaction by the given users. */
function reacted(
  users: Array<{ id: string; name: string; bot: boolean }>,
  { count = users.length, mine = false, emoji = '😂' }: { count?: number; mine?: boolean; emoji?: string } = {}
) {
  return { ...line('2'), reactions: [{ emoji, count, mine, users }] };
}

test('formatTranscript: her line names its reactors instead of counting them', () => {
  const users = [
    { id: '7', name: 'Zoé', bot: false },
    { id: '8', name: 'Helper', bot: true },
  ];
  const [item] = formatTranscript([reacted(users)], { ...base, reactionNames: true });
  assert.ok(item.text.endsWith('[reactions: 😂 by Zoé, Helper]'), item.text);
});

test('formatTranscript: a reactor reads exactly like an author with the same id, handle included', () => {
  const handles = new Map([
    ['7', 'u1abc'],
    ['8', 'u2def'],
  ]);
  const author = { ...line('1', { self: false, authorId: '7', authorName: 'Zoé' }) };
  const users = [{ id: '7', name: 'Zoé', bot: false }];
  const items = formatTranscript([author, reacted(users)], { ...base, handles, reactionNames: true });
  const authorForm = items[0].text.match(/\] (.+): text$/)![1];
  assert.equal(authorForm, '@u1abc');
  assert.ok(items[1].text.endsWith(`[reactions: 😂 by ${authorForm}]`), items[1].text);
  // Owner's rule of 2026-11-10: a bot is a person to her, so a bot reactor, like a bot author, carries its handle.
  const botItems = formatTranscript(
    [
      { ...line('1', { self: false, authorId: '8', authorName: 'Helper', bot: true }) },
      reacted([{ id: '8', name: 'Helper', bot: true }]),
    ],
    { ...base, handles, reactionNames: true }
  );
  assert.ok(botItems[0].text.includes('] @u2def: text'), botItems[0].text);
  assert.ok(botItems[1].text.endsWith('[reactions: 😂 by @u2def]'), botItems[1].text);
});

test('formatTranscript: past reactionNamesMax the rest is counted, and unknown reactors too', () => {
  const users = ['Ana', 'Bé', 'Cé', 'Dé'].map((name, i) => ({ id: String(i + 10), name, bot: false }));
  const [capped] = formatTranscript([reacted(users, { count: 4 })], {
    ...base,
    reactionNames: true,
    reactionNamesMax: 2,
  });
  assert.ok(capped.text.endsWith('[reactions: 😂 by Ana, Bé and 2 more]'), capped.text);
  const [partly] = formatTranscript([reacted(users.slice(0, 1), { count: 4, mine: true })], {
    ...base,
    reactionNames: true,
  });
  assert.ok(partly.text.endsWith('[reactions: 😂 by Ana, Persona (you) and 2 more]'), partly.text);
});

test("formatTranscript: counts stay on others' lines, for unknown reactors and with the switch off", () => {
  const users = [{ id: '7', name: 'Zoé', bot: false }];
  const theirs = { ...line('1', { self: false }), reactions: [{ emoji: '😂', count: 1, mine: false, users }] };
  const [other] = formatTranscript([theirs], { ...base, reactionNames: true });
  assert.ok(other.text.endsWith('[reactions: 😂 x1]'), other.text);
  const [unknown] = formatTranscript([reacted([], { count: 2 })], { ...base, reactionNames: true });
  assert.ok(unknown.text.endsWith('[reactions: 😂 x2]'), unknown.text);
  const [off] = formatTranscript([reacted(users)], { ...base, reactionNames: false });
  assert.ok(off.text.endsWith('[reactions: 😂 x1]'), off.text);
  const [noLabel] = formatTranscript([reacted(users)], {
    ...base,
    reactionNames: true,
    labels: { ...labels, transcript: { ...labels.transcript, reactionNames: '' } },
  });
  assert.ok(noLabel.text.endsWith('[reactions: 😂 x1]'), noLabel.text);
  const [memory] = formatTranscript([reacted(users)], { ...base, mode: 'memory', reactionNames: true });
  assert.ok(memory.text.endsWith('[reactions: 😂 x1]'), memory.text);
});

// --- the persona's request ---------------------------------------------------------

// The owner's decisions of 2026-11-10 (one handle per person, an entry for every handle) and 2026-11-11 (cache layout).
test('buildRequest: a reactor on her line gets a handle and an entry in <people>, and the parts cached longer than <memory> stay the same', () => {
  const now = Date.UTC(2026, 9, 15, 10, 0, 0);
  const author = { id: '650000000000000123', name: 'Zoé' };
  const reactor = { id: '650000000000000456', name: 'Ἑλένη' };
  const history = [
    {
      id: '1',
      ts: now - 3 * 60_000,
      authorId: author.id,
      authorName: author.name,
      self: false,
      content: 'line 1',
      attachments: [],
      stickers: [],
      replyToId: null,
    },
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
      reactions: [
        {
          emoji: '😂',
          count: 2,
          mine: false,
          users: [
            { id: reactor.id, name: reactor.name, bot: false },
            { id: author.id, name: author.name, bot: false },
          ],
        },
      ],
    },
  ];
  const plain = history.map((message) => ({
    ...message,
    reactions: (message.reactions ?? []).map(({ users, ...rest }) => rest),
  }));
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
  // Every request is built on its turn frame (slice 7).
  const input = (lines: Array<unknown>, features?: object) =>
    framed({
      config: config(features),
      prompts: {
        'system-prompt': 'SYSTEM',
        'character-card': 'CARD',
        rules: 'RULES',
        format: 'FORMAT',
        reply: 'REPLY',
        interject: 'INTERJECT',
        labels,
      },
      calibrator: { ratio: 1, apply: (n: number) => n },
      mode: 'interject',
      now,
      selfName: 'Persona',
      selfId: SELF,
      history: lines,
      neighbors: [],
      trigger: null,
      triggerKind: null,
      placeMemory: {},
      interlocutor: null,
      otherProfiles: [],
      candidateProfiles: [{ id: author.id, names: [author.name], aliases: [] }],
    });
  const textOf = (request: Built) =>
    request.messages[1].content
      .filter((part: Part) => part.type === 'text')
      .map((part: Part) => part.text)
      .join('\n');
  /** The parts cached longer than the `memory` segment: `<self>` and `<surroundings>`. */
  const longerOf = (request: Built) =>
    request.messages[1].content
      .filter((part: Part) => part.cacheSegment === 'stable' || part.cacheSegment === 'surroundings')
      .map((part: Part) => part.text)
      .join('\n');

  const named = buildRequest(input(history));
  const bare = buildRequest(input(plain));
  const handleOfId = new Map([...named.handles!].map(([handle, id]) => [id, handle]));
  assert.ok(handleOfId.has(reactor.id), 'the reactor is in view');
  const reactorForm = `@${handleOfId.get(reactor.id)}`;
  const authorForm = `@${handleOfId.get(author.id)}`;
  const text = textOf(named);
  assert.ok(text.includes(`] ${authorForm}: line 1`), text);
  assert.ok(text.includes(`[reactions: 😂 by ${reactorForm}, ${authorForm}]`), text);
  const people = /<people>\n([\s\S]*?)\n<\/people>/.exec(text)?.[1] ?? '';
  assert.ok(people.includes(reactorForm), people);
  assert.deepEqual(named.messages[0], bare.messages[0], 'the same system message');
  assert.ok(longerOf(named) !== '', 'the request has <self>');
  assert.equal(longerOf(named), longerOf(bare), '<self> and <surroundings> do not change with the reactor');
  assert.ok(!longerOf(named).includes(reactorForm) && !longerOf(named).includes(reactor.name), longerOf(named));
});
