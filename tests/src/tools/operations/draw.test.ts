import { test, after, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Untyped } from '../../../../src/tools/types.ts';
import { buildDrawPrompt } from '../../../../src/behavior/prompt.ts';
import { familyOf, ImageGenError } from '../../../../src/llm/images.ts';
import { makeAdmin, makeHot, makeRoot } from '../../../fixtures/admin-rig.ts';
import { world, onWorld } from '../../../fixtures/turn-world.ts';
import { chainsOf } from '../../../fixtures/chains.ts';
import { tmpdir } from 'node:os';
import { createAdmin } from '../../../../src/admin.ts';
import { labels as baseLabels } from '../../../fixtures/labels.ts';
import { withCapturedLogs } from '../../../fixtures/capture-logs.ts';
import { objectMediaCache } from '../../../../src/memory/store-media.ts';
import { createTurnRunner as createRealTurnRunner } from '../../../../src/behavior/turn.ts';
import '../../../../src/tools/operations/index.ts';
import { skillRegistry } from '../../../../src/tools/registry.ts';
import { call, completionOf, toolAnswer } from '../../../fixtures/tool-answers.ts';
import { present, wrongly } from '../../../fixtures/loose-types.ts';
import { directorAnswer } from '../../../fixtures/scene-answer.ts';
import { OWNER_PERSON, ownedBy } from '../../../fixtures/owner-accounts.ts';

// PR 7b: `admin.run` takes the operation's name (`status.show`, `config.set`, ...); every expectation is as it was.

// ---------------------------------------------------------------------------
// draw / the image lines of status and model.show (src/llm/images.ts)
// ---------------------------------------------------------------------------

/** A fake image client: records every generate() call, answers with `picture` or throws `error`. */
function fakeImages({ picture, error, quota }: { picture?: Untyped; error?: Error; quota?: Untyped } = {}) {
  const calls: Array<Untyped> = [];
  return {
    calls,
    familyOf,
    async generate(args: Untyped) {
      calls.push(args);
      if (error) throw error;
      return (
        picture ?? {
          buffer: Buffer.from('fake-png'),
          mediaType: 'image/png',
          cost: 0.042,
          usage: {},
          model: 'openai/image-model',
          seconds: 12.3,
        }
      );
    },
    quota: () => quota ?? { used: 3, cap: 50, userUsed: 0, userCap: 50, spent: false, userSpent: false },
  };
}

/** A fake imageFetcher: records every fetchAsDataUrl() call and answers `result`. */
function fakeImageFetcher(result: { dataUrl: string } | null = { dataUrl: 'data:image/png;base64,QUFB' }) {
  const calls: Array<Untyped> = [];
  return {
    calls,
    async fetchAsDataUrl(url: string, opts: Untyped) {
      calls.push({ url, opts });
      return result;
    },
  };
}

function hotForDraw(rootDir: string, { model = 'openai/image-model', ...image }: Record<string, unknown> = {}) {
  const hot = makeHot(rootDir);
  // Changed: the drawing model is its chain's (spec 2026-11-09-model-routes, slice 4).
  hot.config.models = {
    ...hot.config.models,
    routes: { ...hot.config.models?.routes, ...chainsOf({ drawing: model }) },
  };
  hot.config.image = { referenceMaxBytes: 4000000, ...image };
  hot.config.context = { vision: { fetchTimeoutMs: 7000 } };
  hot.prompts = {
    ...hot.prompts,
    draw: 'Picture by {{name}}.\n\n{{appearance}}\n\nRequest: {{request}}',
    appearance: '{{name}} has silver hair.',
  };
  return hot;
}

function drawClient() {
  const guild = { id: 'g1', name: 'The Server', members: { me: { displayName: 'Persona' } } };
  // The address of the persona's large avatar is the interface's to give (`memberInfo` of the persona).
  world().member('g1', {
    id: 'self-id',
    name: 'Persona',
    avatar: { hash: null, url: null, largeUrl: 'https://cdn.example/avatar.png' },
  });
  return {
    guilds: { cache: new Map([['g1', guild]]) },
    user: { id: 'self-id', username: 'persona-bot' },
  };
}

test('run: draw builds the prompt as a turn does and answers with the picture as a file', async () => {
  const rootDir = makeRoot();
  const hot = hotForDraw(rootDir);
  const images = fakeImages();
  const imageFetcher = fakeImageFetcher();
  const { admin } = makeAdmin(rootDir, { hot, images, imageFetcher, client: drawClient() });

  const result = await admin.run('draw.create', { text: 'a lighthouse at dusk', self: false }, { placeId: 'g1' });

  assert.equal(images.calls.length, 1);
  assert.deepEqual(images.calls[0], {
    prompt: buildDrawPrompt({
      prompts: hot.prompts,
      selfName: 'Persona',
      request: 'a lighthouse at dusk',
      self: false,
    }),
    reference: null,
    accountId: null,
  });
  const firstCall = images.calls[0];
  assert.ok(!firstCall.prompt.includes('silver hair'), 'no appearance without self');
  assert.equal(imageFetcher.calls.length, 0, 'no avatar fetched without self');
  assert.equal(result.files.length, 1);
  const firstFile = result.files[0];
  assert.equal(firstFile.name, 'image.png');
  assert.ok(Buffer.isBuffer(firstFile.attachment));
  const firstFile2 = result.files[0];
  assert.equal(firstFile2.attachment.toString(), 'fake-png');
  assert.ok(!result.text.includes('\n'), 'one line');
  assert.match(result.text, /openai\/image-model/);
  assert.match(result.text, /12\.3s/);
  assert.match(result.text, /0\.042/);
});

// The drawing scene is kept whole; the limit of 1600 is gone.
test('run: draw builds the prompt from the whole request', async () => {
  const rootDir = makeRoot();
  const hot = hotForDraw(rootDir);
  const images = fakeImages();
  const { admin } = makeAdmin(rootDir, { hot, images, client: drawClient() });
  const text = 'άλφαβήτα '.repeat(300).trim();

  await admin.run('draw.create', { text, self: false }, { placeId: 'g1' });

  const firstCall = images.calls[0];
  assert.equal(
    firstCall.prompt,
    buildDrawPrompt({ prompts: hot.prompts, selfName: 'Persona', request: text, self: false })
  );
});

// A picture of the persona is drawn with `appearance.png` of the data folder as its reference; the
// avatar is no longer fetched for drawing. The bytes are the test's own.
test('run: draw with self adds the appearance and sends appearance.png of the data folder as the reference', async () => {
  const rootDir = makeRoot();
  const dataDir = path.join(rootDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'appearance.png'), Buffer.from('LOOK-PNG-BYTES'));
  const hot = hotForDraw(rootDir);
  const images = fakeImages();
  const imageFetcher = fakeImageFetcher();
  const client = drawClient();
  const { admin } = makeAdmin(rootDir, { hot, images, imageFetcher, client });

  await admin.run('draw.create', { text: 'at the beach', self: true }, { placeId: 'g1' });

  assert.equal(imageFetcher.calls.length, 0, 'no avatar fetched for drawing');
  const [sent] = images.calls;
  assert.equal(sent.reference, `data:image/png;base64,${Buffer.from('LOOK-PNG-BYTES').toString('base64')}`);
  const firstCall = images.calls[0];
  assert.equal(firstCall.accountId, null);
  assert.equal(
    firstCall.prompt,
    buildDrawPrompt({ prompts: hot.prompts, selfName: 'Persona', request: 'at the beach', self: true })
  );
  const firstCall2 = images.calls[0];
  assert.ok(firstCall2.prompt.includes('Persona has silver hair.'));
});

// The avatar is not
// fetched for drawing, so a picture of the persona with no `appearance.png` goes without a reference and no avatar note.
test('run: draw with self and no appearance.png generates with no reference', async () => {
  const rootDir = makeRoot();
  const hot = hotForDraw(rootDir);
  const images = fakeImages();
  const imageFetcher = fakeImageFetcher();
  const { admin } = makeAdmin(rootDir, { hot, images, imageFetcher, client: drawClient() });

  await admin.run('draw.create', { text: 'at the beach', self: true }, { placeId: 'g1' });

  assert.equal(images.calls.length, 1);
  const [sent] = images.calls;
  assert.equal(sent.reference, null);
  assert.equal(imageFetcher.calls.length, 0, 'no avatar fetched for drawing');
});

test('run: draw with an unsupported image model is a not-configured refusal with the reason, and never generates', async () => {
  const rootDir = makeRoot();
  const hot = hotForDraw(rootDir, { model: 'someone/else-model' });
  const images = fakeImages();
  const { admin } = makeAdmin(rootDir, { hot, images, client: drawClient() });

  await assert.rejects(
    () => admin.run('draw.create', { text: 'a cat' }, { placeId: 'g1' }),
    (err: Error & { code?: string }) =>
      err.code === 'not-configured' && /someone\/else-model/.test(err.message) && /unsupported/.test(err.message)
  );
  assert.equal(images.calls.length, 0);
});

test('run: draw reports a failed generation with its reason and HTTP status', async () => {
  const rootDir = makeRoot();
  const hot = hotForDraw(rootDir);
  const error = new ImageGenError('moderation', 'image refused by moderation (HTTP 400)', {
    statusCode: 400,
    body: 'provider text',
  });
  const { admin } = makeAdmin(rootDir, { hot, images: fakeImages({ error }), client: drawClient() });

  await assert.rejects(
    () => admin.run('draw.create', { text: 'a cat' }, { placeId: 'g1' }),
    (err: Error) => /moderation/.test(err.message) && /400/.test(err.message) && !err.message.includes('provider text')
  );
});

test('run: draw is refused while paused', async () => {
  const rootDir = makeRoot();
  const images = fakeImages();
  const { admin } = makeAdmin(rootDir, { hot: hotForDraw(rootDir), images, client: drawClient() });

  await admin.run('bot.pause', {}, {});
  await assert.rejects(() => admin.run('draw.create', { text: 'a cat' }, { placeId: 'g1' }), /paused/);
  assert.equal(images.calls.length, 0);
});

// The "before" record of every picture the persona draws: the exact `{ prompt, reference,
// accountId }` each call site hands to the image client (src/llm/images.ts#createImageGen's
// `generate`) -- a reply turn's draw.create call, a diary post's single picture, a diary set's pictures,
// and `/nep draw` with `self`. Asserted at the image-client boundary only, with literal
// expectations: wherever the prompt building, the reference or the caps move, these calls must
// stay byte for byte the same. Fake clock, fake prompts and labels, a fake appearance.png in a temp data folder, a
// fake discord.js-shaped channel; no network.

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

// Tuesday, October 6, 2026, 22:30 in Europe/Athens.
const NOW = Date.UTC(2026, 9, 6, 19, 30, 0);
const TZ = 'Europe/Athens';
const AVATAR = 'data:image/png;base64,QVZBVEFS';

// A picture of the persona is drawn with `appearance.png` of the data folder as its reference, not
// the avatar, and `image.reference` is removed. The bytes are the test's own.
const LOOK_BYTES = Buffer.from('LOOK-PNG-BYTES');
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'appearance-'));
writeFileSync(path.join(DATA_DIR, 'appearance.png'), LOOK_BYTES);

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
    // PR 7d: the switches are code and the diary's kinds and sets are constants of src/behavior/diary.ts (`photoset`
    // is a set of 4 to 6 pictures), so the config holds only the keys that are still settings.
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
describe('drawing through the operation and the turn', () => {
  after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  test("the owner's draw command answers the marks of the picture it posted", async () => {
    // Bug: a picture drawn through a command of the console is stored as anyone's, while the same picture from the persona's call is the persona's.
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
      images: recordingImages(),
      imageFetcher: imageFetcher(),
      dataDir: DATA_DIR,
      now: () => NOW,
    });
    channel('c1', 'general');
    const { result } = await withCapturedLogs(() =>
      admin.runSkillOp(
        'draw.create',
        { text: 'me reading by the window', self: true, people: ['42'], placeId: 'c1' },
        { placeId: 'g1', accountId: '42' }
      )
    );
    const data = loose(loose(result).data);
    assert.ok(data.ref, JSON.stringify(result));
    assert.deepEqual(data.marks, { self: true, accounts: ['42'] });
  });
});

// Drawing, the core's built-in ability, at its call sites: the turn's draw.create call, a diary set and `/nep draw`. The
// prompt builder and the direct generation are tested in tests/src/media/draw.test.ts. The image
// client stays the injected boundary: its calls are asserted byte for byte in
// the `draw parity` tests of tests/src/media/draw.test.ts. Fake clock, prompts, labels, avatar and channel; no network.

const createTurnRunner = onWorld(wrongly(createRealTurnRunner));

// Tuesday, October 6, 2026, 22:30 in Europe/Athens.
const MEDIA_DRAW_NOW = Date.UTC(2026, 9, 6, 19, 30, 0);
const MEDIA_DRAW_TZ = 'Europe/Athens';
const MEDIA_DRAW_AVATAR = 'data:image/png;base64,QVZBVEFS';
const FOLDERS: Array<string> = [];

const MEDIA_DRAW_LABELS = { ...baseLabels, draw: { ...baseLabels.draw, when: 'At {when}.' } };

const MEDIA_DRAW_PROMPTS = {
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
  labels: MEDIA_DRAW_LABELS,
};

function mediaDrawHot() {
  return {
    // PR 7d: the switches are code, the daily caps are gone and the diary's kinds and sets are constants of
    // src/behavior/diary.ts (`photoset` is a set of 4 to 6 pictures), so only the settings stay.
    config: {
      bot: { timezone: MEDIA_DRAW_TZ, ownerPerson: OWNER_PERSON },
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
    prompts: { ...MEDIA_DRAW_PROMPTS },
  };
}

/** A text channel of the world with every permission; `history` its raw messages. */
function mediaDrawChannel(id: string, name: string, history: Array<Untyped> = []) {
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
function mediaDrawClient() {
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
function mediaDrawImageFetcher() {
  return { fetchAsDataUrl: async () => ({ dataUrl: MEDIA_DRAW_AVATAR, bytes: 6, contentType: 'image/png' }) };
}

/** The image client boundary: every generate() call's arguments, as given. */
/** What the draw call hands the image client: the prompt, the reference picture and the member it is charged to. */
type ImageCall = { prompt: string; reference: unknown; accountId?: string };

function mediaDrawRecordingImages() {
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

function mediaDrawStore() {
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

function memberTrigger() {
  const raw = rawMessage({
    id: 'm1',
    authorId: 'u1',
    authorName: 'Eléna',
    content: 'draw a lighthouse',
    ts: MEDIA_DRAW_NOW - 1000,
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
describe('drawing media', () => {
  let stopOwners: Array<() => void> = [];
  before(() => {
    stopOwners = [ownedBy(['42'])];
  });
  after(() => {
    for (const stop of stopOwners) stop();
  });

  after(() => {
    for (const folder of FOLDERS.splice(0)) rmSync(folder, { recursive: true, force: true });
  });
  // PR 7b: admin.run takes the operation's name, the command key map is gone; the expectations are as they were.
  test('/nep draw: one picture for the owner', async () => {
    const images = mediaDrawRecordingImages();
    const hotValue = mediaDrawHot();
    const admin = (value: Record<string, Untyped>) =>
      createAdmin({
        reads: world().reads,
        port: world().port,
        hot: value,
        store: mediaDrawStore(),
        client: mediaDrawClient(),
        selfId: () => 'self-id',
        getSelfName: () => 'Bot',
        spontaneous: {},
        calibrator: { ratio: 1 },
        isServedRoot: (id: unknown) => id === 'g1',
        images,
        imageFetcher: mediaDrawImageFetcher(),
        now: () => MEDIA_DRAW_NOW,
      });
    const ctx = { placeId: 'g1', accountId: '42' };
    const { result } = await withCapturedLogs(() =>
      admin(hotValue).run('draw.create', { text: 'me reading by the window', self: true }, ctx)
    );
    assert.equal(result.files.length, 1);
    const firstCall = images.calls[0];
    assert.equal(
      firstCall.prompt,
      'A drawing by Bot.\n\nBot has silver hair and a green scarf.\n\nScene: me reading by the window'
    );
  });

  test("draw.create from a member's mention: the picture is charged to the member", async () => {
    const hotValue: Record<string, Untyped> = mediaDrawHot();
    const { bot } = hotValue.config;
    bot.access = { 'draw.create': { everyone: false, roles: [], users: ['self-id'] } };
    hotValue.config.tools = { safeMode: false, resultMaxChars: 2000, callTimeoutMs: 120000 };
    const images = mediaDrawRecordingImages();
    const hotCase = structuredClone(hotValue);
    hotCase.prompts = { ...MEDIA_DRAW_PROMPTS };
    const { raw, trigger } = memberTrigger();
    const target = mediaDrawChannel('c1', 'general', [wrongly(raw)]);
    mediaDrawClient();
    const turns = createTurnRunner({
      hot: hotCase,
      store: mediaDrawStore(),
      llm: llm(toolAnswer('', [call('draw.create', { people: [], text: 'a lighthouse at dusk' })])),
      calibrator: { ratio: 1, apply: (n: Record<string, Untyped>) => n, observe: () => {} },
      images,
      imageFetcher: mediaDrawImageFetcher(),
      lookup: null,
      rng: () => 0.5,
      now: () => MEDIA_DRAW_NOW,
      skills: skillRegistry(),
      runOp: createAdmin({
        reads: world().reads,
        port: world().port,
        hot: hotCase,
        store: mediaDrawStore(),
        client: mediaDrawClient(),
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
    const firstCall = images.calls[0];
    assert.equal(firstCall.accountId, 'u1');
    assert.ok(
      target.sent.some((payload) => payload.files?.length === 1),
      'the picture was posted'
    );
  });

  test("draw.create operation quotes the message it replies to, in that message's channel (a link) and refuses a channel that disagrees", async () => {
    const { createFakeAdapter } = await import('../../../../scripts/lib/fake.ts');
    const hotValue = mediaDrawHot();
    const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => MEDIA_DRAW_NOW });
    port.seed('c1', { authorId: 'u1', messageId: 'm9', text: 'a lighthouse?' });
    const admin = createAdmin({
      reads: world().adopt(port, { sendsInHistory: true }),
      hot: hotValue,
      store: mediaDrawStore(),
      client: mediaDrawClient(),
      selfId: () => 'self-id',
      getSelfName: () => 'Bot',
      spontaneous: {},
      calibrator: { ratio: 1 },
      isServedRoot: (id: unknown) => id === 'g1',
      images: mediaDrawRecordingImages(),
      imageFetcher: mediaDrawImageFetcher(),
      now: () => MEDIA_DRAW_NOW,
      port,
    });
    const ctx = { placeId: 'c1', accountId: '42', roleIds: [], actor: 'owner' };
    const quoted = (
      await withCapturedLogs(() => admin.runSkillOp('draw.create', { text: 'a lighthouse', replyTo: 'm9' }, ctx))
    ).result;
    assert.equal(quoted.status ?? 'ok', 'ok', JSON.stringify(quoted));
    const sent: Untyped = port.calls.find((call) => call.op === 'send');
    const secondArg = present(sent).args[1];
    const secondArg2 = present(sent).args[1];
    assert.deepEqual(
      [present(sent).args[0].chatId, secondArg.replyTo.chatId, secondArg2.replyTo.messageId],
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
});
