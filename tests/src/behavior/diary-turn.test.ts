// The diary turn (src/behavior/diary-turn.ts): the post and the entry it stores, its voice and its writer request, and an
// audience that could not be read, over the fake interface, the real turn runner and a scripted model.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import { createTurnRunner, fakeStore, hotWith, DISCORD, rawMessage, sequenceLlm } from '../../fixtures/turn-harness.ts';
import { START, rowsOf } from '../../fixtures/boundary.ts';
import { openTestMemory } from '../../fixtures/memory-db/service.ts';
import { createStore } from '../../../src/memory/store.ts';
import { directorAnswer } from '../../fixtures/scene-answer.ts';
import { ROOT, sceneRunner } from '../../fixtures/diary-requests-recorded.ts';
import { seedMirror, appendedPost, diaryCounts, entryOf } from '../../fixtures/diary-mirror.ts';
import { T0, mirrorScene } from '../../fixtures/mirror-scene.ts';
import type { Scene } from '../../fixtures/mirror-scene.ts';
import { freshWorld, world, onWorld, useIface, useSelf } from '../../fixtures/turn-world.ts';
import type { Channel } from '../../fixtures/turn-world.ts';
import { createTurnRunner as createRealTurnRunner } from '../../../src/behavior/turn.ts';
import { labels } from '../../fixtures/labels.ts';
import { call, completionOf, toolAnswer } from '../../fixtures/tool-answers.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import { createJournal } from '../../../src/memory/journal.ts';
import { NOW as NOW_ID, sceneHot, sceneLlm, sceneMemory, sceneWorld } from '../../fixtures/diary-scene.ts';
import type { SceneMemory } from '../../fixtures/diary-scene.ts';
import { worldTurnRunner } from '../../fixtures/world-runner.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import '../../../src/tools/operations/index.ts';
import { blocksOf } from '../../../src/turn/request/frame.ts';
import { MARK, blockOf, frameTurn, inOrderOf, rootTags } from '../../fixtures/diary-frame.ts';
import { issueContext } from '../../../src/memory/db/scope.ts';
import type { Context } from '../../../src/memory/db/scope.ts';
import { utcDay } from '../../../src/time.ts';
import fs from 'node:fs';
import path from 'node:path';
import { createMirrors, guardMirrorPort } from '../../../src/behavior/mirror.ts';
import { createAdmin } from '../../../src/admin.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { diaryToolHot } from '../../fixtures/diary-tool.ts';

// The fakes hold only the part of the real object that the code under test reads, so each is cast once, here.
const fakeOf = <T>(value: object): T => value as T;

/** The rigs and services a test opened; closed when the file is done. */
const OPEN: Array<{ close(): unknown }> = [];

after(async () => {
  for (const item of OPEN) await item.close();
});

/**
 * The real turn runner over `port`, with a scripted `llm` and no Discord client.
 */
function runnerOver({
  port,
  hot,
  llm,
  store = fakeStore(),
}: {
  port: ReturnType<typeof createFakeAdapter>;
  hot: ReturnType<typeof hotWith>;
  llm: { complete: (messages: never, options: never) => Promise<unknown> };
  store?: ReturnType<typeof fakeStore> | ReturnType<typeof createStore>;
}) {
  const calibrator = { ratio: 1, apply: (value: number) => value, observe: () => {} };
  // The runner's declared parameters ask for more than a test passes (a describer, a fetch), and the fakes are narrower
  // than the real client and port, so the whole argument is cast.
  return createTurnRunner(
    fakeOf<Parameters<typeof createTurnRunner>[0]>({
      hot,
      store,
      llm,
      calibrator,
      now: () => START,
      port,
      skills: skillRegistry(),
      journal: null,
    })
  );
}

describe('inner turns with no interface', () => {
  // The `diary` wake. The turn runs with no chat and records the entry
  // in memory before anything is published: a `diary` row with the persona's full text. No mirror is set up and no reads of an
  // interface are given to the scheduler, so nothing is sent anywhere, and no `diary.placeId` is set.
  test('a diary turn leaves its entry in memory with no interface connected', async () => {
    const memory = await openTestMemory({ now: () => START });
    OPEN.push(memory);
    const store = createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb });
    const hot = hotWith({
      // @ts-expect-error: hotWith has no `features` option, so the key is ignored
      features: { diary: true },
      config: {
        diary: {
          world: false,
          kinds: { status: 1 },
          maxPerDay: 3,
          maxMessages: 2,
          historyPosts: 40,
          gistChars: 60,
          seedSets: 1,
        },
      },
    });
    Object.assign(hot.prompts, {
      'diary/task': 'Write your diary.',
      'diary/scene': 'SCENE_TASK',
      'diary/seeds/place': 'a pier',
    });
    const llm = {
      complete: (messages: unknown, options: { purpose?: string }) =>
        Promise.resolve(
          directorAnswer(messages, options) ?? { text: '<msg>μια ήσυχη μέρα</msg>', usage: {}, estimated: 5 }
        ),
    };
    const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => START });
    // Changed: the diary turn runs as the diary's post runs it, since diary.force is gone.
    await runnerOver({ port, hot, llm, store }).runTurn({ mode: 'diary', diary: { kind: 'thought', forced: false } });
    await store.flushSettled({});
    assert.deepEqual(
      rowsOf(memory.memoryDb, 'SELECT kind, text FROM diary'),
      [{ kind: 'thought', text: 'μια ήσυχη μέρα' }],
      'the entry exists in memory with its text'
    );
    assert.deepEqual(
      port.calls.filter((call) => call.op === 'send'),
      [],
      'nothing is sent'
    );
  });
});

const TEXT = 'ήσυχο βράδυ στο λιμάνι';

const BAD = `<audience>place:fake:channel:nowhere</audience><msg>${TEXT}</msg>`;

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

/** Whether the request tells the persona of a refused audience. */
const tells = (request: unknown): boolean => refusalBlock(request) !== null;

test('the persona hears of it once, and the owner keeps seeing it', async () => {
  // Catches: the same failure repeated on every later request, or telling the persona clearing the owner's view.
  const setup = await setting();
  await turn(setup, BAD);
  assert.equal(tells((await turn(setup, `<msg>${TEXT}</msg>`)).writer), true);
  assert.equal(refusalBlock((await turn(setup, `<msg>${TEXT}</msg>`)).writer), null);
  assert.equal(setup.scene.publisher().mirrorStatus()[0]?.audienceBlocked.length, 1);
});

test('a request the persona answered with silence still counts as telling them', async () => {
  // Catches: the mark tied to a recorded entry, so each skipped turn repeats the notice.
  const setup = await setting();
  await turn(setup, BAD);
  assert.equal(tells((await turn(setup, '<skip/>')).writer), true);
  assert.equal(refusalBlock((await turn(setup, `<msg>${TEXT}</msg>`)).writer), null);
});

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
function diaryTurnCreateTurnRunner(options: Parameters<typeof createWorldRunner>[0]) {
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

function diaryTurnFakeStore({ posts = [], data = {} }: { posts?: Array<Rec>; data?: Rec } = {}) {
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
  store = diaryTurnFakeStore(),
  llm,
  images = fakeImages(),
  lookup = null,
  // The lead: the code draws the diary's kind.
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
  return diaryTurnCreateTurnRunner({
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

test('diary turn: records the post with gists and message ids', async () => {
  // The lead: the code draws the diary's kind.
  const llm = fakeLlm(
    null,
    toolAnswer('<msg>un quai dans la brume, très calme ce soir</msg>', [
      call('draw.create', { people: [], text: 'the persona on a foggy pier at night, lanterns', self: true }),
    ])
  );
  const store = diaryTurnFakeStore();
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
  // The diary is the persona's, so the append names no place.
  const { post, opts } = appendedPost(store);
  // The post is recorded before anything is sent, so it carries the persona's full text and the entry's id and no
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
  const store = diaryTurnFakeStore();
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
  const turns = diaryTurnCreateTurnRunner({
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

// The diary wake keeps the id of its turn on the entry as `extra.turnId`, written through the one writer. The
// wake runs the real turn runner over tests/fixtures/diary-scene.ts with a real journal. Invented ids and
// synthetic text only.

/** The scenes a test opened, closed when the file is done. */
const DIARY_TURN_OPEN: Array<SceneMemory> = [];

/** The `extra` of a stored entry, parsed. */
function extraOf(db: ReturnType<typeof dbOf>, entryId: string): Record<string, unknown> {
  const raw = db.prepare('SELECT extra FROM diary WHERE id = ?').get(entryId)?.extra;
  assert.ok(typeof raw === 'string', `the entry ${entryId} has its extra`);
  return JSON.parse(raw) as Record<string, unknown>;
}

after(async () => {
  for (const scene of DIARY_TURN_OPEN.splice(0)) await scene.memory.close();
});

// The lead: kept without a removal command.
test('an entry written by a diary wake keeps the id of its turn as extra.turnId', async () => {
  // Bug: the entry is stored with no link to the turn that wrote it.
  const scene = await sceneMemory();
  DIARY_TURN_OPEN.push(scene);
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

// ---- voiced entries ----------------------------------------------------------------

const VOICE_PART = 'VOICE_PART';

/** A diary setting where the role `speech` has a route (or none with `speech: false`) and `diary.voiceChance` is `chance`. */
function voiceHot({ chance, speech = true }: { chance?: number; speech?: boolean } = {}) {
  const hot = fakeHot({
    diary: chance === undefined ? {} : { voiceChance: chance },
    prompts: { 'diary/voice': VOICE_PART },
  });
  Object.assign(hot.config, { models: { routes: chainsOf({ speech: speech ? 'x/speech' : null }) } });
  return hot;
}

test('diary voice: an entry of the voice alone is recorded with its voiced text and ends spoke', async () => {
  // Bug: a voiced entry with no <msg> counts as no speech, so the voice is made and the entry is lost.
  const store = diaryTurnFakeStore();
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
    diary: { kind: 'thought', forced: true },
  });
  assert.equal(loose(result).outcome, 'spoke');
  assert.equal(loose(appendedPost(store).post.voice).text, '[soft] bonsoir');
});

// The writer on the turn frame: the turn
// runs with `chat: null`, its request holds the diary list of the frame, and `<publication_places>` is a part of
// `<inner>` that lists the mirrors when there are two or more. tests/fixtures/diary-frame.ts holds the scene.

/** The diary list without `persona`, which is the system message and no root tag of the user text. */
const WRITER_TAGS = blocksOf('diary', null).filter((name) => name !== 'persona');

test('the writer request holds the frame list, with no <chat>, <surroundings>, <about_chat> or root <places>', async () => {
  // Bug: the writer is still built as a reply in the first mirror, with its chat, surroundings and the old place blocks.
  const run = await frameTurn();
  const text = run.writer[0] ?? '';
  const tags = rootTags(text);
  assert.ok(inOrderOf(tags, WRITER_TAGS), tags.join(' '));
  for (const tag of ['self', 'inner', 'spatial_awareness', 'task']) assert.ok(tags.includes(tag), `holds <${tag}>`);
  for (const tag of ['chat', 'surroundings', 'about_chat', 'places', 'meanwhile'])
    assert.ok(!tags.includes(tag), `no root <${tag}>`);
  assert.ok(blockOf(text, 'task').includes(MARK.writer), 'its own task');
});

const TOOLS_OPERATIONS_DIARY_NOW = Date.parse('2026-10-27T12:00:00Z');

const TOOLS_OPERATIONS_DIARY_ROOT = 'g1';

const MAX_PER_DAY = 3;

after(async () => {
  for (const item of OPEN.splice(0)) await item.close();
});

/**
 * A root with `general` (c1), where Alice wrote last, and the diary's two enabled mirrors `journal` (d1) and
 * `notes` (d2), on a fake interface; a real store over memory, the publisher over the interface's own port, and the persona's
 * tools through a real admin over the guarded port. `postsToday` diary entries are already counted today.
 */
async function root({ postsToday = 0 }: { postsToday?: number } = {}) {
  const memory = await openTestMemory({ now: () => TOOLS_OPERATIONS_DIARY_NOW });
  OPEN.push(memory);
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
  const turns = createRealTurnRunner({
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
    // A diary post reads the persona's past entries from memory alone (the frame's reads over the memory
    // database, under the context the turn issues), and never from a mirror's history through the store.
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

/** The `skills: called` lines of a turn, as `skill:status` and the code when there is one. */
const calledOf = (logs: Array<Record<string, unknown>>) =>
  logs
    .filter((entry) => entry.msg === 'skills: called')
    .map(
      (entry) =>
        `${String(entry.skill)}:${String(entry.status)}${typeof entry.code === 'string' ? `/${entry.code}` : ''}`
    );

/** The tools a request offered the persona, by their API names. */
const offeredIn = (options: unknown): Array<string> =>
  ((options as { tools?: Array<{ function: { name: string } }> } | undefined)?.tools ?? []).map(
    (tool) => tool.function.name
  );

// The diary turn keeps its requests byte for byte (section 4): the tools its writer request offers, and how it answers
// a `message.create` call, are what the code of main gave for the same turn in the diary channel
// (tests/fixtures/diary-tool.json, recorded under the same settings).
test('the diary turn offers the tools and answers a diary call as the diary channel turn did', async () => {
  const recorded = JSON.parse(fs.readFileSync(new URL('../../fixtures/diary-tool.json', import.meta.url), 'utf8')) as {
    writerHasTools: boolean;
    writerTools: Array<string>;
    called: Array<string>;
  }; // this test's own fixture, written by the recording of the scene on main
  // PR 7d: voice messages are code, so the recorded writer tools gained voice_say.
  const core = await root();
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const plan = JSON.stringify({ kind: 'thought', brief: 'a quiet day', search: '', picture: false, seed: 0 });
  const { llm, logs } = await turnOf(core, {
    mode: 'diary',
    answers: [
      plan,
      toolAnswer('<msg>μια ήσυχη μέρα</msg>', [call('message.create', { text: 'x' })]),
      '<msg>μια ήσυχη μέρα</msg>',
    ],
  });
  const writer = llm.options[1] as Record<string, unknown> | undefined; // the scripted model keeps each request's options
  assert.ok(writer, 'the diary turn made its writer request');
  assert.equal('tools' in writer, recorded.writerHasTools);
  assert.deepEqual(offeredIn(writer), recorded.writerTools);
  assert.deepEqual(calledOf(logs), recorded.called);
});

const PRIVATE_DIARY = 'private-diary-marker-731';

const internalDiaryContext = () =>
  issueContext({ kind: 'internal', now: () => TOOLS_OPERATIONS_DIARY_NOW, newId: () => 'ctx:private-diary' });

function diaryDb(core: Root) {
  const memoryDb = core.memory.memoryDb;
  const handle = memoryDb.readHandle();
  assert.ok(handle);
  return dbOf(handle);
}

test('a diary-mode internal turn records restricted provenance on its held speech', async () => {
  // Catches guarding diary tool calls while leaving the ordinary diary-mode producer unrestricted.
  const core = await root();
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const plan = JSON.stringify({ kind: 'thought', brief: 'a private day', search: '', picture: false, seed: 0 });
  await turnOf(core, {
    mode: 'diary',
    memoryContext: internalDiaryContext(),
    answers: [plan, `<msg>${PRIVATE_DIARY}</msg>`],
  });
  const [row] = diaryDb(core).prepare('SELECT text, scope_kind, extra FROM diary').all();
  assert.equal(row.text, PRIVATE_DIARY);
  assert.equal(row.scope_kind, 'internal');
  const extra = JSON.parse(String(row.extra)) as Record<string, unknown>;
  assert.ok(extra.publicationBoundary);
});
