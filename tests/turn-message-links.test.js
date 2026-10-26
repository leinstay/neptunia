// Tests for the message links on the way out (src/behavior/turn.js with
// src/memory/mentions.ts#linkMessageNumbers) and, at the end, on the way in: a transcript number `#n` in a `<msg>` is sent as the
// jump link of that message, behind features.messageLinks. Fake discord.js-shaped objects, a fake
// LLM and store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { createTurnRunner } from '../src/behavior/turn.js';
import { labels } from './fixtures/labels.js';
import { createDiscordAdapter, createDiscordInterface } from '../interfaces/discord/index.js';

// The Discord interface's capabilities object, as src/index.js injects it.
const DISCORD = createDiscordInterface().capabilities;

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const MESSAGE_ID = '900000000000000001';

function rawMessage({ id, content = 'γεια' }) {
  return {
    id,
    channelId: 'c1',
    author: { id: 'u1', bot: false, globalName: 'Alice', username: 'Alice' },
    member: { displayName: 'Alice' },
    cleanContent: content,
    createdTimestamp: NOW - 1000,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

function normalizedTrigger(raw) {
  return {
    id: raw.id,
    channelId: raw.channelId,
    authorId: raw.author.id,
    authorName: raw.author.globalName,
    self: false,
    bot: false,
    content: raw.cleanContent,
    ts: raw.createdTimestamp,
    replyToId: null,
    attachments: [],
    stickers: [],
  };
}

function fakeTurnChannel(historyMessages, { dm = false } = {}) {
  const guild = { id: 'g1', members: { me: { displayName: 'Bot' } }, channels: { cache: new Map() } };
  const sent = [];
  const channel = {
    id: 'c1',
    name: 'chat',
    viewable: true,
    permissionsFor: () => ({ has: (flag) => flag !== PermissionFlagsBits.AttachFiles }),
    sendTyping: async () => {},
    send: async (payload) => {
      sent.push(payload);
      return { id: `sent-${sent.length}` };
    },
    messages: {
      cache: new Map(),
      fetch: async (arg) => {
        if (arg && typeof arg === 'object' && 'limit' in arg) return new Map(historyMessages.map((m) => [m.id, m]));
        throw new Error(`fixture message not found: ${arg}`);
      },
    },
    sent,
  };
  if (!dm) channel.guild = guild;
  return channel;
}

function fakeStore() {
  return {
    getGuild: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    getMediaCache: () => ({}),
    state: { data: {}, markDirty() {} },
  };
}

function fakeHot(messageLinks) {
  return {
    config: {
      bot: { timezone: 'UTC', dryRunChannelId: '' },
      context: {
        channelMessages: 100,
        neighborMessages: 5,
        neighborMaxAgeMinutes: 60,
        neighborMaxChannels: 8,
        maxMessageChars: 800,
        gapMarkerMinutes: 20,
        otherProfiles: 6,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: {
          maxImages: 2,
          tokensPerImage: 400,
          imageSize: 512,
          recentImages: 0,
          recentImageMinutes: 0,
          maxBytes: 1_500_000,
          fetchTimeoutMs: 10_000,
        },
        pull: { scanMessages: 20, maxChannels: 1, sameAudience: true },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features: {
        memory: true,
        multiMessage: true,
        typingSimulation: false,
        channelPull: false,
        channelRoute: false,
        elsewhere: false,
        messageLinks,
      },
      media: { maxPerTurn: 6, filePreviewChars: 500 },
      gifs: { maxPerDay: 40 },
    },
    prompts: {
      'system-prompt': 'You are a regular member of this chat, not an assistant.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      labels,
    },
  };
}

async function runLinkTurn(messageLinks, responseText, { dm = false } = {}) {
  const raw = rawMessage({ id: MESSAGE_ID });
  const channel = fakeTurnChannel([raw], { dm });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot(messageLinks),
    store: fakeStore(),
    llm: { complete: async () => ({ text: responseText, usage: {}, estimated: 10 }) },
    calibrator: { ratio: 1, apply: (n) => n, observe: () => {} },
    client: { user: { id: 'self-id', username: 'Bot' } },
  });
  const result = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(raw),
    triggerKind: 'mention',
    guildId: 'g1',
  });
  return { result, channel };
}

test('runTurn: a transcript number in the text becomes its message link', async () => {
  const { result, channel } = await runLinkTurn(true, '<msg>see #1 and #1, not #77 or x#1</msg>');
  assert.equal(result.outcome, 'spoke');
  const url = `https://discord.com/channels/g1/c1/${MESSAGE_ID}`;
  assert.equal(channel.sent[0].content, `see ${url} and ${url}, not #77 or x#1`);
});

test('runTurn: features.messageLinks false sends the number as written', async () => {
  const { channel } = await runLinkTurn(false, '<msg>see #1</msg>');
  assert.equal(channel.sent[0].content, 'see #1');
});

test('runTurn: a private chat links with @me instead of the guild id', async () => {
  const { channel } = await runLinkTurn(true, '<msg>see #1</msg>', { dm: true });
  assert.equal(channel.sent[0].content, `see https://discord.com/channels/@me/c1/${MESSAGE_ID}`);
});

// The other direction: a link in a message of the window to another message of the window reads as that message's
// number in the request, through the reference the Discord package put on the message.
test('runTurn: a message link in the window reads as the #n of the message it names', async () => {
  const first = rawMessage({ id: MESSAGE_ID, content: 'γεια' });
  const second = {
    ...rawMessage({ id: '900000000000000002', content: `see https://discord.com/channels/1/2/${MESSAGE_ID} please` }),
    createdTimestamp: NOW - 500,
  };
  const channel = fakeTurnChannel([first, second]);
  /** @type {string[]} */
  const requests = [];
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot(true),
    store: fakeStore(),
    llm: {
      complete: (/** @type {unknown} */ messages) => {
        requests.push(JSON.stringify(messages));
        return Promise.resolve({ text: '<skip/>', usage: {}, estimated: 10 });
      },
    },
    calibrator: { ratio: 1, apply: (/** @type {number} */ n) => n, observe: () => {} },
    client: { user: { id: 'self-id', username: 'Bot' } },
  });
  await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(second),
    triggerKind: 'mention',
    guildId: 'g1',
  });
  assert.equal(requests.length, 1);
  assert.ok(requests[0].includes('see #1 please'), 'the link is the number of the first line');
  assert.equal(requests[0].includes('discord.com/channels'), false, 'the address is not in the request');
});
