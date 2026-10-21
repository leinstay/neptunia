// One turn over the fakes of a core turn (a scripted model, a fake lookup and recall, a real admin), for the
// child process of tests/skills-no-command-table.test.js. The scene takes a module loader (`load(path)`: an
// import of `path` from the repository root) so it can run over another checkout's src/. Fakes only: no
// network, no data/, no prompts.local/.

import { labels } from './labels.js';
import { completionOf } from './tool-answers.js';

const NOW = Date.parse('2026-10-17T12:00:00Z');

/** A discord.js-shaped raw message of #general (c1). */
function rawMessage({ id, authorId = 'u1', authorName = 'Alice', ts = NOW - 1000, content = 'hey bot' }) {
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

function normalizedTrigger(raw) {
  return { id: raw.id, channelId: raw.channelId, authorId: raw.author.id, authorName: raw.author.globalName, self: false, bot: false, content: raw.cleanContent, ts: raw.createdTimestamp, replyToId: null, attachments: [], stickers: [] };
}

function fakeChannel(historyMessages) {
  const guild = { id: 'g1', members: { me: { displayName: 'Bot' } }, channels: { cache: new Map() } };
  return {
    id: 'c1',
    name: 'general',
    guild,
    viewable: true,
    permissionsFor: () => ({ has: () => true }),
    sendTyping: async () => {},
    send: async () => ({ id: 'sent' }),
    messages: {
      cache: new Map(),
      fetch: async (arg) => {
        if (arg && typeof arg === 'object' && 'limit' in arg) return new Map(historyMessages.map((m) => [m.id, m]));
        return historyMessages.find((m) => m.id === arg) ?? null;
      },
    },
  };
}

function fakeStore() {
  return {
    getGuild: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    countUsers: () => 0,
    getLore: () => [],
    getMediaCache: () => ({}),
    state: { data: {}, markDirty() {} },
  };
}

/** The live config and prompts of a scene: features.coreTools as `coreTools` (absent when undefined). */
function sceneHot({ coreTools, access = {} } = {}) {
  const features = {
    memory: true, reactions: true, multiMessage: true, typingSimulation: false, customEmoji: true, gifs: true,
    imageGeneration: true, channelPull: true, elsewhere: true, recent: true, videoRewatch: true, imageRelook: true,
    videoDescriptions: true, privateLikeServer: true,
    webLookup: true, recall: true,
  };
  if (coreTools !== undefined) features.coreTools = coreTools;
  return {
    config: {
      bot: { timezone: 'UTC', dryRunChannelId: '', owners: ['u1'], access },
      context: {
        channelMessages: 100, neighborMessages: 5, neighborMaxAgeMinutes: 60, neighborMaxChannels: 8, maxMessageChars: 800,
        gapMarkerMinutes: 20, otherProfiles: 6, caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0, maxBytes: 1_500_000, fetchTimeoutMs: 10_000 },
        pull: { scanMessages: 20, maxChannels: 1, sameAudience: true },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9, timeoutMs: 300_000, helperTimeoutMs: 25_000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features,
      models: { base: { analyzer: 'x/text' } },
      media: { maxPerTurn: 6, filePreviewChars: 500, video: { sites: ['youtube.com'] } },
      web: { maxPerDay: 60, links: { enabled: true, maxPerTurn: 2 }, search: { enabled: true, maxPerTurn: 1, contextMessages: 50 } },
      gifs: { maxPerDay: 40 },
      skills: { safeMode: false, resultMaxChars: 2000, loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 } },
    },
    prompts: {
      'system-prompt': 'You are a regular member of this chat, not an assistant.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      interject: 'Jump into the conversation.',
      initiate: 'Start a topic.',
      lookup: 'Decide whether {{name}} needs to look something up.\n{{skills}}',
      labels,
    },
  };
}

/** An LLM fake: the search classifier (its system prompt starts with "Decide whether") answers `classifier`, the turn `answers` in order. */
function sceneLlm({ classifier = 'none', answers = ['<msg>ok</msg>'] } = {}) {
  const requests = [];
  let turn = 0;
  return {
    requests,
    complete: async (messages) => {
      requests.push(messages);
      if (messages[0].content.startsWith('Decide whether')) return { text: classifier, usage: {}, estimated: 5 };
      const answer = answers[Math.min(turn, answers.length - 1)];
      turn += 1;
      return completionOf(answer);
    },
  };
}

function fakeLookup() {
  return {
    readLinks: async () => ({ reads: new Map(), newCount: 0 }),
    search: async (guildId, query) => ({ query, text: 'ευρήματα', sources: [{ title: 'Un', url: 'https://www.example.com/1', site: 'example.com' }] }),
    hasSearch: () => true,
  };
}

function fakeRecall() {
  return { available: () => true, run: async () => ({ stats: {}, text: 'Ana a tiré sur le lapin.', stretch: null, people: [] }) };
}

/**
 * One turn over the same fakes, with the skills on: `answers` are the persona's replies in order,
 * `access` the grants (a map name -> { everyone, roles, users }), `images` an optional image
 * client for a `draw.create` call. Returns the requests sent and the turn's result.
 */
export async function singleScene(load, { content = 'γεια', classifier = 'none', answers, access = {}, images = null } = {}) {
  const { createTurnRunner } = await load('src/behavior/turn.js');
  await load('src/ops/index.js');
  const { skillRegistry } = await load('src/skills/registry.js');
  const { createAdmin } = await load('src/admin.js');
  const { createDiscordAdapter, createDiscordInterface } = await load('src/interface/discord.js');
  const discord = createDiscordInterface().capabilities;
  const client = { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map() } };
  const history = [
    rawMessage({ id: 'm0', ts: NOW - 5000, authorId: 'u2', authorName: 'Zoë', content: 'καλημέρα' }),
    rawMessage({ id: 'm1', ts: NOW - 1000, content }),
  ];
  const hot = sceneHot({ coreTools: true, access });
  const store = fakeStore();
  const llm = sceneLlm({ classifier, answers });
  const admin = createAdmin({ discord, hot, store, client, getGuildId: () => 'g1' });
  const turns = createTurnRunner({
    discord, createPort: createDiscordAdapter, hot, store, llm, calibrator: { ratio: 1, apply: (n) => n, observe: () => {} }, client,
    lookup: fakeLookup(), recall: fakeRecall(), images, imageFetcher: { fetchAsDataUrl: async () => ({ dataUrl: 'data:image/png;base64,AAAA', bytes: 3, contentType: 'image/png' }) },
    skills: skillRegistry(), runOp: admin.runSkillOp, runOwnOp: admin.runOwnSkillOp, now: () => NOW,
  });
  const { result } = await turns.runTurn({ channel: fakeChannel(history), mode: 'reply', trigger: normalizedTrigger(history[1]), triggerKind: 'mention' }).then((result) => ({ result }));
  return { requests: JSON.parse(JSON.stringify(llm.requests)), result };
}
