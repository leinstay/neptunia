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
import { ImageGenError } from '../src/llm/images.js';
import { createDescriber } from '../src/memory/describe.js';
import { fill } from '../src/format.js';
import { labels } from './fixtures/labels.js';
import { call, toolAnswer } from './fixtures/tool-answers.js';
import { NOW, coreTurn, fakeStore } from './fixtures/turn-harness.js';
import { DRAW_PROMPTS, fakeImages } from './fixtures/turn-draws.js';

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
    features: { imageGeneration: true },
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
    features: { imageGeneration: true, speech: true },
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
