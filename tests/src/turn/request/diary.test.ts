import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SnowflakeUtil } from 'discord.js';
import { normalizeMessage } from '../../../../interfaces/discord/index.ts';
import type { createFakeAdapter } from '../../../../scripts/lib/fake.ts';
import { userText as textOf, userText } from '../../../../src/behavior/prompt.ts';
import { createTurnRunner as createRealTurnRunner } from '../../../../src/behavior/turn.ts';
import { deepMerge } from '../../../../src/config.ts';
import { joinLabels } from '../../../../src/config/labels.ts';
import { fill } from '../../../../src/format.ts';
import { createCalibrator } from '../../../../src/llm/tokens.ts';
import { withTextPreviews } from '../../../../src/media/text-preview.ts';
import { objectMediaCache } from '../../../../src/memory/store-media.ts';
import { createStore } from '../../../../src/memory/store.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, utcDay } from '../../../../src/time.ts';
import '../../../../src/tools/operations/index.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import { buildRequest, type Built } from '../../../fixtures/built-request.ts';
import { chainsOf } from '../../../fixtures/chains.ts';
import { blockOf, frameTurn, gistOf, JOURNAL, PAGES, partOf } from '../../../fixtures/diary-frame.ts';
import {
  entriesPart,
  GISTS,
  historyMemory,
  type HistoryMemory,
  historyRunner,
  historyWorld,
  PICTURE,
} from '../../../fixtures/diary-history.ts';
import { entryOf, seedMirror } from '../../../fixtures/diary-mirror.ts';
import { ROOT, sceneLlm, sceneRunner } from '../../../fixtures/diary-requests-recorded.ts';
import type { SceneMemory } from '../../../fixtures/diary-scene.ts';
import type { labels as contractLabels } from '../../../fixtures/labels.ts';
import { labels } from '../../../fixtures/labels.ts';
import { mirrorScene, type Scene, T0 } from '../../../fixtures/mirror-scene.ts';
import { framed } from '../../../fixtures/prompt-rig.ts';
import { directorAnswer } from '../../../fixtures/scene-answer.ts';
import { completionOf } from '../../../fixtures/tool-answers.ts';
import { type Channel, freshWorld, onWorld, useIface, useSelf, world } from '../../../fixtures/turn-world.ts';

const TEXT = 'ήσυχο βράδυ στο λιμάνι';

/** Two interfaces with one mirror each, and one store over their memory. */
async function setting() {
  const scene = await mirrorScene({ ifaces: ['fake', 'other'] });
  seedMirror(scene.memory.memoryDb, { iface: 'fake', chatId: 'd1', at: T0 });
  seedMirror(scene.memory.memoryDb, { iface: 'other', chatId: 'd1', at: T0 });
  return { scene, store: createStore({ dataDir: scene.memory.dataDir, memoryDb: scene.memory.memoryDb }) };
}

type Setting = { scene: Scene; store: ReturnType<typeof createStore> };

/** One diary turn in which the persona's writer answers `answer`, or fails when it is null: the result and the writer's request. */
async function turn({ store }: Setting, answer: string | null, extra: Record<string, unknown> = {}) {
  freshWorld();
  world().channel({ id: 'd1', name: 'journal', placeId: ROOT });
  const calls: Array<unknown> = [];
  const model = {
    calls,
    complete: (messages: unknown, options?: { purpose?: string }) => {
      calls.push(structuredClone(messages));
      const scene = directorAnswer(messages, options);
      if (scene) return Promise.resolve(scene);
      if (answer === null) return Promise.reject(Object.assign(new Error('provider down'), { statusCode: 500 }));
      return Promise.resolve({ text: answer, usage: {}, estimated: 5 });
    },
  };
  const result = await sceneRunner(model, store).runTurn({
    mode: 'diary',
    diary: { kind: 'thought', forced: true },
    placeId: ROOT,
    ...extra,
  });
  await store.flushSettled({});
  return { result, writer: calls.at(-1) };
}

/** Every string of a request, joined. */
function requestText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(requestText).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(requestText).join('\n');
  return '';
}

/**
 * The body of the request's `<feedback>` part of `<inner>`, or null when it has none. In these scenes nothing else
 * failed, so the part holds the refused audiences alone.
 */
function refusalBlock(request: unknown): string | null {
  // Slice 6: the refused audiences are told in `<feedback>` inside `<inner>`, which replaces `<audience_refused>`.
  return /<feedback>([\s\S]*?)<\/feedback>/.exec(requestText(request))?.[1] ?? null;
}

test('an entry with a readable audience blocks nothing and tells the persona nothing', async () => {
  // Catches: every entry reported, or a block that shows up on an ordinary diary request.
  const setup = await setting();
  await turn(setup, `<msg>${TEXT}</msg>`);
  const { writer } = await turn(setup, `<audience>interface:fake</audience><msg>${TEXT}</msg>`);
  assert.equal(refusalBlock(writer), null);
  assert.deepEqual(
    setup.scene
      .publisher()
      .mirrorStatus()
      .flatMap((mirror) => mirror.audienceBlocked),
    []
  );
});

for (const [value, code] of [
  ['place:fake:channel:nowhere', 'audience-unknown-place'],
  ['interface:nothing', 'audience-unknown-interface'],
  ['everywhere', 'audience-malformed'],
] as const) {
  test(`the persona's next diary request tells them why, for ${code}`, async () => {
    // Catches: the same words for every failure, which would not tell the persona what to name differently.
    const setup = await setting();
    await turn(setup, `<audience>${value}</audience><msg>${TEXT}</msg>`);
    const { writer } = await turn(setup, `<msg>${TEXT}</msg>`);
    const reasons = labels.diary.audienceReasons;
    assert.ok(refusalBlock(writer)?.includes(reasons[code]));
  });
}

/** The scenes of the tests, closed when the file is done. */
const HISTORIES: Array<HistoryMemory> = [];

after(async () => {
  for (const scene of HISTORIES.splice(0)) await scene.memory.close();
});

/** The writer's `<diary>` of the history scene's turn; `port` replaces the world's interface. */
async function writerEntries(port: ReturnType<typeof createFakeAdapter> | null = null): Promise<string> {
  const scene = await historyMemory();
  HISTORIES.push(scene);
  // The interface knows the diary channel with Alice's line in it: it is there, and it is not the persona's.
  historyWorld({ history: true, alice: true });
  const llm = sceneLlm();
  const result = await historyRunner(llm, scene, port).runTurn({
    mode: 'diary',
    diary: { kind: null, forced: false },
    placeId: ROOT,
  });
  assert.equal((result as { outcome?: unknown }).outcome, 'spoke', 'the scene records an entry');
  return entriesPart(llm);
}

test("the writer's <diary> holds the persona's five entries from memory newest first, the picture described", async () => {
  // Bug: the persona's entries do not reach the writer, come back oldest first, or the picture post loses what they saw in it.
  // Slice 6: the entries are `<diary>` in `<inner>`, read from the diary table, where the writer's
  // `<chat>` of the diary channel stood.
  const part = await writerEntries();
  const at = GISTS.map((gist) => part.indexOf(gist));
  assert.ok(
    at.every((one) => one >= 0),
    part
  );
  assert.deepEqual(
    at,
    [...at].sort((a, b) => b - a),
    'newest first'
  );
  assert.ok(part.includes(PICTURE.description), part);
});

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
      'diary/kinds/thought': 'THOUGHT_TASK',
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
  // The code draws the diary's kind.
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

// The diary turn on the turn frame: `chat: null`, `<diary>` in `<inner>` read from the `diary` table, newest
// `diary.entries` for the planner and `diary.writerEntries` for the writer, newest first
// (2026-11-14), `<meanwhile>` as in the service template, and the entry still reaching
// every mirror. tests/fixtures/diary-frame.ts holds the scene.

/** The positions of the gists of entries `from` to `to` (inclusive) in `text`, -1 for an absent one. */
const gistsAt = (text: string, from: number, to: number): Array<number> =>
  Array.from({ length: to - from + 1 }, (_, i) => text.indexOf(gistOf(from + i)));

// The diary wake keeps the id of its turn on the entry as `extra.turnId`, written through the one writer. The
// wake runs the real turn runner over tests/fixtures/diary-scene.ts with a real journal. Invented ids and
// synthetic text only.

/** The scenes a test opened, closed when the file is done. */
const OPEN: Array<SceneMemory> = [];

after(async () => {
  for (const scene of OPEN.splice(0)) await scene.memory.close();
});

describe('a diary turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('diary turn: a topic becomes a <topic> part of <inner>', async () => {
    const llm = fakeLlm(null, '<msg>brume</msg>');
    await runner({ llm }).runTurn({
      channel: diaryChannel(),
      mode: 'diary',
      diary: { kind: 'thought', topic: '  le vieux  port\n ', forced: true },
    });
    const inner = blockOf(userOf(llm.calls[0]), 'inner');
    assert.equal(partOf(inner, 'topic'), `${labels.diary.topic}\nle vieux port`);
  });

  test('diary turn: no topic leaves the requests unchanged', async () => {
    const plain = fakeLlm(null, '<msg>brume</msg>');
    await runner({ llm: plain }).runTurn({
      channel: diaryChannel(),
      mode: 'diary',
      diary: { kind: 'thought', forced: true },
    });
    for (const topic of [undefined, null, '', '   ']) {
      const llm = fakeLlm(null, '<msg>brume</msg>');
      await runner({ llm }).runTurn({
        channel: diaryChannel(),
        mode: 'diary',
        diary: { kind: 'thought', topic, forced: true },
      });
      assert.deepEqual(llm.calls, plain.calls, `topic ${JSON.stringify(topic)}: byte-identical requests`);
    }
    assert.ok(!userOf(plain.calls[0]).includes('<topic>'));
  });

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

  test("the diary turn's <diary> is cut at diary.writerEntries", async () => {
    // Bug: the turn keeps 150 entries and ships twenty thousand characters of the persona's own past on every entry.
    const run = await frameTurn({ entries: 8, diary: { writerEntries: 3 } });
    const block = partOf(blockOf(run.writer[0] ?? '', 'inner'), 'diary');
    assert.deepEqual(
      gistsAt(block, 0, 7).map((at) => at >= 0),
      [false, false, false, false, false, true, true, true]
    );
  });
});

const D1 = 'fake:channel:d1';

const OTHER_D1 = 'other:channel:d1';

/** A model whose plan is a thought and whose writer says `answer`; it keeps every request. */
function modelSaying(answer: string) {
  const calls: Array<unknown> = [];
  return {
    calls,
    complete: (messages: unknown, options?: { purpose?: string }) => {
      calls.push(structuredClone(messages));
      return Promise.resolve(directorAnswer(messages, options) ?? { text: answer, usage: {}, estimated: 5 });
    },
  };
}

/** Every string of a request, joined: what the blocks are read from. */
function mirrorAudienceRequestText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(mirrorAudienceRequestText).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(mirrorAudienceRequestText).join('\n');
  return '';
}

/** The words of one block of a request, or null when the request has no such block. */
function blockWords(request: unknown, tag: string): Array<string> | null {
  const found = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(mirrorAudienceRequestText(request));
  return found ? (found[1] ?? '').split(/\s+/).filter(Boolean) : null;
}

/**
 * Two interfaces that share native ids: `fake` and `other`, each with a root `g1` and a channel `d1`, `fake` with
 * another channel `d2` and a channel `d3` outside the root, a private chat, and enabled mirrors as named.
 */
async function places(mirrorOn: ReadonlyArray<'fake:d1' | 'fake:d2' | 'fake:d3' | 'other:d1'> = []) {
  const scene = await mirrorScene({ ifaces: ['fake', 'other'] });
  const fakeRoot = scene.place({ iface: 'fake', native: 'g1', kind: 'root' });
  const otherRoot = scene.place({ iface: 'other', native: 'g1', kind: 'root' });
  scene.place({ iface: 'fake', native: 'd1', parent: fakeRoot });
  scene.place({ iface: 'fake', native: 'd2', parent: fakeRoot });
  scene.place({ iface: 'fake', native: 'd3' });
  scene.place({ iface: 'other', native: 'd1', parent: otherRoot });
  scene.place({ iface: 'fake', native: 'u1', kind: 'dm' });
  for (const one of mirrorOn) {
    const [iface, chatId] = one.split(':') as [string, string];
    scene.db
      .prepare(
        "INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by, extra) VALUES (?, 'diary', ?, 1, ?, 'owner', NULL)"
      )
      .run(`mirror:test:${one}`, `${iface}:channel:${chatId}`, new Date(T0).toISOString());
  }
  return scene;
}

/** One diary turn in which the persona answers `answer`, over the scene's memory: the turn's result and the model's requests. */
async function writeEntry(scene: Scene, answer: string) {
  freshWorld();
  world().channel({ id: 'd1', name: 'journal', placeId: ROOT });
  const store = createStore({ dataDir: scene.memory.dataDir, memoryDb: scene.memory.memoryDb });
  const model = modelSaying(answer);
  const result = await sceneRunner(model, store).runTurn({
    mode: 'diary',
    diary: { kind: 'thought', forced: true },
    placeId: ROOT,
  });
  await store.flushSettled({});
  return { result, entry: entryOf(result), store, writer: model.calls.at(-1) };
}

test('a diary request lists its mirrors by canonical id with their interfaces and leaves out private ones', async () => {
  // Catches: raw native ids the persona could not tell apart, or a private chat offered as an audience.
  // Slice 6: the places the persona may choose among are the mirrors, listed with two or more, so the scene has two mirrors
  // that share the native id `d1` on two interfaces.
  const scene = await places(['fake:d1', 'other:d1']);
  const { writer } = await writeEntry(scene, `<msg>${TEXT}</msg>`);
  const words = blockWords(writer, 'publication_places');
  assert.ok(words, 'the writer request has the block');
  for (const token of ['interface:fake', 'interface:other', `place:${D1}`, `place:${OTHER_D1}`])
    assert.ok(words.includes(token), token);
  assert.equal(
    words.some((word) => word.includes(':dm:')),
    false
  );
});

const PROMPT_DIARY_NOW = Date.UTC(2026, 8, 20, 10, 0, 0);

const MIN = 60_000;

const DAY = 24 * 60 * MIN;

function identityCalibrator() {
  return { ratio: 1, apply: (n: number) => n };
}

function fakePrompts(overrides: Record<string, unknown> = {}) {
  return {
    main: 'SYSTEM_TEXT for {{name}}',
    persona: 'CARD_TEXT',
    rules: 'RULES_TEXT',
    format: 'FORMAT_TEXT',
    'turn/reply': 'REPLY_TASK',
    interject: 'INTERJECT_TASK',
    'diary/task': 'DIARY_TASK for {{name}}',
    labels,
    ...overrides,
  };
}

function fakeConfig(overrides: { context?: object; features?: object; llm?: object; diary?: object } = {}) {
  return {
    bot: { timezone: 'UTC' },
    context: {
      gapMarkerMinutes: 20,
      maxMessageChars: 800,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500 },
      vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
      tempo: { liveMessages10min: 4, deadSilenceMinutes: 45 },
      ...overrides.context,
    },
    features: {
      vision: true,
      relationships: true,
      episodes: true,
      lore: true,
      recent: true,
      imageGeneration: true,
      ...overrides.features,
    },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9, ...overrides.llm },
    memory: { recentHours: 72 },
    diary: { historyPosts: 150, ...overrides.diary },
  };
}

function makeMessage(id: number | string, ts: number, overrides = {}) {
  return {
    id: String(id),
    ts,
    authorId: `author-${id}`,
    authorName: `User${id}`,
    self: false,
    content: `content of message ${id}`,
    attachments: [],
    stickers: [],
    replyToId: null,
    ...overrides,
  };
}

function baseInput(overrides = {}) {
  const input = {
    config: fakeConfig(),
    prompts: fakePrompts(),
    calibrator: identityCalibrator(),
    mode: 'reply',
    now: PROMPT_DIARY_NOW,
    selfName: 'Nept',
    history: [makeMessage(1, PROMPT_DIARY_NOW - MIN)],
    neighbors: [],
    trigger: null,
    triggerKind: null,
    placeMemory: {},
    interlocutor: null,
    otherProfiles: [],
    ...overrides,
  };
  // Every request is built on its turn frame (slice 7).
  return framed(input);
}

// The whole user text, every cache part: the stable part always carries the static senses lines.
const promptDiaryUserText = ({ messages }: Built) => textOf(messages[1].content);

const post = (at: number, kind: string | null, gist: string, picture: string | null = null) => ({
  at,
  kind,
  gist,
  picture,
  messageIds: [],
  search: null,
});

test('buildRequest: no diary blocks outside diary mode, and no <diary> or <scene> without entries or scenes', () => {
  const diary = { posts: [post(PROMPT_DIARY_NOW - DAY, 'thought', 'bonjour')], kind: 'story', scenes: ['A PIER'] };
  const reply = promptDiaryUserText(buildRequest(baseInput({ mode: 'reply', diary })));
  for (const tag of ['diary', 'kind', 'scene']) assert.ok(!reply.includes(`<${tag}>`), tag);

  const bare = promptDiaryUserText(
    buildRequest(baseInput({ mode: 'diary', diary: { posts: [], kind: 'thought', scenes: [] } }))
  );
  assert.ok(!bare.includes('<diary>') && !bare.includes('<scene>'));
  assert.ok(bare.includes('<kind>\nthought\n</kind>'), bare);
});

/** The `<task>` of a diary request of `kind` over the prompts `overrides` laid on the fake ones. */
function diaryTask(kind: string, overrides: Record<string, unknown> = {}): string {
  const text = promptDiaryUserText(
    buildRequest(baseInput({ mode: 'diary', prompts: fakePrompts(overrides), diary: { posts: [], kind, scenes: [] } }))
  );
  return /<task>\n([\s\S]*?)\n<\/task>/.exec(text)?.[1] ?? '';
}

const KIND_FILES = { 'diary/kinds/story': 'STORY_PART', 'diary/kinds/randomSet': 'RANDOM_SET_PART' };

test('the task of a diary entry is the common text and then the file of its kind', () => {
  // Bug: the persona reads every kind's instructions, or another kind's, or none.
  assert.equal(diaryTask('story', KIND_FILES), 'DIARY_TASK for Nept\n\nSTORY_PART');
  assert.equal(diaryTask('randomSet', KIND_FILES), 'DIARY_TASK for Nept\n\nRANDOM_SET_PART');
});

test("a deployment's own diary text replaces the common text and keeps the kind's file", () => {
  assert.equal(diaryTask('story', { ...KIND_FILES, 'diary/task': 'OWN_TASK' }), 'OWN_TASK\n\nSTORY_PART');
});

test("a deployment's own kind file replaces only that kind's part", () => {
  const own = { ...KIND_FILES, 'diary/kinds/story': 'OWN_STORY' };
  assert.equal(diaryTask('story', own), 'DIARY_TASK for Nept\n\nOWN_STORY');
  assert.equal(diaryTask('randomSet', own), 'DIARY_TASK for Nept\n\nRANDOM_SET_PART');
});

test('a kind whose file is emptied gets the common text alone', () => {
  assert.equal(diaryTask('story', { ...KIND_FILES, 'diary/kinds/story': '  ' }), 'DIARY_TASK for Nept');
});

test('<publication_places> is absent with one mirror', async () => {
  // Bug: the list shows with nothing to choose, or lists every group room memory knows.
  const run = await frameTurn({ mirrors: [JOURNAL] });
  assert.ok(!(run.writer[0] ?? '').includes('<publication_places>'));
});

test('<publication_places> in <inner> lists two mirrors, each on its own line with its interface, and no other room', async () => {
  // Bug: the part lists every group place of memory (`c2` here), or drops the interface a mirror is on.
  const run = await frameTurn({ mirrors: [JOURNAL, PAGES] });
  const part = partOf(blockOf(run.writer[0] ?? '', 'inner'), 'publication_places');
  const lines = part.split('\n');
  const journal = lines.findIndex((line) => line.includes('fake:channel:d1') && line.includes('fake'));
  const pages = lines.findIndex((line) => line.includes('tele:channel:k9') && line.includes('tele'));
  assert.ok(journal >= 0 && pages >= 0 && journal !== pages, part);
  assert.ok(!part.includes('fake:channel:c2'), part);
});

// ---- the earlier entries of the same kind -----------------------------------------

test('a facts turn lists in <told> a facts entry older than <diary> shows, and no entry of another kind', async () => {
  // Bug: a kind's history beyond the newest entries is invisible, so a facts entry repeats a subject of an older one.
  const facts = new Set([0, 35]);
  const run = await frameTurn({
    entries: 40,
    entryKind: (index) => (facts.has(index) ? 'facts' : 'thought'),
    kind: 'facts',
  });
  const inner = blockOf(run.writer[0] ?? '', 'inner');
  const told = partOf(inner, 'told');
  assert.ok(told.includes(gistOf(0)), told);
  assert.ok(!told.includes(gistOf(1)), 'no entry of another kind');
  assert.ok(!told.includes(gistOf(35)), 'an entry <diary> shows is not told again');
  assert.ok(partOf(inner, 'diary').includes(gistOf(35)));
});

test('a turn whose kind has no entry beyond <diary> has no <told>', async () => {
  const run = await frameTurn({ entries: 5, kind: 'facts', entryKind: () => 'facts' });
  assert.ok(!(run.writer[0] ?? '').includes('<told>'));
});

/** The fixed words of a label before its first placeholder. */
const labelHead = (label: string) => label.split('{')[0];

// ---- the shipped layer --------------------------------------------------------

const PROMPTS_SHIPPED_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const PROMPTS_DIR = path.join(PROMPTS_SHIPPED_ROOT, 'prompts');

/** The tracked prompt files at any depth, by key: the path relative to prompts/ without `.md`, `/` between the parts. */
const PROMPT_FILES = fs
  .readdirSync(PROMPTS_DIR, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.md'))
  .map((file) => file.slice(0, -'.md'.length).split(path.sep).join('/'))
  .sort();

const BOM = String.fromCharCode(0xfeff);

/** `prompts/<name>.md` as src/hot.ts reads it: the BOM and carriage returns dropped, trimmed. */
function readPrompt(name: string) {
  const text = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8');
  return (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n/g, '\n').trim();
}

/** The tracked layer alone: config/ with the labels read joined, and prompts/, never a local override. */
const SHIPPED = {
  config: JSON.parse(fs.readFileSync(path.join(PROMPTS_SHIPPED_ROOT, 'config', 'config.json'), 'utf8')),
  prompts: {
    ...Object.fromEntries(PROMPT_FILES.map((name) => [name, readPrompt(name)])),
    labels: joinLabels(JSON.parse(fs.readFileSync(path.join(PROMPTS_SHIPPED_ROOT, 'config', 'labels.json'), 'utf8'))),
  },
};

// The shipped labels carry the keys of the contract (the fixture covers every one).
const LABELS = SHIPPED.prompts.labels as typeof contractLabels;

/**
 * A prompt that carries `{{` or a `{key}` as text on purpose: its file name -> `{ literal, why }`.
 * The literal may remain in a request; anything else in braces may not. None today.
 */
const LITERAL_BRACES: Record<string, { literal: string; why: string }> = {};

/** `text` without the literals of LITERAL_BRACES. */
function withoutLiterals(text: string) {
  let rest = text;
  for (const { literal } of Object.values(LITERAL_BRACES)) rest = rest.split(literal).join('');
  return rest;
}

// The rules prompt reaches a request only while the memory table `rules` holds a rule (src/rules-list.ts). The requests
// here are built with no memory, the way a deployment starts, so it stays in NOT_BUILT: putting it in SYSTEM would mean
// a rule in every fixture, and tests/src/rules-list.test.ts already checks the block with and without one.
const SYSTEM = ['main', 'persona', 'format'];

/** Every kind of diary entry and the prompt file of its own task, which follows the common `diary/task.md`. */
const DIARY_KIND_FILES: Record<string, string> = Object.fromEntries(
  ['story', 'selfPicture', 'picture', 'photoset', 'randomSet', 'news', 'facts', 'thought', 'people', 'meme'].map(
    (kind) => [kind, `diary/kinds/${kind}`]
  )
);

/** The prompt files each request below must carry whole, by request. */
const LOADS = {
  reply: [...SYSTEM, 'turn/reply'],
  followUp: [...SYSTEM, 'turn/follow'],
  overheard: [...SYSTEM, 'turn/overheard'],
  errandResult: [...SYSTEM, 'turn/errand'],
  private: [...SYSTEM, 'turn/reply', 'turn/private'],
  draw: ['draw', 'appearance'],
  ...Object.fromEntries(
    Object.entries(DIARY_KIND_FILES).map(([kind, file]) => [`diary ${kind}`, [...SYSTEM, 'diary/task', file]])
  ),
  inner: [...SYSTEM, 'turn/inner'],
  heartbeat: [...SYSTEM, 'heartbeat/task'],
  describe: ['describe/picture'],
  avatar: ['describe/avatar'],
  describeGif: ['describe/gif'],
  describeVideo: ['describe/video'],
  rewatchAnswer: ['describe/rewatch'],
  searchSummary: ['summarize/search'],
  split: ['classify/split'],
  merge: ['classify/merge'],
  missed: ['classify/missed'],
  mediaPick: ['classify/pick'],
  humanizer: ['humanizer/linter', 'humanizer/editor'],
  turn: [...SYSTEM, 'turn/reply'],
};

/** The shipped config.json with `overrides` deep-merged over a fresh copy. */
function shippedConfig(overrides: Record<string, unknown> = {}) {
  const on = {
    models: { routes: chainsOf({ vision: 'x/vision', video: 'x/video', drawing: 'x/drawing', speech: 'x/speech' }) },
  }; // off when shipped
  return deepMerge(deepMerge(structuredClone(SHIPPED.config), on), overrides);
}

// ---- the checks -----------------------------------------------------------------

/** The text of one message content: a string as is, an array of parts as its text parts. */
function contentText(content: unknown) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** Every text a request carries, as one string. */
function promptsShippedRequestText(messages: Array<{ content: unknown }>) {
  return messages.map((message) => contentText(message.content)).join('\n\n');
}

/** The double-brace sequences left in `text`, LITERAL_BRACES aside. */
function strayPlaceholders(text: string) {
  return [...new Set(withoutLiterals(text).match(/\{\{[^{}\n]{0,40}\}\}|\{\{/g) ?? [])];
}

/** The single-brace `{key}` label placeholders left in `text`, LITERAL_BRACES aside. */
function strayLabelKeys(text: string) {
  return [...new Set(withoutLiterals(text).match(/\{[A-Za-z_]\w*\}/g) ?? [])];
}

/** The lines of prompt `name` without a placeholder: a request that loads the file carries each one verbatim. */
function literalLines(name: string) {
  const text = (SHIPPED.prompts as Record<string, unknown>)[name] as string;
  assert.equal(typeof text, 'string', `prompts/${name}.md is not loaded`);
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('{{'));
}

/**
 * Asserts one built request: no `{{placeholder}}` and no label `{key}` left, every prompt file of
 * `files` carried whole, every block of `blocks` rendered. Returns the request's text.
 */
function assertFilled(
  messages: unknown,
  { files = [], blocks = [] }: { files?: Array<string>; blocks?: Array<string> },
  where: string
) {
  assert.ok(Array.isArray(messages) && messages.length > 0, `${where}: no request was built`);
  const text = promptsShippedRequestText(messages);
  assert.deepEqual(strayPlaceholders(text), [], `${where}: a placeholder reached the request unfilled`);
  assert.deepEqual(strayLabelKeys(text), [], `${where}: a label placeholder reached the request unfilled`);
  for (const name of files) {
    const missing = literalLines(name).filter((line) => !text.includes(line));
    assert.equal(
      missing.length,
      0,
      `${where}: prompts/${name}.md is not carried whole, e.g. ${JSON.stringify(missing.slice(0, 2))}`
    );
  }
  for (const tag of blocks) {
    if (tag === 'tempo') {
      // Slice 2 (g): `<tempo>` is the foot of `<chat>`, not a block, so its verdict line ends the chat's body.
      const chat = /<chat>\n([\s\S]*?)\n<\/chat>/.exec(text)?.[1] ?? '';
      const verdict = labelHead(LABELS.tempo.verdict);
      assert.ok(chat.split('\n').at(-1)?.startsWith(verdict), `${where}: no tempo at the foot of <chat>`);
      continue;
    }
    assert.ok(text.includes(`<${tag}>\n`), `${where}: no <${tag}> block`);
  }
  return text;
}

// ---- the scene: one server, its members and channels --------------------------------

const PROMPTS_SHIPPED_NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

const SELF_ID = '900000000000000001';

const SELF_NAME = 'Zoë';

const ANA = '411111111111111111';

const NIKOS = '422222222222222222';

const BJORN = '433333333333333333';

const ELODIE = '444444444444444444';

const GENERAL = '700000000000000001';

const GARDEN = '700000000000000002';

const DIARY = '700000000000000003';

const CHANNEL_INCREMENT: Record<string, bigint> = { [GENERAL]: 1n, [GARDEN]: 2n, [DIARY]: 3n };

const PEOPLE = {
  [ANA]: { id: ANA, name: 'Ana' },
  [NIKOS]: { id: NIKOS, name: 'Nikos' },
  [BJORN]: { id: BJORN, name: 'Björn' },
  [SELF_ID]: { id: SELF_ID, name: SELF_NAME },
};

const iso = (ms: number) => new Date(ms).toISOString();

/** A stored member profile, every field the renderers read filled. */
function profile(id: string, names: Array<string>, extra: Record<string, unknown> = {}) {
  return {
    id,
    names,
    character: `${names[0]} is curious and warm`,
    style: 'short lines, many questions',
    interests: [
      {
        topic: 'gardening',
        note: 'grows tomatoes on a balcony',
        weight: 4,
        firstSeen: iso(PROMPTS_SHIPPED_NOW - 30 * DAY_MS),
        lastSeen: iso(PROMPTS_SHIPPED_NOW - DAY_MS),
      },
      {
        topic: 'chess',
        note: '',
        weight: 1,
        firstSeen: iso(PROMPTS_SHIPPED_NOW - 200 * DAY_MS),
        lastSeen: iso(PROMPTS_SHIPPED_NOW - 200 * DAY_MS),
      },
    ],
    details: [
      {
        id: 1,
        text: 'lives near the sea',
        weight: 3,
        firstSeen: iso(PROMPTS_SHIPPED_NOW - 40 * DAY_MS),
        lastSeen: iso(PROMPTS_SHIPPED_NOW - 2 * DAY_MS),
      },
    ],
    aliases: [
      {
        name: `${names[0].slice(0, 3)}ou`,
        weight: 3,
        firstSeen: iso(PROMPTS_SHIPPED_NOW - 20 * DAY_MS),
        lastSeen: iso(PROMPTS_SHIPPED_NOW - DAY_MS),
      },
    ],
    relationship: 'an old friend of the chat',
    relationshipScore: 20,
    relationshipWrittenAt: iso(PROMPTS_SHIPPED_NOW - 10 * DAY_MS),
    affinity: {
      score: 22,
      reason: 'brought crêpes to the meetup',
      history: [{ delta: 5, ts: PROMPTS_SHIPPED_NOW - 3 * DAY_MS }],
    },
    episodes: [
      {
        date: '2026-09-28',
        what: 'taught the persona a card trick',
        quote: 'regarde bien',
        feeling: 'delighted',
        weight: 3,
        addedAt: iso(PROMPTS_SHIPPED_NOW - 7 * DAY_MS),
      },
      {
        date: '2026-10-04',
        what: 'asked about the weather',
        quote: '',
        feeling: 'calm',
        weight: 1,
        addedAt: iso(PROMPTS_SHIPPED_NOW - DAY_MS),
      },
    ],
    messageCount: 420,
    firstSeen: iso(PROMPTS_SHIPPED_NOW - 90 * DAY_MS),
    lastSeen: iso(PROMPTS_SHIPPED_NOW - 2 * MINUTE_MS),
    ...extra,
  };
}

const PROFILES: Record<string, ReturnType<typeof profile>> = {
  [ANA]: profile(ANA, ['Ana', 'Anaïs']),
  [NIKOS]: profile(NIKOS, ['Nikos']),
  [BJORN]: profile(BJORN, ['Björn']),
  [ELODIE]: profile(ELODIE, ['Élodie']),
};

const nameOf = (id: string) => {
  const names = PROFILES[id]?.names;
  return names?.[0] ?? null;
};

const GUILD_MEMORY = {
  patterns: 'quick banter, many emoji',
  starters: 'a photo of lunch, a question to the room',
  injokes: ['the eternal tomato'],
  self: ['once claimed to like rain'],
  learned: [
    {
      id: 1,
      text: 'say bonjour before anything else',
      from: `<@${ANA}>`,
      weight: 3,
      firstSeen: iso(PROMPTS_SHIPPED_NOW - 9 * DAY_MS),
      lastSeen: iso(PROMPTS_SHIPPED_NOW - DAY_MS),
    },
    {
      id: 2,
      text: 'never spoil a film',
      weight: 1,
      firstSeen: iso(PROMPTS_SHIPPED_NOW - DAY_MS),
      lastSeen: iso(PROMPTS_SHIPPED_NOW - DAY_MS),
    },
  ],
  emojiUsage: { E1: { name: 'zoe_wave', count: 4, last: PROMPTS_SHIPPED_NOW - DAY_MS } },
  updatedAt: iso(PROMPTS_SHIPPED_NOW - 3 * DAY_MS),
};

const CHANNELS = [
  {
    id: GENERAL,
    name: 'général',
    category: 'Café',
    topic: 'tout et rien',
    purpose: 'everyday chat',
    topics: 'plants, films, food',
    tone: 'warm teasing',
    lastMessageAt: PROMPTS_SHIPPED_NOW - 2 * MINUTE_MS,
    messageCount: 900,
    days: { [utcDay(PROMPTS_SHIPPED_NOW)]: 40 },
    topWriters: [
      { id: ANA, count: 30 },
      { id: NIKOS, count: 20 },
    ],
    updatedAt: iso(PROMPTS_SHIPPED_NOW - 8 * DAY_MS),
  },
  {
    id: GARDEN,
    name: 'jardin',
    category: 'Café',
    topic: null,
    purpose: 'garden photos',
    topics: 'seeds',
    tone: 'calm',
    lastMessageAt: PROMPTS_SHIPPED_NOW - 20 * MINUTE_MS,
    messageCount: 120,
    days: {},
  },
  {
    id: DIARY,
    name: 'journal',
    category: 'Notes',
    topic: 'one member per thread',
    purpose: 'personal diaries',
    topics: 'daily life',
    tone: 'quiet',
    lastMessageAt: PROMPTS_SHIPPED_NOW - 5 * MINUTE_MS,
    messageCount: 60,
    days: {},
  },
];

const LORE = [
  {
    id: 'l1',
    title: 'Le grand gel',
    keys: ['tomate'],
    text: 'The winter the balcony tomatoes froze.',
    always: false,
    source: 'analyzer',
    weight: 3,
  },
];

const CUSTOM_EMOJI = [
  { id: 'E1', name: 'zoe_wave' },
  { id: 'E2', name: 'tomate_triste' },
];

const RECENT_LINES = [
  {
    id: 1,
    at: PROMPTS_SHIPPED_NOW - 2 * HOUR_MS,
    addedAt: iso(PROMPTS_SHIPPED_NOW - HOUR_MS),
    placeId: GARDEN,
    text: `<@${NIKOS}> planted garlic`,
    who: [NIKOS],
    weight: 2,
  },
];

const LOOKUP_RESULT = {
  query: 'tomato frost',
  text: 'Tomatoes die below zero degrees [1].',
  sources: [{ title: 'Garden notes', url: 'https://www.example.com/frost', site: 'example.com' }],
};

/**
 * A discord.js-shaped message, enough for normalizeMessage: `author` a PEOPLE entry, media as
 * plain lists (attachments `{ id, name, contentType, url, size?, duration? }`, embeds as Discord
 * sends them, stickers `{ id, name, format }`, reactions `{ name, id?, count, me? }`).
 */
function rawMessage(
  channel: { id: string; name: string | null; category?: string | null; topic?: string | null },
  {
    ts,
    author,
    content = '',
    attachments = [],
    embeds = [],
    stickers = [],
    reactions = [],
    replyTo = null,
    mentions = [],
    forwarded = null,
  }: {
    ts: number;
    author: { id: string; name: string };
    content?: string;
    attachments?: Array<{ id: string; [key: string]: unknown }>;
    embeds?: Array<unknown>;
    stickers?: Array<{ id: string; [key: string]: unknown }>;
    reactions?: Array<{ name: string; id?: string; count: number; me?: boolean }>;
    replyTo?: string | null;
    mentions?: Array<string>;
    forwarded?: string | null;
  }
) {
  // The same id on every call: the time, and the channel as the increment.
  const id = SnowflakeUtil.generate({ timestamp: ts, increment: CHANNEL_INCREMENT[channel.id] ?? 0n }).toString();
  return {
    id,
    channelId: channel.id,
    channel: {
      name: channel.name,
      parent: channel.category ? { name: channel.category } : null,
      topic: channel.topic ?? null,
    },
    guild: null,
    author: { id: author.id, bot: false, globalName: author.name, username: author.name },
    member: { displayName: author.name },
    content,
    cleanContent: content,
    createdTimestamp: ts,
    reference: replyTo ? { messageId: replyTo } : null,
    attachments: new Map(attachments.map((a) => [a.id, a])),
    embeds,
    stickers: new Map(stickers.map((s) => [s.id, s])),
    messageSnapshots: new Map(
      forwarded
        ? [
            [
              'fwd',
              { content: forwarded, cleanContent: forwarded, attachments: new Map(), embeds: [], stickers: new Map() },
            ],
          ]
        : []
    ),
    mentions: { users: new Map(mentions.map((accountId) => [accountId, { id: accountId }])) },
    reactions: {
      cache: new Map(
        reactions.map((r, i) => [
          String(i),
          { emoji: { name: r.name, id: r.id ?? null }, count: r.count, me: r.me ?? false },
        ])
      ),
    },
    flags: { has: () => false },
  };
}

const GENERAL_INFO = { id: GENERAL, name: 'général', category: 'Café', topic: 'tout et rien' };

const GARDEN_INFO = { id: GARDEN, name: 'jardin', category: 'Café', topic: null };

const GIF_EMBED = {
  url: 'https://tenor.com/view/cat-wave-123',
  provider: { name: 'Tenor' },
  thumbnail: { url: 'https://media.tenor.com/cat.png' },
  video: { url: 'https://media.tenor.com/cat.mp4' },
};

const PAGE_EMBED = {
  url: 'https://example.org/tomates',
  title: 'Tomates en pot',
  description: 'Comment cultiver des tomates sur un balcon',
};

/** The chat of #général the turn answers, oldest first: every kind of media the transcript renders. */
function generalRaws() {
  const at = (minutes: number) => PROMPTS_SHIPPED_NOW - minutes * MINUTE_MS;
  const raws: Array<ReturnType<typeof rawMessage>> = [];
  const add = (fields: Parameters<typeof rawMessage>[1]) => {
    const raw = rawMessage(GENERAL_INFO, fields);
    raws.push(raw);
    return raw;
  };
  add({
    ts: at(55),
    author: PEOPLE[NIKOS],
    content: 'bonjour à tous, la tomate a gelé',
    reactions: [
      { name: '🍅', count: 3 },
      { name: 'zoe_wave', id: 'E1', count: 1, me: true },
    ],
  });
  const own = add({ ts: at(50), author: PEOPLE[SELF_ID], content: 'oh non, pauvre tomate' });
  add({
    ts: at(45),
    author: PEOPLE[BJORN],
    content: 'la preuve',
    attachments: [
      {
        id: '800000000000000001',
        name: 'photo.png',
        contentType: 'image/png',
        url: 'https://cdn.discordapp.com/attachments/1/2/photo.png',
        size: 2000,
      },
    ],
  });
  add({
    ts: at(40),
    author: PEOPLE[NIKOS],
    content: 'regardez https://tenor.com/view/cat-wave-123',
    embeds: [GIF_EMBED],
  });
  const video = add({
    ts: at(35),
    author: PEOPLE[ANA],
    content: 'une vidéo des oranges',
    attachments: [
      {
        id: '800000000000000002',
        name: 'oranges.mp4',
        contentType: 'video/mp4',
        url: 'https://cdn.discordapp.com/attachments/1/2/oranges.mp4',
        size: 90000,
        duration: 20,
      },
    ],
  });
  add({ ts: at(30), author: PEOPLE[BJORN], content: 'un article https://example.org/tomates', embeds: [PAGE_EMBED] });
  add({
    ts: at(26),
    author: PEOPLE[ANA],
    content: '',
    stickers: [{ id: '810000000000000001', name: 'tomato_dance', format: 1 }],
  });
  add({
    ts: at(22),
    author: PEOPLE[NIKOS],
    content: 'mes graines',
    attachments: [
      {
        id: '800000000000000003',
        name: 'graines.txt',
        contentType: 'text/plain',
        url: 'https://cdn.discordapp.com/attachments/1/2/graines.txt',
        size: 40,
      },
    ],
  });
  add({ ts: at(18), author: PEOPLE[BJORN], content: 'vu ailleurs', forwarded: 'le gel arrive mardi' });
  add({ ts: at(14), author: PEOPLE[SELF_ID], content: 'jolie vidéo', replyTo: video.id });
  add({ ts: at(10), author: PEOPLE[NIKOS], content: 'Zoë, tu as aimé ?', replyTo: own.id });
  add({
    ts: at(2),
    author: PEOPLE[ANA],
    content: '@Zoë de quelle couleur sont les oranges dans la vidéo ? et quand gèle la tomate ?',
    mentions: [SELF_ID],
  });
  return raws;
}

const normalize = (raws: Array<ReturnType<typeof rawMessage>>) =>
  raws.map((raw) => {
    const SHIPPEDMedia = SHIPPED.config.media;
    const line = normalizeMessage(raw, SELF_ID, {
      videoSites: SHIPPEDMedia.video.sites,
    });
    // The interface's line names its channel natively; the core reads the same line under its place.
    return { ...line, placeId: line.channelId };
  });

/** A fetch stand-in for text attachment previews: every file reads the same short text. */
const previewFetch = async () => ({
  ok: true,
  headers: { get: () => null },
  text: async () => 'graines: tomate, basilic, ail',
});

/** The #général chat, normalized, text previews filled, oldest first. */
async function generalHistory() {
  return withTextPreviews(normalize(generalRaws()), 500, previewFetch);
}

/** Captions, watched videos and read pages for every media item of `history`, as a turn hands them in. */
function mediaMaps(history: ReturnType<typeof normalize>) {
  const descriptions = new Map();
  const videos = new Map();
  const reads = new Map();
  for (const message of history) {
    for (const item of (message.attachments ?? []) as Array<{ id: string; kind: string }>) {
      if (item.kind === 'image' || item.kind === 'gif') descriptions.set(item.id, 'a tomato plant covered in frost');
      if (item.kind === 'video')
        videos.set(item.id, {
          state: 'watched',
          text: 'a person juggles three oranges',
          answer: { question: 'what colour?', text: 'orange' },
        });
    }
    for (const link of (message.links ?? []) as Array<{ id: string; kind: string }>) {
      if (link.kind === 'gif') descriptions.set(link.id, 'a cat waves');
      else reads.set(link.id, 'How to grow tomatoes in pots on a balcony.');
    }
    for (const sticker of (message.stickers ?? []) as Array<{ id: string }>)
      descriptions.set(sticker.id, 'a dancing tomato');
  }
  return { descriptions, videos, reads };
}

/** The GIF library of the server, holding the GIF of the chat. */
function gifLibrary(history: ReturnType<typeof normalize>) {
  const gif = history.flatMap((m) => m.links ?? []).find((link) => link.kind === 'gif')!;
  return {
    nextId: 2,
    entries: {
      [gif.id]: {
        id: 'g1',
        kind: 'link',
        url: gif.url,
        site: 'tenor.com',
        itemId: gif.id,
        count: 3,
        last: PROMPTS_SHIPPED_NOW - DAY_MS,
        firstSeen: PROMPTS_SHIPPED_NOW - 9 * DAY_MS,
      },
    },
  };
}

/** One neighbour channel with a line of its own. */
function neighbors() {
  const line = rawMessage(GARDEN_INFO, {
    ts: PROMPTS_SHIPPED_NOW - 20 * MINUTE_MS,
    author: PEOPLE[BJORN],
    content: 'les semis sont sortis',
  });
  return [{ placeId: GARDEN, channelName: 'jardin', readOnly: false, messages: normalize([line]) }];
}

/** The input of a server turn in #général answering Ana, every optional block given. */
async function turnInput(overrides: Record<string, unknown> = {}) {
  const history = await generalHistory();
  const trigger = history.at(-1);
  const { descriptions, videos, reads } = mediaMaps(history);
  const config = shippedConfig({
    // PR 7d: the switches are code; the private chats are `dm.enabled`.
    dm: { enabled: true },
    memory: { mainChannelIds: [GENERAL] },
  });
  const input = {
    config,
    prompts: SHIPPED.prompts,
    calibrator: createCalibrator(),
    mode: 'reply',
    forced: false,
    now: PROMPTS_SHIPPED_NOW,
    selfName: SELF_NAME,
    history,
    neighbors: neighbors(),
    trigger,
    triggerKind: 'mention',
    placeMemory: GUILD_MEMORY,
    interlocutor: PROFILES[ANA],
    otherProfiles: [PROFILES[NIKOS], PROFILES[BJORN]],
    candidateProfiles: Object.values(PROFILES),
    nameOf,
    channels: CHANNELS,
    loreEntries: LORE,
    currentChannelId: GENERAL,
    descriptions,
    neighborDescriptions: new Map(),
    videos,
    reads,
    lookup: LOOKUP_RESULT,
    searchAvailable: true,
    drawQuota: { spent: false, userSpent: false },
    customEmoji: CUSTOM_EMOJI,
    mediaCache: { 'emoji:E1': { text: 'a small waving hand', ts: PROMPTS_SHIPPED_NOW - DAY_MS } },
    gifs: gifLibrary(history),
    readOnlyIds: new Set([DIARY]),
    recentLines: RECENT_LINES,
    recentAudience: () => true,
    ...overrides,
  };
  // Every request is built on its turn frame (slice 7).
  return Object.hasOwn(overrides, 'frame') ? input : framed(input);
}

// ---- the diary ----------------------------------------------------------------------

/** Two past diary posts, one with a picture. */
const DIARY_POSTS = [
  {
    at: PROMPTS_SHIPPED_NOW - 2 * DAY_MS,
    kind: 'status',
    gist: 'pluie toute la journée',
    picture: null,
    messageIds: [],
    search: null,
  },
  {
    at: PROMPTS_SHIPPED_NOW - DAY_MS,
    kind: 'selfPicture',
    gist: 'sur le toit',
    picture: 'a rooftop at dusk',
    messageIds: [],
    search: null,
  },
];

describe('the shipped prompts', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  before(() => useSelf('900000000000000001'));
  after(() => useSelf('self-id'));

  test("buildRequest: a diary entry of each kind fills the system files, diary/task.md and its kind's own file", async () => {
    const input = await turnInput({
      mode: 'diary',
      trigger: null,
      triggerKind: null,
      interlocutor: null,
      currentChannelId: DIARY,
    });
    input.config = shippedConfig({ diary: { world: true, placeId: DIARY } });
    for (const kind of Object.keys(DIARY_KIND_FILES)) {
      const request = buildRequest({
        ...input,
        diaryChannel: 'journal',
        diary: { posts: DIARY_POSTS, kind, scenes: ['A pier in the fog.'] },
      });
      const text = assertFilled(
        request.messages,
        {
          files: (LOADS as Record<string, Array<string>>)[`diary ${kind}`],
          blocks: ['self', 'senses', 'inner', 'kind', 'spatial_awareness', 'task'],
        },
        `diary ${kind}`
      );
      assert.ok(text.includes(fill(LABELS.senses.diary, { channel: 'journal' })), 'senses.diary names the channel');
    }
  });
});
