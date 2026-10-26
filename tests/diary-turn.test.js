// Tests for the diary turn of src/behavior/turn.js (mode `diary`): the plan
// request on the classifier model, the search it asks for, the compose request
// with the character card, the output rules of a diary post (no reactions, no
// GIF, no reply, no links, a message cap), the picture caps, the record in
// diary.json and the daily counters. Fake discord.js-shaped channel, fake LLM,
// fake store, fake image client and lookup; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { chunkPictures, createTurnRunner } from '../src/behavior/turn.js';
import { DIARY_DAILY, DIARY_PICTURES_DAILY } from '../src/behavior/diary.js';
import { ImageCapError, ImageGenError } from '../src/llm/images.js';
import { DailyCapError } from '../src/llm/openrouter.js';
import { fill, formatNow } from '../src/format.js';
import { countToday, utcDay } from '../src/time.js';
import { userText } from '../src/behavior/prompt.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { call, completionOf, toolAnswer } from './fixtures/tool-answers.js';
import { contentText } from './fixtures/turn-harness.js';
import { createFakeAdapter } from '../src/interface/fake.js';
import '../src/ops/index.js';
import { createDiscordAdapter, createDiscordInterface } from '../interfaces/discord/index.js';

// The Discord interface's capabilities object, as src/index.js injects it.
const DISCORD = createDiscordInterface().capabilities;

const NOW = Date.UTC(2026, 9, 6, 19, 30, 0);
const DAY = 24 * 60 * 60 * 1000;
const TZ = 'Europe/Athens';

/** A diary channel the persona owns: every permission, Attach Files only when `attachFiles`. */
function diaryChannel({ attachFiles = true, historyMessages = [] } = {}) {
  const sent = [];
  const reactCalls = [];
  return {
    id: 'd1',
    name: 'journal',
    guild: { id: 'g1', members: { me: { displayName: 'Bot' } }, channels: { cache: new Map() } },
    viewable: true,
    permissionsFor: () => ({ has: (flag) => attachFiles || flag !== PermissionFlagsBits.AttachFiles }),
    sendTyping: async () => {},
    send: async (payload) => {
      sent.push(payload);
      return { id: `sent-${sent.length}` };
    },
    messages: {
      cache: new Map(),
      fetch: async (arg) => {
        if (arg && typeof arg === 'object' && 'limit' in arg) return new Map(historyMessages.map((m) => [m.id, m]));
        return { react: async (emoji) => reactCalls.push({ id: arg, emoji }) };
      },
    },
    sent,
    reactCalls,
  };
}

/** The persona's own earlier post as discord.js hands it over. */
function ownRaw(id, ts, content) {
  return {
    id,
    channelId: 'd1',
    author: { id: 'self-id', bot: true, globalName: 'Bot', username: 'Bot' },
    member: { displayName: 'Bot' },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

/** An LLM that answers the plan request with `plan` (an object, or raw text), then the post with `post` (a list: one answer per request, the last repeated). */
function fakeLlm(plan, post) {
  const calls = [];
  const options = [];
  let composed = 0;
  return {
    calls,
    options,
    complete: async (messages, opts) => {
      calls.push(messages);
      options.push(opts);
      if (opts?.purpose === 'diary-plan') {
        if (plan instanceof Error) throw plan;
        return { text: typeof plan === 'string' ? plan : JSON.stringify(plan), usage: {}, estimated: 5 };
      }
      const answer = Array.isArray(post) ? post[Math.min(composed, post.length - 1)] : post;
      composed += 1;
      return completionOf(answer);
    },
  };
}

/** Her draw.create calls (`n` of them; the first with self when `self`), as one answer with `text` ahead of them. */
const withDraws = (text, n, self = false) => drawAnswer(text, n, self);
const drawAnswer = (text, n = 1, self = false) =>
  toolAnswer(
    text,
    Array.from({ length: n }, (_, i) =>
      call('draw.create', {
        text: n === 1 ? 'a pier at night' : `scene ${i + 1}`,
        ...(self && i === 0 ? { self: true } : {}),
      })
    )
  );
/** The `skills: called` lines of a run, as `skill:status/code`. */
const calledOf = (logs) =>
  logs
    .filter((entry) => entry.msg === 'skills: called')
    .map((entry) => `${entry.skill}:${entry.status}${entry.code ? `/${entry.code}` : ''}`);

function fakeStore({ posts = [], data = {} } = {}) {
  const appended = [];
  return {
    appended,
    getGuild: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    getMediaCache: () => ({}),
    getDiary: () => ({ posts, updatedAt: 0 }),
    appendDiaryPost: (guildId, post, opts) => appended.push({ guildId, post, opts }),
    state: { data: { ...data }, markDirty() {} },
  };
}

function fakeImages({ used = 0, cap = 10, fail = null } = {}) {
  const prompts = [];
  return {
    prompts,
    quota: () => ({ used, cap, userUsed: 0, userCap: 5, spent: used >= cap, userSpent: false }),
    generate: async ({ prompt }) => {
      prompts.push(prompt);
      if (fail) throw fail;
      return { buffer: Buffer.from('png'), mediaType: 'image/png', seconds: 1, cost: 0 };
    },
  };
}

function fakeLookup(result) {
  const calls = [];
  return {
    calls,
    search: async (guildId, query) => {
      calls.push({ guildId, query });
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const SWITCHES_ON = {
  memory: true,
  reactions: true,
  multiMessage: true,
  typingSimulation: true,
  customEmoji: true,
  gifs: true,
  imageGeneration: true,
  channelPull: true,
  recent: true,
  vision: true,
  diary: true,
};

function fakeHot({ features = {}, diary = {}, prompts = {} } = {}) {
  return {
    config: {
      bot: { timezone: TZ, dryRunChannelId: '' },
      context: {
        channelMessages: 50,
        neighborMessages: 5,
        neighborMaxAgeMinutes: 60,
        neighborMaxChannels: 8,
        maxMessageChars: 800,
        gapMarkerMinutes: 20,
        otherProfiles: 6,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: {
          maxImages: 2,
          tokensPerImage: 400,
          imageSize: 512,
          recentImages: 0,
          recentImageMinutes: 0,
          maxBytes: 1_500_000,
          fetchTimeoutMs: 10_000,
        },
        pull: { scanMessages: 20, maxChannels: 1, sameAudience: true },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [0, 0], minMs: 0, maxMs: 0, betweenMessagesMs: [0, 0] },
      features: { ...SWITCHES_ON, ...features },
      media: { maxPerTurn: 6, filePreviewChars: 500 },
      gifs: { maxPerDay: 40 },
      image: { maxPromptChars: 1000 },
      diary: {
        channelId: 'd1',
        world: false,
        maxPicturesPerDay: 2,
        maxMessages: 2,
        historyPosts: 40,
        gistChars: 60,
        seedSets: 1,
        kinds: { selfPicture: 2, status: 1, news: 1 },
        searchKinds: ['news'],
        pictureKinds: ['selfPicture'],
        planMaxOutputTokens: 250,
        planTimeoutMs: 15000,
        ...diary,
      },
    },
    prompts: {
      'system-prompt': 'SYSTEM for {{name}}',
      'character-card': 'CARD_TEXT',
      format: 'FORMAT_TEXT',
      diary: 'DIARY_TASK for {{name}}',
      'diary-plan': 'PLAN_SYSTEM for {{name}}',
      'diary-seeds': '# place\na pier\n# light\nfog',
      world: 'WORLD of {{name}}',
      draw: 'DRAW for {{name}}\n{{when}}\n{{request}}',
      labels,
      ...prompts,
    },
  };
}

function client() {
  return {
    user: { id: 'self-id', username: 'Bot' },
    channels: { cache: new Map([['d1', { id: 'd1', name: 'journal' }]]) },
  };
}

function runner({ hot = fakeHot(), store = fakeStore(), llm, images = fakeImages(), lookup = null } = {}) {
  return createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store,
    llm,
    calibrator: { ratio: 1, apply: (n) => n, observe: () => {} },
    client: client(),
    images,
    lookup,
    rng: () => 0.5,
    now: () => NOW,
  });
}

// The whole user text, every cache part: the stable part always carries the static senses lines.
const userOf = (messages) => userText(messages[1].content);

test('diary turn: plans on the analyzer model, then composes with the card', async () => {
  const posts = [
    { at: NOW - DAY, kind: 'status', gist: 'une journée grise', picture: null, messageIds: ['m0'], search: null },
  ];
  const llm = fakeLlm({ kind: 'status', brief: 'tired of rain', search: '', picture: false }, '<msg>ennui</msg>');
  const hot = fakeHot({ diary: { world: true } });
  const turns = runner({ hot, store: fakeStore({ posts }), llm });

  const result = await turns.runTurn({ channel: diaryChannel(), mode: 'diary', diary: { kind: null, forced: false } });

  assert.equal(result.outcome, 'spoke');
  assert.equal(llm.calls.length, 2);
  const [plan, compose] = llm.calls;
  assert.equal(plan[0].content, 'PLAN_SYSTEM for Bot');
  const planUser = userOf(plan);
  for (const tag of ['now', 'world', 'diary', 'kinds', 'seeds'])
    assert.ok(planUser.includes(`<${tag}>`), `plan request: <${tag}>`);
  assert.ok(planUser.includes('WORLD of Bot'));
  assert.ok(planUser.includes('- a pier; fog'), 'one seed line per family');
  assert.equal(llm.options[0].role, 'analyzer');
  assert.equal(llm.options[0].purpose, 'diary-plan');
  assert.equal(llm.options[0].maxOutputTokens, 250);
  assert.equal(llm.options[0].timeoutMs, 15000);
  assert.equal(llm.options[0].countAgainstDailyCap, true);

  assert.ok(compose[0].content.includes('CARD_TEXT'), 'the post is composed with the card');
  const composeUser = userOf(compose);
  assert.ok(composeUser.includes('<world>\nWORLD of Bot\n</world>'));
  assert.ok(
    composeUser.includes(
      `<plan>\n${labels.diary.plan}\n${JSON.stringify({ kind: 'status', brief: 'tired of rain', picture: false })}\n</plan>`
    )
  );
  assert.ok(composeUser.includes('une journée grise'));
  assert.ok(composeUser.includes('<task>\nDIARY_TASK for Bot\n</task>'));
  assert.ok(composeUser.includes(fill(labels.senses.diary, { channel: 'journal' })), 'the senses name the diary');
});

test('diary turn: a hedged plan request is limited by diary.planTimeoutMs, an unhedged one carries no hedge', async () => {
  const hedged = fakeHot({ diary: { planTimeoutMs: 120000 } });
  hedged.config.llm.hedge = { roles: ['analyzer'], afterMs: 2500, timeoutMs: 8000, longTimeoutMs: 20000 };
  const llmHedged = fakeLlm({ kind: 'status', brief: 'b', search: '', picture: false }, '<msg>x</msg>');
  await runner({ hot: hedged, llm: llmHedged }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} });
  assert.equal(llmHedged.options[0].purpose, 'diary-plan');
  assert.deepEqual(llmHedged.options[0].hedge, { afterMs: 2500, timeoutMs: 120000 });

  const unhedged = fakeHot({ diary: { planTimeoutMs: 120000 } });
  unhedged.config.llm.hedge = { roles: [], afterMs: 2500, timeoutMs: 8000, longTimeoutMs: 20000 };
  const llmPlain = fakeLlm({ kind: 'status', brief: 'b', search: '', picture: false }, '<msg>x</msg>');
  await runner({ hot: unhedged, llm: llmPlain }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} });
  assert.equal(llmPlain.options[0].purpose, 'diary-plan');
  assert.equal('hedge' in llmPlain.options[0], false);
});

test('diary turn: a broken plan answer falls back to a weighted kind', async () => {
  const llm = fakeLlm('not json at all', '<msg>ennui</msg>');
  const store = fakeStore();
  const { logs } = await withCapturedLogs(() =>
    runner({ llm, store }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} })
  );
  assert.ok(logs.some((l) => l.msg === 'diary: plan failed' && l.reason === 'unparsed'));
  assert.ok(Object.keys(fakeHot().config.diary.kinds).includes(store.appended[0].post.kind));
});

test('diary turn: a request cap on the plan refuses the turn', async () => {
  const llm = fakeLlm(new DailyCapError('daily cap'), '<msg>x</msg>');
  const channel = diaryChannel();
  const result = await runner({ llm }).runTurn({ channel, mode: 'diary', diary: {} });
  assert.equal(result.outcome, 'refused');
  assert.equal(llm.calls.length, 1);
  assert.equal(channel.sent.length, 0);
});

test("diary turn: a forced kind skips the planner's choice", async () => {
  const llm = fakeLlm({ kind: 'status', brief: 'a pier in the fog', search: '', picture: false }, '<msg>brume</msg>');
  const store = fakeStore();
  await runner({ llm, store }).runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: { kind: 'selfPicture', forced: true },
  });
  const planUser = userOf(llm.calls[0]);
  assert.ok(planUser.includes(fill(labels.diary.kindLine, { key: 'selfPicture', weight: 1, count: 0, window: 0 })));
  assert.ok(
    !planUser.includes(fill(labels.diary.kindLine, { key: 'status', weight: 1, count: 0, window: 0 })),
    'the only kind offered'
  );
  assert.ok(
    userOf(llm.calls[1]).includes(JSON.stringify({ kind: 'selfPicture', brief: 'a pier in the fog', picture: true })),
    'the brief is kept'
  );
  assert.equal(store.appended[0].post.kind, 'selfPicture');
});

test('diary turn: a topic becomes a <topic> block in the plan request and a field of <plan>', async () => {
  const llm = fakeLlm({ kind: 'status', brief: 'harbour at dusk', search: '', picture: false }, '<msg>brume</msg>');
  await runner({ llm }).runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: { kind: null, topic: '  le vieux  port\n ', forced: true },
  });
  const planUser = userOf(llm.calls[0]);
  const topicBlock = `<topic>\n${labels.diary.topic}\nle vieux port\n</topic>`;
  assert.ok(planUser.includes(topicBlock), 'the plan request carries the topic block');
  assert.ok(planUser.indexOf('<seeds>') < planUser.indexOf('<topic>'), 'the topic follows the seeds');
  assert.ok(planUser.trimEnd().endsWith('</topic>'), 'the topic is the last block');
  const composeUser = userOf(llm.calls[1]);
  assert.ok(
    composeUser.includes(
      `<plan>\n${labels.diary.plan}\n${JSON.stringify({ kind: 'status', brief: 'harbour at dusk', picture: false, topic: 'le vieux port' })}\n</plan>`
    ),
    'the plan carries the topic'
  );
});

test('diary turn: no topic leaves the requests unchanged', async () => {
  const answer = { kind: 'status', brief: 'harbour at dusk', search: '', picture: false };
  const plain = fakeLlm(answer, '<msg>brume</msg>');
  await runner({ llm: plain }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: { kind: null, forced: true } });
  for (const topic of [undefined, null, '', '   ']) {
    const llm = fakeLlm(answer, '<msg>brume</msg>');
    await runner({ llm }).runTurn({
      channel: diaryChannel(),
      mode: 'diary',
      diary: { kind: null, topic, forced: true },
    });
    assert.deepEqual(llm.calls, plain.calls, `topic ${JSON.stringify(topic)}: byte-identical requests`);
  }
  assert.ok(!userOf(plain.calls[0]).includes('<topic>'));
  assert.ok(!userOf(plain.calls[1]).includes('"topic"'));
});

test('diary turn: searches when the plan asks and passes the summary as found', async () => {
  const llm = fakeLlm(
    { kind: 'news', brief: 'a comet', search: 'comet tonight', picture: false },
    '<msg>une comète</msg>'
  );
  const lookup = fakeLookup({ query: 'comet tonight', text: 'A comet is visible tonight.', sources: [] });
  const store = fakeStore();
  const result = await runner({ llm, lookup, store }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} });
  assert.deepEqual(lookup.calls, [{ guildId: 'g1', query: 'comet tonight' }]);
  assert.ok(userOf(llm.calls[1]).includes(`<found>\n${labels.diary.found}\nA comet is visible tonight.\n</found>`));
  assert.equal(store.appended[0].post.search, 'comet tonight');
  assert.equal(result.diary.search, true);
});

test('diary turn: a failed search posts without a find and logs it', async () => {
  for (const outcome of [null, new Error('boom')]) {
    const llm = fakeLlm(
      { kind: 'news', brief: 'a comet', search: 'comet tonight', picture: false },
      '<msg>une comète</msg>'
    );
    const { logs } = await withCapturedLogs(() =>
      runner({ llm, lookup: fakeLookup(outcome) }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} })
    );
    assert.ok(!userOf(llm.calls[1]).includes('<found>'));
    assert.ok(
      logs.some((l) => l.msg === 'diary: search failed'),
      String(outcome)
    );
  }
});

test('diary turn: search is not asked for a kind outside searchKinds', async () => {
  const llm = fakeLlm({ kind: 'status', brief: 'x', search: 'comet tonight', picture: false }, '<msg>x</msg>');
  const lookup = fakeLookup({ text: 'found' });
  await runner({ llm, lookup }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} });
  assert.equal(lookup.calls.length, 0);
});

test('diary turn: a picture kind draws even when the planner said no picture', async () => {
  const llm = fakeLlm(
    { kind: 'selfPicture', brief: 'a pier', search: '', picture: false },
    drawAnswer('<msg>brume</msg>', 1, true)
  );
  const images = fakeImages();
  const store = fakeStore();
  const result = await runner({ llm, store, images }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} });
  const compose = userOf(llm.calls[1]);
  assert.ok(
    compose.includes(JSON.stringify({ kind: 'selfPicture', brief: 'a pier', picture: true })),
    'the plan says picture'
  );
  assert.equal(images.prompts.length, 1, 'the picture is drawn');
  assert.equal(result.diary.picture, true);
  assert.equal(countToday(store.state.data, DIARY_PICTURES_DAILY, NOW), 1);
});

test('diary turn: picture forced off when diary.maxPicturesPerDay is spent', async () => {
  const spentDiary = fakeStore({
    data: { [DIARY_PICTURES_DAILY.dayKey]: utcDay(NOW), [DIARY_PICTURES_DAILY.countKey]: 2 },
  });
  const cases = [
    { name: 'diary cap', store: spentDiary, images: fakeImages() },
    { name: 'image cap', store: fakeStore(), images: fakeImages({ used: 10, cap: 10 }) },
  ];
  for (const { name, store, images } of cases) {
    const llm = fakeLlm({ kind: 'status', brief: 'a pier', search: '', picture: true }, [
      drawAnswer('<msg>brume</msg>', 1, true),
      '<msg>sans image</msg>',
    ]);
    const channel = diaryChannel();
    const { result, logs } = await withCapturedLogs(() =>
      runner({ llm, store, images }).runTurn({ channel, mode: 'diary', diary: {} })
    );
    const compose = userOf(llm.calls[1]);
    assert.ok(
      compose.includes(JSON.stringify({ kind: 'status', brief: 'a pier', picture: false })),
      `${name}: the plan says no picture`
    );
    assert.ok(
      !compose.includes(labels.senses.draw) && !compose.includes(labels.senses.drawSpent),
      `${name}: no drawing line in the senses`
    );
    assert.equal(images.prompts.length, 0, `${name}: nothing drawn`);
    assert.deepEqual(calledOf(logs), ['draw.create:denied/daily-cap'], `${name}: the picture is refused with the cap`);
    assert.equal(llm.calls.length, 3, `${name}: she reads the result and posts the text in step 2`);
    assert.deepEqual(
      channel.sent.map((payload) => payload.content),
      ['sans image'],
      `${name}: only the text post`
    );
    assert.equal(result.diary.picture, false);
  }
});

/** The `<kinds>` line of `key` with `weight` and no history. */
const kindLine = (key, weight) => fill(labels.diary.kindLine, { key, weight, count: 0, window: 0 });

test('diary turn: with pictures off only text kinds are offered and the fallback picks one', async () => {
  const spentDiary = () =>
    fakeStore({ data: { [DIARY_PICTURES_DAILY.dayKey]: utcDay(NOW), [DIARY_PICTURES_DAILY.countKey]: 2 } });
  const cases = [
    { name: 'diary cap', store: spentDiary(), images: fakeImages(), channel: diaryChannel() },
    { name: 'image cap', store: fakeStore(), images: fakeImages({ used: 10, cap: 10 }), channel: diaryChannel() },
    { name: 'no image client', store: fakeStore(), images: null, channel: diaryChannel() },
  ];
  for (const { name, store, images, channel } of cases) {
    for (const answer of ['not json at all', { kind: 'selfPicture', brief: 'a pier', search: '', picture: true }]) {
      const llm = fakeLlm(answer, '<msg>brume</msg>');
      const { logs } = await withCapturedLogs(() =>
        runner({ llm, store, images }).runTurn({ channel, mode: 'diary', diary: {} })
      );
      const planUser = userOf(llm.calls[0]);
      assert.ok(!planUser.includes(kindLine('selfPicture', 2)), `${name}: no picture kind offered`);
      assert.ok(
        planUser.includes(kindLine('status', 1)) && planUser.includes(kindLine('news', 1)),
        `${name}: the text kinds offered`
      );
      const planned = logs.find((l) => l.msg === 'diary: planned');
      assert.ok(['status', 'news'].includes(planned.kind), `${name}: the fallback is a text kind`);
      assert.equal(planned.fallback, true);
      assert.equal(planned.picture, false);
      assert.equal(planned.picturesOff, true, `${name}: the log says why`);
    }
    assert.ok(
      store.appended.every(({ post }) => post.kind !== 'selfPicture'),
      `${name}: no picture kind recorded`
    );
  }
});

test('diary turn: with pictures allowed the picture kinds are offered as before', async () => {
  const llm = fakeLlm({ kind: 'status', brief: 'x', search: '', picture: false }, '<msg>brume</msg>');
  const { logs } = await withCapturedLogs(() =>
    runner({ llm }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} })
  );
  const planUser = userOf(llm.calls[0]);
  for (const [key, weight] of [
    ['selfPicture', 2],
    ['status', 1],
    ['news', 1],
  ])
    assert.ok(planUser.includes(kindLine(key, weight)), key);
  assert.equal(logs.find((l) => l.msg === 'diary: planned').picturesOff, undefined);
});

test('diary turn: a forced picture kind with pictures off is refused before any request', async () => {
  const spentDiary = fakeStore({
    data: { [DIARY_PICTURES_DAILY.dayKey]: utcDay(NOW), [DIARY_PICTURES_DAILY.countKey]: 2 },
  });
  const cases = [
    {
      name: 'diary cap',
      store: spentDiary,
      images: fakeImages(),
      channel: diaryChannel(),
      limit: { key: 'diary.maxPicturesPerDay', used: 2, cap: 2 },
    },
    {
      name: 'image cap',
      store: fakeStore(),
      images: fakeImages({ used: 10, cap: 10 }),
      channel: diaryChannel(),
      limit: { key: 'image.maxPerDay', used: 10, cap: 10 },
    },
    { name: 'no image client', store: fakeStore(), images: null, channel: diaryChannel(), limit: null },
    {
      name: 'no attach files',
      store: fakeStore(),
      images: fakeImages(),
      channel: diaryChannel({ attachFiles: false }),
      limit: null,
    },
    {
      name: 'drawing off',
      store: fakeStore(),
      images: fakeImages(),
      channel: diaryChannel(),
      limit: null,
      features: { imageGeneration: false },
    },
  ];
  for (const { name, store, images, channel, limit, features } of cases) {
    const llm = fakeLlm({ kind: 'selfPicture', brief: 'x', search: '', picture: true }, '<msg>brume</msg>');
    const hot = fakeHot({ features });
    const result = await runner({ hot, llm, store, images }).runTurn({
      channel,
      mode: 'diary',
      diary: { kind: 'selfPicture', forced: true },
    });
    assert.deepEqual(result, { outcome: 'refused', reason: 'pictures', limit }, name);
    assert.equal(llm.calls.length, 0, `${name}: no request`);
    assert.equal(channel.sent.length, 0);
    assert.equal(store.appended.length, 0);
  }
});

test('diary turn: a forced text kind still posts with pictures off', async () => {
  const store = fakeStore({ data: { [DIARY_PICTURES_DAILY.dayKey]: utcDay(NOW), [DIARY_PICTURES_DAILY.countKey]: 2 } });
  const llm = fakeLlm({ kind: 'status', brief: 'x', search: '', picture: false }, '<msg>brume</msg>');
  const result = await runner({ llm, store }).runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: { kind: 'status', forced: true },
  });
  assert.equal(result.outcome, 'spoke');
  assert.equal(store.appended[0].post.kind, 'status');
});

test('diary turn: reactions and gifs are dropped, reply attributes ignored, urls stripped', async () => {
  const history = [ownRaw('m1', NOW - DAY, 'hier')];
  const llm = fakeLlm(
    { kind: 'status', brief: 'x', search: '', picture: false },
    '<react to="#1">👍</react><msg reply="#1">see https://example.org/a now</msg><msg>https://example.org/b</msg><msg>deux</msg><msg>trois</msg><gif>g1</gif>'
  );
  const channel = diaryChannel({ historyMessages: history });
  const result = await runner({ llm }).runTurn({ channel, mode: 'diary', diary: {} });
  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(
    channel.sent.map((payload) => payload.content),
    ['see now', 'deux\ntrois'],
    'links removed, a message left empty dropped, the fourth joined into the third by the parser'
  );
  assert.ok(
    channel.sent.every((payload) => payload.reply === undefined),
    'nothing posted as a reply'
  );
  assert.equal(channel.reactCalls.length, 0);
  assert.equal(result.diary.messages, 2);
});

test('diary turn: a skip posts nothing and records nothing', async () => {
  const llm = fakeLlm({ kind: 'status', brief: 'x', search: '', picture: false }, '<skip/>');
  const store = fakeStore();
  const channel = diaryChannel();
  const result = await runner({ llm, store }).runTurn({ channel, mode: 'diary', diary: {} });
  assert.equal(result.outcome, 'skip');
  assert.equal(channel.sent.length, 0);
  assert.equal(store.appended.length, 0);
  assert.equal(countToday(store.state.data, DIARY_DAILY, NOW), 0);
});

test('diary turn: records the post with gists and message ids', async () => {
  const llm = fakeLlm(
    { kind: 'selfPicture', brief: 'a pier', search: '', picture: true },
    toolAnswer('<msg>un quai dans la brume, très calme ce soir</msg>', [
      call('draw.create', { text: 'the persona on a foggy pier at night, lanterns', self: true }),
    ])
  );
  const store = fakeStore();
  const result = await runner({ llm, store }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} });
  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(result.diary, { kind: 'selfPicture', picture: true, search: false, messages: 1, pictures: 1 });
  assert.equal(store.appended.length, 1);
  const { guildId, post, opts } = store.appended[0];
  assert.equal(guildId, 'g1');
  assert.deepEqual(post, {
    at: NOW,
    kind: 'selfPicture',
    gist: 'un quai dans la brume, très calme ce soir',
    picture: 'the persona on a foggy pier at night, lanterns',
    messageIds: ['sent-1', 'sent-2'],
    search: null,
  });
  assert.deepEqual(opts, { max: 40 });
  assert.equal(countToday(store.state.data, DIARY_DAILY, NOW), 1);
  assert.equal(countToday(store.state.data, DIARY_PICTURES_DAILY, NOW), 1);
});

test('diary turn: a voice message is kept in the post: its id among messageIds and a voice field with the text as voiced', async () => {
  const llm = fakeLlm(
    { kind: 'status', brief: 'a quiet evening', search: '', picture: false },
    toolAnswer('<msg>soir calme</msg>', [call('voice.say', { text: '[tired] soir calme' })])
  );
  const store = fakeStore();
  const voiced = '[sighs] soir calme';
  const runOwnOp = async (op) => ({
    status: 'ok',
    code: 'ok',
    summary: 'voice message posted',
    data: {
      text: 'voice message posted',
      ref: { conversationId: 'd1', messageId: 'voice-1' },
      voice: { text: voiced, durationSecs: 2.5 },
    },
  });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot({ features: { speech: true } }),
    store,
    llm,
    calibrator: { ratio: 1, apply: (n) => n, observe: () => {} },
    client: client(),
    images: fakeImages(),
    speech: { quota: () => ({ used: 0, cap: 10, spent: false }) },
    runOwnOp,
    rng: () => 0.5,
    now: () => NOW,
  });
  const result = await turns.runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} });
  assert.equal(result.outcome, 'spoke');
  const { post } = store.appended[0];
  assert.ok(post.messageIds.includes('voice-1'), JSON.stringify(post.messageIds));
  assert.deepEqual(post.voice, { messageId: 'voice-1', text: voiced, durationSec: 2.5 });
});

test('diary turn: the gist is cut to diary.gistChars', async () => {
  const long = 'mot '.repeat(40).trim();
  const llm = fakeLlm({ kind: 'status', brief: 'x', search: '', picture: false }, `<msg>${long}</msg>`);
  const store = fakeStore();
  await runner({ llm, store }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} });
  assert.ok(store.appended[0].post.gist.length <= 60);
  assert.equal(countToday(store.state.data, DIARY_PICTURES_DAILY, NOW), 0, 'no picture, no picture count');
});

test('diary turn: a failed drawing is a result she reads before anything is posted; the post goes out without the picture', async () => {
  const llm = fakeLlm({ kind: 'selfPicture', brief: 'a pier', search: '', picture: true }, [
    drawAnswer('<msg>brume</msg>'),
    '<msg>brume sans image</msg>',
  ]);
  const store = fakeStore();
  const images = fakeImages({ fail: new ImageGenError('error') });
  const channel = diaryChannel();
  const { result, logs } = await withCapturedLogs(() =>
    runner({ llm, store, images }).runTurn({ channel, mode: 'diary', diary: {} })
  );
  assert.equal(result.outcome, 'spoke');
  assert.equal(result.drawFailed, undefined);
  assert.equal(llm.calls.length, 3, 'the plan, the post with the draw, the post after the result');
  assert.deepEqual(calledOf(logs), ['draw.create:failed/image-error']);
  assert.ok(logs.some((l) => l.msg === 'turn: speech held'));
  assert.deepEqual(
    channel.sent.map((payload) => payload.content),
    ['brume sans image'],
    'the first speech was held and never posted'
  );
  assert.equal(store.appended[0].post.picture, null);
  assert.equal(countToday(store.state.data, DIARY_PICTURES_DAILY, NOW), 0);
});

test('diary turn: the drawing prompt carries the local time', async () => {
  const llm = fakeLlm({ kind: 'selfPicture', brief: 'a pier', search: '', picture: true }, drawAnswer(''));
  const images = fakeImages();
  await runner({ llm, images }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} });
  assert.equal(images.prompts.length, 1);
  assert.ok(
    images.prompts[0].includes(fill(labels.draw.when, { when: formatNow(NOW, TZ, labels.locale) })),
    images.prompts[0]
  );
});

test("diary turn: an ordinary turn's draw.create carries the local time too", async () => {
  const hot = fakeHot();
  hot.prompts.reply = 'REPLY for {{author}}';
  const llm = fakeLlm(null, toolAnswer('', [call('draw.create', { text: 'a pier' })]));
  const images = fakeImages();
  const raw = ownRaw('m1', NOW - 60_000, 'draw a pier');
  raw.author = { id: 'u1', bot: false, globalName: 'Alice', username: 'Alice' };
  raw.member = { displayName: 'Alice' };
  const channel = diaryChannel({ historyMessages: [raw] });
  // Someone asked: a spontaneous turn has no requester, and the gateway refuses a picture nobody asked for.
  const trigger = {
    id: 'm1',
    channelId: 'd1',
    authorId: 'u1',
    authorName: 'Alice',
    self: false,
    bot: false,
    content: 'draw a pier',
    ts: NOW - 60_000,
    replyToId: null,
    attachments: [],
    stickers: [],
  };
  await runner({ hot, llm, images }).runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });
  assert.ok(images.prompts[0].includes(fill(labels.draw.when, { when: formatNow(NOW, TZ, labels.locale) })));
});

test('diary turn: dry-run mirrors the post and records nothing', async () => {
  const hot = fakeHot({ features: { dryRun: true } });
  const llm = fakeLlm({ kind: 'status', brief: 'x', search: '', picture: false }, '<msg>ennui</msg>');
  const store = fakeStore();
  const channel = diaryChannel();
  const { result, logs } = await withCapturedLogs(() =>
    runner({ hot, llm, store }).runTurn({ channel, mode: 'diary', diary: {} })
  );
  assert.equal(result.outcome, 'spoke');
  assert.equal(result.dryRun, true);
  assert.equal(channel.sent.length, 0);
  assert.equal(store.appended.length, 0);
  assert.equal(countToday(store.state.data, DIARY_DAILY, NOW), 0);
  assert.ok(logs.some((l) => l.msg === 'dry-run: would send'));
});

test('diary turn: a post of a picture alone is a spoken turn', async () => {
  const llm = fakeLlm({ kind: 'selfPicture', brief: 'a pier', search: '', picture: true }, drawAnswer('', 1, true));
  const store = fakeStore();
  const channel = diaryChannel();
  const result = await runner({ llm, store }).runTurn({ channel, mode: 'diary', diary: {} });
  assert.equal(result.outcome, 'spoke');
  assert.equal(result.delivered, true);
  assert.equal(channel.sent.length, 1);
  assert.ok(Array.isArray(channel.sent[0].files));
  assert.equal(store.appended[0].post.gist, '');
  assert.deepEqual(store.appended[0].post.messageIds, ['sent-1']);
  assert.equal(countToday(store.state.data, DIARY_DAILY, NOW), 1);
  assert.equal(countToday(store.state.data, DIARY_PICTURES_DAILY, NOW), 1);
});

// ---- set posts (diary.setKinds): several pictures, generated before anything is sent ----------

/** An image client that answers each generate call by the next step: a byte count, or an error to throw. */
function fakeSetImages(steps, events = []) {
  const prompts = [];
  let call = 0;
  return {
    prompts,
    events,
    quota: () => ({ used: 0, cap: 50, userUsed: 0, userCap: 5, spent: false, userSpent: false }),
    generate: async ({ prompt, userId }) => {
      prompts.push({ prompt, userId });
      const step = steps[call] ?? 10;
      call += 1;
      events.push(`generate ${call}`);
      if (step instanceof Error) throw step;
      return { buffer: Buffer.alloc(step, 1), mediaType: 'image/png', seconds: 1, cost: 0 };
    },
  };
}

/** A hot config where `tour` is the one set kind, with its own set settings. */
function setHot({ set = {}, features = {}, diary = {} } = {}) {
  return fakeHot({
    features,
    diary: {
      kinds: { tour: 1, status: 1 },
      pictureKinds: ['tour'],
      setKinds: ['tour'],
      maxPicturesPerDay: 30,
      seedSets: 1,
      set: { pictures: [3, 5], minPosted: 2, seedSets: 3, maxMessageBytes: 1000, ...set },
      ...diary,
    },
  });
}

/** A diary channel whose sends are logged into `events` too. */
function eventChannel(events) {
  const channel = diaryChannel();
  const send = channel.send;
  channel.send = async (payload) => {
    events.push(payload.files ? `files ${payload.files.length}` : 'msg');
    return send(payload);
  };
  return channel;
}

const TOUR_PLAN = { kind: 'tour', brief: 'a harbour walk', search: '', picture: true };

test('diary: a single picture is staged while the post is composed, then posted after its messages', async () => {
  const events = [];
  const images = fakeSetImages([10], events);
  const store = fakeStore();
  const channel = eventChannel(events);
  const llm = fakeLlm(
    { kind: 'selfPicture', brief: 'a pier', search: '', picture: true },
    drawAnswer('<msg>un quai</msg>', 1, true)
  );
  const { result, logs } = await withCapturedLogs(() =>
    runner({ llm, store, images }).runTurn({ channel, mode: 'diary', diary: {} })
  );
  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(events, ['generate 1', 'msg', 'files 1'], 'generated first, posted after the message');
  assert.deepEqual(calledOf(logs), ['draw.create:ok/staged']);
  assert.equal(llm.calls.length, 2, 'the plan and one post request');
  assert.equal(channel.sent.at(-1).files.length, 1);
  assert.deepEqual(result.diary, { kind: 'selfPicture', picture: true, search: false, messages: 1, pictures: 1 });
  assert.equal(store.appended[0].post.picture, 'a pier at night');
  assert.equal('pictures' in store.appended[0].post, false, 'a single-picture kind records no count');
  assert.equal(countToday(store.state.data, DIARY_PICTURES_DAILY, NOW), 1, 'counted when generated');
});

test('diary set: six draw.create calls in one answer are generated before anything is sent, then the messages, then the files, chunked by bytes', async () => {
  const events = [];
  const images = fakeSetImages([400, 400, 400, 900, 100, 50], events);
  const store = fakeStore();
  const channel = eventChannel(events);
  const llm = fakeLlm(TOUR_PLAN, withDraws('<msg>une promenade</msg><msg>au port</msg>', 6, true));
  const { result, logs } = await withCapturedLogs(() =>
    runner({ hot: setHot({ set: { pictures: [3, 6], maxMessageBytes: 1000 } }), llm, store, images }).runTurn({
      channel,
      mode: 'diary',
      diary: {},
    })
  );
  assert.equal(result.outcome, 'spoke');
  assert.equal(llm.calls.length, 2, 'one post request');
  assert.deepEqual(events, [
    'generate 1',
    'generate 2',
    'generate 3',
    'generate 4',
    'generate 5',
    'generate 6',
    'msg',
    'msg',
    'files 2',
    'files 1',
    'files 2',
    'files 1',
  ]);
  assert.ok(
    images.prompts.every(({ userId }) => userId === null),
    'nobody is charged'
  );
  assert.deepEqual(
    channel.sent.slice(2).map((payload) => payload.files.map((file) => file.attachment.length)),
    [[400, 400], [400], [900, 100], [50]]
  );
  assert.equal(channel.sent[2].content, undefined);
  assert.equal(channel.sent[2].reply, undefined);
  const drew = logs.filter((l) => l.msg === 'turn: drew');
  assert.equal(drew.length, 6);
  assert.ok(drew.every((l) => l.set === true));
  assert.equal(logs.find((l) => l.msg === 'turn: set posted').pictures, 6);
  assert.deepEqual(result.diary, { kind: 'tour', picture: true, search: false, messages: 2, pictures: 6 });
  const { post } = store.appended[0];
  assert.equal(post.picture, 'scene 1');
  assert.equal(post.pictures, 6);
  assert.equal(countToday(store.state.data, DIARY_DAILY, NOW), 1);
  assert.equal(countToday(store.state.data, DIARY_PICTURES_DAILY, NOW), 6);
});

/** A runner whose port is a fake adapter with the given limits: the turn reads them from `capabilities()`. */
function limitedRunner({ hot, llm, images, store = fakeStore(), limits, client: clientOverride = client() }) {
  const adapter = createFakeAdapter({ iface: 'fake', selfId: 'self-id', capabilities: limits });
  const turns = createTurnRunner({
    discord: DISCORD,
    hot,
    store,
    llm,
    calibrator: { ratio: 1, apply: (n) => n, observe: () => {} },
    client: clientOverride,
    images,
    port: adapter,
    rng: () => 0.5,
    now: () => NOW,
  });
  return { turns, adapter };
}

test('diary set: the adapter that allows two files per message gets the six pictures in messages of two files', async () => {
  const images = fakeSetImages([10, 10, 10, 10, 10, 10]);
  const llm = fakeLlm(TOUR_PLAN, withDraws('<msg>une promenade</msg>', 6, true));
  const hot = setHot({ set: { pictures: [3, 6], maxMessageBytes: 1_000_000 } });
  const { turns, adapter } = limitedRunner({ hot, llm, images, limits: { maxFiles: 2 } });
  const result = await turns.runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} });
  assert.equal(result.outcome, 'spoke');
  const withFiles = adapter.messagesIn('d1').filter((message) => message.attachments.length > 0);
  assert.deepEqual(
    withFiles.map((message) => message.attachments.length),
    [2, 2, 2]
  );
});

test('diary set: an adapter that allows twelve files per message gets the same six pictures in one message', async () => {
  const images = fakeSetImages([10, 10, 10, 10, 10, 10]);
  const llm = fakeLlm(TOUR_PLAN, withDraws('<msg>une promenade</msg>', 6, true));
  const hot = setHot({ set: { pictures: [3, 6], maxMessageBytes: 1_000_000 } });
  const { turns, adapter } = limitedRunner({ hot, llm, images, limits: { maxFiles: 12 } });
  await turns.runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} });
  const withFiles = adapter.messagesIn('d1').filter((message) => message.attachments.length > 0);
  assert.deepEqual(
    withFiles.map((message) => message.attachments.length),
    [6]
  );
});

test('diary set: a dry run mirrors the image prompt in messages no longer than the maxChars of the adapter', async () => {
  const scene = 'x'.repeat(600);
  const llm = fakeLlm(TOUR_PLAN, toolAnswer('<msg>x</msg>', [call('draw.create', { text: scene })]));
  const mirrored = [];
  const mirrorChannel = { id: 'dry', send: async (payload) => void mirrored.push(payload.content) };
  const client = {
    user: { id: 'self-id', username: 'Bot' },
    channels: {
      cache: new Map([['d1', { id: 'd1', name: 'journal' }]]),
      fetch: async (id) => (id === 'dry' ? mirrorChannel : null),
    },
  };
  const hot = setHot({ features: { dryRun: true } });
  hot.config.bot.dryRunChannelId = 'dry';
  const { turns } = limitedRunner({ hot, llm, images: fakeSetImages([]), limits: { maxChars: 250 }, client });
  await withCapturedLogs(() => turns.runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} }));
  const parts = mirrored.filter((content) => content.includes('x'.repeat(20)));
  assert.ok(parts.length >= 2, 'a 600 character scene does not fit one message of 250');
  assert.ok(
    parts.every((content) => content.length <= 250),
    parts.map((content) => content.length).join(',')
  );
  assert.ok(parts.join('').split('x').length - 1 >= 600, 'no part of the prompt is lost');
});

test('diary set: calls past diary.set.pictures[1] in one answer are loop-cap results; the speech waits and step 2 posts what was staged', async () => {
  const images = fakeSetImages([]);
  const channel = diaryChannel();
  const llm = fakeLlm(TOUR_PLAN, [withDraws('<msg>x</msg>', 8), '<msg>y</msg>']);
  const { logs } = await withCapturedLogs(() =>
    runner({ hot: setHot({ set: { pictures: [2, 3] } }), llm, images }).runTurn({ channel, mode: 'diary', diary: {} })
  );
  assert.equal(images.prompts.length, 3);
  assert.ok(images.prompts[2].prompt.includes('scene 3'));
  assert.deepEqual(calledOf(logs).filter((line) => line.endsWith('loop-cap')).length, 5);
  assert.deepEqual(
    channel.sent.filter((payload) => payload.content).map((payload) => payload.content),
    ['y']
  );
  assert.equal(channel.sent.at(-1).files.length, 3);
});

test('chunkPictures: a new message past the byte limit or at 10 files; a picture over the limit goes alone', () => {
  const sized = (list) => list.map((n) => ({ buffer: { length: n } }));
  const lengths = (chunks) => chunks.map((chunk) => chunk.map((p) => p.buffer.length));
  assert.deepEqual(lengths(chunkPictures(sized([400, 400, 400, 900, 100]), 1000)), [[400, 400], [400], [900, 100]]);
  assert.deepEqual(lengths(chunkPictures(sized([50, 2000, 50]), 1000)), [[50], [2000], [50]]);
  assert.deepEqual(
    chunkPictures(sized(Array(23).fill(1)), 1_000_000).map((chunk) => chunk.length),
    [10, 10, 3]
  );
  assert.deepEqual(chunkPictures([], 1000), []);
});

test('diary set: one failure in a set holds the speech and the staged pictures; step 2 sees the result and posts with the five that came out', async () => {
  const images = fakeSetImages([10, 10, new ImageGenError('error'), 10, 10, 10]);
  const store = fakeStore();
  const channel = diaryChannel();
  const llm = fakeLlm(TOUR_PLAN, [withDraws('<msg>une promenade</msg>', 6), '<msg>cinq images sur six</msg>']);
  const { result, logs } = await withCapturedLogs(() =>
    runner({ hot: setHot({ set: { pictures: [3, 6] } }), llm, store, images }).runTurn({
      channel,
      mode: 'diary',
      diary: {},
    })
  );
  assert.equal(result.outcome, 'spoke');
  assert.equal(llm.calls.length, 3, 'the plan and two post requests');
  assert.ok(logs.some((l) => l.msg === 'turn: speech held'));
  assert.deepEqual(calledOf(logs), [
    'draw.create:ok/staged',
    'draw.create:ok/staged',
    'draw.create:failed/image-error',
    'draw.create:ok/staged',
    'draw.create:ok/staged',
    'draw.create:ok/staged',
  ]);
  // Step 2 sees all six results and the held notice.
  const step2 = llm.calls[2];
  assert.equal(step2.filter((message) => message.role === 'tool').length, 6);
  assert.ok(contentText(step2.at(-1).content).includes(labels.task.step.held));
  assert.deepEqual(
    channel.sent.filter((payload) => payload.content).map((payload) => payload.content),
    ['cinq images sur six'],
    'the held speech never went out'
  );
  assert.equal(channel.sent.at(-1).files.length, 5);
  assert.equal(result.diary.pictures, 5);
  assert.equal(store.appended[0].post.pictures, 5);
  assert.equal(countToday(store.state.data, DIARY_PICTURES_DAILY, NOW), 5);
});

test('diary set: an image cap mid-set refuses that picture; the others stay staged and the post goes out with them', async () => {
  const capped = Object.assign(new ImageCapError('daily', 'cap'), { key: 'image.maxPerDay', used: 50, cap: 50 });
  const images = fakeSetImages([10, new ImageGenError('error'), 10, capped, 10]);
  const store = fakeStore();
  const channel = diaryChannel();
  const llm = fakeLlm(TOUR_PLAN, [withDraws('<msg>x</msg>', 5), '<msg>y</msg>']);
  const { result, logs } = await withCapturedLogs(() =>
    runner({ hot: setHot(), llm, store, images }).runTurn({ channel, mode: 'diary', diary: {} })
  );
  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent.at(-1).files.length, 3);
  assert.ok(logs.some((l) => l.msg === 'turn: draw refused by a limit' && l.key === 'image.maxPerDay'));
  assert.ok(logs.some((l) => l.msg === 'turn: draw error' && l.reason === 'error'));
  assert.deepEqual(calledOf(logs), [
    'draw.create:ok/staged',
    'draw.create:failed/image-error',
    'draw.create:ok/staged',
    'draw.create:failed/image-cap-daily',
    'draw.create:ok/staged',
  ]);
  assert.equal(store.appended[0].post.pictures, 3);
  assert.equal(countToday(store.state.data, DIARY_PICTURES_DAILY, NOW), 3);
});

test('diary set: fewer than diary.set.minPosted pictures staged posts nothing and is refused set-short', async () => {
  const images = fakeSetImages([10, new ImageGenError('error'), new ImageGenError('error')]);
  const store = fakeStore();
  const channel = diaryChannel();
  const llm = fakeLlm(TOUR_PLAN, [withDraws('<msg>une promenade</msg>', 3), '<msg>une promenade quand même</msg>']);
  const { result, logs } = await withCapturedLogs(() =>
    runner({ hot: setHot({ set: { minPosted: 2 } }), llm, store, images }).runTurn({
      channel,
      mode: 'diary',
      diary: {},
    })
  );
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'set-short');
  assert.equal(channel.sent.length, 0, 'not even the message');
  assert.equal(store.appended.length, 0);
  const short = logs.find((l) => l.msg === 'turn: set short');
  assert.equal(short.pictures, 1);
  assert.equal(short.wanted, 2);
  assert.equal(countToday(store.state.data, DIARY_DAILY, NOW), 0, 'no post counted');
  assert.equal(countToday(store.state.data, DIARY_PICTURES_DAILY, NOW), 1, 'the picture paid for is counted');

  // Every call worked, but she made fewer than the set needs.
  const few = await runner({
    hot: setHot(),
    llm: fakeLlm(TOUR_PLAN, withDraws('<msg>x</msg>', 1)),
    store: fakeStore(),
    images: fakeSetImages([]),
  }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} });
  assert.deepEqual([few.outcome, few.reason], ['refused', 'set-short']);
  // A set answered without any picture is short too.
  const bare = await runner({
    hot: setHot(),
    llm: fakeLlm(TOUR_PLAN, '<msg>sans image</msg>'),
    store: fakeStore(),
    images: fakeSetImages([]),
  }).runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: {},
  });
  assert.deepEqual([bare.outcome, bare.reason], ['refused', 'set-short']);
});

test('diary: a call other than draw.create is refused diary-draw-only and never runs; the picture beside it does', async () => {
  const images = fakeSetImages([10]);
  const channel = diaryChannel();
  const llm = fakeLlm({ kind: 'selfPicture', brief: 'a pier', search: '', picture: true }, [
    toolAnswer('<msg>x</msg>', [call('message.create', { text: 'hello' }), call('draw.create', { text: 'a pier' })]),
    '<msg>y</msg>',
  ]);
  const { logs } = await withCapturedLogs(() => runner({ llm, images }).runTurn({ channel, mode: 'diary', diary: {} }));
  assert.deepEqual(
    calledOf(logs).sort(),
    ['draw.create:ok/staged', 'message.create:denied/diary-draw-only'],
    'only the picture ran'
  );
  assert.ok(
    logs.some((l) => l.msg === 'skill: refused' && l.skill === 'message.create' && l.code === 'diary-draw-only')
  );
  assert.equal(images.prompts.length, 1);
  assert.deepEqual(
    channel.sent.filter((payload) => payload.content).map((payload) => payload.content),
    ['y']
  );
  assert.equal(llm.calls.length, 3, 'the refusal is a result she reads');
  assert.ok(
    contentText(llm.calls[2].find((message) => message.role === 'tool').content).includes(
      labels.skills.result.reasons['diary-draw-only']
    )
  );
});

test('diary: a single-picture kind stages one picture; a second call is a loop-cap result', async () => {
  const images = fakeSetImages([]);
  const channel = diaryChannel();
  const llm = fakeLlm({ kind: 'selfPicture', brief: 'a pier', search: '', picture: true }, [
    withDraws('<msg>x</msg>', 3),
    '<msg>y</msg>',
  ]);
  const hot = setHot({ diary: { kinds: { selfPicture: 1 }, pictureKinds: ['selfPicture', 'tour'] } });
  const result = await runner({ hot, llm, images }).runTurn({ channel, mode: 'diary', diary: {} });
  assert.equal(images.prompts.length, 1);
  assert.equal(channel.sent.at(-1).files.length, 1);
  assert.equal(result.diary.pictures, 1);
});

test('diary set: dry-run generates nothing, posts nothing and logs each picture', async () => {
  const images = fakeSetImages([]);
  const store = fakeStore();
  const channel = diaryChannel();
  const llm = fakeLlm(TOUR_PLAN, withDraws('<msg>x</msg>', 4));
  const hot = setHot({ features: { dryRun: true } });
  const { result, logs } = await withCapturedLogs(() =>
    runner({ hot, llm, store, images }).runTurn({ channel, mode: 'diary', diary: {} })
  );
  assert.equal(result.outcome, 'spoke');
  assert.equal(result.dryRun, true);
  assert.equal(images.prompts.length, 0);
  assert.equal(channel.sent.length, 0);
  assert.equal(store.appended.length, 0);
  assert.equal(logs.filter((l) => l.msg === 'dry-run: would draw').length, 4);
  assert.equal(result.diary.pictures, 4);
  assert.equal(countToday(store.state.data, DIARY_PICTURES_DAILY, NOW), 0);
});

test('diary set: the compose request carries diary.set.seedSets seeds for a set kind, none for another kind', async () => {
  const seedLines = (text) =>
    (/<seeds>\n([\s\S]*?)\n<\/seeds>/.exec(text)?.[1] ?? '').split('\n').filter((line) => line.startsWith('- '));
  const llm = fakeLlm(TOUR_PLAN, withDraws('<msg>x</msg>', 3));
  await runner({ hot: setHot({ set: { seedSets: 3 } }), llm, images: fakeSetImages([]) }).runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: {},
  });
  assert.equal(seedLines(userOf(llm.calls[0])).length, 1, 'the plan request keeps diary.seedSets');
  assert.equal(seedLines(userOf(llm.calls[1])).length, 3, 'the compose request takes diary.set.seedSets');

  const text = fakeLlm({ kind: 'status', brief: 'x', search: '', picture: false }, '<msg>x</msg>');
  await runner({ hot: setHot(), llm: text }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} });
  assert.ok(!userOf(text.calls[1]).includes('<seeds>'));
});

test('diary set: a dry run with fewer drawings than diary.set.minPosted is short too', async () => {
  const channel = diaryChannel();
  const llm = fakeLlm(TOUR_PLAN, withDraws('<msg>x</msg>', 1));
  const hot = setHot({ features: { dryRun: true }, set: { minPosted: 2 } });
  const { result, logs } = await withCapturedLogs(() =>
    runner({ hot, llm, images: fakeSetImages([]) }).runTurn({ channel, mode: 'diary', diary: {} })
  );
  assert.deepEqual([result.outcome, result.reason, result.dryRun], ['refused', 'set-short', true]);
  assert.ok(logs.some((l) => l.msg === 'turn: set short' && l.dryRun === true));
  assert.ok(!logs.some((l) => l.msg === 'dry-run: would send'));
});
