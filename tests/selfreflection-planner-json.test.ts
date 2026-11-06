// Tests for the selfreflection planner's strict JSON answer (src/turn/selfreflection.ts over
// src/behavior/selfreflection.ts): the plan request hands the client `selfreflectionPlanFormat(kinds)` as
// `responseFormat`, a closed object `{ kind, brief, search, picture, seed }` whose `kind` allows exactly the kinds that
// request offered. A well-formed object plans as before. An answer that is not exactly that object (prose around it, a
// fenced object, a missing field, a kind outside the offer, a wrong type) falls back as a broken answer does today: a
// weighted random kind, an empty brief, and no plan stored with the post.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner as createRealTurnRunner } from '../src/behavior/turn.ts';
import { selfreflectionPlanFormat } from '../src/behavior/selfreflection.ts';
import { labels } from './fixtures/labels.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { completionOf } from './fixtures/tool-answers.ts';
import '../src/tools/impl/index.ts';
import { onWorld, useIface, useSelf, world } from './fixtures/turn-world.ts';
import type { Channel } from './fixtures/turn-world.ts';

useIface('fake');
useSelf('self-id');
const createWorldRunner = onWorld((options) =>
  createRealTurnRunner(options as Parameters<typeof createRealTurnRunner>[0])
);

const NOW = Date.UTC(2026, 10, 6, 19, 30, 0);
const ALL_KINDS = [
  'facts',
  'meme',
  'news',
  'people',
  'photoset',
  'picture',
  'randomSet',
  'selfPicture',
  'status',
  'thought',
];
const TEXT_KINDS = ['facts', 'news', 'people', 'status', 'thought'];

/** The diary channel the persona owns, opened in the test's world when a turn runs in it. */
function diaryChannel() {
  let handle: Channel | null = null;
  return {
    id: 'd1',
    open() {
      handle ??= world().channel({ id: 'd1', name: 'journal', placeId: 'g1', permissions: { attach: true } });
      return handle;
    },
  };
}

type Recorded = { post: { kind?: unknown; plan?: { brief?: unknown; seed?: unknown } } };

function fakeStore() {
  const appended: Array<Recorded> = [];
  return {
    appended,
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    getMediaCache: () => ({}),
    getSelfreflection: () => ({ posts: [], updatedAt: 0 }),
    appendSelfreflectionPost: (post: Recorded['post']) => appended.push({ post }),
    state: { data: {}, markDirty() {} },
  };
}

function fakeImages() {
  return {
    quota: () => ({ used: 0, cap: 10, userUsed: 0, userCap: 5, spent: false, userSpent: false }),
    generate: () => Promise.resolve({ buffer: Buffer.from('png'), mediaType: 'image/png', seconds: 1, cost: 0 }),
  };
}

function fakeHot() {
  return {
    config: {
      bot: { timezone: 'Europe/Athens' },
      context: {
        channelMessages: 50,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { fetchTimeoutMs: 10_000 },
        pull: { sameAudience: true },
      },
      llm: { maxRequestTokens: 50000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [0, 0], minMs: 0, maxMs: 0, betweenMessagesMs: [0, 0] },
      image: { maxPromptChars: 1000 },
      selfreflection: { placeId: 'd1', world: false, planMaxOutputTokens: 250, planTimeoutMs: 15000 },
    },
    prompts: {
      'system-prompt': 'SYSTEM for {{name}}',
      'character-card': 'CARD_TEXT',
      format: 'FORMAT_TEXT',
      selfreflection: 'DIARY_TASK for {{name}}',
      'selfreflection-planner': 'PLAN_SYSTEM for {{name}}',
      'selfreflection-seeds': '# place\na pier\n# light\nfog',
      draw: 'DRAW for {{name}}\n{{when}}\n{{request}}',
      labels,
    },
  };
}

/** A model that answers the plan request with `plan` (text as given) and the post with one message. */
function fakeLlm(plan: string) {
  const planOptions: Array<Record<string, unknown>> = [];
  return {
    planOptions,
    complete: (_messages: unknown, options: Record<string, unknown>) => {
      if (options.purpose === 'selfreflection-planner') {
        planOptions.push(options);
        return Promise.resolve({ text: plan, usage: {}, estimated: 5 });
      }
      return Promise.resolve(completionOf('<msg>brume</msg>'));
    },
  };
}

/** One diary turn whose planner answers `plan`; `pictures` false runs it with no image client. */
async function diaryTurn(plan: string, { pictures = true, kind = null as string | null } = {}) {
  const llm = fakeLlm(plan);
  const store = fakeStore();
  const turns = createWorldRunner({
    hot: fakeHot(),
    store,
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    images: pictures ? fakeImages() : null,
    lookup: null,
    rng: () => 0.5,
    now: () => NOW,
  });
  const channel = diaryChannel();
  channel.open();
  const { logs } = await withCapturedLogs(() =>
    turns.runTurn({
      channel,
      mode: 'selfreflection',
      selfreflection: kind ? { kind, forced: true } : {},
    })
  );
  const planned = logs.find((entry) => entry.msg === 'selfreflection: planned');
  const [recorded] = store.appended;
  return { planOptions: llm.planOptions, planned, post: recorded?.post };
}

/** The object text of a plan: a status post built on seed 1, then `fields`. */
const plan = (fields: Record<string, unknown>) =>
  JSON.stringify({ kind: 'status', brief: 'tired of rain', search: '', picture: false, seed: 1, ...fields });

/** Every string a schema node allows by `enum` or `const`, anywhere below it. */
function allowedStrings(node: unknown): Set<string> {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'enum' && Array.isArray(child)) {
        for (const item of child) if (typeof item === 'string') found.add(item);
      } else if (key === 'const' && typeof child === 'string') {
        found.add(child);
      } else {
        walk(child);
      }
    }
  };
  walk(node);
  return found;
}

type Schema = {
  type?: unknown;
  additionalProperties?: unknown;
  required?: Array<string>;
  properties?: Record<string, unknown>;
};

/** The kinds the schema of the one plan request allows. */
function kindsSent(planOptions: Array<Record<string, unknown>>): Array<string> {
  assert.equal(planOptions.length, 1);
  const [options] = planOptions;
  const format = options?.responseFormat as { schema?: Schema } | undefined;
  const properties = format?.schema?.properties;
  return [...allowedStrings(properties?.kind)].sort();
}

test('the plan request hands the client a schema whose kind is the one kind drawn', async () => {
  // Bug: a fixed schema lets the model name a kind the request did not offer, and the post is planned for nothing.
  // The lead: since #675 the code draws the kind and the plan request offers that one kind (owner, 2026-11-06).
  const { planOptions } = await diaryTurn(plan({}));
  const kinds = kindsSent(planOptions);
  assert.equal(kinds.length, 1);
  assert.ok(ALL_KINDS.includes(kinds[0] ?? ''), kinds[0]);
});

test('with pictures off the schema allows only the text kinds', async () => {
  // Bug: the schema still offers a picture kind, so the planner picks one and the post falls back every time.
  // The lead: since #675 the code draws the kind and the plan request offers that one kind (owner, 2026-11-06).
  const { planOptions } = await diaryTurn(plan({}), { pictures: false });
  const kinds = kindsSent(planOptions);
  assert.equal(kinds.length, 1);
  assert.ok(TEXT_KINDS.includes(kinds[0] ?? ''), kinds[0]);
});

test('a forced kind is the one kind the schema allows', async () => {
  const { planOptions } = await diaryTurn(plan({ kind: 'thought' }), { kind: 'thought' });
  assert.deepEqual(kindsSent(planOptions), ['thought']);
});

test('selfreflectionPlanFormat is a closed object of the five plan fields with kind from its argument', () => {
  const schema = selfreflectionPlanFormat(['status', 'news']).schema as Schema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  const fields = ['brief', 'kind', 'picture', 'search', 'seed'];
  assert.deepEqual([...(schema.required ?? [])].sort(), fields);
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), fields);
  assert.deepEqual([...allowedStrings(schema.properties?.kind)].sort(), ['news', 'status']);
});

test('a well-formed object plans its kind and stores its brief and seed with the post', async () => {
  // Bug: the strict reader rejects the very object the schema asks for, and every post falls back.
  // The lead: since #675 the code draws the kind and the plan request offers that one kind (owner, 2026-11-06).
  const { planned, post } = await diaryTurn(plan({ kind: 'status', brief: 'tired of rain', seed: 1 }), {
    kind: 'status',
  });
  assert.equal(planned?.fallback, false);
  assert.equal(post?.kind, 'status');
  assert.equal(post?.plan?.brief, 'tired of rain');
  assert.equal(post?.plan?.seed, 1);
});

/** Plan answers that are not exactly the object: each falls back. */
const UNREADABLE = [
  'not json at all',
  `Here is the plan: ${plan({})}`,
  '```json\n' + plan({}) + '\n```',
  plan({}).slice(0, -1),
  JSON.stringify({ kind: 'status', brief: 'tired of rain', search: '', picture: false }),
  JSON.stringify({ kind: 'status', search: '', picture: false, seed: 1 }),
  plan({ kind: 'opera' }),
  plan({ kind: null }),
  plan({ brief: 7 }),
  plan({ search: null }),
  plan({ picture: 'false' }),
  plan({ seed: '1' }),
  `[${plan({})}]`,
  'null',
];

test('an answer that is not exactly the object falls back to a weighted kind and stores no plan', async () => {
  for (const text of UNREADABLE) {
    const { planned, post } = await diaryTurn(text);
    assert.equal(planned?.fallback, true, text);
    assert.ok(ALL_KINDS.includes(String(post?.kind)), `${text}: a weighted kind`);
    assert.equal(post?.plan, undefined, `${text}: no plan stored`);
  }
});
