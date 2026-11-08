// The "before" record of every picture the persona draws: the exact `{ prompt, reference,
// accountId }` each call site hands to the image client (src/llm/images.ts#createImageGen's
// `generate`) -- a reply turn's draw.create call, a diary post's single picture, a diary set's pictures,
// and `/nep draw` with `self`. Asserted at the image-client boundary only, with literal
// expectations: wherever the prompt building, the avatar fetch or the caps move, these calls must
// stay byte for byte the same. Fake clock, fake prompts and labels, a fake avatar reference, a
// fake discord.js-shaped channel; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner as createRealTurnRunner } from '../src/behavior/turn.ts';
import { createAdmin } from '../src/admin.ts';
import { familyOf } from '../src/llm/images.ts';
import { onWorld, world } from './fixtures/turn-world.ts';
import { labels as baseLabels } from './fixtures/labels.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { call, completionOf, toolAnswer } from './fixtures/tool-answers.ts';
import type { Untyped } from '../src/tools/types.ts';
import { planAnswerText } from './fixtures/plan-answer.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

// onWorld takes a creator of any options; the real runner takes its own input type, so the options are cast once, here.
const createTurnRunner = onWorld((options) =>
  createRealTurnRunner(options as Parameters<typeof createRealTurnRunner>[0])
);

// Tuesday, October 6, 2026, 22:30 in Europe/Athens.
const NOW = Date.UTC(2026, 9, 6, 19, 30, 0);
const TZ = 'Europe/Athens';
const WHEN = 'At Tuesday, October 6, 2026, 22:30 (Europe/Athens).';
const AVATAR = 'data:image/png;base64,QVZBVEFS';

const LABELS = { ...baseLabels, draw: { ...baseLabels.draw, when: 'At {when}.' } };

const PROMPTS = {
  'system-prompt': 'SYSTEM for {{name}}',
  'character-card': 'CARD_TEXT',
  format: 'FORMAT_TEXT',
  reply: 'Someone called you: {{author}}.',
  selfreflection: 'DIARY_TASK for {{name}}',
  'selfreflection-planner': 'PLAN_SYSTEM for {{name}}',
  'selfreflection-seeds': '# place\na pier\n# light\nfog',
  draw: 'A drawing by {{name}}.\n\n{{appearance}}\n\n{{when}}\n\nScene: {{request}}',
  appearance: '{{name}} has silver hair and a green scarf.',
  labels: LABELS,
};

function hot() {
  return {
    // PR 7d: the switches are code and the diary's kinds and sets are constants of src/behavior/selfreflection.ts (`photoset`
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
      models: { base: { drawing: 'openai/image-model' } },
      typing: { reactionDelayMs: [0, 0], msPerChar: [0, 0], minMs: 0, maxMs: 0, betweenMessagesMs: [0, 0] },
      image: { maxPromptChars: 1000, reference: 'avatar', referenceMaxBytes: 4_000_000 },
      selfreflection: { placeId: 'd1', world: false, planMaxOutputTokens: 250, planTimeoutMs: 15000 },
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
    getMediaCache: () => ({}),
    getSelfreflection: () => ({ posts: [], updatedAt: 0 }),
    appendSelfreflectionPost: () => ({ dropped: [] }),
    state: { data: {}, markDirty() {} },
  };
}

/** An LLM answering the diary plan with `plan` and every other request with `post`. */
function llm(post: Untyped, plan: Record<string, unknown> | null = null) {
  let composed = 0;
  return {
    complete: async (_messages: Untyped, opts: Untyped) => {
      // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
      if (opts?.purpose === 'selfreflection-planner')
        return { text: planAnswerText(plan, opts), usage: {}, estimated: 5 };
      const answer = Array.isArray(post) ? post[Math.min(composed, post.length - 1)] : post;
      composed += 1;
      return completionOf(answer);
    },
  };
}

function runner({
  answer,
  plan = null,
  images,
}: {
  answer: Untyped;
  plan?: Record<string, unknown> | null;
  images: Untyped;
}) {
  client();
  return createTurnRunner({
    hot: hot(),
    store: store(),
    llm: llm(answer, plan),
    calibrator: { ratio: 1, apply: (n: Untyped) => n, observe: () => {} },
    images,
    imageFetcher: imageFetcher(),
    lookup: null,
    rng: () => 0.5,
    now: () => NOW,
  });
}

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
  const turns = runner({
    // The owner's rule of 2026-10-20 (#314), restored 2026-11-08: a quiet call in a turn that answers someone is shown to her in one step. She stays silent there.
    answer: [
      toolAnswer('<msg>one sec</msg>', [
        call('draw.create', { reply: '#1', text: 'a lighthouse at dusk, waves below' }),
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
  const plan = { kind: 'selfPicture', brief: 'a pier at dawn', search: '', picture: true };
  const turns = runner({
    answer: toolAnswer('<msg>early start</msg>', [
      call('draw.create', { text: 'me on a pier at dawn, fog', self: true }),
    ]),
    plan,
    images,
  });
  const { result } = await withCapturedLogs(() =>
    turns.runTurn({
      channel: channel('d1', 'journal'),
      mode: 'selfreflection',
      selfreflection: { kind: null, forced: false },
    })
  );
  assert.equal(loose(result).outcome, 'spoke');
  assert.deepEqual(images.calls, [
    {
      prompt: `A drawing by Bot.\n\nBot has silver hair and a green scarf.\n\n${WHEN}\n\nScene: me on a pier at dawn, fog`,
      reference: AVATAR,
      accountId: null,
    },
  ]);
});

test("draw parity: a diary set's pictures, the persona in the first one only", async () => {
  // The lead: the code draws the diary's kind (owner, 2026-11-06).
  const images = recordingImages();
  const plan = { kind: 'photoset', brief: 'a harbour walk', search: '', picture: true };
  const answer = toolAnswer('<msg>a walk</msg>', [
    call('draw.create', { text: 'me at the harbour gate', self: true }),
    call('draw.create', { text: 'boats in the harbour' }),
    call('draw.create', { text: 'a café terrace' }),
    call('draw.create', { text: 'nets on the quay' }),
  ]);
  const turns = runner({ answer, plan, images });
  const { result } = await withCapturedLogs(() =>
    turns.runTurn({
      channel: channel('d1', 'journal'),
      mode: 'selfreflection',
      selfreflection: { kind: 'photoset', forced: false },
    })
  );
  assert.equal(loose(result).outcome, 'spoke');
  assert.deepEqual(images.calls, [
    {
      prompt: `A drawing by Bot.\n\nBot has silver hair and a green scarf.\n\n${WHEN}\n\nScene: me at the harbour gate`,
      reference: AVATAR,
      accountId: null,
    },
    { prompt: `A drawing by Bot.\n\n${WHEN}\n\nScene: boats in the harbour`, reference: null, accountId: null },
    { prompt: `A drawing by Bot.\n\n${WHEN}\n\nScene: a café terrace`, reference: null, accountId: null },
    { prompt: `A drawing by Bot.\n\n${WHEN}\n\nScene: nets on the quay`, reference: null, accountId: null },
  ]);
});

// PR 7b: admin.run takes the operation's name, the command key map is gone; the expectations are as they were.
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
      reference: AVATAR,
      accountId: null,
    },
  ]);
});
