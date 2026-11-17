// Drawing, the core's built-in ability (src/media/draw.ts): the prompt builder, the direct
// generation (her scene verbatim, the appearance.png reference, the failure left as the image client threw
// it) and the call sites: the turn's draw.create call, a diary set and `/nep draw`. The image
// client stays the injected boundary: its calls are asserted byte for byte in
// tests/draw-parity.test.js. Fake clock, prompts, labels, avatar and channel; no network.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner as createRealTurnRunner } from '../src/behavior/turn.ts';
import { createAdmin } from '../src/admin.ts';
import '../src/tools/operations/index.ts';
import { skillRegistry } from '../src/tools/registry.ts';
import { familyOf, ImageGenError, UnsupportedImageModelError } from '../src/llm/images.ts';
import { onWorld, world } from './fixtures/turn-world.ts';
import { labels as baseLabels } from './fixtures/labels.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { publishTo } from './fixtures/diary-mirror.ts';
import { call, completionOf, toolAnswer } from './fixtures/tool-answers.ts';
import { drawPicture, drawPromptOf } from '../src/media/draw.ts';
import type { Untyped } from '../src/tools/types.ts';
import { present, wrongly } from './fixtures/loose-types.ts';
import { planAnswerText } from './fixtures/plan-answer.ts';
import { OWNER_PERSON, ownedBy } from './fixtures/owner-accounts.ts';
import { chainsOf } from './fixtures/chains.ts';
import { objectMediaCache } from '../src/memory/store-media.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { noMediaNames } from './fixtures/media-namer.ts';

const createTurnRunner = onWorld(wrongly(createRealTurnRunner));

// Tuesday, October 6, 2026, 22:30 in Europe/Athens.
const NOW = Date.UTC(2026, 9, 6, 19, 30, 0);
const TZ = 'Europe/Athens';
const WHEN = 'At Tuesday, October 6, 2026, 22:30 (Europe/Athens).';
const AVATAR = 'data:image/png;base64,QVZBVEFS';

// The owner on 2026-11-17: a picture of herself is drawn with `appearance.png` of the data folder as its reference, and
// the avatar is no reference. The bytes are the test's own.
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

const LABELS = { ...baseLabels, draw: { ...baseLabels.draw, when: 'At {when}.' } };

const PROMPTS = {
  'system-prompt': 'SYSTEM for {{name}}',
  'character-card': 'CARD_TEXT',
  format: 'FORMAT_TEXT',
  reply: 'Someone called you: {{author}}.',
  diary: 'DIARY_TASK for {{name}}',
  'diary-planner': 'PLAN_SYSTEM for {{name}}',
  'diary-seeds': '# place\na pier\n# light\nfog',
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
      diary: { placeId: 'd1', world: false, planMaxOutputTokens: 250, planTimeoutMs: 15000 },
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

/** The bot user and the served guild; the interface gives her large avatar as an address. */
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

/** An LLM answering the diary plan with `plan` and every other request with `post`. */
function llm(post: Untyped, plan = null) {
  let composed = 0;
  return {
    complete: async (_messages: Record<string, Untyped>, opts: Record<string, Untyped>) => {
      // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
      if (opts?.purpose === 'diary-planner') return { text: planAnswerText(plan, opts), usage: {}, estimated: 5 };
      const answer = Array.isArray(post) ? post[Math.min(composed, post.length - 1)] : post;
      composed += 1;
      return completionOf(answer);
    },
  };
}

function runner({ answer, plan = null, images, hotValue = hot(), dataDir = null }: Record<string, Untyped>) {
  client();
  return createTurnRunner({
    hot: hotValue,
    dataDir,
    store: store(),
    llm: llm(answer, plan),
    calibrator: { ratio: 1, apply: (n: Record<string, Untyped>) => n, observe: () => {} },
    images,
    imageFetcher: imageFetcher(),
    lookup: null,
    rng: () => 0.5,
    now: () => NOW,
  });
}

function memberTrigger() {
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
  return { raw, trigger };
}

// PR 7d: the daily image cap that ended the set is gone, so the set posts every picture it drew.
// The owner on 2026-11-17: the reference of the picture she is in is `appearance.png` of the data folder, not the avatar.
test('diary set: appearance.png goes with the picture she is in, none with the others; the set is posted', async () => {
  // The lead: the code draws the diary's kind (owner, 2026-11-06).
  const images = recordingImages();
  const hotValue = hot();
  const plan = { kind: 'photoset', brief: 'a harbour walk', search: '', picture: true };
  const answer = [
    toolAnswer('<msg>a walk</msg>', [
      call('draw.create', { text: 'me at the harbour gate', self: true }),
      call('draw.create', { text: 'boats in the harbour' }),
      call('draw.create', { text: 'a café terrace' }),
    ]),
  ];
  const target = channel('d1', 'journal');
  const { result }: Record<string, Untyped> = await withCapturedLogs(() =>
    runner({ answer, plan, images, hotValue, dataDir: dataFolder(true) }).runTurn({
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
// PR 7b: admin.run takes the operation's name, the command key map is gone; the expectations are as they were.
test('/nep draw: one picture for the owner', async () => {
  const images = recordingImages();
  const hotValue = hot();
  const admin = (value: Record<string, Untyped>) =>
    createAdmin({
      mediaNameOf: noMediaNames,
      reads: world().reads,
      port: world().port,
      hot: value,
      store: store(),
      client: client(),
      selfId: () => 'self-id',
      getSelfName: () => 'Bot',
      spontaneous: {},
      calibrator: { ratio: 1 },
      isServedRoot: (id: unknown) => id === 'g1',
      images,
      imageFetcher: imageFetcher(),
      now: () => NOW,
    });
  const ctx = { placeId: 'g1', accountId: '42' };
  const { result } = await withCapturedLogs(() =>
    admin(hotValue).run('draw.create', { text: 'me reading by the window', self: true }, ctx)
  );
  assert.equal(result.files.length, 1);
  assert.equal(
    images.calls[0].prompt,
    'A drawing by Bot.\n\nBot has silver hair and a green scarf.\n\nScene: me reading by the window'
  );
});

test("draw.create from a member's mention: the picture is charged to the member", async () => {
  const hotValue: Record<string, Untyped> = hot();
  hotValue.config.bot.access = { 'draw.create': { everyone: false, roles: [], users: ['self-id'] } };
  hotValue.config.tools = { safeMode: false, resultMaxChars: 2000, callTimeoutMs: 120000 };
  const images = recordingImages();
  const hotCase = structuredClone(hotValue);
  hotCase.prompts = { ...PROMPTS };
  const { raw, trigger } = memberTrigger();
  const target = channel('c1', 'general', [wrongly(raw)]);
  client();
  const turns = createTurnRunner({
    hot: hotCase,
    store: store(),
    llm: llm(toolAnswer('', [call('draw.create', { text: 'a lighthouse at dusk' })])),
    calibrator: { ratio: 1, apply: (n: Record<string, Untyped>) => n, observe: () => {} },
    images,
    imageFetcher: imageFetcher(),
    lookup: null,
    rng: () => 0.5,
    now: () => NOW,
    skills: skillRegistry(),
    runOp: createAdmin({
      mediaNameOf: noMediaNames,
      reads: world().reads,
      port: world().port,
      hot: hotCase,
      store: store(),
      client: client(),
      selfId: () => 'self-id',
      getSelfName: () => 'Bot',
      isServedRoot: (id: unknown) => id === 'g1',
    }).runSkillOp,
  });
  const { logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel: target, mode: 'reply', trigger, triggerKind: 'mention' })
  );
  const called = logs.find((l) => l.msg === 'skills: called' && l.skill === 'draw.create');
  assert.ok(called, JSON.stringify(logs.filter((l) => /skill/.test(String(l.msg)))));
  assert.equal(called.code ?? 'ok', 'ok');
  assert.equal(images.calls[0].accountId, 'u1');
  assert.ok(
    target.sent.some((payload) => payload.files?.length === 1),
    'the picture was posted'
  );
});

test("draw.create operation quotes the message it replies to, in that message's channel (a link) and refuses a channel that disagrees", async () => {
  const { createFakeAdapter } = await import('../src/interface/fake.ts');
  const hotValue = hot();
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
  port.seed('c1', { authorId: 'u1', messageId: 'm9', text: 'a lighthouse?' });
  const admin = createAdmin({
    mediaNameOf: noMediaNames,
    reads: world().adopt(port, { sendsInHistory: true }),
    hot: hotValue,
    store: store(),
    client: client(),
    selfId: () => 'self-id',
    getSelfName: () => 'Bot',
    spontaneous: {},
    calibrator: { ratio: 1 },
    isServedRoot: (id: unknown) => id === 'g1',
    images: recordingImages(),
    imageFetcher: imageFetcher(),
    now: () => NOW,
    port,
  });
  const ctx = { placeId: 'c1', accountId: '42', roleIds: [], actor: 'owner' };
  const quoted = (
    await withCapturedLogs(() => admin.runSkillOp('draw.create', { text: 'a lighthouse', replyTo: 'm9' }, ctx))
  ).result;
  assert.equal(quoted.status ?? 'ok', 'ok', JSON.stringify(quoted));
  const sent: Untyped = port.calls.find((call) => call.op === 'send');
  assert.deepEqual(
    [present(sent).args[0].chatId, present(sent).args[1].replyTo.chatId, present(sent).args[1].replyTo.messageId],
    ['c1', 'c1', 'm9']
  );
  const refused = await admin.runSkillOp(
    'draw.create',
    { text: 'a lighthouse', replyTo: 'https://discord.com/channels/g1/c1/m9', placeId: 'c2' },
    ctx
  );
  assert.equal(refused.status, 'invalid');
  assert.equal(refused.code, 'unknown-message');
});

// The builder and the direct generation, over a bare image client.

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

// The owner on 2026-11-17: the drawing reference is `appearance.png` of the data folder (`dataDir`); the avatar fetch
// for drawing is gone.
const deps = (images: Untyped, hotValue = plainHot(), dataDir = dataFolder(true)) => ({
  images,
  hot: hotValue,
  dataDir,
  now: () => NOW,
});

test('drawPicture: her scene goes into the draw prompt verbatim, with the appearance and the time, and appearance.png as reference', async () => {
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

// The owner on 2026-11-16: the drawing scene is kept whole; the limit of 1600 is gone.
test("drawPicture: no time for the owner's command, no appearance and no reference for a picture she is not in, a long scene kept whole", async () => {
  const images = fakeImages();
  const hotValue = plainHot();
  const longScene = `boats in the harbour, ${'a very long scene, '.repeat(120)}`.trim();
  await drawPicture({
    ...deps(images, hotValue),
    input: { scene: longScene, selfName: 'Bot', self: false, withTime: false },
  });
  assert.equal(images.calls[0].reference, null);
  assert.ok(!images.calls[0].prompt.includes('green scarf'));
  assert.ok(!images.calls[0].prompt.includes('At '));
  assert.ok(images.calls[0].prompt.endsWith(`Scene: ${longScene}`), images.calls[0].prompt.slice(-80));
  assert.equal(
    drawPromptOf({ hot: hotValue, selfName: 'Bot', scene: 'x', self: false, withTime: false }),
    'DRAW by Bot.\n\nScene: x'
  );
});

// The owner on 2026-11-17: the setting `image.reference` and the fetch of the avatar for drawing are removed, so the
// test of the avatar fetched once into a shared holder and of `image.reference: 'none'` is deleted.

test('drawPicture: a picture of herself has no reference when the data folder holds no appearance.png', async () => {
  // Bug: the avatar stands in for the missing file, or the draw fails instead of drawing without a reference.
  const images = fakeImages();
  // The removed setting and an avatar at hand: neither stands in for the file.
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
  // Bug: the file goes with every picture, and a lighthouse comes out with her face.
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

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['42']);

// The owner, 2026-11-16 and 17: a staged diary picture is looked at from its own bytes, and what her eyes saw comes
// back in the result of its draw.create call.
test('diary: a staged picture is looked at once from its bytes and the description is in the result she reads next', async () => {
  // Bug: a staged picture answers `staged` alone, and her diary entry speaks of a picture she never saw.
  const asked: Array<{ placeId: string; buffer?: Buffer; mediaType?: string }> = [];
  const describePicture = (picture: { placeId: string; buffer?: Buffer; mediaType?: string }) => {
    asked.push(picture);
    return Promise.resolve('a pier in fog, the rail bent');
  };
  const { tools } = LABELS;
  const seenLabels = { ...LABELS, tools: { ...tools, result: { ...tools.result, seen: 'SEEN {description}' } } };
  const hotValue = { ...hot(), prompts: { ...PROMPTS, labels: seenLabels } };
  const base = llm(
    [toolAnswer('<think>x</think>', [call('draw.create', { text: 'the pier in fog' })]), '<msg>the pier</msg>'],
    wrongly({ kind: 'picture', brief: 'the pier', search: '', picture: true })
  );
  const requests: Array<Array<Record<string, Untyped>>> = [];
  const recording = {
    complete: (messages: Array<Record<string, Untyped>>, opts: Record<string, Untyped>) => {
      if (opts?.purpose !== 'diary-planner') requests.push(messages);
      return base.complete(wrongly(messages), opts);
    },
  };
  client();
  const turns = createTurnRunner({
    hot: hotValue,
    store: store(),
    llm: recording,
    calibrator: { ratio: 1, apply: (n: Record<string, Untyped>) => n, observe: () => {} },
    images: recordingImages(),
    imageFetcher: imageFetcher(),
    lookup: null,
    rng: () => 0.5,
    now: () => NOW,
    describePicture,
  });
  await withCapturedLogs(() =>
    turns.runTurn({ channel: channel('d1', 'journal'), mode: 'diary', diary: { kind: 'picture', forced: false } })
  );
  assert.equal(requests.length, 2, 'she reads the staged result in one more step');
  assert.equal(asked.length, 1, 'one look per picture');
  const [look] = asked;
  assert.equal(present(look).buffer?.toString(), 'png');
  assert.equal(present(look).mediaType, 'image/png');
  const second = JSON.stringify(present(requests[1]));
  assert.ok(second.includes('SEEN a pier in fog, the rail bent'), second.slice(-600));
});
