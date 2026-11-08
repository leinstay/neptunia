// Tests for the channel links on the way out (src/behavior/turn.ts with
// src/memory/mentions.ts#linkChannels): a `#name` of one of the guild's text
// channels in a `<msg>` is sent as the `<#id>` link.
// Fake discord.js-shaped objects, a fake LLM and store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleOf } from '../src/behavior/handles.ts';
import { labels } from './fixtures/labels.ts';
import { world } from './fixtures/turn-world.ts';
import { createTurnRunner } from './fixtures/turn-runner.ts';

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const LINKED_ID = '323456789012345678';

function rawMessage({ id, content = 'γεια' }: { id: string; content?: string }) {
  return {
    id,
    placeId: 'c1',
    author: { id: 'u1', bot: false, globalName: 'Alice', username: 'Alice' },
    member: { displayName: 'Alice' },
    cleanContent: content,
    createdTimestamp: NOW - 1000,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

function normalizedTrigger(raw: ReturnType<typeof rawMessage>) {
  return {
    id: raw.id,
    placeId: raw.placeId,
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

/** A guild channel whose guild knows one text channel `γενικά`, which she cannot read (no neighbour reads); the non-text `φωνή` is no chat. */
function fakeTurnChannel(historyMessages: Array<Record<string, unknown>>) {
  world().channel({ id: LINKED_ID, name: 'γενικά', permissions: { read: false } });
  return world().channel({ id: 'c1', name: 'chat', placeId: 'g1', historyMessages, permissions: { attach: false } });
}

function fakeLlm(responseText: string) {
  return { complete: async () => ({ text: responseText, usage: {}, estimated: 10 }) };
}

function fakeStore() {
  return {
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    getMediaCache: () => ({}),
    state: { data: {}, markDirty() {} },
  };
}

function fakeHot() {
  return {
    config: {
      bot: { timezone: 'UTC' },
      context: {
        channelMessages: 100,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { fetchTimeoutMs: 10_000 },
        pull: { sameAudience: true },
      },
      llm: { maxRequestTokens: 50000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
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

async function runLinkTurn(answer = '<msg>δες στο #γενικά και στο #φωνή</msg>') {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel([raw]);
  const turns = createTurnRunner({
    hot: fakeHot(),
    store: fakeStore(),
    llm: fakeLlm(answer),
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
  });
  const result = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(raw),
    triggerKind: 'mention',
  });
  return { result, channel };
}

test('runTurn: a #name of a guild text channel is sent as its <#id> link', async () => {
  const { result, channel } = await runLinkTurn();
  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, `δες στο <#${LINKED_ID}> και στο #φωνή`);
});

test('runTurn: a URL in a <msg> is posted exactly as written; a #name and an @handle outside it still turn into links', async () => {
  const handle = handleOf('u1');
  const url = `https://www.youtube.com/@${handle}/#γενικά?si=Ab_9&t=5`;
  const { result, channel } = await runLinkTurn(`<msg>@${handle} δες ${url} στο #γενικά</msg>`);
  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent[0].content, `<@u1> δες ${url} στο <#${LINKED_ID}>`);
});

test('runTurn: a #handle of a guild text channel the request did not show is still sent as its <#id> link', async () => {
  // Bug: a handle she carries over from an earlier request (an intention, her last think) went out as plain text,
  // because only the channels of this request were in the handle map.
  const handle = handleOf(LINKED_ID, 4, 'c');
  const { result, channel } = await runLinkTurn(`<msg>δες στο #${handle}</msg>`);
  assert.equal(result.outcome, 'spoke');
  const [sent] = channel.sent;
  assert.equal(sent.content, `δες στο <#${LINKED_ID}>`);
});

test('runTurn: an @handle of a known member who wrote nothing in the chat is still sent as a mention', async () => {
  // Bug: a member's handle she carries over from an earlier request went out as plain `@handle`, because only the
  // authors of this request's lines were in the handle map.
  const turns = createTurnRunner({
    hot: fakeHot(),
    store: { ...fakeStore(), listUserProfiles: () => [{ id: 'u7', names: ['Zoe'], aliases: [] }] },
    llm: fakeLlm(`<msg>@${handleOf('u7')} έτοιμο</msg>`),
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
  });
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel([raw]);
  const result = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(raw),
    triggerKind: 'mention',
  });
  assert.equal(result.outcome, 'spoke');
  const [sent] = channel.sent;
  assert.equal(sent.content, '<@u7> έτοιμο');
  assert.deepEqual(sent.allowedMentions, { parse: [], users: ['u7'], repliedUser: true });
});
