// Tests for the route of her tool abilities in a turn (src/behavior/turn.js over src/tools/gateway.ts#abilityRoute and
// src/llm/role-health.ts): `draw.create` (drawing, imagesOut), `media.look` (vision, imagesIn) and `voice.say` (speech,
// audioOut). When the role is unset or globally failing, the call goes to the core model if the core declares the
// ability (`models.abilities.<model id>`), else the call does not happen and answers `ability-unavailable`. A global
// failure met during the call routes that same call. The first routed call of a turn carries one route line in its
// tool result, naming every tool ability whose role is down; later calls of the turn carry none. One shared
// `roleHealth` reaches the turn runner and the admin. Over the turn harness with fake model, image and speech
// clients; the labels are this file's own, so nothing here depends on their wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoleHealth } from '../src/llm/role-health.ts';
import { ImageGenError } from '../src/llm/images.ts';
import { createDescriber } from '../src/memory/describe.ts';
import { fill } from '../src/format.ts';
import { labels } from './fixtures/labels.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { NOW, coreTurn, fakeStore } from './fixtures/turn-harness.ts';
import { DRAW_PROMPTS, fakeImages } from './fixtures/turn-draws.ts';

const ABILITY_WORDS = {
  imagesIn: 'A:imagesIn',
  videoIn: 'A:videoIn',
  imagesOut: 'A:imagesOut',
  audioOut: 'A:audioOut',
} as const;
const WHY_WORDS = {
  'no-model': 'W:no-model',
  'no-key': 'W:no-key',
  unauthorized: 'W:unauthorized',
  payment: 'W:payment',
  'not-found': 'W:not-found',
  'daily-limit': 'W:daily-limit',
  malformed: 'W:malformed',
} as const;
type Ability = keyof typeof ABILITY_WORDS;
type Why = keyof typeof WHY_WORDS;

const ROUTE = { fallback: 'core does {ability}: {why}', unavailable: 'gone {ability}: {why}', separator: ' | ' };
const UNAVAILABLE = 'cannot {ability}: {why}; the core cannot either';

/** The fixture labels with the route keys and the `ability-unavailable` reason in this file's own words. */
const ROUTE_LABELS = {
  ...labels,
  tools: {
    ...labels.tools,
    route: ROUTE,
    result: {
      ...labels.tools.result,
      reasons: { ...labels.tools.result.reasons, 'ability-unavailable': UNAVAILABLE },
      params: { ability: ABILITY_WORDS, why: WHY_WORDS },
    },
  },
};

/** One phrase of the route line. */
const phrase = (kind: 'fallback' | 'unavailable', ability: Ability, why: Why): string =>
  fill(ROUTE[kind], { ability: ABILITY_WORDS[ability], why: WHY_WORDS[why] });

/** The words of an `ability-unavailable` result's reason. */
const unavailableReason = (ability: Ability, why: Why): string =>
  fill(UNAVAILABLE, { ability: ABILITY_WORDS[ability], why: WHY_WORDS[why] });

type Run = Awaited<ReturnType<typeof coreTurn>>;
type Message = { role: string; text: string };

/** The text of a message's content, its parts joined. */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) => {
      const text: unknown = part !== null && typeof part === 'object' ? Reflect.get(part, 'text') : null;
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

/** The messages of her request `index` in the turn; throws when the turn made no such request. */
function requestOf(run: Run, index: number): Array<Message> {
  const calls: unknown = run.llm.calls;
  const request: unknown = Array.isArray(calls) ? calls[index] : undefined;
  if (!Array.isArray(request)) throw new Error(`the turn made no request ${index}`);
  return request.map((item: unknown) => {
    const role: unknown = item !== null && typeof item === 'object' ? Reflect.get(item, 'role') : null;
    const content: unknown = item !== null && typeof item === 'object' ? Reflect.get(item, 'content') : null;
    return { role: String(role), text: textOfContent(content) };
  });
}

/** How many lines of every message of `request` are exactly `line`. */
const linesEqual = (request: Array<Message>, line: string): number =>
  request.flatMap((message) => message.text.split('\n')).filter((text) => text === line).length;

/** The text of the tool messages of `request`, in order. */
const toolTexts = (request: Array<Message>): Array<string> =>
  request.filter((message) => message.role === 'tool').map((message) => message.text);

/** The code of each call of `skill` as the turn logs it, '' for a call that worked. */
const calledCodes = (run: Run, skill: string): Array<string> =>
  run.logs
    .filter((entry) => entry.msg === 'skills: called' && entry.skill === skill)
    .map((entry) => String(entry.code ?? ''));

/** A health tracker on the turn's clock, every key present. */
const healthAt = () => createRoleHealth({ now: () => NOW, hasKey: () => true });

/** Zoë's message m0 (`#1`) carries one picture. */
const PICTURE = new Map([
  [
    'pa',
    {
      id: 'pa',
      contentType: 'image/png',
      name: 'lampe.png',
      url: 'https://cdn.discordapp.com/attachments/1/2/lampe.png',
    },
  ],
]);
const LOOK_PROMPTS = {
  rewatch: 'Pick a second look for {{name}}.',
  'rewatch-answer': 'Answer {{question}} in {{maxChars}}.',
};
const fakePictures = {
  fetchAsDataUrl: () =>
    Promise.resolve({ dataUrl: 'data:image/webp;base64,ZmFrZQ==', bytes: 4, contentType: 'image/webp' }),
};

test('with the drawing key revoked and a core that cannot draw, draw.create answers ability-unavailable and the next request carries the route line once', async () => {
  const roleHealth = healthAt();
  const revoked = new ImageGenError('error', 'OpenRouter images HTTP 401', { statusCode: 401, body: '{}' });
  const images = fakeImages([revoked]);
  const run = await coreTurn({
    answers: [toolAnswer('', [call('draw.create', { text: 'ένας φάρος' })]), '<skip/>'],
    allowed: ['draw.create'],
    config: {
      image: { maxPromptChars: 1000, reference: 'none' },
      models: { base: { core: 'x/core', analyzer: 'x/text', drawing: 'openai/image-model' }, abilities: {} },
    },
    prompts: { ...DRAW_PROMPTS, labels: ROUTE_LABELS },
    runner: { images, roleHealth, imageFetcher: fakePictures },
    adminExtra: { roleHealth },
  });
  assert.equal(images.calls.length, 1, 'the one request that met the 401');
  assert.deepEqual(calledCodes(run, 'draw.create'), ['ability-unavailable']);
  assert.equal(run.sends.length, 0, 'nothing posted');
  assert.equal(roleHealth.down(run.hot.config, 'drawing')?.reason, 'unauthorized', 'the 401 is a global failure');

  const next = requestOf(run, 1);
  assert.ok(toolTexts(next)[0]?.includes(unavailableReason('imagesOut', 'unauthorized')), 'the result says why');
  assert.equal(linesEqual(next, phrase('unavailable', 'imagesOut', 'unauthorized')), 1, 'the route line, once');
});

test('with the vision model unset and a core that declares imagesIn, media.look is answered by the core model with the vision prompt', async () => {
  const roleHealth = healthAt();
  // The model requests of the describer: the second look goes out on the core model, with the same input.
  const looks: Array<{ messages: Array<{ role: string; content: unknown }>; model: unknown }> = [];
  const lookLlm = {
    complete: (messages: Array<{ role: string; content: unknown }>, options: { model?: unknown }) => {
      looks.push({ messages, model: options.model });
      return Promise.resolve({ text: 'μια λάμπα στο τραπέζι', usage: {}, estimated: 5 });
    },
  };
  const cache = {};
  const store = { ...fakeStore(), getMediaCache: () => cache, markMediaCacheDirty() {} };
  // The describer reads the turn's own hot config and prompts, as the core wires it.
  let turnHot: { config: unknown; prompts: unknown } | null = null;
  const hot = {
    get config() {
      return turnHot?.config;
    },
    get prompts() {
      return turnHot?.prompts;
    },
  };
  const describer = createDescriber({
    hot,
    store,
    llm: lookLlm,
    imageFetcher: fakePictures,
    state: { data: {}, markDirty() {} },
  });
  const run = await coreTurn({
    answers: [toolAnswer('', [call('media.look', { message: '#1', question: 'τι είναι;' })]), '<msg>λάμπα</msg>'],
    allowed: ['media.look'],
    firstAttachments: PICTURE,
    store,
    config: {
      models: {
        base: { core: 'x/core', analyzer: 'x/text', vision: false },
        abilities: { 'x/core': ['text', 'imagesIn'] },
      },
    },
    prompts: { ...LOOK_PROMPTS, labels: ROUTE_LABELS },
    runner: { describer, imageFetcher: fakePictures, roleHealth },
    adminExtra: { roleHealth },
    withHot: (given: { config: unknown; prompts: unknown }) => {
      turnHot = given;
    },
  });
  assert.deepEqual(calledCodes(run, 'media.look'), ['']);
  assert.equal(looks.length, 1);
  assert.equal(looks[0]?.model, 'x/core', 'the core model, not the vision default');
  const system = looks[0]?.messages[0]?.content;
  assert.ok(typeof system === 'string' && system.startsWith('Answer τι είναι; in '), "the vision role's own prompt");
  assert.ok(JSON.stringify(looks[0]?.messages[1]?.content).includes('data:image/webp'), 'the picture itself');

  const next = requestOf(run, 1);
  assert.ok(toolTexts(next)[0]?.includes('μια λάμπα στο τραπέζι'), 'she reads the answer');
  assert.equal(linesEqual(next, phrase('fallback', 'imagesIn', 'no-model')), 1, 'the route line, once');
});

test('a text-only core loses vision, video, drawing and speech, and she is told once per turn, not once per call', async () => {
  const roleHealth = healthAt();
  const images = fakeImages();
  const relooks: Array<unknown> = [];
  const describer = {
    relookImage: (...args: Array<unknown>) => {
      relooks.push(args);
      return Promise.resolve({ question: 'x', text: 'x' });
    },
  };
  const said: Array<unknown> = [];
  const speech = {
    quota: () => ({ used: 0, cap: 10, spent: false }),
    say: (args: unknown) => {
      said.push(args);
      return Promise.reject(new Error('speech must not be called'));
    },
  };
  const run = await coreTurn({
    answers: [
      toolAnswer('', [
        call('draw.create', { text: 'ένας φάρος' }),
        call('media.look', { message: '#1', question: 'τι είναι;' }),
      ]),
      toolAnswer('', [call('voice.say', { text: 'γεια σας' }), call('draw.create', { text: 'μια βάρκα' })]),
      '<skip/>',
    ],
    allowed: ['draw.create', 'media.look', 'voice.say'],
    firstAttachments: PICTURE,
    config: {
      image: { maxPromptChars: 1000, reference: 'none' },
      speech: { maxChars: 500, maxPerDay: 10 },
      models: {
        base: { core: 'x/core', analyzer: 'x/text', vision: false, video: false, drawing: false, speech: false },
        abilities: {},
      },
    },
    prompts: { ...DRAW_PROMPTS, ...LOOK_PROMPTS, labels: ROUTE_LABELS },
    runner: { images, describer, speech, imageFetcher: fakePictures, roleHealth },
    adminExtra: { speech, roleHealth },
  });
  assert.equal(images.calls.length, 0, 'no picture asked of a role with no model');
  assert.equal(relooks.length, 0, 'no second look asked');
  assert.equal(said.length, 0, 'no voice asked');
  assert.deepEqual(calledCodes(run, 'draw.create'), ['ability-unavailable', 'ability-unavailable']);
  assert.deepEqual(calledCodes(run, 'media.look'), ['ability-unavailable']);
  assert.deepEqual(calledCodes(run, 'voice.say'), ['ability-unavailable']);

  // Every tool ability she lost, in the order vision, video, drawing, speech, on one line.
  const lost = ['imagesIn', 'videoIn', 'imagesOut', 'audioOut'] as const;
  const line = lost.map((ability) => phrase('unavailable', ability, 'no-model')).join(ROUTE.separator);
  const afterFirst = requestOf(run, 1);
  const afterSecond = requestOf(run, 2);
  assert.equal(linesEqual(afterFirst, line), 1, 'told with the first step');
  assert.equal(linesEqual(afterSecond, line), 1, 'the second step adds no second line');
  for (const ability of lost) {
    assert.equal(linesEqual(afterSecond, phrase('unavailable', ability, 'no-model')), 0, `${ability} not told alone`);
  }
});

// ---- roles that are off ----------------------------------------------------------------------------------------------
// An optional role with a null model (`models.base.<role>`) is off. The tools it serves are not in her request's
// `tools`, a picture, GIF or video that needs it is not described, and the request carries the words of the
// `ability-unavailable` answer once for each ability that is down, so she can say she cannot see it.

const ON_ROLES = { vision: 'x/vision', video: 'x/video', drawing: 'x/draw', speech: 'x/speech' };
const CORE_AND_TEXT = { core: 'x/core', analyzer: 'x/text' };

/** The names of the tools of her first request. */
function toolNamesOf(run: Run): Array<string> {
  const tools: unknown = run.llm.options[0]?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((tool: unknown) => {
    const fn: unknown = tool !== null && typeof tool === 'object' ? Reflect.get(tool, 'function') : null;
    const name: unknown = fn !== null && typeof fn === 'object' ? Reflect.get(fn, 'name') : null;
    return String(name);
  });
}

// Bug caught: the model is offered tools whose model is off, and spends steps on calls that cannot run.
test('with drawing and speech off, her tools field has no draw_create and no voice_say, and media_look stays', async () => {
  const run = await coreTurn({
    answers: ['<skip/>'],
    allowed: ['media.look'],
    config: { models: { base: { ...CORE_AND_TEXT, ...ON_ROLES, drawing: null, speech: null } } },
    prompts: { labels: ROUTE_LABELS },
  });
  const names = toolNamesOf(run);
  assert.ok(names.includes('message_create') && names.includes('media_look'), names.join());
  assert.equal(names.includes('draw_create'), false);
  assert.equal(names.includes('voice_say'), false);
});

// Bug caught: any change to the request of a deployment where every role has a model.
test('with every role on, her whole request and her tools are byte-identical to a config that names no optional model', async () => {
  const turn = (base: Record<string, unknown>) =>
    coreTurn({
      answers: ['<skip/>'],
      allowed: ['media.look', 'web.search'],
      config: { models: { base } },
      prompts: { labels: ROUTE_LABELS },
    });
  const explicit = await turn({ ...CORE_AND_TEXT, ...ON_ROLES });
  const bare = await turn(CORE_AND_TEXT);
  const shape = (run: Run) => JSON.stringify({ calls: run.llm.calls, tools: run.llm.options.map((o) => o.tools) });
  assert.equal(shape(explicit), shape(bare));
  assert.ok(toolNamesOf(explicit).includes('draw_create') && toolNamesOf(explicit).includes('voice_say'));
});

const GIF = new Map([
  [
    'ga',
    {
      id: 'ga',
      contentType: 'image/gif',
      name: 'anim.gif',
      url: 'https://cdn.discordapp.com/attachments/1/2/anim.gif',
    },
  ],
]);
const CLIP = new Map([
  [
    'va',
    {
      id: 'va',
      contentType: 'video/mp4',
      name: 'clip.mp4',
      size: 1000,
      url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4',
    },
  ],
]);
const DESCRIBE_PROMPTS = {
  describe: 'Describe it in {{maxChars}}.',
  'describe-video': 'Watch it in {{maxChars}}.',
};

/** A turn whose first message carries `attachments`, with the real describer over a recording model and fetchers. */
async function mediaTurn(base: Record<string, unknown>, attachments: Map<string, unknown>) {
  const described: Array<unknown> = [];
  const describeLlm = {
    complete: (messages: unknown, options: { model?: unknown }) => {
      described.push({ messages, model: options.model });
      return Promise.resolve({ text: 'une chose décrite', usage: {}, estimated: 5 });
    },
  };
  const store = { ...fakeStore(), getMediaCache: () => ({}), markMediaCacheDirty() {} };
  let turnHot: { config: unknown; prompts: unknown } | null = null;
  const hot = {
    get config() {
      return turnHot?.config;
    },
    get prompts() {
      return turnHot?.prompts;
    },
  };
  const fetched: Array<string> = [];
  const videoFetcher = {
    fetchAttachment: (url: string) => {
      fetched.push(url);
      return Promise.resolve({ ok: false, reason: 'error' });
    },
  };
  const describer = createDescriber({
    hot,
    store,
    llm: describeLlm,
    imageFetcher: fakePictures,
    videoFetcher,
    state: { data: {}, markDirty() {} },
  });
  const run = await coreTurn({
    answers: ['<skip/>'],
    allowed: [],
    firstAttachments: attachments,
    store,
    config: { models: { base: { ...CORE_AND_TEXT, ...base } }, media: { maxOutputTokens: 120 } },
    prompts: { ...DESCRIBE_PROMPTS, labels: ROUTE_LABELS },
    runner: { describer, imageFetcher: fakePictures, videoFetcher, roleHealth: healthAt() },
    withHot: (given: { config: unknown; prompts: unknown }) => {
      turnHot = given;
    },
  });
  return { run, described, fetched };
}

/** How many lines of her first request are exactly the words of the ability-unavailable answer for `ability`. */
function toldOnce(run: Run, ability: Ability): number {
  return linesEqual(requestOf(run, 0), unavailableReason(ability, 'no-model'));
}

// Bug caught: a picture sent to a vision model nobody set, or the turn silent about not having seen it.
test('a picture with vision off is not described and the request carries the ability-unavailable words for pictures', async () => {
  const { run, described } = await mediaTurn({ ...ON_ROLES, vision: null }, PICTURE);
  assert.equal(described.length, 0, 'no model request for the picture');
  assert.equal(toldOnce(run, 'imagesIn'), 1);
  assert.equal(toldOnce(run, 'videoIn'), 0, 'video is on and no video is there');
});

// Bug caught: the same picture, vision on, losing its caption or being announced as unseen.
test('a picture with vision on is described and the request carries no ability-unavailable words', async () => {
  const { run, described } = await mediaTurn(ON_ROLES, PICTURE);
  assert.equal(described.length, 1);
  assert.equal(toldOnce(run, 'imagesIn'), 0);
  assert.equal(toldOnce(run, 'videoIn'), 0);
});

// Bug caught: a GIF read through the vision model while video is off, or the loss told as the picture's.
test('a GIF with video off is not described and the request carries the ability-unavailable words for videos', async () => {
  const { run, described } = await mediaTurn({ ...ON_ROLES, video: null }, GIF);
  assert.equal(described.length, 0, 'no request on any role');
  assert.equal(toldOnce(run, 'videoIn'), 1);
  assert.equal(toldOnce(run, 'imagesIn'), 0, 'pictures are on and none is there');
});

// Bug caught: a video fetched and sent to a video model that is off.
test('a video with video off is not fetched or watched and the request carries the ability-unavailable words for videos', async () => {
  const { run, described, fetched } = await mediaTurn({ ...ON_ROLES, video: null }, CLIP);
  assert.equal(described.length, 0);
  assert.equal(fetched.length, 0);
  assert.equal(toldOnce(run, 'videoIn'), 1);
});

// Bug caught: every role off telling nothing when there is no media, which would add a line to every request.
test('with every media role off and no media in the window, the request carries no ability-unavailable words', async () => {
  const { run } = await mediaTurn({ ...ON_ROLES, vision: null, video: null }, new Map());
  assert.equal(toldOnce(run, 'imagesIn') + toldOnce(run, 'videoIn'), 0);
});
