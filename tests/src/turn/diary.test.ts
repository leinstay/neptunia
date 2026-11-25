// Tests for src/turn/diary.ts. The first step of a diary entry (`prepareDiary`): the code draws the kind, a forced
// kind wins, a kind of SCENE_KINDS asks the director for its scenes before any turn, `randomSet` asks three times over
// sets that share no line, and an entry with no scene is skipped. The step runs on its own over the fakes of
// tests/fixtures/diary-prepare.ts; a constant `rng` draws the first or the last kind the entry may take, in the order
// of DIARY_KINDS. The last section reads the place notes a diary plan takes (`diaryPlaceNotes`). Synthetic data only.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { postsOf, prepare } from '../../fixtures/diary-prepare.ts';
import { directorAnswer, setsOf } from '../../fixtures/scene-answer.ts';
import { createDiary, diaryPlaceNotes } from '../../../src/turn/diary.ts';
import type { DiaryPrepared } from '../../../src/turn/diary.ts';
import fs from 'node:fs';
import path from 'node:path';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createAdmin } from '../../../src/admin.ts';
import {
  DEFAULT_HISTORY_POSTS,
  DEFAULT_PICTURE_KINDS,
  DIARY_KINDS,
  drawWeights,
  pickKind,
  withoutPictureKinds,
} from '../../../src/behavior/diary.ts';
import { createMirrors, guardMirrorPort } from '../../../src/behavior/mirror.ts';
import { userText } from '../../../src/behavior/prompt.ts';
import {
  createTurnRunner as createRealTurnRunner,
  createTurnRunner as toolsOperationsDiaryCreateTurnRunner,
} from '../../../src/behavior/turn.ts';
import { retrieveMemory } from '../../../src/memory/db/retrieve.ts';
import { type Context } from '../../../src/memory/db/scope.ts';
import { diaryReadContext } from '../../../src/memory/open-private.ts';
import { memoryQueryFor, type RetrievalInput } from '../../../src/memory/retrieval-input.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import { createStore } from '../../../src/memory/store.ts';
import { utcDay } from '../../../src/time.ts';
import '../../../src/tools/operations/index.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { blockOf, frameTurn, partOf, SCENE } from '../../fixtures/diary-frame.ts';
import { seedMirror } from '../../fixtures/diary-mirror.ts';
import { ROOT, sceneRunner } from '../../fixtures/diary-requests-recorded.ts';
import type { SceneMemory } from '../../fixtures/diary-scene.ts';
import { diaryToolHot } from '../../fixtures/diary-tool.ts';
import { labels } from '../../fixtures/labels.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import {
  addEntity,
  addSource,
  ALEX,
  commit,
  KAI,
  semanticWorld,
  START,
  worksOn,
} from '../../fixtures/memory-db/semantic-world.ts';
import { openTestMemory } from '../../fixtures/memory-db/service.ts';
import { mirrorScene, type Scene, T0 } from '../../fixtures/mirror-scene.ts';
import { call, completionOf, toolAnswer } from '../../fixtures/tool-answers.ts';
import { DISCORD, rawMessage, sequenceLlm } from '../../fixtures/turn-harness.ts';
import { type Channel, freshWorld, onWorld, useIface, useSelf, world } from '../../fixtures/turn-world.ts';

/** The texts of the scenes an entry was prepared with, null for a skipped one. */
const scenesOf = (result: DiaryPrepared): Array<string> | null =>
  result.skipped ? null : result.scenes.map((one) => one.scene);

const FIRST = () => 0;
const LAST = () => 0.999999;

test('a drawn kind with no scene asks the director nothing', async () => {
  // Bug: every kind waits on a director request, so a facts entry costs a scene it never reads.
  // The last roll lands on facts, a kind with no scene, since the draw holds no `status`.
  const run = await prepare({ rng: LAST });
  assert.equal(run.kind, 'facts');
  assert.deepEqual(run.requests, []);
  assert.equal(run.result.skipped, false);
  assert.deepEqual(scenesOf(run.result), []);
});

test('a drawn story asks the director once and carries its scene', async () => {
  // Bug: a scene kind reaches the turn with no scene, so the persona writes it from nothing.
  const run = await prepare({ rng: FIRST });
  assert.equal(run.kind, 'story');
  assert.equal(run.requests.length, 1);
  const [request = ''] = run.requests;
  assert.ok(request.includes('<kind>\nstory\n</kind>'));
  assert.deepEqual(scenesOf(run.result), ['A STILL HARBOUR AT DUSK.']);
});

test('a forced kind wins over the draw', async () => {
  // Bug: the draw replaces the kind the owner asked for with `/diary post <kind>`.
  const run = await prepare({ rng: FIRST, pictures: true, forcedKind: 'facts' });
  assert.equal(run.kind, 'facts');
  assert.notEqual(run.prepared?.drawn, true);
});

test('the prepared journal line marks a drawn kind', async () => {
  // Bug: the journal cannot tell a drawn kind from one the owner chose.
  const run = await prepare({ rng: LAST });
  assert.equal(run.prepared?.drawn, true);
});

test('a randomSet asks for three scenes whose sets share no line', async () => {
  // Bug: the three requests draw their sets apart, so two scenes of one entry are built on the same place.
  const run = await prepare({ rng: FIRST, pictures: true, forcedKind: 'randomSet', seeds: SEEDS_24 });
  assert.equal(run.requests.length, 3);
  const lines = run.requests.flatMap((user) => setsOf(user).flat());
  const places = run.requests.flatMap((user) => setsOf(user).map((set) => set[0]));
  assert.equal(places.length, 24);
  assert.equal(new Set(lines.filter((line) => line.startsWith('p'))).size, 24, 'no place line twice');
  assert.equal(scenesOf(run.result)?.length, 3);
});

test('a randomSet runs on one scene when the other two fail', async () => {
  // Bug: one failed request of three skips the whole entry, or a failed answer is passed on as a scene.
  let n = 0;
  const run = await prepare({
    rng: FIRST,
    pictures: true,
    forcedKind: 'randomSet',
    seeds: SEEDS_24,
    answer: (user) => {
      n += 1;
      return n === 2 ? JSON.stringify({ set: 1, used: [setsOf(user)[0]?.[0]], scene: 'ONE CORNER.' }) : 'not json';
    },
  });
  assert.equal(run.result.skipped, false);
  assert.deepEqual(scenesOf(run.result), ['ONE CORNER.']);
});

test('a scene kind the director gives no scene is skipped as no-scene with the failure named', async () => {
  // Bug: a failed director request lets the turn run on an empty scene, or the skip says nothing of why.
  const run = await prepare({ rng: FIRST, failing: true });
  assert.equal(run.result.skipped, true);
  assert.equal(run.skipped?.reason, 'no-scene');
  assert.deepEqual(run.skipped?.failures, ['request-failed']);
  assert.equal(run.prepared, undefined);
});

/** Two seeds files of 24 lines each, so 24 sets share no line. */
const SEEDS_24 = {
  'diary/seeds/place': Array.from({ length: 24 }, (_, i) => `p${i}`).join('\n'),
  'diary/seeds/setting': Array.from({ length: 24 }, (_, i) => `s${i}`).join('\n'),
};

test('the lines an entry kept, and those of an entry stored with a plan, stay out of the next sets', async () => {
  // Bug: the next entry is offered the place the last one was built on, so two entries in a row share their scene.
  const posts = [
    { at: 1, kind: 'story', gist: 'a', picture: null, scenes: [{ used: ['p0'] }] },
    { at: 2, kind: 'thought', gist: 'b', picture: null, plan: { brief: 'x', seeds: [['p1', 'q1']], seed: 1 } },
  ];
  const run = await prepare({ rng: FIRST, posts, seeds: SEEDS_24 });
  const lines = run.requests.flatMap((user) => setsOf(user).flat());
  assert.equal(lines.includes('p0'), false, 'the kept line of a scene');
  assert.equal(lines.includes('p1'), false, 'the line of a stored plan');
  assert.ok(lines.includes('p2'), lines.join(' '));
});

// ---- the place notes of a diary plan ----------------------------------------------------------------------------

// The notes come from every top place the entry's readers may see, and no first place stands in as a home.
const NOTES: Record<string, object> = {
  'place:one': { patterns: 'short lines', injokes: ['the lamp'], learned: [{ text: 'ask first' }] },
  'place:two': { patterns: 'long threads', injokes: ['the kettle'], learned: [] },
};
const store = { getPlace: (placeId: string) => NOTES[placeId] ?? null };

test('one top place gives its notes untouched', () => {
  // Bug: the request of a one-server install changes because the notes went through a merge.
  assert.equal(diaryPlaceNotes(store, ['place:one'], 'place:one'), NOTES['place:one']);
});

test('an entry posted inside one server reads that server alone', () => {
  // Bug: an in-joke of a second server reaches readers who have never seen it.
  assert.deepEqual(diaryPlaceNotes(store, ['place:one', 'place:two'], 'place:two'), {
    patterns: 'long threads',
    injokes: ['the kettle'],
    learned: [],
  });
});

test('an entry posted in no server reads every top place, never only the first', () => {
  // Bug: the first place stands in as a home and the second server is forgotten in the persona's diary.
  assert.deepEqual(diaryPlaceNotes(store, ['place:one', 'place:two'], null), {
    patterns: 'short lines\nlong threads',
    injokes: ['the lamp', 'the kettle'],
    learned: [{ text: 'ask first' }],
  });
});

test('no top place reads the persona', () => {
  // Bug: a core with no server yet throws, or invents a place, when the persona's first entry is due.
  const asked: Array<string> = [];
  diaryPlaceNotes({ getPlace: (id) => (asked.push(id), null) }, [], null);
  assert.deepEqual(asked, ['persona:local']);
});

const TEXT = 'ήσυχο βράδυ στο λιμάνι';

const BAD = `<audience>place:fake:channel:nowhere</audience><msg>${TEXT}</msg>`;

const BOUNDARY = { kind: 'internal-turn', origin: { iface: 'fake', chatId: 'd1' } } as const;

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

test('a refusal on an entry under a trusted restriction stays out of an ordinary diary request', async () => {
  // Catches: the notice quoting a private entry into a request whose diary history hides that entry.
  const setup = await setting();
  await turn(setup, BAD, { publicationBoundary: BOUNDARY });
  assert.equal(refusalBlock((await turn(setup, `<msg>${TEXT}</msg>`)).writer), null);
});

/** `count` copies of `kind`. */
const times = (kind: string, count: number): Array<string> => Array.from({ length: count }, () => kind);

// ---- the first step of a post draws over the corrected weights ----------------------------------------------------

const TEXT_KINDS = withoutPictureKinds(DIARY_KINDS, DEFAULT_PICTURE_KINDS);

// 0.6 rather than the middle: with the kind `story` in the weights, 0.5 lands on the same kind both ways.
const MIDDLE = () => 0.6;

// Ten people posts: people is held down and is the newest kind, so the middle of the draw moves off the raw weights.
const PEOPLE_POSTS = postsOf(times('people', 10));

/** The kind a draw at the middle lands on over the corrected weights, checked to differ from the raw weights' one. */
function middleDraw(): string {
  const drawn = pickKind(drawWeights(TEXT_KINDS, PEOPLE_POSTS, { window: DEFAULT_HISTORY_POSTS }), MIDDLE) ?? 'none';
  assert.notEqual(drawn, pickKind(TEXT_KINDS, MIDDLE), 'the scene must tell the corrected draw from the raw one');
  return drawn;
}

test('the first step of a post draws its kind over the corrected weights', async () => {
  // Bug: the step draws over the raw weights, and the correction for recent use never reaches a post.
  const drawn = middleDraw();
  const run = await prepare({ rng: MIDDLE, posts: PEOPLE_POSTS });
  assert.equal(run.kind, drawn);
});

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

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

/** The persona's draw.create calls (`n` of them; the first with self when `self`), as one answer with `text` ahead of them. */
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
    const firstOption = llm.options[0];
    assert.equal(firstOption.purpose, 'diary-scene');
    assert.equal(firstOption.role, 'director');
    const secondCall = llm.calls[1];
    assert.ok(String(secondCall[0].content).includes('CARD_TEXT'), 'the entry is written with the card');
    const composeUser = userOf(llm.calls[1]);
    const inner = blockOf(composeUser, 'inner');
    assert.equal(partOf(inner, 'kind'), 'story');
    assert.equal(partOf(inner, 'scene'), 'A FOGGY PIER AT DUSK.');
    assert.ok(composeUser.includes('<task>\nDIARY_TASK for Bot\n\nSTORY_TASK\n</task>'), composeUser.slice(-400));
    for (const tag of ['plan', 'seeds', 'kinds', 'meanwhile']) assert.ok(!composeUser.includes(`<${tag}>`), tag);
  });

  test('diary turn: a thought asks no director and its request holds no <scene>', async () => {
    // Bug: a kind with no scene waits on the director, or reads a scene.
    const llm = fakeLlm(null, '<msg>ennui</msg>');
    await runner({ llm }).runTurn({
      channel: diaryChannel(),
      mode: 'diary',
      diary: { kind: 'thought', forced: false },
    });
    assert.equal(llm.calls.length, 1, 'the persona alone');
    const user = userOf(llm.calls[0]);
    assert.equal(partOf(blockOf(user, 'inner'), 'kind'), 'thought');
    assert.ok(!user.includes('<scene>'));
    assert.ok(user.includes('<task>\nDIARY_TASK for Bot\n\nTHOUGHT_TASK\n</task>'));
  });

  test('diary turn: a randomSet asks for three scenes whose sets share no line', async () => {
    // Bug: the three places of a random set come from one request, or repeat a line, so its pictures look alike.
    const thirty = (family: string) => Array.from({ length: 30 }, (_, i) => `${family} ${i}`).join('\n');
    const llm = fakeLlm(null, '<msg>trois endroits</msg>');
    const hot = fakeHot({
      prompts: { 'diary/seeds/place': thirty('place'), 'diary/seeds/setting': thirty('setting') },
    });
    await runner({ hot, llm }).runTurn({
      channel: diaryChannel(),
      mode: 'diary',
      diary: { kind: 'randomSet', forced: false },
    });
    const { options } = llm;
    const asked = llm.calls.filter((_, i) => options[i].purpose === 'diary-scene');
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
    const firstAppended = store.appended[0];
    const firstAppendedScenes = firstAppended.post.scenes;
    assert.equal(firstAppendedScenes.length, 1);
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

  test('diary turn: a forced kind replaces the draw and is recorded', async () => {
    const llm = fakeLlm(null, '<msg>brume</msg>');
    const store = fakeStore();
    await runner({ llm, store }).runTurn({
      channel: diaryChannel(),
      mode: 'diary',
      diary: { kind: 'thought', forced: true },
    });
    assert.equal(partOf(blockOf(userOf(llm.calls[0]), 'inner'), 'kind'), 'thought');
    const firstAppended = store.appended[0];
    assert.equal(firstAppended.post.kind, 'thought');
  });

  test('diary turn: with pictures off only a text kind is drawn', async () => {
    for (const roll of [0, 0.3, 0.6, 0.99]) {
      const llm = fakeLlm(null, '<msg>brume</msg>');
      const { logs } = await withCapturedLogs(() =>
        runner({ llm, images: null, rng: () => roll }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} })
      );
      const prepared = logs.find((entry) => entry.msg === 'diary: prepared');
      assert.ok(['story', 'thought', 'people', 'news', 'facts'].includes(loose(prepared).kind), String(roll));
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
      diary: { kind: 'thought', forced: true },
    });
    assert.equal(loose(result).outcome, 'spoke');
    const firstAppended = store.appended[0];
    assert.equal(firstAppended.post.kind, 'thought');
  });
});

const SECRET = 'xylophonewhisper';

const BOUNDS = { seeds: 3, hops: 2, nodes: 10, edges: 30, assertions: 6, evidence: 9, tokens: 900, deadlineMs: 700 };

const deps = { now: () => START, embedQuery: null, model: null };

const FACT_TEXT = 'Alex keeps Lumen running';

function known() {
  const world = semanticWorld();
  const open = addSource(world, 'public', 'Alex works on Lumen');
  const hidden = addSource(world, 'alex', `Lumen and ${SECRET}`);
  const lumen = addEntity(world, 'project', 'Lumen', [open]);
  commit(world, worksOn(ALEX, lumen.entityId, [open], { text: FACT_TEXT }));
  commit(world, worksOn(KAI, lumen.entityId, [hidden], { text: `private ${SECRET}` }), world.contexts.alex);
  return { world, lumen, open };
}

for (const openPrivate of [false, true])
  test(`a diary entry with no scene is told the stored facts of group chats, and a private one only with openPrivate (${openPrivate})`, async () => {
    // Bug: the diary reads under an internal context and a mirror publishes a private fact while the switch is off, or
    // stays blind to a direct chat when the owner turned it on.
    const { world } = known();
    const config = { context: { memory: { openPrivate } } };
    const { prepareDiary } = createDiary(
      wrongly({
        hot: { config: {}, prompts: { labels } },
        store: {
          state: { data: {} },
          getPlace: () => null,
          getDiary: () => ({ posts: [] }),
          topPlaces: () => [],
          listChannels: () => [],
          getLore: () => [],
          listUserProfiles: () => [{ id: 'n1' }],
          getUser: () => null,
          personOfAccount: () => ALEX,
        },
        llm: { complete: () => Promise.reject(new Error('a kind with no scene asks no model')) },
        rng: () => 0,
        images: null,
        diaryFacts: (input: RetrievalInput) =>
          retrieveMemory(world.db, diaryReadContext(config), memoryQueryFor(input, BOUNDS), deps),
      })
    );
    const prepared = await wrongly<(input: object) => Promise<{ facts?: string }>>(prepareDiary)({
      config: { diary: {}, llm: { maxRequestTokens: 100000 }, bot: { timezone: 'UTC' } },
      channel: { id: 'c1', rootId: null, permissions: {} },
      now: START + 3_600_000,
      params: { kind: 'thought' },
      memoryOn: true,
    });
    const text = prepared.facts ?? '';
    assert.ok(text.includes(FACT_TEXT), 'the entry carries no stored fact');
    assert.equal(text.includes(SECRET), openPrivate);
    world.handle.close();
  });

test('a story asks the director first, and its request holds <kind> and the scene in <inner>, and no <plan> or <seeds>', async () => {
  // Bug: the persona writes a scene kind with no scene, or reads the planner's blocks that no longer exist.
  const run = await frameTurn({ kind: 'story' });
  assert.equal(run.director.length, 1, 'one director request');
  const text = run.writer[0] ?? '';
  const inner = blockOf(text, 'inner');
  assert.equal(partOf(inner, 'kind'), 'story');
  assert.equal(partOf(inner, 'scene'), SCENE);
  for (const tag of ['plan', 'seeds', 'kinds']) assert.ok(!text.includes(`<${tag}>`), tag);
});

test('a thought asks no director, and its request holds no <scene>', async () => {
  // Bug: a kind with no scene waits on the director, or reads a scene meant for another kind.
  const run = await frameTurn({ kind: 'thought' });
  assert.equal(run.director.length, 0);
  assert.equal(partOf(blockOf(run.writer[0] ?? '', 'inner'), 'kind'), 'thought');
  assert.ok(!(run.writer[0] ?? '').includes('<scene>'));
});

const TOOLS_OPERATIONS_DIARY_NOW = Date.parse('2026-10-27T12:00:00Z');

const TOOLS_OPERATIONS_DIARY_ROOT = 'g1';

const MAX_PER_DAY = 3;

/** The memory databases the scenes opened, closed when the file is done. */
const TOOLS_OPERATIONS_DIARY_OPEN: Array<{ close(): unknown }> = [];

after(async () => {
  for (const item of TOOLS_OPERATIONS_DIARY_OPEN.splice(0)) await item.close();
});

/**
 * A root with `general` (c1), where Alice wrote last, and the diary's two enabled mirrors `journal` (d1) and
 * `notes` (d2), on a fake interface; a real store over memory, the publisher over the interface's own port, and their
 * tools through a real admin over the guarded port. `postsToday` diary entries are already counted today.
 */
async function root({ postsToday = 0 }: { postsToday?: number } = {}) {
  const memory = await openTestMemory({ now: () => TOOLS_OPERATIONS_DIARY_NOW });
  TOOLS_OPERATIONS_DIARY_OPEN.push(memory);
  freshWorld();
  const line = (placeId: string) => ({
    ...rawMessage({ id: `m-${placeId}`, ts: TOOLS_OPERATIONS_DIARY_NOW - 30_000, content: 'γεια' }),
    placeId,
  });
  // The persona's own earlier post in c1 with a picture: what a media repost takes.
  const ownPicture = {
    ...rawMessage({ id: 'p-own', ts: TOOLS_OPERATIONS_DIARY_NOW - 60_000, content: '' }),
    placeId: 'c1',
    author: { id: 'self-id', bot: true, globalName: 'Bot', username: 'Bot' },
    member: { displayName: 'Bot' },
    attachments: new Map([
      [
        'att-own',
        { id: 'att-own', name: 'pier.png', url: 'https://cdn.example/pier.png', contentType: 'image/png', size: 3 },
      ],
    ]),
  };
  world().channel({
    id: 'c1',
    name: 'general',
    placeId: TOOLS_OPERATIONS_DIARY_ROOT,
    historyMessages: [ownPicture, line('c1')],
  });
  world().channel({ id: 'd1', name: 'journal', placeId: TOOLS_OPERATIONS_DIARY_ROOT });
  world().channel({ id: 'd2', name: 'notes', placeId: TOOLS_OPERATIONS_DIARY_ROOT });
  for (const [id, name] of [
    ['d1', 'journal'],
    ['d2', 'notes'],
  ] as const)
    seedMirror(memory.memoryDb, { iface: 'fake', chatId: id, name, at: TOOLS_OPERATIONS_DIARY_NOW });
  // The persona's GIF library holds one GIF, `g1`, posted as its address.
  const store = Object.assign(createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb }), {
    findGif: (_rootId: string, handle: string) =>
      handle === 'g1' ? { id: 'g1', url: 'https://media.example/g1.gif', file: null } : null,
    recordOwnGif: () => {},
  });
  // The diary cap counts by the admin's own clock, the real one, so the seeded day is today's.
  if (postsToday > 0) Object.assign(store.state.data, { diaryDay: utcDay(Date.now()), diaryPosts: postsToday });
  const adapter = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => TOOLS_OPERATIONS_DIARY_NOW });
  const reads = world().adopt(adapter);
  const mirrors = createMirrors({
    memoryDb: memory.memoryDb,
    port: () => adapter,
    now: () => TOOLS_OPERATIONS_DIARY_NOW,
    dataDir: memory.dataDir,
  });
  const port = guardMirrorPort(adapter, { memoryDb: memory.memoryDb });
  const texts = (chatId: string) => adapter.messagesIn(chatId).map((message) => message.text);
  // A file one of the persona's errands brought back.
  const filePath = path.join(memory.dataDir, 'notes.txt');
  fs.writeFileSync(filePath, 'σημειώσεις');
  const errands = { fileOf: () => ({ name: 'notes.txt', path: filePath, contentType: 'text/plain' }) };
  return { memory, store, adapter, reads, mirrors, port, texts, errands };
}

type Root = Awaited<ReturnType<typeof root>>;

/** An intention due in c1: an inner turn of the persona. */
const INTENTION_WAKE = {
  kind: 'intention_due',
  items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
  intentions: [{ id: 'i1', purpose: 'γράψε στο ημερολόγιο', dueAt: TOOLS_OPERATIONS_DIARY_NOW - 60_000 }],
  now: TOOLS_OPERATIONS_DIARY_NOW,
  timezone: 'UTC',
  channels: [],
};

/**
 * One turn of the persona over `core`: an ordinary reply to Alice in c1, an inner turn in c1 for `wake`, or the diary turn.
 * Returns the logs and the scripted model.
 */
async function turnOf(
  core: Root,
  {
    answers,
    mode = 'reply',
    onAnswer = null,
    memoryContext,
  }: {
    answers: Array<unknown>;
    mode?: 'reply' | 'inner' | 'diary';
    onAnswer?: ((index: number) => void) | null;
    memoryContext?: Context;
  }
) {
  const hot = diaryToolHot({ maxPerDay: MAX_PER_DAY });
  const client = { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map() } };
  const admin = createAdmin({
    discord: DISCORD,
    hot,
    store: core.store,
    client,
    isServedRoot: (id: unknown) => id === TOOLS_OPERATIONS_DIARY_ROOT,
    port: core.port,
    reads: core.reads,
    errands: core.errands,
    // The download of the persona's own picture a media repost takes.
    fetchImpl: () =>
      Promise.resolve({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: () => Promise.resolve(new Uint8Array([7, 8, 9]).buffer),
      }),
  });
  const llm = sequenceLlm(answers, 'none', onAnswer);
  const { memoryDb } = core.memory;
  const turns = toolsOperationsDiaryCreateTurnRunner({
    hot,
    store: core.store,
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    // What the runner takes and this scene has none of: no describer, search, emoji or routes.
    describer: undefined,
    lookup: undefined,
    emoji: undefined,
    images: undefined,
    now: () => TOOLS_OPERATIONS_DIARY_NOW,
    port: core.port,
    reads: core.reads,
    selfId: () => 'self-id',
    getSelfName: () => 'Bot',
    skills: skillRegistry(),
    journal: null,
    // The persona's errand files, which a post may carry.
    errands: core.errands,
    runOp: admin.runSkillOp,
    runOwnOp: admin.runOwnSkillOp,
    runInitiativeOp: admin.runInitiativeSkillOp,
    // Slice 6: a diary post reads the persona's past entries from memory alone (the frame's reads over the memory
    // database, under the context the turn issues), no longer from a mirror's history through the store.
    ...(mode === 'diary'
      ? {
          journalDb: () => memoryDb.readHandle()?.db ?? null,
          memoryContext: (given: Record<string, unknown>) => memoryDb.issueContext({ iface: 'fake', ...given }),
        }
      : {}),
  });
  const chat = { iface: 'fake', chatId: 'c1' };
  const trigger = {
    id: 'm-c1',
    placeId: 'c1',
    authorId: 'u1',
    authorName: 'Alice',
    self: false,
    bot: false,
    content: 'γεια',
    ts: TOOLS_OPERATIONS_DIARY_NOW - 30_000,
    replyToId: null,
    attachments: [],
    stickers: [],
  };
  // One call per kind of turn, each written in the call, so runTurn's declared parameter types it; the diary
  // wake has no chat (section 3 item 2).
  const run = () =>
    mode === 'inner'
      ? turns.runTurn({
          chat,
          memoryContext,
          placeId: TOOLS_OPERATIONS_DIARY_ROOT,
          mode: 'inner',
          triggerKind: 'inner',
          inner: { wake: INTENTION_WAKE, shadow: false, mayAct: () => true },
        })
      : mode === 'diary'
        ? turns.runTurn({
            memoryContext,
            mode: 'diary',
            diary: { kind: 'thought', forced: true },
            placeId: TOOLS_OPERATIONS_DIARY_ROOT,
          })
        : turns.runTurn({ memoryContext, chat, mode: 'reply', triggerKind: 'mention', trigger });
  const { logs } = await withCapturedLogs(run);
  await core.store.flushSettled({});
  return { logs: logs as Array<Record<string, unknown>>, llm };
}

const PRIVATE_DIARY = 'private-diary-marker-731';

const PUBLIC_DIARY = 'ordinary-diary-marker-942';

const PRIVATE_BOUNDARY = { kind: 'internal-turn', origin: { iface: 'fake', chatId: 'c1' } } as const;

function seedRestrictedDiary(core: Root, metadata: unknown = PRIVATE_BOUNDARY): void {
  // Public store writes reproduce restored metadata without granting a model control over it.
  const post = {
    at: TOOLS_OPERATIONS_DIARY_NOW - 60000,
    kind: 'thought',
    gist: PRIVATE_DIARY,
    picture: null,
    search: '',
    text: PRIVATE_DIARY,
    itemId: 'diary:restricted-seed',
    publicationBoundary: metadata,
    send: { messages: [PRIVATE_DIARY] },
  };
  core.store.appendDiaryPost(post);
}

test('ordinary diary planning and writing omit restricted posts from the store', async () => {
  // Catches the second diary history path feeding private gists to an outward planning model.
  const core = await root();
  seedRestrictedDiary(core);
  core.store.appendDiaryPost({
    at: TOOLS_OPERATIONS_DIARY_NOW - 120000,
    kind: 'thought',
    gist: PUBLIC_DIARY,
    picture: null,
    search: '',
    text: PUBLIC_DIARY,
    itemId: 'diary:ordinary-seed',
  });
  await core.store.flushSettled({});
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const plan = JSON.stringify({ kind: 'thought', brief: 'a quiet day', search: '', picture: false, seed: 0 });
  const { llm } = await turnOf(core, { mode: 'diary', answers: [plan, '<msg>ordinary entry</msg>'] });
  assert.ok(llm.calls.length >= 2);
  const prompts = JSON.stringify(llm.calls);
  assert.ok(prompts.includes(PUBLIC_DIARY));
  assert.equal(prompts.includes(PRIVATE_DIARY), false);
});
