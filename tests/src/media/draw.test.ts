// Tests for src/media/draw.ts: the prompt builder and the direct generation over a bare image client. The scene goes in
// verbatim, `appearance.png` of the data folder is the reference of a picture of the persona, and a failure is left as
// the image client threw it. Fake clock and prompts; no network.
import { after, before, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ImageGenError, UnsupportedImageModelError, familyOf } from '../../../src/llm/images.ts';
import { drawPicture, drawPromptOf } from '../../../src/media/draw.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { createTurnRunner as createRealTurnRunner } from '../../../src/behavior/turn.ts';
import { fill, formatNow } from '../../../src/format.ts';
import { labels } from '../../fixtures/labels.ts';
import { call, completionOf, toolAnswer } from '../../fixtures/tool-answers.ts';
import '../../../src/tools/operations/index.ts';
import { onWorld, useIface, useSelf, world } from '../../fixtures/turn-world.ts';
import type { Channel } from '../../fixtures/turn-world.ts';
import { directorAnswer } from '../../fixtures/scene-answer.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import type { SceneMemory } from '../../fixtures/diary-scene.ts';
import { createAdmin } from '../../../src/admin.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { publishTo } from '../../fixtures/diary-mirror.ts';
import { present, wrongly } from '../../fixtures/loose-types.ts';
import { OWNER_PERSON, ownedBy } from '../../fixtures/owner-accounts.ts';

// Tuesday, October 6, 2026, 22:30 in Europe/Athens.
const NOW = Date.UTC(2026, 9, 6, 19, 30, 0);
const TZ = 'Europe/Athens';
const WHEN = 'At Tuesday, October 6, 2026, 22:30 (Europe/Athens).';
const AVATAR = 'data:image/png;base64,QVZBVEFS';

// A picture of the persona is drawn with `appearance.png` of the data folder as its reference, and the avatar is no
// reference. The bytes are the test's own.
const LOOK_BYTES = Buffer.from('LOOK-PNG-BYTES');
const LOOK = `data:image/png;base64,${LOOK_BYTES.toString('base64')}`;
const FOLDERS: Array<string> = [];

after(() => {
  for (const folder of FOLDERS.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A fresh data folder under TMPDIR, holding `appearance.png` when `withLook`. */
function dataFolder(withLook: boolean): string {
  const folder = mkdtempSync(path.join(tmpdir(), 'appearance-'));
  FOLDERS.push(folder);
  if (withLook) writeFileSync(path.join(folder, 'appearance.png'), LOOK_BYTES);
  return folder;
}

/** The avatar download: always the same small data: URL. */
function imageFetcher() {
  return { fetchAsDataUrl: async () => ({ dataUrl: AVATAR, bytes: 6, contentType: 'image/png' }) };
}

/** What the draw call hands the image client: the prompt, the reference picture and the member it is charged to. */
type ImageCall = { prompt: string; reference: unknown; accountId?: string };

const SCENE = 'a lighthouse at dusk; keep every word,  even the odd   spacing';

function plainHot(extra = {}) {
  return {
    config: {
      bot: { timezone: TZ },
      image: { referenceMaxBytes: 4_000_000 },
      ...extra,
    },
    prompts: {
      draw: 'DRAW by {{name}}.\n\n{{appearance}}\n\n{{when}}\n\nScene: {{request}}',
      appearance: '{{name}} has a green scarf.',
      labels: { draw: { when: 'At {when}.' } },
    },
  };
}

/** A fake image client: records each call, answers `answers` in turn (an Error is thrown). */
function fakeImages(answers: Array<Untyped> = []) {
  const calls: Array<ImageCall> = [];
  return {
    calls,
    async generate(args: ImageCall) {
      calls.push(structuredClone(args));
      const next = answers.length > 0 ? answers.shift() : null;
      if (next instanceof Error) throw next;
      return next ?? { buffer: Buffer.from('png'), mediaType: 'image/png', seconds: 2, cost: 0.03, model: 'm/img' };
    },
  };
}

// The drawing reference is `appearance.png` of the data folder (`dataDir`), and drawing fetches no avatar.
const deps = (images: Untyped, hotValue = plainHot(), dataDir = dataFolder(true)) => ({
  images,
  hot: hotValue,
  dataDir,
  now: () => NOW,
});

test("drawPicture: the persona's scene goes into the draw prompt verbatim, with the appearance and the time, and appearance.png as reference", async () => {
  const images = fakeImages();
  const { picture } = await drawPicture({
    ...deps(images),
    input: { scene: SCENE, selfName: 'Bot', self: true, withTime: true, accountId: 'u1' },
  });
  assert.deepEqual(images.calls, [
    {
      prompt: `DRAW by Bot.\n\nBot has a green scarf.\n\n${WHEN}\n\nScene: ${SCENE}`,
      reference: LOOK,
      accountId: 'u1',
    },
  ]);
  assert.equal(picture.model, 'm/img');
});

// The drawing scene is kept whole, with no length limit.
test("drawPicture: no time for the owner's command, no appearance and no reference for a picture the persona is not in, a long scene kept whole", async () => {
  const images = fakeImages();
  const hotValue = plainHot();
  const longScene = `boats in the harbour, ${'a very long scene, '.repeat(120)}`.trim();
  await drawPicture({
    ...deps(images, hotValue),
    input: { scene: longScene, selfName: 'Bot', self: false, withTime: false },
  });
  const [sent] = images.calls;
  assert.equal(sent.reference, null);
  assert.ok(!sent.prompt.includes('green scarf'));
  assert.ok(!sent.prompt.includes('At '));
  assert.ok(sent.prompt.endsWith(`Scene: ${longScene}`), sent.prompt.slice(-80));
  assert.equal(
    drawPromptOf({ hot: hotValue, selfName: 'Bot', scene: 'x', self: false, withTime: false }),
    'DRAW by Bot.\n\nScene: x'
  );
});

test('drawPicture: a picture of the persona has no reference when the data folder holds no appearance.png', async () => {
  // Bug: the avatar stands in for the missing file, or the draw fails instead of drawing without a reference.
  const images = fakeImages();
  // A retired `image.reference` setting and an avatar at hand: neither stands in for the file.
  const legacy = plainHot({ image: { reference: 'avatar' } });
  const avatarAtHand = {
    avatarUrl: () => Promise.resolve('https://cdn.example/avatar.png'),
    imageFetcher: imageFetcher(),
  };
  await drawPicture({
    ...deps(images, legacy, dataFolder(false)),
    ...avatarAtHand,
    input: { scene: 'a', selfName: 'Bot', self: true },
  });
  const [sent] = images.calls;
  assert.equal(sent?.reference, null);
});

test('drawPicture: a picture without self has no reference even when appearance.png exists', async () => {
  // Bug: the file goes with every picture, and a lighthouse comes out with the persona's face.
  const images = fakeImages();
  await drawPicture({ ...deps(images, plainHot(), dataFolder(true)), input: { scene: 'a', selfName: 'Bot' } });
  await drawPicture({
    ...deps(images, plainHot(), dataFolder(true)),
    input: { scene: 'b', selfName: 'Bot', self: false },
  });
  assert.deepEqual(
    images.calls.map((sent) => sent.reference),
    [null, null]
  );
});

test("drawPicture: a failure is the image client's own error, unwrapped", async () => {
  const errors = [
    new ImageGenError('moderation', 'refused', { statusCode: 400 }),
    new UnsupportedImageModelError('x/y'),
    new RangeError('odd'),
  ];
  for (const error of errors) {
    await assert.rejects(
      () => drawPicture({ ...deps(fakeImages([error])), input: { scene: 'a', selfName: 'Bot' } }),
      (err: unknown) => err === error
    );
  }
});

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;
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

function turnFakeImages({
  used = 0,
  cap = 10,
  fail = null,
}: { used?: number; cap?: number; fail?: Error | null } = {}) {
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

// The diary's switches are code, and its kinds, sets, gist length and message count are constants of
// src/behavior/diary.ts, so the config holds only the keys that are settings.
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
  images = turnFakeImages(),
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

// The diary wake keeps the id of its turn on the entry as `extra.turnId`, written through the one writer. The
// wake runs the real turn runner over tests/fixtures/diary-scene.ts with a real journal. Invented ids and
// synthetic text only.

/** The scenes a test opened, closed when the file is done. */
const OPEN: Array<SceneMemory> = [];

describe('diary turn', () => {
  // The diary channel is held by a fake interface named `fake`; the persona is `self-id`.
  // The turn world's interface and self id are module state of the fixture: set for these cases only.
  before(() => {
    useIface('fake');
    useSelf('self-id');
  });
  after(() => {
    useIface('discord');
    useSelf('self-id');
  });
  after(async () => {
    for (const scene of OPEN.splice(0)) await scene.memory.close();
  });

  test('diary turn: the drawing prompt carries the local time', async () => {
    const llm = fakeLlm(null, drawAnswer(''));
    const images = turnFakeImages();
    await runner({ llm, images }).runTurn({
      channel: diaryChannel(),
      mode: 'diary',
      diary: {},
    });
    assert.equal(images.prompts.length, 1);
    const firstPrompt = images.prompts[0];
    assert.ok(firstPrompt.includes(fill(labels.draw.when, { when: formatNow(NOW, TZ, labels.locale) })), firstPrompt);
  });

  test("diary turn: an ordinary turn's draw.create carries the local time too", async () => {
    const hot = fakeHot();
    loose(hot.prompts)['turn/reply'] = 'REPLY for {{author}}';
    const llm = fakeLlm(null, toolAnswer('', [call('draw.create', { people: [], text: 'a pier' })]));
    const images = turnFakeImages();
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
    const firstPrompt = images.prompts[0];
    assert.ok(firstPrompt.includes(fill(labels.draw.when, { when: formatNow(NOW, TZ, labels.locale) })));
  });
});

// onWorld takes a creator of any options; the real runner takes its own input type, so the options are cast once, here.
const parityCreateTurnRunner = onWorld((options) =>
  createRealTurnRunner(options as Parameters<typeof createRealTurnRunner>[0])
);
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'appearance-'));

const LABELS = { ...labels, draw: { ...labels.draw, when: 'At {when}.' } };

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
    // The diary's switches are code and its kinds and sets are constants of src/behavior/diary.ts (`photoset` is a set
    // of 4 to 6 pictures), so the config holds only the keys that are settings.
    config: {
      bot: { timezone: TZ, owners: ['42'] },
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

/** A member's message as discord.js hands it over. */
function rawMessage({
  id,
  authorId,
  authorName,
  content,
  ts,
}: {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  ts: number;
}) {
  return {
    id,
    placeId: 'c1',
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
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

/** The image client boundary: every generate() call's arguments, as given. */
function recordingImages() {
  const calls: Array<Untyped> = [];
  return {
    calls,
    familyOf,
    quota: () => ({ used: 0, cap: 50, userUsed: 0, userCap: 5, spent: false, userSpent: false }),
    generate: async (args: Untyped) => {
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
    complete: async (messages: Untyped, opts: Untyped) => {
      const scene = directorAnswer(messages, opts);
      if (scene) return scene;
      const answer = Array.isArray(post) ? post[Math.min(composed, post.length - 1)] : post;
      composed += 1;
      return completionOf(answer);
    },
  };
}

function parityRunner({ answer, images }: { answer: Untyped; images: Untyped }) {
  client();
  return parityCreateTurnRunner({
    hot: hot(),
    dataDir: DATA_DIR,
    store: store(),
    llm: llm(answer),
    calibrator: { ratio: 1, apply: (n: Untyped) => n, observe: () => {} },
    images,
    imageFetcher: imageFetcher(),
    lookup: null,
    rng: () => 0.5,
    now: () => NOW,
  });
}

describe('draw parity', () => {
  writeFileSync(path.join(DATA_DIR, 'appearance.png'), LOOK_BYTES);
  after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  test("draw parity: a reply turn's draw.create call asked by a member", async () => {
    const images = recordingImages();
    const raw = rawMessage({
      id: 'm1',
      authorId: 'u1',
      authorName: 'Eléna',
      content: 'draw a lighthouse',
      ts: NOW - 1000,
    });
    const trigger = {
      id: raw.id,
      placeId: raw.placeId,
      authorId: 'u1',
      authorName: 'Eléna',
      self: false,
      bot: false,
      content: raw.cleanContent,
      ts: raw.createdTimestamp,
      replyToId: null,
      attachments: [],
      stickers: [],
    };
    const turns = parityRunner({
      // A quiet call in a turn that answers someone is shown to the persona in one step, and they stay silent there.
      answer: [
        toolAnswer('<msg>one sec</msg>', [
          call('draw.create', { people: [], reply: '#1', text: 'a lighthouse at dusk, waves below' }),
        ]),
        '<skip/>',
      ],
      images,
    });
    const { result } = await withCapturedLogs(() =>
      turns.runTurn({ channel: channel('c1', 'general', [raw]), mode: 'reply', trigger, triggerKind: 'mention' })
    );
    assert.equal(loose(result).outcome, 'spoke');
    assert.deepEqual(images.calls, [
      {
        prompt: `A drawing by Bot.\n\n${WHEN}\n\nScene: a lighthouse at dusk, waves below`,
        reference: null,
        accountId: 'u1',
      },
    ]);
  });

  test("draw parity: a diary post's single self picture", async () => {
    const images = recordingImages();
    const turns = parityRunner({
      answer: toolAnswer('<msg>early start</msg>', [
        call('draw.create', { people: [], text: 'me on a pier at dawn, fog', self: true }),
      ]),
      images,
    });
    const { result } = await withCapturedLogs(() =>
      turns.runTurn({
        channel: channel('d1', 'journal'),
        mode: 'diary',
        diary: { kind: null, forced: false },
      })
    );
    assert.equal(loose(result).outcome, 'spoke');
    assert.deepEqual(images.calls, [
      {
        prompt: `A drawing by Bot.\n\nBot has silver hair and a green scarf.\n\n${WHEN}\n\nScene: me on a pier at dawn, fog`,
        reference: LOOK,
        accountId: null,
      },
    ]);
  });

  test("draw parity: a diary set's pictures, the persona in the first one only", async () => {
    // The code draws the diary's kind.
    const images = recordingImages();
    const answer = toolAnswer('<msg>a walk</msg>', [
      call('draw.create', { people: [], text: 'me at the harbour gate', self: true }),
      call('draw.create', { people: [], text: 'boats in the harbour' }),
      call('draw.create', { people: [], text: 'a café terrace' }),
      call('draw.create', { people: [], text: 'nets on the quay' }),
    ]);
    const turns = parityRunner({ answer, images });
    const { result } = await withCapturedLogs(() =>
      turns.runTurn({
        channel: channel('d1', 'journal'),
        mode: 'diary',
        diary: { kind: 'photoset', forced: false },
      })
    );
    assert.equal(loose(result).outcome, 'spoke');
    assert.deepEqual(images.calls, [
      {
        prompt: `A drawing by Bot.\n\nBot has silver hair and a green scarf.\n\n${WHEN}\n\nScene: me at the harbour gate`,
        reference: LOOK,
        accountId: null,
      },
      { prompt: `A drawing by Bot.\n\n${WHEN}\n\nScene: boats in the harbour`, reference: null, accountId: null },
      { prompt: `A drawing by Bot.\n\n${WHEN}\n\nScene: a café terrace`, reference: null, accountId: null },
      { prompt: `A drawing by Bot.\n\n${WHEN}\n\nScene: nets on the quay`, reference: null, accountId: null },
    ]);
  });

  // admin.run takes the operation's name.
  test('draw parity: /nep draw with self', async () => {
    const images = recordingImages();
    const admin = createAdmin({
      reads: world().reads,
      port: world().port,
      hot: hot(),
      store: store(),
      client: client(),
      selfId: () => 'self-id',
      getSelfName: () => 'Bot',
      spontaneous: {},
      calibrator: { ratio: 1 },
      isServedRoot: (id: unknown) => id === 'g1',
      images,
      imageFetcher: imageFetcher(),
      dataDir: DATA_DIR,
      now: () => NOW,
    });
    const { result } = await withCapturedLogs(() =>
      admin.run('draw.create', { text: 'me reading by the window', self: true }, { placeId: 'g1', accountId: '42' })
    );
    assert.equal(result.files.length, 1);
    // The owner's command carries no local time: its `{{when}}` is blank.
    assert.deepEqual(images.calls, [
      {
        prompt: 'A drawing by Bot.\n\nBot has silver hair and a green scarf.\n\nScene: me reading by the window',
        reference: LOOK,
        accountId: null,
      },
    ]);
  });
});

const drawCreateTurnRunner = onWorld(wrongly(createRealTurnRunner));

const DRAW_LABELS = { ...labels, draw: { ...labels.draw, when: 'At {when}.' } };

function drawHot() {
  return {
    // The diary's switches are code and its kinds and sets are constants of src/behavior/diary.ts (`photoset` is a set
    // of 4 to 6 pictures), so only the settings stay.
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

function drawRecordingImages() {
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

/** An LLM answering the director with a scene and every other request with `post`. */
function drawLlm(post: Untyped) {
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

function drawRunner({ answer, images, hotValue = drawHot(), dataDir = null }: Record<string, Untyped>) {
  client();
  return drawCreateTurnRunner({
    hot: hotValue,
    dataDir,
    store: store(),
    llm: drawLlm(answer),
    calibrator: { ratio: 1, apply: (n: Record<string, Untyped>) => n, observe: () => {} },
    images,
    imageFetcher: imageFetcher(),
    lookup: null,
    rng: () => 0.5,
    now: () => NOW,
  });
}

describe('media draw', () => {
  after(() => {
    for (const folder of FOLDERS.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  // The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
  let disown = (): void => {};
  before(() => {
    disown = ownedBy(['42']);
  });
  after(() => disown());

  // No daily image cap ends the set, so the set posts every picture it drew. The reference of a picture the persona is
  // in is `appearance.png` of the data folder, not the avatar.
  test('diary set: appearance.png goes with the picture the persona is in, none with the others; the set is posted', async () => {
    // The code draws the diary's kind.
    const images = drawRecordingImages();
    const hotValue = drawHot();
    const answer = [
      toolAnswer('<msg>a walk</msg>', [
        call('draw.create', { people: [], text: 'me at the harbour gate', self: true }),
        call('draw.create', { people: [], text: 'boats in the harbour' }),
        call('draw.create', { people: [], text: 'a café terrace' }),
      ]),
    ];
    const target = channel('d1', 'journal');
    const { result }: Record<string, Untyped> = await withCapturedLogs(() =>
      drawRunner({ answer, images, hotValue, dataDir: dataFolder(true) }).runTurn({
        channel: target,
        mode: 'diary',
        diary: { kind: 'photoset', forced: false },
      })
    );
    assert.equal(result.outcome, 'spoke');
    assert.deepEqual(
      images.calls.map((call) => call.reference),
      [LOOK, null, null]
    );
    // Stage 3 design, section 3 item 4: the turn records the entry and sends nothing; the mirror's publication of the
    // entry posts what came out.
    assert.equal(target.sent.length, 0, 'the turn itself sends nothing');
    await publishTo(result, world().port, { now: NOW });
    assert.equal(present(present(target.sent.at(-1)).files).length, 3, 'the three pictures are posted');
  });
});
