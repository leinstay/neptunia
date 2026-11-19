// Tests for the diary turn of src/behavior/turn.ts (mode `diary`): the director's
// request for a kind that takes a scene, the persona's request
// with the character card, the output rules of a diary post (no reactions, no
// GIF, no reply, no links, a message cap), the picture sets and the record in
// diary.json. Fake discord.js-shaped channel, fake LLM,
// fake store, fake image client and lookup; no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chunkPictures, createTurnRunner as createRealTurnRunner } from '../src/behavior/turn.ts';
import { ImageGenError } from '../src/llm/images.ts';
import { DailyCapError } from '../src/llm/openrouter.ts';
import { fill, formatNow } from '../src/format.ts';
import { userText } from '../src/behavior/prompt.ts';
import { labels } from './fixtures/labels.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import type { LogEntry } from './fixtures/capture-logs.ts';
import { call, completionOf, toolAnswer } from './fixtures/tool-answers.ts';
import { contentText } from './fixtures/turn-harness.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import '../src/tools/operations/index.ts';
import { attachmentCount, onWorld, useIface, useSelf, world } from './fixtures/turn-world.ts';
import type { Channel } from './fixtures/turn-world.ts';
import { appendedPost, diaryCounts, entryOf, publishTo } from './fixtures/diary-mirror.ts';
import type { Untyped } from '../src/tools/types.ts';
import { directorAnswer, setsOf } from './fixtures/scene-answer.ts';
import { mirrorScene } from './fixtures/mirror-scene.ts';
import {
  FRAME_NOW,
  JOURNAL,
  PAGES,
  TEXT as FRAME_TEXT,
  blockOf,
  frameTurn,
  gistOf,
  partOf,
} from './fixtures/diary-frame.ts';
import { objectMediaCache } from '../src/memory/store-media.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { createJournal } from '../src/memory/journal.ts';
import { NOW as NOW_ID, sceneHot, sceneLlm, sceneMemory, sceneWorld } from './fixtures/diary-scene.ts';
import type { SceneMemory } from './fixtures/diary-scene.ts';
import { worldTurnRunner } from './fixtures/world-runner.ts';
import { chainsOf } from './fixtures/chains.ts';
import { defaultSkills } from '../src/turn/calls.ts';

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
 * A turn runner whose `runTurn` first opens the chat a test gave as a diary channel (see diaryChannel).
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
 * A diary channel the persona owns: every permission, Attach Files only when `attachFiles`. The chat is made in
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
        placeId: 'g1',
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
 * Stage 3, the diary wake: a diary turn records her entry and sends nothing itself, and the diary's mirror
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
    placeId: 'd1',
    author: { id: 'self-id', bot: true, globalName: 'Bot', username: 'Bot' },
    member: { displayName: 'Bot' },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

/**
 * An LLM that answers the director with `scene` (a scene's text, an Error it throws, or `{ raw }` sent as it is), then
 * the persona's requests with `post` (a list: one answer per request, the last repeated). `calls` holds every request,
 * the director's first.
 */
function fakeLlm(scene: string | Error | { raw: string } | null, post: Untyped) {
  const calls: Array<Untyped> = [];
  const options: Array<Untyped> = [];
  let composed = 0;
  return {
    calls,
    options,
    complete: async (messages: Untyped, opts: Untyped) => {
      calls.push(messages);
      options.push(opts);
      if (opts?.purpose === 'diary-scene') {
        if (scene instanceof Error) throw scene;
        if (scene !== null && typeof scene === 'object') return { text: scene.raw, usage: {}, estimated: 5 };
        return directorAnswer(messages, opts, typeof scene === 'string' ? scene : undefined);
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
        people: [],
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
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
    getDiary: () => ({ posts, updatedAt: 0 }),
    appendDiaryPost: (post: Untyped, opts: Untyped) => appended.push({ post, opts }),
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
    search: async (placeId: string, query: Untyped) => {
      calls.push({ placeId, query });
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
      image: {},
      diary: {
        placeId: 'd1',
        world: false,
        ...diary,
      },
    },
    prompts: {
      main: 'SYSTEM for {{name}}',
      persona: 'CARD_TEXT',
      format: 'FORMAT_TEXT',
      'diary/task': 'DIARY_TASK for {{name}}',
      'diary/scene': 'SCENE_TASK',
      'diary/kinds/status': 'STATUS_TASK',
      'diary/kinds/story': 'STORY_TASK',
      'diary/seeds/place': 'a pier',
      'diary/seeds/setting': 'fog',
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
  // The lead: the code draws the diary's kind (owner, 2026-11-06).
  rng = () => 0.5,
  extra = {},
}: {
  hot?: Untyped;
  store?: Untyped;
  llm?: Untyped;
  images?: Untyped;
  lookup?: Untyped;
  rng?: () => number;
  extra?: Record<string, unknown>;
} = {}) {
  return createTurnRunner({
    hot,
    store,
    llm,
    calibrator: { ratio: 1, apply: (n: Untyped) => n, observe: () => {} },
    images,
    lookup,
    rng,
    now: () => NOW,
    ...extra,
  });
}

// The whole user text, every cache part: the stable part always carries the static senses lines.
const userOf = (messages: Untyped) => userText(messages[1].content);

test('diary turn: a story asks the director on its role, then writes with the card and the scene', async () => {
  // Bug: the persona writes a scene kind with no scene, or the director runs on the persona's own role.
  const llm = fakeLlm('A FOGGY PIER AT DUSK.', '<msg>ennui</msg>');
  const turns = runner({ hot: fakeHot({ diary: { world: true } }), llm });

  const result = await turns.runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: { kind: 'story', forced: false },
  });

  assert.equal(loose(result).outcome, 'spoke');
  assert.equal(llm.calls.length, 2);
  assert.equal(llm.options[0].purpose, 'diary-scene');
  assert.equal(llm.options[0].role, 'director');
  assert.ok(String(llm.calls[1][0].content).includes('CARD_TEXT'), 'the entry is written with the card');
  const composeUser = userOf(llm.calls[1]);
  const inner = blockOf(composeUser, 'inner');
  assert.equal(partOf(inner, 'kind'), 'story');
  assert.equal(partOf(inner, 'scene'), 'A FOGGY PIER AT DUSK.');
  assert.ok(composeUser.includes('<task>\nDIARY_TASK for Bot\n\nSTORY_TASK\n</task>'), composeUser.slice(-400));
  for (const tag of ['plan', 'seeds', 'kinds', 'meanwhile']) assert.ok(!composeUser.includes(`<${tag}>`), tag);
});

test('diary turn: a status asks no director and its request holds no <scene>', async () => {
  // Bug: a kind with no scene waits on the director, or reads a scene.
  const llm = fakeLlm(null, '<msg>ennui</msg>');
  await runner({ llm }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: { kind: 'status', forced: false } });
  assert.equal(llm.calls.length, 1, 'the persona alone');
  const user = userOf(llm.calls[0]);
  assert.equal(partOf(blockOf(user, 'inner'), 'kind'), 'status');
  assert.ok(!user.includes('<scene>'));
  assert.ok(user.includes('<task>\nDIARY_TASK for Bot\n\nSTATUS_TASK\n</task>'));
});

test('diary turn: a randomSet asks for three scenes whose sets share no line', async () => {
  // Bug: the three places of a random set come from one request, or repeat a line, so its pictures look alike.
  const thirty = (family: string) => Array.from({ length: 30 }, (_, i) => `${family} ${i}`).join('\n');
  const llm = fakeLlm(null, '<msg>trois endroits</msg>');
  const hot = fakeHot({ prompts: { 'diary/seeds/place': thirty('place'), 'diary/seeds/setting': thirty('setting') } });
  await runner({ hot, llm }).runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: { kind: 'randomSet', forced: false },
  });
  const asked = llm.calls.filter((_, i) => llm.options[i].purpose === 'diary-scene');
  assert.equal(asked.length, 3);
  const lines = asked.flatMap((messages: Untyped) => setsOf(String(messages[1].content)).flat());
  assert.equal(new Set(lines).size, lines.length, 'no line in two sets');
  const scene = partOf(blockOf(userOf(llm.calls[3]), 'inner'), 'scene');
  assert.equal(scene.split('A STILL HARBOUR AT DUSK.').length - 1, 3, scene);
});

test('diary turn: a randomSet with one scene of three runs', async () => {
  // Bug: one failed request of three drops the whole entry.
  let asked = 0;
  const llm = fakeLlm(null, withDraws('<msg>un endroit</msg>', 3));
  const complete = llm.complete;
  llm.complete = (messages: Untyped, opts: Untyped) => {
    if (opts?.purpose === 'diary-scene' && (asked += 1) > 1)
      return Promise.resolve({ text: 'no json', usage: {}, estimated: 5 });
    return complete(messages, opts);
  };
  const store = fakeStore();
  const result = await runner({ llm, store }).runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: { kind: 'randomSet', forced: false },
  });
  assert.equal(loose(result).outcome, 'spoke');
  assert.equal(store.appended[0].post.scenes.length, 1);
});

test('diary turn: with no scene no turn runs and the slot ends skip no-scene', async () => {
  // Bug: the persona writes a scene kind with no scene and makes one up, or the failure goes unlogged.
  for (const scene of [new Error('down'), { raw: 'not json' }]) {
    const llm = fakeLlm(scene, '<msg>x</msg>');
    const store = fakeStore();
    const { result, logs } = await withCapturedLogs(() =>
      runner({ llm, store }).runTurn({
        channel: diaryChannel(),
        mode: 'diary',
        diary: { kind: 'story', forced: false },
      })
    );
    assert.equal(loose(result).outcome, 'skip');
    assert.equal(loose(result).reason, 'no-scene');
    assert.equal(llm.calls.length, 1, 'the director alone');
    assert.equal(store.appended.length, 0);
    const line = logs.find((entry) => entry.msg === 'diary: skip');
    assert.deepEqual(loose(line).failures, [scene instanceof Error ? 'request-failed' : 'not-json']);
  }
});

test('diary turn: a request cap on the director refuses the turn', async () => {
  const llm = fakeLlm(new DailyCapError('daily cap'), '<msg>x</msg>');
  const channel = diaryChannel();
  const result = await runner({ llm }).runTurn({ channel, mode: 'diary', diary: { kind: 'story', forced: false } });
  assert.equal(loose(result).outcome, 'refused');
  assert.equal(llm.calls.length, 1);
  assert.equal(channel.sent.length, 0);
});

test('diary turn: a forced kind replaces the draw and is recorded', async () => {
  const llm = fakeLlm(null, '<msg>brume</msg>');
  const store = fakeStore();
  await runner({ llm, store }).runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: { kind: 'thought', forced: true },
  });
  assert.equal(partOf(blockOf(userOf(llm.calls[0]), 'inner'), 'kind'), 'thought');
  assert.equal(store.appended[0].post.kind, 'thought');
});

test('diary turn: a topic becomes a <topic> part of <inner>', async () => {
  const llm = fakeLlm(null, '<msg>brume</msg>');
  await runner({ llm }).runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: { kind: 'status', topic: '  le vieux  port\n ', forced: true },
  });
  const inner = blockOf(userOf(llm.calls[0]), 'inner');
  assert.equal(partOf(inner, 'topic'), `${labels.diary.topic}\nle vieux port`);
});

test('diary turn: no topic leaves the requests unchanged', async () => {
  const plain = fakeLlm(null, '<msg>brume</msg>');
  await runner({ llm: plain }).runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: { kind: 'status', forced: true },
  });
  for (const topic of [undefined, null, '', '   ']) {
    const llm = fakeLlm(null, '<msg>brume</msg>');
    await runner({ llm }).runTurn({
      channel: diaryChannel(),
      mode: 'diary',
      diary: { kind: 'status', topic, forced: true },
    });
    assert.deepEqual(llm.calls, plain.calls, `topic ${JSON.stringify(topic)}: byte-identical requests`);
  }
  assert.ok(!userOf(plain.calls[0]).includes('<topic>'));
});

test('diary turn: news asks for no search of the code', async () => {
  // Bug: the code still searches for the persona before the turn, so the entry rides on a search it did not choose.
  const llm = fakeLlm(null, '<msg>une comète</msg>');
  const lookup = fakeLookup({ text: 'found', sources: [] });
  await runner({ llm, lookup }).runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: { kind: 'news', forced: true },
  });
  assert.equal(lookup.calls.length, 0);
});

// PR 7d: the kinds and their weights are DIARY_KINDS of src/behavior/diary.ts, and the daily caps that turned the
// pictures off are gone: no image client is what turns them off here.
test('diary turn: with pictures off only a text kind is drawn', async () => {
  for (const roll of [0, 0.3, 0.6, 0.99]) {
    const llm = fakeLlm(null, '<msg>brume</msg>');
    const { logs } = await withCapturedLogs(() =>
      runner({ llm, images: null, rng: () => roll }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} })
    );
    const prepared = logs.find((entry) => entry.msg === 'diary: prepared');
    assert.ok(['story', 'thought', 'people', 'news', 'facts', 'status'].includes(loose(prepared).kind), String(roll));
    assert.equal(loose(prepared).picturesOff, true, 'the log says why');
  }
});

test('diary turn: with pictures allowed a picture kind may be drawn', async () => {
  // The lowest roll takes the first kind after `story`, a picture kind, once pictures are allowed.
  const llm = fakeLlm(null, drawAnswer('<msg>brume</msg>', 1, true));
  const { logs } = await withCapturedLogs(() =>
    runner({ llm, rng: () => 0.2 }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} })
  );
  const prepared = logs.find((entry) => entry.msg === 'diary: prepared');
  assert.equal(loose(prepared).kind, 'selfPicture');
  assert.equal(loose(prepared).picturesOff, undefined);
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
    const llm = fakeLlm(null, '<msg>brume</msg>');
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
  const llm = fakeLlm(null, '<msg>brume</msg>');
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
    null,
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
  const llm = fakeLlm(null, '<skip/>');
  const store = fakeStore();
  const channel = diaryChannel();
  const result = await runner({ llm, store }).runTurn({ channel, mode: 'diary', diary: {} });
  assert.equal(loose(result).outcome, 'skip');
  assert.equal(channel.sent.length, 0);
  assert.equal(store.appended.length, 0);
});

test('diary turn: records the post with gists and message ids', async () => {
  // The lead: the code draws the diary's kind (owner, 2026-11-06).
  const llm = fakeLlm(
    null,
    toolAnswer('<msg>un quai dans la brume, très calme ce soir</msg>', [
      call('draw.create', { people: [], text: 'the persona on a foggy pier at night, lanterns', self: true }),
    ])
  );
  const store = fakeStore();
  const channel = diaryChannel();
  const result = await runner({ llm, store }).runTurn({
    channel,
    mode: 'diary',
    diary: { kind: 'selfPicture', forced: false },
  });
  assert.equal(loose(result).outcome, 'spoke');
  // Stage 3: the outcome also names the entry it recorded (`entry`), beside the same counts.
  assert.deepEqual(diaryCounts(result), {
    kind: 'selfPicture',
    picture: true,
    messages: 1,
    pictures: 1,
  });
  const entry = entryOf(result);
  assert.deepEqual(entry.messages, ['un quai dans la brume, très calme ce soir']);
  assert.equal(store.appended.length, 1);
  // Her diary is the persona's, so the append names no place.
  const { post, opts } = appendedPost(store);
  // Stage 3: the post is recorded before anything is sent, so it carries her full text and the entry's id and no
  // message ids (the receipts of its publications hold those); the turn itself sends nothing.
  assert.deepEqual(
    {
      at: post.at,
      kind: post.kind,
      gist: post.gist,
      picture: post.picture,
      scenes: post.scenes,
      text: post.text,
      itemId: post.itemId,
    },
    {
      at: NOW,
      kind: 'selfPicture',
      gist: 'un quai dans la brume, très calme ce soir',
      picture: 'the persona on a foggy pier at night, lanterns',
      // The line of its scene the director kept, so the next draws leave it out.
      scenes: [{ used: ['a pier'] }],
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
  const llm = fakeLlm(null, toolAnswer('<msg>soir calme</msg>', [call('voice.say', { text: '[tired] soir calme' })]));
  const store = fakeStore();
  const voiced = '[sighs] soir calme';
  const runOwnOp = async (op: Untyped) => ({
    status: 'ok',
    code: 'ok',
    summary: 'voice message posted',
    data: {
      text: 'voice message posted',
      ref: { chatId: 'd1', messageId: 'voice-1' },
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

test('diary turn: an audience named beside a call holds when her messages come in a later answer', async () => {
  // Catches: only the last answer's tag being read, so the restriction she named first falls open to unrestricted.
  const llm = fakeLlm(null, [
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
  const llm = fakeLlm(null, [drawAnswer('<msg>brume</msg>'), '<msg>brume sans image</msg>']);
  const store = fakeStore();
  const images = fakeImages({ fail: new ImageGenError('error') });
  const channel = diaryChannel();
  const { result, logs } = await withCapturedLogs(() =>
    runner({ llm, store, images }).runTurn({ channel, mode: 'diary', diary: {} })
  );
  assert.equal(loose(result).outcome, 'spoke');
  assert.equal(loose(result).drawFailed, undefined);
  // Changed: the kind drawn here takes no scene and the planner is gone, so no request comes before the persona's.
  assert.equal(llm.calls.length, 2, 'the request with the draw, the request after the result');
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
  const llm = fakeLlm(null, drawAnswer(''));
  const images = fakeImages();
  await runner({ llm, images }).runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: {},
  });
  assert.equal(images.prompts.length, 1);
  assert.ok(
    images.prompts[0].includes(fill(labels.draw.when, { when: formatNow(NOW, TZ, labels.locale) })),
    images.prompts[0]
  );
});

test("diary turn: an ordinary turn's draw.create carries the local time too", async () => {
  const hot = fakeHot();
  loose(hot.prompts)['turn/reply'] = 'REPLY for {{author}}';
  const llm = fakeLlm(null, toolAnswer('', [call('draw.create', { people: [], text: 'a pier' })]));
  const images = fakeImages();
  const raw = ownRaw('m1', NOW - 60_000, 'draw a pier');
  raw.author = { id: 'u1', bot: false, globalName: 'Alice', username: 'Alice' };
  raw.member = { displayName: 'Alice' };
  const channel = diaryChannel({ historyMessages: [raw] });
  // Someone asked: a spontaneous turn has no requester, and the gateway refuses a picture nobody asked for.
  const trigger = {
    id: 'm1',
    placeId: 'd1',
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
  const llm = fakeLlm(null, drawAnswer('', 1, true));
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

// ---- set posts (diary.setKinds): several pictures, generated before anything is sent ----------

/** An image client that answers each generate call by the next step: a byte count, or an error to throw. */
function fakeSetImages(steps: Untyped, events: Array<string> = []) {
  const prompts: Array<Untyped> = [];
  let call = 0;
  return {
    prompts,
    events,
    quota: () => ({ used: 0, cap: 50, userUsed: 0, userCap: 5, spent: false, userSpent: false }),
    generate: async ({ prompt, accountId }: { prompt: Untyped; accountId: Untyped }) => {
      prompts.push({ prompt, accountId });
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

test('diary: a single picture is staged while the post is composed, then posted after its messages', async () => {
  // The lead: the code draws the diary's kind (owner, 2026-11-06).
  const events: Array<Untyped> = [];
  const images = fakeSetImages([10], events);
  const store = fakeStore();
  const channel = eventChannel(events);
  const llm = fakeLlm(null, drawAnswer('<msg>un quai</msg>', 1, true));
  const { result, logs } = await withCapturedLogs(() =>
    runner({ llm, store, images }).runTurn({
      channel,
      mode: 'diary',
      diary: { kind: 'selfPicture', forced: false },
    })
  );
  assert.equal(loose(result).outcome, 'spoke');
  // Stage 3: the turn sends nothing; the expectation below is what the mirror's publication of the entry sends.
  await published(result, channel);
  assert.deepEqual(events, ['generate 1', 'msg', 'files 1'], 'generated first, posted after the message');
  assert.deepEqual(calledOf(logs), ['draw.create:ok/staged']);
  assert.equal(llm.calls.length, 2, 'the director and one request of the persona');
  assert.equal(loose(channel.sent.at(-1)).files.length, 1);
  // Stage 3 design, section 3 item 6: the outcome names the entry it recorded; the entry itself is checked by its publication.
  assert.deepEqual(loose(result).diary, {
    kind: 'selfPicture',
    picture: true,
    scenes: loose(result).diary.scenes,
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
  // The lead: the code draws the diary's kind (owner, 2026-11-06).
  const events: Array<Untyped> = [];
  const images = fakeSetImages([3_200_000, 3_200_000, 3_200_000, 7_200_000, 800_000, 400_000], events);
  const store = fakeStore();
  const channel = eventChannel(events);
  const llm = fakeLlm(null, withDraws('<msg>une promenade</msg><msg>au port</msg>', 6, true));
  const { result, logs } = await withCapturedLogs(() =>
    runner({ llm, store, images }).runTurn({
      channel,
      mode: 'diary',
      diary: { kind: 'photoset', forced: false },
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
    images.prompts.every(({ accountId }) => accountId === null),
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
    scenes: loose(result).diary.scenes,
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
  // The lead: the code draws the diary's kind (owner, 2026-11-06).
  const images = fakeSetImages([10, 10, 10, 10, 10, 10]);
  const llm = fakeLlm(null, withDraws('<msg>une promenade</msg>', 6, true));
  const { turns, adapter } = limitedRunner({ hot: fakeHot(), llm, images, limits: { maxFiles: 2 } });
  const result = await turns.runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: { kind: 'photoset', forced: false },
  });
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
  // The lead: the code draws the diary's kind (owner, 2026-11-06).
  const images = fakeSetImages([10, 10, 10, 10, 10, 10]);
  const llm = fakeLlm(null, withDraws('<msg>une promenade</msg>', 6, true));
  const { turns, adapter } = limitedRunner({ hot: fakeHot(), llm, images, limits: { maxFiles: 12 } });
  const result = await turns.runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: { kind: 'photoset', forced: false },
  });
  // Stage 3: the turn sends nothing; the mirror's publication to this adapter puts the set in one message.
  assert.deepEqual(adapter.messagesIn('d1'), [], 'the turn itself sends nothing');
  await published(result, null, adapter);
  const withFiles = adapter.messagesIn('d1').filter((message) => message.attachments.length > 0);
  assert.deepEqual(
    withFiles.map((message) => message.attachments.length),
    [6]
  );
});

test('diary set: calls past diary.set.pictures[1] in one answer are loop-cap results; the speech waits and step 2 posts what was staged', async () => {
  // The lead: the code draws the diary's kind (owner, 2026-11-06).
  const images = fakeSetImages([]);
  const channel = diaryChannel();
  const llm = fakeLlm(null, [withDraws('<msg>x</msg>', 8), '<msg>y</msg>']);
  const { result, logs } = await withCapturedLogs(() =>
    runner({ llm, images }).runTurn({
      channel,
      mode: 'diary',
      diary: { kind: 'photoset', forced: false },
    })
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
  // The lead: the code draws the diary's kind (owner, 2026-11-06).
  const images = fakeSetImages([10, 10, new ImageGenError('error'), 10, 10, 10]);
  const store = fakeStore();
  const channel = diaryChannel();
  const llm = fakeLlm(null, [withDraws('<msg>une promenade</msg>', 6), '<msg>cinq images sur six</msg>']);
  const { result, logs } = await withCapturedLogs(() =>
    runner({ llm, store, images }).runTurn({
      channel,
      mode: 'diary',
      diary: { kind: 'photoset', forced: false },
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

test('diary set: fewer than diary.set.minPosted pictures staged posts nothing and is refused set-short', async () => {
  // The lead: the code draws the diary's kind (owner, 2026-11-06).
  const images = fakeSetImages([10, new ImageGenError('error'), new ImageGenError('error')]);
  const store = fakeStore();
  const channel = diaryChannel();
  const llm = fakeLlm(null, [withDraws('<msg>une promenade</msg>', 3), '<msg>une promenade quand même</msg>']);
  const { result, logs } = await withCapturedLogs(() =>
    runner({ llm, store, images }).runTurn({
      channel,
      mode: 'diary',
      diary: { kind: 'photoset', forced: false },
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
    llm: fakeLlm(null, withDraws('<msg>x</msg>', 1)),
    store: fakeStore(),
    images: fakeSetImages([]),
  }).runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: { kind: 'photoset', forced: false },
  });
  assert.deepEqual([loose(few).outcome, loose(few).reason], ['refused', 'set-short']);
  // A set answered without any picture is short too.
  const bare = await runner({
    llm: fakeLlm(null, '<msg>sans image</msg>'),
    store: fakeStore(),
    images: fakeSetImages([]),
  }).runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: { kind: 'photoset', forced: false },
  });
  assert.deepEqual([loose(bare).outcome, loose(bare).reason], ['refused', 'set-short']);
});

test('diary: a call other than draw.create is refused diary-draw-only and never runs; the picture beside it does', async () => {
  const images = fakeSetImages([10]);
  const channel = diaryChannel();
  const llm = fakeLlm(null, [
    toolAnswer('<msg>x</msg>', [
      call('message.create', { text: 'hello' }),
      call('draw.create', { people: [], text: 'a pier' }),
    ]),
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
  // Changed: the kind drawn here takes no scene and the planner is gone, so the persona's requests are the only ones.
  assert.equal(llm.calls.length, 2, 'the refusal is a result she reads');
  assert.ok(
    contentText(llm.calls[1].find((message: Untyped) => message.role === 'tool').content).includes(
      labels.tools.result.reasons['diary-draw-only']
    )
  );
});

test('diary: an errand is accepted, waits for its end and its result is read in the next request', async () => {
  // Bug caught: the diary turn refuses the errand as diary-draw-only, or answers queued and never reads the result.
  const hot = fakeHot();
  Object.assign(hot.config.bot, { access: { 'errand.scout': { everyone: false, roles: [], users: ['self-id'] } } });
  const waits: Array<unknown> = [];
  const runOp = (op: string, _args: unknown, context: Record<string, unknown>) => {
    waits.push(context.waitMs);
    const text = 'ΤΟ ΑΠΟΤΕΛΕΣΜΑ ΤΟΥ ΗΜΕΡΟΛΟΓΙΟΥ';
    return { status: 'ok', code: 'ok', summary: text, data: { text, task: { id: 'e1' }, waited: true } };
  };
  const errands = { budget: () => ({ spent: false, key: null, code: null }), view: () => [] };
  const llm = fakeLlm(null, [toolAnswer('', [call('errand.scout', { goal: 'find the pier' })]), '<msg>y</msg>']);
  const { logs } = await withCapturedLogs(() =>
    runner({ hot, llm, extra: { runOp, errands } }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} })
  );
  assert.deepEqual(calledOf(logs), ['errand.scout:ok']);
  assert.ok(Number(waits[0]) > 0, 'the call carries the time it may wait');
  // Changed: the kind drawn here takes no scene and the planner is gone, so the persona's requests are the only ones.
  assert.equal(llm.calls.length, 2, 'the request with the call and the request that reads the result');
  assert.ok(JSON.stringify(llm.calls[1]).includes('ΤΟ ΑΠΟΤΕΛΕΣΜΑ ΤΟΥ ΗΜΕΡΟΛΟΓΙΟΥ'));
});

test('diary: a call that only looks runs, the picture runs, and a post is refused diary-draw-only', async () => {
  // Bug caught: the diary turn refuses a search or a read of memory, so the persona cannot look anything up for news.
  const hot = fakeHot();
  Object.assign(hot.config.bot, { access: { 'lore.list': { everyone: false, roles: [], users: ['self-id'] } } });
  const ran: Array<string> = [];
  const runOp = (op: string) => {
    ran.push(op);
    return { status: 'ok', code: 'ok', summary: 'ΤΟ ΛΗΜΜΑ', data: { text: 'ΤΟ ΛΗΜΜΑ' } };
  };
  const llm = fakeLlm(null, [
    toolAnswer('', [
      call('lore.list', {}),
      call('draw.create', { people: [], text: 'a pier' }),
      call('message.create', { text: 'hello' }),
    ]),
    '<msg>y</msg>',
  ]);
  const { logs } = await withCapturedLogs(() =>
    runner({ hot, llm, extra: { runOp } }).runTurn({
      channel: diaryChannel(),
      mode: 'diary',
      diary: { kind: 'picture', forced: true },
    })
  );
  assert.deepEqual(
    calledOf(logs).sort(),
    ['draw.create:ok/staged', 'lore.list:ok', 'message.create:denied/diary-draw-only'],
    'the read and the picture ran, the post did not'
  );
});

test('diary: a single-picture kind stages one picture; a second call is a loop-cap result', async () => {
  const images = fakeSetImages([]);
  const channel = diaryChannel();
  const llm = fakeLlm(null, [withDraws('<msg>x</msg>', 3), '<msg>y</msg>']);
  const result = await runner({ llm, images }).runTurn({ channel, mode: 'diary', diary: {} });
  assert.equal(images.prompts.length, 1);
  // Stage 3: the turn sends nothing; the expectation below is what the mirror's publication of the entry sends.
  await published(result, channel);
  assert.equal(loose(channel.sent.at(-1)).files.length, 1);
  assert.equal(loose(result).diary.pictures, 1);
});

// The diary turn on the turn frame (plan 2026-11-06-turn-frame, slice 6, with the owner's answers of
// 2026-11-07): `chat: null`, `<diary>` in `<inner>` read from the `diary` table, newest
// `diary.entries` for the planner and `diary.writerEntries` for the writer, newest first
// (2026-11-14), `<meanwhile>` as in the service template, and the entry still reaching
// every mirror. tests/fixtures/diary-frame.ts holds the scene.

/** The positions of the gists of entries `from` to `to` (inclusive) in `text`, -1 for an absent one. */
const gistsAt = (text: string, from: number, to: number): Array<number> =>
  Array.from({ length: to - from + 1 }, (_, i) => text.indexOf(gistOf(from + i)));

test('the <diary> holds the newest diary.writerEntries of 200 stored entries newest first', async () => {
  // Bug: the block keeps the old history cut, reads the first mirror's messages, or renders oldest first.
  // Changed: the planner's request, which read `diary.entries`, went with the planner, so this reads the turn's own
  // request under `diary.writerEntries`.
  const run = await frameTurn({ entries: 200, diary: { writerEntries: 150 } });
  const text = run.writer[0] ?? '';
  const block = partOf(blockOf(text, 'inner'), 'diary');
  const kept = gistsAt(block, 50, 199);
  assert.ok(
    kept.every((at) => at >= 0),
    `kept ${kept.filter((at) => at >= 0).length} of 150`
  );
  assert.deepEqual(
    kept,
    [...kept].sort((a, b) => b - a),
    'newest first'
  );
  assert.ok(
    gistsAt(block, 0, 49).every((at) => at < 0),
    'the 50 oldest are left out'
  );
});

test('<diary> reads no mirror place', async () => {
  // Bug: the entries are rebuilt from the mirror's history, through the interface or from her stored lines there.
  const run = await frameTurn({ entries: 3 });
  const block = partOf(blockOf(run.writer[0] ?? '', 'inner'), 'diary');
  assert.ok(block.includes(gistOf(2)), block);
  assert.ok(!block.includes(FRAME_TEXT.mirrorOnly), block);
  const { port } = run;
  const reads = port.calls.filter((one: { op: string }) => one.op === 'history' || one.op === 'fetchMessages');
  assert.deepEqual(reads, []);
});

test("the diary turn's <diary> is cut at diary.writerEntries", async () => {
  // Bug: the turn keeps 150 entries and ships twenty thousand characters of her own past on every entry.
  const run = await frameTurn({ entries: 8, diary: { writerEntries: 3 } });
  const block = partOf(blockOf(run.writer[0] ?? '', 'inner'), 'diary');
  assert.deepEqual(
    gistsAt(block, 0, 7).map((at) => at >= 0),
    [false, false, false, false, false, true, true, true]
  );
});

test('two diary requests with nothing stored between them hold the same <kind> and <diary>', async () => {
  // Bug: something per request (a clock, a draw, an unordered set) enters the list and breaks the cache.
  // Her answer skips, so the first turn stores nothing for the second to read.
  const run = await frameTurn({ entries: 6, answer: '<skip/>', turns: 2 });
  assert.equal(run.writer.length, 2, 'one request per turn');
  const [first = '', second = ''] = run.writer.map((text) => blockOf(text, 'inner'));
  assert.equal(partOf(first, 'kind'), 'status');
  assert.equal(partOf(second, 'kind'), partOf(first, 'kind'));
  assert.notEqual(partOf(first, 'diary'), '');
  assert.equal(partOf(second, 'diary'), partOf(first, 'diary'));
});

test('the diary turn lists the group rooms of two interfaces in <memory>, no direct chat, and holds no <meanwhile>', async () => {
  // Bug: the diary keeps the chat turns' `<meanwhile>`, reads one interface, or lets a private chat in.
  const run = await frameTurn({ memorySettings: { openPrivate: false } });
  const text = run.writer[0] ?? '';
  const memory = blockOf(text, 'memory');
  assert.ok(memory.includes('"κήπος"'), memory);
  assert.ok(memory.includes('"λιμάνι"'), memory);
  assert.ok(!memory.includes('dm with'), memory);
  assert.equal(blockOf(text, 'meanwhile'), '');
});

test('with context.memory.openPrivate on, the diary turn lists the direct chat and the group entry reaches its mirror', async () => {
  // Bug: the switch opens her memory, but the diary still reads the groups alone, or the open read leaks into the
  // entry's audience and the publication boundary refuses the copy.
  const scene = await mirrorScene({ start: FRAME_NOW, config: { context: { memory: { openPrivate: true } } } });
  const run = await frameTurn({ memory: scene.memory, entries: 0, memorySettings: { openPrivate: true } });
  assert.ok(blockOf(run.writer[0] ?? '', 'memory').includes('dm with'));
  const stored = scene.db.prepare('SELECT scope_kind, scope_dm FROM diary').all();
  assert.deepEqual(
    stored.map((row) => [row.scope_kind, row.scope_dm]),
    [['group', null]]
  );
  const mirrors = scene.publisher();
  await mirrors.publishEntry(entryOf(run.result));
  await mirrors.drainQueued();
  assert.deepEqual(scene.transport('fake').posted('d1'), [FRAME_TEXT.entry]);
});

test('an entry recorded with chat null reaches every mirror', async () => {
  // Bug: with no chat the turn records nothing, or the entry only goes to the place the turn used to run in.
  const scene = await mirrorScene({ ifaces: ['fake', 'tele'], start: FRAME_NOW });
  // No earlier entry, so the drain has only this one to send.
  const run = await frameTurn({ memory: scene.memory, mirrors: [JOURNAL, PAGES], entries: 0 });
  const mirrors = scene.publisher();
  await mirrors.publishEntry(entryOf(run.result));
  await mirrors.drainQueued();
  assert.deepEqual(scene.transport('fake').posted('d1'), [FRAME_TEXT.entry]);
  assert.deepEqual(scene.transport('tele').posted('k9'), [FRAME_TEXT.entry]);
});

test('an <audience> naming a group room that is no mirror is refused, and the entry goes nowhere', async () => {
  // Bug: her choice is checked against every group place memory knows, so a room that is no mirror passes.
  const scene = await mirrorScene({ ifaces: ['fake', 'tele'], start: FRAME_NOW });
  const run = await frameTurn({
    memory: scene.memory,
    mirrors: [JOURNAL, PAGES],
    entries: 0,
    answer: `<audience>place:fake:channel:c2</audience><msg>${FRAME_TEXT.entry}</msg>`,
  });
  const mirrors = scene.publisher();
  await mirrors.publishEntry(entryOf(run.result));
  await mirrors.drainQueued();
  const reasons = mirrors.mirrorStatus().flatMap((mirror) => mirror.audienceBlocked.map((one) => one.reason));
  assert.deepEqual(reasons, ['audience-unknown-place', 'audience-unknown-place']);
  assert.deepEqual(scene.transport('fake').attempts, []);
  assert.deepEqual(scene.transport('tele').attempts, []);
});

// The diary wake keeps the id of its turn on the entry as `extra.turnId`, written through the one writer. The
// wake runs the real turn runner over tests/fixtures/diary-scene.ts with a real journal. Invented ids and
// synthetic text only.

/** The scenes a test opened, closed when the file is done. */
const OPEN: Array<SceneMemory> = [];

/** The `extra` of a stored entry, parsed. */
function extraOf(db: ReturnType<typeof dbOf>, entryId: string): Record<string, unknown> {
  const raw = db.prepare('SELECT extra FROM diary WHERE id = ?').get(entryId)?.extra;
  assert.ok(typeof raw === 'string', `the entry ${entryId} has its extra`);
  return JSON.parse(raw) as Record<string, unknown>;
}
after(async () => {
  for (const scene of OPEN.splice(0)) await scene.memory.close();
});

// The lead: kept when the removal command went (owner, 2026-11-06).
test('an entry written by a diary wake keeps the id of its turn as extra.turnId', async () => {
  // Bug: the entry is stored with no link to the turn that wrote it.
  const scene = await sceneMemory();
  OPEN.push(scene);
  sceneWorld();
  const { memoryDb, dataDir } = scene.memory;
  const runner = worldTurnRunner({
    hot: sceneHot(),
    store: scene.store,
    llm: sceneLlm(),
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    images: null,
    lookup: null,
    rng: () => 0.5,
    now: () => NOW_ID,
    journal: createJournal({ memoryDb, dataDir, now: () => NOW_ID }),
  });
  // The world runner answers its result untyped; the wake names its outcome, its turn and its entry.
  const result = (await runner.runTurn({
    mode: 'diary',
    diary: { kind: null, forced: false },
    placeId: 'g1',
  })) as { outcome?: unknown; turnId?: unknown; diary?: { entry?: { id?: unknown } } };
  assert.equal(result.outcome, 'spoke', 'the wake records an entry');
  const reflection = result.diary;
  const entryId = reflection?.entry?.id;
  assert.ok(typeof entryId === 'string' && typeof result.turnId === 'string', 'the wake names its entry and its turn');
  scene.store.flush();
  await scene.store.flushSettled({});
  assert.equal(extraOf(dbOf(memoryDb.readHandle() as { db: unknown }), entryId).turnId, result.turnId);
});

test('the diary requests are the same bytes with a heartbeat seeds file beside them', async () => {
  // Bug: the heartbeat's fragments or its lists leak into a diary request, which shares the heartbeat's path nowhere.
  const plain = await frameTurn();
  const seeded = await frameTurn({
    prompts: { 'heartbeat/seeds/one': 'ΘΡΑΥΣΜΑ-ΕΝΑ', 'heartbeat/seeds/two': 'ΘΡΑΥΣΜΑ-ΔΥΟ' },
  });
  assert.equal(seeded.writer[0], plain.writer[0]);
  assert.ok(!(seeded.writer[0] ?? '').includes('ΘΡΑΥΣΜΑ'));
});

// ---- voiced entries ----------------------------------------------------------------

const VOICE_PART = 'VOICE_PART';
const TEXT_KINDS = ['status', 'story', 'thought', 'people', 'news', 'facts'];
const PICTURE_KINDS = ['selfPicture', 'picture', 'photoset', 'randomSet', 'meme'];

/** A diary setting where the role `speech` has a route (or none with `speech: false`) and `diary.voiceChance` is `chance`. */
function voiceHot({ chance, speech = true }: { chance?: number; speech?: boolean } = {}) {
  const hot = fakeHot({
    diary: chance === undefined ? {} : { voiceChance: chance },
    prompts: { 'diary/voice': VOICE_PART },
  });
  Object.assign(hot.config, { models: { routes: chainsOf({ speech: speech ? 'x/speech' : null }) } });
  return hot;
}

/** The `<task>` of the persona's first request in a diary turn of `kind` at a constant `roll`. */
async function voicedTask(
  kind: string,
  roll: number,
  hot: ReturnType<typeof voiceHot>,
  extra: Record<string, unknown> = {}
) {
  const llm = fakeLlm(null, '<skip/>');
  await runner({ hot, llm, rng: () => roll, extra }).runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: { kind, forced: true },
  });
  const at = (llm.options as Array<{ purpose?: unknown } | null>).findIndex((one) => one?.purpose !== 'diary-scene');
  return /<task>\n([\s\S]*?)\n<\/task>/.exec(userOf(llm.calls[at]))?.[1] ?? '';
}

test('diary voice: with diary.voiceChance at 1 every text kind is voiced and no picture kind', async () => {
  // Bug: a picture entry is told to speak, or a text kind is never voiced.
  for (const kind of TEXT_KINDS)
    assert.ok((await voicedTask(kind, 0.5, voiceHot({ chance: 1 }))).endsWith(VOICE_PART), kind);
  for (const kind of PICTURE_KINDS)
    assert.ok(!(await voicedTask(kind, 0.5, voiceHot({ chance: 1 }))).includes(VOICE_PART), kind);
});

test('diary voice: with diary.voiceChance at 0 no entry is voiced', async () => {
  for (const kind of TEXT_KINDS)
    assert.ok(!(await voicedTask(kind, 0, voiceHot({ chance: 0 }))).includes(VOICE_PART), kind);
});

test('diary voice: the default chance voices a text entry below 0.1 and not above it', async () => {
  assert.ok((await voicedTask('status', 0.05, voiceHot())).endsWith(VOICE_PART));
  assert.ok(!(await voicedTask('status', 0.15, voiceHot())).includes(VOICE_PART));
});

test('diary voice: with the role speech off no entry is voiced at any roll', async () => {
  // Bug: the persona is told to speak with a tool it is not offered.
  for (const roll of [0, 0.05, 0.5])
    assert.ok(!(await voicedTask('status', roll, voiceHot({ chance: 1, speech: false }))).includes(VOICE_PART));
});

test("diary voice: with voice.say filtered out of the turn's tools no entry is voiced", async () => {
  const skills = new Map([...defaultSkills()].filter(([name]) => name !== 'voice.say'));
  assert.ok(!(await voicedTask('status', 0, voiceHot({ chance: 1 }), { skills })).includes(VOICE_PART));
});

test('diary voice: an entry of the voice alone is recorded with its voiced text and ends spoke', async () => {
  // Bug: a voiced entry with no <msg> counts as no speech, so the voice is made and the entry is lost.
  const store = fakeStore();
  const llm = fakeLlm(null, [toolAnswer('', [call('voice.say', { text: 'bonsoir' })]), '<skip/>']);
  const speech = {
    say: ({ text }: { text: string }) =>
      Promise.resolve({
        ogg: new Uint8Array(1),
        durationSecs: 2,
        waveform: '',
        voiced: `[soft] ${text}`,
      }),
  };
  const result = await runner({ hot: voiceHot({ chance: 1 }), store, llm, rng: () => 0, extra: { speech } }).runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: { kind: 'status', forced: true },
  });
  assert.equal(loose(result).outcome, 'spoke');
  assert.equal(loose(appendedPost(store).post.voice).text, '[soft] bonsoir');
});
