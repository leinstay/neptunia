// Tests for src/behavior/recall-run.js: the recall runner over a fake guild
// (REST search, member search, channels with history), a fake store, a fake
// LLM and a fake describer. No network, no real data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecall } from '../src/behavior/recall-run.js';
import { createStore } from '../src/memory/store.js';
import { HIT_MARK, snowflakeAt } from '../src/behavior/recall.js';
import { toRecordLine } from '../src/memory/record.js';
import { DailyCapError } from '../src/llm/openrouter.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED_CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const RABBIT = Date.UTC(2026, 9, 1, 18, 44);
const GUILD = 'g1';
const PROMPT = 'You are {{name}}; {{answerChars}}.';

// The recall settings the runner tests rely on, pinned here instead of read from the shipped defaults.
const RECALL_PIN = { maxForms: 8, maxPeople: 2, dateSamples: 4, clusterGapMinutes: 30, maxClusters: 8, rareHits: 0, windowMessages: 16, answerChars: 1200, stretchChars: 1500, maxPerDay: 100, timeoutMs: 30000, minSummaryMs: 2500, maxOutputTokens: 500, memoryItems: 6, selfBonus: 1, selfExtra: 0, contextMessages: 0, traceMaxLines: 500 };

/** The shipped config.json with the recall settings pinned and the given groups merged over a fresh copy (one level deep). */
function config(overrides = {}) {
  const base = structuredClone(SHIPPED_CONFIG);
  base.bot = { ...base.bot, timezone: 'UTC' };
  base.recall = { ...RECALL_PIN };
  for (const [key, value] of Object.entries(overrides)) base[key] = { ...base[key], ...value };
  return base;
}

/** One stored line of a fake channel: `{ id, ts, author, content, bot, attachment }`. */
function line(id, ts, { author = 'u1', name = 'Ana', content = `line ${id}`, bot = false, attachment = null } = {}) {
  return { id, ts, author, name, content, bot, attachment };
}

/** A discord.js-shaped message of `channelId` from a stored line. */
function djs(channelId, l) {
  const attachments = new Map();
  if (l.attachment) attachments.set(l.attachment.id, { id: l.attachment.id, contentType: 'image/png', name: 'x.png', url: 'https://cdn.example/x.png', size: 10 });
  return {
    id: l.id,
    channelId,
    createdTimestamp: l.ts,
    cleanContent: l.content,
    content: l.content,
    author: { id: l.author, username: l.name.toLowerCase(), bot: l.bot },
    member: { displayName: l.name },
    attachments,
    embeds: [],
    stickers: new Map(),
    reactions: { cache: new Map() },
    mentions: { users: new Map() },
  };
}

/** A raw API search hit of a stored line. */
function rawHit(channelId, l) {
  return { id: l.id, channel_id: channelId, timestamp: new Date(l.ts).toISOString(), author: { id: l.author, username: l.name.toLowerCase(), global_name: l.name, bot: l.bot }, content: l.content };
}

/**
 * A scene: a guild with #general (c1, the turn's channel), #garden (c2) and #private (c4, which @everyone cannot
 * view, so the audience rail refuses it here); `lines` per channel id; `answers(route, query)` gives the REST body.
 */
function scene({ lines = {}, answers = () => ({ total_results: 0, messages: [] }), answer = 'stretch: 1\nAna did it on October 1.', features = {}, recall = {}, state = {}, capLeft = 100, describer = null, profiles = [], memory = {}, timers, now = () => NOW, archive = null, record = null } = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const guild = {
    id: GUILD,
    members: { me: { id: 'self' } },
    roles: { everyone: { id: GUILD }, cache: new Map() },
    channels: { cache: new Map() },
    client: {
      rest: {
        get: async (route, { query, signal }) => {
          calls.push({ route, query: Object.fromEntries(query), signal });
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Promise.resolve();
          inFlight -= 1;
          return answers(route, Object.fromEntries(query), signal);
        },
      },
    },
  };
  const fetches = [];
  const addChannel = (id, name, { everyone = true } = {}) => {
    const stored = lines[id] ?? [];
    const channel = {
      id,
      name,
      guild,
      viewable: true,
      lastMessageId: null,
      isTextBased: () => true,
      isThread: () => false,
      permissionsFor: (target) => ({ has: () => everyone || target?.id === 'self' }),
      permissionOverwrites: { cache: new Map() },
      messages: {
        fetch: async ({ around, limit }) => {
          fetches.push({ channel: id, around, limit });
          const at = stored.findIndex((l) => l.id === around);
          const from = Math.max(0, at - Math.floor(limit / 2));
          return new Map(stored.slice(from, from + limit).map((l) => [l.id, djs(id, l)]));
        },
      },
    };
    guild.channels.cache.set(id, channel);
    return channel;
  };
  const channel = addChannel('c1', 'general');
  addChannel('c2', 'garden');
  addChannel('c4', 'private', { everyone: false });

  const data = { ...state };
  let dirty = 0;
  const store = {
    state: {
      get data() {
        return data;
      },
      markDirty() {
        dirty += 1;
      },
    },
    listUserProfiles: () => profiles,
    // The other stored memory a test hands over: getLore, getGuild, getRecent, getPrivate.
    ...memory,
  };
  const llmCalls = [];
  const llm = {
    capLeft: () => capLeft,
    complete: async (messages, options) => {
      llmCalls.push({ messages, options });
      if (answer instanceof Error) throw answer;
      if (typeof answer === 'function') return answer(messages, options);
      return { text: answer };
    },
  };
  const hot = {
    config: config({ features, recall: { ...recall }, llm: { helperTimeoutMs: 30000 } }),
    prompts: { 'recall-summary': PROMPT, labels },
  };
  const recaller = createRecall({ hot, store, llm, describer, now, archive, record, ...(timers ? { timers } : {}) });
  const history = [
    { id: 'h1', channelId: 'c1', ts: NOW - 30 * MINUTE, self: false, bot: false, authorName: 'Nikos', content: 'τι έγινε με το κουνέλι;' },
    { id: 'h2', channelId: 'c1', ts: NOW - MINUTE, self: false, bot: false, authorName: 'Nikos', content: 'ποιος σκότωσε το κουνέλι;' },
  ];
  const args = { guild, guildId: GUILD, channel, selfId: 'self', selfName: 'Zoë', history, candidate: history[1] };
  return {
    recaller,
    args,
    calls,
    fetches,
    llmCalls,
    data,
    hot,
    dirty: () => dirty,
    maxInFlight: () => maxInFlight,
  };
}

/** The message searches among the REST calls. */
const searches = (calls) => calls.filter((c) => c.route.endsWith('/messages/search'));

const RABBIT_LINES = [
  line('r0', RABBIT - 6 * MINUTE, { name: 'Βασίλης', author: 'u2', content: 'πάμε κυνήγι' }),
  line('r1', RABBIT - 4 * MINUTE, { name: 'Ana', content: 'bang', attachment: { id: 'p1' } }),
  line('r2', RABBIT, { name: 'Βασίλης', author: 'u2', content: 'το κουνέλι πέθανε' }),
  line('r3', RABBIT + 2 * MINUTE, { name: 'Ana', content: 'κηδεία για το κουνέλι' }),
  line('r4', RABBIT + 3 * MINUTE, { name: 'Birthdays', author: 'bot1', content: 'κουνέλι birthday!', bot: true }),
];
const GARDEN_LINES = [
  line('g1', RABBIT - 30 * HOUR, { name: 'Éloïse', author: 'u3', content: 'ένα κουνέλι στον κήπο' }),
  line('g2', RABBIT - 30 * HOUR + MINUTE, { name: 'Ana', content: 'ωραίο' }),
];
const PRIVATE_LINES = [line('s1', RABBIT - HOUR, { name: 'Ana', content: 'μυστικό κουνέλι' })];

/** Search answers: `κουνέλι` hits the rabbit lines (the bot's too), the garden and the private channel; `κουνελιού` nothing. */
function rabbitAnswers(route, query) {
  if (route.endsWith('/members/search')) return [];
  if (query.content === 'κουνέλι') {
    return {
      total_results: 5,
      messages: [[rawHit('c1', RABBIT_LINES[4])], [rawHit('c1', RABBIT_LINES[3])], [rawHit('c1', RABBIT_LINES[2])], [rawHit('c4', PRIVATE_LINES[0])], [rawHit('c2', GARDEN_LINES[0])]],
    };
  }
  return { total_results: 0, messages: [] };
}

const RABBIT_SERVER = { forms: ['κουνέλι', 'κουνελιού'], who: [], from: null, to: null };

test('recall: forms are searched one after another in order; the summary reads the windows and names a stretch', async () => {
  const s = scene({ lines: { c1: RABBIT_LINES, c2: GARDEN_LINES, c4: PRIVATE_LINES }, answers: rabbitAnswers, recall: { answerChars: 900 } });
  const { result, logs } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
  assert.deepEqual(searches(s.calls).map((c) => c.query.content), ['κουνέλι', 'κουνελιού']);
  assert.equal(s.maxInFlight(), 1, 'never two searches at once');
  assert.ok(searches(s.calls).every((c) => c.query.max_id === snowflakeAt(NOW - 30 * MINUTE)), 'the turn\'s own chat never takes a result slot');
  assert.equal(result.text, 'Ana did it on October 1.');
  assert.equal(result.stretch.channelId, 'c1');
  assert.equal(result.stretch.channelName, 'general');
  assert.equal(s.data.recallCount, 1, 'one run, one count');
  assert.ok(s.dirty() >= 1);

  const { messages, options } = s.llmCalls[0];
  assert.equal(options.purpose, 'recall-summary');
  assert.equal(options.role, 'classifier.text');
  assert.equal(options.long, true, 'a summary: the long hedge limit');
  assert.equal(messages[0].content, 'You are Zoë; 900.');
  const user = messages[1].content;
  assert.ok(user.includes('## 1 | 2026-10-01 | #general') && user.includes('## 2 | 2026-09-30 | #garden'), user);
  assert.ok(user.includes(`${HIT_MARK}#3 [18:44] Βασίλης: το κουνέλι πέθανε`), user);
  assert.ok(user.endsWith('<question>\nNikos: ποιος σκότωσε το κουνέλι;\n</question>'));
  const summary = logs.find((l) => l.msg === 'recall: summary');
  assert.deepEqual([summary.answer, summary.stretch], ['text', true]);
});

test('recall: a channel the audience rail refuses contributes nothing, other bots are dropped, the persona stays', async () => {
  const own = line('r5', RABBIT + 5 * MINUTE, { name: 'Zoë', author: 'self', content: 'κουνέλι, αντίο' });
  const s = scene({
    lines: { c1: [...RABBIT_LINES, own], c2: GARDEN_LINES, c4: PRIVATE_LINES },
    answers: (route, query) => (query.content === 'κουνέλι' ? { total_results: 3, messages: [[rawHit('c1', own)], [rawHit('c1', RABBIT_LINES[4])], [rawHit('c4', PRIVATE_LINES[0])]] } : rabbitAnswers(route, query)),
  });
  const { logs } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: { ...RABBIT_SERVER, forms: ['κουνέλι'] } }));
  assert.ok(!s.fetches.some((f) => f.channel === 'c4'), 'no window of the refused channel');
  assert.deepEqual(s.fetches.map((f) => f.around), ['r5'], 'the bot\'s hit is gone, the persona\'s own is kept');
  const user = s.llmCalls[0].messages[1].content;
  assert.ok(!user.includes('μυστικό') && !user.includes('birthday'), 'neither the refused channel nor the bot line is shown');
  assert.ok(user.includes('Zoë (you): κουνέλι, αντίο'));
  const searched = logs.find((l) => l.msg === 'recall: searched');
  assert.deepEqual([searched.hits, searched.kept, searched.clusters], [3, 1, 1]);
});

test('recall: the turn\'s own lines are dropped from the hits and the windows', async () => {
  const visible = line('h2', NOW - MINUTE, { name: 'Nikos', author: 'u5', content: 'ποιος σκότωσε το κουνέλι;' });
  const s = scene({
    lines: { c1: [...RABBIT_LINES.slice(0, 4), visible] },
    answers: (route, query) => (query.content === 'κουνέλι' ? { total_results: 2, messages: [[rawHit('c1', visible)], [rawHit('c1', RABBIT_LINES[3])]] } : { total_results: 0, messages: [] }),
  });
  const { logs } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: { ...RABBIT_SERVER, forms: ['κουνέλι'] } }));
  assert.equal(logs.find((l) => l.msg === 'recall: searched').kept, 1);
  assert.deepEqual(s.fetches.map((f) => f.around), ['r3']);
  assert.ok(!s.llmCalls[0].messages[1].content.includes('<found>\n## 1 | 2026-10-05'), 'the window holds no line of the turn');
  assert.equal((s.llmCalls[0].messages[1].content.match(/ποιος σκότωσε/g) ?? []).length, 1, 'the question alone carries it');
});

test('recall: a Latin name form found by the member search adds an author query; a stored name needs no member search', async () => {
  const kite = line('k1', RABBIT - 300 * HOUR, { name: 'Kitezu', author: 'u7', content: 'γεια' });
  const s = scene({
    lines: { c1: [kite] },
    answers: (route, query) => {
      if (route.endsWith('/members/search')) return [{ nick: null, user: { id: 'u7', username: 'kitezu.', global_name: 'Kitezu', bot: false } }];
      if (query.author_id === 'u7') return { total_results: 1, messages: [[rawHit('c1', kite)]] };
      return { total_results: 0, messages: [] };
    },
  });
  const { result } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: { forms: [], who: ['kitezu'], from: null, to: null } }));
  assert.deepEqual(s.calls.map((c) => [c.route.split('/').at(-2), c.query.query ?? c.query.content ?? c.query.author_id]), [
    ['members', 'kitezu'],
    ['messages', 'kitezu'],
    ['messages', 'u7'],
  ]);
  assert.deepEqual(result.people, [{ id: 'u7', name: 'Kitezu', username: 'kitezu.', count: 1, newestTs: kite.ts }]);
  assert.ok(s.llmCalls[0].messages[1].content.includes('<people>\nKitezu | kitezu. | 1 | 2026-09-19\n</people>'));
  assert.equal(s.data.recallCount, 1, 'the member search and the message searches count as one run');

  const stored = scene({ profiles: [{ id: 'u3', names: ['Éloïse'], aliases: [{ name: 'Ελο' }] }] });
  await withCapturedLogs(() => stored.recaller.run({ ...stored.args, server: { forms: [], who: ['ελο'], from: null, to: null } }));
  assert.ok(!stored.calls.some((c) => c.route.endsWith('/members/search')), 'no member search for a stored name');
  assert.deepEqual(searches(stored.calls).map((c) => c.query.content ?? c.query.author_id), ['ελο', 'u3']);
});

test('recall: a date range alone is sampled at evenly spaced offsets of its total', async () => {
  const day = line('d1', Date.UTC(2025, 11, 18, 15), { content: 'καλημέρα' });
  const s = scene({
    lines: { c1: [day] },
    recall: { dateSamples: 4 },
    answers: (route, query) => ({ total_results: 2115, messages: query.offset ? [] : [[rawHit('c1', day)]] }),
  });
  const from = Date.UTC(2025, 11, 18);
  const to = Date.UTC(2025, 11, 19) - 1;
  await withCapturedLogs(() => s.recaller.run({ ...s.args, server: { forms: [], who: [], from, to } }));
  const sent = searches(s.calls);
  assert.deepEqual(sent.map((c) => c.query.offset ?? '0'), ['0', '528', '1057', '1586']);
  assert.ok(sent.every((c) => !c.query.content && !c.query.author_id && c.query.min_id === snowflakeAt(from) && c.query.max_id === snowflakeAt(to + 1)));
});

test('recall: the daily recall cap and the daily request cap stop it before any request', async () => {
  const capped = scene({ recall: { maxPerDay: 3 }, state: { recallDay: '2026-10-05', recallCount: 3 } });
  const first = await withCapturedLogs(() => capped.recaller.run({ ...capped.args, server: RABBIT_SERVER }));
  assert.equal(capped.calls.length, 0);
  assert.equal(capped.recaller.available(), false);
  assert.deepEqual(first.logs.map((l) => [l.msg, l.reason]), [['recall: skipped', 'daily']]);
  assert.equal(capped.data.recallCount, 3);

  const spent = scene({ capLeft: 0 });
  const second = await withCapturedLogs(() => spent.recaller.run({ ...spent.args, server: RABBIT_SERVER }));
  assert.equal(spent.calls.length, 0);
  assert.deepEqual(second.logs.map((l) => [l.msg, l.reason]), [['recall: skipped', 'daily-cap']]);
  assert.equal(second.result.text, null);
  assert.equal(scene().recaller.available(), true);
});

test('recall: the switch off, a private chat or nothing asked make no request', async () => {
  const off = scene({ features: { recall: false } });
  const quiet = await withCapturedLogs(() => off.recaller.run({ ...off.args, server: RABBIT_SERVER }));
  assert.equal(off.calls.length, 0);
  assert.equal(quiet.logs.length, 0);
  assert.equal(off.recaller.available(), false);

  const dm = scene();
  const priv = await withCapturedLogs(() => dm.recaller.run({ ...dm.args, channel: { id: 'dm1' }, server: RABBIT_SERVER }));
  assert.deepEqual(priv.logs.map((l) => l.reason), ['private-chat']);
  const none = await withCapturedLogs(() => dm.recaller.run({ ...dm.args, server: { forms: [], who: [], from: null, to: null } }));
  assert.deepEqual(none.logs.map((l) => l.reason), ['no-query']);
  assert.equal(dm.calls.length, 0);
});

test('recall: a private chat with its partner searches the server, keeps only what the partner can view, and its own chat bounds nothing', async () => {
  const s = scene({
    lines: { c1: RABBIT_LINES, c2: GARDEN_LINES, c4: PRIVATE_LINES },
    answers: rabbitAnswers,
    memory: {
      getRecent: () => ({
        nextId: 3,
        lines: [
          { id: 1, at: NOW - 2 * HOUR, addedAt: null, channelId: 'c2', text: 'κουνέλι in garden', who: [], weight: 2 },
          { id: 2, at: NOW - 2 * HOUR, addedAt: null, channelId: 'c4', text: 'μυστικό κουνέλι', who: [], weight: 3 },
        ],
      }),
    },
  });
  const dm = { id: 'dm1', guild: null };
  const partner = { id: 'u5', guild: s.args.guild };
  const history = [{ id: 'p1', channelId: 'dm1', ts: NOW - MINUTE, self: false, bot: false, authorName: 'Nikos', content: 'ποιος σκότωσε το κουνέλι;' }];
  const { result } = await withCapturedLogs(() =>
    s.recaller.run({ ...s.args, channel: dm, partner, history, candidate: history[0], server: RABBIT_SERVER }),
  );
  assert.deepEqual(searches(s.calls).map((c) => c.query.content), ['κουνέλι', 'κουνελιού']);
  assert.ok(searches(s.calls).every((c) => c.query.max_id === undefined), 'the private chat is not the server: no search stops at its oldest line');
  assert.ok(!s.fetches.some((f) => f.channel === 'c4'), 'no window of a channel the partner cannot view');
  const user = s.llmCalls[0].messages[1].content;
  assert.ok(user.includes('#general') && user.includes('#garden'), user);
  assert.ok(user.includes('κουνέλι in garden'), user);
  assert.ok(!user.includes('μυστικό'), 'neither a hit nor a recent line of the channel the partner cannot view');
  assert.equal(result.text, 'Ana did it on October 1.');
});

/** Timers fired by hand: `fire(ms)` runs the pending one that was set for `ms`. */
function manualTimers() {
  const all = [];
  return {
    set: (fn, ms) => {
      const timer = { fn, ms, done: false };
      all.push(timer);
      return timer;
    },
    clear: (timer) => {
      timer.done = true;
    },
    fire(ms) {
      const timer = all.find((t) => t.ms === ms && !t.done);
      assert.ok(timer, `a pending timer of ${ms} ms`);
      timer.done = true;
      timer.fn();
    },
    pending: () => all.filter((t) => !t.done).map((t) => t.ms),
  };
}

/** A promise with its resolve at hand. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A pending request that rejects with an AbortError once `signal` aborts. */
function hangUntilAbort(signal) {
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
}

const BUDGET = { timeoutMs: 10000, minSummaryMs: 2500 };

test('recall: a search still out at 60 % of the budget is cut; with nothing found there is no text and no summary', async () => {
  const timers = manualTimers();
  const sent = deferred();
  const s = scene({
    recall: BUDGET,
    timers,
    answers: (route, query, signal) => {
      sent.resolve();
      return hangUntilAbort(signal);
    },
  });
  const { result, logs } = await withCapturedLogs(async () => {
    const running = s.recaller.run({ ...s.args, server: RABBIT_SERVER });
    await sent.promise;
    assert.deepEqual(timers.pending().sort((a, b) => a - b), [BUDGET.timeoutMs * 0.6, BUDGET.timeoutMs]);
    timers.fire(BUDGET.timeoutMs * 0.6);
    return running;
  });
  assert.deepEqual([result.text, result.stretch], [null, null]);
  assert.ok(s.calls[0].signal.aborted);
  assert.equal(searches(s.calls).length, 1, 'no further search after the cut');
  assert.deepEqual([result.stats.queries, result.stats.failed], [1, 1]);
  assert.ok(logs.some((l) => l.msg === 'recall: skipped' && l.reason === 'no-hits'));
  assert.ok(!logs.some((l) => l.msg === 'recall: summary'));
  assert.equal(s.llmCalls.length, 0);
  assert.deepEqual(timers.pending(), [], 'both timers cleared');
});

test('recall: a cut search keeps what the earlier ones found; the summary gets the rest of the budget', async () => {
  const timers = manualTimers();
  const second = deferred();
  let t = NOW;
  const s = scene({
    lines: { c1: RABBIT_LINES },
    recall: BUDGET,
    timers,
    now: () => t,
    answers: (route, query, signal) => {
      if (query.content === 'κουνέλι') {
        t = NOW + 3000;
        return rabbitAnswers(route, query);
      }
      second.resolve();
      return hangUntilAbort(signal);
    },
  });
  const { result } = await withCapturedLogs(async () => {
    const running = s.recaller.run({ ...s.args, server: { ...RABBIT_SERVER, forms: ['κουνέλι', 'κουνελιού', 'κήπος'] } });
    await second.promise;
    t = NOW + BUDGET.timeoutMs * 0.6;
    timers.fire(BUDGET.timeoutMs * 0.6);
    return running;
  });
  assert.deepEqual(searches(s.calls).map((c) => c.query.content), ['κουνέλι', 'κουνελιού'], 'the third form is never sent');
  assert.deepEqual(s.fetches.map((f) => f.around), ['r3', 'g1'], 'the first search\'s hits reach the windows');
  assert.equal(s.llmCalls[0].options.timeoutMs, BUDGET.timeoutMs * 0.4, 'the summary is limited to what is left');
  assert.equal(result.text, 'Ana did it on October 1.');
  assert.equal(result.stats.summary, 'answered');
});

test('recall: no search is sent once half of the budget is gone', async () => {
  let t = NOW;
  const s = scene({
    lines: { c1: RABBIT_LINES },
    recall: BUDGET,
    now: () => t,
    answers: (route, query) => {
      t = NOW + BUDGET.timeoutMs * 0.5;
      return rabbitAnswers(route, query);
    },
  });
  const { result } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
  assert.equal(searches(s.calls).length, 1);
  assert.deepEqual([result.stats.planned, result.stats.queries], [2, 1]);
  assert.equal(s.llmCalls[0].options.timeoutMs, BUDGET.timeoutMs * 0.5);
});

test('recall: the windows of the kept clusters are fetched together', async () => {
  const s = scene({ lines: { c1: RABBIT_LINES, c2: GARDEN_LINES }, answers: rabbitAnswers });
  let inFlight = 0;
  let most = 0;
  for (const id of ['c1', 'c2']) {
    const messages = s.args.guild.channels.cache.get(id).messages;
    const fetch = messages.fetch;
    messages.fetch = async (options) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return fetch(options);
    };
  }
  await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
  assert.equal(s.fetches.length, 2);
  assert.equal(most, 2, 'both windows were out at once');
});

/** The rabbit scene plus a newer one-hit cluster in #garden: the newest cluster is not the best-matched one. */
const GARDEN_AGAIN = line('g9', RABBIT + 2 * HOUR, { name: 'Éloïse', author: 'u3', content: 'κουνέλι ξανά' });
function rankedAnswers(route, query) {
  if (route.endsWith('/members/search')) return [];
  if (query.content !== 'κουνέλι') return { total_results: 0, messages: [] };
  return { total_results: 3, messages: [[rawHit('c2', GARDEN_AGAIN)], [rawHit('c1', RABBIT_LINES[3])], [rawHit('c1', RABBIT_LINES[2])]] };
}
const RANKED_LINES = { c1: RABBIT_LINES, c2: [...GARDEN_LINES, GARDEN_AGAIN] };

test('recall: each hit carries the queries that found it; the cluster two forms meet in outranks a newer one-form hit', async () => {
  const bothForms = (route, query) => {
    if (route.endsWith('/members/search')) return [];
    if (query.content === 'κουνελιού') return { total_results: 1, messages: [[rawHit('c1', RABBIT_LINES[2])]] };
    return rankedAnswers(route, query);
  };
  const dense = scene({ lines: RANKED_LINES, answers: bothForms, recall: { maxClusters: 1 } });
  await withCapturedLogs(() => dense.recaller.run({ ...dense.args, server: RABBIT_SERVER }));
  assert.deepEqual(dense.fetches.map((f) => f.around), ['r3'], 'r2 found by both forms: the rabbit cluster counts two queries');
  const plain = scene({ lines: RANKED_LINES, answers: rankedAnswers, recall: { maxClusters: 1 } });
  await withCapturedLogs(() => plain.recaller.run({ ...plain.args, server: RABBIT_SERVER }));
  assert.deepEqual(plain.fetches.map((f) => f.around), ['g9'], 'one form each: the newer cluster wins the tie');
});
test('recall: a form whose search totals at most recall.rareHits is rare: the old cluster it found beats a newer one-form hit', async () => {
  const rareOld = (route, query) => {
    if (route.endsWith('/members/search')) return [];
    if (query.content === 'κουνέλι') return { total_results: 40, messages: [[rawHit('c2', GARDEN_AGAIN)]] };
    if (query.content === 'κουνελιού') return { total_results: 1, messages: [[rawHit('c1', RABBIT_LINES[2])]] };
    return { total_results: 0, messages: [] };
  };
  const rare = scene({ lines: RANKED_LINES, answers: rareOld, recall: { maxClusters: 1, rareHits: 5 } });
  await withCapturedLogs(() => rare.recaller.run({ ...rare.args, server: RABBIT_SERVER }));
  assert.deepEqual(rare.fetches.map((f) => f.around), ['r2'], 'one hit on the whole server: the rare form weighs two');
  const off = scene({ lines: RANKED_LINES, answers: rareOld, recall: { maxClusters: 1, rareHits: 0 } });
  await withCapturedLogs(() => off.recaller.run({ ...off.args, server: RABBIT_SERVER }));
  assert.deepEqual(off.fetches.map((f) => f.around), ['g9'], 'rareHits 0: one form each, the newer cluster wins the tie');
});
test('recall: name and author queries locate the person, the forms rank: an older two-form cluster beats a newer one of the person', async () => {
  const answers = (route, query) => {
    if (route.endsWith('/members/search')) return [];
    if (query.content === 'κουνέλι') return { total_results: 2, messages: [[rawHit('c1', RABBIT_LINES[3])], [rawHit('c1', RABBIT_LINES[2])]] };
    if (query.content === 'κουνελιού') return { total_results: 1, messages: [[rawHit('c1', RABBIT_LINES[2])]] };
    if (query.content === 'éloïse' || query.author_id === 'u3') return { total_results: 1, messages: [[rawHit('c2', GARDEN_AGAIN)]] };
    return { total_results: 0, messages: [] };
  };
  const s = scene({ lines: RANKED_LINES, answers, recall: { maxClusters: 1 }, profiles: [{ id: 'u3', names: ['Éloïse'] }] });
  await withCapturedLogs(() => s.recaller.run({ ...s.args, server: { ...RABBIT_SERVER, who: ['éloïse'] } }));
  assert.deepEqual(
    searches(s.calls).map((c) => c.query.content ?? c.query.author_id),
    ['κουνέλι', 'éloïse', 'κουνελιού', 'u3'],
    'server and name forms round-robin, then the author',
  );
  assert.deepEqual(s.fetches.map((f) => f.around), ['r3'], 'the newer cluster has a name and an author hit, no form');
});
const RANKED_STRETCH = [
  '[18:38] Βασίλης: πάμε κυνήγι',
  '[18:40] Ana: bang [image]',
  `${HIT_MARK}[18:44] Βασίλης: το κουνέλι πέθανε`,
  `${HIT_MARK}[18:46] Ana: κηδεία για το κουνέλι`,
].join('\n');

test('recall: a summary that fails or times out returns the first-ranked window verbatim, without a text', async () => {
  const cases = [
    [new Error('fixture: provider down'), 'failed'],
    [Object.assign(new Error('fixture: cut at its limit'), { name: 'TimeoutError' }), 'timeout'],
  ];
  for (const [answer, kind] of cases) {
    const s = scene({ lines: RANKED_LINES, answers: rankedAnswers, answer, recall: BUDGET });
    const { result, logs } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
    assert.equal(s.llmCalls.length, 1, kind);
    assert.equal(result.text, null, kind);
    assert.equal(result.stretch.channelId, 'c1', `${kind}: the best-matched of the newest three, not the newest`);
    assert.equal(result.stretch.lines, RANKED_STRETCH, kind);
    assert.equal(result.stretch.startTs, RABBIT_LINES[0].ts, kind);
    assert.equal(result.stats.summary, kind);
    const summary = logs.find((l) => l.msg === 'recall: summary');
    assert.deepEqual([summary.answer, summary.summary, summary.stretch], ['fallback', kind, true], kind);
    assert.equal(logs.find((l) => l.msg === 'recall: failed').name, answer.name, kind);
  }
});

test('recall: the fallback stretch is cut by recall.stretchChars, and none is shown with it at 0', async () => {
  const cut = scene({ lines: RANKED_LINES, answers: rankedAnswers, answer: new Error('fixture'), recall: { ...BUDGET, stretchChars: 60 } });
  const first = await withCapturedLogs(() => cut.recaller.run({ ...cut.args, server: RABBIT_SERVER }));
  assert.deepEqual(first.result.stretch.lines.split('\n'), RANKED_STRETCH.split('\n').slice(2));

  const none = scene({ lines: RANKED_LINES, answers: rankedAnswers, answer: new Error('fixture'), recall: { ...BUDGET, stretchChars: 0 } });
  const second = await withCapturedLogs(() => none.recaller.run({ ...none.args, server: RABBIT_SERVER }));
  assert.deepEqual([second.result.text, second.result.stretch, second.result.stats.summary], [null, null, 'failed']);
  assert.equal(second.logs.find((l) => l.msg === 'recall: summary').stretch, false);
});

test('recall: with less than recall.minSummaryMs left the summary is skipped and the fallback returned at once', async () => {
  let t = NOW;
  const s = scene({
    lines: RANKED_LINES,
    recall: BUDGET,
    now: () => t,
    answers: (route, query) => {
      t = NOW + BUDGET.timeoutMs - BUDGET.minSummaryMs + 1;
      return rankedAnswers(route, query);
    },
  });
  const { result, logs } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
  assert.equal(s.llmCalls.length, 0);
  assert.equal(result.text, null);
  assert.equal(result.stretch.lines, RANKED_STRETCH);
  assert.equal(result.stats.summary, 'skipped');
  const summary = logs.find((l) => l.msg === 'recall: summary');
  assert.deepEqual([summary.answer, summary.summary, summary.ms], ['fallback', 'skipped', 0]);
  assert.ok(!logs.some((l) => l.msg === 'recall: failed'));
});

test('recall: the run budget running out during the summary aborts it and returns the fallback', async () => {
  const timers = manualTimers();
  const asked = deferred();
  const s = scene({
    lines: RANKED_LINES,
    answers: rankedAnswers,
    recall: BUDGET,
    timers,
    answer: (messages, options) => {
      asked.resolve();
      return hangUntilAbort(options.signal);
    },
  });
  const { result, logs } = await withCapturedLogs(async () => {
    const running = s.recaller.run({ ...s.args, server: RABBIT_SERVER });
    await asked.promise;
    timers.fire(BUDGET.timeoutMs);
    return running;
  });
  assert.ok(s.llmCalls[0].options.signal.aborted);
  assert.equal(result.text, null);
  assert.equal(result.stretch.lines, RANKED_STRETCH);
  assert.equal(result.stats.summary, 'timeout');
  assert.ok(logs.some((l) => l.msg === 'recall: failed' && l.reason === 'timeout'));
  const summary = logs.find((l) => l.msg === 'recall: summary');
  assert.deepEqual([summary.answer, summary.summary], ['fallback', 'timeout']);
});

test('recall: the run budget running out before the windows are read abandons it with nothing', async () => {
  const timers = manualTimers();
  const reading = deferred();
  const s = scene({ lines: RANKED_LINES, answers: rankedAnswers, recall: BUDGET, timers });
  for (const id of ['c1', 'c2']) {
    s.args.guild.channels.cache.get(id).messages.fetch = () => {
      reading.resolve();
      return new Promise(() => {});
    };
  }
  const { result, logs } = await withCapturedLogs(async () => {
    const running = s.recaller.run({ ...s.args, server: RABBIT_SERVER });
    await reading.promise;
    timers.fire(BUDGET.timeoutMs);
    return running;
  });
  assert.deepEqual([result.text, result.stretch, result.stats.summary], [null, null, null]);
  assert.ok(logs.some((l) => l.msg === 'recall: failed' && l.reason === 'timeout'));
  assert.ok(!logs.some((l) => l.msg === 'recall: summary'));
  assert.equal(s.llmCalls.length, 0);
});

test('recall: a nothing answer gives no text and no stretch; a refused summary logs its rail code', async () => {
  const s = scene({ lines: { c1: RABBIT_LINES }, answers: rabbitAnswers, answer: 'nothing' });
  const { result, logs } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
  assert.deepEqual([result.text, result.stretch], [null, null]);
  const summary = logs.find((l) => l.msg === 'recall: summary');
  assert.deepEqual([summary.answer, summary.stretch], ['nothing', false]);

  const refused = scene({ lines: { c1: RABBIT_LINES }, answers: rabbitAnswers, answer: new DailyCapError('cap') });
  const second = await withCapturedLogs(() => refused.recaller.run({ ...refused.args, server: RABBIT_SERVER }));
  assert.equal(second.result.text, null);
  assert.equal(second.logs.find((l) => l.msg === 'recall: failed').reason, 'daily-cap');
});

test('recall: no hit left skips the summary', async () => {
  const s = scene();
  const { result, logs } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
  assert.equal(result.text, null);
  assert.equal(s.llmCalls.length, 0);
  assert.ok(logs.some((l) => l.msg === 'recall: skipped' && l.reason === 'no-hits'));
});

test('recall: a window shows the cached caption of its picture and asks for no fresh one', async () => {
  const asked = [];
  const describer = {
    cachedDescriptions: (guildId, items) => {
      asked.push(items.map((i) => i.itemId));
      return new Map([['p1', 'ένα κουνέλι στο γρασίδι']]);
    },
    describeMany: async () => {
      throw new Error('fixture: no fresh caption may be asked');
    },
  };
  const s = scene({ lines: { c1: RABBIT_LINES }, answers: rabbitAnswers, describer });
  await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
  assert.deepEqual(asked, [['p1']]);
  assert.ok(s.llmCalls[0].messages[1].content.includes('Ana: bang [image: ένα κουνέλι στο γρασίδι]'));

  const blind = scene({ lines: { c1: RABBIT_LINES }, answers: rabbitAnswers, describer, features: { mediaDescriptions: false } });
  await withCapturedLogs(() => blind.recaller.run({ ...blind.args, server: RABBIT_SERVER }));
  assert.equal(asked.length, 1, 'captions off: the cache is not asked');
  assert.ok(blind.llmCalls[0].messages[1].content.includes('Ana: bang [image]'));
});

test('recall: the stretch is the named window without indices; out of range names none; the cut keeps matched lines', async () => {
  const s = scene({ lines: { c1: RABBIT_LINES, c2: GARDEN_LINES }, answers: rabbitAnswers, answer: 'stretch: 2\nÉloïse saw one.' });
  const { result } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
  assert.equal(result.stretch.channelId, 'c2');
  assert.equal(result.stretch.startTs, GARDEN_LINES[0].ts);
  assert.equal(result.stretch.lines, `${HIT_MARK}[12:44] Éloïse: ένα κουνέλι στον κήπο\n[12:45] Ana: ωραίο`);

  const far = scene({ lines: { c1: RABBIT_LINES, c2: GARDEN_LINES }, answers: rabbitAnswers, answer: 'stretch: 3\nÉloïse saw one.' });
  const second = await withCapturedLogs(() => far.recaller.run({ ...far.args, server: RABBIT_SERVER }));
  assert.equal(second.result.stretch, null);
  assert.equal(second.result.text, 'Éloïse saw one.');

  const cut = scene({ lines: { c1: RABBIT_LINES }, answers: rabbitAnswers, recall: { stretchChars: 60 }, answer: 'stretch: 1\nAna.' });
  const third = await withCapturedLogs(() => cut.recaller.run({ ...cut.args, server: RABBIT_SERVER }));
  const kept = third.result.stretch.lines.split('\n');
  assert.deepEqual(kept, [`${HIT_MARK}[18:44] Βασίλης: το κουνέλι πέθανε`, `${HIT_MARK}[18:46] Ana: κηδεία για το κουνέλι`]);
});

test('recall: logs carry counts, ids and codes, never a form, a name or a message', async () => {
  const s = scene({ lines: { c1: RABBIT_LINES, c2: GARDEN_LINES }, answers: rabbitAnswers, profiles: [{ id: 'u3', names: ['Éloïse'], aliases: [] }] });
  const { logs } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: { ...RABBIT_SERVER, who: ['éloïse'] } }));
  const text = JSON.stringify(logs);
  for (const secret of ['κουνέλι', 'κουνελιού', 'éloïse', 'Éloïse', 'Βασίλης', 'πέθανε', 'Ana did it', 'general', 'garden']) {
    assert.ok(!text.includes(secret), secret);
  }
  assert.ok(logs.some((l) => l.msg === 'recall: searched' && Number.isInteger(l.queries)));
});

// ---- stored memory ---------------------------------------------------------------------------

const ANA_ID = '411111111111111111';
const ELO_ID = '433333333333333333';
const MEMORY_PROFILES = [
  {
    id: ANA_ID,
    names: ['Ana'],
    aliases: [],
    episodes: [
      { date: '2026-10-01', what: `held a funeral for the κουνέλι with <@${ELO_ID}>`, quote: 'ο δολοφόνος έρχεται στην κηδεία', feeling: '', weight: 5, addedAt: '2026-10-01T20:00:00.000Z' },
      { date: '2026-09-20', what: 'baked bread', quote: '', feeling: 'thinks of the κουνέλι', weight: 5, addedAt: '2026-09-20T20:00:00.000Z' },
    ],
  },
  { id: ELO_ID, names: ['Éloïse'], aliases: [], episodes: [] },
];
const MEMORY_LORE = [{ id: 'l1', title: 'Το κουνέλι', keys: ['κουνέλι'], text: 'The rabbit of the main channel.', weight: 3 }];
const FUNERAL_LINE = `episode | 2026-10-01 | Ana | held a funeral for the κουνέλι with Éloïse "ο δολοφόνος έρχεται στην κηδεία"`;
const LORE_LINE = 'lore | - | - | Το κουνέλι: The rabbit of the main channel.';

test('recall: stored memory is read before any Discord request and reaches the summary as <memory> before <found>', async () => {
  let readAt = null;
  const holder = {};
  const s = scene({
    lines: { c1: RABBIT_LINES },
    answers: rabbitAnswers,
    profiles: MEMORY_PROFILES,
    memory: {
      getLore: () => {
        readAt ??= holder.scene.calls.length;
        return MEMORY_LORE;
      },
    },
  });
  holder.scene = s;
  const { result, logs } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
  assert.equal(readAt, 0, 'no Discord request before the memory was read');
  const user = s.llmCalls[0].messages[1].content;
  assert.ok(user.startsWith(['<memory>', FUNERAL_LINE, LORE_LINE, '</memory>', '<found>\n'].join('\n')), user);
  assert.ok(!user.includes('baked bread'), 'a feeling is never searched');
  assert.equal(result.stats.memory, 2);
  assert.equal(logs.find((l) => l.msg === 'recall: searched').memory, 2);
  assert.equal(result.text, 'Ana did it on October 1.');
});

test('recall: stored memory alone still asks the summary; without an answer it gives nothing verbatim', async () => {
  const s = scene({ profiles: MEMORY_PROFILES, recall: { maxForms: 0 } });
  const { result, logs } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
  assert.equal(searches(s.calls).length, 0, 'no form query at maxForms 0');
  assert.equal(s.llmCalls.length, 1);
  const user = s.llmCalls[0].messages[1].content;
  assert.ok(user.startsWith(`<memory>\n${FUNERAL_LINE}\n</memory>\n<question>`), user);
  assert.ok(!user.includes('<found>'));
  assert.deepEqual([result.text, result.stretch, result.stats.summary], ['Ana did it on October 1.', null, 'answered']);
  assert.equal(s.data.recallCount, 1, 'the summary counts the run');
  assert.ok(!logs.some((l) => l.msg === 'recall: skipped'));

  const failed = scene({ profiles: MEMORY_PROFILES, answer: new Error('fixture: provider down') });
  const second = await withCapturedLogs(() => failed.recaller.run({ ...failed.args, server: RABBIT_SERVER }));
  assert.equal(searches(failed.calls).length, 2, 'the forms were searched and found nothing');
  assert.equal(failed.llmCalls.length, 1);
  assert.deepEqual([second.result.text, second.result.stretch, second.result.stats.summary], [null, null, 'failed']);
});

test('recall: a recent line from a channel the audience cannot see is left out; a private layer is never read', async () => {
  const at = NOW - 2 * HOUR;
  const recent = {
    nextId: 4,
    lines: [
      { id: 1, at, addedAt: null, channelId: 'c1', text: 'κουνέλι in general', who: [], weight: 2 },
      { id: 2, at: at - HOUR, addedAt: null, channelId: 'c2', text: 'κουνέλι in garden', who: [], weight: 2 },
      { id: 3, at, addedAt: null, channelId: 'c4', text: 'μυστικό κουνέλι', who: [], weight: 3 },
    ],
  };
  const learned = [{ id: 1, text: 'the κουνέλι was called Bun', from: `<@${ELO_ID}>`, weight: 1, firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-02T00:00:00.000Z' }];
  let privateReads = 0;
  const s = scene({
    profiles: MEMORY_PROFILES,
    memory: {
      getRecent: () => structuredClone(recent),
      getGuild: () => ({ learned }),
      getPrivate: () => {
        privateReads += 1;
        return { episodes: [{ date: '2026-10-01', what: 'κουνέλι secret', weight: 5 }] };
      },
    },
  });
  await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
  const user = s.llmCalls[0].messages[1].content;
  assert.ok(user.includes('recent | 2026-10-05 | - | κουνέλι in general'), user);
  assert.ok(user.includes('recent | 2026-10-05 | - | κουνέλι in garden'), user);
  assert.ok(user.includes('learned | - | Éloïse | the κουνέλι was called Bun'), user);
  assert.ok(!user.includes('μυστικό'), 'the line of a channel @everyone cannot view');
  assert.ok(!user.includes('secret'));
  assert.equal(privateReads, 0);
});

test('recall: the memory switches gate each store; recall.memoryItems caps the items', async () => {
  const memory = { getLore: () => MEMORY_LORE };
  const run = async (options) => {
    const s = scene({ profiles: MEMORY_PROFILES, memory, ...options });
    const { result } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
    return { user: s.llmCalls[0]?.messages[1].content ?? '', result };
  };
  const noEpisodes = await run({ features: { episodes: false } });
  assert.ok(noEpisodes.user.includes(LORE_LINE) && !noEpisodes.user.includes('funeral'));
  const noLore = await run({ features: { lore: false } });
  assert.ok(noLore.user.includes(FUNERAL_LINE) && !noLore.user.includes('lore |'));
  const off = await run({ features: { memory: false } });
  assert.deepEqual([off.user, off.result.stats.memory], ['', 0], 'memory off: nothing to ask about');
  const one = await run({ recall: { memoryItems: 1 } });
  assert.ok(one.user.includes(`<memory>\n${FUNERAL_LINE}\n</memory>`));
  const none = await run({ recall: { memoryItems: 0 } });
  assert.equal(none.user, '');
});

// ---- the current conversation, the persona's own stretches, the context, the trace ------------

/** #general holds the turn's chat (h1, h2) and, just before it, an older hit x1; #garden a stretch with the persona's line. */
const CHAT_LINES = {
  c1: [
    line('x1', NOW - 40 * MINUTE, { content: 'το κουνέλι ξανά' }),
    line('h1', NOW - 30 * MINUTE, { name: 'Nikos', author: 'u9', content: 'τι έγινε με το κουνέλι;' }),
    line('h2', NOW - MINUTE, { name: 'Nikos', author: 'u9', content: 'ποιος σκότωσε το κουνέλι;' }),
  ],
  c2: [GARDEN_LINES[0], line('g3', GARDEN_LINES[0].ts + 2 * MINUTE, { name: 'Zoë', author: 'self', content: 'το είδα κι εγώ' })],
};

/** `κουνέλι` finds x1, the chat's own h2 and the garden line. */
function chatAnswers(route, query) {
  if (route.endsWith('/members/search')) return [];
  if (query.content === 'κουνέλι') {
    return { total_results: 3, messages: [[rawHit('c1', CHAT_LINES.c1[2])], [rawHit('c1', CHAT_LINES.c1[0])], [rawHit('c2', CHAT_LINES.c2[0])]] };
  }
  return { total_results: 0, messages: [] };
}

/** The fixture labels with the two stretch flags (the shipped wording is the writer's). */
const FLAGGED = { ...labels, lookup: { ...labels.lookup, stretchSelf: '[SELF]', stretchCurrent: '[CURRENT]' } };

test('recall: hits shown in the chat are dropped and counted; a window reaching into the chat and one with the persona\'s line are flagged', async () => {
  const s = scene({ lines: CHAT_LINES, answers: chatAnswers, recall: { maxClusters: 2, selfExtra: 0 } });
  s.hot.prompts.labels = FLAGGED;
  const { result, logs } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
  assert.equal(result.stats.inChatDropped, 1);
  assert.equal(result.stats.selfClusters, 1);
  assert.deepEqual(s.fetches.map((f) => f.around).sort(), ['g1', 'x1'], 'no window is centred on a chat line');
  const user = s.llmCalls[0].messages[1].content;
  const headers = user.split('\n').filter((l) => l.startsWith('## '));
  assert.deepEqual(headers, ['## 1 | 2026-10-05 | #general [CURRENT]', '## 2 | 2026-09-30 | #garden [SELF]']);
  assert.ok(!user.slice(user.indexOf('<found>'), user.indexOf('</found>')).includes('ποιος σκότωσε'), 'the chat lines stay out of the windows');
  const searched = logs.find((l) => l.msg === 'recall: searched');
  assert.deepEqual([searched.inChatDropped, searched.selfClusters], [1, 1]);
});

test('recall: recall.selfExtra more windows are fetched and the persona\'s stretch wins with recall.selfBonus', async () => {
  const bonus = scene({ lines: CHAT_LINES, answers: chatAnswers, recall: { maxClusters: 1, selfExtra: 1, selfBonus: 1 } });
  const first = await withCapturedLogs(() => bonus.recaller.run({ ...bonus.args, server: RABBIT_SERVER }));
  assert.equal(bonus.fetches.length, 2, 'maxClusters + selfExtra windows');
  assert.equal(first.result.stats.clusters, 1);
  assert.equal(first.result.stretch.channelId, 'c2', 'one form each: the older stretch with the persona\'s line outranks the newer one');

  const flat = scene({ lines: CHAT_LINES, answers: chatAnswers, recall: { maxClusters: 1, selfExtra: 1, selfBonus: 0 } });
  const second = await withCapturedLogs(() => flat.recaller.run({ ...flat.args, server: RABBIT_SERVER }));
  assert.equal(second.result.stretch.channelId, 'c1', 'no bonus: the newer cluster wins the tie');

  const narrow = scene({ lines: CHAT_LINES, answers: chatAnswers, recall: { maxClusters: 1, selfExtra: 0, selfBonus: 1 } });
  await withCapturedLogs(() => narrow.recaller.run({ ...narrow.args, server: RABBIT_SERVER }));
  assert.deepEqual(narrow.fetches.map((f) => f.around), ['x1'], 'no extra window: the bonus has nothing to re-rank');
});

test('recall: the summary reads the last recall.contextMessages chat lines as <context> right before <question>', async () => {
  const s = scene({ lines: CHAT_LINES, answers: chatAnswers, recall: { contextMessages: 6 } });
  const routed = [{ id: 'o1', channelId: 'c2', ts: NOW - 2 * MINUTE, self: true, bot: false, authorName: 'Zoë', content: 'σε άλλο κανάλι' }, s.args.history[1]];
  await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
  const user = s.llmCalls[0].messages[1].content;
  assert.match(user, /<\/found>\n<context>\n=== .+ ===\n#\d+ \[11:30\] Nikos: τι έγινε με το κουνέλι;\n<\/context>\n<question>\nNikos: ποιος σκότωσε το κουνέλι;\n<\/question>$/);

  const other = scene({ lines: CHAT_LINES, answers: chatAnswers, recall: { contextMessages: 6 } });
  await withCapturedLogs(() => other.recaller.run({ ...other.args, context: routed, server: RABBIT_SERVER }));
  const withRouted = other.llmCalls[0].messages[1].content;
  assert.match(withRouted, /<context>\n=== .+ ===\n#\d+ \[11:58\] Zoë \(you\): σε άλλο κανάλι\n<\/context>/, 'the lines the question was read in; own lines under labels.self');

  const off = scene({ lines: CHAT_LINES, answers: chatAnswers, recall: { contextMessages: 0 } });
  await withCapturedLogs(() => off.recaller.run({ ...off.args, server: RABBIT_SERVER }));
  assert.ok(!off.llmCalls[0].messages[1].content.includes('<context>'));
});

/** A real store in a fresh temporary directory (never data/), and its trace file of guild g1. */
function tempStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-trace-'));
  const store = createStore({ dataDir });
  const file = path.join(dataDir, 'guilds', GUILD, 'recall-trace.jsonl');
  const lines = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { store, file, lines, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test('recall: with features.recallTrace on every run appends one trace line with the clusters, the summary and its stretch', async () => {
  const t = tempStore();
  try {
    const s = scene({
      lines: CHAT_LINES,
      answers: chatAnswers,
      features: { recallTrace: true },
      recall: { maxClusters: 1, selfExtra: 1 },
      memory: { appendRecallTrace: (...args) => t.store.appendRecallTrace(...args) },
    });
    const { result } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
    const [record, ...rest] = t.lines();
    assert.equal(rest.length, 0);
    assert.deepEqual(Object.keys(record), ['at', 'channelId', 'triggerId', 'forms', 'who', 'when', 'hits', 'inChatDropped', 'clusters', 'summary', 'lookupChars']);
    assert.equal(record.at, new Date(NOW).toISOString());
    assert.deepEqual([record.channelId, record.triggerId, record.forms, record.who, record.when], ['c1', 'h2', RABBIT_SERVER.forms, [], null]);
    assert.deepEqual([record.hits, record.inChatDropped], [3, 1]);
    assert.deepEqual(record.clusters, [
      { channelId: 'c1', from: new Date(CHAT_LINES.c1[0].ts).toISOString(), to: new Date(CHAT_LINES.c1[0].ts).toISOString(), score: 1, queries: 1, self: false, overlapsChat: true, kept: false },
      { channelId: 'c2', from: new Date(GARDEN_LINES[0].ts).toISOString(), to: new Date(GARDEN_LINES[0].ts).toISOString(), score: 2, queries: 1, self: true, overlapsChat: false, kept: true },
    ]);
    assert.deepEqual(record.summary, {
      answer: 'text',
      stretch: { n: 1, channelId: 'c2', channelName: 'garden', lines: result.stretch.lines },
      text: 'Ana did it on October 1.',
    });
    assert.ok(record.summary.stretch.lines.includes('το είδα κι εγώ'), 'the stretch lines themselves');
    assert.equal(record.lookupChars, [...result.text].length + [...result.stretch.lines].length);
  } finally {
    t.cleanup();
  }
});

test('recall: with features.recallTrace off or missing no trace is written', async () => {
  for (const features of [{ recallTrace: false }, {}]) {
    const t = tempStore();
    try {
      const s = scene({ lines: CHAT_LINES, answers: chatAnswers, features, memory: { appendRecallTrace: (...args) => t.store.appendRecallTrace(...args) } });
      if (!('recallTrace' in features)) delete s.hot.config.features.recallTrace;
      await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
      assert.equal(s.llmCalls.length, 1, 'the run itself went on');
      assert.equal(fs.existsSync(t.file), false, JSON.stringify(features));
    } finally {
      t.cleanup();
    }
  }
});

test('recall: the trace keeps the newest recall.traceMaxLines lines', async () => {
  const t = tempStore();
  try {
    let clock = NOW;
    const s = scene({
      lines: CHAT_LINES,
      answers: chatAnswers,
      features: { recallTrace: true },
      recall: { traceMaxLines: 2 },
      now: () => clock,
      memory: { appendRecallTrace: (...args) => t.store.appendRecallTrace(...args) },
    });
    for (let i = 0; i < 4; i += 1) {
      clock = NOW + i * MINUTE;
      await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
    }
    assert.deepEqual(t.lines().map((r) => r.at), [new Date(NOW + 2 * MINUTE).toISOString(), new Date(NOW + 3 * MINUTE).toISOString()]);
  } finally {
    t.cleanup();
  }
});

test('recall: the searched log line carries counts only, never a text, with the trace on', async () => {
  const t = tempStore();
  try {
    const s = scene({ lines: CHAT_LINES, answers: chatAnswers, features: { recallTrace: true }, memory: { appendRecallTrace: (...args) => t.store.appendRecallTrace(...args) } });
    const { logs } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
    const searched = logs.find((l) => l.msg === 'recall: searched');
    const { msg, level, time, channel, ...fields } = searched;
    assert.equal(channel, 'c1');
    for (const [key, value] of Object.entries(fields)) assert.equal(typeof value, 'number', key);
    assert.ok('inChatDropped' in fields && 'selfClusters' in fields);
    const all = JSON.stringify(logs);
    for (const text of ['κουνέλι', 'Ana did it', 'το είδα']) assert.ok(!all.includes(text), text);
  } finally {
    t.cleanup();
  }
});

// ---- the archive and the recent record ---------------------------------------------------------

/** A record line of a channel near NOW (src/memory/record.js#toRecordLine), private ones scoped to their owner. */
function recLine(id, ts, text, { channelId = 'c2', by = ANA_ID, owner = null } = {}) {
  const line = toRecordLine({ id, channelId, authorId: by, content: text, ts }, { now: () => NOW, uuid: () => `x-${id}` });
  return owner ? { ...line, scope: { user: owner, private: true, channel: channelId } } : line;
}

/** An archive entry of `itemKind` (the fields recall reads). */
function archEntry(itemId, itemKind, text, scope) {
  return { v: 1, id: `a-${itemId}`, kind: 'archive', event: 'evicted', itemKind, itemId, revisionId: 'rv-1', scope, participants: [], observedAt: { date: '2026-10-04', precision: 'day' }, neutral: null, text, stored: {}, recordedAt: '2026-10-05T00:00:00.000Z', guildId: GUILD };
}

/** A fake archive or record: `iterate` streams the list of the base it is asked for (the guild's, or a private owner's). */
function fakeSource(byBase) {
  const queries = [];
  return {
    queries,
    async *iterate(guildId, query = {}) {
      queries.push(query);
      yield* byBase[query.privateUserId ?? 'guild'] ?? [];
    },
  };
}

const RECENT_SERVER = { forms: ['κουνέλι'], who: [], from: null, to: null, recent: true };

test('recall-run: a channel the member cannot read is skipped before matching', async () => {
  const record = fakeSource({
    guild: [recLine('r-c2', NOW - 2 * HOUR, 'κουνέλι στον κήπο σήμερα'), recLine('r-c4', NOW - HOUR, 'μυστικό κουνέλι', { channelId: 'c4' })],
  });
  const archive = fakeSource({
    guild: [archEntry('rc-2', 'recent', { text: 'κουνέλι archived in the garden' }, { channel: 'c2' }), archEntry('rc-4', 'recent', { text: 'μυστικό κουνέλι archived' }, { channel: 'c4' })],
  });
  const s = scene({ profiles: MEMORY_PROFILES, record, archive });
  const { result } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RECENT_SERVER }));
  const user = s.llmCalls[0].messages[1].content;
  assert.ok(user.includes('archived recent | 2026-10-04 | - | κουνέλι archived in the garden'), user);
  assert.ok(user.includes('κουνέλι στον κήπο σήμερα') && user.includes('#garden | source: record'), user);
  assert.ok(!user.includes('μυστικό'), 'neither a record line nor an archived item of the channel @everyone cannot view');
  assert.equal(result.stats.record, 1);
  assert.ok(Date.parse(record.queries[0].from) >= NOW - 3 * 24 * HOUR, 'the last recordDays');
});

test('recall-run: a dateless question with no recent cue reads the record too, recordDays 0 reads none', async () => {
  const lines = () => fakeSource({ guild: [recLine('r-old', NOW - 2 * 24 * HOUR, 'κουνέλι στον κήπο τότε')] });
  const record = lines();
  const s = scene({ profiles: MEMORY_PROFILES, record });
  const { result } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
  assert.equal(result.stats.record, 1, 'no when: range and no recent cue, the record is still read');
  assert.ok(s.llmCalls[0].messages[1].content.includes('κουνέλι στον κήπο τότε'));
  assert.ok(Date.parse(record.queries[0].from) >= NOW - 3 * 24 * HOUR, 'the last recordDays');

  const offRecord = lines();
  const off = scene({ profiles: MEMORY_PROFILES, record: offRecord, recall: { recordDays: 0 } });
  const { result: offResult } = await withCapturedLogs(() => off.recaller.run({ ...off.args, server: RABBIT_SERVER }));
  assert.equal(offResult.stats.record, 0);
  assert.equal(offRecord.queries.length, 0, 'recordDays 0 reads nothing');
});

test('recall-run: private entries match only for their owner', async () => {
  const sources = () => ({
    archive: fakeSource({
      guild: [archEntry('ep-g', 'episode', { what: 'κουνέλι in the open' }, { user: ANA_ID }), archEntry('ep-stray', 'episode', { what: 'κουνέλι stray secret' }, { user: 'u5', private: true })],
      u5: [archEntry('ep-p', 'episode', { what: 'κουνέλι whispered' }, { user: 'u5', private: true })],
      u6: [archEntry('ep-q', 'episode', { what: 'κουνέλι of another' }, { user: 'u6', private: true })],
    }),
    record: fakeSource({ u5: [recLine('d1', NOW - HOUR, 'κουνέλι in the dm', { channelId: 'dm1', by: 'u5', owner: 'u5' })] }),
  });
  const ask = async (who) => {
    const s = scene({ profiles: MEMORY_PROFILES, ...sources() });
    const dm = { id: 'dm1', guild: null };
    const history = [{ id: 'p1', channelId: 'dm1', ts: NOW - MINUTE, self: false, bot: false, authorName: 'Nikos', content: 'κουνέλι;' }];
    const args = who === null ? { ...s.args, server: RECENT_SERVER } : { ...s.args, channel: dm, partner: { id: who, guild: s.args.guild }, history, candidate: history[0], server: RECENT_SERVER };
    await withCapturedLogs(() => s.recaller.run(args));
    return s.llmCalls[0]?.messages[1].content ?? '';
  };
  const owner = await ask('u5');
  assert.ok(owner.includes('κουνέλι whispered') && owner.includes('κουνέλι stray secret') && owner.includes('κουνέλι in the dm'), owner);
  assert.ok(owner.includes('κουνέλι in the open'));
  assert.ok(!owner.includes('another'), 'another member\'s private layer is never read');
  const other = await ask('u6');
  assert.ok(other.includes('κουνέλι of another') && other.includes('κουνέλι in the open'), other);
  assert.ok(!other.includes('whispered') && !other.includes('stray') && !other.includes('in the dm'), other);
  const server = await ask(null);
  assert.ok(server.includes('κουνέλι in the open'), server);
  assert.ok(!server.includes('whispered') && !server.includes('stray') && !server.includes('another') && !server.includes('in the dm'), 'a server turn reads no private entry');
});
