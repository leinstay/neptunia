// The drawing agent at its call sites, with the errand service in place (stage 3b): the turn's
// draw.create call, a diary set and `/nep draw` each make their pictures through `errands.runInline` as
// task records of the drawing agent (src/errands/tools.js), and the agent's daily caps refuse a
// picture with the limit behaviour of an image cap (the notice for a member who asked, the end of
// a set's generation, `draw failed` for the command). The image client stays the injected
// boundary: its calls are asserted byte for byte in tests/draw-parity.test.js, which has no
// errand service. Fake clock, prompts, labels, avatar and channel; a real task store in a temp
// directory; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner } from '../src/behavior/turn.js';
import { createAdmin } from '../src/admin.js';
import '../src/ops/index.js';
import { skillRegistry } from '../src/skills/registry.js';
import { familyOf } from '../src/llm/images.js';
import { createDiscordAdapter, createDiscordInterface } from '../src/interface/discord.js';
import { labels as baseLabels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { call, completionOf, toolAnswer } from './fixtures/tool-answers.js';
import fs from 'node:fs';
import path from 'node:path';
import { createTaskStores } from '../src/errands/store.js';
import { createErrandService } from '../src/errands/service.js';
import { tempDir } from './fixtures/tmp.js';

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

function runner({ answer, plan = null, images, errands = null, hotValue = hot() }) {
  return createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: hotValue,
    errands,
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

/** The errand service over a real task store in a temp directory, on `hotValue`'s config. */
function errandsOf(hotValue) {
  const dataDir = tempDir('nep-draw-agent-');
  const stores = createTaskStores({ dataDir, config: () => hotValue.config, now: () => NOW });
  const errands = createErrandService({ client: { configured: () => true }, stores, hot: hotValue, getGuildId: () => 'g1', now: () => NOW });
  const records = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataDir, 'guilds', 'g1', 'tasks.json'), 'utf8')).tasks;
    } catch {
      return [];
    }
  };
  return { errands, records };
}

function memberTrigger() {
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Eléna', content: 'draw a lighthouse', ts: NOW - 1000 });
  const trigger = {
    id: raw.id, channelId: raw.channelId, authorId: 'u1', authorName: 'Eléna', self: false, bot: false,
    content: raw.cleanContent, ts: raw.createdTimestamp, replyToId: null, attachments: [], stickers: [],
  };
  return { raw, trigger };
}

test('draw agent: a diary set is recorded picture by picture; the avatar is fetched once; the caps end the set like an image cap and the rest is posted', async () => {
  const images = recordingImages();
  const hotValue = hot();
  hotValue.config.agents = { drawing: { daily: { tasks: 2 } } };
  const { errands, records } = errandsOf(hotValue);
  const plan = { kind: 'tour', brief: 'a harbour walk', search: '', picture: true };
  const answer = [
    toolAnswer('<msg>a walk</msg>', [call('draw.create', { text: 'me at the harbour gate', self: true }), call('draw.create', { text: 'boats in the harbour' }), call('draw.create', { text: 'a café terrace' })]),
    '<msg>a walk, two pictures</msg>',
  ];
  const target = channel('d1', 'journal');
  const { result, logs } = await withCapturedLogs(() => runner({ answer, plan, images, errands, hotValue }).runTurn({ channel: target, mode: 'diary', diary: { kind: null, forced: false } }));
  assert.equal(result.outcome, 'spoke');
  assert.equal(images.calls.length, 2, 'the third picture was refused before it started');
  assert.deepEqual(images.calls.map((call) => call.reference), [AVATAR, null]);
  assert.deepEqual(records().map((task) => [task.agent, task.state, task.requester.kind]), [['drawing', 'done', 'persona'], ['drawing', 'done', 'persona']]);
  const refused = logs.find((l) => l.msg === 'turn: draw refused by a limit');
  assert.deepEqual([refused.key, refused.asked], ['agents.drawing.daily.tasks', false]);
  assert.equal(target.sent.at(-1).files.length, 2, 'what came out is posted (diary.set.minPosted is 2)');
});

test('draw agent: /nep draw is recorded as the owner\'s picture; a cap makes the command fail with the image cap\'s words', async () => {
  const images = recordingImages();
  const hotValue = hot();
  const { errands, records } = errandsOf(hotValue);
  const admin = (value, service) => createAdmin({
    discord: DISCORD, hot: value, store: store(), client: client(), spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1', images, imageFetcher: imageFetcher(), errands: service, now: () => NOW,
  });
  const ctx = { guildId: 'g1', userId: '42' };
  const { result } = await withCapturedLogs(() => admin(hotValue, errands).run('draw', { text: 'me reading by the window', self: true }, ctx));
  assert.equal(result.files.length, 1);
  assert.equal(images.calls[0].prompt, 'A drawing by Bot.\n\nBot has silver hair and a green scarf.\n\nScene: me reading by the window');
  assert.deepEqual(records().map((task) => [task.agent, task.state, task.requester.kind, task.seen]), [['drawing', 'done', 'owner', true]]);

  const capped = hot();
  capped.config.agents = { drawing: { daily: { tasks: 0 } } };
  const refused = errandsOf(capped);
  const { result: outcome } = await withCapturedLogs(async () => {
    try {
      return await admin(capped, refused.errands).run('draw', { text: 'again' }, ctx);
    } catch (err) {
      return err;
    }
  });
  assert.match(String(outcome?.message ?? outcome?.summary ?? JSON.stringify(outcome)), /draw failed \(daily\)/);
  assert.equal(images.calls.length, 1, 'nothing was generated');
});

test('draw agent: a member\'s draw.create call is made by the turn itself and recorded as a task of the drawing agent, the member as its requester; a cap comes back as a result, with no notice', async () => {
  const hotValue = hot();
  hotValue.config.bot.access = { 'draw.create': { everyone: false, roles: [], users: ['self-id'] } };
  hotValue.config.skills = { safeMode: false, resultMaxChars: 2000, callTimeoutMs: 120000 };
  const make = (agents) => {
    const hotCase = structuredClone(hotValue);
    hotCase.prompts = { ...PROMPTS };
    if (agents) hotCase.config.agents = agents;
    return hotCase;
  };
  for (const [agents, expected] of [[null, 'ok'], [{ drawing: { daily: { tasks: 0 } } }, 'image-cap-daily']]) {
    const images = recordingImages();
    const hotCase = make(agents);
    const { errands, records } = errandsOf(hotCase);
    const { raw, trigger } = memberTrigger();
    const target = channel('c1', 'general', [raw]);
    const turns = createTurnRunner({
      discord: DISCORD,
      createPort: createDiscordAdapter,
      hot: hotCase,
      errands,
      store: store(),
      llm: llm(toolAnswer('', [call('draw.create', { text: 'a lighthouse at dusk' })])),
      calibrator: { ratio: 1, apply: (n) => n, observe: () => {} },
      client: client(),
      images,
      imageFetcher: imageFetcher(),
      lookup: null,
      rng: () => 0.5,
      now: () => NOW,
      skills: skillRegistry(),
      runOp: createAdmin({ discord: DISCORD, hot: hotCase, store: store(), client: client(), getGuildId: () => 'g1', errands }).runSkillOp,
    });
    const { logs } = await withCapturedLogs(() => turns.runTurn({ channel: target, mode: 'reply', trigger, triggerKind: 'mention' }));
    const called = logs.find((l) => l.msg === 'skills: called' && l.skill === 'draw.create');
    assert.ok(called, JSON.stringify(logs.filter((l) => /skill/.test(l.msg))));
    assert.equal(called.code ?? 'ok', expected);
    if (expected === 'ok') {
      assert.equal(images.calls[0].userId, 'u1');
      assert.ok(target.sent.some((payload) => payload.files?.length === 1), 'the picture was posted');
      assert.deepEqual(records().map((task) => [task.agent, task.state, task.requester]), [['drawing', 'done', { userId: 'u1', kind: 'member' }]]);
    } else {
      assert.equal(images.calls.length, 0);
      assert.equal(target.sent.length, 0, 'no limit notice');
    }
  }
});

test('draw agent: the draw.create operation quotes the message it replies to, in that message\'s channel (a link) and refuses a channel that disagrees', async () => {
  const { createFakeAdapter } = await import('../src/interface/fake.js');
  const hotValue = hot();
  const { errands } = errandsOf(hotValue);
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
  port.seed('c1', { authorId: 'u1', messageId: 'm9', text: 'a lighthouse?' });
  const admin = createAdmin({
    discord: DISCORD, hot: hotValue, store: store(), client: client(), spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1', images: recordingImages(), imageFetcher: imageFetcher(), errands, now: () => NOW, port,
  });
  const ctx = { guildId: 'g1', channelId: 'c1', userId: '42', roleIds: [], actor: 'owner' };
  const quoted = (await withCapturedLogs(() => admin.runSkillOp('draw.create', { text: 'a lighthouse', replyTo: 'm9' }, ctx))).result;
  assert.equal(quoted.status ?? 'ok', 'ok', JSON.stringify(quoted));
  const sent = port.calls.find((call) => call.op === 'send');
  assert.deepEqual([sent.args[0].conversationId, sent.args[1].replyTo.conversationId, sent.args[1].replyTo.messageId], ['c1', 'c1', 'm9']);
  const refused = await admin.runSkillOp('draw.create', { text: 'a lighthouse', replyTo: 'https://discord.com/channels/g1/c1/m9', channelId: 'c2' }, ctx);
  assert.equal(refused.status, 'invalid');
  assert.equal(refused.code, 'unknown-message');
});
