// The "before" record of every picture the persona draws: the exact `{ prompt, reference,
// userId }` each call site hands to the image client (src/llm/images.js#createImageGen's
// `generate`) -- a reply turn's draw.create call, a diary post's single picture, a diary set's pictures,
// and `/nep draw` with `self`. Asserted at the image-client boundary only, with literal
// expectations: wherever the prompt building, the avatar fetch or the caps move, these calls must
// stay byte for byte the same. Fake clock, fake prompts and labels, a fake avatar reference, a
// fake discord.js-shaped channel; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner } from '../src/behavior/turn.js';
import { createAdmin } from '../src/admin.js';
import { familyOf } from '../src/llm/images.js';
import { createDiscordAdapter, createDiscordInterface } from '../src/interface/discord.js';
import { labels as baseLabels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { call, completionOf, toolAnswer } from './fixtures/tool-answers.js';

// The Discord interface's capabilities object, as src/index.js injects it.
const DISCORD = createDiscordInterface().capabilities;

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
  diary: 'DIARY_TASK for {{name}}',
  'diary-plan': 'PLAN_SYSTEM for {{name}}',
  'diary-seeds': '# place\na pier\n# light\nfog',
  draw: 'A drawing by {{name}}.\n\n{{appearance}}\n\n{{when}}\n\nScene: {{request}}',
  appearance: '{{name}} has silver hair and a green scarf.',
  labels: LABELS,
};

const SWITCHES = {
  memory: true,
  reactions: true,
  multiMessage: true,
  typingSimulation: false,
  customEmoji: true,
  gifs: false,
  imageGeneration: true,
  channelPull: false,
  recent: true,
  vision: true,
  diary: true,
};

function hot() {
  return {
    config: {
      bot: { timezone: TZ, dryRunChannelId: '', owners: ['42'] },
      context: {
        channelMessages: 50,
        neighborMessages: 5,
        neighborMaxAgeMinutes: 60,
        neighborMaxChannels: 8,
        maxMessageChars: 800,
        gapMarkerMinutes: 20,
        otherProfiles: 6,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0, maxBytes: 1_500_000, fetchTimeoutMs: 7000 },
        pull: { scanMessages: 20, maxChannels: 1, sameAudience: true },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      models: { base: { drawing: 'openai/image-model' } },
      typing: { reactionDelayMs: [0, 0], msPerChar: [0, 0], minMs: 0, maxMs: 0, betweenMessagesMs: [0, 0] },
      features: { ...SWITCHES },
      media: { maxPerTurn: 6, filePreviewChars: 500 },
      gifs: { maxPerDay: 40 },
      image: { maxPromptChars: 1000, reference: 'avatar', referenceMaxBytes: 4_000_000 },
      diary: {
        channelId: 'd1',
        world: false,
        maxPicturesPerDay: 30,
        maxMessages: 3,
        historyPosts: 40,
        gistChars: 60,
        seedSets: 1,
        kinds: { selfPicture: 1, tour: 1 },
        searchKinds: [],
        pictureKinds: ['selfPicture', 'tour'],
        setKinds: ['tour'],
        set: { pictures: [3, 3], minPosted: 2, seedSets: 1, maxMessageBytes: 8_000_000 },
        planMaxOutputTokens: 250,
        planTimeoutMs: 15000,
      },
    },
    prompts: { ...PROMPTS },
  };
}

/** A discord.js-shaped text channel with every permission; `history` its raw messages. */
function channel(id, name, history = []) {
  const sent = [];
  return {
    id,
    name,
    guild: { id: 'g1', members: { me: { displayName: 'Bot' } }, channels: { cache: new Map() } },
    viewable: true,
    permissionsFor: () => ({ has: () => true }),
    sendTyping: async () => {},
    send: async (payload) => {
      sent.push(payload);
      return { id: `sent-${id}-${sent.length}` };
    },
    messages: {
      cache: new Map(),
      fetch: async (arg) => {
        if (arg && typeof arg === 'object' && 'limit' in arg) return new Map(history.map((m) => [m.id, m]));
        return { react: async () => {} };
      },
    },
    sent,
  };
}

/** A member's message as discord.js hands it over. */
function rawMessage({ id, authorId, authorName, content, ts }) {
  return {
    id,
    channelId: 'c1',
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

/** The bot user and the served guild, with an avatar URL. */
function client() {
  const guild = { id: 'g1', name: 'The Server', members: { me: { displayName: 'Bot' } } };
  return {
    user: { id: 'self-id', username: 'Bot', displayAvatarURL: () => 'https://cdn.example/avatar.png' },
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
  const calls = [];
  return {
    calls,
    familyOf,
    quota: () => ({ used: 0, cap: 50, userUsed: 0, userCap: 5, spent: false, userSpent: false }),
    generate: async (args) => {
      calls.push(structuredClone(args));
      return { buffer: Buffer.from('png'), mediaType: 'image/png', seconds: 1, cost: 0, usage: {}, model: 'openai/image-model' };
    },
  };
}

function store() {
  return {
    getGuild: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    getMediaCache: () => ({}),
    getDiary: () => ({ posts: [], updatedAt: 0 }),
    appendDiaryPost: () => ({ dropped: [] }),
    state: { data: {}, markDirty() {} },
  };
}

/** An LLM answering the diary plan with `plan` and every other request with `post`. */
function llm(post, plan = null) {
  let composed = 0;
  return {
    complete: async (_messages, opts) => {
      if (opts?.purpose === 'diary-plan') return { text: JSON.stringify(plan), usage: {}, estimated: 5 };
      const answer = Array.isArray(post) ? post[Math.min(composed, post.length - 1)] : post;
      composed += 1;
      return completionOf(answer);
    },
  };
}

function runner({ answer, plan = null, images }) {
  return createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: hot(),
    store: store(),
    llm: llm(answer, plan),
    calibrator: { ratio: 1, apply: (n) => n, observe: () => {} },
    client: client(),
    images,
    imageFetcher: imageFetcher(),
    lookup: null,
    rng: () => 0.5,
    now: () => NOW,
  });
}

test('draw parity: a reply turn\'s draw.create call asked by a member', async () => {
  const images = recordingImages();
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Eléna', content: 'draw a lighthouse', ts: NOW - 1000 });
  const trigger = {
    id: raw.id, channelId: raw.channelId, authorId: 'u1', authorName: 'Eléna', self: false, bot: false,
    content: raw.cleanContent, ts: raw.createdTimestamp, replyToId: null, attachments: [], stickers: [],
  };
  const turns = runner({ answer: toolAnswer('<msg>one sec</msg>', [call('draw.create', { reply: '#1', text: 'a lighthouse at dusk, waves below' })]), images });
  const { result } = await withCapturedLogs(() => turns.runTurn({ channel: channel('c1', 'general', [raw]), mode: 'reply', trigger, triggerKind: 'mention' }));
  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(images.calls, [
    {
      prompt: `A drawing by Bot.\n\n${WHEN}\n\nScene: a lighthouse at dusk, waves below`,
      reference: null,
      userId: 'u1',
    },
  ]);
});

test('draw parity: a diary post\'s single self picture', async () => {
  const images = recordingImages();
  const plan = { kind: 'selfPicture', brief: 'a pier at dawn', search: '', picture: true };
  const turns = runner({ answer: toolAnswer('<msg>early start</msg>', [call('draw.create', { text: 'me on a pier at dawn, fog', self: true })]), plan, images });
  const { result } = await withCapturedLogs(() => turns.runTurn({ channel: channel('d1', 'journal'), mode: 'diary', diary: { kind: null, forced: false } }));
  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(images.calls, [
    {
      prompt: `A drawing by Bot.\n\nBot has silver hair and a green scarf.\n\n${WHEN}\n\nScene: me on a pier at dawn, fog`,
      reference: AVATAR,
      userId: null,
    },
  ]);
});

test('draw parity: a diary set\'s pictures, the persona in the first one only', async () => {
  const images = recordingImages();
  const plan = { kind: 'tour', brief: 'a harbour walk', search: '', picture: true };
  const answer = toolAnswer('<msg>a walk</msg>', [call('draw.create', { text: 'me at the harbour gate', self: true }), call('draw.create', { text: 'boats in the harbour' }), call('draw.create', { text: 'a café terrace' })]);
  const turns = runner({ answer, plan, images });
  const { result } = await withCapturedLogs(() => turns.runTurn({ channel: channel('d1', 'journal'), mode: 'diary', diary: { kind: null, forced: false } }));
  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(images.calls, [
    {
      prompt: `A drawing by Bot.\n\nBot has silver hair and a green scarf.\n\n${WHEN}\n\nScene: me at the harbour gate`,
      reference: AVATAR,
      userId: null,
    },
    { prompt: `A drawing by Bot.\n\n${WHEN}\n\nScene: boats in the harbour`, reference: null, userId: null },
    { prompt: `A drawing by Bot.\n\n${WHEN}\n\nScene: a café terrace`, reference: null, userId: null },
  ]);
});

test('draw parity: /nep draw with self', async () => {
  const images = recordingImages();
  const admin = createAdmin({
    discord: DISCORD,
    hot: hot(),
    store: store(),
    client: client(),
    spontaneous: {},
    calibrator: { ratio: 1 },
    getGuildId: () => 'g1',
    images,
    imageFetcher: imageFetcher(),
    now: () => NOW,
  });
  const { result } = await withCapturedLogs(() => admin.run('draw', { text: 'me reading by the window', self: true }, { guildId: 'g1', userId: '42' }));
  assert.equal(result.files.length, 1);
  // The owner's command carries no local time: its `{{when}}` is blank.
  assert.deepEqual(images.calls, [
    {
      prompt: 'A drawing by Bot.\n\nBot has silver hair and a green scarf.\n\nScene: me reading by the window',
      reference: AVATAR,
      userId: null,
    },
  ]);
});
