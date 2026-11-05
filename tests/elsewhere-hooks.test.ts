// The elsewhere pick as a turn uses it, and its list lines. Tests that moved here from tests/route.test.ts and
// tests/participation-pick.test.ts in plan 2026-11-04-cli-and-memory B3 carry the behaviour those two classifiers had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createElsewhereHooks,
  elsewhereEpisodeLines,
  elsewherePlaceLines,
  parseElsewhereAnswer,
} from '../src/behavior/elsewhere-pick.ts';
import type { ElsewhereEpisode, ElsewherePlace } from '../src/behavior/elsewhere-pick.ts';
import { snapshotOf } from '../src/behavior/snapshot.ts';
import type { ConversationInfo } from '../src/protocol/adapter.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { labels } from './fixtures/labels.ts';
import { channel as channelOf } from './fixtures/reads-rig.ts';
import { wrongly } from './fixtures/loose-types.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const UNITS = (labels as { units: unknown }).units;

const place = (extra: Partial<ElsewherePlace> = {}): ElsewherePlace => ({
  id: 'c1',
  name: 'journal',
  iface: 'alpha',
  kind: 'channel',
  lastActivityAt: null,
  lastAttentionAt: null,
  ...extra,
});

const episode = (extra: Partial<ElsewhereEpisode> = {}): ElsewhereEpisode => ({
  id: 'p1',
  placeId: 'c1',
  ageMs: 3_600_000,
  memberName: 'Ana',
  memberLines: 'μια ερώτηση',
  selfLines: 'στο ράφι',
  ...extra,
});

test('elsewherePlaceLines: numbered lines with the writer and the clamped purpose, an empty tail trimmed', () => {
  const long = 'ένα ημερολόγιο '.repeat(20);
  const lines = elsewherePlaceLines([place({ writer: 'Éloïse (Élo)', purpose: long }), place({ name: 'jardin' })], 20);
  assert.ok(lines[0]?.startsWith('1 | journal | Éloïse (Élo) | ένα'));
  assert.ok((lines[0]?.length ?? 0) < 60, lines[0]);
  assert.equal(lines[1], '2 | jardin |  |');
});

test('elsewherePlaceLines: 0 chars drops the purpose', () => {
  assert.deepEqual(elsewherePlaceLines([place({ purpose: 'a diary' })], 0), ['1 | journal |  |']);
});

test('elsewhereEpisodeLines: one numbered line per episode with its ages apart; a pipe in a text becomes a slash', () => {
  const { lines, ages, ids } = elsewhereEpisodeLines([episode({ memberLines: 'a | b' })], {
    placeNameOf: () => 'journal',
    units: UNITS,
    selfName: 'Nova',
  });
  assert.deepEqual(lines, ['1 | journal | Ana: a / b | Nova: στο ράφι']);
  assert.equal(ages.length, 1);
  assert.ok(ages[0]?.startsWith('1 | '));
  assert.deepEqual(ids, ['p1']);
});

test('elsewhereEpisodeLines: an episode with no member leaves that column empty, one of a nameless place is left out', () => {
  const { lines, ids } = elsewhereEpisodeLines(
    [episode({ memberName: null, memberLines: '' }), episode({ id: 'p2', placeId: 'gone' })],
    { placeNameOf: (id) => (id === 'c1' ? 'journal' : null), units: UNITS, selfName: 'Nova' }
  );
  assert.deepEqual(lines, ['1 | journal |  | Nova: στο ράφι']);
  assert.deepEqual(ids, ['p1']);
});

test('parseElsewhereAnswer: older reads as earlier, as the route classifier read it', () => {
  assert.equal(
    parseElsewhereAnswer('place: 1 older\nepisodes: none', { places: 1, episodes: 0 }).place.direction,
    'earlier'
  );
});

test('parseElsewhereAnswer: quotes and trailing punctuation around a value are tolerated', () => {
  const parsed = parseElsewhereAnswer('place: "2."\nepisodes: #1, #2.', { places: 2, episodes: 2 });
  assert.equal(parsed.place.index, 2);
  assert.deepEqual(parsed.episodes.indices, [1, 2]);
});

type Line = Record<string, unknown>;

function scene(
  options: {
    answer?: string | (() => string);
    conversations?: Array<ConversationInfo>;
    stored?: Array<Record<string, unknown>>;
    episodes?: Array<Record<string, unknown>>;
    prompt?: string | null;
  } = {}
) {
  const calls: Array<{ user: string; options: Record<string, unknown> }> = [];
  const here = channelOf('here', { iface: 'alpha', rootId: 'g1' });
  const conversations = options.conversations ?? [channelOf('c2', { iface: 'alpha', rootId: 'g1', name: 'journal' })];
  const hooks = createElsewhereHooks({
    hot: {
      config: { bot: { timezone: 'UTC' }, llm: {}, models: {}, elsewhere: { maxPlaces: 10, maxEpisodes: 10 } },
      prompts: {
        labels,
        ...(options.prompt === null ? {} : { 'elsewhere-pick': options.prompt ?? 'Pick for {{name}}.' }),
      },
    },
    store: {
      listChannels: () => options.stored ?? [{ id: 'c2', name: 'journal', lastMessageAt: NOW - 1000 }],
      getParticipation: () => ({ episodes: options.episodes ?? [], nextId: 1 }),
      getUser: () => null,
    },
    llm: {
      complete: (messages: Array<{ content: unknown }>, request: Record<string, unknown>) => {
        calls.push({ user: JSON.stringify(messages[1]?.content), options: request });
        const answer = options.answer ?? 'place: none\nepisodes: none';
        return Promise.resolve({ text: typeof answer === 'function' ? answer() : answer });
      },
    },
    now: () => NOW,
  });
  const line: Line = { id: 'm1', placeId: 'here', authorId: 'u1', authorName: 'Eleni', content: 'τι έγινε;', ts: NOW };
  const args = {
    placeId: 'g1',
    channel: here,
    snapshot: snapshotOf('g1', { conversations: [here, ...conversations], groups: [] }),
    history: [line],
    trigger: line,
    triggerKind: 'mention',
    mode: 'reply',
    selfName: 'Nova',
  };
  return { hooks, calls, args };
}

test('hooks: the pull phase and the request phase share one request for one line', async () => {
  // Bug: the merge still pays two calls, one per call site.
  const { hooks, calls, args } = scene({ answer: 'place: 1\nepisodes: none' });
  const [route, episodes] = await withCapturedLogs(() =>
    Promise.all([hooks.routeChannels(wrongly(args)), hooks.pickEpisodes(wrongly(args))])
  ).then(({ result }) => result);
  assert.equal(calls.length, 1);
  assert.deepEqual(route, ['c2']);
  assert.deepEqual(episodes, []);
});

test('hooks: a new line asks again', async () => {
  // Bug: the shared answer outlives its line, and the next turn acts on the old pick.
  const { hooks, calls, args } = scene();
  await withCapturedLogs(async () => {
    await hooks.routeChannels(wrongly(args));
    await hooks.routeChannels(wrongly({ ...args, trigger: { ...args.trigger, id: 'm2' } }));
  });
  assert.equal(calls.length, 2);
});

test('hooks: an earlier pick comes with its direction', async () => {
  const { hooks, args } = scene({ answer: 'place: 1 earlier\nepisodes: none' });
  const { result } = await withCapturedLogs(() => hooks.routeChannels(wrongly(args)));
  assert.deepEqual(result, [{ id: 'c2', direction: 'earlier' }]);
});

test('hooks: a spontaneous turn judges the newest member line', async () => {
  const { hooks, calls, args } = scene();
  await withCapturedLogs(() => hooks.routeChannels(wrongly({ ...args, trigger: null, triggerKind: null })));
  assert.ok(calls[0]?.user.includes('τι έγινε;'));
});

for (const triggerKind of ['overheard', 'private', 'followUp']) {
  test(`hooks: a ${triggerKind} turn asks, every started turn does`, async () => {
    // Plan B3 and B2: the route classifier refused overheard and private turns; the one pick does not.
    const { hooks, calls, args } = scene();
    const partner = triggerKind === 'private' ? { partner: { id: 'u1' } } : {};
    await withCapturedLogs(() => hooks.routeChannels(wrongly({ ...args, triggerKind, ...partner })));
    assert.equal(calls.length, 1);
  });
}

test('hooks: a missed recovery never asks', async () => {
  const { hooks, calls, args } = scene();
  await hooks.routeChannels(wrongly({ ...args, triggerKind: 'missed' }));
  assert.equal(calls.length, 0);
});

test('hooks: a place its listing does not hold is no candidate', async () => {
  // Bug: a stored place with an unprovable audience is offered.
  const { hooks, calls, args } = scene({ stored: [{ id: 'nowhere', name: 'x' }] });
  await hooks.routeChannels(wrongly(args));
  assert.equal(calls.length, 0);
});

test('hooks: a store that throws resolves none and does not reject', async () => {
  const { hooks, args } = scene();
  const throwing = createElsewhereHooks({
    hot: { config: {}, prompts: { labels, 'elsewhere-pick': 'p' } },
    store: {
      listChannels: () => {
        throw new Error('store down');
      },
    },
    llm: { complete: () => Promise.resolve({ text: '' }) },
    now: () => NOW,
  });
  assert.ok(hooks);
  const { result } = await withCapturedLogs(() => throwing.routeChannels(wrongly(args)));
  assert.deepEqual(result, []);
});

test('hooks: the cached lists are byte-identical across calls minutes apart', async () => {
  // Bug: an age or an order moves into the stable part and every turn misses the provider's cache.
  const episodes = [
    {
      id: 'p1',
      placeId: 'c2',
      continues: null,
      lastOwnAt: NOW - 60_000,
      messages: [{ id: 's1', ts: NOW - 60_000, authorId: 'self', name: 'Nova', self: true, text: 'στο ράφι' }],
    },
  ];
  const stablePart = (user: string) =>
    (JSON.parse(user) as Array<{ cacheSegment?: string; text: string }>).find((part) => part.cacheSegment === 'stable')
      ?.text;
  const first = scene({ episodes });
  await withCapturedLogs(() => first.hooks.pickEpisodes(wrongly(first.args)));
  const second = scene({ episodes });
  await withCapturedLogs(() => second.hooks.pickEpisodes(wrongly(second.args)));
  assert.ok(stablePart(first.calls[0]?.user ?? '[]')?.includes('<places>'));
  assert.equal(stablePart(first.calls[0]?.user ?? '[]'), stablePart(second.calls[0]?.user ?? '[]'));
});
