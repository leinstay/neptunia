// Tests for the channel links on the way out (src/behavior/turn.js with
// src/memory/mentions.js#linkChannels): a `#name` of one of the guild's text
// channels in a `<msg>` is sent as the `<#id>` link, behind
// features.channelLinks. Fake discord.js-shaped objects, a fake LLM and store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { createTurnRunner } from '../src/behavior/turn.js';
import { handleOf } from '../src/behavior/handles.js';
import { labels } from './fixtures/labels.js';

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const LINKED_ID = '323456789012345678';
const VOICE_ID = '423456789012345678';

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

/** A guild channel whose guild knows one text channel `γενικά` and one non-text channel `φωνή`, neither viewable (no neighbour reads). */
function fakeTurnChannel(historyMessages) {
  const guildChannels = new Map([
    [LINKED_ID, { id: LINKED_ID, name: 'γενικά', isTextBased: () => true, isThread: () => false, viewable: false }],
    [VOICE_ID, { id: VOICE_ID, name: 'φωνή', isTextBased: () => false, isThread: () => false, viewable: false }],
  ]);
  const guild = { id: 'g1', members: { me: { displayName: 'Bot' } }, channels: { cache: guildChannels } };
  const sent = [];
  return {
    id: 'c1',
    name: 'chat',
    guild,
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
}

function fakeLlm(responseText) {
  return { complete: async () => ({ text: responseText, usage: {}, estimated: 10 }) };
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

function fakeHot(channelLinks) {
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
        vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0, maxBytes: 1_500_000, fetchTimeoutMs: 10_000 },
        pull: { scanMessages: 20, maxChannels: 1, sameAudience: true },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features: { memory: true, multiMessage: true, typingSimulation: false, channelPull: false, channelRoute: false, elsewhere: false, channelLinks },
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

async function runLinkTurn(channelLinks, answer = '<msg>δες στο #γενικά και στο #φωνή</msg>') {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel([raw]);
  const turns = createTurnRunner({
    hot: fakeHot(channelLinks),
    store: fakeStore(),
    llm: fakeLlm(answer),
    calibrator: { ratio: 1, apply: (n) => n, observe: () => {} },
    client: { user: { id: 'self-id', username: 'Bot' } },
  });
  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
  return { result, channel };
}

test('runTurn: a #name of a guild text channel is sent as its <#id> link', async () => {
  const { result, channel } = await runLinkTurn(true);
  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, `δες στο <#${LINKED_ID}> και στο #φωνή`);
});

test('runTurn: features.channelLinks false sends #name as written', async () => {
  const { result, channel } = await runLinkTurn(false);
  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent[0].content, 'δες στο #γενικά και στο #φωνή');
});

test('runTurn: a URL in a <msg> is posted exactly as written; a #name and an @handle outside it still turn into links', async () => {
  const handle = handleOf('u1');
  const url = `https://www.youtube.com/@${handle}/#γενικά?si=Ab_9&t=5`;
  const { result, channel } = await runLinkTurn(true, `<msg>@${handle} δες ${url} στο #γενικά</msg>`);
  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent[0].content, `<@u1> δες ${url} στο <#${LINKED_ID}>`);
});
