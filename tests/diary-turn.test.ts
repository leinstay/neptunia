// Tests for the diary turn of src/behavior/turn.ts (mode `diary`): the plan
// request on the classifier model, the search it asks for, the compose request
// with the character card, the output rules of a diary post (no reactions, no
// GIF, no reply, no links, a message cap), the picture sets and the record in
// diary.json. Fake discord.js-shaped channel, fake LLM,
// fake store, fake image client and lookup; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkPictures, createTurnRunner as createRealTurnRunner } from '../src/behavior/turn.ts';
import { ImageGenError } from '../src/llm/images.ts';
import { DIARY_KINDS } from '../src/behavior/diary.ts';
import { DailyCapError } from '../src/llm/openrouter.ts';
import { fill, formatNow } from '../src/format.ts';
import { userText } from '../src/behavior/prompt.ts';
import { labels } from './fixtures/labels.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import type { LogEntry } from './fixtures/capture-logs.ts';
import { call, completionOf, toolAnswer } from './fixtures/tool-answers.ts';
import { contentText } from './fixtures/turn-harness.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import '../src/tools/impl/index.ts';
import { attachmentCount, onWorld, useIface, useSelf, world } from './fixtures/turn-world.ts';
import type { Channel } from './fixtures/turn-world.ts';
import { appendedPost, diaryCounts, entryOf, publishTo } from './fixtures/diary-mirror.ts';
import type { Untyped } from '../src/tools/types.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

// The diary channel is held by a fake interface named `fake`; the persona is `self-id`.
useIface('fake');
useSelf('self-id');
// onWorld takes a creator of any options; the real runner takes its own input type, so the options are cast once, here.
const createWorldRunner = onWorld((options) =>
  createRealTurnRunner(options as Parameters<typeof createRealTurnRunner>[0])
);

/**
 * A turn runner whose `runTurn` first opens the conversation a test gave as a diary channel (see diaryChannel).
 */
function createTurnRunner(options: Parameters<typeof createWorldRunner>[0]) {
  const turns = createWorldRunner(options);
  return {
    ...turns,
    runTurn: (params: Record<string, unknown> & { channel?: { open?: () => unknown } }) => {
      params.channel?.open?.();
      return turns.runTurn(params);
    },
  };
}

const NOW = Date.UTC(2026, 9, 6, 19, 30, 0);
const DAY = 24 * 60 * 60 * 1000;
const TZ = 'Europe/Athens';

/**
 * A diary channel the persona owns: every permission, Attach Files only when `attachFiles`. The conversation is made in
 * the test's world when a turn runs in it (`open`), and `sent` and `reactCalls` read what the persona did there.
 */
function diaryChannel({
  attachFiles = true,
  historyMessages = [],
}: { attachFiles?: boolean; historyMessages?: Array<Rec> } = {}) {
  let handle: Channel | null = null;
  return {
    id: 'd1',
    open() {
      handle ??= world().channel({
        id: 'd1',
        name: 'journal',
        guildId: 'g1',
        permissions: { attach: attachFiles },
        historyMessages,
      });
      return handle;
    },
    get sent() {
      return handle?.sent ?? [];
    },
    get reactCalls() {
      return handle?.reactCalls ?? [];
    },
  };
}

/**
 * Stage 3, the selfreflection wake: a diary turn records her entry and sends nothing itself, and the diary's mirror
 * publishes the entry (src/behavior/mirror.ts). The cases that asserted the turn's send call this where the send used
 * to happen: it checks that the turn sent nothing to `channel`, then publishes the entry to a mirror on `d1` of `port`,
 * so what `channel.sent` or the adapter shows after it is what the publication sent.
 * @param result  The diary turn's result.
 * @param channel  The diary channel of the case, or null when the case reads the adapter.
 */
async function published(result: Untyped, channel: Untyped, port = world().port) {
  assert.deepEqual(channel?.sent ?? [], [], 'the turn itself sends nothing');
  return publishTo(result, port, { now: NOW });
}

/** The persona's own earlier post as discord.js hands it over. */
function ownRaw(id: string, ts: number, content: string) {
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
function fakeLlm(plan: Untyped, post: Untyped) {
  const calls: Array<Untyped> = [];
  const options: Array<Untyped> = [];
  let composed = 0;
  return {
    calls,
    options,
    complete: async (messages: Untyped, opts: Untyped) => {
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
const withDraws = (text: string, n: Untyped, self = false) => drawAnswer(text, n, self);
const drawAnswer = (text: string, n = 1, self = false) =>
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
const calledOf = (logs: Array<LogEntry>) =>
  logs
    .filter((entry) => entry.msg === 'skills: called')
    .map((entry) => `${entry.skill}:${entry.status}${entry.code ? `/${entry.code}` : ''}`);

type Rec = Record<string, Untyped>;

function fakeStore({ posts = [], data = {} }: { posts?: Array<Rec>; data?: Rec } = {}) {
  const appended: Array<Untyped> = [];
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
    appendDiaryPost: (guildId: string, post: Untyped, opts: Untyped) => appended.push({ guildId, post, opts }),
    state: { data: { ...data }, markDirty() {} },
  };
}

function fakeImages({ used = 0, cap = 10, fail = null }: { used?: number; cap?: number; fail?: Error | null } = {}) {
  const prompts: Array<Untyped> = [];
  return {
    prompts,
    quota: () => ({ used, cap, userUsed: 0, userCap: 5, spent: used >= cap, userSpent: false }),
    generate: async ({ prompt }: { prompt: Untyped }) => {
      prompts.push(prompt);
      if (fail) throw fail;
      return { buffer: Buffer.from('png'), mediaType: 'image/png', seconds: 1, cost: 0 };
    },
  };
}

function fakeLookup(result: Untyped) {
  const calls: Array<Untyped> = [];
  return {
    calls,
    search: async (guildId: string, query: Untyped) => {
      calls.push({ guildId, query });
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

// PR 7d: the switches are code, the dry run and the daily caps are gone, and the diary's kinds, sets, gist length and
// message count are constants of src/behavior/diary.ts, so the config holds only the keys that are still settings.
function fakeHot({ diary = {}, prompts = {} }: { diary?: Untyped; prompts?: Untyped } = {}) {
  return {
    config: {
      bot: { timezone: TZ },
      context: {
        channelMessages: 50,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { fetchTimeoutMs: 10_000 },
        pull: { sameAudience: true },
      },
      llm: { maxRequestTokens: 50000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [0, 0], minMs: 0, maxMs: 0, betweenMessagesMs: [0, 0] },
      image: { maxPromptChars: 1000 },
      selfreflection: { channelId: 'd1', world: false, planMaxOutputTokens: 250, planTimeoutMs: 15000, ...diary },
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

function runner({
  hot = fakeHot(),
  store = fakeStore(),
  llm,
  images = fakeImages(),
  lookup = null,
}: { hot?: Untyped; store?: Untyped; llm?: Untyped; images?: Untyped; lookup?: Untyped } = {}) {
  return createTurnRunner({
    hot,
    store,
    llm,
    calibrator: { ratio: 1, apply: (n: Untyped) => n, observe: () => {} },
    images,
    lookup,
    rng: () => 0.5,
    now: () => NOW,
  });
}

// The whole user text, every cache part: the stable part always carries the static senses lines.
const userOf = (messages: Untyped) => userText(messages[1].content);

test('diary turn: plans on the analyzer model, then composes with the card', async () => {
  const posts = [
    { at: NOW - DAY, kind: 'status', gist: 'une journée grise', picture: null, messageIds: ['m0'], search: null },
  ];
  const llm = fakeLlm({ kind: 'status', brief: 'tired of rain', search: '', picture: false }, '<msg>ennui</msg>');
  const hot = fakeHot({ diary: { world: true } });
  const turns = runner({ hot, store: fakeStore({ posts }), llm });

  const result = await turns.runTurn({ channel: diaryChannel(), mode: 'diary', diary: { kind: null, forced: false } });

  assert.equal(loose(result).outcome, 'spoke');
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
  loose(hedged.config.llm).hedge = { roles: ['analyzer'], afterMs: 2500, timeoutMs: 8000, longTimeoutMs: 20000 };
  const llmHedged = fakeLlm({ kind: 'status', brief: 'b', search: '', picture: false }, '<msg>x</msg>');
  await runner({ hot: hedged, llm: llmHedged }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} });
  assert.equal(llmHedged.options[0].purpose, 'diary-plan');
  assert.deepEqual(llmHedged.options[0].hedge, { afterMs: 2500, timeoutMs: 120000 });

  const unhedged = fakeHot({ diary: { planTimeoutMs: 120000 } });
  loose(unhedged.config.llm).hedge = { roles: [], afterMs: 2500, timeoutMs: 8000, longTimeoutMs: 20000 };
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
  // PR 7d: the kinds are DIARY_KINDS of src/behavior/diary.ts.
  assert.ok(Object.keys(DIARY_KINDS).includes(store.appended[0].post.kind));
});

test('diary turn: a request cap on the plan refuses the turn', async () => {
  const llm = fakeLlm(new DailyCapError('daily cap'), '<msg>x</msg>');
  const channel = diaryChannel();
  const result = await runner({ llm }).runTurn({ channel, mode: 'diary', diary: {} });
  assert.equal(loose(result).outcome, 'refused');
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
  assert.equal(loose(result).diary.search, true);
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
  assert.equal(loose(result).diary.picture, true);
});

/** The `<kinds>` line of `key` with `weight` and no history. */
const kindLine = (key: string, weight: Untyped) => fill(labels.diary.kindLine, { key, weight, count: 0, window: 0 });

// PR 7d: the kinds and their weights are DIARY_KINDS of src/behavior/diary.ts, and the daily caps that turned the
// pictures off are gone: no image client is what turns them off here.
test('diary turn: with pictures off only text kinds are offered and the fallback picks one', async () => {
  const cases = [{ name: 'no image client', store: fakeStore(), images: null, channel: diaryChannel() }];
  for (const { name, store, images, channel } of cases) {
    for (const answer of ['not json at all', { kind: 'selfPicture', brief: 'a pier', search: '', picture: true }]) {
      const llm = fakeLlm(answer, '<msg>brume</msg>');
      const { logs } = await withCapturedLogs(() =>
        runner({ llm, store, images }).runTurn({ channel, mode: 'diary', diary: {} })
      );
      const planUser = userOf(llm.calls[0]);
      assert.ok(!planUser.includes(kindLine('selfPicture', 3)), `${name}: no picture kind offered`);
      assert.ok(
        planUser.includes(kindLine('status', 3)) && planUser.includes(kindLine('news', 2)),
        `${name}: the text kinds offered`
      );
      const planned = logs.find((l) => l.msg === 'diary: planned');
      assert.ok(['thought', 'people', 'news', 'facts', 'status'].includes(loose(planned).kind), `${name}: a text kind`);
      assert.equal(loose(planned).fallback, true);
      assert.equal(loose(planned).picture, false);
      assert.equal(loose(planned).picturesOff, true, `${name}: the log says why`);
    }
    assert.ok(
      store.appended.every(({ post }) => post.kind !== 'selfPicture'),
      `${name}: no picture kind recorded`
    );
  }
});

// PR 7d: the weights are DIARY_KINDS of src/behavior/diary.ts.
test('diary turn: with pictures allowed the picture kinds are offered as before', async () => {
  const llm = fakeLlm({ kind: 'status', brief: 'x', search: '', picture: false }, '<msg>brume</msg>');
  const { logs } = await withCapturedLogs(() =>
    runner({ llm }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} })
  );
  const planUser = userOf(llm.calls[0]);
  const kinds: Array<[string, number]> = [
    ['selfPicture', 3],
    ['status', 3],
    ['news', 2],
  ];
  for (const [key, weight] of kinds) assert.ok(planUser.includes(kindLine(key, weight)), key);
  assert.equal(loose(logs.find((l) => l.msg === 'diary: planned')).picturesOff, undefined);
});

test('diary turn: a forced picture kind with pictures off is refused before any request', async () => {
  const cases = [
    { name: 'no image client', store: fakeStore(), images: null, channel: diaryChannel(), limit: null },
    {
      name: 'no attach files',
      store: fakeStore(),
      images: fakeImages(),
      channel: diaryChannel({ attachFiles: false }),
      limit: null,
    },
  ];
  for (const { name, store, images, channel, limit } of cases) {
    const llm = fakeLlm({ kind: 'selfPicture', brief: 'x', search: '', picture: true }, '<msg>brume</msg>');
    const result = await runner({ llm, store, images }).runTurn({
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
  const store = fakeStore();
  const llm = fakeLlm({ kind: 'status', brief: 'x', search: '', picture: false }, '<msg>brume</msg>');
  const result = await runner({ llm, store, images: null }).runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: { kind: 'status', forced: true },
  });
  assert.equal(loose(result).outcome, 'spoke');
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
  assert.equal(loose(result).outcome, 'spoke');
  // Stage 3: the turn sends nothing; the expectation below is what the mirror's publication of the entry sends.
  await published(result, channel);
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
  assert.equal(loose(result).diary.messages, 2);
});

test('diary turn: a skip posts nothing and records nothing', async () => {
  const llm = fakeLlm({ kind: 'status', brief: 'x', search: '', picture: false }, '<skip/>');
  const store = fakeStore();
  const channel = diaryChannel();
  const result = await runner({ llm, store }).runTurn({ channel, mode: 'diary', diary: {} });
  assert.equal(loose(result).outcome, 'skip');
  assert.equal(channel.sent.length, 0);
  assert.equal(store.appended.length, 0);
});

test('diary turn: records the post with gists and message ids', async () => {
  const llm = fakeLlm(
    { kind: 'selfPicture', brief: 'a pier', search: '', picture: true },
    toolAnswer('<msg>un quai dans la brume, très calme ce soir</msg>', [
      call('draw.create', { text: 'the persona on a foggy pier at night, lanterns', self: true }),
    ])
  );
  const store = fakeStore();
  const channel = diaryChannel();
  const result = await runner({ llm, store }).runTurn({ channel, mode: 'diary', diary: {} });
  assert.equal(loose(result).outcome, 'spoke');
  // Stage 3: the outcome also names the entry it recorded (`entry`), beside the same counts.
  assert.deepEqual(diaryCounts(result), {
    kind: 'selfPicture',
    picture: true,
    search: false,
    messages: 1,
    pictures: 1,
  });
  const entry = entryOf(result);
  assert.deepEqual(entry.messages, ['un quai dans la brume, très calme ce soir']);
  assert.equal(store.appended.length, 1);
  const { guildId, post, opts } = appendedPost(store);
  assert.equal(guildId, 'g1');
  // Stage 3: the post is recorded before anything is sent, so it carries her full text and the entry's id and no
  // message ids (the receipts of its publications hold those); the turn itself sends nothing.
  assert.deepEqual(
    {
      at: post.at,
      kind: post.kind,
      gist: post.gist,
      picture: post.picture,
      search: post.search,
      text: post.text,
      itemId: post.itemId,
    },
    {
      at: NOW,
      kind: 'selfPicture',
      gist: 'un quai dans la brume, très calme ce soir',
      picture: 'the persona on a foggy pier at night, lanterns',
      search: null,
      text: 'un quai dans la brume, très calme ce soir',
      itemId: entry.id,
    }
  );
  assert.deepEqual(post.messageIds ?? [], []);
  assert.deepEqual(channel.sent, [], 'the turn itself sends nothing');
  // PR 7d: the history kept is the constant DEFAULT_HISTORY_POSTS of src/behavior/diary.ts, 150 posts.
  assert.deepEqual(opts, { max: 150 });
});

test('diary turn: a voice message is kept in the post: its id among messageIds and a voice field with the text as voiced', async () => {
  const llm = fakeLlm(
    { kind: 'status', brief: 'a quiet evening', search: '', picture: false },
    toolAnswer('<msg>soir calme</msg>', [call('voice.say', { text: '[tired] soir calme' })])
  );
  const store = fakeStore();
  const voiced = '[sighs] soir calme';
  const runOwnOp = async (op: Untyped) => ({
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
    hot: fakeHot(),
    store,
    llm,
    calibrator: { ratio: 1, apply: (n: Untyped) => n, observe: () => {} },
    images: fakeImages(),
    speech: { quota: () => ({ used: 0, cap: 10, spent: false }) },
    runOwnOp,
    rng: () => 0.5,
    now: () => NOW,
  });
  const result = await turns.runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} });
  assert.equal(loose(result).outcome, 'spoke');
  const { post } = appendedPost(store);
  const voice: { text?: unknown; durationSec?: unknown } = post.voice ?? {};
  // Stage 3: the entry is recorded before any send, so its voice has no message id yet: the post keeps the text as
  // voiced and its length, and the mirror's publication sends the voice file.
  assert.deepEqual({ text: voice.text, durationSec: voice.durationSec }, { text: voiced, durationSec: 2.5 });
});

// PR 7d: `selfreflection.gistChars` is the constant DEFAULT_GIST_CHARS of src/behavior/diary.ts, 200.
test('diary turn: the gist is cut to selfreflection.gistChars', async () => {
  const long = 'mot '.repeat(100).trim();
  const llm = fakeLlm({ kind: 'status', brief: 'x', search: '', picture: false }, `<msg>${long}</msg>`);
  const store = fakeStore();
  await runner({ llm, store }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} });
  assert.ok(store.appended[0].post.gist.length <= 200);
});

test('diary turn: an audience named beside a call holds when her messages come in a later answer', async () => {
  // Catches: only the last answer's tag being read, so the restriction she named first falls open to unrestricted.
  const llm = fakeLlm({ kind: 'selfPicture', brief: 'a pier', search: '', picture: true }, [
    drawAnswer('<audience>interface:nowhere</audience><msg>brume</msg>'),
    '<msg>brume sans image</msg>',
  ]);
  const images = fakeImages({ fail: new ImageGenError('error') });
  const result = await runner({ llm, store: fakeStore(), images }).runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: {},
  });
  const { audience } = (result as { diary: { audience: unknown } }).diary;
  assert.deepEqual(audience, { ok: false, code: 'audience-unknown-interface' });
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
  assert.equal(loose(result).outcome, 'spoke');
  assert.equal(loose(result).drawFailed, undefined);
  assert.equal(llm.calls.length, 3, 'the plan, the post with the draw, the post after the result');
  assert.deepEqual(calledOf(logs), ['draw.create:failed/image-error']);
  assert.ok(logs.some((l) => l.msg === 'turn: speech held'));
  // Stage 3: the turn sends nothing; the expectation below is what the mirror's publication of the entry sends.
  await published(result, channel);
  assert.deepEqual(
    channel.sent.map((payload) => payload.content),
    ['brume sans image'],
    'the first speech was held and never posted'
  );
  assert.equal(store.appended[0].post.picture, null);
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
  loose(hot.prompts).reply = 'REPLY for {{author}}';
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

test('diary turn: a post of a picture alone is a spoken turn', async () => {
  const llm = fakeLlm({ kind: 'selfPicture', brief: 'a pier', search: '', picture: true }, drawAnswer('', 1, true));
  const store = fakeStore();
  const channel = diaryChannel();
  const result = await runner({ llm, store }).runTurn({ channel, mode: 'diary', diary: {} });
  assert.equal(loose(result).outcome, 'spoke');
  // Stage 3: nothing reaches a chat from the turn, so it delivers nothing and the post records no message id; the
  // picture is one message of files once the mirror publishes the entry.
  await published(result, channel);
  assert.equal(channel.sent.length, 1);
  assert.ok(Array.isArray(channel.sent[0].files));
  assert.equal(store.appended[0].post.gist, '');
});

// ---- set posts (selfreflection.setKinds): several pictures, generated before anything is sent ----------

/** An image client that answers each generate call by the next step: a byte count, or an error to throw. */
function fakeSetImages(steps: Untyped, events: Array<string> = []) {
  const prompts: Array<Untyped> = [];
  let call = 0;
  return {
    prompts,
    events,
    quota: () => ({ used: 0, cap: 50, userUsed: 0, userCap: 5, spent: false, userSpent: false }),
    generate: async ({ prompt, userId }: { prompt: Untyped; userId: Untyped }) => {
      prompts.push({ prompt, userId });
      const step = steps[call] ?? 10;
      call += 1;
      events.push(`generate ${call}`);
      if (step instanceof Error) throw step;
      return { buffer: Buffer.alloc(step, 1), mediaType: 'image/png', seconds: 1, cost: 0 };
    },
  };
}

/** A diary channel whose sends are logged into `events` too (one entry per message: its files, or `msg`). */
function eventChannel(events: Untyped) {
  const channel = diaryChannel();
  world().tap('send', ([, content]) => {
    const files = attachmentCount(content);
    events.push(files > 0 ? `files ${files}` : 'msg');
  });
  return channel;
}

// PR 7d: the set kinds and their settings are constants of src/behavior/diary.ts: `photoset` is a set kind of 4 to 6
// pictures, at least 2 posted, 6 seed sets, at most 8 000 000 bytes in one message.
const TOUR_PLAN = { kind: 'photoset', brief: 'a harbour walk', search: '', picture: true };

test('diary: a single picture is staged while the post is composed, then posted after its messages', async () => {
  const events: Array<Untyped> = [];
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
  assert.equal(loose(result).outcome, 'spoke');
  // Stage 3: the turn sends nothing; the expectation below is what the mirror's publication of the entry sends.
  await published(result, channel);
  assert.deepEqual(events, ['generate 1', 'msg', 'files 1'], 'generated first, posted after the message');
  assert.deepEqual(calledOf(logs), ['draw.create:ok/staged']);
  assert.equal(llm.calls.length, 2, 'the plan and one post request');
  assert.equal(loose(channel.sent.at(-1)).files.length, 1);
  // Stage 3 design, section 3 item 6: the outcome names the entry it recorded; the entry itself is checked by its publication.
  assert.deepEqual(loose(result).diary, {
    kind: 'selfPicture',
    picture: true,
    search: false,
    messages: 1,
    pictures: 1,
    // The outcome also names her audience (plan section 5): no tag in the answer reads as unrestricted.
    audience: { ok: true, audience: { kind: 'unrestricted' } },
    entry: entryOf(result),
  });
  assert.equal(store.appended[0].post.picture, 'a pier at night');
  assert.equal('pictures' in store.appended[0].post, false, 'a single-picture kind records no count');
});

test('diary set: six draw.create calls in one answer are generated before anything is sent, then the messages, then the files, chunked by bytes', async () => {
  const events: Array<Untyped> = [];
  const images = fakeSetImages([3_200_000, 3_200_000, 3_200_000, 7_200_000, 800_000, 400_000], events);
  const store = fakeStore();
  const channel = eventChannel(events);
  const llm = fakeLlm(TOUR_PLAN, withDraws('<msg>une promenade</msg><msg>au port</msg>', 6, true));
  const { result, logs } = await withCapturedLogs(() =>
    runner({ llm, store, images }).runTurn({
      channel,
      mode: 'diary',
      diary: {},
    })
  );
  assert.equal(loose(result).outcome, 'spoke');
  assert.equal(llm.calls.length, 2, 'one post request');
  // Stage 3: the turn sends nothing; the expectation below is what the mirror's publication of the entry sends.
  await published(result, channel);
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
    channel.sent
      .slice(2)
      .map((payload) => loose(payload.files).map((file: string) => loose(loose(file).attachment).length)),
    [[3_200_000, 3_200_000], [3_200_000], [7_200_000, 800_000], [400_000]]
  );
  assert.equal(channel.sent[2].content, undefined);
  assert.equal(channel.sent[2].reply, undefined);
  const drew = logs.filter((l) => l.msg === 'turn: drew');
  assert.equal(drew.length, 6);
  assert.ok(drew.every((l) => l.set === true));
  assert.equal(loose(logs.find((l) => l.msg === 'turn: set posted')).pictures, 6);
  // Stage 3 design, section 3 item 6: the outcome names the entry it recorded; the entry itself is checked by its publication.
  assert.deepEqual(loose(result).diary, {
    kind: 'photoset',
    picture: true,
    search: false,
    messages: 2,
    pictures: 6,
    // The outcome also names her audience (plan section 5): no tag in the answer reads as unrestricted.
    audience: { ok: true, audience: { kind: 'unrestricted' } },
    entry: entryOf(result),
  });
  const { post } = store.appended[0];
  assert.equal(post.picture, 'scene 1');
  assert.equal(post.pictures, 6);
});

/**
 * A runner whose port is a fake adapter with the given limits: the turn reads them from `capabilities()`.
 */
function limitedRunner({
  hot,
  llm,
  images,
  store = fakeStore(),
  limits,
}: {
  hot: Untyped;
  llm: Untyped;
  images: Untyped;
  store?: Untyped;
  limits: Untyped;
}) {
  const adapter = createFakeAdapter({ iface: 'fake', selfId: 'self-id', capabilities: limits });
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
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
  const { turns, adapter } = limitedRunner({ hot: fakeHot(), llm, images, limits: { maxFiles: 2 } });
  const result = await turns.runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} });
  assert.equal(loose(result).outcome, 'spoke');
  // Stage 3: the turn sends nothing; the mirror's publication to this adapter splits the set by its maxFiles.
  assert.deepEqual(adapter.messagesIn('d1'), [], 'the turn itself sends nothing');
  await published(result, null, adapter);
  const withFiles = adapter.messagesIn('d1').filter((message) => message.attachments.length > 0);
  assert.deepEqual(
    withFiles.map((message) => message.attachments.length),
    [2, 2, 2]
  );
});

test('diary set: an adapter that allows twelve files per message gets the same six pictures in one message', async () => {
  const images = fakeSetImages([10, 10, 10, 10, 10, 10]);
  const llm = fakeLlm(TOUR_PLAN, withDraws('<msg>une promenade</msg>', 6, true));
  const { turns, adapter } = limitedRunner({ hot: fakeHot(), llm, images, limits: { maxFiles: 12 } });
  const result = await turns.runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} });
  // Stage 3: the turn sends nothing; the mirror's publication to this adapter puts the set in one message.
  assert.deepEqual(adapter.messagesIn('d1'), [], 'the turn itself sends nothing');
  await published(result, null, adapter);
  const withFiles = adapter.messagesIn('d1').filter((message) => message.attachments.length > 0);
  assert.deepEqual(
    withFiles.map((message) => message.attachments.length),
    [6]
  );
});

test('diary set: calls past selfreflection.set.pictures[1] in one answer are loop-cap results; the speech waits and step 2 posts what was staged', async () => {
  const images = fakeSetImages([]);
  const channel = diaryChannel();
  const llm = fakeLlm(TOUR_PLAN, [withDraws('<msg>x</msg>', 8), '<msg>y</msg>']);
  const { result, logs } = await withCapturedLogs(() =>
    runner({ llm, images }).runTurn({ channel, mode: 'diary', diary: {} })
  );
  assert.equal(images.prompts.length, 6);
  assert.ok(images.prompts[5].prompt.includes('scene 6'));
  assert.deepEqual(calledOf(logs).filter((line: string) => line.endsWith('loop-cap')).length, 2);
  // Stage 3: the turn sends nothing; the expectation below is what the mirror's publication of the entry sends.
  await published(result, channel);
  assert.deepEqual(
    channel.sent.filter((payload) => payload.content).map((payload) => payload.content),
    ['y']
  );
  assert.equal(loose(channel.sent.at(-1)).files.length, 6);
});

test('chunkPictures: a new message past the byte limit or at 10 files; a picture over the limit goes alone', () => {
  const sized = (list: Untyped) => list.map((n: Untyped) => ({ buffer: { length: n } }));
  const lengths = (chunks: Untyped) => chunks.map((chunk: Untyped) => chunk.map((p: string) => loose(p).buffer.length));
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
    runner({ llm, store, images }).runTurn({
      channel,
      mode: 'diary',
      diary: {},
    })
  );
  assert.equal(loose(result).outcome, 'spoke');
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
  // Stage 3: the turn sends nothing; the expectation below is what the mirror's publication of the entry sends.
  await published(result, channel);
  // Step 2 sees all six results and the held notice.
  const step2 = llm.calls[2];
  assert.equal(step2.filter((message: Untyped) => message.role === 'tool').length, 6);
  assert.ok(contentText(step2.at(-1).content).includes(labels.task.step.held));
  assert.deepEqual(
    channel.sent.filter((payload) => payload.content).map((payload) => payload.content),
    ['cinq images sur six'],
    'the held speech never went out'
  );
  assert.equal(loose(channel.sent.at(-1)).files.length, 5);
  assert.equal(loose(result).diary.pictures, 5);
  assert.equal(store.appended[0].post.pictures, 5);
});

test('diary set: fewer than selfreflection.set.minPosted pictures staged posts nothing and is refused set-short', async () => {
  const images = fakeSetImages([10, new ImageGenError('error'), new ImageGenError('error')]);
  const store = fakeStore();
  const channel = diaryChannel();
  const llm = fakeLlm(TOUR_PLAN, [withDraws('<msg>une promenade</msg>', 3), '<msg>une promenade quand même</msg>']);
  const { result, logs } = await withCapturedLogs(() =>
    runner({ llm, store, images }).runTurn({
      channel,
      mode: 'diary',
      diary: {},
    })
  );
  assert.equal(loose(result).outcome, 'refused');
  assert.equal(loose(result).reason, 'set-short');
  assert.equal(channel.sent.length, 0, 'not even the message');
  assert.equal(store.appended.length, 0);
  const short = logs.find((l) => l.msg === 'turn: set short');
  assert.equal(loose(short).pictures, 1);
  assert.equal(loose(short).wanted, 2);

  // Every call worked, but she made fewer than the set needs.
  const few = await runner({
    llm: fakeLlm(TOUR_PLAN, withDraws('<msg>x</msg>', 1)),
    store: fakeStore(),
    images: fakeSetImages([]),
  }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} });
  assert.deepEqual([loose(few).outcome, loose(few).reason], ['refused', 'set-short']);
  // A set answered without any picture is short too.
  const bare = await runner({
    llm: fakeLlm(TOUR_PLAN, '<msg>sans image</msg>'),
    store: fakeStore(),
    images: fakeSetImages([]),
  }).runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: {},
  });
  assert.deepEqual([loose(bare).outcome, loose(bare).reason], ['refused', 'set-short']);
});

test('diary: a call other than draw.create is refused diary-draw-only and never runs; the picture beside it does', async () => {
  const images = fakeSetImages([10]);
  const channel = diaryChannel();
  const llm = fakeLlm({ kind: 'selfPicture', brief: 'a pier', search: '', picture: true }, [
    toolAnswer('<msg>x</msg>', [call('message.create', { text: 'hello' }), call('draw.create', { text: 'a pier' })]),
    '<msg>y</msg>',
  ]);
  const { result, logs } = await withCapturedLogs(() =>
    runner({ llm, images }).runTurn({ channel, mode: 'diary', diary: {} })
  );
  assert.deepEqual(
    calledOf(logs).sort(),
    ['draw.create:ok/staged', 'message.create:denied/diary-draw-only'],
    'only the picture ran'
  );
  assert.ok(
    logs.some((l) => l.msg === 'skill: refused' && l.skill === 'message.create' && l.code === 'diary-draw-only')
  );
  assert.equal(images.prompts.length, 1);
  // Stage 3: the turn sends nothing; the expectation below is what the mirror's publication of the entry sends.
  await published(result, channel);
  assert.deepEqual(
    channel.sent.filter((payload) => payload.content).map((payload) => payload.content),
    ['y']
  );
  assert.equal(llm.calls.length, 3, 'the refusal is a result she reads');
  assert.ok(
    contentText(llm.calls[2].find((message: Untyped) => message.role === 'tool').content).includes(
      labels.tools.result.reasons['diary-draw-only']
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
  const result = await runner({ llm, images }).runTurn({ channel, mode: 'diary', diary: {} });
  assert.equal(images.prompts.length, 1);
  // Stage 3: the turn sends nothing; the expectation below is what the mirror's publication of the entry sends.
  await published(result, channel);
  assert.equal(loose(channel.sent.at(-1)).files.length, 1);
  assert.equal(loose(result).diary.pictures, 1);
});

test('diary set: the compose request carries selfreflection.set.seedSets seeds for a set kind, none for another kind', async () => {
  const seedLines = (text: string) =>
    (/<seeds>\n([\s\S]*?)\n<\/seeds>/.exec(text)?.[1] ?? '').split('\n').filter((line) => line.startsWith('- '));
  const llm = fakeLlm(TOUR_PLAN, withDraws('<msg>x</msg>', 3));
  await runner({ llm, images: fakeSetImages([]) }).runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: {},
  });
  // PR 7d: the plan's seed sets (2) and a set's (6) are constants of src/behavior/diary.ts.
  assert.equal(seedLines(userOf(llm.calls[0])).length, 2, 'the plan request keeps selfreflection.seedSets');
  assert.equal(seedLines(userOf(llm.calls[1])).length, 6, 'the compose request takes selfreflection.set.seedSets');

  const text = fakeLlm({ kind: 'status', brief: 'x', search: '', picture: false }, '<msg>x</msg>');
  await runner({ llm: text }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} });
  assert.ok(!userOf(text.calls[1]).includes('<seeds>'));
});
