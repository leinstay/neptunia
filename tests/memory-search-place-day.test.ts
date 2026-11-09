// `memory.search` asked by place and day with no word that matched: the place-and-time stream of
// src/memory/db/recall.ts#search (`sampleTime: true`, what the persona's own search passes), the `sampled` answer through
// src/behavior/recall-run.ts and src/tools/tools.ts, and the picture-only lines with their descriptions. Synthetic content
// on real temp databases; no model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecall } from '../src/behavior/recall-run.ts';
import { memorySearchPlan } from '../src/behavior/recall.ts';
import { snapshotOf } from '../src/behavior/snapshot.ts';
import { channelPlaceId, dmPlaceId, messageSourceId, personId } from '../src/memory/db/ids.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { observe } from '../src/memory/db/observe.ts';
import { dbSettings, search } from '../src/memory/db/recall.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import { dmContext, dmScope, groupContext, groupScope } from '../src/memory/db/scope.ts';
import { loadStemmer } from '../src/memory/db/stems.ts';
import { memorySearchText, runMemorySearch } from '../src/tools/tools.ts';
import { fillEnvAudiences } from './fixtures/memory-db/audiences.ts';
import { fixture } from './fixtures/memory-db-recall.ts';
import { joinLabels } from '../src/config/labels.ts';
import { labels } from './fixtures/labels.ts';
import { channel as channelInfo, privateChannel } from './fixtures/reads-rig.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shippedJson = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'config', file), 'utf8')) as Record<string, object>;

const MINUTE = 60000;
const DAY = 86400000;
const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const DAY_START = Date.parse('2026-11-01T00:00:00.000Z');
const DAY_END = Date.parse('2026-11-01T23:59:59.999Z');
const GENERAL = channelPlaceId('discord', 'c1');
const SECRET = channelPlaceId('discord', 'c4');
const OTHER = channelPlaceId('discord', 'c9');
const ALICE = 'u-alice';
const BOB = 'u-bob';
const group = groupContext('discord');

/** The stretch settings every test here depends on, named so no test reads a shipped default. */
const SETTINGS = { ...dbSettings({})!, recordContext: 3, followMessages: 24, followGapMinutes: 5, candidates: 40 };
const SAMPLED_MARK = 'SAMPLED-MARK';
const NONE_MARK = 'NONE-MARK';
const toolLabels = {
  ...labels,
  tools: {
    ...labels.tools,
    tools: {
      ...labels.tools.tools,
      memory: { ...labels.tools.tools.memory, sampled: SAMPLED_MARK, none: NONE_MARK },
    },
  },
};

type Env = ReturnType<typeof fixture>;
type Plan = { forms: Array<string>; who: Array<string>; from: number | null; to: number | null; placeId?: string };

const planOf = (extra: Partial<Plan> = {}): Plan => ({ forms: [], who: [], from: null, to: null, ...extra });
const theDay = (extra: Partial<Plan> = {}): Plan => planOf({ from: DAY_START, to: DAY_END, ...extra });
/** The channels' place rows, as every stored line's place has one: a search finds a named channel by its native id. */
function channelRows(env: Env): void {
  env.channel(GENERAL, 'c1');
  env.channel(SECRET, 'c4');
  env.channel(OTHER, 'c9');
}
const sampling = (env: Env, plan: Plan, rest: Record<string, unknown> = {}, ctx: unknown = group) => {
  channelRows(env);
  return search(env.db, { ctx, plan, now: NOW, settings: SETTINGS, sampleTime: true, ...rest });
};
const lineIds = (found: { windows: Array<{ messages: Array<{ id: unknown }> }> }) =>
  found.windows.flatMap((window) => window.messages.map((message) => message.id));
const hitIds = (found: { hits: Array<{ messageId: unknown }> }) => found.hits.map((hit) => hit.messageId);

/** `count` lines spread evenly over a span, each further from the next than a chat's silence. */
function spread(
  env: Env,
  prefix: string,
  {
    from,
    to,
    count,
    place = GENERAL,
    text = '',
  }: { from: number; to: number; count: number; place?: string; text?: string }
) {
  const step = (to - from) / count;
  for (let i = 0; i < count; i += 1)
    env.say({ native: `${prefix}${i}`, at: Math.round(from + i * step), text: text || `line ${prefix}${i}`, place });
}

/** An image with no text, as the interface reports it, written through the observation path. */
function observePicture(
  env: Env,
  {
    native,
    at,
    channelId = 'c1',
    attachments,
  }: { native: string; at: number; channelId?: string; attachments: Array<{ id: string; kind: string }> }
) {
  const envelope = observationOf({
    iface: 'discord',
    at,
    message: {
      id: native,
      at,
      content: '',
      author: { id: ALICE },
      attachments: attachments.map((item) => ({ ...item, name: 'p.png', url: 'https://example.invalid/p.png' })),
      links: [],
      stickers: [],
    },
    chat: { id: channelId, kind: 'channel', rootId: 'g1', name: channelId },
  });
  assert.ok(envelope);
  const written = observe(env.handle, envelope, { now: () => at });
  assert.equal(written.ok, true);
}

/** A description of an attachment as the media cache stores it. */
function describe(
  env: Env,
  attachmentId: string,
  description: string | null,
  {
    scope = groupScope('discord'),
    retired = null,
  }: { scope?: ReturnType<typeof groupScope>; retired?: string | null } = {}
) {
  // The item the observation made holds its description; a cache row of an item not yet observed is one more row.
  const held = env.db
    .prepare(
      `UPDATE media SET description = ?, availability = ?, retired_at = ?, extra = json_set(COALESCE(extra, '{}'), '$.textOrigin', 'retelling')
       WHERE native_ref = ? AND scope_iface IS ?`
    )
    .run(description, description === null ? 'unknown' : 'present', retired, attachmentId, scope.scope_iface);
  assert.equal(Number(held.changes) > 0, true, 'the picture was observed first');
}

/**
 * The runner and the tool over the fixture database: #general (c1), #secret (c4) that the root cannot see, stored as
 * `secret`.
 */
function toolRig(env: Env, { secret: secretId = SECRET }: { secret?: string } = {}) {
  fillEnvAudiences(env);
  insertRows(
    env.db,
    {
      places: [
        { id: GENERAL, iface: 'discord', kind: 'channel', native_id: 'c1', scope_kind: 'group', name: 'general' },
        { id: secretId, iface: 'discord', kind: 'channel', native_id: 'c4', scope_kind: 'group', name: 'secret' },
      ],
    },
    { log: { info() {}, debug() {}, warn() {}, error() {} } }
  );
  const channel = channelInfo('c1', { name: 'general' });
  const secret = { ...privateChannel('c4', []), name: 'secret' };
  const snapshot = snapshotOf('g1', { chats: [channel, secret], groups: [] });
  const shipped = shippedJson('config.json');
  const config = {
    ...shipped,
    bot: { ...shipped.bot, timezone: 'UTC' },
    features: { ...shipped.features, meaningSearch: false, recall: true },
  };
  const data = {};
  const store = {
    state: {
      get data() {
        return data;
      },
      markDirty() {},
    },
    listUserProfiles: () => [],
  };
  const llmCalls: Array<unknown> = [];
  const reads = {
    searchMessages: () => Promise.resolve({ total: 0, hits: [] }),
    searchMembers: () => Promise.resolve({ members: [] }),
    history: () => Promise.resolve({ events: [], complete: true }),
  };
  const llm = {
    capLeft: () => 100,
    complete: (...call: Array<unknown>) => {
      llmCalls.push(call);
      return Promise.resolve({ text: '' });
    },
  };
  const recall = createRecall({
    reads,
    hot: { config, prompts: { 'recall-summary': 'x', labels: toolLabels } },
    store,
    llm,
    now: () => NOW,
    memoryDb: { database: () => env.db },
  } as unknown as Parameters<typeof createRecall>[0]);
  const ask = (args: Record<string, unknown>) =>
    runMemorySearch({
      recall,
      store,
      config,
      labels: toolLabels,
      placeId: 'g1',
      snapshot,
      channel,
      selfId: 'self',
      selfName: 'Self',
      history: [],
      now: NOW,
      args,
    });
  return { ask, llmCalls };
}

const textOf = (result: Awaited<ReturnType<typeof runMemorySearch>>) => {
  assert.equal(result.status, 'ok');
  return (result as { data: { text: string } }).data.text;
};

// ---------- the stream ----------

test('a day in a channel with no words is answered from that day, each hit found by the time stream', () => {
  const env = fixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 10 });
    const found = sampling(env, theDay({ placeId: 'c1' }), { limit: 3 });
    assert.equal(found.sampled, true);
    assert.ok(found.windows.length > 0, 'the day has lines');
    assert.ok(found.hits.length > 0);
    for (const hit of found.hits) assert.deepEqual(hit.streams, ['time']);
  } finally {
    env.done();
  }
});

test('a busy day comes back sampled across its whole span, one window per third under a limit of three', () => {
  const env = fixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 222 });
    const found = sampling(env, theDay({ placeId: 'c1' }), { limit: 3 });
    assert.equal(found.windows.length, 3);
    const span = (DAY_END - DAY_START) / 3;
    const thirds = found.windows.map((window) =>
      Math.min(2, Math.floor((window.messages[Math.floor(window.messages.length / 2)].ts - DAY_START) / span))
    );
    assert.deepEqual([...thirds].sort(), [0, 1, 2]);
  } finally {
    env.done();
  }
});

test('a sample stays far under the size of the day it reads', () => {
  const env = fixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 222 });
    const found = sampling(env, theDay({ placeId: 'c1' }), { limit: 3 });
    // Each window is at most a hit, its neighbours each side and the chat followed on.
    const most = 3 * (1 + 2 * SETTINGS.recordContext + SETTINGS.followMessages);
    assert.ok(lineIds(found).length > 0, 'the day has lines');
    assert.ok(lineIds(found).length <= most, `${lineIds(found).length} lines`);
    assert.ok(found.hits.length <= SETTINGS.candidates, `${found.hits.length} hits`);
  } finally {
    env.done();
  }
});

test('a limit of one gives one window', () => {
  const env = fixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 50 });
    assert.equal(sampling(env, theDay({ placeId: 'c1' }), { limit: 1 }).windows.length, 1);
  } finally {
    env.done();
  }
});

test('the windows of a sample come back newest first, each in time order', () => {
  const env = fixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 60 });
    const found = sampling(env, theDay({ placeId: 'c1' }), { limit: 3 });
    assert.equal(found.windows.length, 3);
    const ends = found.windows.map((window) => window.messages.at(-1)!.ts);
    assert.deepEqual(
      ends,
      [...ends].sort((a, b) => b - a)
    );
    for (const window of found.windows) {
      const times = window.messages.map((message) => message.ts);
      assert.deepEqual(
        times,
        [...times].sort((a, b) => a - b)
      );
    }
  } finally {
    env.done();
  }
});

test('a range with fewer lines than the limit gives every line, a range with none gives nothing', () => {
  const env = fixture();
  try {
    env.say({ native: 'one', at: DAY_START + 2 * 60 * MINUTE, text: 'first', place: GENERAL });
    env.say({ native: 'two', at: DAY_START + 14 * 60 * MINUTE, text: 'second', place: GENERAL });
    const found = sampling(env, theDay({ placeId: 'c1' }), { limit: 5 });
    assert.deepEqual(hitIds(found).sort(), ['one', 'two']);
    const empty = sampling(env, planOf({ from: DAY_START + 3 * DAY, to: DAY_END + 3 * DAY, placeId: 'c1' }));
    assert.deepEqual([empty.windows.length, empty.hits.length, empty.sampled], [0, 0, false]);
  } finally {
    env.done();
  }
});

test('a hit of a sample is inside the range and the channel it named', () => {
  const env = fixture();
  try {
    spread(env, 'before', { from: DAY_START - 5 * DAY, to: DAY_START - DAY, count: 40 });
    spread(env, 'in', { from: DAY_START, to: DAY_END, count: 40 });
    spread(env, 'after', { from: DAY_END + DAY, to: DAY_END + 3 * DAY, count: 40 });
    spread(env, 'there', { from: DAY_START, to: DAY_END, count: 40, place: OTHER });
    const found = sampling(env, theDay({ placeId: 'c1' }), { limit: 4 });
    assert.ok(found.hits.length > 0);
    for (const hit of found.hits) {
      assert.ok(hit.ts >= DAY_START && hit.ts <= DAY_END, String(hit.messageId));
      assert.equal(hit.placeId, GENERAL);
    }
  } finally {
    env.done();
  }
});

test('a range with one open side stays on its named side', () => {
  const env = fixture();
  try {
    spread(env, 'old', { from: DAY_START - 30 * DAY, to: DAY_START, count: 30 });
    spread(env, 'new', { from: DAY_START, to: DAY_START + 30 * DAY, count: 30 });
    const since = sampling(env, planOf({ from: DAY_START, placeId: 'c1' }), { limit: 3 });
    assert.ok(since.hits.length > 0);
    for (const hit of since.hits) assert.ok(hit.ts >= DAY_START, String(hit.messageId));
    const until = sampling(env, planOf({ to: DAY_START - 1, placeId: 'c1' }), { limit: 3 });
    assert.ok(until.hits.length > 0);
    for (const hit of until.hits) assert.ok(hit.ts < DAY_START, String(hit.messageId));
  } finally {
    env.done();
  }
});

test('a channel named with no range is sampled across its whole span, bounded by the limit', () => {
  const env = fixture();
  try {
    spread(env, 'c', { from: DAY_START - 300 * DAY, to: DAY_START, count: 300 });
    spread(env, 'there', { from: DAY_START - 300 * DAY, to: DAY_START, count: 30, place: OTHER });
    const found = sampling(env, planOf({ placeId: 'c1' }), { limit: 2 });
    assert.equal(found.windows.length, 2);
    assert.ok(lineIds(found).every((id) => String(id).startsWith('c')));
    const middle = DAY_START - 150 * DAY;
    const sides = found.windows.map((window) => window.messages[0].ts < middle);
    assert.deepEqual([...sides].sort(), [false, true], 'an old stretch and a recent one');
  } finally {
    env.done();
  }
});

test('a range with no channel samples every channel the context may read', () => {
  const env = fixture();
  try {
    spread(env, 'a', { from: DAY_START, to: DAY_END, count: 30 });
    spread(env, 'b', { from: DAY_START, to: DAY_END, count: 30, place: OTHER });
    const found = sampling(env, theDay(), { limit: 5 });
    assert.equal(found.sampled, true);
    assert.ok(found.windows.length > 0);
  } finally {
    env.done();
  }
});

// ---------- when the stream runs ----------

test('words that match nothing still answer from the time stream, with the words kept out of the ranking', () => {
  const env = fixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 20 });
    const found = sampling(env, theDay({ forms: ['ανυπαρκτο'], placeId: 'c1' }), { limit: 2 });
    assert.equal(found.sampled, true);
    assert.equal(found.stats.words, 0);
    assert.ok(found.hits.length > 0);
    for (const hit of found.hits) assert.deepEqual(hit.streams, ['time']);
  } finally {
    env.done();
  }
});

test('one word that matched keeps the answer to the word stream, the rest of the day stays out', () => {
  const env = fixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 40 });
    env.say({ native: 'found', at: DAY_START + 720 * MINUTE + 1, text: 'το ποδηλατο', place: GENERAL });
    env.stem();
    const found = sampling(env, theDay({ forms: ['ποδηλατο'], placeId: 'c1' }), { limit: 3 });
    assert.deepEqual(hitIds(found), ['found']);
    assert.deepEqual(found.hits[0].streams, ['words']);
    assert.equal(found.windows.length, 1, 'a word match is not filled up with a sample');
    assert.equal(found.sampled, false);
  } finally {
    env.done();
  }
});

test('a part of a word the letters found keeps the time stream off', () => {
  const env = fixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 20 });
    env.say({ native: 'part', at: DAY_START + 60 * MINUTE + 1, text: 'η παρακαλουσα', place: GENERAL });
    const found = sampling(env, theDay({ forms: ['ρακαλου'], placeId: 'c1' }), { limit: 3 });
    assert.deepEqual(hitIds(found), ['part']);
    assert.equal(found.sampled, false);
  } finally {
    env.done();
  }
});

test('a line the meaning stream found keeps the time stream off', () => {
  const env = fixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 20 });
    env.vector('d3', [1, 0, 0, 0]);
    const found = sampling(env, theDay({ forms: ['ανυπαρκτο'], placeId: 'c1' }), {
      limit: 3,
      vector: [1, 0, 0, 0],
      settings: { ...SETTINGS, minMeaning: 0.5 },
    });
    assert.deepEqual(hitIds(found), ['d3']);
    assert.equal(found.sampled, false);
  } finally {
    env.done();
  }
});

test('a person who spoke that day keeps the time stream off', () => {
  const env = fixture();
  try {
    env.account(ALICE, ['Alice']);
    env.account(BOB, ['Bob']);
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 20 });
    env.say({ native: 'bob', at: DAY_START + 60 * MINUTE + 1, text: 'hello', place: GENERAL, author: BOB });
    const found = sampling(env, theDay({ who: ['Bob'], placeId: 'c1' }), { limit: 3 });
    assert.deepEqual(hitIds(found), ['bob']);
    assert.equal(found.sampled, false);
  } finally {
    env.done();
  }
});

test('words that matched only the lines she already sees answer nothing, no sample in their place', () => {
  const env = fixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 20 });
    const seenId = env.say({ native: 'seen', at: DAY_START + 60 * MINUTE + 1, text: 'το ποδηλατο', place: GENERAL });
    env.stem();
    const found = sampling(env, theDay({ forms: ['ποδηλατο'], placeId: 'c1' }), {
      exclusions: [{ kind: 'source', sourceId: seenId }],
    });
    assert.deepEqual([found.windows.length, found.sampled], [0, false]);
  } finally {
    env.done();
  }
});

test('a plan with no place, no range and no words answers nothing', () => {
  const env = fixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 10 });
    const found = sampling(env, planOf());
    assert.deepEqual([found.windows.length, found.hits.length, found.sampled], [0, 0, false]);
  } finally {
    env.done();
  }
});

test('words that match nothing with no place and no range answer nothing', () => {
  const env = fixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 10 });
    const found = sampling(env, planOf({ forms: ['ανυπαρκτο'] }));
    assert.deepEqual([found.windows.length, found.hits.length, found.sampled], [0, 0, false]);
  } finally {
    env.done();
  }
});

// The automatic memory prefetch searches with `to` set and must never get a day's chat when its words miss.
test('a search that did not ask for the time stream stays empty with a range and no match', () => {
  const env = fixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 10 });
    const found = search(env.db, {
      ctx: group,
      plan: planOf({ forms: ['ανυπαρκτο'], to: DAY_END }),
      now: NOW,
      settings: SETTINGS,
    });
    assert.deepEqual([found.windows.length, found.hits.length, found.sampled], [0, 0, false]);
  } finally {
    env.done();
  }
});

// ---------- audience, place rule, retired lines ----------

test("a DM's lines in the range never reach a group, and a range holding only them answers nothing", () => {
  const env = fixture();
  try {
    const dm = dmPlaceId('discord', BOB);
    const scope = dmScope(personId('discord', BOB), 'discord');
    for (let i = 0; i < 12; i += 1)
      env.say({ native: `dm${i}`, at: DAY_START + i * 60 * MINUTE, text: 'μυστικο', place: dm, author: BOB, scope });
    const alone = sampling(env, theDay());
    assert.deepEqual([alone.windows.length, alone.hits.length, alone.sampled, alone.hidden], [0, 0, false, false]);
    spread(env, 'g', { from: DAY_START, to: DAY_END, count: 12 });
    const found = sampling(env, theDay(), { limit: 5 });
    assert.ok(found.hits.length > 0);
    const dump = JSON.stringify({ windows: found.windows, hits: found.hits });
    assert.ok(!dump.includes('μυστικο') && !dump.includes('dm1'));
  } finally {
    env.done();
  }
});

test("a DM context reads its own DM's lines and never another person's", () => {
  const env = fixture();
  try {
    const mine = dmScope(personId('discord', BOB), 'discord');
    const theirs = dmScope(personId('discord', ALICE), 'discord');
    for (let i = 0; i < 6; i += 1) {
      env.say({
        native: `mine${i}`,
        at: DAY_START + i * 60 * MINUTE,
        text: 'δικο μου',
        place: dmPlaceId('discord', BOB),
        author: BOB,
        scope: mine,
      });
      env.say({
        native: `theirs${i}`,
        at: DAY_START + i * 60 * MINUTE + 1,
        text: 'ξενο',
        place: dmPlaceId('discord', ALICE),
        scope: theirs,
      });
    }
    const found = sampling(
      env,
      theDay(),
      { limit: 5 },
      dmContext(personId('discord', BOB), 'discord', dmPlaceId('discord', BOB))
    );
    assert.ok(lineIds(found).some((id) => String(id).startsWith('mine')));
    assert.ok(!JSON.stringify(found.windows).includes('ξενο'));
  } finally {
    env.done();
  }
});

test('a channel the place rule refuses stays out of a range and answers nothing when named', () => {
  const env = fixture();
  try {
    spread(env, 'open', { from: DAY_START, to: DAY_END, count: 12 });
    spread(env, 'shut', { from: DAY_START, to: DAY_END, count: 12, place: SECRET, text: 'κρυφο' });
    const allowPlace = (placeId: unknown) => placeId !== SECRET;
    const wide = sampling(env, theDay(), { limit: 5, allowPlace });
    assert.ok(wide.hits.length > 0);
    assert.ok(!JSON.stringify(wide.windows).includes('κρυφο'));
    const named = sampling(env, theDay({ placeId: 'c4' }), { limit: 5, allowPlace });
    assert.deepEqual([named.windows.length, named.sampled], [0, false]);
  } finally {
    env.done();
  }
});

test('retired, deleted and superseded lines are out of a sample', () => {
  const env = fixture();
  try {
    const at = DAY_START + 60 * MINUTE;
    const retired = env.say({ native: 'gone', at, text: 'αποσυρθηκε', place: GENERAL });
    env.db.prepare('UPDATE sources SET retired_at = ? WHERE id = ?').run(new Date(NOW).toISOString(), retired);
    env.say({ native: 'del', at: at + 20 * MINUTE, text: 'σβηστηκε', place: GENERAL });
    env.deleted('del', at + 21 * MINUTE);
    env.say({ native: 'ed', at: at + 40 * MINUTE, text: 'παλια μορφη', place: GENERAL });
    env.say({ native: 'ed', at: at + 40 * MINUTE, text: 'νεα μορφη', place: GENERAL, revision: 2 });
    env.say({ native: 'kept', at: at + 60 * MINUTE, text: 'μενει', place: GENERAL });
    const found = sampling(env, theDay({ placeId: 'c1' }), { limit: 5 });
    assert.deepEqual(hitIds(found).sort(), ['ed', 'kept']);
    const dump = JSON.stringify(found.windows);
    assert.ok(dump.includes('νεα μορφη'));
    for (const text of ['αποσυρθηκε', 'σβηστηκε', 'παλια μορφη']) assert.ok(!dump.includes(text), text);
  } finally {
    env.done();
  }
});

test('a line left out by the exclusions is neither a hit nor a line of a sample', () => {
  const env = fixture();
  try {
    const id = (i: number) => messageSourceId('discord', `d${i}`, 1, 'seen');
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 8 });
    const found = sampling(env, theDay({ placeId: 'c1' }), {
      limit: 5,
      exclusions: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ kind: 'source' as const, sourceId: id(i) })),
    });
    assert.deepEqual(hitIds(found), ['d7']);
    assert.deepEqual(lineIds(found), ['d7']);
  } finally {
    env.done();
  }
});

// ---------- the plan and the tool ----------

test('memorySearchPlan keeps a channel with nothing else, and still answers null for nothing at all', () => {
  assert.deepEqual(memorySearchPlan({ placeId: 'c1', now: NOW }), {
    forms: [],
    who: [],
    from: null,
    to: null,
    placeId: 'c1',
  });
  assert.equal(memorySearchPlan({ now: NOW }), null);
});

for (const [name, args] of [
  ['with a question', { question: 'τι εγινε τοτε στο καναλι', when: '2026-11-01', placeId: 'c1' }],
  ['with no question', { when: '2026-11-01', placeId: 'c1' }],
  ['with terms that match nothing', { terms: 'ανυπαρκτο', when: '2026-11-01', placeId: 'c1' }],
  ['with a channel alone', { placeId: 'c1' }],
] as const) {
  test(`the tool answers a day in a channel ${name} with its lines and the sampled line`, async () => {
    const env = fixture();
    try {
      spread(env, 'd', { from: DAY_START, to: DAY_END, count: 30 });
      const text = textOf(await toolRig(env).ask(args));
      assert.ok(text.includes(SAMPLED_MARK), text);
      assert.ok(text.includes('line d'), text);
      assert.ok(!text.includes(NONE_MARK), text);
    } finally {
      env.done();
    }
  });
}

test('the tool answers an empty search the same as before: no sampled line', async () => {
  const env = fixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 5 });
    const text = textOf(await toolRig(env).ask({ when: '2026-10-01', placeId: 'c1' }));
    assert.ok(text.includes(NONE_MARK), text);
    assert.ok(!text.includes(SAMPLED_MARK), text);
  } finally {
    env.done();
  }
});

test('the tool still refuses a call with nothing to search', async () => {
  const env = fixture();
  try {
    assert.equal((await toolRig(env).ask({})).status, 'invalid');
  } finally {
    env.done();
  }
});

test('the tool keeps a hidden channel hidden through its place rule', async () => {
  const env = fixture();
  try {
    spread(env, 'shut', { from: DAY_START, to: DAY_END, count: 12, place: SECRET, text: 'κρυφο' });
    spread(env, 'open', { from: DAY_START, to: DAY_END, count: 12 });
    const rig = toolRig(env);
    const named = textOf(await rig.ask({ when: '2026-11-01', placeId: 'c4' }));
    assert.ok(!named.includes('κρυφο'), named);
    const wide = textOf(await rig.ask({ when: '2026-11-01' }));
    assert.ok(!wide.includes('κρυφο'), wide);
    assert.ok(wide.includes('line open'), wide);
  } finally {
    env.done();
  }
});

test('the place rule keeps a hidden channel stored under an opaque id hidden, read by the native id of its row', async () => {
  // Bug: the rule cut the channel's native id out of the text of its place id, which an opaque id does not spell.
  const env = fixture();
  try {
    const hidden = 'place:opaque-secret';
    spread(env, 'shut', { from: DAY_START, to: DAY_END, count: 12, place: hidden, text: 'κρυφο' });
    spread(env, 'open', { from: DAY_START, to: DAY_END, count: 12 });
    const rig = toolRig(env, { secret: hidden });
    const wide = textOf(await rig.ask({ when: '2026-11-01' }));
    assert.deepEqual([wide.includes('κρυφο'), wide.includes('line open')], [false, true]);
  } finally {
    env.done();
  }
});

test('memorySearchText names a sample after the source line, and only when it holds a stretch', () => {
  const quote = { channelName: 'general', startTs: DAY_START, lines: 'line one' };
  const shown = memorySearchText([quote], { labels: toolLabels, sampled: true });
  const lines = shown.split('\n');
  assert.equal(lines[1], SAMPLED_MARK);
  assert.ok(!memorySearchText([quote], { labels: toolLabels }).includes(SAMPLED_MARK));
  assert.ok(!memorySearchText([], { labels: toolLabels, sampled: true }).includes(SAMPLED_MARK));
});

// Without the label a sampled day reads as a match for words that matched nothing.
test('the shipped labels hold the line that names a sample', () => {
  const quote = { channelName: 'general', startTs: DAY_START, lines: 'line one' };
  // The engine reads labels through joinLabels; the file itself is split by owner and model.
  const shipped = joinLabels(shippedJson('labels.json') as never);
  assert.notEqual(
    memorySearchText([quote], { labels: shipped, sampled: true }),
    memorySearchText([quote], { labels: shipped })
  );
});

// ---------- picture-only lines ----------

const imageTag = (text: string) => labels.transcript.imageDescribed.replace('{text}', text);

test('a picture-only line of a sampled day comes back with the bare image marker when it has no description', async () => {
  const env = fixture();
  try {
    const source = env.say({ native: 'pic', at: DAY_START + 60 * MINUTE, text: '', place: GENERAL });
    // The kinds of a line live on its links: one bare item, as the migration leaves an old picture.
    env.db
      .prepare(
        "INSERT INTO media (id, kind, availability, scope_kind, scope_iface) VALUES ('media:bare:b', 'image', 'unknown', 'group', 'discord')"
      )
      .run();
    env.db
      .prepare(
        "INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('source', ?, 0, 'media:bare:b')"
      )
      .run(source);
    const text = textOf(await toolRig(env).ask({ when: '2026-11-01', placeId: 'c1' }));
    assert.ok(text.includes(labels.transcript.image), text);
    assert.ok(!text.includes(NONE_MARK), text);
  } finally {
    env.done();
  }
});

test('a picture observed with its attachment id renders the description of the media table', async () => {
  const env = fixture();
  try {
    observePicture(env, { native: 'pic', at: DAY_START + 60 * MINUTE, attachments: [{ id: 'att-1', kind: 'image' }] });
    describe(env, 'att-1', 'a red bicycle by a wall');
    const rig = toolRig(env);
    const text = textOf(await rig.ask({ when: '2026-11-01', placeId: 'c1' }));
    assert.ok(text.includes(imageTag('a red bicycle by a wall')), text);
    assert.deepEqual(rig.llmCalls, [], 'the read asks no model');
  } finally {
    env.done();
  }
});

test('two pictures on one line each carry their own description, in order', async () => {
  const env = fixture();
  try {
    observePicture(env, {
      native: 'pic',
      at: DAY_START + 60 * MINUTE,
      attachments: [
        { id: 'att-1', kind: 'image' },
        { id: 'att-2', kind: 'image' },
      ],
    });
    describe(env, 'att-1', 'a red bicycle');
    describe(env, 'att-2', 'a blue kettle');
    const text = textOf(await toolRig(env).ask({ when: '2026-11-01', placeId: 'c1' }));
    const first = text.indexOf(imageTag('a red bicycle'));
    const second = text.indexOf(imageTag('a blue kettle'));
    assert.ok(first >= 0 && second > first, text);
  } finally {
    env.done();
  }
});

for (const [name, setup] of [
  ['with no row in the media table', () => {}],
  ['whose row holds no description', (env: Env) => describe(env, 'att-1', null)],
  [
    'whose row is retired',
    (env: Env) => describe(env, 'att-1', 'a retired description', { retired: new Date(NOW).toISOString() }),
  ],
] as const) {
  test(`a picture ${name} renders the bare marker, nothing invented`, async () => {
    const env = fixture();
    try {
      observePicture(env, {
        native: 'pic',
        at: DAY_START + 60 * MINUTE,
        attachments: [{ id: 'att-1', kind: 'image' }],
      });
      setup(env);
      const text = textOf(await toolRig(env).ask({ when: '2026-11-01', placeId: 'c1' }));
      assert.ok(text.includes(labels.transcript.image), text);
      assert.ok(!text.includes('a retired description'), text);
    } finally {
      env.done();
    }
  });
}

// The owner's ruling of 2026-11-05: one row per item, and audience comes only from a link. A group line that shows an item reads
// its description; a DM's line stays out of a group by its own audience (tests/media-memory-search.test.ts holds that for each kind).
test('a group line reads the description of the item it shows, whichever reader told it', async () => {
  const env = fixture();
  try {
    observePicture(env, { native: 'pic', at: DAY_START + 60 * MINUTE, attachments: [{ id: 'att-1', kind: 'image' }] });
    describe(env, 'att-1', 'a red bicycle');
    const text = textOf(await toolRig(env).ask({ when: '2026-11-01', placeId: 'c1' }));
    assert.ok(text.includes(imageTag('a red bicycle')), text);
  } finally {
    env.done();
  }
});

test('a picture line beside a word match carries its description too', async () => {
  const env = fixture();
  try {
    env.say({ native: 'word', at: DAY_START + 60 * MINUTE, text: 'το ποδηλατο', place: GENERAL });
    env.stem();
    observePicture(env, { native: 'pic', at: DAY_START + 61 * MINUTE, attachments: [{ id: 'att-1', kind: 'image' }] });
    describe(env, 'att-1', 'a red bicycle');
    const text = textOf(await toolRig(env).ask({ terms: 'ποδηλατο', when: '2026-11-01', placeId: 'c1' }));
    assert.ok(text.includes(imageTag('a red bicycle')), text);
    assert.ok(!text.includes(SAMPLED_MARK), text);
  } finally {
    env.done();
  }
});

// ---------- an ordinary word search ----------

/** The lines of each place around the rows the word index holds for a form: the word stream's windows, built by hand. */
function wordBaseline(env: Env, form: string, around: number): Array<Array<string>> {
  const hits = env.db
    .prepare(
      `SELECT s.native_id AS native_id, s.place_id AS place_id, s.occurred_at AS occurred_at
       FROM sources_fts JOIN sources s ON s.rowid = sources_fts.rowid
       WHERE sources_fts MATCH ? ORDER BY s.occurred_at DESC`
    )
    .all(`{stems} : "${loadStemmer(env.db).stem(form)}"`);
  return hits.map((hit) => {
    const place = env.db
      .prepare('SELECT native_id FROM sources WHERE place_id = ? ORDER BY occurred_at')
      .all(hit.place_id as string)
      .map((row) => String(row.native_id));
    const at = place.indexOf(String(hit.native_id));
    return place.slice(Math.max(0, at - around), at + around + 1);
  });
}

function wordFixture(env: Env) {
  spread(env, 'a', { from: DAY_START, to: DAY_END, count: 40 });
  spread(env, 'b', { from: DAY_START, to: DAY_END, count: 40, place: OTHER });
  env.say({ native: 'w1', at: DAY_START + 3 * 60 * MINUTE + 1, text: 'το ποδηλατο εδω', place: GENERAL });
  env.say({ native: 'w2', at: DAY_START + 20 * 60 * MINUTE + 1, text: 'και το ποδηλατο εκει', place: OTHER });
  env.stem();
}

const sansFollow = { ...SETTINGS, followMessages: 0 };

test('an ordinary word search gives the windows the word index computes', () => {
  const env = fixture();
  try {
    wordFixture(env);
    const found = search(env.db, { ctx: group, plan: planOf({ forms: ['ποδηλατο'] }), now: NOW, settings: sansFollow });
    assert.deepEqual(
      found.windows.map((window) => window.messages.map((message) => message.id)),
      wordBaseline(env, 'ποδηλατο', SETTINGS.recordContext)
    );
  } finally {
    env.done();
  }
});

test('asking for the time stream changes nothing about a search whose words matched', () => {
  const env = fixture();
  try {
    wordFixture(env);
    channelRows(env);
    for (const plan of [
      planOf({ forms: ['ποδηλατο'] }),
      theDay({ forms: ['ποδηλατο'] }),
      theDay({ forms: ['ποδηλατο'], placeId: 'c1' }),
    ]) {
      const asked = { ctx: group, plan, now: NOW, settings: SETTINGS };
      const plain = search(env.db, asked);
      const withStream = search(env.db, { ...asked, sampleTime: true });
      assert.deepEqual(withStream.windows, plain.windows);
      assert.deepEqual(withStream.hits, plain.hits);
      assert.deepEqual(withStream.stats, plain.stats);
      assert.ok(plain.hits.length > 0);
    }
  } finally {
    env.done();
  }
});

test('the stream counts of a search stay the four named ones after a sample', () => {
  const env = fixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 10 });
    const found = sampling(env, theDay({ placeId: 'c1' }));
    assert.ok(found.hits.length > 0, 'the day has lines');
    assert.deepEqual(found.stats, { words: 0, trigram: 0, meaning: 0, people: 0 });
  } finally {
    env.done();
  }
});
