// Tests for src/memory/warmup.js: THE way memory starts. Pure helpers
// (pickPeople, memberStats, splitNewestOlder, sampleMember,
// selectChannelMessages, markOwnContext, buildChannelRequest,
// clampProfileResult, clampChannelResult, clampServerResult,
// the template values of the profile, channel and server requests,
// takeFittingPrefix, buildPersonWriteIterations, warmupRoute,
// clampPortraitDecision) are tested directly (portraitMode, which the
// refresh reads, is src/memory/portrait.js's: tests/portrait.test.js); the
// factory is tested against a fake discord.js guild/channel, a fake LLM
// client and a real (temp-dir) store, and the two-stage portrait refresh end
// to end with the stream analyzer's voice run. No network, no real prompts/
// or data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/memory/store.js';

import {
  pickPeople,
  memberStats,
  splitNewestOlder,
  sampleMember,
  selectChannelMessages,
  markOwnContext,
  buildChannelRequest,
  clampProfileResult,
  clampChannelResult,
  clampServerResult,
  takeFittingPrefix,
  buildPersonWriteIterations,
  clampPortraitDecision,
  warmupRoute,
  profileTemplateValues,
  channelTemplateValues,
  serverTemplateValues,
  createWarmup,
} from '../src/memory/warmup.js';
import { createCalibrator, estimateMessages } from '../src/llm/tokens.js';
import { DailyCapError, TokenLimitError } from '../src/llm/openrouter.js';
import { createPortraitScheduler, portraitDue, portraitSettings } from '../src/memory/portrait.js';
import { createMemoryUpdater } from '../src/memory/update.js';
import { mergeIntoQueue } from '../src/memory/voice.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A normalized-message-shaped fixture, just enough for the pure helpers and formatTranscript. */
function msg(id, ts, overrides = {}) {
  return {
    id: String(id),
    ts,
    authorId: 'other',
    authorName: 'Other',
    content: `m${id}`,
    channelId: 'c1',
    channelName: 'general',
    self: false,
    bot: false,
    replyToId: null,
    attachments: [],
    links: [],
    stickers: [],
    emojis: [],
    forwarded: [],
    ...overrides,
  };
}

/** A ChannelWindow fixture. */
function win(id, messages, overrides = {}) {
  return { id, name: id, category: null, topic: null, messages, ...overrides };
}

// ---------------------------------------------------------------------------
// pickPeople / memberStats
// ---------------------------------------------------------------------------

test('pickPeople: counts own messages, excludes bots and the persona itself, sorts most active first', () => {
  const windows = [
    win('c1', [
      msg(1, 1000, { authorId: 'a', authorName: 'Alice' }),
      msg(2, 2000, { authorId: 'a', authorName: 'Alice' }),
      msg(3, 3000, { authorId: 'bot1', bot: true }),
      msg(4, 4000, { self: true }),
      msg(5, 5000, { authorId: 'b', authorName: 'Bob' }),
    ]),
  ];
  const people = pickPeople(windows, { minMessages: 1, maxPeople: 10 });
  assert.deepEqual(people.map((p) => p.id), ['a', 'b']);
  assert.equal(people[0].messages, 2);
  assert.equal(people[1].messages, 1);
});

test('pickPeople: minMessages drops people below the threshold', () => {
  const windows = [
    win('c1', [
      msg(1, 1000, { authorId: 'a' }),
      msg(2, 2000, { authorId: 'a' }),
      msg(3, 3000, { authorId: 'a' }),
      msg(4, 4000, { authorId: 'b' }),
    ]),
  ];
  const people = pickPeople(windows, { minMessages: 2, maxPeople: 10 });
  assert.deepEqual(people.map((p) => p.id), ['a']);
});

test('pickPeople: maxPeople caps the ranked list', () => {
  const windows = [
    win('c1', [
      msg(1, 1000, { authorId: 'a' }),
      msg(2, 2000, { authorId: 'a' }),
      msg(3, 3000, { authorId: 'b' }),
      msg(4, 4000, { authorId: 'c' }),
    ]),
  ];
  const people = pickPeople(windows, { minMessages: 1, maxPeople: 2 });
  assert.equal(people.length, 2);
  assert.deepEqual(people.map((p) => p.id), ['a', 'b']);
});

test('pickPeople: byChannel counts and first/last timestamps, across channels', () => {
  const windows = [
    win('c1', [msg(1, 1000, { authorId: 'a', channelId: 'c1' }), msg(2, 5000, { authorId: 'a', channelId: 'c1' })]),
    win('c2', [msg(3, 3000, { authorId: 'a', channelId: 'c2' })]),
  ];
  const [alice] = pickPeople(windows, { minMessages: 1, maxPeople: 10 });
  assert.deepEqual(alice.byChannel, { c1: 2, c2: 1 });
  assert.equal(alice.firstTs, 1000);
  assert.equal(alice.lastTs, 5000);
});

test('memberStats: null for a member who wrote nothing', () => {
  const windows = [win('c1', [msg(1, 1000, { authorId: 'a' })])];
  assert.equal(memberStats(windows, 'ghost'), null);
});

// ---------------------------------------------------------------------------
// splitNewestOlder
// ---------------------------------------------------------------------------

test('splitNewestOlder: total >= length reconstructs the original chronological order', () => {
  const pool = Array.from({ length: 5 }, (_, i) => ({ id: i }));
  assert.deepEqual(splitNewestOlder(pool, 5), pool);
  assert.deepEqual(splitNewestOlder(pool, 99), pool);
});

test('splitNewestOlder: half from the newest third, the rest evenly spread over the older part', () => {
  const pool = Array.from({ length: 9 }, (_, i) => ({ id: i }));
  const chosen = splitNewestOlder(pool, 6);
  // newest third = ids 6,7,8 (all kept); older two-thirds = ids 0..5, 3 spread evenly -> 0,2,4
  assert.deepEqual(chosen.map((m) => m.id), [0, 2, 4, 6, 7, 8]);
});

// ---------------------------------------------------------------------------
// sampleMember
// ---------------------------------------------------------------------------

test('sampleMember: context before + reply target attached, chronological order preserved', () => {
  const messages = [
    msg(0, 0, { authorId: 'other' }),
    msg(1, 1000, { authorId: 'a' }), // own
    msg(2, 2000, { authorId: 'other' }),
    msg(3, 3000, { authorId: 'a' }), // own
    msg(4, 4000, { authorId: 'other' }),
    msg(5, 5000, { authorId: 'a', replyToId: '2' }), // own, replies to msg 2
  ];
  const windows = [win('c1', messages)];
  const cfg = { messagesPerPerson: 3, contextBefore: 1, maxChannelShare: 1 };
  const sample = sampleMember(windows, 'a', cfg, new Set());

  assert.equal(sample.ownCount, 3);
  assert.deepEqual([...sample.ownIds].sort(), ['1', '3', '5']);
  // context: msg0 (before msg1), msg2 (before msg3, and also the reply target of msg5), msg4 (before msg5)
  assert.equal(sample.contextCount, 3);
  assert.deepEqual(sample.messages.map((m) => m.id), ['0', '1', '2', '3', '4', '5']);
});

test('sampleMember: overlapping context windows are merged, never double-counted', () => {
  const messages = [
    msg(0, 0, { authorId: 'other' }),
    msg(1, 1000, { authorId: 'other' }),
    msg(2, 2000, { authorId: 'a' }), // own
    msg(3, 3000, { authorId: 'a' }), // own, right after msg 2
    msg(4, 4000, { authorId: 'other' }),
  ];
  const windows = [win('c1', messages)];
  const cfg = { messagesPerPerson: 2, contextBefore: 2, maxChannelShare: 1 };
  const sample = sampleMember(windows, 'a', cfg, new Set());

  // msg2's context wants {0,1}; msg3's context wants {1,2} (2 is own already) -- msg1 must appear once.
  assert.equal(sample.ownCount, 2);
  assert.equal(sample.contextCount, 2); // msg0, msg1 -- msg4 is never pulled in
  assert.deepEqual(sample.messages.map((m) => m.id), ['0', '1', '2', '3']);
});

test('sampleMember: a non-main channel is capped at maxChannelShare of the total sample', () => {
  const c1 = Array.from({ length: 10 }, (_, i) => msg(`c1-${i}`, i * 1000, { authorId: 'a', channelId: 'c1', channelName: 'c1' }));
  const c2 = Array.from({ length: 10 }, (_, i) => msg(`c2-${i}`, i * 1000, { authorId: 'a', channelId: 'c2', channelName: 'c2' }));
  const windows = [win('c1', c1), win('c2', c2)];
  const cfg = { messagesPerPerson: 6, contextBefore: 0, maxChannelShare: 0.5 };
  const sample = sampleMember(windows, 'a', cfg, new Set());

  assert.equal(sample.ownCount, 6);
  const perChannel = { c1: 0, c2: 0 };
  for (const id of sample.ownIds) perChannel[id.startsWith('c1') ? 'c1' : 'c2'] += 1;
  assert.equal(perChannel.c1, 3);
  assert.equal(perChannel.c2, 3);
});

test('sampleMember: a main channel is exempt from the share cap and filled first', () => {
  const main = Array.from({ length: 5 }, (_, i) => msg(`m-${i}`, i * 1000, { authorId: 'a', channelId: 'main', channelName: 'main' }));
  const other = Array.from({ length: 10 }, (_, i) => msg(`o-${i}`, i * 1000, { authorId: 'a', channelId: 'other', channelName: 'other' }));
  const windows = [win('main', main), win('other', other)];
  // Non-main share cap would be floor(6 * 0.3) = 1 -- the main channel must ignore it entirely.
  const cfg = { messagesPerPerson: 6, contextBefore: 0, maxChannelShare: 0.3 };
  const sample = sampleMember(windows, 'a', cfg, new Set(['main']));

  const fromMain = [...sample.ownIds].filter((id) => id.startsWith('m-')).length;
  const fromOther = [...sample.ownIds].filter((id) => id.startsWith('o-')).length;
  assert.equal(fromMain, 5); // all of the main channel's own messages, uncapped
  assert.equal(fromOther, 1); // the remaining budget, capped at the non-main share
});

// ---------------------------------------------------------------------------
// selectChannelMessages
// ---------------------------------------------------------------------------

test('selectChannelMessages: keeps the newest N, chronological order preserved', () => {
  const messages = Array.from({ length: 5 }, (_, i) => msg(i, i * 1000));
  assert.deepEqual(selectChannelMessages(messages, 2).map((m) => m.id), ['3', '4']);
});

test('selectChannelMessages: an invalid/absent N keeps everything', () => {
  const messages = Array.from({ length: 3 }, (_, i) => msg(i, i * 1000));
  assert.deepEqual(selectChannelMessages(messages, 0), messages);
  assert.deepEqual(selectChannelMessages(messages, undefined), messages);
});

// ---------------------------------------------------------------------------
// markOwnContext
// ---------------------------------------------------------------------------

test('markOwnContext: marks only the message line, not a channel heading or gap marker', () => {
  const items = [
    { id: '1', text: '## #general (id:c1)\n[00:00] Nick (id:a): hi' },
    { id: '2', text: '--- 5 min passed ---\n[00:05] Nick (id:a): again' },
  ];
  const marked = markOwnContext(items, new Set(['1']), labels);
  assert.equal(marked[0].text, '## #general (id:c1)\n[own] [00:00] Nick (id:a): hi');
  assert.equal(marked[1].text, '--- 5 min passed ---\n[ctx] [00:05] Nick (id:a): again');
});

test('markOwnContext: missing labels leaves every item untouched, nothing skipped', () => {
  const items = [{ id: '1', text: 'line one' }, { id: '2', text: 'line two' }];
  const marked = markOwnContext(items, new Set(['1']), {});
  assert.deepEqual(marked, items);
});

// ---------------------------------------------------------------------------
// buildChannelRequest
// ---------------------------------------------------------------------------

function baseConfig(overrides = {}) {
  return {
    bot: { timezone: 'UTC' },
    context: { gapMarkerMinutes: 20, maxMessageChars: 800 },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
    memory: {
      fieldChars: 400,
      maxInterests: 12,
      maxDetails: 15,
      interestTopicChars: 40,
      interestNoteChars: 120,
      maxNewEpisodes: 3,
      clampTolerance: 1.25,
    },
    ...overrides,
  };
}

test('buildChannelRequest: fills {{fieldChars}} and the <channel>/<messages> blocks', () => {
  const messages = [msg(1, 1000, { authorId: 'a', authorName: 'Alice', channelId: 'general', channelName: 'general' })];
  const { messages: llmMessages } = buildChannelRequest({
    prompts: { channel: 'CHANNEL fields={{fieldChars}}', labels },
    config: baseConfig(),
    calibrator: createCalibrator(),
    channel: { id: 'general', name: 'general', category: 'Chat', topic: 'general chatter' },
    messages,
    isMain: true,
  });
  assert.equal(llmMessages[0].content, 'CHANNEL fields=400');
  const user = llmMessages[1].content;
  assert.match(user, /<channel>\ngeneral \(id:general\), category: Chat, topic: general chatter, main: true\n<\/channel>/);
  assert.match(user, /<messages>[\s\S]*<\/messages>/);
});

test('serverTemplateValues: guildFieldChars is twice memory.fieldChars, the limit clampServerResult cuts patterns and starters to', () => {
  const config = baseConfig({ memory: { fieldChars: 400, maxInjokes: 7, clampTolerance: 1 }, lore: { textChars: 300 } });
  const values = serverTemplateValues(config, 'Nept');
  assert.deepEqual(values, { name: 'Nept', fieldChars: 400, guildFieldChars: 800, maxInjokes: 7, loreTextChars: 300 });
  assert.equal(serverTemplateValues(config).guildFieldChars, 2 * config.memory.fieldChars);

  const clamped = clampServerResult({ patterns: 'p'.repeat(1500), starters: 's'.repeat(1500), injokes: Array.from({ length: 9 }, (_, i) => `αστείο ${i}`) }, config);
  assert.equal(clamped.patterns.length, values.guildFieldChars, 'the prompt states the limit the code clamps to');
  assert.equal(clamped.starters.length, values.guildFieldChars);
  assert.equal(clamped.injokes.length, values.maxInjokes);
});

test('code fallbacks: every setting the module defaults when it is missing equals config.json', () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json'), 'utf8'));
  assert.deepEqual(profileTemplateValues({}, 'Nept'), profileTemplateValues(shipped, 'Nept'));
  assert.deepEqual(channelTemplateValues({}), channelTemplateValues(shipped));
  assert.deepEqual(serverTemplateValues({}, 'Nept'), serverTemplateValues(shipped, 'Nept'));
  assert.deepEqual(channelTemplateValues(shipped), { fieldChars: shipped.memory.fieldChars });
  assert.equal(serverTemplateValues(shipped).guildFieldChars, 2 * shipped.memory.fieldChars);
  assert.equal(profileTemplateValues(shipped, 'Nept').maxNewEpisodes, shipped.memory.maxNewEpisodes);

  const channelRequest = (config) =>
    buildChannelRequest({
      prompts: { channel: 'CHANNEL fields={{fieldChars}}', labels },
      config,
      calibrator: createCalibrator(),
      channel: { id: 'general', name: 'general', category: null, topic: null },
      messages: [msg(1, 1000)],
      isMain: false,
    }).messages[0].content;
  assert.equal(channelRequest(baseConfig({ memory: {} })), `CHANNEL fields=${shipped.memory.fieldChars}`);

  const long = { patterns: 'p'.repeat(5000), lore: [{ title: 'T', keys: ['k1'], text: 'l'.repeat(5000) }] };
  const clamped = clampServerResult(long, { memory: { clampTolerance: 1 } });
  assert.equal(clamped.patterns.length, 2 * shipped.memory.fieldChars);
  assert.equal(clamped.lore[0].text.length, shipped.lore.textChars);

  const twoStage = { features: { memoryTwoStage: true }, llm: { model: 'talk/model' }, memory: {} };
  assert.equal(warmupRoute(twoStage).maxOutputTokens, shipped.memory.maxOutputTokens);
});

test('buildChannelRequest: missing labels fail loudly, like the stream analyzer, never a request without them', () => {
  assert.throws(
    () =>
      buildChannelRequest({
        prompts: { channel: 'CHANNEL' },
        config: baseConfig(),
        calibrator: createCalibrator(),
        channel: { id: 'general', name: 'general', category: null, topic: null },
        messages: [msg(1, 1000)],
        isMain: false,
      }),
    /labels/,
  );
});

test('createWarmup: a person or server request without labels fails loudly, nothing sent', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })])]));
  const hot = fakeHot({ prompts: { labels: undefined } });
  hot.config.warmup.minMessages = 1;
  const llm = scriptedLlm([{}]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await assert.rejects(warmup.runPerson('g1', 'a'), /labels/);
  await assert.rejects(warmup.runServer('g1'), /labels/);
  assert.equal(llm.calls.length, 0);
});

test('buildChannelRequest: fitting drops the OLDEST messages only', () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    msg(i, i * 60_000, { authorId: 'a', authorName: 'Alice', channelId: 'general', channelName: 'general', content: `content number ${i} padded out` }),
  );
  const config = baseConfig({ llm: { maxRequestTokens: 220, safetyMargin: 1 } });
  const { messages, stats } = buildChannelRequest({
    prompts: { channel: 'CHANNEL', labels },
    config,
    calibrator: createCalibrator(),
    channel: { id: 'general', name: 'general', category: null, topic: null },
    messages: many,
    isMain: false,
  });
  assert.ok(stats.dropped > 0);
  const user = messages[1].content;
  assert.ok(!user.includes('content number 0 '));
  assert.ok(user.includes(`content number ${many.length - 1} `));
});

// ---------------------------------------------------------------------------
// clampProfileResult / clampChannelResult
// ---------------------------------------------------------------------------

test('clampProfileResult: null on garbage input', () => {
  assert.equal(clampProfileResult(null, baseConfig()), null);
  assert.equal(clampProfileResult([1, 2], baseConfig()), null);
});

test('clampProfileResult: resolves a stale "Name (id:x)" form to the member\'s current name', () => {
  const bigId = '111111111111111111'; // toTokens' ID_MARKER_RE requires a 17-20 digit id
  const nameOf = (id) => (id === bigId ? 'Alice' : null);
  const result = clampProfileResult({ character: `often teases OldNick (id:${bigId}) about it` }, baseConfig(), nameOf);
  assert.equal(result.character, `often teases Alice (id:${bigId}) about it`);
});

test('clampProfileResult: dedupes interests/details case-insensitively, keeping the max "times"', () => {
  const result = clampProfileResult(
    {
      interests: [
        { topic: 'Anime', note: '', times: 1 },
        { topic: 'anime', note: 'watches subs', times: 2 },
      ],
      details: [
        { text: 'plays guitar', times: 1 },
        { text: 'Plays Guitar', times: 3 },
      ],
    },
    baseConfig(),
  );
  assert.equal(result.interests.length, 1);
  assert.equal(result.interests[0].topic, 'Anime');
  assert.equal(result.interests[0].note, 'watches subs');
  assert.equal(result.interests[0].times, 2);
  assert.equal(result.details.length, 1);
  assert.equal(result.details[0].times, 3);
});

test('clampProfileResult: episodes capped at memory.maxNewEpisodes; an alias is left for the store to clamp', () => {
  const episodes = Array.from({ length: 5 }, (_, i) => ({ date: '2026-01-01', what: `event ${i}`, weight: 3 }));
  const result = clampProfileResult({ episodes, aliases: ['x'.repeat(60), 42, ''] }, baseConfig());
  assert.equal(result.episodes.length, 3);
  assert.deepEqual(result.aliases, ['x'.repeat(60)]);
});

test('createWarmup: an alias, an episode weight and a lore title are clamped where they are stored', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })];
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history)]));
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;
  const llm = scriptedLlm([
    { character: 'c', style: 's', aliases: ['Αλέξανδρος '.repeat(6)], episodes: [{ date: '2026-01-01', what: 'won a game', weight: 9 }] },
    { patterns: 'p', lore: [{ title: 'Τίτλος '.repeat(20), keys: ['k1'], text: 'x' }] },
  ]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  assert.equal((await warmup.runPerson('g1', 'a')).ok, true);
  assert.equal((await warmup.runServer('g1')).ok, true);

  const profile = store.getUser('g1', 'a');
  assert.equal(profile.aliases.length, 1);
  assert.ok(profile.aliases[0].name.length <= 40);
  assert.equal(profile.episodes[0].weight, 5);
  assert.ok(store.getLore('g1')[0].title.length <= 80);
});

test('clampChannelResult: clamps purpose/topics/tone, null on garbage', () => {
  assert.equal(clampChannelResult('nope', baseConfig()), null);
  const result = clampChannelResult({ purpose: 'p'.repeat(1000), topics: 'chat', tone: 'casual' }, baseConfig());
  assert.ok(result.purpose.length <= 500); // 400 * clampTolerance 1.25
  assert.equal(result.topics, 'chat');
  assert.equal(result.tone, 'casual');
});

// ---------------------------------------------------------------------------
// clampServerResult
// ---------------------------------------------------------------------------

test('clampServerResult: empty fields on garbage input, never throws', () => {
  const result = clampServerResult('nope', baseConfig());
  assert.deepEqual(result, { patterns: '', starters: '', injokes: [], lore: [] });
});

test('clampServerResult: clamps patterns/starters/injokes and validates lore entries', () => {
  const result = clampServerResult(
    {
      patterns: 'people banter a lot',
      starters: 'someone posts a link',
      injokes: ['the eternal bug', 42, ''],
      lore: [{ title: 'The Great Outage', keys: ['outage', 'the incident'], text: 'server went down for a day' }, { title: '' }, 'nope'],
    },
    baseConfig(),
  );
  assert.equal(result.patterns, 'people banter a lot');
  assert.equal(result.starters, 'someone posts a link');
  assert.deepEqual(result.injokes, ['the eternal bug']);
  assert.equal(result.lore.length, 1);
  assert.equal(result.lore[0].title, 'The Great Outage');
  assert.deepEqual(result.lore[0].keys, ['outage', 'the incident']);
});

// ---------------------------------------------------------------------------
// takeFittingPrefix
// ---------------------------------------------------------------------------

test('takeFittingPrefix: greedily fills the prefix under budget, leaves the rest', () => {
  const items = [1, 2, 3, 4, 5];
  const { taken, rest } = takeFittingPrefix(items, 6, (n) => n);
  assert.deepEqual(taken, [1, 2, 3]); // 1+2+3=6 <= 6, +4 would overflow
  assert.deepEqual(rest, [4, 5]);
});

test('takeFittingPrefix: always takes at least one item, even an oversized one', () => {
  const items = [10, 1, 1];
  const { taken, rest } = takeFittingPrefix(items, 1, (n) => n);
  assert.deepEqual(taken, [10]);
  assert.deepEqual(rest, [1, 1]);
});

// ---------------------------------------------------------------------------
// buildPersonWriteIterations
// ---------------------------------------------------------------------------

test('buildPersonWriteIterations: character/style/aliases/episodes land only on the first iteration', () => {
  const answer = { character: 'friendly', style: 'short', interests: [], details: [], episodes: [{ date: '2026-01-01', what: 'x', weight: 3 }], aliases: ['Al'] };
  const iterations = buildPersonWriteIterations(answer);
  assert.equal(iterations.length, 1);
  assert.equal(iterations[0].character, 'friendly');
  assert.equal(iterations[0].style, 'short');
  assert.deepEqual(iterations[0].aliases, { add: ['Al'] });
  assert.deepEqual(iterations[0].episodes, answer.episodes);
});

test('buildPersonWriteIterations: an interest/detail with times: N appears in exactly the first N iterations', () => {
  const answer = {
    interests: [{ topic: 'anime', note: '', times: 3 }, { topic: 'chess', note: '', times: 1 }],
    details: [{ text: 'plays guitar', times: 2 }],
  };
  const iterations = buildPersonWriteIterations(answer);
  assert.equal(iterations.length, 3);
  assert.deepEqual(iterations[0].interests.add.map((i) => i.topic), ['anime', 'chess']);
  assert.deepEqual(iterations[1].interests.add.map((i) => i.topic), ['anime']);
  assert.deepEqual(iterations[2].interests.add.map((i) => i.topic), ['anime']);
  // The ops-object shape (`{ add }`), the only one applyMemoryUpdate / store.applyProfileOps accept.
  assert.deepEqual(iterations[0].details, { add: ['plays guitar'] });
  assert.deepEqual(iterations[1].details, { add: ['plays guitar'] });
  assert.equal(iterations[2].details, undefined);
});

test('buildPersonWriteIterations: an empty answer yields no iterations', () => {
  assert.deepEqual(buildPersonWriteIterations({ character: '', style: '', interests: [], details: [], episodes: [], aliases: [] }), []);
});

// ---------------------------------------------------------------------------
// Factory: createWarmup against a fake discord.js guild + fake LLM client
// ---------------------------------------------------------------------------

function fakeChannel(id, historyAsc, { name = id, category = null, topic = null, deny = false } = {}) {
  for (const m of historyAsc) m.channelId = id;
  const desc = [...historyAsc].reverse();
  return {
    id,
    name,
    parent: category ? { name: category } : null,
    topic,
    guild: null,
    isTextBased: () => true,
    isThread: () => false,
    viewable: true,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetchCalls: 0,
      fetch(opts = {}) {
        this.fetchCalls += 1;
        const limit = opts.limit ?? 50;
        let pool = desc;
        if (opts.before) {
          const beforeNum = BigInt(opts.before);
          pool = pool.filter((m) => BigInt(m.id) < beforeNum);
        }
        return Promise.resolve(new Map(pool.slice(0, limit).map((m) => [m.id, m])));
      },
    },
    _deny: deny,
  };
}

function fakeGuild(id, channels) {
  const guild = { id, channels: { cache: new Map(channels.map((c) => [c.id, c])) }, members: { me: { displayName: 'Bot' } } };
  for (const c of channels) c.guild = guild;
  return guild;
}

function fakeClient(guild) {
  return { user: { id: 'selfUser' }, guilds: { cache: new Map([[guild.id, guild]]) } };
}

/** A raw discord.js-shaped message for fakeChannel's history array. */
function rawMessage(ts, { authorId = 'a', bot = false, content = 'hi', replyToId = null } = {}) {
  return {
    id: String(ts),
    author: { id: authorId, bot, globalName: authorId, username: authorId },
    member: { displayName: authorId },
    cleanContent: content,
    createdTimestamp: ts,
    reference: replyToId ? { messageId: replyToId } : null,
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    messageSnapshots: new Map(),
  };
}

function fakeHot(overrides = {}) {
  return {
    config: {
      bot: { timezone: 'UTC', channels: { allow: [], deny: [] } },
      context: { gapMarkerMinutes: 20, maxMessageChars: 800 },
      llm: { model: 'talk/model', maxRequestTokens: 50000, safetyMargin: 0.9 },
      memory: {
        model: null,
        mainChannelIds: [],
        fieldChars: 400,
        maxInterests: 12,
        maxDetails: 15,
        maxEpisodes: 20,
        maxInjokes: 15,
        interestTopicChars: 40,
        interestNoteChars: 120,
        maxNewEpisodes: 3,
        clampTolerance: 1.25,
        confirmGapHours: 12,
        portraitRefreshHours: 24,
        portraitRefreshPerDay: 20,
      },
      lore: { maxEntries: 500, textChars: 400 },
      media: {},
      warmup: {
        enabled: true,
        lookbackDays: 60,
        minMessages: 2,
        maxPeople: 40,
        messagesPerPerson: 10,
        contextBefore: 1,
        maxChannelShare: 1,

        messagesPerChannel: 50,
        serverSampleMessages: 50,
        fetchLimitPerChannel: 1000,
        maxRequestTokens: 50000,
        maxOutputTokens: 6000,
        maxTokens: 6_000_000,
        rateLimitWaitMinutes: 10,
        rateLimitMaxWaits: 36,
      },
      ...overrides.config,
    },
    prompts: {
      profile: 'SYSTEM {{name}}',
      channel: 'CHANNEL {{fieldChars}}',
      server: 'SERVER {{fieldChars}}',
      'character-card': 'CARD {{name}}',
      labels,
      ...overrides.prompts,
    },
  };
}

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nep-warmup-store-'));
}

/** A fake sleep that resolves immediately but records every requested duration. */
function fakeSleep() {
  const calls = [];
  const sleep = (ms) => {
    calls.push(ms);
    return Promise.resolve();
  };
  sleep.calls = calls;
  return sleep;
}

function fakeLlm(script) {
  const calls = [];
  return {
    calls,
    complete: async (messages, opts) => {
      calls.push({ messages, opts });
      return script(calls.length - 1, messages, opts);
    },
  };
}

test('createWarmup: peopleReport respects bot.channels.deny and reports totals', async () => {
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' }), rawMessage(3000, { authorId: 'b' })]);
  const denied = fakeChannel('c2', [rawMessage(1000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1, denied]);
  const client = fakeClient(guild);
  const hot = fakeHot({ config: { bot: { timezone: 'UTC', channels: { allow: [], deny: ['c2'] } } } });
  hot.config.warmup.minMessages = 2;
  const warmup = createWarmup({ hot, client, llm: fakeLlm(() => ({})), calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const report = await warmup.peopleReport('g1');
  assert.equal(report.ok, true);
  assert.equal(report.totals.channelsRead, 1); // c2 denied, never fetched
  assert.equal(report.totals.messagesRead, 3);
  assert.deepEqual(report.people.map((p) => p.id), ['a']); // b has only 1 message, below minMessages
  assert.equal(report.totals.belowThreshold, 1);
});

test('createWarmup: fetched windows are cached for 15 minutes per guild', async () => {
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  let nowMs = 1_000_000;
  const warmup = createWarmup({ hot, client, llm: fakeLlm(() => ({})), calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => nowMs });

  await warmup.peopleReport('g1');
  await warmup.peopleReport('g1');
  assert.equal(c1.messages.fetchCalls, 1, 'second call within the cache window must not refetch');

  nowMs += 16 * 60_000;
  await warmup.peopleReport('g1');
  assert.equal(c1.messages.fetchCalls, 2, 'a call after the cache expired must refetch');
});

test('createWarmup: peopleReport never writes anything under a real data/ directory', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-warmup-data-'));
  fs.writeFileSync(path.join(dataDir, 'marker.json'), '{}');
  const before = fs.readdirSync(dataDir).sort();

  try {
    const history = Array.from({ length: 3 }, (_, i) => rawMessage(1000 + i * 1000, { authorId: 'a' }));
    const c1 = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [c1]);
    const client = fakeClient(guild);
    const hot = fakeHot();
    hot.config.warmup.minMessages = 1;
    const warmup = createWarmup({ hot, client, llm: fakeLlm(() => ({})), calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

    await warmup.peopleReport('g1');
    await warmup.peopleReport('g1');

    assert.deepEqual(fs.readdirSync(dataDir).sort(), before);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Factory write path: run() / runXxx() / refreshPortrait() against a real
// (temp-dir) store.
// ---------------------------------------------------------------------------

/** Polls `predicate` on the microtask queue (no real timer) until it is true, or throws after
 * `tries` empty polls -- used only to observe a fake async dependency (fetch, `llm.complete`) has
 * actually been reached mid-flight, without hardcoding how many awaits its callers take to get
 * there. */
async function waitFor(predicate, tries = 50) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('waitFor: condition not met in time');
}

/** A fake `llm.complete` whose promise never settles on its own -- it only rejects once
 * `opts.signal` (the AbortController `callWithRails` now attaches to every call) actually fires,
 * exactly as a real cancelled `fetch` would. Simulates the model call a `/nep warmup stop` catches
 * mid-flight. */
function abortAwareLlm() {
  const calls = [];
  return {
    calls,
    complete: (messages, opts) => {
      calls.push({ messages, opts });
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });
    },
  };
}

function scriptedLlm(results) {
  const calls = [];
  return {
    calls,
    complete: async (messages, opts) => {
      const i = calls.length;
      calls.push({ messages, opts });
      const entry = results[Math.min(i, results.length - 1)];
      const payload = typeof entry === 'function' ? entry(i, messages, opts) : entry;
      if (payload instanceof Error) throw payload;
      return { text: JSON.stringify(payload), usage: { prompt_tokens: 100, completion_tokens: 20 }, estimated: 120, finishReason: 'stop' };
    },
  };
}

test('createWarmup: run() processes channels, then people, then the server, writing through the store', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = [
    rawMessage(1000, { authorId: 'a', content: 'hi one' }),
    rawMessage(2000, { authorId: 'a', content: 'hi two' }),
    rawMessage(3000, { authorId: 'a', content: 'hi three' }),
  ];
  const c1 = fakeChannel('c1', history, { name: 'general', category: 'Chat', topic: 'chit-chat' });
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();

  const llm = scriptedLlm([
    { purpose: 'general chatter', topics: 'everything', tone: 'casual' }, // channel c1
    { character: 'friendly and curious', style: 'short messages', interests: [{ topic: 'anime', note: 'watches subs', times: 2 }], details: [], episodes: [], aliases: [] }, // person a
    { patterns: 'lots of banter', starters: 'someone posts a link', injokes: ['the eternal bug'], lore: [{ title: 'The Outage', keys: ['outage'], text: 'the server went down once' }] }, // server
  ]);

  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  const result = await warmup.run('g1');

  assert.equal(result.ok, true);
  assert.equal(llm.calls.length, 3);

  const channel = store.getChannel('g1', 'c1');
  assert.equal(channel.purpose, 'general chatter');

  const profile = store.getUser('g1', 'a');
  assert.equal(profile.character, 'friendly and curious');
  assert.equal(profile.messageCount, 3);
  assert.equal(profile.interests.length, 1);
  assert.equal(profile.interests[0].weight, 2); // times: 2 -> weight 2, via two sightings

  const guildMemory = store.getGuild('g1');
  assert.equal(guildMemory.patterns, 'lots of banter');
  assert.deepEqual(guildMemory.injokes, ['the eternal bug']);
  assert.equal(store.getLore('g1').length, 1);

  const bs = store.state.data.warmup;
  assert.deepEqual(bs.done.channels, ['c1']);
  assert.deepEqual(bs.done.people, ['a']);
  assert.equal(bs.done.server, true);
  assert.ok(bs.startedAt);
  assert.ok(bs.finishedAt);
  assert.equal(bs.aborted, null);
});

test('createWarmup: run() is idempotent once finished -- a second call makes no further requests', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })];
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: 'p', topics: 't', tone: 'x' }, { character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }, { patterns: '', starters: '', injokes: [], lore: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup.run('g1');
  const callsAfterFirst = llm.calls.length;

  const failingLlm = { complete: async () => { throw new Error('must not be called again'); } };
  const warmup2 = createWarmup({ hot, store, client, llm: failingLlm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  const second = await warmup2.run('g1');

  assert.equal(second.ok, true);
  assert.equal(llm.calls.length, callsAfterFirst); // unchanged -- the second run made no new model calls
});

test('createWarmup: run() resumes after a stop, never reprocessing a done item', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history1 = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })];
  const history2 = [rawMessage(1000, { authorId: 'b' }), rawMessage(2000, { authorId: 'b' })];
  const c1 = fakeChannel('c1', history1);
  const c2 = fakeChannel('c2', history2);
  const guild = fakeGuild('g1', [c1, c2]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.maxTokens = 1; // stop immediately, before the very first request

  const llm1 = scriptedLlm([{ purpose: 'p' }]);
  const warmup1 = createWarmup({ hot, store, client, llm: llm1, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  const first = await warmup1.run('g1');
  assert.equal(first.ok, false);
  assert.equal(llm1.calls.length, 0);
  assert.equal(store.state.data.warmup.aborted, 'budget');
  assert.deepEqual(store.state.data.warmup.done.channels, []);

  hot.config.warmup.maxTokens = 6_000_000; // lift the rail, resume
  const llm2 = scriptedLlm([
    { purpose: 'p1' },
    { purpose: 'p2' },
    { character: 'ca', style: 'sa', interests: [], details: [], episodes: [], aliases: [] },
    { character: 'cb', style: 'sb', interests: [], details: [], episodes: [], aliases: [] },
    { patterns: '', starters: '', injokes: [], lore: [] },
  ]);
  const warmup2 = createWarmup({ hot, store, client, llm: llm2, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  const second = await warmup2.run('g1');

  assert.equal(second.ok, true);
  assert.deepEqual(store.state.data.warmup.done.channels.sort(), ['c1', 'c2']);
  assert.deepEqual(store.state.data.warmup.done.people.sort(), ['a', 'b']);
  assert.equal(store.state.data.warmup.aborted, null);
});

test('createWarmup: run() refuses while another run is already in flight', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();

  let resolveFirst;
  const gate = new Promise((resolve) => { resolveFirst = resolve; });
  const llm = { complete: async () => { await gate; return { text: '{}', usage: {}, estimated: 0, finishReason: 'stop' }; } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const firstRun = warmup.run('g1');
  assert.equal(warmup.isWarmingUp(), true);
  const secondRun = await warmup.run('g1');
  assert.equal(secondRun.ok, false);
  assert.match(secondRun.message, /already in flight/);

  resolveFirst();
  await firstRun;
  assert.equal(warmup.isWarmingUp(), false);
});

test('createWarmup: run() pauses after the request in flight, resumable', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const c2 = fakeChannel('c2', [rawMessage(1000, { authorId: 'b' }), rawMessage(2000, { authorId: 'b' })]);
  const guild = fakeGuild('g1', [c1, c2]);
  const client = fakeClient(guild);
  const hot = fakeHot();

  const llm = scriptedLlm([
    (i) => {
      store.state.data.paused = true; // simulate /nep pause landing while call #1 was in flight
      return { purpose: 'p1' };
    },
    { purpose: 'p2' }, // must never be reached
  ]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await warmup.run('g1');
  assert.equal(result.ok, false);
  assert.equal(llm.calls.length, 1);
  assert.deepEqual(store.state.data.warmup.done.channels, ['c1']);
});

// ---------------------------------------------------------------------------
// /nep warmup stop -- stopRequested, honoured at the same checkpoints as
// store.state.data.paused, cleared at the start of every run().
// ---------------------------------------------------------------------------

test('createWarmup: stop() ends the run after the request in flight, activity stopped, progress kept, nothing marked aborted', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const c2 = fakeChannel('c2', [rawMessage(1000, { authorId: 'b' }), rawMessage(2000, { authorId: 'b' })]);
  const guild = fakeGuild('g1', [c1, c2]);
  const client = fakeClient(guild);
  const hot = fakeHot();

  const llm = scriptedLlm([
    () => {
      const result = warmup.stop(); // simulate /nep warmup stop landing while call #1 was in flight
      assert.equal(result.ok, true);
      return { purpose: 'p1' };
    },
    { purpose: 'p2' }, // must never be reached
  ]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await warmup.run('g1');
  assert.equal(result.ok, false);
  assert.equal(result.message, 'stopped');
  assert.equal(llm.calls.length, 1); // c2 never reached
  assert.deepEqual(store.state.data.warmup.done.channels, ['c1']); // progress kept
  assert.equal(store.state.data.warmup.aborted, null); // nothing marks it aborted

  const status = warmup.status('g1');
  assert.equal(status.activity.phase, 'stopped');
  assert.equal(status.stopRequested, true);
});

test('createWarmup: run() clears stopRequested at the start of the next run', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;

  let sawStopRequestedDuringSecondRun = null;
  const llm = scriptedLlm([
    () => { warmup.stop(); return { purpose: 'p1' }; }, // channel call: request a stop mid-run
    () => {
      sawStopRequestedDuringSecondRun = warmup.status('g1').stopRequested;
      return { character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] };
    },
    { patterns: '', starters: '', injokes: [], lore: [] },
  ]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const first = await warmup.run('g1');
  assert.equal(first.message, 'stopped');
  assert.equal(warmup.status('g1').stopRequested, true);

  const second = await warmup.run('g1');
  assert.equal(sawStopRequestedDuringSecondRun, false); // cleared before the person request that follows
  assert.equal(second.ok, true);
  assert.equal(warmup.status('g1').stopRequested, false);
});

// ---------------------------------------------------------------------------
// /nep warmup stop cancels the model call ACTUALLY in flight (an
// AbortController threaded through llm.complete's `signal`), not just the
// loop after it finishes -- see src/memory/warmup.js#callWithRails/`stop`.
// ---------------------------------------------------------------------------

test('createWarmup: stop() aborts the model call in flight during a bulk users run; nothing written for that target, resumable', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;

  const llm = abortAwareLlm();
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const started = await warmup.runUsers('g1');
  assert.equal(started.ok, true);
  assert.equal(started.count, 1);
  assert.equal(llm.calls.length, 1, 'the person request must already be in flight');
  assert.equal(llm.calls[0].opts.signal.aborted, false);

  const stopResult = warmup.stop();
  assert.equal(stopResult.ok, true);
  assert.equal(llm.calls[0].opts.signal.aborted, true, '/nep warmup stop must cancel the in-flight call');

  await warmup.waitIdle();

  assert.equal(llm.calls.length, 1, 'no retry after a deliberate abort');
  assert.deepEqual(store.state.data.warmup.done.people, []); // not marked done
  assert.equal(store.getUser('g1', 'a'), null); // nothing partial written
  assert.equal(store.state.data.warmup.aborted, null); // a deliberate stop, never a failure

  const status = warmup.status('g1');
  assert.equal(status.running, false);
  assert.equal(status.activity.phase, 'stopped');

  // Later: a fresh warmup users run resumes and actually profiles the member.
  const llm2 = scriptedLlm([{ character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }]);
  const warmup2 = createWarmup({ hot, store, client, llm: llm2, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  const resumed = await warmup2.runUsers('g1');
  assert.equal(resumed.ok, true);
  await warmup2.waitIdle();
  assert.deepEqual(store.state.data.warmup.done.people, ['a']);
});

test('createWarmup: stop() aborts the model call in flight during a synchronous warmup users one-off (a single member)', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();

  const llm = abortAwareLlm();
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const runPromise = warmup.runPerson('g1', 'a');
  // Let the synchronous one-off actually reach its (hanging) model call before stopping it.
  await waitFor(() => llm.calls.length === 1);

  const stopResult = warmup.stop();
  assert.equal(stopResult.ok, true);
  assert.equal(llm.calls[0].opts.signal.aborted, true);

  const result = await runPromise;
  assert.equal(result.ok, false);
  assert.equal(result.message, 'stopped');
  assert.equal(store.getUser('g1', 'a'), null);
  assert.deepEqual(store.state.data.warmup.done.people, []);
});

test('createWarmup: run() waits out a sustained rate limit then aborts (resumable)', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.rateLimitMaxWaits = 2;

  const rateLimitError = new Error('rate limited');
  rateLimitError.statusCode = 429;
  const llm = { complete: async () => { throw rateLimitError; } };
  const sleep = fakeSleep();
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000, sleep });

  const result = await warmup.run('g1');
  assert.equal(result.ok, false);
  assert.equal(sleep.calls.length, 2); // 2 allowed waits, then a 3rd attempt that also fails -> abort without a 3rd wait
  assert.equal(store.state.data.warmup.aborted, 'rate-limit');
});

test('createWarmup: run() aborts after three consecutive other failures (resumable)', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const c2 = fakeChannel('c2', [rawMessage(1000, { authorId: 'b' }), rawMessage(2000, { authorId: 'b' })]);
  const c3 = fakeChannel('c3', [rawMessage(1000, { authorId: 'c' }), rawMessage(2000, { authorId: 'c' })]);
  const guild = fakeGuild('g1', [c1, c2, c3]);
  const client = fakeClient(guild);
  const hot = fakeHot();

  let calls = 0;
  const llm = { complete: async () => { calls += 1; throw new Error(`boom ${calls}`); } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await warmup.run('g1');
  assert.equal(result.ok, false);
  assert.equal(calls, 3);
  assert.equal(store.state.data.warmup.aborted, 'failures');
  assert.deepEqual(store.state.data.warmup.done.channels, []); // nothing ever succeeded
});

test('createWarmup: run() reports a missing prompts.profile instead of throwing', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot({ prompts: { profile: undefined } });
  const llm = scriptedLlm([{ purpose: 'p' }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await warmup.run('g1');
  assert.equal(result.ok, false);
  assert.match(result.message, /profile\.md/);
});

test('createWarmup: a person whose sample does not fit one request is chunked, each later chunk carrying a <draft>, the LAST answer wins', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = Array.from({ length: 12 }, (_, i) => rawMessage(1000 + i * 1000, { authorId: 'a', content: `padded message content number ${i} with extra words to make it long` }));
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;
  hot.config.warmup.messagesPerPerson = 12;
  hot.config.warmup.contextBefore = 0;
  hot.config.warmup.maxRequestTokens = 90;
  hot.config.llm.safetyMargin = 1;

  const llm = scriptedLlm([
    (i) => ({ character: `chunk-${i}`, style: 's', interests: [], details: [], episodes: [], aliases: [] }),
  ]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.runPerson('g1', 'a');
  assert.equal(outcome.ok, true);
  assert.ok(llm.calls.length > 1, 'expected the sample to be split into more than one request');

  const firstUser = llm.calls[0].messages[1].content;
  assert.ok(!firstUser.includes('<draft>'));
  const secondUser = llm.calls[1].messages[1].content;
  assert.ok(secondUser.includes('<draft>'));
  assert.ok(secondUser.includes('chunk-0'));

  const profile = store.getUser('g1', 'a');
  assert.equal(profile.character, `chunk-${llm.calls.length - 1}`); // the LAST answer wins
});

test('createWarmup: a bad-json person answer is retried once with half the sample, then skipped', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = Array.from({ length: 4 }, (_, i) => rawMessage(1000 + i * 1000, { authorId: 'a', content: `m${i}` }));
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;

  let calls = 0;
  const llm = { complete: async () => { calls += 1; return { text: 'not json at all', usage: {}, estimated: 0, finishReason: 'stop' }; } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.runPerson('g1', 'a');
  assert.equal(outcome.ok, false);
  assert.equal(calls, 2); // one attempt, one retry with half the sample
  const store2 = store; // the person is marked done (skipped), not retried forever
  assert.deepEqual(store2.state.data.warmup.done.people, ['a']);
});

test('createWarmup: every failed target carries a reason; only a final skip is marked done', async () => {
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })];
  const setup = (llm, tweak = () => {}) => {
    const store = createStore({ dataDir: tmpDataDir() });
    const hot = fakeHot();
    hot.config.warmup.minMessages = 1;
    tweak(hot);
    const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history.map((m) => ({ ...m })))]));
    return { store, warmup: createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 }) };
  };
  const garbage = { complete: async () => ({ text: 'not json', usage: {}, estimated: 0, finishReason: 'stop' }) };
  const failing = { complete: async () => { throw new Error('provider down'); } };
  const tinyCap = (hot) => {
    hot.config.warmup.maxRequestTokens = 3;
    hot.config.llm.safetyMargin = 1;
  };

  let run = setup(garbage);
  assert.equal((await run.warmup.runChannel('g1', 'c1')).message, 'bad-json');
  assert.deepEqual(run.store.state.data.warmup.done.channels, [], 'retried next run');
  assert.equal((await run.warmup.runServer('g1')).message, 'bad-json');
  assert.equal(run.store.state.data.warmup.done.server, false, 'retried next run');
  const unparsable = await run.warmup.runPerson('g1', 'a');
  assert.equal(unparsable.message, 'unparsable');
  assert.equal(unparsable.outcome.skipped, true);
  assert.deepEqual(run.store.state.data.warmup.done.people, ['a'], 'a final skip: marked done');

  run = setup(failing);
  assert.equal((await run.warmup.runPerson('g1', 'a')).message, 'llm-error');
  assert.deepEqual(run.store.state.data.warmup.done.people, [], 'retried next run');

  run = setup(garbage, tinyCap);
  assert.equal((await run.warmup.runChannel('g1', 'c1')).message, 'over-cap');
  const overCap = await run.warmup.runPerson('g1', 'a');
  assert.equal(overCap.message, 'over-cap');
  assert.equal(overCap.outcome.skipped, undefined, 'not a final skip: a larger cap fixes it');
  assert.deepEqual(run.store.state.data.warmup?.done?.people ?? [], []);
});

// ---------------------------------------------------------------------------
// /nep warmup users user:<member> / channels channel:<channel> / server
// (runPerson/runChannel/runServer's richer outcome) and /nep warmup
// users/channels with no member/channel (runUsers/runChannels, the
// background bulk redo sharing `running` with run()).
// ---------------------------------------------------------------------------

test('createWarmup: runPerson reports "no messages in the window" when the member never wrote at all', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'other' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = { complete: async () => { throw new Error('must not be called'); } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.runPerson('g1', 'ghost');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.message, 'no messages in the window');
});

test('createWarmup: runPerson stores the answer\'s details, each at the weight of its "times"', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = [rawMessage(1000, { authorId: 'a', content: 'hi one' }), rawMessage(2000, { authorId: 'a', content: 'hi two' })];
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;
  const llm = scriptedLlm([
    { character: 'friendly', style: 'short', interests: [], details: [{ text: 'plays guitar', times: 2 }, { text: 'owns a cat', times: 1 }], episodes: [], aliases: [] },
  ]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.runPerson('g1', 'a');
  assert.equal(outcome.ok, true);

  const details = store.getUser('g1', 'a').details;
  assert.deepEqual(
    details.map(({ text, weight }) => ({ text, weight })),
    [
      { text: 'plays guitar', weight: 2 },
      { text: 'owns a cat', weight: 1 },
    ],
  );
});

test('createWarmup: runPerson appends prompts.rules after the card in the <character> block', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = [rawMessage(1000, { authorId: 'a', content: 'hi one' }), rawMessage(2000, { authorId: 'a', content: 'hi two' })];
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot({ prompts: { rules: 'Never repeat yourself.' } });
  hot.config.warmup.minMessages = 1;
  const llm = scriptedLlm([{ character: 'friendly', style: 'short', interests: [], details: [], episodes: [], aliases: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup.runPerson('g1', 'a');

  const user = llm.calls[0].messages[1].content;
  assert.match(user, /<character>\nCARD Nept\n\nNever repeat yourself\.\n<\/character>/);
});

test('createWarmup: processChannel fills the channel\'s counters and top writers from the messages it actually had', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = [
    rawMessage(1000, { authorId: 'a' }),
    rawMessage(2000, { authorId: 'a' }),
    rawMessage(3000, { authorId: 'b' }),
    rawMessage(4000, { authorId: 'a' }),
    rawMessage(5000, { authorId: 'bot1', bot: true }),
  ];
  const c1 = fakeChannel('c1', history, { name: 'general', category: 'Chat', topic: 'chit-chat' });
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: 'general chatter', topics: 'everything', tone: 'casual' }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.runChannel('g1', 'c1');
  assert.equal(outcome.ok, true);

  const channel = store.getChannel('g1', 'c1');
  assert.equal(channel.messageCount, 5); // the channel's own traffic counts a bot's message too
  assert.equal(channel.firstMessageAt, 1000);
  assert.equal(channel.lastMessageAt, 5000);
  assert.deepEqual(channel.days, { [new Date(1000).toISOString().slice(0, 10)]: 5 });
  assert.deepEqual(channel.topWriters, [{ id: 'a', count: 3 }, { id: 'b', count: 1 }]); // the bot never counts as a writer
});

test('createWarmup: processChannel redone (runChannel again) SETS the counters, never adding to a previous run', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })];
  const c1 = fakeChannel('c1', history, { name: 'general' });
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm1 = scriptedLlm([{ purpose: 'p1' }]);
  const warmup1 = createWarmup({ hot, store, client, llm: llm1, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  await warmup1.runChannel('g1', 'c1');
  assert.equal(store.getChannel('g1', 'c1').messageCount, 2);

  const llm2 = scriptedLlm([{ purpose: 'p2' }]);
  const warmup2 = createWarmup({ hot, store, client, llm: llm2, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  await warmup2.runChannel('g1', 'c1');
  assert.equal(store.getChannel('g1', 'c1').messageCount, 2); // SET, not added -- a redo must not double the count
});

test('createWarmup: processChannel sets zeros and empty lists for a channel with no messages at all', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [], { name: 'empty-room' });
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: '', topics: '', tone: '' }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.runChannel('g1', 'c1');
  assert.equal(outcome.ok, true);

  const channel = store.getChannel('g1', 'c1');
  assert.equal(channel.messageCount, 0);
  assert.equal(channel.firstMessageAt, null);
  assert.equal(channel.lastMessageAt, null);
  assert.deepEqual(channel.days, {});
  assert.deepEqual(channel.topWriters, []);
});

test('createWarmup: a server answer that omits a field leaves the stored value as it was', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.updateGuild('g1', { patterns: 'old patterns', starters: 'old starters', injokes: ['old joke'] });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ starters: 'new starters', patterns: '', lore: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.runServer('g1');
  assert.equal(outcome.ok, true);

  const stored = store.getGuild('g1');
  assert.equal(stored.patterns, 'old patterns', 'an empty patterns never blanks the stored one');
  assert.equal(stored.starters, 'new starters');
  assert.deepEqual(stored.injokes, ['old joke'], 'a missing injokes list never empties the stored one');
});

test('createWarmup: a channel answer that omits a field leaves the stored value as it was', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.updateChannel('g1', 'c1', { purpose: 'old purpose', topics: 'old topics', tone: 'old tone' });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })], { name: 'general' });
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: 'new purpose', tone: '' }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.runChannel('g1', 'c1');
  assert.equal(outcome.ok, true);

  const stored = store.getChannel('g1', 'c1');
  assert.equal(stored.purpose, 'new purpose');
  assert.equal(stored.topics, 'old topics', 'a missing field never blanks the stored one');
  assert.equal(stored.tone, 'old tone', 'an empty field never blanks the stored one');
});

test('createWarmup: an unparsable channel, person or server answer is logged by its error name, never quoting it', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })];
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history)]));
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;
  const llm = { complete: async () => ({ text: '{"purpose": she quit her job}', usage: {}, estimated: 0, finishReason: 'stop' }) };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const { logs } = await withCapturedLogs(async () => {
    await warmup.runChannel('g1', 'c1');
    await warmup.runPerson('g1', 'a');
    await warmup.runServer('g1');
  });

  const parseWarnings = logs.filter((entry) => /could not be parsed|still bad/.test(entry.msg));
  assert.ok(parseWarnings.length >= 3);
  for (const entry of parseWarnings) assert.equal(entry.detail, 'SyntaxError', entry.msg);
  assert.ok(!JSON.stringify(logs).includes('she quit'), 'the answer text never reaches a log line');
});

test('createWarmup: a redo (runPerson called again) SETS messageCount/firstSeen/lastSeen from the window instead of adding', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = [
    rawMessage(1000, { authorId: 'a', content: 'hi one' }),
    rawMessage(2000, { authorId: 'a', content: 'hi two' }),
    rawMessage(3000, { authorId: 'a', content: 'hi three' }),
  ];
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;
  const llm = scriptedLlm([{ character: 'friendly', style: 's', interests: [], details: [], episodes: [], aliases: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup.runPerson('g1', 'a');
  const first = store.getUser('g1', 'a');
  assert.equal(first.messageCount, 3);

  await warmup.runPerson('g1', 'a');
  const second = store.getUser('g1', 'a');
  assert.equal(second.messageCount, 3); // SET, not added -- a redo must not double the count
  assert.equal(second.firstSeen, first.firstSeen);
  assert.equal(second.lastSeen, first.lastSeen);
});

test('createWarmup: runUsers starts a background redo of every qualifying member, resolving once the count is known', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = [
    rawMessage(1000, { authorId: 'a' }),
    rawMessage(2000, { authorId: 'a' }),
    rawMessage(3000, { authorId: 'b' }),
    rawMessage(4000, { authorId: 'b' }),
  ];
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;
  const llm = scriptedLlm([{ character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const started = await warmup.runUsers('g1');
  assert.equal(started.ok, true);
  assert.equal(started.count, 2);
  assert.equal(warmup.isWarmingUp(), true); // shares `running` with run()

  while (warmup.isWarmingUp()) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(store.state.data.warmup.done.people.sort(), ['a', 'b']);
});

test('createWarmup: runUsers redoes an already-done member, overwriting its previous answer', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;
  const llm1 = scriptedLlm([{ character: 'first', style: 's', interests: [], details: [], episodes: [], aliases: [] }]);
  const warmup1 = createWarmup({ hot, store, client, llm: llm1, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup1.runPerson('g1', 'a');
  assert.deepEqual(store.state.data.warmup.done.people, ['a']);

  const llm2 = scriptedLlm([{ character: 'second', style: 's', interests: [], details: [], episodes: [], aliases: [] }]);
  const warmup2 = createWarmup({ hot, store, client, llm: llm2, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const started = await warmup2.runUsers('g1');
  assert.equal(started.ok, true);
  assert.equal(started.count, 1); // "a" is redone even though already marked done
  while (warmup2.isWarmingUp()) await new Promise((r) => setTimeout(r, 5));

  const profile = store.getUser('g1', 'a');
  assert.equal(profile.character, 'second');
});

test('createWarmup: runUsers is refused while a run/one-off target is already in flight', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();

  let resolveFirst;
  const gate = new Promise((resolve) => { resolveFirst = resolve; });
  const llm = { complete: async () => { await gate; return { text: '{}', usage: {}, estimated: 0, finishReason: 'stop' }; } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const firstRun = warmup.run('g1');
  assert.equal(warmup.isWarmingUp(), true);
  const usersResult = await warmup.runUsers('g1');
  assert.equal(usersResult.ok, false);
  assert.match(usersResult.message, /already in flight/);

  resolveFirst();
  await firstRun;
});

test('createWarmup: runUsers claims the run before its history fetch -- a redo started meanwhile is refused', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const client = fakeClient(fakeGuild('g1', [c1]));
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;
  const llm = scriptedLlm([{ character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const first = warmup.runUsers('g1');
  assert.equal(warmup.isWarmingUp(), true, 'the persona is muted from the start, the history fetch included');
  const second = await warmup.runChannels('g1');
  assert.equal(second.ok, false);
  assert.match(second.message, /already in flight/);

  assert.equal((await first).count, 1);
  while (warmup.isWarmingUp()) await new Promise((r) => setTimeout(r, 5));
  assert.equal(c1.messages.fetchCalls, 1, 'one history fetch, not two');
  assert.equal(llm.calls.length, 1, 'one redo loop, not two');
});

test('createWarmup: runUsers with nothing to redo, or a failed history fetch, releases the run at once', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  hot.config.warmup.minMessages = 100;
  const quiet = createWarmup({
    hot,
    store,
    client: fakeClient(fakeGuild('g1', [fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })])])),
    llm: scriptedLlm([{}]),
    calibrator: createCalibrator(),
    getSelfName: () => 'Nept',
    now: () => 10_000_000,
  });
  assert.deepEqual(await quiet.runUsers('g1'), { ok: true, count: 0 });
  assert.equal(quiet.isWarmingUp(), false);
  await quiet.waitIdle(); // resolves: nothing left in flight

  const broken = fakeChannel('c1', []);
  broken.isTextBased = () => {
    throw new Error('channel cache unavailable');
  };
  const failing = createWarmup({ hot, store, client: fakeClient(fakeGuild('g1', [broken])), llm: scriptedLlm([{}]), calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  await assert.rejects(failing.runChannels('g1'), /channel cache unavailable/);
  assert.equal(failing.isWarmingUp(), false);
  await failing.waitIdle();
});

test('createWarmup: runChannels starts a background redo of every readable channel', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })], { name: 'general' });
  const c2 = fakeChannel('c2', [rawMessage(1000, { authorId: 'b' })], { name: 'random' });
  const guild = fakeGuild('g1', [c1, c2]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: 'p' }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const started = await warmup.runChannels('g1');
  assert.equal(started.ok, true);
  assert.equal(started.count, 2);

  while (warmup.isWarmingUp()) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(store.state.data.warmup.done.channels.sort(), ['c1', 'c2']);
});

test('createWarmup: resumeIfNeeded resumes a run left unfinished while warmup.enabled is true', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.state.data.warmup = { version: 3, startedAt: '2026-10-01T00:00:00.000Z', finishedAt: null, tokensUsed: 0, requests: 0, done: { channels: [], people: [], server: false }, aborted: 'budget' };
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot({ config: { warmup: { ...fakeHot().config.warmup, enabled: true } } });
  const llm = scriptedLlm([{ purpose: 'p' }, { character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }, { patterns: '', starters: '', injokes: [], lore: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const started = warmup.resumeIfNeeded('g1');
  assert.equal(started, true);
  // resumeIfNeeded fires the run without awaiting it -- wait for it to actually finish.
  while (warmup.isWarmingUp()) await new Promise((r) => setTimeout(r, 5));
  assert.ok(store.state.data.warmup.finishedAt);
});

test('createWarmup: resumeIfNeeded never starts a fresh run, even with no profile at all', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const guild = fakeGuild('g1', [fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })])]);
  const client = fakeClient(guild);
  const hot = fakeHot({ config: { warmup: { ...fakeHot().config.warmup, enabled: true } } });
  const llm = { complete: async () => { throw new Error('must not be called'); } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  assert.equal(warmup.resumeIfNeeded('g1'), false);
  assert.equal(warmup.isWarmingUp(), false);
});

test('createWarmup: resumeIfNeeded leaves an unfinished run alone unless warmup.enabled is exactly true', () => {
  for (const enabled of [undefined, false, 'yes']) {
    const dir = tmpDataDir();
    const store = createStore({ dataDir: dir });
    store.state.data.warmup = { version: 3, startedAt: '2026-10-01T00:00:00.000Z', finishedAt: null, tokensUsed: 0, requests: 0, done: { channels: ['c1'], people: [], server: false }, aborted: null };
    const warmupCfg = { ...fakeHot().config.warmup, enabled };
    if (enabled === undefined) delete warmupCfg.enabled;
    const hot = fakeHot({ config: { warmup: warmupCfg } });
    const llm = { complete: async () => { throw new Error('must not be called'); } };
    const warmup = createWarmup({ hot, store, client: fakeClient(fakeGuild('g1', [])), llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
    assert.equal(warmup.resumeIfNeeded('g1'), false, String(enabled));
  }
});

test('createWarmup: resumeIfNeeded does nothing once a profile already exists and no run is unfinished', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  const guild = fakeGuild('g1', []);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = { complete: async () => { throw new Error('must not be called'); } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  assert.equal(warmup.resumeIfNeeded('g1'), false);
});

test('createWarmup: resumeIfNeeded respects warmup.enabled: false', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const guild = fakeGuild('g1', []);
  const client = fakeClient(guild);
  const hot = fakeHot({ config: { warmup: { ...fakeHot().config.warmup, enabled: false } } });
  const llm = { complete: async () => { throw new Error('must not be called'); } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  assert.equal(warmup.resumeIfNeeded('g1'), false);
});

test('createWarmup: reset() clears progress only, refused while running', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: 'p' }, { character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }, { patterns: '', starters: '', injokes: [], lore: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup.run('g1');
  assert.ok(store.state.data.warmup.finishedAt);

  const result = warmup.reset();
  assert.equal(result.ok, true);
  assert.equal(store.state.data.warmup, undefined);
  // The already-written profile/channel/guild data is untouched.
  assert.ok(store.getUser('g1', 'a'));
});

// ---------------------------------------------------------------------------
// status().activity -- in-memory run phase, never persisted
// ---------------------------------------------------------------------------

test('activity: reports the channel phase with its position among the run\'s eligible channels', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })], { name: 'general' });
  const c2 = fakeChannel('c2', [rawMessage(1000, { authorId: 'b' }), rawMessage(2000, { authorId: 'b' })], { name: 'random' });
  const guild = fakeGuild('g1', [c1, c2]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 100; // nobody qualifies as a person -- channels then straight to the server

  let warmup;
  const seen = [];
  const results = [{ purpose: 'p1' }, { purpose: 'p2' }, { patterns: '', starters: '', injokes: [], lore: [] }];
  let i = 0;
  const llm = {
    complete: async () => {
      seen.push(warmup.status('g1').activity);
      const payload = results[Math.min(i, results.length - 1)];
      i += 1;
      return { text: JSON.stringify(payload), usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, finishReason: 'stop' };
    },
  };
  warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await warmup.run('g1');
  assert.equal(result.ok, true);
  assert.equal(seen.length, 3);

  assert.equal(seen[0].phase, 'channel');
  assert.equal(seen[0].detail.id, 'c1');
  assert.equal(seen[0].detail.name, 'general');
  assert.equal(seen[0].detail.index, 1);
  assert.equal(seen[0].detail.total, 2);

  assert.equal(seen[1].detail.id, 'c2');
  assert.equal(seen[1].detail.index, 2);
  assert.equal(seen[1].detail.total, 2);

  assert.equal(seen[2].phase, 'server');
  assert.equal(seen[2].detail, null);
});

test('activity: never written to state.json (in-memory only)', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: 'p' }, { character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }, { patterns: '', starters: '', injokes: [], lore: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup.run('g1');
  store.flush();

  const raw = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
  assert.ok(!raw.includes('"activity"'), 'the run activity must never be persisted');
  assert.ok(!raw.includes('lastActivityAt'), 'the run activity must never be persisted');
});

// ---------------------------------------------------------------------------
// Factory write path: refreshPortrait()
// ---------------------------------------------------------------------------

test('refreshPortrait: samples the member and replaces only character/style, with <draft> and <hint> blocks', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  store.applyProfileOps('g1', 'a', { character: 'old character', style: 'old style', interests: { add: [{ topic: 'chess', note: '' }] } }, { fieldChars: 400, seenAt: 1000 });

  const history = Array.from({ length: 5 }, (_, i) => rawMessage(1000 + i * 1000, { authorId: 'a', content: `m${i}` }));
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();

  const llm = scriptedLlm([{ character: 'new character', style: 'new style', interests: [{ topic: 'poker', note: '', times: 5 }], details: [], episodes: [], aliases: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 20_000_000 });

  const result = await warmup.refreshPortrait('g1', 'a', 'writes shorter than usual now');
  assert.equal(result.ok, true);

  const user = llm.calls[0].messages[1].content;
  assert.ok(user.includes('<draft>'));
  assert.ok(user.includes('old character'));
  assert.ok(user.includes('<hint>'));
  assert.ok(user.includes('writes shorter than usual now'));

  const profile = store.getUser('g1', 'a');
  assert.equal(profile.character, 'new character');
  assert.equal(profile.style, 'new style');
  assert.equal(profile.interests.length, 1);
  assert.equal(profile.interests[0].topic, 'chess'); // interests from the refresh answer are IGNORED
  assert.ok(profile.portraitRefreshedAt);
});

test('refreshPortrait: the "portrait refreshed" log says whether a hint was given, never its text', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  const history = Array.from({ length: 3 }, (_, i) => rawMessage(1000 + i * 1000, { authorId: 'a', content: `m${i}` }));
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history)]));
  const hot = fakeHot();
  const llm = scriptedLlm([{ character: 'new character', style: 'new style', interests: [], details: [], episodes: [], aliases: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 20_000_000 });

  const { result, logs } = await withCapturedLogs(() => warmup.refreshPortrait('g1', 'a', 'γράφει πιο σύντομα τώρα'));
  assert.equal(result.ok, true);

  const refreshed = logs.find((entry) => entry.msg === 'warmup: portrait refreshed');
  assert.ok(refreshed);
  assert.equal(refreshed.hinted, true);
  assert.ok(!JSON.stringify(logs).includes('σύντομα'), 'the hint text never reaches a log line');
});

test('refreshPortrait: skips a member refreshed less than memory.portraitRefreshHours ago, unless forced', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  store.updateUser('g1', 'a', { portraitRefreshedAt: new Date(10_000_000).toISOString() });

  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1; // one own line is a sample worth sending here
  let calls = 0;
  const llm = { complete: async () => { calls += 1; return { text: '{"character":"c","style":"s"}', usage: {}, estimated: 0, finishReason: 'stop' }; } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 + 3600_000 }); // 1h later, rail is 24h

  const skipped = await warmup.refreshPortrait('g1', 'a', 'reason');
  assert.equal(skipped.ok, false);
  assert.equal(skipped.reason, 'too-soon');
  assert.equal(calls, 0);

  // Forced (the owner's command): the whole window is sampled, not only lines since the stamp.
  const forced = await warmup.refreshPortrait('g1', 'a', 'reason', { force: true });
  assert.equal(forced.ok, true);
  assert.equal(calls, 1);
});

test('refreshPortrait: skips once the daily refresh cap is reached', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.memory.portraitRefreshPerDay = 1;
  hot.config.warmup.minMessages = 1;
  let calls = 0;
  const llm = { complete: async () => { calls += 1; return { text: '{"character":"c","style":"s"}', usage: {}, estimated: 0, finishReason: 'stop' }; } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const first = await warmup.refreshPortrait('g1', 'a', 'r1', { force: true });
  assert.equal(first.ok, true);
  const second = await warmup.refreshPortrait('g1', 'a', 'r2', { force: true });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'daily-cap');
  assert.equal(calls, 1);
});

test('refreshPortrait: concurrent cues never overshoot the daily cap -- the slot is taken before the history fetch', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  store.touchUser('g1', 'b', 'Bob', 1000);
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'b' })];
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history)]));
  const hot = fakeHot();
  hot.config.memory.portraitRefreshPerDay = 1;
  hot.config.warmup.minMessages = 1;
  let calls = 0;
  const llm = { complete: async () => { calls += 1; return { text: '{"character":"c","style":"s"}', usage: {}, estimated: 0, finishReason: 'stop' }; } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const [first, second] = await Promise.all([warmup.refreshPortrait('g1', 'a', 'r1'), warmup.refreshPortrait('g1', 'b', 'r2')]);

  assert.deepEqual([first.ok, second.ok], [true, false]);
  assert.equal(second.reason, 'daily-cap');
  assert.equal(calls, 1);
});

test('refreshPortrait: the daily count lives outside the warmup progress, so /nep warmup reset never zeroes it', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })])]));
  const hot = fakeHot();
  hot.config.memory.portraitRefreshPerDay = 1;
  hot.config.warmup.minMessages = 1;
  let calls = 0;
  const llm = { complete: async () => { calls += 1; return { text: '{"character":"c","style":"s"}', usage: {}, estimated: 0, finishReason: 'stop' }; } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  assert.equal((await warmup.refreshPortrait('g1', 'a', 'r1', { force: true })).ok, true);
  assert.equal(store.state.data.portraitDay, new Date(10_000_000).toISOString().slice(0, 10));
  assert.equal(store.state.data.portraitCount, 1);

  assert.equal(warmup.reset().ok, true);
  const again = await warmup.refreshPortrait('g1', 'a', 'r2', { force: true });
  assert.equal(again.reason, 'daily-cap');
  assert.equal(calls, 1);
});

test('refreshPortrait: a missing prompts.profile is reason "no-prompt", no slot taken, no request', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })])]));
  const hot = fakeHot({ prompts: { profile: undefined } });
  const llm = scriptedLlm([{}]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.refreshPortrait('g1', 'a', 'r1', { force: true });
  assert.equal(outcome.reason, 'no-prompt');
  assert.equal(llm.calls.length, 0);
  assert.equal(store.state.data.portraitCount, undefined);
});

test('refreshPortrait: a refresh with nothing to sample gives its daily slot back', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', [rawMessage(1000, { authorId: 'other' })])]));
  const hot = fakeHot();
  const warmup = createWarmup({ hot, store, client, llm: scriptedLlm([{}]), calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.refreshPortrait('g1', 'a', 'r1', { force: true });
  assert.equal(outcome.reason, 'nothing-to-sample');
  assert.equal(store.state.data.portraitCount, 0);
  assert.equal(store.getUser('g1', 'a').portraitAttemptAt, new Date(10_000_000).toISOString(), 'the attempt is stamped: it backs off');
});

test('refreshPortrait: concurrent cues share one history fetch', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  store.touchUser('g1', 'b', 'Bob', 1000);
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'b' })]);
  const client = fakeClient(fakeGuild('g1', [c1]));
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;
  const llm = scriptedLlm([{ character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const results = await Promise.all([warmup.refreshPortrait('g1', 'a', 'r1'), warmup.refreshPortrait('g1', 'b', 'r2')]);

  assert.deepEqual(results.map((r) => r.ok), [true, true]);
  assert.equal(c1.messages.fetchCalls, 1, 'the second cue waits for the fetch already in flight');
});

test('refreshPortrait: queues nothing and just logs while a warmup run is in flight', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();

  let resolveGate;
  const gate = new Promise((resolve) => { resolveGate = resolve; });
  const llm = { complete: async () => { await gate; return { text: '{}', usage: {}, estimated: 0, finishReason: 'stop' }; } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const runPromise = warmup.run('g1');
  const refreshResult = await warmup.refreshPortrait('g1', 'a', 'reason');
  assert.equal(refreshResult.ok, false);
  assert.equal(refreshResult.reason, 'warming-up');

  resolveGate();
  await runPromise;
});

test('createWarmup: resumeIfNeeded resumes a run that has progress but no start stamp, even when profiles exist', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: 'p' }, { character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }, { patterns: '', starters: '', injokes: [], lore: [] }]);
  store.touchUser('g1', 'a', 'alpha');
  store.state.data.warmup = { version: 3, startedAt: null, finishedAt: null, done: { channels: [], people: ['someone'], server: false } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  warmup.resumeIfNeeded('g1');
  await new Promise((r) => setTimeout(r, 20));
  while (warmup.isWarmingUp()) await new Promise((r) => setTimeout(r, 5));
  assert.ok(store.state.data.warmup.finishedAt, 'the run should have resumed and finished');
});

test('warmupState: a stored state.warmup from an older version is discarded wholesale by a write, never healed field by field', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const guild = fakeGuild('g1', []);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.maxTokens = 0; // the run stops on its very first request: only the reset is observed
  const stored = {
    version: 2,
    done: false,
    aborted: false,
    startedAt: '2026-01-01T00:00:00.000Z',
    tokensUsed: 5000,
    requests: 7,
    channels: {},
  };
  store.state.data.warmup = structuredClone(stored);
  const warmup = createWarmup({ hot, store, client, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const summary = warmup.summary(); // a read: reports the fresh view, writes nothing
  assert.equal(summary.tokensUsed, 0);
  assert.equal(summary.startedAt, null);
  assert.deepEqual(store.state.data.warmup, stored);

  await warmup.run('g1');

  const progress = store.state.data.warmup;
  assert.equal(progress.version, 3);
  assert.equal(progress.tokensUsed, 0);
  assert.equal(progress.requests, 0);
  assert.equal(progress.startedAt, new Date(10_000_000).toISOString(), 'the old start stamp is gone, the run stamped its own');
  assert.equal('channels' in progress, false);
  assert.deepEqual(progress.done, { channels: [], people: [], server: false });
});

test('warmupState: a stored state.warmup already at the current version is healed field by field, not replaced', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const guild = fakeGuild('g1', []);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.maxTokens = 0;
  store.state.data.warmup = { version: 3, tokensUsed: 42, done: { channels: ['c1'], people: [], server: false } };
  const warmup = createWarmup({ hot, store, client, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

  assert.equal(warmup.summary().tokensUsed, 42);
  assert.equal(warmup.summary().doneChannels, 1);

  await warmup.run('g1');

  const progress = store.state.data.warmup;
  assert.equal(progress.version, 3);
  assert.equal(progress.tokensUsed, 42, 'a version-3 object keeps its own field values');
  assert.deepEqual(progress.done.channels, ['c1']);
  assert.equal(progress.requests, 0, 'a missing field is filled in');
});

test('warmupState: status() and summary() are read-only -- they never write or dirty state.json', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const client = fakeClient(fakeGuild('g1', []));
  const hot = fakeHot();
  const stored = { version: 1, done: 'garbage' };
  store.state.data.warmup = structuredClone(stored);
  let dirtied = 0;
  store.state.markDirty = () => {
    dirtied += 1;
  };
  const warmup = createWarmup({ hot, store, client, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const status = warmup.status('g1');
  const summary = warmup.summary();
  assert.equal(status.phase, 'not started');
  assert.equal(summary.doneChannels, 0);
  assert.deepEqual(store.state.data.warmup, stored, 'the stored object is left exactly as it was');
  assert.equal(dirtied, 0);
});

test('status: next target skips the target currently in flight', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })]);
  const c2 = fakeChannel('c2', [rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1, c2]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  let release;
  const gate = new Promise((r) => { release = r; });
  const llm = { complete: async () => { await gate; return { content: JSON.stringify({ purpose: 'p', topics: 't', tone: 'n' }), usage: { prompt_tokens: 1, completion_tokens: 1 } }; } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  const running = warmup.run('g1');
  while (warmup.status('g1').activity.phase !== 'channel') await new Promise((r) => setTimeout(r, 5));
  const s = warmup.status('g1');
  assert.equal(s.activity.detail.id, 'c1');
  assert.match(s.nextTarget, /c2/);
  release();
  await running;
});

test('createWarmup: memory.temperature is read at each call, and memory.timeoutMs applies, for the warmup and the portrait refresh alike', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' }), rawMessage(3000, { authorId: 'a' })];
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history)]));
  const hot = fakeHot();
  hot.config.memory.temperature = 0.55;
  hot.config.memory.timeoutMs = 900_000;
  hot.config.llm.timeoutMs = 300_000;
  const llm = scriptedLlm([{ purpose: 'p' }, { character: 'c', style: 's' }, { patterns: 'x' }, { character: 'c2', style: 's2' }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup.run('g1');
  hot.config.memory.temperature = 0.1; // a live edit reaches the next request
  await warmup.refreshPortrait('g1', 'a', '', { force: true });

  assert.deepEqual(llm.calls.map((call) => call.opts.temperature), [0.55, 0.55, 0.55, 0.1]);
  for (const call of llm.calls) assert.equal(call.opts.timeoutMs, 900_000, 'memory.timeoutMs, not the chat llm.timeoutMs');
});

test('createWarmup: warmup.maxRequestTokens, not the chat cap, governs fitting and the request cap alike', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const history = Array.from({ length: 6 }, (_, i) => rawMessage(1000 + i * 1000, { authorId: 'a', content: `line number ${i} with a few words` }));
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history)]));
  const hot = fakeHot();
  hot.config.warmup.maxRequestTokens = 120000;
  hot.config.llm.maxRequestTokens = 40; // the chat cap: far too small for this channel
  hot.config.llm.safetyMargin = 1;
  const llm = scriptedLlm([{ purpose: 'p' }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.runChannel('g1', 'c1');
  assert.equal(outcome.ok, true);
  assert.equal(llm.calls[0].opts.maxRequestTokens, 120000);
  assert.ok(llm.calls[0].messages[1].content.includes('line number 0 '), 'fitted to the warmup cap, nothing dropped');
});

test('createWarmup: warmup rails are read at the call -- a lowered warmup.maxTokens stops a run already in flight', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })]);
  const c2 = fakeChannel('c2', [rawMessage(2000, { authorId: 'b' })]);
  const client = fakeClient(fakeGuild('g1', [c1, c2]));
  const hot = fakeHot();
  const llm = scriptedLlm([
    () => {
      // A hot reload replaces the config objects, as src/hot.js does.
      hot.config = { ...hot.config, warmup: { ...hot.config.warmup, maxTokens: 1, maxOutputTokens: 1234 } };
      return { purpose: 'p1' };
    },
    { purpose: 'p2' },
  ]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await warmup.run('g1');
  assert.equal(result.ok, false);
  assert.equal(result.message, 'budget');
  assert.equal(llm.calls.length, 1);
  assert.equal(store.state.data.warmup.aborted, 'budget');
});

// Provider routing: every warmup request is routed as the analyzer role.

test('createWarmup: run() and refreshPortrait() route every request as the analyzer role', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' }), rawMessage(3000, { authorId: 'a' })];
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history)]));
  const hot = fakeHot();
  const llm = scriptedLlm([
    { purpose: 'p', topics: 't', tone: 'x' },
    { character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] },
    { patterns: '', starters: '', injokes: [], lore: [] },
    { character: 'c2', style: 's2', interests: [], details: [], episodes: [], aliases: [] },
  ]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup.run('g1');
  const refreshed = await warmup.refreshPortrait('g1', 'a', '', { force: true });

  assert.equal(refreshed.ok, true);
  assert.equal(llm.calls.length, 4);
  assert.deepEqual(llm.calls.map((call) => call.opts.role), ['analyzer', 'analyzer', 'analyzer', 'analyzer']);
});

// ---------------------------------------------------------------------------
// refreshPortrait() under the counters (src/memory/portrait.js): the 50k rail, the sample since
// the last portrait, the stamps, the back-off, pause safety, and the scheduler's one history
// crawl per check.
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 9, 1, 12);
const iso = (ms) => new Date(ms).toISOString();

/** `count` normalized lines of `authorId` in channel `channelId`, one a minute from `startTs`. */
function lines(channelId, authorId, count, startTs, content = (i) => `line ${i} of ${authorId}`) {
  return Array.from({ length: count }, (_, i) =>
    msg(`${channelId}-${authorId}-${i}`, startTs + i * 60_000, { channelId, authorId, authorName: authorId, content: content(i) }),
  );
}

/** A client that serves no guild: only the injected-windows path can refresh. */
function guildlessClient() {
  return { user: { id: 'selfUser' }, guilds: { cache: new Map() } };
}

/** A warmup for portrait tests; the clock defaults to 30 hours after T0. */
function portraitWarmup({ hot = fakeHot(), store = createStore({ dataDir: tmpDataDir() }), client = guildlessClient(), llm, now = () => T0 + 30 * 3_600_000, calibrator = createCalibrator() } = {}) {
  const warmup = createWarmup({ hot, store, client, llm, calibrator, getSelfName: () => 'Nept', now });
  return { warmup, store, hot, llm };
}

/** A member with a stored portrait, seen at `at`; `stamps` go through the generic setter. */
function seedPortrait(store, userId, { at = T0, character = 'μιλάει πολύ', style = 'σύντομα', ...stamps } = {}) {
  store.touchUser('g1', userId, userId, at);
  store.applyProfileOps('g1', userId, { character, style }, { fieldChars: 400 });
  if (Object.keys(stamps).length > 0) store.updateUser('g1', userId, stamps);
}

/** A fake `llm.complete` answering raw text (with a finish reason) or throwing an Error entry. */
function textLlm(results) {
  const calls = [];
  return {
    calls,
    complete: async (messages, opts) => {
      const entry = results[Math.min(calls.length, results.length - 1)];
      calls.push({ messages, opts });
      if (entry instanceof Error) throw entry;
      return { text: entry.text, usage: {}, estimated: 0, finishReason: entry.finishReason ?? 'stop' };
    },
  };
}

/** A fake `llm.complete` that holds every answer until `release()`. */
function gatedLlm(answer) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  return {
    calls,
    release: () => release(),
    complete: async (messages, opts) => {
      calls.push({ messages, opts });
      await gate;
      return { text: JSON.stringify(answer), usage: {}, estimated: 0, finishReason: 'stop' };
    },
  };
}

const snippetsOf = (call) => /<snippets>\n([\s\S]*?)\n<\/snippets>/.exec(call.messages[1].content)[1];
const ownLinesOf = (call) => snippetsOf(call).split('\n').filter((line) => line.startsWith('[own] '));

test('refreshPortrait: injected windows need no guild and fetch nothing', async () => {
  const llm = scriptedLlm([{ character: 'νέος χαρακτήρας', style: 'νέο ύφος' }]);
  const { warmup, store } = portraitWarmup({ llm });
  seedPortrait(store, 'a');

  const noWindows = await warmup.refreshPortrait('g1', 'a', '');
  assert.equal(noWindows.reason, 'no-guild');
  assert.equal(store.state.data.portraitCount, undefined, 'no slot taken');

  const result = await warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 5, T0))] });
  assert.equal(result.ok, true);
  assert.equal(llm.calls.length, 1);
  assert.equal(store.getUser('g1', 'a').character, 'νέος χαρακτήρας');
  assert.equal(store.getUser('g1', 'a').style, 'νέο ύφος');
});

test('refreshPortrait: the request fits llm.maxRequestTokens x safetyMargin, shrinking the sample, main channels first', async () => {
  const hot = fakeHot();
  hot.config.llm.maxRequestTokens = 2500;
  hot.config.llm.safetyMargin = 1;
  hot.config.memory.mainChannelIds = ['main'];
  hot.config.memory.portraitRefreshMessages = 60;
  hot.config.warmup.minMessages = 5;
  hot.config.warmup.contextBefore = 0;
  const llm = scriptedLlm([{ character: 'c', style: 's' }]);
  const { warmup, store } = portraitWarmup({ hot, llm });
  seedPortrait(store, 'a');
  const long = (tag) => (i) => `${tag} ${i} ${'a walk along the river and back again, '.repeat(5)}`;
  const windows = [win('main', lines('main', 'a', 20, T0, long('main'))), win('side', lines('side', 'a', 40, T0, long('side')))];

  const result = await warmup.refreshPortrait('g1', 'a', '', { windows });

  assert.equal(result.ok, true);
  assert.ok(result.shrunk > 0, 'the sample shrank');
  const [call] = llm.calls;
  assert.ok(createCalibrator().apply(estimateMessages(call.messages)) <= 2500, 'fitted under the cap');
  assert.equal(call.opts.maxRequestTokens, undefined, 'the llm.maxRequestTokens rail applies, not the warmup cap');
  const own = ownLinesOf(call);
  assert.equal(own.filter((line) => line.includes('main ')).length, 20, 'every main-channel line kept');
  assert.ok(own.filter((line) => line.includes('side ')).length < 40, 'the other channel gave way');
  assert.equal(result.own, own.length);
});

test('refreshPortrait: a 300-message sample is trimmed under the 50k rail, never a token-limit failure', async () => {
  const hot = fakeHot(); // llm.maxRequestTokens 50000, safetyMargin 0.9
  hot.config.memory.portraitRefreshMessages = 300;
  hot.config.warmup.minMessages = 30;
  hot.config.warmup.contextBefore = 1;
  const calibrator = createCalibrator();
  // The real client's pre-flight check: over llm.maxRequestTokens is a TokenLimitError, nothing sent.
  const llm = {
    calls: [],
    async complete(messages, opts) {
      this.calls.push({ messages, opts });
      const estimated = calibrator.apply(estimateMessages(messages));
      if (estimated > (opts.maxRequestTokens ?? hot.config.llm.maxRequestTokens)) throw new TokenLimitError(`request estimated at ${estimated}`);
      return { text: JSON.stringify({ character: 'c', style: 's' }), usage: {}, estimated, finishReason: 'stop' };
    },
  };
  const { warmup, store } = portraitWarmup({ hot, llm, calibrator });
  seedPortrait(store, 'a');
  const text = (i) => `${i} ${'the long story of a weekend trip to the mountains, '.repeat(10)}`;
  const mixed = [];
  for (let i = 0; i < 320; i += 1) {
    mixed.push(msg(`b-${i}`, T0 + i * 120_000, { channelId: 'c1', authorId: 'b', authorName: 'b', content: text(i) }));
    mixed.push(msg(`a-${i}`, T0 + i * 120_000 + 60_000, { channelId: 'c1', authorId: 'a', authorName: 'a', content: text(i) }));
  }

  const result = await warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', mixed)] });

  assert.equal(result.ok, true);
  assert.equal(llm.calls.length, 1);
  const sent = calibrator.apply(estimateMessages(llm.calls[0].messages));
  assert.ok(sent <= 45000, `fitted to 45000 calibrated tokens, was ${sent}`);
  assert.ok(result.own < 300 && result.own >= 30);
});

test('refreshPortrait: samples only own messages since the last refresh', async () => {
  const llm = scriptedLlm([{ character: 'c', style: 's' }]);
  const { warmup, store } = portraitWarmup({ llm }); // 30 hours after T0
  seedPortrait(store, 'a', { portraitRefreshedAt: iso(T0 + 4 * 60_000) });
  const content = (i) => (i < 4 ? `παλιό ${i}` : `νέο ${i}`);
  const channel = [...lines('c1', 'a', 10, T0, content), ...lines('c1', 'b', 10, T0 - 30_000)].sort((x, y) => x.ts - y.ts);

  const result = await warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', channel)] });

  assert.equal(result.ok, true);
  const own = ownLinesOf(llm.calls[0]);
  assert.equal(own.length, 6);
  assert.ok(own.every((line) => line.includes('νέο')), 'no own line from before the last portrait');
  assert.match(llm.calls[0].messages[1].content, /<member>\na \(id:a\), 6 messages in the window/, 'the member line counts since the last portrait');
});

test('refreshPortrait: a forced refresh (the owner\'s command) samples the whole window', async () => {
  const llm = scriptedLlm([{ character: 'c', style: 's' }]);
  const { warmup, store } = portraitWarmup({ llm, now: () => T0 + 3_600_000 });
  seedPortrait(store, 'a', { portraitRefreshedAt: iso(T0 + 4 * 60_000) });
  const windows = [win('c1', lines('c1', 'a', 10, T0, (i) => (i < 4 ? `παλιό ${i}` : `νέο ${i}`)))];

  assert.equal((await warmup.refreshPortrait('g1', 'a', '', { windows })).reason, 'too-soon');
  const result = await warmup.refreshPortrait('g1', 'a', '', { windows, force: true });

  assert.equal(result.ok, true);
  assert.equal(ownLinesOf(llm.calls[0]).length, 10);
});

test('refreshPortrait: a pre-flight token limit or daily cap sends nothing and gives the slot back', async () => {
  const llm = textLlm([new DailyCapError('daily LLM request cap reached (300)'), new TokenLimitError('request estimated at 60000 tokens, cap is 50000')]);
  const { warmup, store } = portraitWarmup({ llm });
  seedPortrait(store, 'a');
  const windows = [win('c1', lines('c1', 'a', 5, T0))];

  const capped = await warmup.refreshPortrait('g1', 'a', '', { windows });
  assert.deepEqual([capped.ok, capped.reason, capped.cap], [false, 'daily-cap', 'llm']);
  assert.equal(store.state.data.portraitCount, 0, 'the slot is given back');
  assert.equal(store.getUser('g1', 'a').portraitAttemptAt ?? null, null, 'nothing about the member: no back-off');

  const over = await warmup.refreshPortrait('g1', 'a', '', { windows });
  assert.deepEqual([over.ok, over.reason], [false, 'token-limit']);
  assert.equal(store.state.data.portraitCount, 0, 'the slot is given back');
  assert.equal(store.getUser('g1', 'a').portraitAttemptAt, iso(T0 + 30 * 3_600_000), 'the member backs off');
  assert.equal(store.getUser('g1', 'a').character, 'μιλάει πολύ');
});

test('refreshPortrait: success stamps portraitRefreshedAt and portraitMessageCount and clears portraitAttemptAt', async () => {
  const now = T0 + 30 * 3_600_000;
  const llm = scriptedLlm([{ character: 'νέος', style: 'νέο' }]);
  const { warmup, store, hot } = portraitWarmup({ llm, now: () => now });
  seedPortrait(store, 'a', { messageCount: 420, portraitAttemptAt: iso(now - 25 * 3_600_000) });

  const result = await warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 5, T0))] });

  assert.equal(result.ok, true);
  const profile = store.getUser('g1', 'a');
  assert.equal(profile.portraitRefreshedAt, iso(now));
  assert.equal(profile.portraitMessageCount, 420);
  assert.equal(profile.portraitAttemptAt, null);
  assert.equal(store.state.data.portraitCount, 1);
  assert.equal(portraitDue(profile, now, portraitSettings(hot.config)).due, false);
});

test('refreshPortrait: a failure after sending keeps the slot and stamps portraitAttemptAt', async () => {
  const now = T0 + 30 * 3_600_000;
  // 400 is not in src/llm/openrouter.js#RETRY_STATUS: a provider error that says the request itself was wrong.
  const llm = textLlm([Object.assign(new Error('OpenRouter HTTP 400: bad request'), { statusCode: 400 })]);
  const { warmup, store } = portraitWarmup({ llm, now: () => now });
  seedPortrait(store, 'a');
  const windows = [win('c1', lines('c1', 'a', 5, T0))];

  const failed = await warmup.refreshPortrait('g1', 'a', '', { windows });
  assert.deepEqual([failed.ok, failed.reason], [false, 'llm-error']);
  assert.equal(store.state.data.portraitCount, 1, 'the request was sent: the slot is spent');
  assert.equal(store.getUser('g1', 'a').portraitAttemptAt, iso(now));

  const again = await warmup.refreshPortrait('g1', 'a', 'a cue', { windows });
  assert.equal(again.reason, 'retry-wait', 'a cue waits memory.portraitRetryHours too');
  assert.equal(llm.calls.length, 1);
});

test('refreshPortrait: a provider 429 after send gives the day\'s slot back, restores the attempt stamp, and the member stays due', async () => {
  const now = T0 + 30 * 3_600_000;
  const earlier = iso(now - 30 * 3_600_000); // past memory.portraitRetryHours
  const timeout = Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
  const llm = textLlm([Object.assign(new Error('OpenRouter HTTP 429: rate limited'), { statusCode: 429 }), timeout]);
  const { warmup, store, hot } = portraitWarmup({ llm, now: () => now });
  seedPortrait(store, 'a', { messageCount: 420, portraitAttemptAt: earlier });
  const windows = [win('c1', lines('c1', 'a', 5, T0))];
  const before = store.state.data.portraitCount ?? 0;

  for (const label of ['429', 'timeout']) {
    const result = await warmup.refreshPortrait('g1', 'a', '', { windows });
    assert.deepEqual(result, { ok: false, reason: 'llm-error', slotReturned: true }, label);
    assert.equal(store.state.data.portraitCount, before, `${label}: the slot is given back`);
    const profile = store.getUser('g1', 'a');
    assert.equal(profile.portraitAttemptAt, earlier, `${label}: the earlier attempt stamp, neither fresh nor cleared`);
    assert.equal(profile.character, 'μιλάει πολύ');
    assert.equal(portraitDue(profile, now, portraitSettings(hot.config)).due, true, `${label}: the member stays due`);
  }
  assert.equal(llm.calls.length, 2);
});

test('refreshPortrait: an unparsable answer after send keeps the day\'s slot and backs the member off', async () => {
  const now = T0 + 30 * 3_600_000;
  const llm = textLlm([{ text: 'όχι json' }]);
  const { warmup, store } = portraitWarmup({ llm, now: () => now });
  seedPortrait(store, 'a', { messageCount: 420, portraitAttemptAt: iso(now - 30 * 3_600_000) });

  const result = await warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 5, T0))] });
  assert.deepEqual(result, { ok: false, reason: 'bad-json' });
  assert.equal(store.state.data.portraitCount, 1, 'the request was answered: the slot is spent');
  assert.equal(store.getUser('g1', 'a').portraitAttemptAt, iso(now));
});

test('refreshPortrait: an empty or cut answer leaves the stored portrait untouched', async () => {
  const llm = textLlm([
    { text: JSON.stringify({ character: '', style: '  ' }) },
    { text: JSON.stringify({ character: 'μισό', style: 'μισό' }), finishReason: 'length' },
    { text: '{"character": "μισ' },
    { text: 'όχι json' },
  ]);
  const { warmup, store } = portraitWarmup({ llm });
  seedPortrait(store, 'a');
  const windows = [win('c1', lines('c1', 'a', 5, T0))];

  const reasons = [];
  for (let i = 0; i < 4; i += 1) reasons.push((await warmup.refreshPortrait('g1', 'a', '', { windows, force: true })).reason);

  assert.deepEqual(reasons, ['empty-answer', 'truncated', 'truncated', 'bad-json']);
  const profile = store.getUser('g1', 'a');
  assert.equal(profile.character, 'μιλάει πολύ');
  assert.equal(profile.style, 'σύντομα');
  assert.equal(profile.portraitRefreshedAt ?? null, null);
  assert.ok(profile.portraitAttemptAt, 'backs off');
  assert.equal(store.state.data.portraitCount, 4, 'every request was sent');
});

test('refreshPortrait: a member with no lines in the history is stamped and not crawled for again within memory.portraitRetryHours', async () => {
  let nowMs = T0;
  const c1 = fakeChannel('c1', [rawMessage(T0 - 60_000, { authorId: 'b' })]);
  const llm = scriptedLlm([{ character: 'c', style: 's' }]);
  const { warmup, store, hot } = portraitWarmup({ llm, client: fakeClient(fakeGuild('g1', [c1])), now: () => nowMs });
  seedPortrait(store, 'a', { messageCount: 900 });

  const first = await warmup.refreshPortrait('g1', 'a', '');
  assert.equal(first.reason, 'nothing-to-sample');
  const fetches = c1.messages.fetchCalls;
  assert.equal(store.state.data.portraitCount, 0, 'the slot is given back');
  const profile = store.getUser('g1', 'a');
  assert.equal(profile.portraitAttemptAt, iso(T0));
  assert.equal(portraitDue(profile, T0 + 23 * 3_600_000, portraitSettings(hot.config)).reason, 'retry-wait');

  nowMs = T0 + 2 * 3_600_000; // well past the 15-minute history cache
  assert.equal((await warmup.refreshPortrait('g1', 'a', 'a cue')).reason, 'retry-wait');
  assert.equal(c1.messages.fetchCalls, fetches, 'no second crawl');
  assert.equal(llm.calls.length, 0);
});

test('refreshPortrait: a sample thinner than warmup.minMessages sends nothing, gives the slot back and backs off', async () => {
  const hot = fakeHot();
  hot.config.warmup.minMessages = 5;
  const llm = scriptedLlm([{ character: 'c', style: 's' }]);
  const { warmup, store } = portraitWarmup({ hot, llm });
  seedPortrait(store, 'a');

  const result = await warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 3, T0))] });

  assert.equal(result.reason, 'thin-sample');
  assert.equal(llm.calls.length, 0);
  assert.equal(store.state.data.portraitCount, 0);
  assert.ok(store.getUser('g1', 'a').portraitAttemptAt);
});

test('refreshPortrait: the stored portrait reaches the request as the draft, member tokens resolved for the analyzer', async () => {
  const llm = scriptedLlm([{ character: 'c', style: 's' }]);
  const { warmup, store } = portraitWarmup({ llm });
  store.touchUser('g1', '222222222222222222', 'Βράνος', T0);
  seedPortrait(store, 'a', { character: 'φίλη του <@222222222222222222>, γελάει εύκολα', style: 'σύντομα, χωρίς τελείες' });

  await warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 5, T0))] });

  const draft = JSON.parse(/<draft>\n([\s\S]*?)\n<\/draft>/.exec(llm.calls[0].messages[1].content)[1]);
  assert.deepEqual(draft, { character: 'φίλη του Βράνος (id:222222222222222222), γελάει εύκολα', style: 'σύντομα, χωρίς τελείες' });
});

test('refreshPortrait: a refresh that finishes while paused writes nothing', async () => {
  const llm = gatedLlm({ character: 'νέος', style: 'νέο' });
  const { warmup, store } = portraitWarmup({ llm });
  seedPortrait(store, 'a');

  const pending = warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 5, T0))] });
  await waitFor(() => llm.calls.length === 1);
  const sent = JSON.stringify(store.getUser('g1', 'a')); // the attempt stamp was written before sending
  store.state.data.paused = true;
  llm.release();
  const result = await pending;

  assert.deepEqual([result.ok, result.reason], [false, 'paused']);
  assert.equal(JSON.stringify(store.getUser('g1', 'a')), sent, 'nothing written after the pause');
  assert.equal(store.getUser('g1', 'a').character, 'μιλάει πολύ');
});

test('refreshPortrait: waitIdle waits for a refresh in flight, which never mutes the persona', async () => {
  const llm = gatedLlm({ character: 'νέος', style: 'νέο' });
  const { warmup, store } = portraitWarmup({ llm });
  seedPortrait(store, 'a');

  const pending = warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 5, T0))] });
  await waitFor(() => llm.calls.length === 1);
  assert.equal(warmup.isWarmingUp(), false);
  let idle = false;
  const waiting = warmup.waitIdle().then(() => {
    idle = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(idle, false, 'waitIdle waits for the refresh in flight');

  llm.release();
  await pending;
  await waiting;
  assert.equal(idle, true);
  assert.equal(store.getUser('g1', 'a').character, 'νέος');
});

test('refreshPortrait: the same member is never refreshed twice at once', async () => {
  const llm = gatedLlm({ character: 'νέος', style: 'νέο' });
  const { warmup, store } = portraitWarmup({ llm });
  seedPortrait(store, 'a');
  const windows = [win('c1', lines('c1', 'a', 5, T0))];

  const pending = warmup.refreshPortrait('g1', 'a', '', { windows });
  const second = await warmup.refreshPortrait('g1', 'a', 'a cue', { windows, force: true });

  assert.equal(second.reason, 'busy');
  assert.equal(store.state.data.portraitCount, 1, 'one slot, not two');
  llm.release();
  assert.equal((await pending).ok, true);
});

test('writePersonAnswer: a warmup person run stamps portraitRefreshedAt and portraitMessageCount', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' }), rawMessage(3000, { authorId: 'a' }), rawMessage(4000, { authorId: 'b' })];
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history)]));
  const llm = scriptedLlm([{ character: 'μιλάει πολύ', style: 'σύντομα' }, { character: '', style: '', interests: [{ topic: 'σκάκι', note: '', times: 1 }] }]);
  const warmup = createWarmup({ hot: fakeHot(), store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  store.touchUser('g1', 'a', 'a', 500);
  store.updateUser('g1', 'a', { messageCount: 700, portraitAttemptAt: new Date(9_000_000).toISOString() });

  assert.equal((await warmup.runPerson('g1', 'a')).ok, true);
  const profile = store.getUser('g1', 'a');
  assert.equal(profile.character, 'μιλάει πολύ');
  assert.equal(profile.messageCount, 3, 'the run SETS the count from its window');
  assert.equal(profile.portraitMessageCount, 3, 'and the stamp re-bases on it');
  assert.equal(profile.portraitRefreshedAt, new Date(10_000_000).toISOString());
  assert.equal(profile.portraitAttemptAt, null);

  // An answer that carries no portrait writes none, so stamps none.
  assert.equal((await warmup.runPerson('g1', 'b')).ok, true);
  assert.equal(store.getUser('g1', 'b').portraitRefreshedAt, undefined);
  assert.deepEqual(store.getUser('g1', 'b').interests.map((it) => it.topic), ['σκάκι']);
});

test('portrait scheduler: one history crawl per check, and a member with no lines in it is stamped and not picked again within the retry time', async () => {
  let nowMs = T0;
  const history = [
    ...Array.from({ length: 5 }, (_, i) => rawMessage(T0 - (60 - i) * 60_000, { authorId: 'a' })),
    ...Array.from({ length: 4 }, (_, i) => rawMessage(T0 - (30 - i) * 60_000, { authorId: 'b' })),
  ];
  const c1 = fakeChannel('c1', history);
  const hot = fakeHot();
  hot.config.memory.portraitRefreshPerDay = 3;
  // Every answer takes 20 minutes: longer than the 15-minute history cache.
  const llm = scriptedLlm([
    () => {
      nowMs += 20 * 60_000;
      return { character: 'νέος', style: 'νέο' };
    },
  ]);
  const store = createStore({ dataDir: tmpDataDir() });
  const warmup = createWarmup({ hot, store, client: fakeClient(fakeGuild('g1', [c1])), llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => nowMs });
  for (const [id, count] of [['z', 500], ['a', 400], ['b', 350]]) {
    seedPortrait(store, id, { at: T0 - 3_600_000, character: 'παλιός', style: 'παλιό', messageCount: count });
  }
  const scheduler = createPortraitScheduler({ hot, store, refreshPortrait: warmup.refreshPortrait, isWarmingUp: warmup.isWarmingUp, getGuildId: () => 'g1', now: () => nowMs });

  const cycle = await scheduler.tick();

  assert.deepEqual(cycle, { ran: true, due: 3, started: 3, refreshed: 2, skipped: 1 });
  assert.equal(c1.messages.fetchCalls, 1, 'one crawl for the whole check');
  assert.equal(store.getUser('g1', 'z').portraitAttemptAt, iso(T0), 'no lines in the window: stamped');
  assert.equal(store.getUser('g1', 'z').character, 'παλιός');
  assert.equal(store.getUser('g1', 'a').character, 'νέος');
  assert.equal(store.getUser('g1', 'b').character, 'νέος');
  assert.equal(store.state.data.portraitCount, 2);

  nowMs += 61 * 60_000;
  assert.deepEqual(await scheduler.tick(), { ran: false, reason: 'none-due' });
  assert.equal(c1.messages.fetchCalls, 1, 'nobody due: no crawl');
});

test('portrait scheduler: features.portraitRefresh false starts no refresh, the owner\'s command still works', async () => {
  const hot = fakeHot();
  hot.config.features = { portraitRefresh: false };
  const llm = scriptedLlm([{ character: 'νέος', style: 'νέο' }]);
  const { warmup, store } = portraitWarmup({ hot, llm });
  seedPortrait(store, 'a', { messageCount: 900 });
  const scheduler = createPortraitScheduler({ hot, store, refreshPortrait: warmup.refreshPortrait, isWarmingUp: warmup.isWarmingUp, getGuildId: () => 'g1', now: () => T0 + 30 * 3_600_000 });

  assert.deepEqual(await scheduler.tick(), { ran: false, reason: 'off' });
  assert.equal(llm.calls.length, 0);

  const owner = await warmup.refreshPortrait('g1', 'a', '', { force: true, windows: [win('c1', lines('c1', 'a', 5, T0))] });
  assert.equal(owner.ok, true);
  assert.equal(store.getUser('g1', 'a').character, 'νέος');
});

// ---------------------------------------------------------------------------
// refreshPortrait(): what happens while a refresh is in flight (forget, wipe, pause, a warmup
// run), the slot and the stamps on every early end, the LLM's daily cap before any history read,
// and where the next sample starts.
// ---------------------------------------------------------------------------

/** A promise with its resolver, to hold a fake dependency (a history read, one answer). */
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A fake `llm.complete` whose call `i` answers `answers[i]` once `gates[i]` (if any) resolves. */
function perCallLlm(answers, gates = []) {
  const calls = [];
  return {
    calls,
    complete: async (messages, opts) => {
      const i = calls.length;
      calls.push({ messages, opts });
      if (gates[i]) await gates[i].promise;
      return { text: JSON.stringify(answers[Math.min(i, answers.length - 1)]), usage: {}, estimated: 0, finishReason: 'stop' };
    },
  };
}

const userFileOf = (dir, userId) => path.join(dir, 'guilds', 'g1', 'users', `${userId}.json`);

test('refreshPortrait: a member forgotten while the request is in flight is not written back', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const llm = gatedLlm({ character: 'νέος', style: 'νέο' });
  const { warmup } = portraitWarmup({ store, llm });
  seedPortrait(store, 'a');
  store.flush();

  const pending = warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 5, T0))] });
  await waitFor(() => llm.calls.length === 1);
  store.forgetUser('g1', 'a');
  llm.release();
  const result = await pending;
  store.flush();

  assert.deepEqual([result.ok, result.reason], [false, 'gone']);
  assert.equal(store.getUser('g1', 'a'), null);
  assert.equal(fs.existsSync(userFileOf(dir, 'a')), false, 'the forgotten file is not re-created');
  assert.equal(store.state.data.portraitCount, 1, 'the request was sent: the slot is spent');
});

test('refreshPortrait: a member forgotten or wiped during the history read sends nothing and gives the slot back', async () => {
  for (const remove of [(store) => store.forgetUser('g1', 'a'), (store) => store.wipeGuild('g1')]) {
    const dir = tmpDataDir();
    const store = createStore({ dataDir: dir });
    const llm = scriptedLlm([{ character: 'νέος', style: 'νέο' }]);
    const { warmup } = portraitWarmup({ store, llm, client: fakeClient(fakeGuild('g1', [])) });
    seedPortrait(store, 'a');
    store.flush();
    const read = deferred();

    const pending = warmup.refreshPortrait('g1', 'a', '', { crawl: { windows: read.promise } });
    remove(store);
    read.resolve([win('c1', lines('c1', 'a', 5, T0))]);
    const result = await pending;
    store.flush();

    assert.deepEqual([result.ok, result.reason], [false, 'gone']);
    assert.equal(llm.calls.length, 0);
    assert.equal(store.state.data.portraitCount, 0, 'the slot is given back');
    assert.equal(fs.existsSync(userFileOf(dir, 'a')), false);
  }
});

test('refreshPortrait: a member without a stored profile is refreshed only when forced', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const llm = scriptedLlm([{ character: 'νέος', style: 'νέο' }]);
  const { warmup } = portraitWarmup({ store, llm });
  const windows = [win('c1', lines('c1', 'a', 5, T0))];

  const cue = await warmup.refreshPortrait('g1', 'a', 'a cue', { windows });
  assert.deepEqual([cue.ok, cue.reason], [false, 'no-profile']);
  assert.equal(store.state.data.portraitCount, undefined, 'no slot taken');
  assert.equal(llm.calls.length, 0);
  store.flush();
  assert.equal(fs.existsSync(userFileOf(dir, 'a')), false);

  // The owner's command names the member on purpose.
  const owner = await warmup.refreshPortrait('g1', 'a', '', { windows, force: true });
  assert.equal(owner.ok, true);
  assert.equal(store.getUser('g1', 'a').character, 'νέος');
});

test('portrait scheduler: a candidate forgotten before its turn is not re-created', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const nowMs = T0 + 3_600_000;
  const history = [
    ...Array.from({ length: 4 }, (_, i) => rawMessage(T0 - (50 - i) * 60_000, { authorId: 'x' })),
    ...Array.from({ length: 4 }, (_, i) => rawMessage(T0 - (40 - i) * 60_000, { authorId: 'y' })),
  ];
  const c1 = fakeChannel('c1', history);
  const hot = fakeHot();
  const llm = gatedLlm({ character: 'νέος', style: 'νέο' });
  const warmup = createWarmup({ hot, store, client: fakeClient(fakeGuild('g1', [c1])), llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => nowMs });
  seedPortrait(store, 'x', { at: T0 - 3_600_000, messageCount: 500 });
  seedPortrait(store, 'y', { at: T0 - 3_600_000, messageCount: 400 });
  store.flush();
  const scheduler = createPortraitScheduler({ hot, store, refreshPortrait: warmup.refreshPortrait, isWarmingUp: warmup.isWarmingUp, getGuildId: () => 'g1', now: () => nowMs });

  const cycle = scheduler.tick();
  await waitFor(() => llm.calls.length === 1, 500);
  store.forgetUser('g1', 'y'); // the cycle already picked x and y
  llm.release();
  assert.deepEqual(await cycle, { ran: true, due: 2, started: 1, refreshed: 1, skipped: 1 }, 'y is skipped at its turn, no refresh started');
  store.flush();

  assert.equal(llm.calls.length, 1, 'no request for the forgotten member');
  assert.equal(store.getUser('g1', 'y'), null);
  assert.equal(fs.existsSync(userFileOf(dir, 'y')), false);
  assert.equal(store.getUser('g1', 'x').character, 'νέος');
  assert.equal(store.state.data.portraitCount, 1);
});

test('portrait scheduler: a candidate forgotten and re-created by a new message before its turn is not refreshed', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const nowMs = T0 + 3_600_000;
  const history = [
    ...Array.from({ length: 4 }, (_, i) => rawMessage(T0 - (50 - i) * 60_000, { authorId: 'x' })),
    ...Array.from({ length: 4 }, (_, i) => rawMessage(T0 - (40 - i) * 60_000, { authorId: 'y', content: `before forget ${i}` })),
  ];
  const c1 = fakeChannel('c1', history);
  const hot = fakeHot();
  const llm = gatedLlm({ character: 'NEW', style: 'NEW' });
  const warmup = createWarmup({ hot, store, client: fakeClient(fakeGuild('g1', [c1])), llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => nowMs });
  seedPortrait(store, 'x', { at: T0 - 3_600_000, messageCount: 500 });
  seedPortrait(store, 'y', { at: T0 - 3_600_000, messageCount: 400 });
  store.flush();
  const scheduler = createPortraitScheduler({ hot, store, refreshPortrait: warmup.refreshPortrait, isWarmingUp: warmup.isWarmingUp, getGuildId: () => 'g1', now: () => nowMs });

  const cycle = scheduler.tick();
  await waitFor(() => llm.calls.length === 1, 500);
  store.forgetUser('g1', 'y'); // the cycle already picked x and y
  store.touchUser('g1', 'y', 'y', nowMs); // y posts once: a fresh profile
  llm.release();
  assert.deepEqual(await cycle, { ran: true, due: 2, started: 1, refreshed: 1, skipped: 1 });
  store.flush();

  assert.equal(llm.calls.length, 1, 'no second request');
  const y = store.getUser('g1', 'y');
  assert.equal(y.messageCount, 1);
  assert.equal(y.character, '');
  assert.equal(y.style, '');
  assert.equal(y.portraitRefreshedAt ?? null, null);
  assert.equal(y.portraitMessageCount ?? null, null);
  assert.equal(y.portraitAttemptAt ?? null, null);
  assert.equal(store.state.data.portraitCount, 1);
});

test('refreshPortrait: a profile re-created after a forget never samples a line from before it; the owner\'s forced refresh reads the whole window', async () => {
  const llm = scriptedLlm([{ character: 'νέος', style: 'νέο' }]);
  const { warmup, store } = portraitWarmup({ llm }); // 30 hours after T0
  seedPortrait(store, 'y', { at: T0 });
  store.forgetUser('g1', 'y');
  const after = T0 + 10 * 3_600_000;
  for (let i = 0; i < 30; i += 1) store.touchUser('g1', 'y', 'y', after + i * 60_000);
  const windows = [
    win('c1', lines('c1', 'y', 40, T0, (i) => `πριν ${i}`)),
    win('c2', lines('c2', 'y', 30, after, (i) => `μετά ${i}`)),
  ];

  const result = await warmup.refreshPortrait('g1', 'y', '', { windows });

  assert.equal(result.ok, true);
  const own = ownLinesOf(llm.calls[0]);
  assert.equal(own.length, 30);
  assert.ok(own.every((line) => line.includes('μετά')), 'no own line from before the profile was re-created');
  assert.match(llm.calls[0].messages[1].content, /<member>\ny \(id:y\), 30 messages in the window/);

  const forced = await warmup.refreshPortrait('g1', 'y', '', { windows, force: true });
  assert.equal(forced.ok, true);
  assert.equal(ownLinesOf(llm.calls[1]).length, 70, 'the owner names the member on purpose: the whole window');
});

test('refreshPortrait: a re-created profile whose own lines all predate it samples nothing and backs off', async () => {
  const llm = scriptedLlm([{ character: 'νέος', style: 'νέο' }]);
  const now = T0 + 30 * 3_600_000;
  const { warmup, store } = portraitWarmup({ llm, now: () => now });
  seedPortrait(store, 'y', { at: T0 });
  store.forgetUser('g1', 'y');
  for (let i = 0; i < 30; i += 1) store.touchUser('g1', 'y', 'y', now - 60_000 + i);

  const result = await warmup.refreshPortrait('g1', 'y', '', { windows: [win('c1', lines('c1', 'y', 40, T0))] });

  assert.deepEqual([result.ok, result.reason], [false, 'nothing-to-sample']);
  assert.equal(llm.calls.length, 0);
  assert.equal(store.getUser('g1', 'y').character, '');
  assert.equal(store.getUser('g1', 'y').portraitAttemptAt, iso(now), 'backs off memory.portraitRetryHours');
  assert.equal(store.state.data.portraitCount, 0, 'the slot is given back');
});

test('refreshPortrait: a pause during the history read gives the slot back and stamps nothing', async () => {
  const llm = scriptedLlm([{ character: 'νέος', style: 'νέο' }]);
  const { warmup, store } = portraitWarmup({ llm, client: fakeClient(fakeGuild('g1', [])) });
  seedPortrait(store, 'a');
  const read = deferred();

  const pending = warmup.refreshPortrait('g1', 'a', '', { crawl: { windows: read.promise } });
  assert.equal(store.state.data.portraitCount, 1, 'the slot is held during the read');
  store.state.data.paused = true;
  read.resolve([win('c1', lines('c1', 'a', 5, T0))]);
  const result = await pending;

  assert.deepEqual([result.ok, result.reason], [false, 'paused']);
  assert.equal(llm.calls.length, 0);
  assert.equal(store.state.data.portraitCount, 0, 'the slot is given back');
  assert.equal(store.getUser('g1', 'a').portraitAttemptAt ?? null, null, 'the pause backs nobody off');
});

test('refreshPortrait: a sample still over the cap at warmup.minMessages own lines is over-cap: nothing sent, slot back, attempt stamped', async () => {
  const hot = fakeHot({ prompts: { rules: 'a rule about the long story of the weekend trip. '.repeat(200) } });
  hot.config.llm.maxRequestTokens = 1000;
  hot.config.llm.safetyMargin = 1;
  hot.config.warmup.minMessages = 2;
  const llm = scriptedLlm([{ character: 'νέος', style: 'νέο' }]);
  const now = T0 + 30 * 3_600_000;
  const { warmup, store } = portraitWarmup({ hot, llm, now: () => now });
  seedPortrait(store, 'a');

  const result = await warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 5, T0))] });

  assert.deepEqual([result.ok, result.reason], [false, 'over-cap']);
  assert.equal(llm.calls.length, 0, 'no request is built past the cap');
  assert.equal(store.state.data.portraitCount, 0, 'the slot is given back');
  assert.equal(store.getUser('g1', 'a').portraitAttemptAt, iso(now), 'the member backs off');
  assert.equal(store.getUser('g1', 'a').character, 'μιλάει πολύ');
});

test('refreshPortrait: the LLM daily cap keeps an earlier attempt stamp as it was', async () => {
  const now = T0 + 30 * 3_600_000;
  const earlier = iso(now - 30 * 3_600_000); // past memory.portraitRetryHours
  const llm = textLlm([new DailyCapError('daily LLM request cap reached (300)')]);
  const { warmup, store } = portraitWarmup({ llm, now: () => now });
  seedPortrait(store, 'a', { portraitAttemptAt: earlier });

  const result = await warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 5, T0))] });

  assert.deepEqual([result.ok, result.reason, result.cap], [false, 'daily-cap', 'llm']);
  assert.equal(store.getUser('g1', 'a').portraitAttemptAt, earlier, 'neither a fresh back-off nor a cleared one');
  assert.equal(store.state.data.portraitCount, 0);
});

test('refreshPortrait: today\'s LLM requests at llm.maxRequestsPerDay end the refresh before any history read', async () => {
  const now = T0 + 30 * 3_600_000;
  const c1 = fakeChannel('c1', Array.from({ length: 3 }, (_, i) => rawMessage(T0 + i * 60_000, { authorId: 'a' })));
  const hot = fakeHot();
  hot.config.llm.maxRequestsPerDay = 5;
  const llm = scriptedLlm([{ character: 'νέος', style: 'νέο' }]);
  const { warmup, store } = portraitWarmup({ hot, llm, client: fakeClient(fakeGuild('g1', [c1])), now: () => now });
  seedPortrait(store, 'a');
  Object.assign(store.state.data, { llmDay: new Date(now).toISOString().slice(0, 10), llmCount: 5 });

  const capped = await warmup.refreshPortrait('g1', 'a', 'a cue');
  assert.deepEqual([capped.ok, capped.reason, capped.cap], [false, 'daily-cap', 'llm']);
  assert.equal(c1.messages.fetchCalls, 0, 'no history read');
  assert.equal(store.state.data.portraitCount, undefined, 'no slot taken');
  assert.equal(store.getUser('g1', 'a').portraitAttemptAt ?? null, null);

  hot.config.llm.maxRequestsPerDay = 6; // a live raise
  assert.equal((await warmup.refreshPortrait('g1', 'a', 'a cue')).ok, true);
  assert.equal(store.state.data.llmCount, 5, 'the check only reads the LLM counter');
});

test('refreshPortrait: an answer that lands while a warmup run is in flight is not stored', async () => {
  const gates = [deferred(), deferred()];
  const llm = perCallLlm([{ character: 'από την ανανέωση', style: 'ανανέωση' }, { character: 'από την προθέρμανση', style: 'προθέρμανση' }], gates);
  const c1 = fakeChannel('c1', Array.from({ length: 3 }, (_, i) => rawMessage(T0 + i * 60_000, { authorId: 'a' })));
  const { warmup, store } = portraitWarmup({ llm, client: fakeClient(fakeGuild('g1', [c1])) });
  seedPortrait(store, 'a');

  const refresh = warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 5, T0))] });
  await waitFor(() => llm.calls.length === 1);
  const redo = warmup.runPerson('g1', 'a'); // the owner's /nep warmup users user:a
  await waitFor(() => llm.calls.length === 2, 1000);
  gates[0].resolve();
  const outcome = await refresh;

  assert.deepEqual([outcome.ok, outcome.reason], [false, 'warming-up']);
  assert.equal(store.getUser('g1', 'a').character, 'μιλάει πολύ', 'the late answer wrote nothing');
  gates[1].resolve();
  assert.equal((await redo).ok, true);
  assert.equal(store.getUser('g1', 'a').character, 'από την προθέρμανση', 'the redo is the portrait');
});

test('refreshPortrait: a portrait written while the request was in flight is never overwritten', async () => {
  const gates = [deferred()];
  const llm = perCallLlm([{ character: 'από την ανανέωση', style: 'ανανέωση' }, { character: 'από την προθέρμανση', style: 'προθέρμανση' }], gates);
  const c1 = fakeChannel('c1', Array.from({ length: 3 }, (_, i) => rawMessage(T0 + i * 60_000, { authorId: 'a' })));
  const { warmup, store } = portraitWarmup({ llm, client: fakeClient(fakeGuild('g1', [c1])) });
  seedPortrait(store, 'a');

  const refresh = warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 5, T0))] });
  await waitFor(() => llm.calls.length === 1);
  assert.equal((await warmup.runPerson('g1', 'a')).ok, true, 'a person redo runs to the end meanwhile');
  gates[0].resolve();
  const outcome = await refresh;

  assert.deepEqual([outcome.ok, outcome.reason], [false, 'changed']);
  assert.equal(store.getUser('g1', 'a').character, 'από την προθέρμανση');
  assert.equal(store.getUser('g1', 'a').style, 'προθέρμανση');
});

test('refreshPortrait: member tokens in the hint reach the analyzer as name (id:...)', async () => {
  const llm = scriptedLlm([{ character: 'c', style: 's' }]);
  const { warmup, store } = portraitWarmup({ llm });
  store.touchUser('g1', '222222222222222222', 'Βράνος', T0);
  seedPortrait(store, 'a');

  await warmup.refreshPortrait('g1', 'a', 'λέει άλλα από όσα είπε για αυτήν ο <@222222222222222222>', { windows: [win('c1', lines('c1', 'a', 5, T0))] });

  const hint = /<hint>\n([\s\S]*?)\n<\/hint>/.exec(llm.calls[0].messages[1].content)[1];
  assert.equal(hint, 'λέει άλλα από όσα είπε για αυτήν ο Βράνος (id:222222222222222222)');
});

test('refreshPortrait: a throw before the request is sent gives the slot back and stamps nothing', async () => {
  const llm = scriptedLlm([{ character: 'c', style: 's' }]);
  const broken = { ratio: 1, apply() { throw new TypeError('broken'); }, observe() {} };
  const { warmup, store } = portraitWarmup({ llm, calibrator: broken });
  seedPortrait(store, 'a');
  const windows = [win('c1', lines('c1', 'a', 5, T0))];

  await assert.rejects(warmup.refreshPortrait('g1', 'a', '', { windows }), TypeError);
  assert.equal(store.state.data.portraitCount, 0, 'the slot is given back');
  assert.equal(store.getUser('g1', 'a').portraitAttemptAt ?? null, null);
  assert.equal(llm.calls.length, 0);
  await warmup.waitIdle(); // nothing left in flight
  await assert.rejects(warmup.refreshPortrait('g1', 'a', '', { windows }), TypeError, 'the member is free again, not busy');
});

test('refreshPortrait: the next sample starts where the history read began, so a line written during a refresh is not skipped', async () => {
  let nowMs = T0 + 3_600_000;
  const readStart = nowMs;
  const history = Array.from({ length: 3 }, (_, i) => rawMessage(T0 + i * 60_000, { authorId: 'a', content: `παλιό ${i}` }));
  const guild = fakeGuild('g1', [fakeChannel('c1', history)]);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;
  const llm = scriptedLlm([
    () => {
      nowMs += 20 * 60_000; // the answer takes 20 minutes
      return { character: 'νέος', style: 'νέο' };
    },
  ]);
  const { warmup, store } = portraitWarmup({ hot, llm, client: fakeClient(guild), now: () => nowMs });
  seedPortrait(store, 'a', { at: T0 });

  assert.equal((await warmup.refreshPortrait('g1', 'a', '')).ok, true);
  assert.equal(store.getUser('g1', 'a').portraitRefreshedAt, iso(readStart), 'stamped with the read, not the write');

  // A line written while that request was in flight, read by the next crawl a day later.
  const during = rawMessage(readStart + 5 * 60_000, { authorId: 'a', content: 'γράφτηκε στο μεταξύ' });
  const later = fakeChannel('c1', [...history.map((m) => ({ ...m })), during]);
  later.guild = guild;
  guild.channels.cache.set('c1', later);
  nowMs += 25 * 3_600_000;
  assert.equal((await warmup.refreshPortrait('g1', 'a', '')).ok, true);

  const own = ownLinesOf(llm.calls[1]);
  assert.equal(own.length, 1);
  assert.ok(own[0].includes('γράφτηκε στο μεταξύ'));
});

test('writePersonAnswer: a person run stamps the time its history read began', async () => {
  let nowMs = 10_000_000;
  const store = createStore({ dataDir: tmpDataDir() });
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })];
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history)]));
  const llm = scriptedLlm([
    () => {
      nowMs += 20 * 60_000;
      return { character: 'μιλάει πολύ', style: 'σύντομα' };
    },
  ]);
  const warmup = createWarmup({ hot: fakeHot(), store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => nowMs });

  assert.equal((await warmup.runPerson('g1', 'a')).ok, true);
  assert.equal(store.getUser('g1', 'a').portraitRefreshedAt, new Date(10_000_000).toISOString());
});

test('writePersonAnswer: a person run with no portrait keeps the own messages since the last one', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' }), rawMessage(3000, { authorId: 'a' })];
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history)]));
  const llm = scriptedLlm([{ character: '', style: '', interests: [{ topic: 'σκάκι', note: '', times: 1 }] }]);
  const warmup = createWarmup({ hot: fakeHot(), store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  store.touchUser('g1', 'a', 'a', 500);
  store.updateUser('g1', 'a', { messageCount: 2000, portraitMessageCount: 1999 });

  assert.equal((await warmup.runPerson('g1', 'a')).ok, true);
  const profile = store.getUser('g1', 'a');
  assert.equal(profile.messageCount, 3, 'the run SETS the count from its window');
  assert.equal(profile.portraitMessageCount, 2, 'the stamp moved with it');
  assert.equal(profile.portraitRefreshedAt, undefined);
});

// ---------------------------------------------------------------------------
// Two-stage mode (features.memoryTwoStage): the portrait refresh's stage A on memory.model, its
// character worded later by the voice run, and every warmup text in the persona's voice on
// llm.model.
// ---------------------------------------------------------------------------

const BRANOS = '222222222222222222';

/** A live view with the two-stage switch on: neutral requests on `memory.model`, the persona's
 * voice on `llm.model` (`talk/model`); `prompts` overrides (undefined removes a prompt). */
function twoStageHot({ prompts = {}, memory = {} } = {}) {
  const hot = fakeHot({ prompts: { portrait: 'PORTRAIT {{name}} {{fieldChars}}', 'memory-voice': 'VOICE {{name}}', ...prompts } });
  hot.config.features = { memoryTwoStage: true };
  Object.assign(hot.config.memory, { model: 'gpt/decider', voice: { maxPerDay: 100 }, ...memory });
  return hot;
}

/** A stage A answer of prompts/portrait.md. */
function portraitAnswer(style, character = {}) {
  return { style, character: { keep: [], revise: [], add: [], drop: [], ...character } };
}

/** A fake llm for both stages: a voice request (it carries `<items>`) gets `word(item)` for each
 * item it holds, any other request `decision` as JSON (or `decision(messages)` when it is a
 * function). */
function stagedLlm({ decision, word = () => null }) {
  const calls = [];
  return {
    calls,
    complete: async (messages, opts) => {
      calls.push({ messages, opts });
      const items = /<items>\n([\s\S]*?)\n<\/items>/.exec(messages[1].content);
      if (!items) {
        const answer = typeof decision === 'function' ? decision(messages) : decision;
        return { text: JSON.stringify(answer), usage: {}, estimated: 0, finishReason: 'stop' };
      }
      const worded = {};
      for (const item of JSON.parse(items[1])) {
        const text = word(item);
        if (typeof text === 'string') worded[item.id] = text;
      }
      return { text: JSON.stringify({ items: worded }), usage: {}, estimated: 0, finishReason: 'stop' };
    },
  };
}

const itemsOf = (call) => JSON.parse(/<items>\n([\s\S]*?)\n<\/items>/.exec(call.messages[1].content)[1]);

test('warmupRoute: with memoryTwoStage off every request goes out on memory.model as the analyzer role, as before', () => {
  const config = { llm: { model: 'talk/model' }, memory: { model: null, reasoning: { effort: 'low' } } };
  assert.deepEqual(warmupRoute(config), { model: 'talk/model', role: 'analyzer' });
  assert.deepEqual(warmupRoute(config, { voice: true }), { model: 'talk/model', role: 'analyzer' }, 'the voice model is two-stage mode only');
  config.memory.model = 'gpt/decider';
  config.features = { memoryTwoStage: 'yes' }; // read === true
  assert.deepEqual(warmupRoute(config, { voice: true }), { model: 'gpt/decider', role: 'analyzer' });
});

test('warmupRoute: in two-stage mode a voice text goes to llm.model as a memory-wording request, a neutral one stays on memory.model with stage A\'s memory.reasoning and memory.maxOutputTokens; calibration only on the voice model', () => {
  const config = {
    features: { memoryTwoStage: true },
    llm: { model: 'talk/model' },
    // A deployment that still carries the removed memory.voiceModel: never read.
    memory: { model: 'gpt/decider', voiceModel: 'opus/voice', reasoning: { effort: 'low' }, maxOutputTokens: 18000 },
  };
  assert.deepEqual(
    warmupRoute(config, { voice: true }),
    { model: 'talk/model', role: 'voice', purpose: 'memory-voice', cache: false, skipCalibration: false },
    'the caller\'s own output budget; never cache-marked',
  );
  assert.deepEqual(warmupRoute(config), { model: 'gpt/decider', role: 'analyzer', skipCalibration: true, maxOutputTokens: 18000, reasoning: { effort: 'low' } });

  config.memory.model = null;
  config.memory.reasoning = 'low'; // not a plain object: not sent
  config.memory.maxOutputTokens = 7000;
  assert.deepEqual(warmupRoute(config), { model: 'talk/model', role: 'analyzer', skipCalibration: false, maxOutputTokens: 7000 });
});

test('clampPortraitDecision: null on garbage or a character that is not an object of lists', () => {
  assert.equal(clampPortraitDecision(null, fakeHot().config), null);
  assert.equal(clampPortraitDecision([], fakeHot().config), null);
  assert.equal(clampPortraitDecision({ style: 'ύφος' }, fakeHot().config), null);
  assert.equal(clampPortraitDecision({ style: 'ύφος', character: 'ένα κείμενο' }, fakeHot().config), null);
});

test('clampPortraitDecision: the lists are tokenized and clamped, empty entries dropped; only the lists that say something make the brief', () => {
  const config = fakeHot().config; // fieldChars 400
  const nameOf = (id) => (id === BRANOS ? 'Βράνος' : null);
  const long = 'λέξη '.repeat(200);
  const decision = clampPortraitDecision(
    portraitAnswer('  μακριές προτάσεις  ', {
      keep: ['μιλάει πολύ', '', 7],
      revise: [{ old: 'ήσυχη', now: `μαλώνει με τον Βράνος (id:${BRANOS})` }, { old: 'χωρίς νέο' }, { now: 'μόνο νέο' }],
      add: [long],
      drop: [{ old: 'αργεί' }, 'σιωπά', {}],
    }),
    config,
    nameOf,
    { storedCharacter: 'μιλάει πολύ' },
  );

  assert.equal(decision.style, 'μακριές προτάσεις');
  assert.deepEqual(decision.brief.keep, ['μιλάει πολύ']);
  assert.deepEqual(decision.brief.revise, [{ old: 'ήσυχη', now: `μαλώνει με τον <@${BRANOS}>` }, { now: 'μόνο νέο' }]);
  assert.equal(decision.brief.add.length, 1);
  assert.ok(decision.brief.add[0].length <= 400 * 1.25, 'clamped to memory.fieldChars');
  assert.deepEqual(decision.brief.drop, [{ old: 'αργεί' }, { old: 'σιωπά' }]);
  assert.equal(decision.changed, true);

  const quiet = clampPortraitDecision(portraitAnswer('ύφος', { keep: ['μιλάει πολύ'] }), config, nameOf, { storedCharacter: 'μιλάει πολύ' });
  assert.deepEqual(quiet.brief, { keep: ['μιλάει πολύ'] });
  assert.equal(quiet.changed, false, 'keep alone restates the stored portrait: nothing to word');
  assert.equal(clampPortraitDecision(portraitAnswer('ύφος', { keep: ['μιλάει πολύ'] }), config, nameOf).changed, true, 'with no stored portrait, keep is the first one');
  const empty = clampPortraitDecision(portraitAnswer(''), config, nameOf, { storedCharacter: 'μιλάει πολύ' });
  assert.deepEqual([empty.style, empty.brief, empty.changed], ['', {}, false]);
});

test('refreshPortrait (two-stage): stage A on memory.model stores style and queues one character item with the brief; the portrait stamps wait for the voice run', async () => {
  const now = T0 + 30 * 3_600_000;
  const hot = twoStageHot({ memory: { reasoning: { effort: 'low' }, maxOutputTokens: 18000 } });
  const llm = scriptedLlm([portraitAnswer('μακριές προτάσεις', { keep: ['μιλάει πολύ'], add: [`ρωτάει πάντα τον Βράνος (id:${BRANOS})`] })]);
  const { warmup, store } = portraitWarmup({ hot, llm, now: () => now });
  store.touchUser('g1', BRANOS, 'Βράνος', T0);
  seedPortrait(store, 'a', { messageCount: 420, portraitRefreshedAt: iso(T0 - 5 * 86_400_000) });

  const { result, logs } = await withCapturedLogs(() => warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 5, T0))] }));

  assert.deepEqual([result.ok, result.stage, result.characterQueued], [true, 'two', true]);
  assert.equal(llm.calls.length, 1, 'one stage A request');
  const [call] = llm.calls;
  assert.equal(call.messages[0].content, 'PORTRAIT Nept 400', 'prompts/portrait.md with {{name}} and {{fieldChars}}');
  assert.deepEqual([call.opts.model, call.opts.role, call.opts.skipCalibration], ['gpt/decider', 'analyzer', true]);
  assert.deepEqual(call.opts.reasoning, { effort: 'low' }, 'stage A\'s reasoning setting');
  assert.equal(call.opts.maxOutputTokens, 18000, 'stage A\'s output budget, not warmup.maxOutputTokens');
  assert.equal(call.opts.maxRequestTokens, undefined, 'the 50k rail applies');
  const draft = JSON.parse(/<draft>\n([\s\S]*?)\n<\/draft>/.exec(call.messages[1].content)[1]);
  assert.deepEqual(draft, { character: 'μιλάει πολύ', style: 'σύντομα' }, 'the stored portrait is the draft');
  assert.equal(ownLinesOf(call).length, 5);

  const profile = store.getUser('g1', 'a');
  assert.equal(profile.style, 'μακριές προτάσεις', 'style (neutral) is stored at once');
  assert.equal(profile.character, 'μιλάει πολύ', 'character waits for the voice model');
  assert.equal(profile.portraitRefreshedAt, iso(T0 - 5 * 86_400_000), 'no portrait stamp until the item is applied');
  assert.equal(profile.portraitMessageCount, undefined);
  assert.equal(profile.portraitAttemptAt, iso(now), 'the attempt stamp holds the member back meanwhile');
  assert.equal(portraitDue(profile, now, portraitSettings(hot.config)).reason, 'retry-wait');

  const queue = store.getVoiceQueue('g1');
  assert.equal(queue.length, 1);
  assert.deepEqual(
    { kind: queue[0].kind, userId: queue[0].userId, brief: queue[0].brief, createdAt: queue[0].createdAt },
    { kind: 'character', userId: 'a', brief: { keep: ['μιλάει πολύ'], add: [`ρωτάει πάντα τον <@${BRANOS}>`] }, createdAt: now },
    'one item: the lists as the brief (member tokens), dated when the history was read',
  );
  assert.equal(store.state.data.portraitCount, 1);

  const line = logs.find((entry) => entry.msg === 'warmup: portrait refreshed');
  assert.deepEqual([line.stage, line.characterQueued], ['two', true]);
  assert.equal(JSON.stringify(logs).includes('μακριές'), false, 'logs carry counts, never the text');
});

test('refreshPortrait (two-stage): the voice run words the queued character on llm.model from the old text and the brief, rewrites character only and stamps the portrait when it is applied', async () => {
  let nowMs = T0 + 30 * 3_600_000;
  const readAt = nowMs;
  const hot = twoStageHot();
  const llm = stagedLlm({
    decision: portraitAnswer('νέο ύφος', { keep: ['μιλάει πολύ'], add: ['γράφει τη νύχτα'] }),
    word: (item) => (item.kind === 'character' ? 'μιλάει πολύ και γράφει τη νύχτα' : null),
  });
  const { warmup, store } = portraitWarmup({ hot, llm, now: () => nowMs });
  seedPortrait(store, 'a', { messageCount: 420 });
  store.applyProfileOps('g1', 'a', { relationship: 'φίλοι' }, { fieldChars: 400 });

  assert.equal((await warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 5, T0))] })).characterQueued, true);
  nowMs += 10 * 60_000;
  store.updateUser('g1', 'a', { messageCount: 450 });
  const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => nowMs });
  await withCapturedLogs(() => updater.runVoice('g1'));

  assert.equal(llm.calls.length, 2);
  const voice = llm.calls[1];
  assert.deepEqual([voice.opts.model, voice.opts.role, voice.opts.purpose], [undefined, 'voice', 'memory-voice'], 'llm.model, never memory.model');
  const [item] = itemsOf(voice);
  assert.equal(item.kind, 'character');
  assert.equal(item.old, 'μιλάει πολύ', 'the stored portrait goes in as the base');
  assert.deepEqual(item.brief, { keep: ['μιλάει πολύ'], add: ['γράφει τη νύχτα'] });

  const profile = store.getUser('g1', 'a');
  assert.equal(profile.character, 'μιλάει πολύ και γράφει τη νύχτα');
  assert.equal(profile.style, 'νέο ύφος');
  assert.equal(profile.relationship, 'φίλοι', 'nothing else rewritten');
  assert.equal(profile.portraitRefreshedAt, iso(readAt), 'stamped when applied, dated when the history was read');
  assert.equal(profile.portraitMessageCount, 450, 'the count when it was applied');
  assert.equal(profile.portraitAttemptAt, null);
  assert.deepEqual(store.getVoiceQueue('g1'), []);
  assert.equal(portraitDue(profile, nowMs, portraitSettings(hot.config)).due, false);
});

test('refreshPortrait (two-stage): empty lists, or keep alone, leave character unchanged, queue nothing and stamp the member as checked', async () => {
  for (const character of [{}, { keep: ['μιλάει πολύ'] }]) {
    const now = T0 + 30 * 3_600_000;
    const llm = scriptedLlm([portraitAnswer('νέο ύφος', character)]);
    const { warmup, store, hot } = portraitWarmup({ hot: twoStageHot(), llm, now: () => now });
    seedPortrait(store, 'a', { messageCount: 420, portraitAttemptAt: iso(now - 25 * 3_600_000) });

    const result = await warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 5, T0))] });

    assert.deepEqual([result.ok, result.characterQueued], [true, false]);
    const profile = store.getUser('g1', 'a');
    assert.equal(profile.character, 'μιλάει πολύ');
    assert.equal(profile.style, 'νέο ύφος');
    assert.deepEqual(store.getVoiceQueue('g1'), [], 'nothing for the voice model');
    assert.equal(profile.portraitRefreshedAt, iso(now));
    assert.equal(profile.portraitMessageCount, 420);
    assert.equal(profile.portraitAttemptAt, null);
    assert.equal(portraitDue(profile, now + 3_600_000, portraitSettings(hot.config)).due, false, 'not due again at once');
  }
});

test('refreshPortrait (two-stage): an empty answer queues nothing and backs the member off; a cut or unparsable answer stores nothing', async () => {
  const llm = textLlm([
    { text: JSON.stringify(portraitAnswer('  ')) },
    { text: JSON.stringify(portraitAnswer('', { keep: ['μιλάει πολύ'] })) },
    { text: JSON.stringify(portraitAnswer('μισό', { add: ['μισό'] })), finishReason: 'length' },
    { text: '{"style": "μισ' },
    { text: 'όχι json' },
    { text: JSON.stringify({ style: 'ύφος', character: 'ένα κείμενο' }) },
  ]);
  const { warmup, store } = portraitWarmup({ hot: twoStageHot(), llm });
  seedPortrait(store, 'a');
  const windows = [win('c1', lines('c1', 'a', 5, T0))];

  const reasons = [];
  for (let i = 0; i < 6; i += 1) reasons.push((await warmup.refreshPortrait('g1', 'a', '', { windows, force: true })).reason);

  assert.deepEqual(reasons, ['empty-answer', 'empty-answer', 'truncated', 'truncated', 'bad-json', 'bad-json']);
  const profile = store.getUser('g1', 'a');
  assert.equal(profile.character, 'μιλάει πολύ');
  assert.equal(profile.style, 'σύντομα');
  assert.deepEqual(store.getVoiceQueue('g1'), []);
  assert.equal(profile.portraitRefreshedAt ?? null, null);
  assert.ok(profile.portraitAttemptAt, 'backs off');
  assert.equal(store.state.data.portraitCount, 6, 'every request was sent');
});

test('refreshPortrait (two-stage): a missing portrait prompt falls back to the single request on the voice model and warns once', async () => {
  const now = T0 + 30 * 3_600_000;
  const hot = twoStageHot({ prompts: { portrait: undefined }, memory: { reasoning: { effort: 'low' }, maxOutputTokens: 18000 } });
  const llm = scriptedLlm([
    (i, messages) => (messages[0].content.startsWith('PORTRAIT') ? portraitAnswer('ύφος Α', { add: ['νέα συνήθεια'] }) : { character: `χαρακτήρας ${i}`, style: `ύφος ${i}` }),
  ]);
  const { warmup, store } = portraitWarmup({ hot, llm, now: () => now });
  seedPortrait(store, 'a', { messageCount: 420 });
  const windows = [win('c1', lines('c1', 'a', 5, T0))];
  const refresh = () => warmup.refreshPortrait('g1', 'a', '', { windows, force: true });

  const { logs } = await withCapturedLogs(async () => {
    const first = await refresh();
    assert.deepEqual([first.ok, first.stage, first.characterQueued], [true, 'single', false]);
    assert.equal((await refresh()).ok, true);
    hot.prompts.portrait = 'PORTRAIT {{name}} {{fieldChars}}'; // back: stage A again
    assert.equal((await refresh()).stage, 'two');
    delete hot.prompts['memory-voice']; // the voice prompt is part of two-stage mode too
    assert.equal((await refresh()).stage, 'single');
  });

  assert.deepEqual(
    llm.calls.map((call) => [call.messages[0].content.split(' ')[0], call.opts.model, call.opts.role, call.opts.purpose ?? null, 'reasoning' in call.opts, call.opts.maxOutputTokens]),
    [
      ['SYSTEM', 'talk/model', 'voice', 'memory-voice', false, 6000],
      ['SYSTEM', 'talk/model', 'voice', 'memory-voice', false, 6000],
      ['PORTRAIT', 'gpt/decider', 'analyzer', null, true, 18000],
      ['SYSTEM', 'talk/model', 'voice', 'memory-voice', false, 6000],
    ],
    'the fallback words the character itself, on the voice model, never on memory.model, without stage A\'s settings',
  );
  const profile = store.getUser('g1', 'a');
  assert.equal(profile.character, 'χαρακτήρας 3', 'the fallback stores the portrait at once');
  assert.equal(profile.portraitRefreshedAt, iso(now));
  const warnings = logs.filter((entry) => entry.msg === 'warmup: portrait two-stage unavailable');
  assert.deepEqual(
    warnings.map((entry) => [entry.reason, entry.missing]),
    [['no-prompt', ['portrait']], ['no-prompt', ['memory-voice']]],
    'once per change of state, not once per refresh',
  );

  // Without the profile prompt either, there is nothing to fall back to.
  delete hot.prompts.profile;
  const before = store.state.data.portraitCount;
  const missing = await refresh();
  assert.deepEqual([missing.ok, missing.reason], [false, 'no-prompt']);
  assert.equal(llm.calls.length, 4, 'nothing sent');
  assert.equal(store.state.data.portraitCount, before, 'no slot taken');
});

test('refreshPortrait (two-stage): the character item is queued in one synchronous step: an item queued during the request stays', async () => {
  const now = T0 + 30 * 3_600_000;
  const hot = twoStageHot();
  const llm = gatedLlm(portraitAnswer('νέο ύφος', { add: ['γράφει τη νύχτα'] }));
  const { warmup, store } = portraitWarmup({ hot, llm, now: () => now });
  seedPortrait(store, 'a');

  const pending = warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 5, T0))] });
  await waitFor(() => llm.calls.length === 1);
  store.updateVoiceQueue('g1', (queue) => mergeIntoQueue(queue, [{ kind: 'self', brief: ['μου αρέσει ο καφές'] }], now, hot.config));
  llm.release();
  assert.equal((await pending).characterQueued, true);

  assert.deepEqual(store.getVoiceQueue('g1').map((item) => item.kind).sort(), ['character', 'self']);
});

test('refreshPortrait (two-stage): a full queue loses nothing to the character item; the overflow is left for the analyzer\'s next merge', async () => {
  const now = T0 + 30 * 3_600_000;
  const hot = twoStageHot({ memory: { voice: { maxPerDay: 100, queueMax: 2 } } });
  const llm = scriptedLlm([portraitAnswer('νέο ύφος', { add: ['γράφει τη νύχτα'] })]);
  const { warmup, store } = portraitWarmup({ hot, llm, now: () => now });
  seedPortrait(store, 'a');
  store.updateVoiceQueue('g1', (queue) => mergeIntoQueue(queue, [{ kind: 'self', brief: ['πρώτο'] }, { kind: 'self', brief: ['δεύτερο'] }], now - 60_000, hot.config));

  assert.equal((await warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 5, T0))] })).characterQueued, true);

  assert.deepEqual(store.getVoiceQueue('g1').map((item) => item.brief), [['πρώτο'], ['δεύτερο'], { add: ['γράφει τη νύχτα'] }]);
});

test('refreshPortrait (two-stage): an answer that lands while paused, after a forget or over a changed portrait stores no style and queues nothing', async () => {
  for (const meanwhile of ['pause', 'forget', 'change']) {
    const dir = tmpDataDir();
    const store = createStore({ dataDir: dir });
    const llm = gatedLlm(portraitAnswer('νέο ύφος', { add: ['γράφει τη νύχτα'] }));
    const { warmup } = portraitWarmup({ hot: twoStageHot(), store, llm });
    seedPortrait(store, 'a');

    const pending = warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 5, T0))] });
    await waitFor(() => llm.calls.length === 1);
    if (meanwhile === 'pause') store.state.data.paused = true;
    if (meanwhile === 'forget') store.forgetUser('g1', 'a');
    if (meanwhile === 'change') store.applyProfileOps('g1', 'a', { character: 'από την προθέρμανση' }, { fieldChars: 400 });
    llm.release();
    const result = await pending;

    assert.deepEqual([result.ok, result.reason], [false, { pause: 'paused', forget: 'gone', change: 'changed' }[meanwhile]], meanwhile);
    assert.deepEqual(store.getVoiceQueue('g1'), [], `${meanwhile}: nothing queued`);
    if (meanwhile !== 'forget') assert.equal(store.getUser('g1', 'a').style, 'σύντομα', `${meanwhile}: style kept`);
  }
});

test('createWarmup (two-stage): the person and server runs word on llm.model as memory-wording requests, the channel run stays on memory.model; a stale memory.voiceModel is never read', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' }), rawMessage(3000, { authorId: 'a' })];
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history)]));
  const hot = twoStageHot({ memory: { reasoning: { effort: 'low' }, maxOutputTokens: 18000 } });
  const llm = scriptedLlm([
    { purpose: 'p' },
    { character: 'c', style: 's', episodes: [{ date: '2026-10-01', what: 'κάτι', feeling: 'χαρά' }] },
    { patterns: 'x', starters: 'y' },
    { character: 'c2', style: 's2' },
  ]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  assert.equal((await warmup.run('g1')).ok, true);
  assert.deepEqual(
    llm.calls.map((call) => [call.messages[0].content.split(' ')[0], call.opts.model, call.opts.role, call.opts.purpose ?? null, call.opts.cache ?? null, call.opts.skipCalibration]),
    [
      ['CHANNEL', 'gpt/decider', 'analyzer', null, null, true],
      ['SYSTEM', 'talk/model', 'voice', 'memory-voice', false, false],
      ['SERVER', 'talk/model', 'voice', 'memory-voice', false, false],
    ],
    'no voice text on memory.model',
  );
  assert.deepEqual(
    llm.calls.map((call) => [call.opts.reasoning ?? null, call.opts.maxOutputTokens]),
    [
      [{ effort: 'low' }, 18000],
      [null, 6000],
      [null, 6000],
    ],
    'the neutral channel request carries stage A\'s settings, the voice requests keep warmup.maxOutputTokens and no reasoning',
  );
  for (const call of llm.calls) {
    assert.equal(call.opts.countAgainstDailyCap, false, 'the warmup keeps its own rails');
    assert.equal(call.opts.maxRequestTokens, 45000, 'and its own request cap');
  }

  hot.config.memory.voiceModel = 'opus/voice';
  assert.equal((await warmup.runPerson('g1', 'a')).ok, true);
  assert.deepEqual([llm.calls[3].opts.model, llm.calls[3].opts.role, llm.calls[3].opts.skipCalibration], ['talk/model', 'voice', false]);
});

test('createWarmup: with memoryTwoStage off no warmup or portrait request carries skipCalibration or reasoning', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' }), rawMessage(3000, { authorId: 'a' })];
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history)]));
  const hot = fakeHot({ prompts: { portrait: 'PORTRAIT', 'memory-voice': 'VOICE' } });
  hot.config.memory.model = 'gpt/decider';
  hot.config.memory.reasoning = { effort: 'low' };
  const llm = scriptedLlm([{ purpose: 'p' }, { character: 'c', style: 's' }, { patterns: 'x' }, { character: 'c2', style: 's2' }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup.run('g1');
  const refreshed = await warmup.refreshPortrait('g1', 'a', '', { force: true });

  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.stage, undefined, 'the outcome is as before');
  assert.deepEqual(store.getVoiceQueue('g1'), []);
  assert.equal(llm.calls[3].messages[0].content, 'SYSTEM Nept', 'profile.md, not the portrait prompt');
  for (const call of llm.calls) {
    assert.deepEqual([call.opts.model, call.opts.role, 'skipCalibration' in call.opts, 'reasoning' in call.opts], ['gpt/decider', 'analyzer', false, false]);
  }
});

test('refreshPortrait (two-stage): the character item is dated when the history read began, and the voice run stamps the portrait with that, not with the answer\'s time', async () => {
  let nowMs = T0 + 3_600_000;
  const readStart = nowMs;
  const history = Array.from({ length: 3 }, (_, i) => rawMessage(T0 + i * 60_000, { authorId: 'a', content: `παλιό ${i}` }));
  const guild = fakeGuild('g1', [fakeChannel('c1', history)]);
  const hot = twoStageHot();
  const llm = stagedLlm({
    decision: () => {
      nowMs += 20 * 60_000; // the answer takes 20 minutes
      return portraitAnswer('νέο ύφος', { add: ['γράφει τη νύχτα'] });
    },
    word: (item) => (item.kind === 'character' ? 'μιλάει πολύ και γράφει τη νύχτα' : null),
  });
  const { warmup, store } = portraitWarmup({ hot, llm, client: fakeClient(guild), now: () => nowMs });
  seedPortrait(store, 'a', { at: T0 });

  assert.equal((await warmup.refreshPortrait('g1', 'a', '')).characterQueued, true);
  assert.equal(nowMs, readStart + 20 * 60_000, 'the answer came 20 minutes after the read');
  const [item] = store.getVoiceQueue('g1');
  assert.equal(item.createdAt, readStart, 'dated when the history read began, not when the answer came');

  const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => nowMs });
  await withCapturedLogs(() => updater.runVoice('g1'));
  const profile = store.getUser('g1', 'a');
  assert.equal(profile.character, 'μιλάει πολύ και γράφει τη νύχτα');
  assert.equal(profile.portraitRefreshedAt, iso(readStart), 'stamped with the read, not the answer nor the voice run');
});

test('refreshPortrait (two-stage): a check that changes nothing is stamped when the history read began, not when the answer came', async () => {
  let nowMs = T0 + 3_600_000;
  const readStart = nowMs;
  const history = Array.from({ length: 3 }, (_, i) => rawMessage(T0 + i * 60_000, { authorId: 'a', content: `παλιό ${i}` }));
  const guild = fakeGuild('g1', [fakeChannel('c1', history)]);
  const llm = stagedLlm({
    decision: () => {
      nowMs += 20 * 60_000;
      return portraitAnswer('νέο ύφος', { keep: ['μιλάει πολύ'] });
    },
  });
  const { warmup, store } = portraitWarmup({ hot: twoStageHot(), llm, client: fakeClient(guild), now: () => nowMs });
  seedPortrait(store, 'a', { at: T0 });

  const result = await warmup.refreshPortrait('g1', 'a', '');
  assert.deepEqual([result.ok, result.characterQueued], [true, false]);
  assert.notEqual(iso(readStart), iso(nowMs));
  assert.equal(store.getUser('g1', 'a').portraitRefreshedAt, iso(readStart), 'the read, not the answer');
});

test('refreshPortrait: a newer portrait written while a character item waits (the switch rolled back) takes the item out: the voice run never merges the stale brief nor dates the portrait back', async () => {
  let nowMs = T0 + 30 * 3_600_000;
  const queuedAt = nowMs;
  const hot = twoStageHot();
  const llm = stagedLlm({
    decision: (messages) =>
      messages[0].content.startsWith('PORTRAIT') ? portraitAnswer('ύφος Α', { add: ['παλιά συνήθεια'] }) : { character: 'νεότερο πορτρέτο', style: 'νεότερο ύφος' },
    word: () => 'παλιό συγχωνευμένο',
  });
  const { warmup, store } = portraitWarmup({ hot, llm, now: () => nowMs });
  seedPortrait(store, 'a', { messageCount: 420 });
  const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => nowMs });
  const windows = () => [win('c1', lines('c1', 'a', 5, T0))];

  assert.equal((await warmup.refreshPortrait('g1', 'a', '', { windows: windows() })).characterQueued, true);
  hot.config.features.memoryTwoStage = false; // the owner rolls the switch back
  assert.equal((await withCapturedLogs(() => updater.runVoice('g1'))).result.reason, 'off');
  assert.equal(store.getVoiceQueue('g1').length, 1, 'a character item never expires');

  nowMs += 5 * 86_400_000; // days later, a refresh by the counters in single mode
  const newer = await warmup.refreshPortrait('g1', 'a', '', { windows: windows() });
  assert.deepEqual([newer.ok, newer.stage], [true, undefined]);
  assert.deepEqual(store.getVoiceQueue('g1'), [], 'the stale item went with the newer portrait');

  hot.config.features.memoryTwoStage = true; // and on again
  await withCapturedLogs(() => updater.runVoice('g1'));
  assert.equal(llm.calls.length, 2, 'no voice request: nothing left to word');
  const profile = store.getUser('g1', 'a');
  assert.equal(profile.character, 'νεότερο πορτρέτο');
  assert.equal(profile.portraitRefreshedAt, iso(nowMs), 'the newer stamp stands');
  assert.ok(Date.parse(profile.portraitRefreshedAt) > queuedAt);
});

test('refreshPortrait (two-stage): a later check that changes nothing (the owner\'s, while the item waits) settles a character item still queued; the voice run then has nothing to word', async () => {
  let nowMs = T0 + 30 * 3_600_000;
  const hot = twoStageHot();
  let answer = portraitAnswer('ύφος Α', { add: ['παλιά συνήθεια'] });
  const llm = stagedLlm({ decision: () => answer, word: () => 'παλιό συγχωνευμένο' });
  const { warmup, store } = portraitWarmup({ hot, llm, now: () => nowMs });
  seedPortrait(store, 'a', { messageCount: 420 });
  const windows = () => [win('c1', lines('c1', 'a', 5, T0))];

  assert.equal((await warmup.refreshPortrait('g1', 'a', '', { windows: windows() })).characterQueued, true);
  nowMs += 25 * 3_600_000; // past memory.portraitRetryHours
  answer = portraitAnswer('ύφος Β', { keep: ['μιλάει πολύ'] });
  // While the item waits for the voice model only the owner's forced refresh asks stage A again.
  assert.equal((await warmup.refreshPortrait('g1', 'a', '', { windows: windows() })).reason, 'voice-pending');
  assert.equal(llm.calls.length, 1);
  const check = await warmup.refreshPortrait('g1', 'a', '', { windows: windows(), force: true });
  assert.deepEqual([check.ok, check.characterQueued], [true, false]);
  assert.deepEqual(store.getVoiceQueue('g1'), [], 'the older brief is settled by the newer verdict');

  const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => nowMs });
  await withCapturedLogs(() => updater.runVoice('g1'));
  assert.equal(llm.calls.length, 2, 'no voice request');
  const profile = store.getUser('g1', 'a');
  assert.equal(profile.character, 'μιλάει πολύ');
  assert.equal(profile.style, 'ύφος Β');
  assert.equal(profile.portraitRefreshedAt, iso(nowMs));
});

test('refreshPortrait (two-stage): a member whose character item waits for the voice model is neither picked nor asked again (voice-pending: no slot, no crawl, no request) until the voice run applies it', async () => {
  const HOUR = 3_600_000;
  let nowMs = T0 + 30 * HOUR;
  const hot = twoStageHot();
  const llm = stagedLlm({
    decision: portraitAnswer('νέο ύφος', { keep: ['μιλάει πολύ'], add: ['γράφει τη νύχτα'] }),
    word: (item) => (item.kind === 'character' ? 'μιλάει πολύ και γράφει τη νύχτα' : null),
  });
  const c1 = fakeChannel('c1', Array.from({ length: 5 }, (_, i) => rawMessage(T0 + i * 60_000, { authorId: 'a' })));
  const { warmup, store } = portraitWarmup({ hot, llm, client: fakeClient(fakeGuild('g1', [c1])), now: () => nowMs });
  seedPortrait(store, 'a', { messageCount: 420 });
  const scheduler = createPortraitScheduler({ hot, store, refreshPortrait: warmup.refreshPortrait, isWarmingUp: warmup.isWarmingUp, getGuildId: () => 'g1', now: () => nowMs });

  assert.equal((await warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 5, T0))] })).characterQueued, true);
  const [queued] = store.getVoiceQueue('g1');
  const attemptAt = store.getUser('g1', 'a').portraitAttemptAt;

  // The voice model stays down past memory.portraitRetryHours: by the counters alone the member is due again.
  nowMs += 25 * HOUR;
  assert.equal(portraitDue(store.getUser('g1', 'a'), nowMs, portraitSettings(hot.config)).due, true);
  const { result, logs } = await withCapturedLogs(async () => ({ cycle: await scheduler.tick(), cue: await warmup.refreshPortrait('g1', 'a', 'μια νύξη') }));

  assert.deepEqual(result.cycle, { ran: false, reason: 'none-due' }, 'not picked');
  assert.deepEqual([result.cue.ok, result.cue.reason], [false, 'voice-pending'], 'the analyzer\'s cue stands down too');
  assert.equal(llm.calls.length, 1, 'no second stage A request');
  assert.equal(c1.messages.fetchCalls, 0, 'no history crawl');
  // The UTC day turned since the first refresh (the look rolled the counter over): none of today's slots is taken.
  assert.deepEqual([store.state.data.portraitDay, store.state.data.portraitCount], [iso(nowMs).slice(0, 10), 0], 'no daily slot taken');
  assert.deepEqual(store.getVoiceQueue('g1'), [queued], 'the waiting item is neither replaced nor dropped');
  assert.equal(store.getUser('g1', 'a').portraitAttemptAt, attemptAt, 'no back-off: nothing went wrong for the member');
  assert.ok(logs.some((entry) => entry.msg === 'warmup: portrait refresh skipped' && entry.reason === 'voice-pending' && entry.sent === false));

  // The voice run words and applies the item: from then on the counters decide again.
  const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => nowMs });
  await withCapturedLogs(() => updater.runVoice('g1'));
  assert.deepEqual(store.getVoiceQueue('g1'), []);
  assert.equal(store.getUser('g1', 'a').character, 'μιλάει πολύ και γράφει τη νύχτα');
  nowMs += 25 * HOUR; // past memory.portraitRefreshHours since the portrait the voice run stamped
  const again = await warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 5, nowMs - 3 * HOUR))] });
  assert.deepEqual([again.ok, again.characterQueued], [true, true]);
  assert.equal(llm.calls.length, 3, 'stage A, the voice run, stage A again');
});

test('writePersonAnswer (two-stage): a person run that writes a portrait while a voice request for the member\'s character item is in flight wins; the late answer is not applied', async () => {
  let nowMs = T0 + 30 * 3_600_000;
  const store = createStore({ dataDir: tmpDataDir() });
  const history = Array.from({ length: 3 }, (_, i) => rawMessage(T0 + i * 60_000, { authorId: 'a' }));
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history)]));
  const hot = twoStageHot();
  const llm = scriptedLlm([
    (i, messages) =>
      messages[0].content.startsWith('PORTRAIT') ? portraitAnswer('ύφος Α', { add: ['παλιά συνήθεια'] }) : { character: 'από την προθέρμανση', style: 'ύφος προθέρμανσης' },
  ]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => nowMs });
  seedPortrait(store, 'a', { messageCount: 420 });
  assert.equal((await warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 5, T0))] })).characterQueued, true);

  // The voice request for that item, held in flight.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const voiceCalls = [];
  const voiceLlm = {
    complete: async (messages, opts) => {
      voiceCalls.push({ messages, opts });
      await gate;
      const worded = Object.fromEntries(itemsOf({ messages }).map((item) => [item.id, 'παλιό συγχωνευμένο']));
      return { text: JSON.stringify({ items: worded }), usage: {}, estimated: 0, finishReason: 'stop' };
    },
  };
  const updater = createMemoryUpdater({ hot, store, llm: voiceLlm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => nowMs });
  nowMs += 3_600_000;
  const personReadAt = nowMs;

  const { result: voiceDone } = await withCapturedLogs(async () => {
    const voice = updater.runVoice('g1');
    await waitFor(() => voiceCalls.length === 1);
    assert.equal((await warmup.runPerson('g1', 'a')).ok, true);
    assert.deepEqual(store.getVoiceQueue('g1'), [], 'the person run settled the queued item');
    release();
    return voice;
  });

  assert.deepEqual([voiceDone.sent, voiceDone.applied], [1, 0], 'sent, but no longer queued when the answer came');
  const profile = store.getUser('g1', 'a');
  assert.equal(profile.character, 'από την προθέρμανση');
  assert.equal(profile.portraitRefreshedAt, iso(personReadAt), 'the person run\'s stamp stands');
});

test('refreshPortrait (two-stage): a forced refresh of a member with no profile whose answer brings no style queues nothing (no-profile); with a style the profile starts and the item is queued', async () => {
  const llm = textLlm([
    { text: JSON.stringify(portraitAnswer('', { add: ['γράφει τη νύχτα'] })) },
    { text: JSON.stringify(portraitAnswer('μακριές προτάσεις', { add: ['γράφει τη νύχτα'] })) },
  ]);
  const { warmup, store } = portraitWarmup({ hot: twoStageHot(), llm });
  const windows = [win('c1', lines('c1', 'a', 5, T0))];

  const { result: bare, logs } = await withCapturedLogs(() => warmup.refreshPortrait('g1', 'a', '', { windows, force: true }));
  assert.deepEqual([bare.ok, bare.reason], [false, 'no-profile']);
  assert.equal(store.getUser('g1', 'a'), null, 'no profile created');
  assert.deepEqual(store.getVoiceQueue('g1'), [], 'no item the voice run would drop as gone');
  assert.ok(logs.some((entry) => entry.reason === 'no-profile' && entry.sent === true));

  const styled = await warmup.refreshPortrait('g1', 'a', '', { windows, force: true });
  assert.deepEqual([styled.ok, styled.characterQueued], [true, true]);
  assert.equal(store.getUser('g1', 'a').style, 'μακριές προτάσεις');
  assert.equal(store.getVoiceQueue('g1').length, 1);
});

/** Hold `channel`'s history fetch until `open()`: the crawl a refresh awaits. */
function holdFetch(channel) {
  const original = channel.messages.fetch.bind(channel.messages);
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const held = { started: false, open: () => open() };
  channel.messages.fetch = async (opts) => {
    held.started = true;
    await gate;
    return original(opts);
  };
  return held;
}

test('refreshPortrait: the mode, its prompt and the request\'s route are read after the history crawl, so a switch flipped or a prompt removed during it is honoured whole', async () => {
  for (const change of ['on', 'off', 'no-prompt']) {
    const history = Array.from({ length: 3 }, (_, i) => rawMessage(T0 + i * 60_000, { authorId: 'a' }));
    const channel = fakeChannel('c1', history);
    const held = holdFetch(channel);
    const hot = twoStageHot();
    if (change === 'on') hot.config.features.memoryTwoStage = false;
    const llm = stagedLlm({
      decision: (messages) => (messages[0].content.startsWith('PORTRAIT') ? portraitAnswer('νέο ύφος', { add: ['γράφει τη νύχτα'] }) : { character: 'νέος', style: 'νέο' }),
    });
    const { warmup, store } = portraitWarmup({ hot, llm, client: fakeClient(fakeGuild('g1', [channel])) });
    seedPortrait(store, 'a', { at: T0 });

    const pending = withCapturedLogs(() => warmup.refreshPortrait('g1', 'a', ''));
    await waitFor(() => held.started, 500);
    if (change === 'on') hot.config.features.memoryTwoStage = true;
    if (change === 'off') hot.config.features.memoryTwoStage = false;
    if (change === 'no-prompt') {
      delete hot.prompts.portrait;
      delete hot.prompts.profile;
    }
    held.open();
    const { result } = await pending;

    if (change === 'no-prompt') {
      assert.deepEqual([result.ok, result.reason], [false, 'no-prompt'], change);
      assert.equal(llm.calls.length, 0, 'nothing sent');
      assert.equal(store.state.data.portraitCount, 0, 'the slot went back');
      assert.equal(store.getUser('g1', 'a').portraitAttemptAt, undefined, 'no back-off');
      continue;
    }
    assert.equal(llm.calls.length, 1, change);
    const [call] = llm.calls;
    if (change === 'on') {
      assert.deepEqual([call.messages[0].content.split(' ')[0], call.opts.model, call.opts.role], ['PORTRAIT', 'gpt/decider', 'analyzer'], 'stage A whole');
      assert.deepEqual([result.stage, result.characterQueued], ['two', true]);
      assert.equal(store.getVoiceQueue('g1').length, 1);
    } else {
      assert.deepEqual([call.messages[0].content.split(' ')[0], call.opts.model, call.opts.role], ['SYSTEM', 'gpt/decider', 'analyzer'], 'the single request whole');
      assert.equal(result.stage, undefined);
      assert.deepEqual(store.getVoiceQueue('g1'), [], 'nothing queued with the switch off');
      assert.equal(store.getUser('g1', 'a').character, 'νέος');
    }
  }
});

// ---------------------------------------------------------------------------
// Notes refresh: refreshChannelNotes / refreshServerNotes
// ---------------------------------------------------------------------------

const NOTES_DAY = 86_400_000;

/** fakeHot with the notes refresh settings this test sets itself. */
function notesHot(memory = {}) {
  const hot = fakeHot();
  Object.assign(hot.config.memory, { notesSampleDays: 30, notesSampleMessages: 60, notesSampleMaxAuthorShare: 0.35, notesMinMessages: 30, ...memory });
  return hot;
}

/** `days` days of `perDay` raw messages before T0 (one every ten minutes from 11:50 back), every
 * tenth by the persona's own id (`selfUser`, fakeClient's), the rest by five members in turn. */
function spreadHistory(days, perDay, { mark = '', offset = 0 } = {}) {
  const history = [];
  for (let d = days - 1; d >= 0; d -= 1) {
    for (let i = perDay - 1; i >= 0; i -= 1) {
      const ts = T0 - d * NOTES_DAY - (i + 1) * 10 * 60_000 - offset;
      const own = i % 10 === 0;
      const authorId = own ? 'selfUser' : ['a', 'b', 'c', 'd', 'e'][i % 5];
      history.push(rawMessage(ts, { authorId, content: own ? `persona-line ${d}-${i}` : `${mark}member line ${d}-${i}` }));
    }
  }
  return history;
}

const existingNotesOf = (call) => {
  const match = /<existing_notes>\n([\s\S]*?)\n<\/existing_notes>/.exec(call.messages[1].content);
  return match ? JSON.parse(match[1]) : null;
};

test('refreshChannelNotes: fills <existing_notes>, samples across days without the persona, writes only on a change, stamps the review either way', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  store.updateChannel('g1', 'c1', { purpose: 'alpha', topics: 'beta', tone: 'gamma' });
  store.getChannel('g1', 'c1').updatedAt = iso(T0 - 20 * NOTES_DAY);
  const channel = fakeChannel('c1', spreadHistory(12, 30), { name: 'general' });
  const hot = notesHot();
  const llm = scriptedLlm([
    { purpose: 'alpha', topics: 'beta', tone: 'gamma' },
    { purpose: 'alpha', topics: 'beta and delta', tone: 'gamma' },
  ]);
  const warmup = createWarmup({ hot, store, client: fakeClient(fakeGuild('g1', [channel])), llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => T0 });

  const { result: first, logs } = await withCapturedLogs(() => warmup.refreshChannelNotes('g1', 'c1'));
  assert.equal(first.ok, true);
  assert.equal(first.changed, false);
  assert.ok(first.sample <= hot.config.memory.notesSampleMessages, 'the sample stays within memory.notesSampleMessages');
  assert.ok(first.sample >= hot.config.memory.notesMinMessages);
  assert.ok(first.days >= 10, 'the sample spreads over the days of the window');
  assert.equal(first.authors, 5, 'the persona is never one of the authors');
  let stored = store.getChannel('g1', 'c1');
  assert.equal(stored.updatedAt, iso(T0 - 20 * NOTES_DAY), 'an identical answer does not move updatedAt');
  assert.equal(stored.notesSampleReviewedAt, iso(T0));
  assert.equal(stored.notesAttemptAt, null);

  const [call] = llm.calls;
  const content = call.messages[1].content;
  assert.deepEqual(existingNotesOf(call), { purpose: 'alpha', topics: 'beta', tone: 'gamma', writtenDaysAgo: 20 });
  assert.ok(content.indexOf('<channel>') < content.indexOf('<existing_notes>'), '<existing_notes> after <channel>');
  assert.ok(content.indexOf('<existing_notes>') < content.indexOf('<messages>'), '<existing_notes> before <messages>');
  assert.ok(!content.includes('persona-line'), 'no line by the persona reaches the sample');
  assert.deepEqual(store.state.data.warmup?.done?.channels ?? [], [], 'a refresh never marks warmup progress');
  assert.equal(store.state.data.warmup?.tokensUsed ?? 0, 0, 'a refresh never spends the warmup budget');
  assert.notEqual(call.opts.countAgainstDailyCap, false, 'a refresh counts against llm.maxRequestsPerDay');

  const refreshed = logs.find((entry) => entry.msg === 'warmup: notes refreshed');
  assert.deepEqual(
    { target: refreshed.target, channelId: refreshed.channelId, changed: refreshed.changed, sample: refreshed.sample, authors: refreshed.authors, days: refreshed.days },
    { target: 'channel', channelId: 'c1', changed: false, sample: first.sample, authors: 5, days: first.days },
  );
  assert.ok(!JSON.stringify(logs).includes('member line'), 'logs carry counts, never text');

  const second = await withCapturedLogs(() => warmup.refreshChannelNotes('g1', 'c1')).then(({ result }) => result);
  assert.equal(second.ok, true);
  assert.equal(second.changed, true);
  stored = store.getChannel('g1', 'c1');
  assert.equal(stored.topics, 'beta and delta');
  assert.notEqual(stored.updatedAt, iso(T0 - 20 * NOTES_DAY), 'a changed note moves updatedAt');
  assert.equal(stored.notesSampleReviewedAt, iso(T0));
});

test('refreshChannelNotes: a channel changed since the history read is a conflict -- nothing written, attempt stamped', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  store.updateChannel('g1', 'c1', { purpose: 'alpha', topics: 'beta', tone: 'gamma' });
  store.getChannel('g1', 'c1').updatedAt = iso(T0 - 20 * NOTES_DAY);
  const channel = fakeChannel('c1', spreadHistory(12, 30), { name: 'general' });
  const llm = scriptedLlm([
    () => {
      // The stream analyzer rewrites the note while the refresh's request is in flight.
      store.updateChannel('g1', 'c1', { purpose: 'delta' });
      return { purpose: 'epsilon', topics: 'zeta', tone: 'eta' };
    },
  ]);
  const warmup = createWarmup({ hot: notesHot(), store, client: fakeClient(fakeGuild('g1', [channel])), llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => T0 });

  const { result, logs } = await withCapturedLogs(() => warmup.refreshChannelNotes('g1', 'c1'));
  assert.deepEqual([result.ok, result.reason], [false, 'conflict']);
  const stored = store.getChannel('g1', 'c1');
  assert.deepEqual([stored.purpose, stored.topics, stored.tone], ['delta', 'beta', 'gamma'], 'the answer is dropped whole');
  assert.equal(stored.notesAttemptAt, iso(T0));
  assert.equal(stored.notesSampleReviewedAt, null);
  const failed = logs.find((entry) => entry.msg === 'warmup: notes refresh failed');
  assert.deepEqual([failed.target, failed.channelId, failed.reason], ['channel', 'c1', 'conflict']);
});

test('refreshChannelNotes: too few messages in the window is too-few and stamps the attempt; running / paused refuse without a request', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  store.updateChannel('g1', 'c1', { purpose: 'alpha', topics: 'beta', tone: 'gamma' });
  // 10 member lines inside the window; the persona's own lines and the older ones do not count.
  const history = [
    ...Array.from({ length: 40 }, (_, i) => rawMessage(T0 - 59 * NOTES_DAY + i * 60_000, { authorId: 'b' })),
    ...Array.from({ length: 10 }, (_, i) => rawMessage(T0 - NOTES_DAY + i * 60_000, { authorId: 'a' })),
    ...Array.from({ length: 30 }, (_, i) => rawMessage(T0 - NOTES_DAY + (20 + i) * 60_000, { authorId: 'selfUser' })),
  ];
  const channel = fakeChannel('c1', history, { name: 'general' });
  const llm = abortAwareLlm();
  const warmup = createWarmup({ hot: notesHot(), store, client: fakeClient(fakeGuild('g1', [channel])), llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => T0 });

  const held = holdFetch(channel);
  const pendingFew = withCapturedLogs(() => warmup.refreshChannelNotes('g1', 'c1'));
  await waitFor(() => held.started, 500);
  assert.equal(warmup.isWarmingUp(), false, 'a refresh in flight never mutes the persona');
  const { result: second } = await withCapturedLogs(() => warmup.refreshChannelNotes('g1', 'c1'));
  assert.deepEqual([second.ok, second.reason], [false, 'running'], 'one refresh at a time');
  held.open();
  const { result: few } = await pendingFew;
  assert.deepEqual([few.ok, few.reason], [false, 'too-few']);
  assert.equal(llm.calls.length, 0);
  assert.equal(store.getChannel('g1', 'c1').notesAttemptAt, iso(T0));
  assert.equal(store.getChannel('g1', 'c1').notesSampleReviewedAt, null);

  store.state.data.paused = true;
  const { result: paused } = await withCapturedLogs(() => warmup.refreshChannelNotes('g1', 'c1'));
  assert.deepEqual([paused.ok, paused.reason], [false, 'paused']);
  store.state.data.paused = false;

  // A warmup run whose channel request hangs in flight: the refresh is refused meanwhile.
  const pending = withCapturedLogs(() => warmup.run('g1'));
  await waitFor(() => llm.calls.length === 1, 500);
  const { result: busy } = await withCapturedLogs(() => warmup.refreshChannelNotes('g1', 'c1'));
  assert.deepEqual([busy.ok, busy.reason], [false, 'running']);
  assert.equal(llm.calls.length, 1, 'neither refusal sent a request');
  warmup.stop();
  await pending;
});

test('refreshServerNotes: <existing_notes> carries patterns/starters/injokes, lore from the answer is ignored, the guild stamp moves', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  store.updateGuild('g1', { patterns: 'old patterns', starters: 'old starters', injokes: ['old joke'] });
  store.getGuild('g1').notesUpdatedAt = iso(T0 - 5 * NOTES_DAY);
  const main = fakeChannel('c1', spreadHistory(12, 30), { name: 'general' });
  const side = fakeChannel('c2', spreadHistory(3, 30, { mark: 'side-', offset: 5 * 60_000 }), { name: 'side' });
  const hot = notesHot();
  hot.config.memory.mainChannelIds = ['c1'];
  const llm = scriptedLlm([
    { patterns: 'new patterns', starters: 'old starters', injokes: ['old joke'], lore: [{ title: 'The Outage', keys: ['outage'], text: 'the server went down once' }] },
  ]);
  const warmup = createWarmup({ hot, store, client: fakeClient(fakeGuild('g1', [main, side])), llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => T0 });

  const { result, logs } = await withCapturedLogs(() => warmup.refreshServerNotes('g1'));
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.ok(result.sample <= hot.config.memory.notesSampleMessages);
  assert.ok(result.days >= 10);
  assert.equal(result.authors, 5);

  const [call] = llm.calls;
  assert.deepEqual(existingNotesOf(call), { patterns: 'old patterns', starters: 'old starters', injokes: ['old joke'], writtenDaysAgo: 5 });
  const content = call.messages[1].content;
  assert.ok(content.indexOf('<existing_notes>') < content.indexOf('<messages>'));
  assert.ok(!content.includes('side-member line'), 'only the main channels are sampled');
  assert.ok(!content.includes('persona-line'), 'no line by the persona reaches the sample');

  const guild = store.getGuild('g1');
  assert.equal(guild.patterns, 'new patterns');
  assert.equal(guild.starters, 'old starters');
  assert.deepEqual(guild.injokes, ['old joke']);
  assert.equal(guild.notesSampleReviewedAt, iso(T0));
  assert.equal(guild.notesAttemptAt, null);
  assert.equal(store.getLore('g1').length, 0, 'lore from a refresh answer is never written');
  assert.equal(store.state.data.warmup?.done?.server ?? false, false, 'a refresh never marks warmup progress');
  const refreshed = logs.find((entry) => entry.msg === 'warmup: notes refreshed');
  assert.deepEqual([refreshed.target, refreshed.changed, refreshed.channelId], ['server', true, undefined]);
});

// ---------------------------------------------------------------------------
// Over the limit: a refresh's rewrite is never cut, it is re-asked once with <over_limit>
// ---------------------------------------------------------------------------

/** The parsed `<over_limit>` block of any message of a request, or null without one. */
const overLimitBlockOf = (call) => {
  for (const message of call.messages) {
    const match = /<over_limit>\n([\s\S]*?)\n<\/over_limit>/.exec(message.content);
    if (match) return JSON.parse(match[1]);
  }
  return null;
};

/** The retry is the first request, then the first answer as an assistant turn (`answer`: what the
 * fake returned, scriptedLlm's JSON text), then a user turn holding only `<over_limit>`. */
function assertRetryOf(first, retry, expected, answer) {
  assert.equal(first.messages.length, 2, 'the first request: system and user only');
  assert.ok(first.messages.every((message) => message.role !== 'assistant'), 'the first request carries no assistant turn');
  assert.equal(overLimitBlockOf(first), null, 'the first request carries no <over_limit>');
  assert.equal(retry.messages.length, 4);
  assert.deepEqual(retry.messages.slice(0, 2), first.messages, 'the same system and user messages, unchanged');
  assert.deepEqual(retry.messages[2], { role: 'assistant', content: JSON.stringify(answer) }, 'the first answer as returned');
  assert.equal(retry.messages[3].role, 'user');
  assert.ok(retry.messages[3].content.startsWith('<over_limit>') && retry.messages[3].content.endsWith('</over_limit>'), 'the last turn is <over_limit> alone');
  assert.deepEqual(overLimitBlockOf({ messages: [retry.messages[3]] }), expected);
}

test('refreshPortrait: a style over the limit is re-asked once with <over_limit> and the shorter answer is stored', async () => {
  const now = T0 + 30 * 3_600_000;
  // memory.fieldChars 400 with clampTolerance 1.25: 450 is inside the tolerance, yet a rewrite is never widened.
  const llm = scriptedLlm([
    { character: 'νέος χαρακτήρας', style: 'λ'.repeat(450) },
    { character: 'νέος χαρακτήρας', style: 'σύντομο νέο ύφος' },
  ]);
  const { warmup, store } = portraitWarmup({ llm, now: () => now });
  seedPortrait(store, 'a', { messageCount: 420 });

  const result = await warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 5, T0))] });

  assert.equal(result.ok, true);
  assert.equal(llm.calls.length, 2, 'one retry');
  const [first, retry] = llm.calls;
  assertRetryOf(first, retry, { style: { chars: 450, limit: 400 } }, { character: 'νέος χαρακτήρας', style: 'λ'.repeat(450) });
  const profile = store.getUser('g1', 'a');
  assert.equal(profile.style, 'σύντομο νέο ύφος');
  assert.equal(profile.character, 'νέος χαρακτήρας');
  assert.equal(profile.portraitRefreshedAt, iso(now));
  assert.equal(store.state.data.portraitCount, 1, 'one daily slot for both requests');
});

test('refreshPortrait: a second overflow keeps the stored style and ends over-limit with the attempt stamped', async () => {
  const now = T0 + 30 * 3_600_000;
  const llm = scriptedLlm([
    { character: 'νέος', style: 'λ'.repeat(450) },
    { character: 'νέος', style: 'λ'.repeat(420) },
    { character: 'νέος', style: 'λ'.repeat(450) },
  ]);
  const { warmup, store, hot } = portraitWarmup({ llm, now: () => now });
  seedPortrait(store, 'a', { messageCount: 420, portraitAttemptAt: iso(now - 30 * 3_600_000) });
  const windows = [win('c1', lines('c1', 'a', 5, T0))];

  const { result, logs } = await withCapturedLogs(() => warmup.refreshPortrait('g1', 'a', '', { windows }));

  assert.deepEqual(result, { ok: false, reason: 'over-limit', fields: ['style'] });
  assert.equal(llm.calls.length, 2);
  assertRetryOf(llm.calls[0], llm.calls[1], { style: { chars: 450, limit: 400 } }, { character: 'νέος', style: 'λ'.repeat(450) });
  let profile = store.getUser('g1', 'a');
  assert.equal(profile.style, 'σύντομα', 'the stored style stays, never cut');
  assert.equal(profile.character, 'μιλάει πολύ', 'the answer is refused whole');
  assert.equal(profile.portraitAttemptAt, iso(now), 'the attempt is stamped');
  assert.equal(profile.portraitRefreshedAt ?? null, null);
  assert.equal(store.state.data.portraitCount, 1, 'the request was sent: the slot stays taken');
  const failed = logs.find((entry) => entry.msg === 'warmup: portrait refresh failed');
  assert.deepEqual([failed.reason, failed.sent, failed.fields], ['over-limit', true, ['style']]);
  assert.ok(!JSON.stringify(logs).includes('λλλ'), 'logs carry field names, never the text');

  hot.config.memory.overLimitRetries = 0;
  const unretried = await warmup.refreshPortrait('g1', 'a', '', { windows, force: true });
  assert.deepEqual(unretried, { ok: false, reason: 'over-limit', fields: ['style'] });
  assert.equal(llm.calls.length, 3, 'memory.overLimitRetries 0: no retry');
  profile = store.getUser('g1', 'a');
  assert.equal(profile.style, 'σύντομα');
});

test('refreshPortrait (two-stage): a stage A style over the limit is re-asked once; the retry answer is taken whole', async () => {
  const llm = scriptedLlm([
    portraitAnswer('λ'.repeat(450), { add: ['πρώτη σημείωση'] }),
    portraitAnswer('νέο ύφος', { add: ['δεύτερη σημείωση'] }),
  ]);
  const { warmup, store } = portraitWarmup({ hot: twoStageHot(), llm });
  seedPortrait(store, 'a');

  const result = await warmup.refreshPortrait('g1', 'a', '', { windows: [win('c1', lines('c1', 'a', 5, T0))] });

  assert.deepEqual([result.ok, result.characterQueued], [true, true]);
  assert.equal(llm.calls.length, 2);
  assertRetryOf(llm.calls[0], llm.calls[1], { style: { chars: 450, limit: 400 } }, portraitAnswer('λ'.repeat(450), { add: ['πρώτη σημείωση'] }));
  assert.equal(store.getUser('g1', 'a').style, 'νέο ύφος');
  const queue = store.getVoiceQueue('g1');
  assert.equal(queue.length, 1);
  assert.deepEqual(queue[0].brief, { add: ['δεύτερη σημείωση'] }, 'the lists of the retry answer');
});

test('refreshChannelNotes: an overflowing topics is re-asked once; a second overflow writes nothing and stamps the attempt', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  store.updateChannel('g1', 'c1', { purpose: 'alpha', topics: 'beta', tone: 'gamma' });
  store.getChannel('g1', 'c1').updatedAt = iso(T0 - 20 * NOTES_DAY);
  const channel = fakeChannel('c1', spreadHistory(12, 30), { name: 'general' });
  const hot = notesHot();
  const long = 'θ'.repeat(450); // over memory.fieldChars 400, inside clampTolerance 1.25
  const llm = scriptedLlm([
    { purpose: 'alpha', topics: long, tone: 'gamma' },
    { purpose: 'alpha', topics: 'beta and delta', tone: 'gamma' },
    { purpose: 'alpha two', topics: long, tone: 'gamma two' },
    { purpose: 'alpha two', topics: `${long}θ`, tone: 'gamma two' },
    { purpose: 'alpha three', topics: long, tone: 'gamma' },
  ]);
  const warmup = createWarmup({ hot, store, client: fakeClient(fakeGuild('g1', [channel])), llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => T0 });

  const { result: first } = await withCapturedLogs(() => warmup.refreshChannelNotes('g1', 'c1'));
  assert.deepEqual([first.ok, first.changed], [true, true]);
  assert.equal(llm.calls.length, 2, 'one retry');
  assertRetryOf(llm.calls[0], llm.calls[1], { topics: { chars: 450, limit: 400 } }, { purpose: 'alpha', topics: long, tone: 'gamma' });
  let stored = store.getChannel('g1', 'c1');
  assert.equal(stored.topics, 'beta and delta');
  assert.equal(stored.notesSampleReviewedAt, iso(T0));
  const versions = store.listVersions('g1', 'channels', 'c1');
  assert.deepEqual(versions.topics.map((v) => [v.text, v.by]), [['beta', 'refresh']], 'the rewrite keeps the previous text, written by the refresh');

  const { result: second, logs } = await withCapturedLogs(() => warmup.refreshChannelNotes('g1', 'c1'));
  assert.deepEqual(second, { ok: false, reason: 'over-limit', fields: ['topics'] });
  assert.equal(llm.calls.length, 4);
  assertRetryOf(llm.calls[2], llm.calls[3], { topics: { chars: 450, limit: 400 } }, { purpose: 'alpha two', topics: long, tone: 'gamma two' });
  stored = store.getChannel('g1', 'c1');
  assert.deepEqual([stored.purpose, stored.topics, stored.tone], ['alpha', 'beta and delta', 'gamma'], 'nothing written, not even the fields that fit');
  assert.equal(stored.notesAttemptAt, iso(T0));
  const failed = logs.find((entry) => entry.msg === 'warmup: notes refresh failed');
  assert.deepEqual([failed.target, failed.channelId, failed.reason, failed.fields], ['channel', 'c1', 'over-limit', ['topics']]);
  assert.ok(!JSON.stringify(logs).includes('θθθ'), 'logs carry field names, never the text');

  hot.config.memory.overLimitRetries = 0;
  const { result: third } = await withCapturedLogs(() => warmup.refreshChannelNotes('g1', 'c1'));
  assert.deepEqual(third, { ok: false, reason: 'over-limit', fields: ['topics'] });
  assert.equal(llm.calls.length, 5, 'memory.overLimitRetries 0: no retry');
});

test('refreshServerNotes: same for patterns at fieldChars*2', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  store.updateGuild('g1', { patterns: 'old patterns', starters: 'old starters', injokes: ['old joke'] });
  store.getGuild('g1').notesUpdatedAt = iso(T0 - 5 * NOTES_DAY);
  const main = fakeChannel('c1', spreadHistory(12, 30), { name: 'general' });
  const hot = notesHot();
  hot.config.memory.mainChannelIds = ['c1'];
  const long = 'π'.repeat(900); // over fieldChars*2 = 800, inside clampTolerance 1.25
  const starters = 'σ'.repeat(500); // over fieldChars 400, within fieldChars*2
  const llm = scriptedLlm([
    { patterns: long, starters, injokes: ['old joke'] },
    { patterns: 'new patterns', starters, injokes: ['old joke'] },
    { patterns: long, starters: 'other starters', injokes: ['new joke'] },
    { patterns: long, starters: 'other starters', injokes: ['new joke'] },
    { patterns: long, starters: 'other starters', injokes: ['new joke'] },
  ]);
  const warmup = createWarmup({ hot, store, client: fakeClient(fakeGuild('g1', [main])), llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => T0 });

  const { result: first } = await withCapturedLogs(() => warmup.refreshServerNotes('g1'));
  assert.deepEqual([first.ok, first.changed], [true, true]);
  assert.equal(llm.calls.length, 2, 'one retry');
  assertRetryOf(llm.calls[0], llm.calls[1], { patterns: { chars: 900, limit: 800 } }, { patterns: long, starters, injokes: ['old joke'] });
  let guild = store.getGuild('g1');
  assert.equal(guild.patterns, 'new patterns');
  assert.equal(guild.starters, starters, 'starters at 500 fit fieldChars*2, never cut');
  assert.deepEqual(store.listVersions('g1', 'guild', 'guild').patterns.map((v) => [v.text, v.by]), [['old patterns', 'refresh']]);

  const { result: second, logs } = await withCapturedLogs(() => warmup.refreshServerNotes('g1'));
  assert.deepEqual(second, { ok: false, reason: 'over-limit', fields: ['patterns'] });
  assert.equal(llm.calls.length, 4);
  guild = store.getGuild('g1');
  assert.deepEqual([guild.patterns, guild.starters, guild.injokes], ['new patterns', starters, ['old joke']], 'nothing written at all');
  assert.equal(guild.notesAttemptAt, iso(T0));
  const failed = logs.find((entry) => entry.msg === 'warmup: notes refresh failed');
  assert.deepEqual([failed.target, failed.reason, failed.fields], ['server', 'over-limit', ['patterns']]);

  hot.config.memory.overLimitRetries = 0;
  const { result: third } = await withCapturedLogs(() => warmup.refreshServerNotes('g1'));
  assert.deepEqual(third, { ok: false, reason: 'over-limit', fields: ['patterns'] });
  assert.equal(llm.calls.length, 5, 'memory.overLimitRetries 0: no retry');
});

test('createWarmup: run() first pass still clamps and stores (by warmup)', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const history = [rawMessage(1000, { authorId: 'a', content: 'hi one' }), rawMessage(2000, { authorId: 'a', content: 'hi two' })];
  const guild = fakeGuild('g1', [fakeChannel('c1', history, { name: 'general' })]);
  const hot = fakeHot();
  hot.config.memory.clampTolerance = 1;
  const words = (n) => Array.from({ length: n }, (_, i) => `λέξη${i}`).join(' ');
  const llm = scriptedLlm([
    { purpose: words(120), topics: 'everything', tone: 'casual' },
    { character: 'friendly', style: 'short', interests: [], details: [], episodes: [], aliases: [] },
    { patterns: words(250), starters: 'a link', injokes: [], lore: [] },
    { purpose: 'a calmer purpose', topics: 'everything', tone: 'casual' },
  ]);
  const warmup = createWarmup({ hot, store, client: fakeClient(guild), llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  assert.equal((await warmup.run('g1')).ok, true);
  assert.equal(llm.calls.length, 3, 'no retry on a first pass');
  assert.ok(llm.calls.every((call) => overLimitBlockOf(call) === null && call.messages.length === 2), 'no <over_limit>, no assistant turn');
  const channel = store.getChannel('g1', 'c1');
  assert.ok(channel.purpose.length > 0 && channel.purpose.length <= 400, 'a first write over the limit is clamped and stored');
  const guildMemory = store.getGuild('g1');
  assert.ok(guildMemory.patterns.length > 0 && guildMemory.patterns.length <= 800, 'patterns clamped to fieldChars*2');
  assert.deepEqual(store.listVersions('g1', 'channels', 'c1'), {}, 'a first write records no version');
  assert.deepEqual(store.listVersions('g1', 'guild', 'guild'), {});

  // A redo of the channel rewrites a stored note: the previous text is kept, written by the warmup.
  const firstPurpose = channel.purpose;
  await warmup.runChannel('g1', 'c1');
  assert.equal(store.getChannel('g1', 'c1').purpose, 'a calmer purpose');
  assert.deepEqual(store.listVersions('g1', 'channels', 'c1').purpose.map((v) => [v.text, v.by]), [[firstPurpose, 'warmup']]);
});
