import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createDiscordAdapter, createDiscordInterface } from '../../../interfaces/discord/index.ts';
import { handleOf } from '../../../src/behavior/handles.ts';
import { createTurnRunner as createRealTurnRunner } from '../../../src/behavior/turn.ts';
import { familyOf, ImageGenError } from '../../../src/llm/images.ts';
import { placeOfRoot } from '../../../src/memory/addresses.ts';
import type { GifLibrary } from '../../../src/memory/gifs.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import { createStore } from '../../../src/memory/store.ts';
import { CODE } from '../../../src/tools/codes.ts';
import '../../../src/tools/operations/index.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import type { TurnParams } from '../../../src/turn/outcome.ts';
import type { TriggerKind } from '../../../src/turn/triggers.ts';
import { type LogEntry, withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { entryOf, publishTo } from '../../fixtures/diary-mirror.ts';
import type { SceneMemory } from '../../fixtures/diary-scene.ts';
import { labels as baseLabels, labels } from '../../fixtures/labels.ts';
import { present, wrongly } from '../../fixtures/loose-types.ts';
import { ownedBy, OWNER_PERSON } from '../../fixtures/owner-accounts.ts';
import { asRecord } from '../../fixtures/records.ts';
import { directorAnswer } from '../../fixtures/scene-answer.ts';
import { memoryAt } from '../../fixtures/store-kit.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { call, completionOf, toolAnswer } from '../../fixtures/tool-answers.ts';
import {
  DRAW_CONFIG,
  DRAW_PROMPTS,
  fakeImages as drawGifFakeImages,
  drawTurn,
  fakeImages as turnCoreToolsFakeImages,
} from '../../fixtures/turn-draws.ts';
import {
  appended,
  contentText,
  fakeStore as drawGifFakeStore,
  type HotStandIn,
  NOW as TURN_CORE_TOOLS_NOW,
  WEB_CONFIG,
} from '../../fixtures/turn-harness.ts';
import {
  fakeClient,
  type FakeHot,
  fakeImageFetcher,
  fakeTurnChannel,
  identityCalibrator,
  NOW as MEDIA_PICK_TURN_NOW,
  fakeHot as mediaPickTurnFakeHot,
  fakeStore as mediaPickTurnFakeStore,
  rawMessage as mediaPickTurnRawMessage,
  normalizedTrigger,
  fakeHot as turnFakeHot,
  fakeStore as turnFakeStore,
  rawMessage as turnRawMessage,
} from '../../fixtures/turn-kit.ts';
import {
  createTurnRunner as mediaPickTurnCreateTurnRunner,
  createTurnRunner as turnCreateTurnRunner,
} from '../../fixtures/turn-runner.ts';
import {
  attachmentCount,
  type Channel,
  freshWorld,
  onWorld,
  type Posted,
  useIface,
  useSelf,
  world,
} from '../../fixtures/turn-world.ts';

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
 * Stage 3, the diary wake: a diary turn records the persona's entry and sends nothing itself, and the diary's mirror
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

  // PR 7d: the set kinds and their settings are constants of src/behavior/diary.ts: `photoset` is a set kind of 4 to 6
  // pictures, at least 2 posted, 6 seed sets, at most 8 000 000 bytes in one message.

  test('diary: a single picture is staged while the post is composed, then posted after its messages', async () => {
    // The code draws the diary's kind.
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
      // The outcome also names the persona's audience: no tag in the answer reads as unrestricted.
      audience: { ok: true, audience: { kind: 'unrestricted' } },
      entry: entryOf(result),
    });
    const firstAppended = store.appended[0];
    assert.equal(firstAppended.post.picture, 'a pier at night');
    assert.equal('pictures' in firstAppended.post, false, 'a single-picture kind records no count');
  });

  test('diary set: calls past diary.set.pictures[1] in one answer are loop-cap results; the speech waits and step 2 posts what was staged', async () => {
    // The code draws the diary's kind.
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
    const sixthPrompt = images.prompts[5];
    assert.ok(sixthPrompt.prompt.includes('scene 6'));
    assert.deepEqual(calledOf(logs).filter((line: string) => line.endsWith('loop-cap')).length, 2);
    // Stage 3: the turn sends nothing; the expectation below is what the mirror's publication of the entry sends.
    await published(result, channel);
    assert.deepEqual(
      channel.sent.filter((payload) => payload.content).map((payload) => payload.content),
      ['y']
    );
    assert.equal(loose(channel.sent.at(-1)).files.length, 6);
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
});

const SEEN = 'a laptop with its screen on the outside of the lid';

/** What the turn hands the persona's eyes for one picture. */
type Looked = {
  placeId: string;
  messageId?: string;
  itemId?: string;
  url?: string;
  buffer?: Buffer;
  mediaType?: string;
};

/** Eyes that answer `answer` (an Error is thrown) and keep every picture they were asked about. */
function eyes(answer: string | null | Error) {
  const asked: Array<Looked> = [];
  const describePicture = (picture: Looked): Promise<string | null> => {
    asked.push(picture);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return { asked, describePicture };
}

/** The stand-in lines for a description and for a look that failed. */
function withSeenLabels(hot: HotStandIn): void {
  const { tools } = labels;
  hot.prompts.labels = {
    ...labels,
    tools: { ...tools, result: { ...tools.result, seen: 'SEEN {description}', unseen: 'UNSEEN' } },
  };
}

/** The text of the persona's draw.create result in the second request. */
function drawResult(run: Awaited<ReturnType<typeof drawTurn>>): string {
  return contentText(appended(run.llm, 1).find((message) => message.role === 'tool')?.content);
}

/** The sends that carried a picture. */
const pictures = (run: Awaited<ReturnType<typeof drawTurn>>) =>
  run.sends.filter((send) => asRecord(send.attachments)?.length === 1);

const { ok: okLabel } = labels.tools.result;

const DRAW_ANSWERS = [
  toolAnswer('<think>x</think>', [call('draw.create', { people: [], text: 'my laptop' })]),
  '<skip/>',
];

test("a posted picture is looked at once and what the persona's eyes saw is in the result they read next", async () => {
  // Bug: draw.create answers ok with the reference alone, and the persona reads laughter at a broken picture as praise.
  const looking = eyes(SEEN);
  const run = await drawTurn({
    answers: DRAW_ANSWERS,
    runner: { describePicture: looking.describePicture },
    withHot: withSeenLabels,
  });
  const { calls } = run.llm;
  assert.equal(calls.length, 2);
  assert.equal(looking.asked.length, 1, 'one look per picture');
  const [firstLook] = looking.asked;
  assert.equal(firstLook?.placeId, 'c1');
  const result = drawResult(run);
  assert.ok(result.startsWith(okLabel), result);
  assert.ok(result.includes(`SEEN ${SEEN}`), result);
});

for (const [name, answer] of [
  ['answer nothing', null],
  ['throw', new Error('vision down')],
] as const) {
  test(`when the persona's eyes ${name}, the picture is still posted, the call is ok and the result says it could not be looked at`, async () => {
    // Bug: a failed look fails the call of a picture already posted, or leaves the persona to assume it came out as asked.
    const looking = eyes(answer);
    const run = await drawTurn({
      answers: DRAW_ANSWERS,
      runner: { describePicture: looking.describePicture },
      withHot: withSeenLabels,
    });
    assert.equal(pictures(run).length, 1);
    const result = drawResult(run);
    assert.ok(result.startsWith(okLabel), result);
    assert.ok(result.includes('UNSEEN'), result);
    assert.equal(result.includes('SEEN '), false, result);
  });
}

test('with no eyes the result names neither a description nor a failed look', async () => {
  // Bug: vision off is told to the persona as a failed look on every picture they draw.
  const run = await drawTurn({ answers: DRAW_ANSWERS, withHot: withSeenLabels });
  assert.equal(pictures(run).length, 1);
  const result = drawResult(run);
  assert.equal(result.includes('SEEN'), false, result);
});

test("a refused generation asks the persona's eyes nothing", async () => {
  // Bug: the look runs on a picture that does not exist and spends a vision request on nothing.
  const looking = eyes(SEEN);
  const run = await drawTurn({
    answers: DRAW_ANSWERS,
    images: drawGifFakeImages([new ImageGenError('moderation')]),
    runner: { describePicture: looking.describePicture },
    withHot: withSeenLabels,
  });
  assert.equal(pictures(run).length, 0);
  assert.equal(looking.asked.length, 0);
});

// ---------- the people a drawing shows ----------

const PEOPLE = [
  { id: 'u1', names: ['Alice'] },
  { id: 'u2', names: ['Zoë'] },
];

/** A record that keeps every line it is asked to append. */
function keptRecord() {
  const lines: Array<Record<string, unknown>> = [];
  return {
    lines,
    append: (_placeId: string, appended: ReadonlyArray<Record<string, unknown>>) => {
      lines.push(...appended);
      return Promise.resolve();
    },
  };
}

/** A drawing turn whose call is `args`, with Alice and Zoë known and the persona's said lines kept. */
async function drawWith(args: Record<string, unknown>, extra: Partial<Parameters<typeof drawTurn>[0]> = {}) {
  const record = keptRecord();
  const images = drawGifFakeImages();
  const run = await drawTurn({
    answers: [toolAnswer('<think>x</think>', [call('draw.create', { text: 'a picnic', ...args })]), '<skip/>'],
    images,
    store: drawGifFakeStore({ profiles: PEOPLE }),
    config: { ...DRAW_CONFIG, features: { record: true } },
    runner: { record },
    ...extra,
  });
  const said = record.lines.filter((line) => line.kind === 'said');
  return { run, images, said };
}

test('a draw.create call without people is refused before anything is drawn', async () => {
  // Bug: the list is optional, the persona leaves it out, and the picture is stored with nobody in it.
  const { images, run } = await drawWith({ self: true });
  assert.equal(images.calls.length, 0);
  assert.equal(pictures(run).length, 0);
});

test('a handle nobody goes by refuses the call before the drawing model is asked', async () => {
  // Bug: an unknown name is dropped and the picture is drawn and stored without the person the persona meant.
  const { images, run } = await drawWith({ self: false, people: ['Alice', 'Nobody'] });
  assert.equal(images.calls.length, 0);
  assert.equal(pictures(run).length, 0);
  const codes = run.logs.filter((entry) => entry.msg === 'skills: called').map((entry): unknown => entry.code);
  assert.deepEqual(codes, [CODE.UNKNOWN_MEMBER]);
});

test("an empty list with self true marks the drawing as the persona's showing themselves alone", async () => {
  // Bug: the persona's self-portrait reaches memory with no mark, and they later read it as a stranger's picture.
  const { said } = await drawWith({ self: true, people: [] });
  assert.equal(said.length, 1);
  assert.deepEqual(said[0]?.marks, { self: true, accounts: [] });
});

test('two handles with self false mark the drawing as showing those two and not the persona', async () => {
  // Bug: the people the persona named are lost, or they are put into a picture they are not in.
  const { said } = await drawWith({ self: false, people: ['Alice', 'Zoë'] });
  assert.equal(said.length, 1);
  assert.deepEqual(said[0]?.marks, { self: false, accounts: ['u1', 'u2'] });
});

test('the caption the persona gets back of their drawing carries the made mark and the people it shows', async () => {
  // Bug: the eyes name a character the persona's design resembles and nothing tells them the picture is of themselves and Alice.
  const looking = eyes(SEEN);
  const { run } = await drawWith(
    { self: true, people: ['Alice'] },
    {
      runner: { describePicture: looking.describePicture, record: keptRecord() },
      withHot: (hot) => {
        withSeenLabels(hot);
        const held = hot.prompts.labels as typeof labels;
        hot.prompts.labels = {
          ...held,
          transcript: {
            ...held.transcript,
            mediaMade: '[MADE]',
            mediaDepicts: '[SHOWS {names}]',
            mediaDepictsSelf: 'HERSELF',
          },
        };
      },
    }
  );
  const result = drawResult(run);
  assert.ok(result.includes('[MADE]'), result);
  // A person is written by the handle the persona can pass to a tool, never by a name.
  // The stand-in store links no person, so Alice's handle is cut from Alice's account, as every block of a request does.
  assert.ok(result.includes(`[SHOWS HERSELF, @${handleOf('u1')}]`), result);
});

const gifsCreateTurnRunner = onWorld(wrongly(createRealTurnRunner));

const DAY = 86_400_000;

const T0 = Date.UTC(2026, 8, 1);

const TENOR = 'https://tenor.com/view/cat-dance-123';

function gifLink(id: string, url = TENOR, title = 'Chat qui danse') {
  return { id, kind: 'gif', site: 'Tenor', title, text: '', thumbnailUrl: 'https://media.tenor.com/x.png', url };
}

function gifAttachment(id: string, name = 'réaction.gif') {
  return {
    id,
    kind: 'gif',
    name,
    url: `https://cdn.discordapp.com/attachments/c1/${id}/${name}?ex=1`,
    size: 10,
    durationSec: null,
  };
}

function msg(overrides = {}) {
  return {
    id: 'm1',
    placeId: 'c1',
    channelName: 'general',
    authorId: '1',
    authorName: 'Zoé',
    self: false,
    bot: false,
    content: '',
    ts: T0,
    replyToId: null,
    attachments: [],
    links: [],
    stickers: [],
    emojis: [],
    ...overrides,
  };
}

function withStore(fn: Untyped) {
  const dir = tempDir('nep-');
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = fn(createStore(memoryAt(dir)), dir);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result && typeof result.then === 'function') return result.finally(cleanup);
  cleanup();
  return result;
}

// --- the <gif> tag -----------------------------------------------------------

// B7: `<gif>` left the output contract; tests/src/llm/parse.test.ts holds what the parser does with one.

// --- the poster --------------------------------------------------------------

const GIFS_NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

function rawMessage(
  id: string,
  { attachments = new Map(), messageSnapshots }: { attachments?: Untyped; messageSnapshots?: Untyped } = {}
) {
  return {
    id,
    placeId: 'c1',
    author: { id: 'u1', bot: false, globalName: 'Zoé', username: 'Zoé' },
    member: { displayName: 'Zoé' },
    cleanContent: 'hey',
    createdTimestamp: GIFS_NOW - 1000,
    reference: null,
    attachments,
    stickers: new Map(),
    ...(messageSnapshots ? { messageSnapshots } : {}),
  };
}

function trigger(raw: Record<string, Untyped>) {
  return {
    id: raw.id,
    placeId: 'c1',
    authorId: 'u1',
    authorName: 'Zoé',
    self: false,
    bot: false,
    content: 'hey',
    ts: raw.createdTimestamp,
    replyToId: null,
    attachments: [],
    stickers: [],
  };
}

/** A channel of the world holding `historyMessages`; `fetched` lists the messages read by id, `fetchFails` makes that read fail. */
function fakeChannel({
  id = 'c1',
  historyMessages = [],
  fetchFails = false,
}: { id?: string; historyMessages?: Array<Untyped>; fetchFails?: boolean } = {}) {
  const fetched: Array<Untyped> = [];
  world().tap('fetchMessages', ([ref, ids]: Untyped) => {
    if (ref.chatId === id) fetched.push(...ids);
  });
  const channel = world().channel({ id, name: 'general', placeId: 'g1', historyMessages });
  if (fetchFails) world().failRead('fetchMessages', id);
  return Object.assign(channel, { fetched });
}

// PR 7d: the switches are code and the context and media measures constants, so only the settings stay.
function gifsFakeHot() {
  return {
    config: {
      bot: { timezone: 'UTC' },
      context: { channelMessages: 100, caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 } },
      llm: { maxRequestTokens: 50000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 1, betweenMessagesMs: [0, 0] },
    },
    prompts: {
      main: 'You are a regular member of this chat.',
      persona: 'Terse.',
      format: 'Use tags.',
      'turn/reply': 'Someone called you: {{author}}.',
      interject: 'Jump in.',
      initiate: 'Start a topic.',
      labels,
    },
  };
}

function calibrator() {
  return { ratio: 1, apply: (n: Record<string, Untyped>) => n, observe: () => {} };
}

/** A real store seeded with one link gif (g1, from m-old in c1) and one attached gif (g2, from m-att in c2). */
function seedLibrary(store: Record<string, Untyped>) {
  store.recordGifs(placeOfRoot(store, 'g1'), [
    msg({ id: 'm-old', placeId: 'c1', ts: GIFS_NOW - DAY, links: [gifLink('m-old#e0')] }),
    msg({ id: 'm-att', placeId: 'c2', ts: GIFS_NOW - DAY, attachments: [gifAttachment('att1')] }),
  ]);
  // A GIF is stored as one text, its description, written by the describer's cache entry.
  // `ha` is the word of the replies below.
  store.putMediaEntry(placeOfRoot(store, 'g1'), 'm-old#e0', { text: 'ha a cat dancing', ts: GIFS_NOW - DAY });
  store.putMediaEntry(placeOfRoot(store, 'g1'), 'att1', { text: 'ha an attached gif', ts: GIFS_NOW - DAY });
}

/**
 * B7: one turn with the media pick on an interface that declares GIF links and files: `output` is the persona's answer and `pick`
 * the classifier's. `<gif>` left the persona's output, so a GIF of theirs goes out only through the pick.
 */
type GifTurnRun = {
  result: { outcome: unknown };
  logs: Array<Record<string, Untyped>>;
  channel: { sent: Array<Posted> };
  gifs: GifLibrary;
};

async function runGifTurn({
  output,
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  pick = '{"pick":"none","name":null}',
  channelOpts = {},
  prepare,
  triggerKind = 'mention',
}: {
  output?: Untyped;
  pick?: string;
  channelOpts?: Record<string, Untyped>;
  prepare?: Untyped;
  triggerKind?: string;
} = {}): Promise<GifTurnRun> {
  return withStore(async (store: Record<string, Untyped>) => {
    seedLibrary(store);
    if (prepare) prepare(store);
    const raw = rawMessage('m1');
    const channel = fakeChannel({ historyMessages: [raw], ...channelOpts });
    const port = world().port as unknown as { capabilities: () => object };
    const declared = port.capabilities.bind(port);
    port.capabilities = () => ({ ...declared(), mediaPick: { gifForms: ['file', 'link'] } });
    const hot: Untyped = gifsFakeHot();
    Object.assign(hot.prompts, { 'classify/pick': 'Pick for {{name}}.' });
    hot.config.models = { routes: chainsOf({ analyzer: 'cheap/classifier' }) };
    const llm = {
      complete: (_messages: Untyped, options: Untyped) =>
        Promise.resolve({ text: options?.purpose === 'media-pick' ? pick : output, usage: {}, estimated: 10 }),
    };
    const turns = gifsCreateTurnRunner({
      hot,
      store,
      llm,
      calibrator: calibrator(),
      now: () => GIFS_NOW,
    });
    const { result, logs } = await withCapturedLogs(() =>
      turns.runTurn({ channel, mode: 'reply', trigger: trigger(raw), triggerKind })
    );
    return { result, logs, channel, state: store.state.data, gifs: store.getGifs() };
  });
}

test('the pick: a link handle sends the stored url in place of the first message, as a reply', async () => {
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const { result, channel } = await runGifTurn({
    output: '<msg reply="#1">ha</msg><msg>more</msg>',
    pick: '{"pick":"gif","name":"g1"}',
  });
  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent.length, 2);
  const firstSent = channel.sent[0];
  assert.equal(firstSent.content, TENOR);
  const secondSent = channel.sent[1];
  assert.equal(secondSent.content, 'more');
  assert.equal(firstSent.reply?.messageReference, 'm1');
});

test('the pick: a sent gif stamps ownLast and ownUses on its entry, for the place it went to', async () => {
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const { gifs } = await runGifTurn({ output: '<msg>ha</msg>', pick: '{"pick":"gif","name":"g1"}' });
  const entry = gifs.entries['m-old#e0'];
  assert.equal(entry.ownLast, GIFS_NOW);
  assert.equal(entry.ownUses, 1);
  const entryC1 = entry.places.c1;
  assert.equal(entryC1?.ownLast, GIFS_NOW);
  assert.equal(entry.count, 1, "the members' count is not touched");
  assert.equal('ownLast' in gifs.entries.att1, false);
});

test('the pick: a gif alone is a turn; a follow-up never replies', async () => {
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const withReply = await runGifTurn({ output: '<msg reply="#1">ha</msg>', pick: '{"pick":"gif","name":"g1"}' });
  assert.equal(withReply.result.outcome, 'spoke');
  const withReplySent = withReply.channel.sent;
  assert.equal(withReplySent.length, 1);
  const withReplySentReply = withReplySent[0].reply;
  assert.equal(withReplySentReply?.messageReference, 'm1');
  const followUp = await runGifTurn({
    output: '<msg reply="#1">ha</msg>',
    pick: '{"pick":"gif","name":"g1"}',
    triggerKind: 'followUp',
  });
  const followUpSent = followUp.channel.sent;
  assert.equal(followUpSent.length, 1);
  assert.equal(followUpSent[0].reply, undefined);
});

test('the pick: an attachment with no cached file re-fetches its message and sends the fresh url', async () => {
  const fresh = 'https://cdn.discordapp.com/attachments/c2/att1/r%C3%A9action.gif?ex=fresh';
  const original = rawMessage('m-att', { attachments: new Map([['att1', { id: 'att1', url: fresh }]]) });
  const source = fakeChannel({ id: 'c2', historyMessages: [original] });
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const { channel, logs } = await runGifTurn({ output: '<msg>ha</msg>', pick: '{"pick":"gif","name":"g2"}' });
  assert.deepEqual(source.fetched, ['m-att']);
  const firstSent = channel.sent[0];
  assert.equal(firstSent.content, fresh);
  const line = logs.find((l: Record<string, Untyped>) => l.msg === 'turn: gif sent');
  assert.equal(line?.fresh, true);
  assert.equal(line?.gif, 'g2');
});

test('the pick: an attachment in a forwarded snapshot is found too', async () => {
  const fresh = 'https://cdn.discordapp.com/attachments/c2/att1/x.gif?ex=fwd';
  const snapshots = new Map([['s', { attachments: new Map([['att1', { id: 'att1', url: fresh }]]) }]]);
  const original = rawMessage('m-att', wrongly({ messageSnapshots: snapshots }));
  fakeChannel({ id: 'c2', historyMessages: [original] });
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const { channel } = await runGifTurn({ output: '<msg>ha</msg>', pick: '{"pick":"gif","name":"g2"}' });
  const firstSent = channel.sent[0];
  assert.equal(firstSent.content, fresh);
});

test('the pick: a failed re-fetch falls back to the stored url', async () => {
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const { channel, logs } = await runGifTurn({ output: '<msg>ha</msg>', pick: '{"pick":"gif","name":"g2"}' });
  const firstSent = channel.sent[0];
  assert.equal(firstSent.content, gifAttachment('att1').url);
  assert.ok(logs.find((l: Record<string, Untyped>) => l.msg === 'turn: gif refetch failed'));
  assert.equal(logs.find((l: Record<string, Untyped>) => l.msg === 'turn: gif sent')?.fresh, false);
});

test('the pick: an unknown handle posts the text as written', async () => {
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const { result, channel, logs } = await runGifTurn({ output: '<msg>ha</msg>', pick: '{"pick":"gif","name":"g99"}' });
  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(
    channel.sent.map((p: Record<string, Untyped>) => p.content),
    ['ha']
  );
  assert.equal(logs.find((l: Record<string, Untyped>) => l.msg === 'media-pick: answered')?.kind, 'none');
});

const mediaDrawCreateTurnRunner = onWorld(wrongly(createRealTurnRunner));

// Tuesday, October 6, 2026, 22:30 in Europe/Athens.
const MEDIA_DRAW_NOW = Date.UTC(2026, 9, 6, 19, 30, 0);

const AVATAR = 'data:image/png;base64,QVZBVEFS';

const FOLDERS: Array<string> = [];

after(() => {
  for (const folder of FOLDERS.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const LABELS = { ...baseLabels, draw: { ...baseLabels.draw, when: 'At {when}.' } };

const PROMPTS = {
  main: 'SYSTEM for {{name}}',
  persona: 'CARD_TEXT',
  format: 'FORMAT_TEXT',
  'turn/reply': 'Someone called you: {{author}}.',
  'diary/task': 'DIARY_TASK for {{name}}',
  'diary/scene': 'SCENE_TASK',
  'diary/seeds/place': 'a pier',
  'diary/seeds/setting': 'fog',
  draw: 'A drawing by {{name}}.\n\n{{appearance}}\n\n{{when}}\n\nScene: {{request}}',
  appearance: '{{name}} has silver hair and a green scarf.',
  labels: LABELS,
};

function hot() {
  return {
    // PR 7d: the switches are code, the daily caps are gone and the diary's kinds and sets are constants of
    // src/behavior/diary.ts (`photoset` is a set of 4 to 6 pictures), so only the settings stay.
    config: {
      bot: { timezone: TZ, ownerPerson: OWNER_PERSON },
      context: {
        channelMessages: 50,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { fetchTimeoutMs: 7000 },
        pull: { sameAudience: true },
      },
      llm: { maxRequestTokens: 50000 },
      models: { routes: chainsOf({ drawing: 'openai/image-model' }) },
      typing: { reactionDelayMs: [0, 0], msPerChar: [0, 0], minMs: 0, maxMs: 0, betweenMessagesMs: [0, 0] },
      image: { referenceMaxBytes: 4_000_000 },
      diary: { placeId: 'd1', world: false },
    },
    prompts: { ...PROMPTS },
  };
}

/** A text channel of the world with every permission; `history` its raw messages. */
function channel(id: string, name: string, history: Array<Untyped> = []) {
  return world().channel({ id, name, placeId: 'g1', historyMessages: history });
}

/** The bot user and the served guild; the interface gives the persona's large avatar as an address. */
function client() {
  const guild = { id: 'g1', name: 'The Server', members: { me: { displayName: 'Bot' } } };
  world().member('g1', {
    id: 'self-id',
    name: 'Bot',
    avatar: { hash: null, url: null, largeUrl: 'https://cdn.example/avatar.png' },
  });
  return {
    user: { id: 'self-id', username: 'Bot' },
    guilds: { cache: new Map([['g1', guild]]) },
    channels: { cache: new Map([['d1', { id: 'd1', name: 'journal' }]]) },
  };
}

/** The avatar download: always the same small data: URL. */
function imageFetcher() {
  return { fetchAsDataUrl: async () => ({ dataUrl: AVATAR, bytes: 6, contentType: 'image/png' }) };
}

/** The image client boundary: every generate() call's arguments, as given. */
/** What the draw call hands the image client: the prompt, the reference picture and the member it is charged to. */
type ImageCall = { prompt: string; reference: unknown; accountId?: string };

function recordingImages() {
  const calls: Array<ImageCall> = [];
  return {
    calls,
    familyOf,
    generate: async (args: ImageCall) => {
      calls.push(structuredClone(args));
      return {
        buffer: Buffer.from('png'),
        mediaType: 'image/png',
        seconds: 1,
        cost: 0,
        usage: {},
        model: 'openai/image-model',
      };
    },
  };
}

function store() {
  return {
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
    getDiary: () => ({ posts: [], updatedAt: 0 }),
    appendDiaryPost: () => ({ dropped: [] }),
    state: { data: {}, markDirty() {} },
  };
}

/** An LLM answering the director with a scene and every other request with `post`. */
function llm(post: Untyped) {
  let composed = 0;
  return {
    complete: async (messages: Record<string, Untyped>, opts: Record<string, Untyped>) => {
      const scene = directorAnswer(messages, opts);
      if (scene) return scene;
      const answer = Array.isArray(post) ? post[Math.min(composed, post.length - 1)] : post;
      composed += 1;
      return completionOf(answer);
    },
  };
}

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['42']);

describe('a drawn picture', () => {
  // A staged diary picture is looked at from its own bytes, and what the persona's eyes saw comes
  // back in the result of its draw.create call.
  test('diary: a staged picture is looked at once from its bytes and the description is in the result the persona reads next', async () => {
    // Bug: a staged picture answers `staged` alone, and the persona's diary entry speaks of a picture they never saw.
    const asked: Array<{ placeId: string; buffer?: Buffer; mediaType?: string }> = [];
    const describePicture = (picture: { placeId: string; buffer?: Buffer; mediaType?: string }) => {
      asked.push(picture);
      return Promise.resolve('a pier in fog, the rail bent');
    };
    const { tools } = LABELS;
    const seenLabels = { ...LABELS, tools: { ...tools, result: { ...tools.result, seen: 'SEEN {description}' } } };
    const hotValue = { ...hot(), prompts: { ...PROMPTS, labels: seenLabels } };
    const base = llm([
      toolAnswer('<think>x</think>', [call('draw.create', { people: [], text: 'the pier in fog' })]),
      '<msg>the pier</msg>',
    ]);
    const requests: Array<Array<Record<string, Untyped>>> = [];
    const recording = {
      complete: (messages: Array<Record<string, Untyped>>, opts: Record<string, Untyped>) => {
        if (opts?.purpose !== 'diary-scene') requests.push(messages);
        return base.complete(wrongly(messages), opts);
      },
    };
    client();
    const turns = mediaDrawCreateTurnRunner({
      hot: hotValue,
      store: store(),
      llm: recording,
      calibrator: { ratio: 1, apply: (n: Record<string, Untyped>) => n, observe: () => {} },
      images: recordingImages(),
      imageFetcher: imageFetcher(),
      lookup: null,
      rng: () => 0.5,
      now: () => MEDIA_DRAW_NOW,
      describePicture,
    });
    await withCapturedLogs(() =>
      turns.runTurn({ channel: channel('d1', 'journal'), mode: 'diary', diary: { kind: 'picture', forced: false } })
    );
    assert.equal(requests.length, 2, 'the persona reads the staged result in one more step');
    assert.equal(asked.length, 1, 'one look per picture');
    const [look] = asked;
    assert.equal(present(look).buffer?.toString(), 'png');
    assert.equal(present(look).mediaType, 'image/png');
    const second = JSON.stringify(present(requests[1]));
    assert.ok(second.includes('SEEN a pier in fog, the rail bent'), second.slice(-600));
  });
});

const URL_G1 = 'https://tenor.com/view/g1';

/** One described link GIF in the shared library. */
// A GIF is stored as one text.
function sharedLibrary(texts: object = { description: 'ναι φυσικά γνέφει' }) {
  return {
    nextId: 2,
    backfill: null,
    entries: {
      k1: {
        id: 'g1',
        kind: 'link',
        url: URL_G1,
        itemId: 'item-1',
        messageId: 'm-1',
        placeId: 'c1',
        count: 3,
        last: MEDIA_PICK_TURN_NOW - 3_600_000,
        firstSeen: MEDIA_PICK_TURN_NOW - 7_200_000,
        ...texts,
        nativeIds: ['item-1'],
        links: [URL_G1],
        places: { c1: { count: 3, last: MEDIA_PICK_TURN_NOW - 3_600_000 } },
      },
    },
  };
}

/** The adapter of this turn's world declares `mediaPick` beside what it already declares. */
function declare(mediaPick: unknown): void {
  const port = world().port as unknown as { capabilities: () => object };
  const declared = port.capabilities.bind(port);
  port.capabilities = () => ({ ...declared(), mediaPick });
}

async function runScene({
  reply = '<msg reply="#2">ναι, φυσικά, έλα</msg>',
  // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  pick = '{"pick":"none","name":null}',
  mediaPick = null,
  failLink = false,
  texts,
}: { reply?: string; pick?: string; mediaPick?: object | null; failLink?: boolean; texts?: object } = {}) {
  if (mediaPick) declare(mediaPick);
  if (failLink) world().failSends((text) => String(text).startsWith('https://tenor.com/'));
  const raws = [
    mediaPickTurnRawMessage({ id: 'm0', ts: MEDIA_PICK_TURN_NOW - 5000, content: 'καλημέρα' }),
    mediaPickTurnRawMessage({ id: 'm1', ts: MEDIA_PICK_TURN_NOW - 1000, content: 'θα έρθεις απόψε;' }),
  ];
  const channel = fakeTurnChannel({ historyMessages: raws });
  const calls: Array<{ messages: Array<{ content: unknown }>; options: Record<string, Untyped> }> = [];
  const hot = mediaPickTurnFakeHot(
    {},
    {},
    {
      media: { maxPerTurn: 6, filePreviewChars: 500, pick: { maxOutputTokens: 17, candidates: 5 } },
      models: { routes: chainsOf({ analyzer: 'cheap/classifier' }) },
    }
  );
  // The old prompt stays beside the new one: a picker that still reads it, or that runs on an interface without the
  // capability, shows up as a pick request.
  Object.assign(hot.prompts, { 'classify/pick': 'Pick for {{name}}.', 'gif-pick': 'Pick for {{name}}.', labels });
  const library = sharedLibrary(texts);
  const known = { key: 'k1', ...library.entries.k1 };
  const store = Object.assign(mediaPickTurnFakeStore({ mediaCache: { 'item-1': { text: 'ναι φυσικά γνέφει' } } }), {
    getGifs: () => library,
    // Whatever arguments it is called with, the last one is the handle.
    findGif: (...given: Array<string>) => (given.at(-1) === 'g1' ? known : null),
    getEmojiRails: () => null,
    setEmojiRails: () => {},
    recordOwnGif: () => {},
  });
  const turns = mediaPickTurnCreateTurnRunner({
    hot,
    store,
    llm: {
      complete: (messages: Array<{ content: unknown }>, options: Record<string, Untyped>) => {
        calls.push({ messages, options });
        const text = options?.purpose === 'media-pick' ? pick : reply;
        return Promise.resolve({ text, usage: {}, estimated: 10 });
      },
    },
    calibrator: identityCalibrator(),
    client: fakeClient(),
    now: () => MEDIA_PICK_TURN_NOW,
  });
  const trigger = normalizedTrigger(raws[1]);
  const result = await turns.runTurn(wrongly({ channel, mode: 'reply', trigger, triggerKind: 'mention' }));
  const isPick = (call: (typeof calls)[number]): boolean => /^(?:media|gif)-pick$/.test(String(call.options?.purpose));
  const picks = calls.filter(isPick);
  const reply0 = calls.find((call) => !isPick(call));
  return { result, picks, reply0, sent: channel.sent.map((payload: { content: unknown }) => payload.content) };
}

describe('a media pick in a turn', () => {
  beforeEach(() => {
    freshWorld();
  });

  test('a picked GIF is posted in place of the first message and the rest follow', async () => {
    const { picks, sent } = await runScene({
      reply: '<msg>ναι, φυσικά, έλα</msg><msg>στις οκτώ</msg>',
      // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
      pick: '{"pick":"gif","name":"g1"}',
      mediaPick: { gifForms: ['file', 'link'] },
    });
    assert.equal(picks.length, 1);
    assert.deepEqual(sent, [URL_G1, 'στις οκτώ']);
  });

  test('a refused post leaves the text message in place', async () => {
    const { picks, sent } = await runScene({
      // Elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
      pick: '{"pick":"gif","name":"g1"}',
      mediaPick: { gifForms: ['file', 'link'] },
      failLink: true,
    });
    const picksOptions = picks[0]?.options;
    assert.equal(picksOptions?.purpose, 'media-pick');
    assert.ok(sent.includes('ναι, φυσικά, έλα'), JSON.stringify(sent));
  });
});

// The casts through `Parameters<typeof f>` hand a function a fake that carries only the fields the test reads.

/** The content of the tool message of call `n` (0-based) in request `i`: what the persona read of that call. */
function toolContent(llm: Untyped, i: number, n = 0) {
  const llmCall = llm.calls[i];
  const message = llmCall.filter((item: Untyped) => item.role === 'tool')[n];
  return typeof message?.content === 'string'
    ? message.content
    : (message?.content ?? []).map((part: Untyped) => part.text ?? '').join('');
}

/** A recall runner fake: records each run and answers `quotes`. */
function fakeRecall(
  quotes = [
    {
      placeId: 'c2',
      channelName: 'jardin',
      startTs: TURN_CORE_TOOLS_NOW - 3 * 86_400_000,
      lines: '[09:00] Éloïse: ένα κουνέλι στον κήπο',
    },
  ]
) {
  const runs: Array<Untyped> = [];
  return {
    runs,
    available: () => true,
    run: async (args: unknown) => (runs.push(args), { text: null, stretch: null, people: [], quotes, stats: {} }),
  };
}

// draw.create as an in-turn tool: the picture is made and posted by the turn itself, every failure comes back as a result.

const calledLogs = (run: Untyped) =>
  run.logs.filter((entry: Untyped) => entry.msg === 'skills: called' && entry.skill === 'draw.create');

test("draw.create in the loop: the turn makes the picture from the persona's scene and posts it as a file in this channel, the member who asked charged", async () => {
  const images = turnCoreToolsFakeImages();
  const run = await drawTurn({
    answers: [toolAnswer('', [call('draw.create', { people: [], text: 'ένας φάρος το σούρουπο' })]), '<skip/>'],
    images,
  });
  assert.equal(images.calls.length, 1);
  assert.equal(asRecord(images.calls[0]).accountId, 'u1', "the asking member's rail");
  assert.match(asRecord(images.calls[0]).prompt, /Scene: ένας φάρος το σούρουπο$/);
  const picture = run.sends.find((send) => asRecord(send.attachments)?.length === 1);
  assert.equal(picture?.to, 'c1');
  assert.equal(asRecord(picture?.attachments)[0].contentType, 'image/png');
  assert.equal(picture?.replyTo, undefined);
  assert.deepEqual(
    calledLogs(run).map((entry: Untyped) => [entry.status, entry.code ?? null]),
    [['ok', null]]
  );
  assert.ok(!run.logs.some((entry) => entry.msg === 'turn: draw refused by a limit' && entry.asked === false));
});

test('draw.create: the generation failures come back as results with their own codes; no limit notice', async () => {
  const { ImageGenError } = await import('../../../src/llm/images.ts');
  const cases: Array<[Error, string]> = [
    [new ImageGenError('moderation'), 'image-moderation'],
    [new ImageGenError('timeout'), 'image-timeout'],
    [new ImageGenError('error'), 'image-error'],
    [new ImageGenError('empty'), 'image-error'],
  ];
  for (const [failure, code] of cases) {
    const run = await drawTurn({
      answers: [toolAnswer('', [call('draw.create', { people: [], text: 'ένας φάρος' })]), '<skip/>'],
      images: turnCoreToolsFakeImages([failure]),
    });
    assert.deepEqual(
      calledLogs(run).map((entry: Untyped) => [entry.status, entry.code]),
      [['failed', code]],
      code
    );
    assert.equal(run.sends.filter((send) => asRecord(send.attachments)?.length).length, 0, `${code}: nothing posted`);
    assert.equal(run.sends.length, 0, `${code}: no limit notice`);
    const resultLabels = labels.tools.result;
    assert.ok(
      toolContent(run.llm, 1).startsWith(resultLabels.failed.split(':')[0]),
      `${code}: the persona reads that it failed`
    );
    assert.ok(!run.logs.some((entry) => entry.msg === 'turn: draw refused by a limit' && entry.asked !== true), code);
  }
});

test('draw.create: an upload the port could not confirm is unknown, one it refused is failed; the picture is generated once either way', async () => {
  for (const status of ['unknown', 'failed']) {
    const images = turnCoreToolsFakeImages();
    const run = await drawTurn({
      answers: [toolAnswer('', [call('draw.create', { people: [], text: 'ένας φάρος' })]), '<skip/>'],
      images,
      setup: (port) =>
        port.failNext('send', { status, error: { code: 'timeout' } } as unknown as Parameters<typeof port.failNext>[1]),
    });
    assert.equal(images.calls.length, 1, status);
    assert.deepEqual(
      calledLogs(run).map((entry: Untyped) => [entry.status, entry.code]),
      [[status, 'timeout']],
      status
    );
    assert.equal(run.sends.length, 1, `${status}: the one upload that was tried`);
  }
});

test('draw.create: reply quotes that message here; a channel the persona names is where it goes', async () => {
  const jardin = {
    id: 'c2',
    name: 'jardin',
    root: { id: 'g1' },
    isTextBased: () => true,
    isDMBased: () => false,
    viewable: true,
    permissionsFor: () => ({ has: () => true }),
  };
  const here = await drawTurn({
    answers: [toolAnswer('', [call('draw.create', { people: [], reply: '#2', text: 'ένας φάρος' })]), '<skip/>'],
  });
  const quoted = here.sends.find((send) => asRecord(send.attachments)?.length === 1);
  assert.deepEqual(
    [quoted?.to, asRecord(quoted?.replyTo).chatId, asRecord(quoted?.replyTo).messageId],
    ['c1', 'c1', 'm1']
  );
  const there = await drawTurn({
    answers: [toolAnswer('', [call('draw.create', { people: [], place: '#jardin', text: 'ένας φάρος' })]), '<skip/>'],
    neighbours: [jardin],
  });
  assert.deepEqual(
    there.sends.filter((send) => asRecord(send.attachments)?.length).map((send) => send.to),
    ['c2']
  );
});

test('draw.create: a reply to a message of another channel (a quoted line of a search) follows it there', async () => {
  const theirs = { id: 'q2', authorId: 'u7', self: false, content: 'ξένο' };
  const recall = fakeRecall([
    {
      placeId: 'c2',
      channelName: 'jardin',
      startTs: TURN_CORE_TOOLS_NOW - 3 * 86_400_000,
      lines: 'ignored',
      entries: [{ id: 'q2', text: '[09:00] Éloïse: ένα κουνέλι', authorId: 'u7', self: false, message: theirs }],
    },
  ] as unknown as Parameters<typeof fakeRecall>[0]);
  const jardin = {
    id: 'c2',
    name: 'jardin',
    root: { id: 'g1' },
    isTextBased: () => true,
    isDMBased: () => false,
    viewable: true,
    permissionsFor: () => ({ has: () => true }),
  };
  const probe = await drawTurn({
    answers: [toolAnswer('', [call('memory.search', { question: 'κουνέλι' })]), '<skip/>'],
    allowed: ['memory.search', 'draw.create'],
    features: { recall: true },
    config: { ...DRAW_CONFIG, ...WEB_CONFIG },
    runner: { recall },
  } as unknown as Parameters<typeof drawTurn>[0]);
  const handle = Number(/^#(\d+) \[09:00\] /m.exec(toolContent(probe.llm, 1))?.[1]);
  assert.ok(handle > 3, toolContent(probe.llm, 1));
  const run = await drawTurn({
    answers: [
      toolAnswer('', [call('memory.search', { question: 'κουνέλι' })]),
      toolAnswer(``, [call('draw.create', { people: [], reply: `#${handle}`, text: `ένα κουνέλι` })]),
      '<skip/>',
    ],
    allowed: ['memory.search', 'draw.create'],
    features: { recall: true },
    config: { ...DRAW_CONFIG, ...WEB_CONFIG },
    runner: { recall },
    neighbours: [jardin],
    seeds: [{ chatId: 'c2', authorId: 'u7', messageId: 'q2', text: 'ξένο' }],
    loop: { maxSteps: 4 },
  } as unknown as Parameters<typeof drawTurn>[0]);
  const picture = run.sends.find((send) => asRecord(send.attachments)?.length === 1);
  assert.ok(picture, JSON.stringify(calledLogs(run)));
  assert.deepEqual(
    [picture.to, asRecord(picture.replyTo).chatId, asRecord(picture.replyTo).messageId],
    ['c2', 'c2', 'q2']
  );
});

test("draw.create on a turn nobody asked (the persona's own initiative): the picture is charged to no member, and it is posted all the same", async () => {
  const wake = {
    kind: 'intention_due',
    items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
    intentions: [{ id: 'i1', purpose: 'ζωγράφισε κάτι', dueAt: TURN_CORE_TOOLS_NOW - 60_000 }],
    now: TURN_CORE_TOOLS_NOW,
    timezone: 'UTC',
    channels: [],
  };
  const images = turnCoreToolsFakeImages();
  const run = await drawTurn({
    answers: [toolAnswer('', [call('draw.create', { people: [], text: 'ένας φάρος' })]), '<skip/>'],
    images,
    inner: wake,
    config: { ...DRAW_CONFIG, wakes: { mode: 'live', chatMessages: 2 } },
    prompts: { ...DRAW_PROMPTS, 'turn/inner': 'Do what the wake says.' },
  });
  assert.equal(images.calls.length, 1, JSON.stringify(run.logs.filter((l) => /skill/.test(l.msg))));
  assert.equal(asRecord(images.calls[0]).accountId, null, "nobody's rail");
  assert.equal(run.sends.filter((send) => asRecord(send.attachments)?.length === 1).length, 1);
});

/** The test memory databases opened here; closed when the file is done. */
const OPENED_MEMORY: Array<{ close: () => Promise<void> }> = [];

after(async () => {
  for (const mem of OPENED_MEMORY) await mem.close();
});

// The Discord interface's capabilities object, as src/index.ts injects it.
const DISCORD = createDiscordInterface().capabilities;

// ---------------------------------------------------------------------------
// Drawing: the persona's <draw> goes to the image client after its messages;
// a failed generation gets its own follow-up turn.

// A picture of the persona takes `appearance.png` of the data folder
// as its reference, and the avatar is not fetched for drawing.
const DRAW_IMAGE_CFG = { referenceMaxBytes: 4_000_000 };

const LOOK_BYTES = Buffer.from('LOOK-PNG-BYTES');

const DRAW_FOLDERS: Array<string> = [];

after(() => {
  for (const folder of DRAW_FOLDERS.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A fresh data folder under TMPDIR, holding `appearance.png` when `withLook`. */
function drawDataDir(withLook: boolean): string {
  const folder = mkdtempSync(path.join(tmpdir(), 'appearance-'));
  DRAW_FOLDERS.push(folder);
  if (withLook) writeFileSync(path.join(folder, 'appearance.png'), LOOK_BYTES);
  return folder;
}

/** A fake createImageGen()-shaped dependency (see src/llm/images.ts). */
function turnFakeImages({ error = null, mediaType = 'image/png' }: { error?: Error | null; mediaType?: string } = {}) {
  const generateCalls: Array<Untyped> = [];
  return {
    generateCalls,
    generate: async (args: unknown) => {
      generateCalls.push(args);
      if (error) throw error;
      return {
        buffer: Buffer.from('fake picture'),
        mediaType,
        cost: 0.02,
        usage: {},
        model: 'fake/model',
        seconds: 1.5,
      };
    },
  };
}

/** A fake LLM answering each call with the next text of `answers` (the last one repeats). */
/** An LLM answering `answers` in turn (the last one repeats); an answer is its text, or the completion's fields over the defaults. */
function sequenceLlm(answers: Array<string | Record<string, unknown>>) {
  const calls: Array<Untyped> = [];
  const options: Array<Untyped> = [];
  return {
    calls,
    options,
    complete: async (messages: unknown, requestOptions: unknown) => {
      calls.push(messages);
      options.push(requestOptions ?? {});
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      return typeof answer === 'string'
        ? { text: answer, usage: {}, estimated: 10 }
        : { usage: {}, estimated: 10, ...answer };
    },
  };
}

function drawHot(
  features: Record<string, unknown> = {},
  image: Record<string, unknown> = {},
  bot: Record<string, unknown> = {}
) {
  const hot = turnFakeHot({ ...features }, bot, { image: { ...DRAW_IMAGE_CFG, ...image } });
  hot.prompts.draw = 'Drawing for {{name}}.\n\n{{appearance}}\n\n{{request}}';
  hot.prompts.appearance = '{{name}} wears a green scarf.';
  hot.prompts['turn/reply'] = 'Someone called you: {{author}}, they {{trigger}}.';
  return hot;
}

async function runDrawTurn({
  answers,
  hot = drawHot(),
  images = turnFakeImages(),
  client = fakeClient(),
  imageFetcher = fakeImageFetcher(),
  withTrigger = true,
  attachFiles = true,
  triggerKind = 'mention',
  dataDir = null,
}: {
  answers: Array<string | Record<string, unknown>>;
  hot?: FakeHot;
  images?: ReturnType<typeof turnFakeImages>;
  client?: ReturnType<typeof fakeClient>;
  imageFetcher?: ReturnType<typeof fakeImageFetcher>;
  withTrigger?: boolean;
  attachFiles?: boolean;
  triggerKind?: TriggerKind;
  dataDir?: string | null;
}) {
  const raw = turnRawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', content: 'draw me a cat' });
  const channel = fakeTurnChannel({ id: 'c1', name: 'general', historyMessages: [raw], attachFiles });
  const llm = sequenceLlm(answers);
  const turns = turnCreateTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: turnFakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client,
    images,
    imageFetcher,
    dataDir,
  });
  const params: TurnParams = withTrigger
    ? { channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind }
    : { channel, mode: 'interject' };
  const { result, logs } = await withCapturedLogs(() => turns.runTurn(params));
  return { result, logs, channel, llm, images, imageFetcher, turns };
}

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['u1']);

describe('a whole turn', () => {
  test('runTurn: the file name follows the media type (image/jpeg -> .jpg)', async () => {
    const { channel } = await runDrawTurn({
      answers: [toolAnswer('', [call('draw.create', { people: [], text: 'a cat' })])],
      images: turnFakeImages({ mediaType: 'image/jpeg' }),
    });
    const firstSent = channel.sent[0];
    const firstFile = firstSent.files?.[0];
    assert.equal(firstFile?.name, 'image.jpg');
  });

  // The drawing scene is kept whole.
  test('runTurn: the draw request reaches the image model whole', async () => {
    const text = 'abcdefghij '.repeat(300).trim();
    const { images } = await runDrawTurn({
      answers: [toolAnswer('', [call('draw.create', { people: [], text })])],
      hot: drawHot({}),
    });
    const firstGenerateCall = images.generateCalls[0];
    assert.ok(firstGenerateCall.prompt.endsWith(`\n\n${text}`));
  });

  // The reference is `appearance.png` of the data folder; the avatar is not asked for or fetched.
  test('runTurn: a self <draw> passes appearance.png of the data folder as reference', async () => {
    const avatarAsks: Array<Untyped> = [];
    world().tap('memberInfo', ([member]: Array<Untyped>) => {
      if (member.accountId === 'self-id') avatarAsks.push(member.accountId);
    });
    world().member('g1', {
      id: 'self-id',
      name: 'Bot',
      avatar: { hash: null, url: null, largeUrl: 'https://cdn.example.com/avatar.png' },
    });
    const imageFetcher = fakeImageFetcher({
      dataUrl: 'data:image/png;base64,YXZhdGFy',
      bytes: 6,
      contentType: 'image/png',
    });
    const { images } = await runDrawTurn({
      // A quiet call in a turn that answers someone is shown to
      // the persona in one step, and they stay silent there.
      answers: [toolAnswer('', [call('draw.create', { people: [], self: true, text: 'me waving' })]), '<skip/>'],
      client: fakeClient(),
      imageFetcher,
      dataDir: drawDataDir(true),
    });

    assert.deepEqual(avatarAsks, [], 'the avatar is not asked for');
    assert.equal(imageFetcher.calls.length, 0, 'nothing is fetched');
    const [sent] = images.generateCalls;
    assert.equal(sent.reference, `data:image/png;base64,${LOOK_BYTES.toString('base64')}`);
    assert.ok(sent.prompt.includes('Bot wears a green scarf.'), 'a self picture carries the appearance');
  });

  // With no
  // `appearance.png` a picture of the persona is drawn with no reference, and the avatar does not stand in for it.
  test('runTurn: a self <draw> with no appearance.png is drawn without a reference', async () => {
    world().member('g1', {
      id: 'self-id',
      name: 'Bot',
      avatar: { hash: null, url: null, largeUrl: 'https://cdn.example.com/avatar.png' },
    });
    const { images, channel, imageFetcher } = await runDrawTurn({
      answers: [toolAnswer('', [call('draw.create', { people: [], self: true, text: 'me' })]), '<skip/>'],
      hot: drawHot({}, { reference: 'avatar' }),
      client: fakeClient(),
      imageFetcher: fakeImageFetcher({ dataUrl: 'data:image/png;base64,YXZhdGFy', bytes: 6, contentType: 'image/png' }),
      dataDir: drawDataDir(false),
    });

    assert.equal(imageFetcher.calls.length, 0, 'the avatar is not fetched');
    const [sent] = images.generateCalls;
    assert.equal(sent.reference, null);
    assert.equal(channel.sent.length, 1);
  });
});
