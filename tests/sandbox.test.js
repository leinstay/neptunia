// Tests for src/behavior/sandbox.js: the replay sandbox (a real moment's
// request as a turn builds it, sampled, nothing sent), the memory as it stood
// at the moment, the cached media a replay renders, and tools/replay.mjs's use
// of the module, all against fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as sandbox from '../src/behavior/sandbox.js';
import { fetchHistoryWindow } from '../src/discord/collect.js';
import { formatTranscript } from '../src/discord/format.js';
import { videoUrlCacheKey } from '../src/discord/video-sites.js';
import { createCalibrator } from '../src/llm/tokens.js';
import { fill } from '../src/discord/format.js';
import { buildRequest } from '../src/behavior/prompt.js';
import { handleOf } from '../src/behavior/handles.js';

const { liveView, situationHistory, answerReply, sandboxRequestInput, SANDBOX_OMITS, momentView, momentCutoff, hiddenLater, replayMedia } = sandbox;
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { labels } from './fixtures/labels.js';

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const SELF_ID = '900000000000000001';
const ALICE = '111111111111111111';
const BRUNO = '222222222222222222';
const CHANNEL = { id: '500000000000000001', name: 'general', category: 'Talk', topic: null };

/** A moment as normalized channel messages (src/discord/collect.js#normalizeMessage), oldest first:
 * one `[authorId, authorName, text, minutesBefore]` per line, the last one the trigger. */
function moment(lines) {
  const base = { channelId: CHANNEL.id, channelName: CHANNEL.name, channelCategory: CHANNEL.category, channelTopic: null, self: false, bot: false, mentionedUserIds: [], replyToId: null, forwardedFrom: null, attachments: [], links: [], forwarded: [], stickers: [], emojis: [], reactions: [] };
  return { history: lines.map(([authorId, authorName, content, minutes], i) => ({ ...base, id: `80000000000000010${i}`, authorId, authorName, content, ts: NOW - minutes * 60_000 })) };
}

function twoLines() {
  return moment([
    [BRUNO, 'Bruno', 'καλημέρα', 5],
    [ALICE, 'Alice', 'what do you think about chess?', 1],
  ]);
}

function fakeConfig(featureOverrides = {}) {
  return {
    bot: { timezone: 'UTC' },
    context: {
      channelMessages: 100,
      maxMessageChars: 800,
      gapMarkerMinutes: 20,
      otherProfiles: 6,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
      vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
    },
    roles: { voice: 'x/chat', extractor: 'x/memory' },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9, timeoutMs: 1000 },
    memory: {
      maxOutputTokens: 4000,
      timeoutMs: 9000,
      fieldChars: 400,
      maxDetails: 15,
      maxInjokes: 15,
      maxSelfFacts: 20,
      maxEpisodes: 20,
      maxNewEpisodes: 3,
    },
    relationships: { maxDeltaPerUpdate: 15, historySize: 10 },
    lore: { maxEntries: 500 },
    features: featureOverrides,
  };
}

function fakeHot(featureOverrides = {}) {
  return {
    config: fakeConfig(featureOverrides),
    prompts: {
      'system-prompt': 'SYSTEM_MARKER: you are a regular member of this chat.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      memory: 'Summarize what happened.',
      labels,
    },
  };
}

function fakeStore({ guildMemory = {}, userProfiles = {}, channels = [], loreEntries = [] } = {}) {
  const writes = [];
  const writer = (name) => () => writes.push(name);
  return {
    writes,
    getGuild: () => guildMemory,
    getUser: (guildId, userId) => userProfiles[userId] ?? null,
    getPrivate: () => {
      throw new Error('the private layer is out of bounds for the sandbox');
    },
    listChannels: () => channels,
    listUserProfiles: () => Object.values(userProfiles),
    getLore: () => loreEntries,
    applyProfileOps: writer('applyProfileOps'),
    updateGuild: writer('updateGuild'),
    state: { data: {}, markDirty: writer('markDirty') },
  };
}

function fakeLlm(texts, { usage = { total_tokens: 120 }, estimated = 100, onCall } = {}) {
  const calls = [];
  return {
    calls,
    complete: async (messages, options) => {
      calls.push({ messages, options });
      if (onCall) onCall(calls.length);
      const text = Array.isArray(texts) ? texts[(calls.length - 1) % texts.length] : texts;
      return { text, usage, estimated };
    },
  };
}


// ---- liveView ----------------------------------------------------------------

test('liveView: reads prompts at call time', () => {
  const hot = fakeHot();
  const view = liveView({ hot, store: fakeStore(), guildId: 'g1' });
  assert.equal(view.prompts.reply, 'Someone called you: {{author}}.');
  hot.prompts = { ...hot.prompts, reply: 'EDITED' };
  hot.config = { ...hot.config, marker: 1 };
  assert.equal(view.prompts.reply, 'EDITED');
  assert.equal(view.config.marker, 1);
});

test('liveView: memory reads go to the store for the one guild', () => {
  const seen = [];
  const store = {
    getGuild: (g) => (seen.push(['getGuild', g]), { patterns: 'p' }),
    getUser: (g, id) => (seen.push(['getUser', g, id]), { id }),
    listUserProfiles: (g) => (seen.push(['listUserProfiles', g]), []),
    listChannels: (g) => (seen.push(['listChannels', g]), []),
    getLore: (g) => (seen.push(['getLore', g]), []),
  };
  const view = liveView({ hot: fakeHot(), store, guildId: 'g1' });
  view.memory.getGuild();
  view.memory.getUser('u9');
  view.memory.listUserProfiles();
  view.memory.listChannels();
  view.memory.getLore();
  assert.deepEqual(seen, [
    ['getGuild', 'g1'],
    ['getUser', 'g1', 'u9'],
    ['listUserProfiles', 'g1'],
    ['listChannels', 'g1'],
    ['getLore', 'g1'],
  ]);
  assert.equal('getPrivate' in view.memory, false);
});

test('liveView: the calibrator follows the live ratio and never feeds it', () => {
  const live = createCalibrator(0.8);
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1', calibrator: live });
  assert.equal(view.calibrator.ratio, 0.8);
  assert.equal(view.calibrator.apply(1000), live.apply(1000));

  // The sandbox observes nothing: the live ratio stays where it was.
  assert.equal(view.calibrator.observe(1000, 1500), 0.8);
  assert.equal(live.ratio, 0.8);

  // A real turn moves the live ratio; the view reads it at the moment of use.
  live.observe(1000, 1500);
  assert.notEqual(live.ratio, 0.8);
  assert.equal(view.calibrator.ratio, live.ratio);
  assert.equal(view.calibrator.apply(1000), live.apply(1000));

  // Without a live calibrator the view measures tokens as they are.
  const plain = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  assert.equal(plain.calibrator.ratio, 1);
  assert.equal(plain.calibrator.apply(123), 123);
  assert.equal(plain.calibrator.observe(1000, 1500), 1);
});

// ---- answerReply -------------------------------------------------------------

test('answerReply: sends the live system prompt and renders the member\'s profile', async () => {
  const hot = fakeHot();
  const store = fakeStore({ userProfiles: { [ALICE]: { id: ALICE, names: ['Alice'], character: 'CHARACTER_MARKER solves chess problems' } } });
  const view = liveView({ hot, store, guildId: 'g1' });
  const llm = fakeLlm('<msg reply="#2">δεν ξέρω</msg><react to="#1">👍</react>');
  const result = await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 1, at: NOW });

  assert.equal(llm.calls.length, 1);
  const [system, user] = llm.calls[0].messages;
  assert.equal(system.role, 'system');
  assert.ok(system.content.includes('SYSTEM_MARKER'));
  assert.equal(result.request.system, system.content);
  assert.equal(typeof result.request.user, 'string');
  assert.equal(result.request.user, user.content);
  assert.ok(result.request.user.includes('CHARACTER_MARKER'));
  assert.ok(result.request.user.includes('what do you think about chess?'));
  assert.deepEqual(result.answers, [
    { messages: [{ text: 'δεν ξέρω', replyTo: 2 }], reactions: [{ to: 1, emoji: '👍' }], gif: null, draw: null, skip: false, think: '' },
  ]);
  assert.equal(result.stopped, false);
  assert.deepEqual(store.writes, [], 'nothing is written to memory');
});

/** A real moment: normalized messages, the trigger last. */
function storedMoment({ replyToSelf = false, mentions = [] } = {}) {
  const base = { channelId: CHANNEL.id, channelName: 'general', channelCategory: 'Talk', channelTopic: null, bot: false, mentionedUserIds: [], replyToId: null, forwardedFrom: null, attachments: [], links: [], forwarded: [], stickers: [], emojis: [], reactions: [] };
  return {
    history: [
      { ...base, id: '800000000000000001', authorId: SELF_ID, authorName: 'Zoë', self: true, content: 'it opens at nine', ts: NOW - 120000 },
      {
        ...base,
        id: '800000000000000002',
        authorId: ALICE,
        authorName: 'Alice',
        self: false,
        content: `REAL_MOMENT ${'é'.repeat(1500)}`,
        ts: NOW - 60000,
        replyToId: replyToSelf ? '800000000000000001' : null,
        mentionedUserIds: mentions,
        reactions: [{ emoji: '👍', count: 2, mine: false }],
      },
    ],
  };
}

test('situationHistory: a stored moment is replayed as stored, the last message the trigger', () => {
  const moment = storedMoment();
  const { history, trigger, triggerKind } = situationHistory(moment);
  assert.equal(history, moment.history);
  assert.equal(trigger, moment.history[1]);
  assert.equal(triggerKind, 'mention');
  assert.equal(situationHistory(storedMoment({ replyToSelf: true })).triggerKind, 'reply');
  assert.throws(() => situationHistory({ history: [] }), /empty/);
  assert.throws(() => situationHistory({}), /empty/);
  assert.throws(() => situationHistory({ history: [moment.history[0]] }), /self/);
});

test('answerReply: a stored moment is answered from its own messages, reactions included', async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const llm = fakeLlm('<msg>ok</msg>');
  const result = await answerReply({ view, situation: storedMoment({ replyToSelf: true }), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 1, at: NOW });
  assert.ok(result.request.user.includes('REAL_MOMENT'));
  assert.ok(result.request.user.includes('it opens at nine'));
  assert.ok(result.request.user.includes('[reactions: '));
  assert.equal(llm.calls[0].options.countAgainstDailyCap, false);
  assert.equal(llm.calls[0].options.skipCalibration, true);
});

test('answerReply: a stored moment over the request budget loses its oldest messages, never the trigger', async () => {
  const hot = fakeHot();
  hot.config.llm.maxRequestTokens = 2500;
  const moment = storedMoment();
  const filler = Array.from({ length: 30 }, (_, i) => ({ ...moment.history[0], id: `70000000000000${1000 + i}`, self: false, authorId: BRUNO, authorName: 'Bruno', content: `OLD_${i} ${'x'.repeat(700)}`, ts: NOW - 3_600_000 + i * 1000 }));
  const view = liveView({ hot, store: fakeStore(), guildId: 'g1' });
  const llm = fakeLlm('<msg>ok</msg>');
  const result = await answerReply({ view, situation: { ...moment, history: [...filler, ...moment.history] }, selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 1, at: NOW });
  assert.ok(result.request.user.includes('REAL_MOMENT'));
  assert.ok(!result.request.user.includes('OLD_0 '));
});

test('answerReply: makes samples requests, none counted against the daily cap', async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const llm = fakeLlm(['<msg>a</msg>', '<msg>b</msg>', '<skip/>']);
  const result = await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 3, at: NOW });

  assert.equal(llm.calls.length, 3);
  for (const { options } of llm.calls) {
    assert.equal(options.countAgainstDailyCap, false);
    assert.equal(options.skipCalibration, true);
    assert.equal('maxRequestTokens' in options, false);
  }
  assert.deepEqual(result.answers.map((a) => a.messages.map((m) => m.text)), [['a'], ['b'], []]);
  assert.equal(result.answers[2].skip, true);
});

test('answerReply: a ratio under 1 lets a capped section keep more', async () => {
  // Enough self notes to go well past a small aboutChat cap.
  const self = Array.from({ length: 80 }, (_, i) => `note ${i + 1}: the persona likes the café on the corner and tea with honey`);
  const userTextAt = async (ratio) => {
    const hot = fakeHot();
    hot.config.context.caps.aboutChat = 300;
    const view = liveView({ hot, store: fakeStore({ guildMemory: { self } }), guildId: 'g1', calibrator: createCalibrator(ratio) });
    const llm = fakeLlm('<skip/>');
    const result = await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 1, at: NOW });
    return result.request.user;
  };
  const atOne = await userTextAt(1);
  const atLow = await userTextAt(0.7);
  assert.ok(atOne.includes('note 1:'), 'the cap keeps some notes');
  assert.equal(atOne.includes('note 80:'), false, 'the cap is reached at ratio 1');
  assert.ok(atLow.length > atOne.length, `${atLow.length} > ${atOne.length}`);
});

test('answerReply: the feature switches trim the answer as in a real turn', async () => {
  const view = liveView({ hot: fakeHot({ reactions: false, multiMessage: false }), store: fakeStore(), guildId: 'g1' });
  const llm = fakeLlm('<msg>one</msg><msg>two</msg><react to="#1">👍</react>');
  const result = await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 1, at: NOW });
  assert.deepEqual(result.answers[0].messages, [{ text: 'one', replyTo: null }]);
  assert.deepEqual(result.answers[0].reactions, []);
});

test('answerReply: reports usage through onUsage; the result carries no token count of its own', async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const llm = fakeLlm('<msg>a</msg>', { usage: { total_tokens: 120 }, estimated: 100 });
  const seen = [];
  const result = await answerReply({
    view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 2, at: NOW,
    onUsage: (usage, estimated) => seen.push([usage, estimated]),
  });
  assert.deepEqual(seen, [[{ total_tokens: 120 }, 100], [{ total_tokens: 120 }, 100]]);
  assert.deepEqual(Object.keys(result).sort(), ['answers', 'request', 'stopped']);
});

test('answerReply: without usage, onUsage gets null and the estimate (what the budget then charges)', async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const llm = fakeLlm('<msg>a</msg>', { usage: null, estimated: 70 });
  const seen = [];
  await answerReply({
    view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 2, at: NOW,
    onUsage: (usage, estimated) => seen.push([usage, estimated]),
  });
  assert.deepEqual(seen, [[null, 70], [null, 70]]);
});

const EMOJI = [{ id: '600000000000000001', name: 'wave', animated: false }];
const GIF_LIBRARY = {
  nextId: 2,
  entries: {
    k1: { id: 'g1', kind: 'link', url: 'https://tenor.com/view/dance-1', site: 'Tenor', name: 'Danse', itemId: 'k1', messageId: 'm1', channelId: CHANNEL.id, count: 3, last: NOW - 86_400_000, firstSeen: NOW - 86_400_000 },
  },
  backfill: null,
};
const MEDIA_CACHE = {
  'emoji:600000000000000001': { text: 'a waving hand', ts: NOW - 1000 },
  k1: { text: 'a dancing cat', ts: NOW - 1000 },
};

test('answerReply: the server\'s custom emoji and GIF library render as in a live turn, with their cached captions', async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const result = await answerReply({
    view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm: fakeLlm('<msg>ok</msg>'), samples: 1, at: NOW,
    customEmoji: EMOJI, gifs: GIF_LIBRARY, mediaCache: MEDIA_CACHE,
  });
  assert.ok(result.request.user.includes(`<emoji>\n${labels.emoji.header}\n:wave: -- a waving hand\n</emoji>`), result.request.user);
  assert.ok(result.request.user.includes(`<gifs>\n${labels.gifs.header}\ng1 -- a dancing cat\n</gifs>`), result.request.user);
  assert.ok(result.request.user.includes(labels.senses.customEmoji));
  assert.ok(result.request.user.includes(labels.senses.gifs));

  // The switches drop them as in a live turn; nothing handed in, nothing rendered.
  const off = liveView({ hot: fakeHot({ customEmoji: false, gifs: false }), store: fakeStore(), guildId: 'g1' });
  const without = await answerReply({
    view: off, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm: fakeLlm('<msg>ok</msg>'), samples: 1, at: NOW,
    customEmoji: EMOJI, gifs: GIF_LIBRARY, mediaCache: MEDIA_CACHE,
  });
  const bare = await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm: fakeLlm('<msg>ok</msg>'), samples: 1, at: NOW });
  for (const { request } of [without, bare]) {
    assert.ok(!request.user.includes('<emoji>'));
    assert.ok(!request.user.includes('<gifs>'));
  }
});

test('answerReply: a GIF or a drawing alone is an action, not silence; switched off or unknown, nothing is left to do', async () => {
  const answer = async (text, { features = {}, gifs = GIF_LIBRARY } = {}) => {
    const view = liveView({ hot: fakeHot(features), store: fakeStore(), guildId: 'g1' });
    const result = await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm: fakeLlm(text), samples: 1, at: NOW, gifs });
    return result.answers[0];
  };
  const gif = await answer('<gif reply="#2">g1</gif>');
  assert.equal(gif.skip, false);
  assert.deepEqual(gif.gif, { id: 'g1', replyTo: 2 });
  const draw = await answer('<draw self="yes">a cat on a chessboard</draw>');
  assert.equal(draw.skip, false);
  assert.deepEqual(draw.draw, { text: 'a cat on a chessboard', self: true, replyTo: null });

  for (const [text, options] of [
    ['<gif>g9</gif>', {}],
    ['<gif>g1</gif>', { gifs: null }],
    ['<gif>g1</gif>', { features: { gifs: false } }],
    ['<draw>a cat</draw>', { features: { imageGeneration: false } }],
  ]) {
    const dropped = await answer(text, options);
    assert.equal(dropped.skip, true, `${text} ${JSON.stringify(options)}`);
    assert.equal(dropped.gif, null);
    assert.equal(dropped.draw, null);
  }
});

test('answerReply: an aborted signal stops before the next sample', async () => {
  const controller = new AbortController();
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const llm = fakeLlm('<msg>a</msg>', { onCall: () => controller.abort() });
  const result = await answerReply({
    view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 3, at: NOW, signal: controller.signal,
  });
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].options.signal, controller.signal);
  assert.equal(result.answers.length, 1);
  assert.equal(result.stopped, true);
});

test('answerReply: an abort during a request returns what was collected', async () => {
  const controller = new AbortController();
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  let calls = 0;
  const llm = {
    complete: async () => {
      calls += 1;
      if (calls === 2) {
        controller.abort();
        throw new Error('aborted');
      }
      return { text: '<msg>a</msg>', usage: null, estimated: 5 };
    },
  };
  const result = await answerReply({
    view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 3, at: NOW, signal: controller.signal,
  });
  assert.equal(result.answers.length, 1);
  assert.equal(result.stopped, true);
});

test('answerReply: an llm error other than an abort is thrown to the caller', async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const llm = { complete: async () => { throw new Error('provider down'); } };
  await assert.rejects(
    answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 1, at: NOW }),
    /provider down/,
  );
});

test('answerReply: reads everything through the view, so another view of the same shape needs no hot or store', async () => {
  const hot = fakeHot();
  const overlay = {
    prompts: { ...hot.prompts, 'system-prompt': 'OVERLAY_SYSTEM' },
    config: hot.config,
    memory: {
      getGuild: () => ({}),
      getUser: (id) => (id === ALICE ? { id: ALICE, names: ['Alice'], character: 'OVERLAY_CHARACTER' } : null),
      listUserProfiles: () => [],
      listChannels: () => [],
      getLore: () => [],
    },
  };
  const llm = fakeLlm('<skip/>');
  const result = await answerReply({ view: overlay, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 1, at: NOW });
  assert.ok(result.request.system.includes('OVERLAY_SYSTEM'));
  assert.ok(result.request.user.includes('OVERLAY_CHARACTER'));
});

// ---- a stored moment replayed as the turn it was ----------------------------

/** The task texts of the reply, overheard and interject prompts, each naming itself. */
function kindHot(featureOverrides = {}) {
  const hot = fakeHot(featureOverrides);
  hot.prompts = {
    ...hot.prompts,
    reply: 'REPLY_TASK {{author}}: {{trigger}}',
    overheard: 'OVERHEARD_TASK {{author}}: {{trigger}}',
    interject: 'INTERJECT_TASK',
  };
  return hot;
}

const TRIGGER_ID = '800000000000000002';
const KITCHEN = { id: '500000000000000003', name: 'kitchen' };

function aliceStore() {
  return fakeStore({
    userProfiles: {
      [ALICE]: { id: ALICE, names: ['Alice'], character: 'ALICE_PORTRAIT' },
      [BRUNO]: { id: BRUNO, names: ['Bruno'], character: 'BRUNO_PORTRAIT' },
    },
  });
}

async function replay(situation, { hot = kindHot(), samples = 1, ...extra } = {}) {
  const view = liveView({ hot, store: aliceStore(), guildId: 'g1' });
  const llm = fakeLlm('<skip/>');
  const result = await answerReply({ view, situation, selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples, at: NOW, ...extra });
  return { ...result, llm };
}

test('situationHistory: a stored kind replaces the guess; the trigger is found by its id', () => {
  const moment = { ...storedMoment(), kind: 'overheard', triggerId: TRIGGER_ID };
  const { trigger, triggerKind } = situationHistory(moment);
  assert.equal(triggerKind, 'overheard');
  assert.equal(trigger.id, TRIGGER_ID);
  // A kind a turn does not know is no kind: the guess.
  assert.equal(situationHistory({ ...storedMoment(), kind: 'shouted' }).triggerKind, 'mention');
  // A line of hers after the trigger (her request held it) does not make the moment unusable.
  const later = { ...moment.history[0], id: '800000000000000003', content: 'a later line of hers', ts: NOW - 30_000 };
  const extended = situationHistory({ ...moment, history: [...moment.history, later] });
  assert.equal(extended.trigger.id, TRIGGER_ID);
  assert.equal(extended.history.length, 3);
  // A trigger id that points at her own line is refused.
  assert.throws(() => situationHistory({ ...moment, triggerId: '800000000000000001' }), /self/);
});

test('situationHistory: a spontaneous moment has no trigger, whoever wrote last', () => {
  for (const mode of ['interject', 'initiate']) {
    const own = { ...storedMoment(), mode, history: storedMoment().history.slice(0, 1) };
    const { history, trigger, triggerKind } = situationHistory(own);
    assert.equal(history.length, 1);
    assert.equal(trigger, null);
    assert.equal(triggerKind, null);
  }
});

test('answerReply: a moment stored as overheard is replayed with the overheard task and its trigger label', async () => {
  const overheard = await replay({ ...storedMoment(), mode: 'reply', kind: 'overheard', triggerId: TRIGGER_ID });
  assert.ok(overheard.request.user.includes(`OVERHEARD_TASK Alice: ${labels.triggers.overheard}`), overheard.request.user);
  assert.ok(!overheard.request.user.includes('REPLY_TASK'));
  // Its author is not the one who called her.
  assert.ok(overheard.request.user.includes('ALICE_PORTRAIT'));
  assert.ok(!overheard.request.user.includes(labels.peopleNow.marks.interlocutor));
  // The same moment without its kind is the old guess: a mention under the reply task.
  const guessed = await replay(storedMoment());
  assert.ok(guessed.request.user.includes(`REPLY_TASK Alice: ${labels.triggers.mention}`));
  assert.ok(guessed.request.user.includes(labels.peopleNow.marks.interlocutor));
});

test('answerReply: a follow-up and a name call keep their trigger labels; a spontaneous moment takes its mode\'s task', async () => {
  for (const kind of ['followUp', 'name']) {
    const result = await replay({ ...storedMoment(), mode: 'reply', kind, triggerId: TRIGGER_ID });
    assert.ok(result.request.user.includes(`REPLY_TASK Alice: ${labels.triggers[kind]}`), kind);
  }
  const unasked = await replay({ ...storedMoment(), mode: 'interject', kind: null, triggerId: null });
  assert.ok(unasked.request.user.includes('INTERJECT_TASK'));
  assert.ok(!unasked.request.user.includes('REPLY_TASK'));
  assert.ok(!unasked.request.user.includes(labels.peopleNow.marks.interlocutor), 'nobody called her');
  // An unknown mode is a reply.
  const odd = await replay({ ...storedMoment(), mode: 'auto' });
  assert.ok(odd.request.user.includes('REPLY_TASK'));
});

test('answerReply: a follow-up and an untagged reply are replayed with the follow-up task; a tagged reply keeps reply.md', async () => {
  const hot = kindHot();
  hot.prompts = { ...hot.prompts, 'follow-up': 'FOLLOW_UP_TASK {{author}}: {{trigger}}' };
  const followUp = await replay({ ...storedMoment(), mode: 'reply', kind: 'followUp', triggerId: TRIGGER_ID }, { hot });
  assert.ok(followUp.request.user.includes(`FOLLOW_UP_TASK Alice: ${labels.triggers.followUp}`), followUp.request.user);
  assert.ok(!followUp.request.user.includes('REPLY_TASK'));
  const untagged = await replay({ ...storedMoment({ replyToSelf: true }), mode: 'reply', kind: 'reply', triggerId: TRIGGER_ID }, { hot });
  assert.ok(untagged.request.user.includes(`FOLLOW_UP_TASK Alice: ${labels.triggers.reply}`), untagged.request.user);
  const tagged = await replay({ ...storedMoment({ replyToSelf: true, mentions: [SELF_ID] }), mode: 'reply', kind: 'reply', triggerId: TRIGGER_ID }, { hot });
  assert.ok(tagged.request.user.includes(`REPLY_TASK Alice: ${labels.triggers.reply}`), tagged.request.user);
  assert.ok(!tagged.request.user.includes('FOLLOW_UP_TASK'));
});

test('answerReply: no other channel is pulled in and no call is routed', async () => {
  const result = await replay({ ...storedMoment(), pulled: [{ channelId: KITCHEN.id }], source: { channelId: KITCHEN.id, reason: 'routed' } });
  assert.ok(!result.request.user.includes('<channel_view>'));
  const input = sandboxRequestInput({ view: liveView({ hot: kindHot(), store: aliceStore(), guildId: 'g1' }), situation: storedMoment(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, at: NOW });
  assert.deepEqual(input.pulled, []);
  assert.equal(input.source, null);
});

test('answerReply: the destination of a read-only call and the search flag reach <senses>', async () => {
  const destination = fill(labels.senses.elsewhere, { destination: 'general' });
  const withBoth = await replay(storedMoment(), { hot: kindHot({ webLookup: true }), elsewhereDestination: { name: 'general' }, searchAvailable: true });
  assert.ok(withBoth.request.user.includes(destination));
  assert.ok(withBoth.request.user.includes(labels.senses.search));
  const without = await replay(storedMoment(), { hot: kindHot({ webLookup: true }) });
  assert.ok(!without.request.user.includes(destination));
  assert.ok(!without.request.user.includes(labels.senses.search));
});

test('answerReply: the sandbox never runs the server search, so <senses> never offers it', async () => {
  assert.ok(Object.hasOwn(SANDBOX_OMITS, 'recallAvailable'));
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const input = sandboxRequestInput({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, at: NOW, recallAvailable: true });
  assert.equal(input.recallAvailable, null);
  const result = await replay(storedMoment(), { hot: kindHot({ webLookup: true }), searchAvailable: true });
  assert.ok(result.request.user.includes(labels.senses.search));
  assert.ok(!result.request.user.includes(labels.senses.recall));
});

test('answerReply: with the prompt cache on, samples 1 and 2 carry the same marked user part', async () => {
  const cachedHot = () => {
    const hot = fakeHot({ promptCache: true });
    hot.config.roles.voice = 'anthropic/claude-test';
    return hot;
  };
  const view = liveView({ hot: cachedHot(), store: fakeStore(), guildId: 'g1' });
  const llm = fakeLlm('<msg>ok</msg>');
  const result = await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 2, at: NOW });
  const [first, second] = llm.calls.map((call) => call.messages[1].content);
  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  assert.equal(first[0].type, 'text');
  assert.equal(first[0].text, result.request.user);
  assert.ok(first[0].cache_control, 'the part carries the cache marker');

  // One sample, or a request the client does not cache: the plain text as before.
  const single = fakeLlm('<msg>ok</msg>');
  await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm: single, samples: 1, at: NOW });
  assert.equal(typeof single.calls[0].messages[1].content, 'string');
  const off = fakeLlm('<msg>ok</msg>');
  const offHot = cachedHot();
  offHot.config.features.promptCache = false;
  await answerReply({ view: liveView({ hot: offHot, store: fakeStore(), guildId: 'g1' }), situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm: off, samples: 2, at: NOW });
  assert.ok(off.calls.every((call) => typeof call.messages[1].content === 'string'));
});

test('answerReply: every sample is sent as the replay\'s', async () => {
  const { llm } = await replay(storedMoment(), { samples: 2 });
  assert.equal(llm.calls.length, 2);
  assert.ok(llm.calls.every((call) => call.options.origin === 'replay' && call.options.role === 'voice' && call.options.purpose === 'reply'));
});

// ---- the last hours: <recent> -------------------------------------------------

const HOUR = 3_600_000;

/** A recent line the way the store hands it over (src/memory/store.js#getRecent). */
function recentLine(id, text, { at = NOW - HOUR, channelId = CHANNEL.id } = {}) {
  return { id, at, addedAt: new Date(at + 60_000).toISOString(), channelId, text, who: [], weight: 2 };
}

/** A store that keeps a recent store too, counting its reads. */
function recentStore(lines) {
  const reads = [];
  return { ...fakeStore(), reads, getRecent: (guildId) => (reads.push(guildId), { nextId: lines.length + 1, lines }) };
}

test('liveView: the recent store is read for the one guild; a store without one reads as none', () => {
  const store = recentStore([recentLine(1, 'η αγορά άνοιξε')]);
  const view = liveView({ hot: fakeHot(), store, guildId: 'g1' });
  assert.deepEqual(view.memory.getRecent().lines.map((line) => line.text), ['η αγορά άνοιξε']);
  assert.deepEqual(store.reads, ['g1']);
  assert.equal(liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' }).memory.getRecent(), null);
});

test('answerReply: the channel\'s recent lines inside the window render as <recent>, as they stood at the turn\'s time', async () => {
  const lines = [
    recentLine(1, 'RECENT_HERE the café closed early'),
    recentLine(2, 'RECENT_ELSEWHERE a kitchen rumour', { channelId: KITCHEN.id }),
    recentLine(3, 'RECENT_OLD the market moved', { at: NOW - 80 * HOUR }),
  ];
  const ask = async (store, featureOverrides = {}, at = NOW) => {
    const view = liveView({ hot: fakeHot(featureOverrides), store, guildId: 'g1' });
    const result = await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm: fakeLlm('<skip/>'), samples: 1, at });
    return result.request.user;
  };
  const user = await ask(recentStore(lines));
  const block = /<recent>\n([^]*?)\n<\/recent>/.exec(user)?.[1] ?? '';
  assert.ok(block.startsWith(fill(labels.recent.header, { hours: 72 })), user);
  assert.ok(block.includes('RECENT_HERE the café closed early'));
  // Another channel's audience cannot be checked without the guild: its line stays out.
  assert.ok(!user.includes('RECENT_ELSEWHERE'));
  // A line older than memory.recentHours at the turn's time is no longer live.
  assert.ok(!user.includes('RECENT_OLD'));
  // The window is measured at the turn's time, not at today's.
  assert.ok((await ask(recentStore(lines), {}, NOW - 70 * HOUR)).includes('RECENT_OLD the market moved'));

  // No block: the switch off, memory off, a store without a recent store.
  for (const without of [await ask(recentStore(lines), { recent: false }), await ask(recentStore(lines), { memory: false }), await ask(fakeStore())]) {
    assert.ok(!without.includes('<recent>'));
  }
});

test('answerReply: a recent store that cannot be read costs the block, never the answer', async () => {
  const store = { ...fakeStore(), getRecent: () => { throw new Error('the memory store is read-only here'); } };
  const view = liveView({ hot: fakeHot(), store, guildId: 'g1' });
  const llm = fakeLlm('<msg>ok</msg>');
  const { result, logs } = await withCapturedLogs(() =>
    answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 1, at: NOW }),
  );
  assert.equal(result.answers.length, 1);
  assert.ok(!result.request.user.includes('<recent>'));
  assert.deepEqual(logs.map((entry) => [entry.level, entry.msg]), [['warn', 'sandbox: recent failed']]);
});

/** Every input buildRequest reads: the keys it destructures from `input` and each `input.<key>` of its body. */
function buildRequestInputs() {
  const source = fs.readFileSync(new URL('../src/behavior/prompt.js', import.meta.url), 'utf8');
  const start = source.indexOf('export function buildRequest(input) {');
  assert.ok(start >= 0, 'buildRequest is where this test reads it');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  const destructured = /const \{([^}]*)\} = input;/.exec(body);
  assert.ok(destructured, 'buildRequest destructures its input');
  const keys = destructured[1].split(',').map((part) => part.trim().split(/[\s=:]/)[0]).filter(Boolean);
  for (const match of body.matchAll(/\binput\.(\w+)/g)) keys.push(match[1]);
  return new Set(keys);
}

test('sandboxRequestInput: names every input buildRequest reads; what it leaves out is SANDBOX_OMITS, passed as absent', () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const wanted = buildRequestInputs();
  assert.ok(wanted.has('history') && wanted.has('pulled') && wanted.has('gifs'), 'the reader finds both kinds of key');
  for (const situation of [twoLines(), { ...storedMoment(), mode: 'interject' }]) {
    const input = sandboxRequestInput({ view, situation, selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, at: NOW });
    assert.deepEqual(Object.keys(input).sort(), [...wanted].sort());
    const passed = Object.keys(input).filter((key) => !Object.hasOwn(SANDBOX_OMITS, key));
    assert.deepEqual(new Set([...passed, ...Object.keys(SANDBOX_OMITS)]), wanted);
    for (const key of passed) assert.notEqual(input[key], undefined, `${key} is named`);
    for (const [key, reason] of Object.entries(SANDBOX_OMITS)) {
      assert.ok(typeof reason === 'string' && reason.trim(), `${key} says why`);
      const absent = input[key] === null || (Array.isArray(input[key]) && input[key].length === 0);
      assert.ok(absent, `${key} is left out`);
    }
  }
});

test('sandboxRequestInput: a skill scenario passes its inventory and her granted skills; everything else SANDBOX_OMITS leaves out stays out', () => {
  const { SKILL_SCENARIO_OMITS } = sandbox;
  assert.deepEqual(Object.keys(SKILL_SCENARIO_OMITS).sort(), Object.keys(SANDBOX_OMITS).filter((key) => key !== 'skillsInventory' && key !== 'skillsGranted').sort());
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const wanted = buildRequestInputs();
  const rows = [{ name: 'rule.add', title: 'Add a rule', whenToUse: 'when asked', allowed: true, reason: 'allowed' }];
  const granted = ['rule.add'];
  const input = sandboxRequestInput({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, at: NOW, skillsInventory: rows, skillsGranted: granted });
  assert.equal(input.skillsInventory, rows);
  assert.equal(input.skillsGranted, granted);
  const passed = Object.keys(input).filter((key) => !Object.hasOwn(SKILL_SCENARIO_OMITS, key));
  assert.deepEqual(new Set([...passed, ...Object.keys(SKILL_SCENARIO_OMITS)]), wanted);
  for (const key of passed) assert.notEqual(input[key], undefined, `${key} is named`);
  for (const key of Object.keys(SKILL_SCENARIO_OMITS)) {
    const absent = input[key] === null || (Array.isArray(input[key]) && input[key].length === 0);
    assert.ok(absent, `${key} is left out`);
  }
  // An empty catalogue is no block, as in any other sandbox turn.
  assert.equal(sandboxRequestInput({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, at: NOW, skillsInventory: [] }).skillsInventory, null);
  // No grant: no list, as in any other sandbox turn.
  assert.equal(sandboxRequestInput({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, at: NOW, skillsGranted: [] }).skillsGranted, null);
});

test('answerSkillScenario: her skills are shown; a call goes to onCall and its result comes back before <task> (features.followUpContinuation off); nothing else runs', async () => {
  const { answerSkillScenario } = sandbox;
  const view = liveView({ hot: fakeHot({ followUpContinuation: false }), store: fakeStore(), guildId: 'g1' });
  const rows = [{ name: 'rule.add', title: 'Add a rule', whenToUse: 'when asked', allowed: true, reason: 'allowed' }];
  const llm = fakeLlm([
    '<msg>μια στιγμή</msg><call skill="rule.add">όχι spoilers</call>',
    '<msg>έγινε</msg><call skill="rule.add">ξανά</call>',
    '<msg>όχι τώρα</msg>',
    '<call skill="rule.add">πάλι</call>',
  ]);
  const seen = [];
  const outcomes = [
    { verdict: { stage: 'gateway', ok: true }, executed: { skill: 'rule.add', args: { text: 'όχι spoilers' } }, result: { skill: 'rule.add', status: 'ok', data: { text: 'RESULT_MARKER' } }, followUp: true },
    { verdict: { stage: 'gateway', ok: false, code: 'skills-off' }, executed: null, result: { skill: 'rule.add', status: 'denied', code: 'skills-off' }, followUp: false },
  ];
  const result = await answerSkillScenario({
    view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, runs: 3, at: NOW, skillsInventory: rows,
    onCall: (call, context) => {
      seen.push({ call, context });
      return outcomes[seen.length - 1];
    },
  });
  assert.ok(result.request.user.includes('rule.add: Add a rule -- when asked (allowed)'), 'the <skills> block lists her catalogue');
  assert.equal(llm.calls.length, 4, 'run 1 and its follow-up, run 2, run 3 without a follow-up');
  for (const { options } of llm.calls) assert.deepEqual([options.origin, options.countAgainstDailyCap, options.skipCalibration, options.purpose], ['replay', false, true, 'reply']);

  // Run 1: the call reached onCall with the turn's transcript numbers and history (the trigger last).
  assert.deepEqual(seen[0].call, { skill: 'rule.add', args: {}, body: 'όχι spoilers' });
  assert.ok(seen[0].context.idByIndex instanceof Map);
  assert.equal(seen[0].context.history.at(-1).authorId, ALICE);
  const followUser = llm.calls[1].messages[1].content;
  assert.equal(typeof followUser, 'string', 'the follow-up carries no cache marker');
  const at = followUser.indexOf('<result skill="rule.add" status="ok">');
  assert.ok(at > 0 && at < followUser.lastIndexOf('<task>'), 'the result sits before <task>');
  assert.ok(followUser.includes('already posted: μια στιγμή') && followUser.includes('RESULT_MARKER'));
  const [first, second, third] = result.runs;
  assert.deepEqual(first.answer.messages.map((m) => m.text), ['μια στιγμή']);
  assert.deepEqual(first.followUp.answer.messages.map((m) => m.text), ['έγινε']);
  assert.equal(first.followUp.extraCall, true, 'a call in the follow-up is only reported');
  // Run 2: no call, nothing asked of onCall. Run 3: a call whose outcome needs no follow-up.
  assert.deepEqual([second.call, second.outcome, second.followUp], [null, null, null]);
  assert.equal(third.outcome.verdict.code, 'skills-off');
  assert.equal(third.followUp, null);
  assert.equal(seen.length, 2);
  assert.equal(result.stopped, false);
  assert.equal(first.followUp.continuation, false);
});

test('answerSkillScenario: with features.followUpContinuation on the follow-up continues the turn as a live one -- her line with the call\'s mark and why, an ok call\'s data in <result>, the continue task', async () => {
  const { answerSkillScenario } = sandbox;
  const view = liveView({ hot: fakeHot({ followUpContinuation: true }), store: fakeStore(), guildId: 'g1' });
  const rows = [{ name: 'rule.add', title: 'Add a rule', whenToUse: 'when asked', allowed: true, reason: 'allowed' }];
  const llm = fakeLlm(['<msg>μια στιγμή</msg><call skill="message.delete"/>', '<msg>ποιο μήνυμα;</msg>', '<msg>κοιτάζω</msg><call skill="rule.add">όχι spoilers</call>', '<skip/>']);
  const outcomes = [
    { verdict: { stage: 'gateway', ok: false, code: 'invalid-args', reason: 'args.message:required' }, executed: null, result: { skill: 'message.delete', status: 'invalid', code: 'invalid-args', reason: 'args.message:required' }, followUp: true },
    { verdict: { stage: 'gateway', ok: true }, executed: { skill: 'rule.add', args: { text: 'όχι spoilers' } }, result: { skill: 'rule.add', status: 'ok', data: { text: 'RESULT_MARKER' } }, followUp: true },
  ];
  let n = 0;
  const result = await answerSkillScenario({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, runs: 2, at: NOW, skillsInventory: rows, onCall: () => outcomes[(n += 1) - 1] });
  assert.equal(llm.calls.length, 4);
  const failed = llm.calls[1].messages[1].content;
  assert.equal(typeof failed, 'string', 'no cache marker');
  const status = fill(labels.transcript.callStatusReason, { status: labels.transcript.callStatus.invalid, reason: fill(labels.transcript.callReasons['missing-arg'], { arg: 'message' }) });
  assert.ok(failed.includes(`Zoë (you): μια στιγμή [called message.delete in #general: ${status}]`), failed);
  assert.ok(!failed.includes('<result') && !failed.includes(fill(labels.skills.result.alreadyPosted, { text: '' })), failed);
  assert.ok(failed.endsWith(`<task>\n${fill(labels.task.continue, { skill: 'message.delete' })}\n</task>`), failed);
  assert.ok(failed.indexOf('what do you think about chess?') < failed.indexOf('μια στιγμή'), 'the trigger kept, her line after it');
  const read = llm.calls[3].messages[1].content;
  const at = read.indexOf('<result skill="rule.add" status="ok">');
  assert.ok(at > read.indexOf('</chat>') && at < read.lastIndexOf('<task>') && read.includes('RESULT_MARKER'), read);
  assert.ok(read.includes(`Zoë (you): κοιτάζω [called rule.add in #general: ${labels.transcript.callStatus.ok}]`), read);
  assert.deepEqual(result.runs.map((run) => run.followUp.continuation), [true, true]);
  assert.deepEqual(result.runs[0].followUp.answer.messages.map((m) => m.text), ['ποιο μήνυμα;']);
});

// ---- the memory as it stood at the moment: momentView, momentCutoff, hiddenLater ---------------

const CUTOFF = Date.UTC(2026, 8, 29, 18, 2, 0);
const iso = (ms) => new Date(ms).toISOString();
const BEFORE = iso(CUTOFF - 60_000);
const EARLIER = iso(CUTOFF - 3_600_000);
const AT = iso(CUTOFF);
const AFTER = iso(CUTOFF + 60_000);

function aliceProfile() {
  return {
    id: ALICE,
    names: ['Alice'],
    firstSeen: '2026-08-01T10:00:00.000Z',
    lastSeen: AFTER,
    messageCount: 40,
    character: 'Argues with care.',
    style: 'Long messages, accents: é à.',
    relationship: 'Old friend of the persona.',
    interests: [
      { topic: 'chess', note: '', weight: 3, firstSeen: EARLIER, lastSeen: AFTER },
      { topic: 'όπερα', note: 'new', weight: 1, firstSeen: AT, lastSeen: AT },
      { topic: 'sailing', note: '', weight: 1, firstSeen: AFTER, lastSeen: AFTER },
      { topic: 'tea', note: '', weight: 1, firstSeen: null, lastSeen: null },
    ],
    details: [
      { id: 1, text: 'lives by the sea', weight: 2, firstSeen: BEFORE, lastSeen: AFTER },
      { id: 2, text: 'lost the argument', weight: 1, firstSeen: AFTER, lastSeen: AFTER },
      { id: 3, text: 'undated detail', weight: 1, firstSeen: null, lastSeen: null },
    ],
    detailsSeq: 4,
    aliases: [
      { name: 'Ali', weight: 2, firstSeen: EARLIER, lastSeen: AFTER },
      { name: 'Λίσα', weight: 1, firstSeen: AT, lastSeen: AT },
    ],
    affinity: {
      score: 12,
      reason: 'R3 after the argument',
      history: [
        { ts: EARLIER, delta: 5, appliedDelta: 5, score: 5, reason: 'R1' },
        { ts: BEFORE, delta: 4, appliedDelta: 4, score: 9, reason: 'R2' },
        { ts: AFTER, delta: 3, appliedDelta: 3, score: 12, reason: 'R3 after the argument' },
      ],
    },
    episodes: [
      { date: '2026-09-20', what: 'old episode', quote: '', feeling: '', weight: 3, addedAt: EARLIER },
      { date: '2026-09-29', what: 'the argument itself', quote: '', feeling: 'won it', weight: 4, addedAt: AFTER },
      { date: '2026-09-29', what: 'written at the cutoff', quote: '', feeling: '', weight: 2, addedAt: AT },
      { date: '2026-09-28', what: 'no addedAt, the day before', quote: '', feeling: '', weight: 2 },
      { date: '2026-09-29', what: 'no addedAt, the same day', quote: '', feeling: '', weight: 2 },
      { what: 'no date at all', quote: '', feeling: '', weight: 1 },
    ],
    updatedAt: AFTER,
  };
}

function brunoProfile() {
  return {
    id: BRUNO,
    names: ['Bruno'],
    character: 'Quiet.',
    style: '',
    relationship: '',
    interests: [],
    details: [],
    aliases: [],
    affinity: { score: -4, reason: 'R only after', history: [{ ts: AFTER, delta: -4, appliedDelta: -4, score: -4, reason: 'R only after' }] },
    episodes: [],
  };
}

function guildMemory() {
  return {
    patterns: 'Short greetings.',
    starters: 'Games.',
    injokes: ['the café'],
    self: ['likes rain'],
    learned: [
      { id: 1, text: 'answer in one line', weight: 3, firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: AFTER },
      { id: 2, text: 'taught right after', weight: 1, firstSeen: AFTER, lastSeen: AFTER, from: `<@${ALICE}>` },
    ],
    learnedNextId: 3,
  };
}

function loreEntries() {
  return [
    { id: 'a', title: 'Old tale', keys: ['tale'], text: 'Known.', source: 'analyzer', createdAt: EARLIER, updatedAt: AFTER },
    { id: 'b', title: 'The argument', keys: ['argument'], text: 'How it ended.', source: 'analyzer', createdAt: AFTER, updatedAt: AFTER },
    { id: 'c', title: 'Owner note', keys: ['note'], text: 'Undated.', source: 'owner' },
  ];
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** A base view (liveView's shape) over plain data; its data is deep-frozen, so a write throws. */
function baseView() {
  const data = deepFreeze({ users: { [ALICE]: aliceProfile(), [BRUNO]: brunoProfile() }, guild: guildMemory(), lore: loreEntries(), channels: [{ id: 'c1', name: 'games' }] });
  const hot = { prompts: { rules: 'RULES' }, config: { features: {} } };
  return {
    hot,
    view: {
      get prompts() {
        return hot.prompts;
      },
      get config() {
        return hot.config;
      },
      calibrator: { ratio: 1, apply: (n) => n },
      memory: {
        getGuild: () => data.guild,
        getUser: (id) => data.users[id] ?? null,
        listUserProfiles: () => Object.values(data.users),
        listChannels: () => data.channels,
        getLore: () => data.lore,
      },
    },
  };
}

test('momentCutoff: the newest line she saw, else the answer time, else null', () => {
  const history = [{ ts: CUTOFF - 120_000 }, { ts: CUTOFF }];
  assert.equal(momentCutoff({ history, at: CUTOFF + 5000 }), CUTOFF);
  assert.equal(momentCutoff({ history: [{ ts: 1 }, {}], at: CUTOFF + 5000 }), CUTOFF + 5000);
  assert.equal(momentCutoff({ history: [{}], at: undefined }), null);
  assert.equal(momentCutoff({}), null);
  // Lines after the trigger that her request held: the last of them.
  assert.equal(momentCutoff({ history: [{ id: 't', ts: CUTOFF - 60_000 }, { id: 'n', ts: CUTOFF }], triggerId: 't' }), CUTOFF);
  // A trigger id found nowhere: the last line.
  assert.equal(momentCutoff({ history: [{ id: 'a', ts: CUTOFF - 120_000 }, { id: 'b', ts: CUTOFF - 60_000 }], triggerId: 'gone' }), CUTOFF - 60_000);
});

test('momentView: episodes written at or after the cutoff are hidden, earlier ones kept', () => {
  const { view } = baseView();
  const episodes = momentView(view, CUTOFF).memory.getUser(ALICE).episodes.map((e) => e.what);
  assert.deepEqual(episodes, ['old episode', 'no addedAt, the day before', 'no date at all']);
});

test('momentView: affinity history entries at or after the cutoff are hidden; the reason falls back, the score stays', () => {
  const { view } = baseView();
  const at = momentView(view, CUTOFF);
  const affinity = at.memory.getUser(ALICE).affinity;
  assert.deepEqual(affinity.history.map((h) => h.reason), ['R1', 'R2']);
  assert.equal(affinity.reason, 'R2');
  assert.equal(affinity.score, 12);
  const other = at.memory.getUser(BRUNO).affinity;
  assert.deepEqual(other.history, []);
  assert.equal(other.reason, '');
  assert.equal(other.score, -4);
  const later = momentView(view, CUTOFF + 3_600_000).memory.getUser(ALICE).affinity;
  assert.equal(later.reason, 'R3 after the argument');
  assert.equal(later.history.length, 3);
});

test('momentView: the restored reason looks past kept entries whose reason is empty', () => {
  const { view } = baseView();
  const profile = {
    ...aliceProfile(),
    affinity: {
      score: 14,
      reason: 'R3 after the argument',
      history: [
        { ts: EARLIER, delta: 5, appliedDelta: 5, score: 5, reason: 'R1' },
        { ts: BEFORE, delta: 4, appliedDelta: 4, score: 9, reason: '' },
        { ts: AFTER, delta: 5, appliedDelta: 5, score: 14, reason: 'R3 after the argument' },
      ],
    },
  };
  const affinity = momentView({ ...view, memory: { ...view.memory, getUser: () => profile } }, CUTOFF).memory.getUser(ALICE).affinity;
  assert.deepEqual(affinity.history.map((h) => h.reason), ['R1', '']);
  assert.equal(affinity.reason, 'R1');
});

test('momentView: details, interests and aliases first recorded at or after the cutoff are hidden', () => {
  const { view } = baseView();
  const profile = momentView(view, CUTOFF).memory.getUser(ALICE);
  assert.deepEqual(profile.details.map((d) => d.text), ['lives by the sea', 'undated detail']);
  assert.deepEqual(profile.interests.map((i) => i.topic), ['chess', 'tea']);
  assert.deepEqual(profile.aliases.map((a) => a.name), ['Ali']);
  assert.deepEqual(profile.details[0], aliceProfile().details[0]);
});

test('momentView: learned items and lore entries created at or after the cutoff are hidden', () => {
  const { view } = baseView();
  const at = momentView(view, CUTOFF);
  assert.deepEqual(at.memory.getGuild().learned.map((i) => i.text), ['answer in one line']);
  assert.deepEqual(at.memory.getLore().map((e) => e.title), ['Old tale', 'Owner note']);
});

test('momentView: recent lines added at or after the cutoff are hidden; a base without a recent store reads none', () => {
  const { view } = baseView();
  const line = (id, fields = {}) => ({ id, at: CUTOFF - 7_200_000, addedAt: EARLIER, channelId: 'c1', text: `σημείωση ${id}`, who: [], weight: 2, ...fields });
  const stored = deepFreeze({
    nextId: 6,
    lines: [line(1), line(2, { addedAt: AT }), line(3, { at: CUTOFF - 60_000, addedAt: AFTER }), line(4, { addedAt: null }), line(5, { at: CUTOFF + 60_000, addedAt: null })],
  });
  const base = { prompts: view.prompts, config: view.config, memory: { ...view.memory, getRecent: () => stored } };
  const seen = momentView(base, CUTOFF).memory.getRecent();
  assert.deepEqual(seen.lines.map((entry) => entry.id), [1, 4]);
  assert.equal(seen.lines[0], stored.lines[0], 'a kept line is the stored one');
  assert.equal(momentView(base, CUTOFF + 3_600_000).memory.getRecent(), stored);
  assert.equal(momentView(view, CUTOFF).memory.getRecent(), null);
  assert.deepEqual(hiddenLater(base, CUTOFF), hiddenLater(view, CUTOFF));
});

test('momentView: undated fields, channels, prompts and config are untouched', () => {
  const { view, hot } = baseView();
  const at = momentView(view, CUTOFF);
  const profile = at.memory.getUser(ALICE);
  const stored = aliceProfile();
  for (const key of ['id', 'names', 'firstSeen', 'lastSeen', 'messageCount', 'character', 'style', 'relationship', 'detailsSeq', 'updatedAt']) {
    assert.deepEqual(profile[key], stored[key], key);
  }
  const g = at.memory.getGuild();
  for (const key of ['patterns', 'starters', 'injokes', 'self', 'learnedNextId']) assert.deepEqual(g[key], guildMemory()[key], key);
  assert.equal(at.memory.listChannels(), view.memory.listChannels());
  assert.equal(at.memory.getUser('333333333333333333'), null);
  assert.equal(at.calibrator, view.calibrator);
  assert.deepEqual(at.memory.listUserProfiles()[0], at.memory.getUser(ALICE));
  hot.prompts = { rules: 'NEW RULES' };
  assert.equal(at.prompts.rules, 'NEW RULES');
  assert.equal(at.config, hot.config);
});

test('hiddenLater: counts what the cutoff hides, by kind; nothing for undated memory', () => {
  const { view } = baseView();
  assert.deepEqual(hiddenLater(view, CUTOFF), { episodes: 3, affinity: 2, reasons: 2, details: 1, interests: 2, aliases: 1, learned: 1, lore: 1 });
  const bare = { id: ALICE, names: ['Alice'], character: 'x' };
  const plain = { memory: { getGuild: () => ({ patterns: 'p' }), getUser: () => bare, listUserProfiles: () => [bare], listChannels: () => [], getLore: () => null } };
  assert.deepEqual(momentView(plain, CUTOFF).memory.getUser(ALICE), bare);
  assert.equal(momentView(plain, CUTOFF).memory.getLore(), null);
  assert.deepEqual(hiddenLater(plain, CUTOFF), { episodes: 0, affinity: 0, reasons: 0, details: 0, interests: 0, aliases: 0, learned: 0, lore: 0 });
});

// ---- what the persona saw of the moment's media: replayMedia ------------------------------------

const START = Date.UTC(2026, 8, 29, 18, 0, 0);
const VIDEO_ID = '810000000000000001';
const IMAGE_ID = '810000000000000002';
const BLANK_ID = '810000000000000003';
const EMOJI_ID = '810000000000000004';
const SITES = ['youtube.com'];
const YOUTUBE = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const SEEN_TS = START + 3 * 60_000 + 30_000;
const LATER_TS = START + 10 * 60_000;

/** A snowflake for the n-th message, a minute apart from START. */
function sf(n) {
  return ((BigInt(START + n * 60_000) - 1420070400000n) << 22n).toString();
}

function rawMessage(n, authorId, text, extra = {}) {
  const names = { [SELF_ID]: 'Zoë', [ALICE]: 'Alice', [BRUNO]: 'Bruno' };
  return {
    id: sf(n),
    channelId: CHANNEL.id,
    channel: { name: CHANNEL.name },
    author: { id: authorId, bot: authorId === SELF_ID, globalName: names[authorId], username: names[authorId] },
    member: { displayName: names[authorId] },
    cleanContent: text,
    createdTimestamp: START + n * 60_000,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    messageSnapshots: new Map(),
    reactions: { cache: new Map() },
    ...extra,
  };
}

/** A readable guild channel over `raws` (oldest first). */
function fakeChannel(raws) {
  return {
    id: CHANNEL.id,
    name: CHANNEL.name,
    guild: { id: '600000000000000001', members: { me: { id: SELF_ID } } },
    viewable: true,
    isTextBased: () => true,
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      async fetch(arg) {
        let list = [...raws];
        if (arg.before) list = list.filter((m) => BigInt(m.id) < BigInt(arg.before)).slice(-arg.limit);
        else list = list.slice(-arg.limit);
        return new Map(list.map((m) => [m.id, m]));
      },
    },
  };
}

function attachmentsOf(...list) {
  return new Map(list.map((a) => [a.id, { url: `https://cdn.discordapp.com/attachments/1/${a.id}/${a.name}`, size: 1000, ...a }]));
}

/** A chat with media: a clip, two pictures, a video-site link, a custom emoji in the trigger. */
function mediaChat() {
  return [
    rawMessage(0, BRUNO, 'look', { attachments: attachmentsOf({ id: VIDEO_ID, contentType: 'video/mp4', name: 'clip.mp4', duration: 12 }) }),
    rawMessage(1, ALICE, 'and these', { attachments: attachmentsOf({ id: IMAGE_ID, contentType: 'image/png', name: 'a.png' }, { id: BLANK_ID, contentType: 'image/png', name: 'b.png' }) }),
    rawMessage(2, BRUNO, `this one too ${YOUTUBE}`),
    rawMessage(3, ALICE, 'what do you think :wave:', { content: `what do you think <:wave:${EMOJI_ID}>` }),
  ];
}

/** The describer's cache as the live turns left it; frozen, so a write throws. */
function mediaCache() {
  return deepFreeze({
    [VIDEO_ID]: { text: 'a still of a cat', ts: SEEN_TS },
    [`video:${VIDEO_ID}`]: { text: 'a cat knocks a cup off the table', ts: SEEN_TS, watched: true },
    [IMAGE_ID]: { text: 'a café terrace at night', ts: SEEN_TS },
    [BLANK_ID]: { miss: true, ts: SEEN_TS },
    [`video:${videoUrlCacheKey(YOUTUBE)}`]: { text: 'a music video from the eighties', ts: SEEN_TS, watched: true },
    // Described only after she answered: she never saw it.
    [`emoji:${EMOJI_ID}`]: { text: 'a waving hand', ts: LATER_TS },
  });
}

function rendered(history, { descriptions, videos } = {}) {
  return formatTranscript(history, { timezone: 'UTC', gapMinutes: 60, maxChars: 2000, selfName: 'Zoë', labels, descriptions, videos })
    .map((item) => item.text)
    .join('\n');
}

test('replayMedia: a stored watched length and total pass through, so a part-watched link renders as live', async () => {
  const history = await fetchHistoryWindow(fakeChannel(mediaChat()), { anchorId: sf(3), limit: 30, selfId: SELF_ID, embedTextChars: 300, videoSites: SITES });
  const key = `video:${videoUrlCacheKey(YOUTUBE)}`;
  const cache = deepFreeze({ [key]: { text: 'a long lecture', ts: SEEN_TS, watched: true, watchedSeconds: 300, totalSeconds: 3289 } });
  const media = replayMedia(history, { cache, sites: SITES });
  assert.deepEqual(media.videos.get(videoUrlCacheKey(YOUTUBE)), { state: 'watched', text: 'a long lecture', watchedSeconds: 300, totalSeconds: 3289 });
  assert.match(rendered(history, media), /\[watched the first 5:00 of 54:49 \(clip cap\): a long lecture\]/);
});

test('replayMedia: the describer cache as it stood when she answered renders as the live transcript did, read only', async () => {
  const history = await fetchHistoryWindow(fakeChannel(mediaChat()), { anchorId: sf(3), limit: 30, selfId: SELF_ID, embedTextChars: 300, videoSites: SITES });
  assert.equal(history.length, 4);
  const cache = mediaCache();
  const media = replayMedia(history, { cache, sites: SITES, before: START + 4 * 60_000 });
  assert.deepEqual(media.descriptions, new Map([[VIDEO_ID, 'a still of a cat'], [IMAGE_ID, 'a café terrace at night']]));
  assert.deepEqual(
    media.videos,
    new Map([
      [VIDEO_ID, { state: 'watched', text: 'a cat knocks a cup off the table' }],
      [videoUrlCacheKey(YOUTUBE), { state: 'watched', text: 'a music video from the eighties' }],
    ]),
  );
  const text = rendered(history, media);
  assert.match(text, /\[video: clip\.mp4, 0:12, watched: a cat knocks a cup off the table\]/);
  assert.match(text, /\[image: a café terrace at night\] \[image\]/);
  assert.match(text, /\[watched: a music video from the eighties\]/);
  assert.doesNotMatch(text, /a waving hand/);
  // No time bound: what was described later is taken too.
  assert.equal(replayMedia(history, { cache, sites: SITES }).descriptions.get(`emoji:${EMOJI_ID}`), 'a waving hand');
  // Nothing cached: empty maps, the transcript as it renders without any.
  for (const empty of [replayMedia(history, { cache: null, sites: SITES }), replayMedia(history, { cache: {}, sites: SITES }), replayMedia(history)]) {
    assert.equal(empty.descriptions.size, 0);
    assert.equal(empty.videos.size, 0);
    assert.equal(rendered(history, empty), rendered(history));
  }
});

// ---- tools/replay.mjs ------------------------------------------------------------------------

test('tools/replay.mjs: replays through src/behavior/sandbox.js, every name it takes exported there', () => {
  const source = fs.readFileSync(new URL('../tools/replay.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("path.join(src, 'behavior', 'sandbox.js')"), 'the engine check names the sandbox');
  const match = /const \{([^}]*)\} = await load\('behavior\/sandbox\.js'\);/.exec(source);
  assert.ok(match, 'replay loads the sandbox');
  const names = match[1].split(',').map((name) => name.trim()).filter(Boolean);
  assert.ok(names.length >= 10);
  for (const name of names) assert.notEqual(sandbox[name], undefined, name);
  assert.deepEqual([...sandbox.SANDBOX_STORE_READS].sort(), ['getGifs', 'getGuild', 'getLore', 'getMediaCache', 'getRecent', 'getUser', 'listChannels', 'listUserProfiles']);
});

// ---- mention handles (features.mentionHandles) -------------------------------------------

const ZOE_ID = '333333333333333333';
const DIRECTORY_LABELS = { ...labels, transcript: { ...labels.transcript, author: '{name} [{handle}]' }, directory: { lead: 'DIRECTORY', line: '{handle} {names}', lineAliases: '{handle} {names} aka {aliases}' } };

/** A view whose labels render the directory and the author handles, with Zoé's stored profile (not in the moment). */
function handlesView(features = {}) {
  const hot = fakeHot(features);
  hot.prompts.labels = DIRECTORY_LABELS;
  const store = fakeStore({ userProfiles: { [ZOE_ID]: { id: ZOE_ID, names: ['Zoé'], aliases: [{ name: 'Zo', weight: 3 }] }, [SELF_ID]: { id: SELF_ID, names: ['Zoë'], aliases: [] } } });
  return liveView({ hot, store, guildId: 'g1' });
}

test('answerReply: the replay shows the live turn\'s <directory> and author handles, and resolves @handle as a live turn would', async () => {
  const view = handlesView();
  const zoe = `@${handleOf(ZOE_ID)}`;
  const alice = `@${handleOf(ALICE)}`;
  const unknown = [zoe, alice].includes('@uzzzz') ? '@u0000' : '@uzzzz';
  const llm = fakeLlm(`<msg>${zoe} ${alice} @Alice ${unknown}</msg><msg>ναι</msg>`);
  const result = await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 1, at: NOW });

  const live = buildRequest(sandboxRequestInput({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, at: NOW }));
  const directory = /<directory>\n[\s\S]*?\n<\/directory>/.exec(result.request.user)?.[0];
  assert.equal(directory, `<directory>\nDIRECTORY\n${zoe} "Zoé" aka "Zo"\n</directory>`, 'the persona\'s own profile is never listed');
  assert.ok(live.messages[1].content.find((part) => part.cacheSegment === 'stable').text.includes(directory));
  assert.ok(result.request.user.includes(`Alice [${alice}]: what do you think about chess?`), result.request.user);
  assert.ok(result.request.user.includes(`Bruno [@${handleOf(BRUNO)}]: καλημέρα`));
  assert.deepEqual(result.answers[0].messages, [
    { text: `${zoe} ${alice} @Alice ${unknown}`, replyTo: null, mentions: [ZOE_ID, ALICE], unknownHandles: 1 },
    { text: 'ναι', replyTo: null },
  ]);
});

test('answerReply: features.mentionHandles off -- no directory, no handles, nothing resolved', async () => {
  const view = handlesView({ mentionHandles: false });
  const llm = fakeLlm(`<msg>@${handleOf(ZOE_ID)}</msg>`);
  const result = await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 1, at: NOW });
  assert.equal(result.request.user.includes('<directory>'), false);
  assert.ok(result.request.user.includes('Alice: what do you think about chess?'));
  assert.deepEqual(result.answers[0].messages, [{ text: `@${handleOf(ZOE_ID)}`, replyTo: null }]);
});

test('answerSkillScenario: a message.create body is resolved like a <msg> (callMentions); the answers carry their mentions', async () => {
  const { answerSkillScenario } = sandbox;
  const view = handlesView();
  const zoe = `@${handleOf(ZOE_ID)}`;
  const llm = fakeLlm([`<msg>${zoe}</msg><call skill="message.create" channel="#general">${zoe} @Zo</call>`, '<msg>ok</msg>']);
  const result = await answerSkillScenario({
    view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, runs: 2, at: NOW,
    onCall: () => ({ verdict: { stage: 'gateway', ok: true }, executed: null, result: { skill: 'message.create', status: 'ok' }, followUp: false }),
  });
  const [first, second] = result.runs;
  assert.deepEqual(first.callMentions, { mentions: [ZOE_ID], unknownHandles: 0 });
  assert.deepEqual(first.answer.messages[0].mentions, [ZOE_ID]);
  assert.equal('callMentions' in second, false, 'a run without a call has none');
});

test('answerSkillScenario: a message text given in a text= attribute is resolved like a body (callMentions)', async () => {
  const { answerSkillScenario } = sandbox;
  const view = handlesView();
  const zoe = `@${handleOf(ZOE_ID)}`;
  const llm = fakeLlm([
    `<call skill="message.create" channel="#general" text="${zoe} @Zo"/>`,
    `<call skill="message.edit" message="#1" text="${zoe}"></call>`,
    `<call skill="rule.add" text="${zoe}"/>`,
  ]);
  const result = await answerSkillScenario({
    view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, runs: 3, at: NOW,
    onCall: () => ({ verdict: { stage: 'gateway', ok: true }, executed: null, result: { skill: 'message.create', status: 'ok' }, followUp: false }),
  });
  const [create, edit, other] = result.runs;
  assert.deepEqual(create.callMentions, { mentions: [ZOE_ID], unknownHandles: 0 });
  assert.deepEqual(edit.callMentions, { mentions: [ZOE_ID], unknownHandles: 0 });
  assert.equal('callMentions' in other, false, 'only a message\'s text is rendered as a post');
});
