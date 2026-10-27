// The recall runner (src/behavior/recall-run.js) over the interface's reads. A search is `searchMessages` with the
// community and a neutral query (text, author, a time range as `after` and `before` in ms); a hit is neutral too (a
// reference, a time, a text and its author). The windows around the hits are `history` reads, anchored `around` a
// message and followed `after` the last line; a member name is `searchMembers`. Which conversations a hit may come
// from is decided by the core's pull rail over the turn's snapshot (src/behavior/snapshot.ts), toward the turn's
// conversation or, in a private chat, toward its partner (`partnerId`). Nothing here knows a snowflake or a platform
// object. The interface is the fake adapter; the model, the store and the clock are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConversationInfo } from '../src/protocol/adapter.ts';
import type { Reads } from '../src/interface/reads.ts';
import { takeSnapshot } from '../src/behavior/snapshot.ts';
import type { Snapshot } from '../src/behavior/snapshot.ts';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { labels } from './fixtures/labels.js';
import { COMMUNITY, SELF_ID, channel, member, message, privateChannel, rig } from './fixtures/reads-rig.ts';
import { createRecall } from '../src/behavior/recall-run.js';
import * as recall from '../src/behavior/recall.js';
import { searchPlan } from '../src/behavior/recall.js';

type Line = {
  id: string;
  channelId: string;
  ts: number;
  self: boolean;
  bot: boolean;
  authorName: string;
  content: string;
};
type Server = { forms: Array<string>; who: Array<string>; from: number | null; to: number | null };
type RunArgs = {
  guildId: string;
  channel: ConversationInfo;
  partnerId: string | null;
  snapshot: Snapshot | null;
  selfId: string;
  selfName: string;
  history: Array<Line>;
  candidate: Line;
  server: Server;
};
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')) as Record<string, object>;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const RABBIT = Date.UTC(2026, 9, 1, 18, 44);
const PROMPT = 'You are {{name}}; {{answerChars}}.';
const RABBIT_SERVER: Server = { forms: ['κουνέλι', 'κουνελιού'], who: [], from: null, to: null };

/** The recall settings these tests rely on, set here and not read from the shipped defaults. */
const RECALL = {
  maxForms: 8,
  maxPeople: 2,
  dateSamples: 4,
  clusterGapMinutes: 30,
  maxClusters: 8,
  rareHits: 0,
  windowMessages: 16,
  answerChars: 1200,
  stretchChars: 1500,
  maxPerDay: 100,
  timeoutMs: 30000,
  minSummaryMs: 2500,
  maxOutputTokens: 500,
  memoryItems: 6,
  selfBonus: 1,
  selfExtra: 0,
  contextMessages: 0,
  traceMaxLines: 500,
  followMessages: 24,
  followGapMinutes: 5,
};

type Scene = { reads?: ReadonlyArray<string>; profiles?: Array<object>; botIds?: Array<string> };

/**
 * A community with #general (c1, the turn's), #garden (c2) and #private (c4, only member u9 views it), the rabbit
 * conversation seeded in them, and a recall runner over the fake's reads.
 */
async function scene(options: Scene = {}) {
  const world = rig(options.reads === undefined ? {} : { reads: options.reads });
  const { fake } = world;
  const general = channel('c1', { name: 'general' });
  const garden = channel('c2', { name: 'garden' });
  const secret = privateChannel('c4', ['u9']);
  for (const info of [general, garden, secret]) fake.seedConversation(info);
  fake.seedMember(COMMUNITY, member('u1', 'Ana'));
  fake.seedMember(COMMUNITY, member('u2', 'Βασίλης'));
  fake.seedMember(COMMUNITY, member('u3', 'Éloïse'));
  fake.seedMember(COMMUNITY, member('bot1', 'Birthdays', { bot: true }));
  fake.seedEvent(message(general, 'r0', RABBIT - 6 * MINUTE, 'πάμε κυνήγι', { authorId: 'u2', authorName: 'Βασίλης' }));
  fake.seedEvent(message(general, 'r2', RABBIT, 'το κουνέλι πέθανε', { authorId: 'u2', authorName: 'Βασίλης' }));
  fake.seedEvent(
    message(general, 'r3', RABBIT + 2 * MINUTE, 'κηδεία για το κουνέλι', { authorId: 'u1', authorName: 'Ana' })
  );
  fake.seedEvent(
    message(general, 'r4', RABBIT + 3 * MINUTE, 'κουνέλι birthday!', {
      authorId: 'bot1',
      authorName: 'Birthdays',
      bot: true,
    })
  );
  fake.seedEvent(
    message(garden, 'g1', RABBIT - 30 * HOUR, 'ένα κουνέλι στον κήπο', { authorId: 'u3', authorName: 'Éloïse' })
  );
  fake.seedEvent(message(secret, 's1', RABBIT - HOUR, 'μυστικό κουνέλι', { authorId: 'u1', authorName: 'Ana' }));

  // The fake marks no author as automated; the hits of `botIds` are marked here, as an interface would.
  const bots = new Set(options.botIds ?? ['bot1']);
  const reads: Reads = {
    ...world.reads,
    searchMessages: async (scope, query) => {
      const found = await world.reads.searchMessages(scope, query);
      if (found === null) return null;
      return {
        ...found,
        hits: found.hits.map((hit) => ({ ...hit, author: { ...hit.author, bot: bots.has(String(hit.author.id)) } })),
      };
    },
  };

  const prompts: Array<Array<{ content: string }>> = [];
  const data: Record<string, unknown> = {};
  const recaller = createRecall({
    hot: {
      config: {
        ...SHIPPED,
        bot: { ...SHIPPED.bot, timezone: 'UTC' },
        recall: RECALL,
        llm: { analyzerTimeoutMs: 30000 },
      },
      prompts: { 'recall-summary': PROMPT, labels },
    },
    store: { state: { data, markDirty() {} }, listUserProfiles: () => options.profiles ?? [] },
    llm: {
      capLeft: () => 100,
      complete: (messages: Array<{ content: string }>) => {
        prompts.push(messages);
        return Promise.resolve({ text: 'stretch: 1\nAna did it on October 1.' });
      },
    },
    reads,
    describer: null,
    now: () => NOW,
  });
  const snapshot = await takeSnapshot(reads, COMMUNITY, ['u5']);
  const history: Array<Line> = [
    {
      id: 'h1',
      channelId: 'c1',
      ts: NOW - 30 * MINUTE,
      self: false,
      bot: false,
      authorName: 'Nikos',
      content: 'τι έγινε με το κουνέλι;',
    },
    {
      id: 'h2',
      channelId: 'c1',
      ts: NOW - MINUTE,
      self: false,
      bot: false,
      authorName: 'Nikos',
      content: 'ποιος σκότωσε το κουνέλι;',
    },
  ];
  const args: RunArgs = {
    guildId: COMMUNITY,
    channel: general,
    partnerId: null,
    snapshot,
    selfId: SELF_ID,
    selfName: 'Zoë',
    history,
    candidate: history[1],
    server: RABBIT_SERVER,
  };
  const run = (over: Partial<RunArgs> = {}) => withCapturedLogs(() => recaller.run({ ...args, ...over }));
  const searches = () =>
    fake.calls
      .filter((call) => call.op === 'searchMessages')
      .map((call) => call.args as [object, Record<string, unknown>]);
  const windows = (): Array<{ conversationId: string; around?: string; after?: string; limit?: number }> =>
    fake.calls
      .filter((call) => call.op === 'history')
      .map((call) => ({
        ...(call.args[0] as { conversationId: string }),
        ...(call.args[1] as { around?: string; after?: string; limit?: number }),
      }));
  return { ...world, fake, args, run, searches, windows, prompts, snapshot };
}

test('searches each form over the whole community, one after another and in order', async () => {
  const s = await scene();
  await s.run();
  assert.deepEqual(
    s.searches().map(([scope, query]) => [scope, query.text]),
    [
      [{ communityId: COMMUNITY }, 'κουνέλι'],
      [{ communityId: COMMUNITY }, 'κουνελιού'],
    ]
  );
  assert.equal(
    s.searches().every(([, query]) => query.after === undefined && query.before === undefined),
    true,
    'no range asked: nothing bounds a query'
  );
});

test('reads a window around the hits of each conversation, follows it, and the summary names the stretch', async () => {
  const s = await scene();
  const { result } = await s.run();
  assert.equal(result.text, 'Ana did it on October 1.');
  assert.equal(result.stretch?.channelId, 'c1');
  assert.equal(result.stretch?.channelName, 'general');
  const around = s.windows().filter((read) => read.around !== undefined);
  assert.deepEqual(around.map((read) => read.conversationId).sort(), ['c1', 'c2']);
  assert.equal(
    around.every((read) => read.limit === RECALL.windowMessages),
    true
  );
  const follows = s.windows().filter((read) => read.after !== undefined);
  assert.equal(follows.length > 0 && follows.every((read) => read.limit === RECALL.followMessages), true);
  assert.equal(s.prompts.length, 1);
});

test("leaves out a conversation the audience rail refuses, an automated author and keeps the persona's own line", async () => {
  const s = await scene();
  s.fake.seedMember(COMMUNITY, member(SELF_ID, 'Zoë'));
  s.fake.seedEvent(
    message(channel('c1', { name: 'general' }), 'r5', RABBIT + 5 * MINUTE, 'κουνέλι, αντίο', {
      authorId: SELF_ID,
      authorName: 'Zoë',
    })
  );
  await s.run({ server: { ...RABBIT_SERVER, forms: ['κουνέλι'] } });
  assert.equal(
    s.windows().some((read) => read.conversationId === 'c4'),
    false
  );
  const user = s.prompts[0]?.[1]?.content ?? '';
  assert.equal(user.includes('μυστικό'), false);
  assert.equal(user.includes('birthday'), false);
  assert.equal(user.includes('Zoë (you): κουνέλι, αντίο'), true);
});

test("drops the hits that are lines of the turn's own chat before reading windows", async () => {
  const s = await scene();
  s.fake.seedEvent(
    message(channel('c1', { name: 'general' }), 'h2', NOW - MINUTE, 'ποιος σκότωσε το κουνέλι;', {
      authorId: 'u5',
      authorName: 'Nikos',
    })
  );
  await s.run({ server: { ...RABBIT_SERVER, forms: ['κουνέλι'] } });
  const anchors = s.windows().map((read) => read.around);
  assert.equal(anchors.includes('h2'), false);
  assert.equal(anchors.length > 0, true);
});

test('finds a person by a Latin name form through the member search and then searches their messages', async () => {
  const s = await scene();
  s.fake.seedMember(COMMUNITY, member('u7', 'Kitezu'));
  s.fake.seedEvent(
    message(channel('c1', { name: 'general' }), 'k1', RABBIT - 300 * HOUR, 'γεια', {
      authorId: 'u7',
      authorName: 'Kitezu',
    })
  );
  const { result } = await s.run({ server: { forms: [], who: ['kitezu'], from: null, to: null } });
  assert.deepEqual(
    s.fake.calls.filter((call) => call.op === 'searchMembers').map((call) => call.args),
    [[{ communityId: COMMUNITY }, { prefix: 'kitezu', limit: RECALL.maxPeople }]]
  );
  assert.deepEqual(
    s.searches().map(([, query]) => query.text ?? query.authorId),
    ['kitezu', 'u7']
  );
  assert.deepEqual(
    result.people.map((person) => [person.id, person.name, person.count, person.newestTs]),
    [['u7', 'Kitezu', 1, RABBIT - 300 * HOUR]]
  );
});

test('uses a stored name without asking the interface for members', async () => {
  const s = await scene({ profiles: [{ id: 'u3', names: ['Éloïse'], aliases: [{ name: 'Ελο' }] }] });
  await s.run({ server: { forms: [], who: ['ελο'], from: null, to: null } });
  assert.deepEqual(s.asked('searchMembers'), []);
  assert.deepEqual(
    s.searches().map(([, query]) => query.text ?? query.authorId),
    ['ελο', 'u3']
  );
});

test('bounds a date range alone by the times asked and no text or author', async () => {
  const s = await scene();
  const from = RABBIT - 10 * MINUTE;
  const to = RABBIT + 10 * MINUTE;
  await s.run({ server: { forms: [], who: [], from, to } });
  const queries = s.searches().map(([, query]) => query);
  assert.equal(queries.length > 0, true);
  assert.equal(
    queries.every(
      (query) =>
        query.after === from && query.before === to + 1 && query.text === undefined && query.authorId === undefined
    ),
    true
  );
});

test('searches nothing in a private chat that has no partner', async () => {
  const s = await scene();
  const dm = channel('dm1', { kind: 'dm', communityId: null, chatType: 'dm', audience: null });
  await s.run({ channel: dm, partnerId: null });
  assert.deepEqual(s.searches(), []);
});

test('in a private chat searches the community and keeps only what the partner can view', async () => {
  const s = await scene();
  s.fake.seedConversation(
    channel('c4', { public: false, viewers: { u5: false }, audience: privateChannel('c4', ['u9']).audience ?? null })
  );
  const dm = channel('dm1', { kind: 'dm', communityId: null, chatType: 'dm', partnerId: 'u5', audience: null });
  const snapshot = await takeSnapshot(s.reads, COMMUNITY, ['u5']);
  await s.run({ channel: dm, partnerId: 'u5', snapshot });
  assert.equal(s.searches().length > 0, true);
  const read = new Set(s.windows().map((window) => window.conversationId));
  assert.equal(read.has('c2'), true);
  assert.equal(read.has('c4'), false);
});

test('returns nothing, and asks the model nothing, when the interface cannot search', async () => {
  const s = await scene({ reads: ['conversation.info', 'conversations.list', 'messages.history'] });
  const { result } = await s.run();
  assert.deepEqual([result.text, result.stretch], [null, null]);
  assert.equal(s.prompts.length, 0);
});

test('returns nothing when hits are found but the interface cannot read their windows', async () => {
  const s = await scene({ reads: ['conversation.info', 'conversations.list', 'messages.search'] });
  const { result } = await s.run();
  assert.deepEqual([result.text, result.stretch], [null, null]);
});

test('plans each query over a range as times: after the start, before the instant past the end', () => {
  const plan = searchPlan({ forms: ['κουνέλι'], memberIds: ['u7'], from: 1000, to: 1999, maxForms: 8 });
  assert.deepEqual(plan, [
    { kind: 'form', content: 'κουνέλι', after: 1000, before: 2000 },
    { kind: 'author', authorId: 'u7', after: 1000, before: 2000 },
  ]);
});

test('plans a query with no range unbounded, and a range alone as one query of its own', () => {
  assert.deepEqual(searchPlan({ forms: ['κουνέλι'], maxForms: 8 }), [
    { kind: 'form', content: 'κουνέλι', after: null, before: null },
  ]);
  assert.deepEqual(searchPlan({ from: 1000, to: 1999, maxForms: 8 }), [{ kind: 'range', after: 1000, before: 2000 }]);
});

test('keeps no snowflake arithmetic in the core', () => {
  assert.equal('snowflakeAt' in recall, false);
});
