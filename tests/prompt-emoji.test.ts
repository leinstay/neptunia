// Custom emoji in the persona's turn (src/behavior/prompt.ts): no list since stage B8 of plan 2026-11-04-cli-and-memory, the
// interface's own line in `<senses>`, the description in the chat line, and the ranking the media pick took over.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankEmojiCandidates } from '../src/behavior/media-pick.ts';
import { userText as contentText } from '../src/behavior/prompt.ts';
import { labels } from './fixtures/labels.ts';
import { buildRequest, type Built } from './fixtures/built-request.ts';

const NOW = Date.UTC(2026, 8, 20, 10, 0, 0);

function fakeConfig(overrides: { caps?: object } = {}) {
  return {
    bot: { timezone: 'UTC' },
    context: {
      gapMarkerMinutes: 20,
      maxMessageChars: 800,
      caps: {
        interlocutor: 2500,
        aboutChat: 2500,
        people: 4000,
        neighbors: 3000,
        server: 2500,
        lore: 1500,
        ...overrides.caps,
      },
    },
    llm: { maxRequestTokens: 50000 },
    lore: { scanMessages: 30 },
    memory: {},
  };
}

function baseInput(overrides = {}) {
  return {
    config: fakeConfig(),
    prompts: {
      'system-prompt': 'SYSTEM',
      'character-card': 'CARD',
      rules: 'RULES',
      format: 'FORMAT',
      reply: 'REPLY_TASK',
      labels,
    },
    calibrator: { ratio: 1, apply: (n: number) => n },
    mode: 'reply',
    now: NOW,
    selfName: 'Nept',
    history: [
      {
        id: '1',
        ts: NOW - 60_000,
        authorId: 'a',
        authorName: 'Zoé',
        self: false,
        content: 'hi',
        attachments: [],
        stickers: [],
        replyToId: null,
      },
    ],
    neighbors: [],
    trigger: null,
    triggerKind: null,
    placeMemory: {},
    interlocutor: null,
    otherProfiles: [],
    ...overrides,
  };
}

const INDEX = [
  { id: '1', name: 'alpha', animated: false },
  { id: '2', name: 'beta', animated: true },
  { id: '3', name: 'gamma', animated: false },
  { id: '4', name: 'delta', animated: false },
];

function userText(request: Built) {
  return contentText(request.messages[1].content);
}

function emojiBlock(request: Built) {
  const match = /<emoji>\n([\s\S]*?)\n<\/emoji>/.exec(userText(request));
  return match ? match[1].split('\n') : null;
}

function sensesOf(request: Built) {
  const match = /<senses>\n([\s\S]*?)\n<\/senses>/.exec(userText(request));
  return match ? match[1] : '';
}

// B8: the ranking moved to the media pick's candidates, and these go on holding there.
const namesOf = (usage: object, cap = 30) => rankEmojiCandidates(INDEX, usage, cap).map((emoji) => emoji.name);

test('rankEmojiCandidates: skips a ranked emoji the server no longer has and uses its current name', () => {
  const names = namesOf({
    99: { name: 'gone', count: 50, last: NOW },
    2: { name: 'beta_old_name', count: 3, last: NOW },
  });
  assert.equal(names[0], 'beta');
  assert.ok(!names.includes('gone'));
});

test('rankEmojiCandidates: tops up a short ranking with the rest of the index, in index order', () => {
  assert.deepEqual(namesOf({ 4: { name: 'delta', count: 1, last: NOW } }), ['delta', 'alpha', 'beta', 'gamma']);
});

test('rankEmojiCandidates: falls back to the index order when nothing is ranked yet', () => {
  assert.deepEqual(namesOf({}), ['alpha', 'beta', 'gamma', 'delta']);
});

test('buildRequest: no <emoji> block, and the interface text only with an index', () => {
  const withIndex = buildRequest(baseInput({ customEmoji: INDEX, mediaPickText: 'ένα σημάδι' }));
  assert.equal(emojiBlock(withIndex), null);
  assert.ok(sensesOf(withIndex).split('\n').includes('ένα σημάδι'));
  const empty = buildRequest(baseInput({ customEmoji: [], mediaPickText: 'ένα σημάδι' }));
  assert.equal(emojiBlock(empty), null);
  assert.ok(!sensesOf(empty).includes('ένα σημάδι'));
  assert.equal(emojiBlock(buildRequest(baseInput())), null, 'no index passed at all');
});

// ---- a custom emoji of the chat is described once, in <emoji> ----------------

function chatLine(id: string, content: string, emojis: Array<unknown>, ts = NOW - 60_000) {
  return {
    id,
    ts,
    authorId: 'a',
    authorName: 'Zoé',
    self: false,
    content,
    attachments: [],
    stickers: [],
    emojis,
    replyToId: null,
  };
}

function chatBlock(request: Built) {
  const match = /<chat>\n([\s\S]*?)\n<\/chat>/.exec(userText(request));
  return match ? match[1] : '';
}

// B8: the line carries the description, because no block lists the emoji any more.
test('buildRequest: a chat line keeps the inline emojiDescribed tag, with an index and without', () => {
  const history = [chatLine('1', 'ωραίο :pog:', [{ id: '9', name: 'pog' }])];
  const descriptions = new Map([['emoji:9', 'a surprised cat face']]);
  const inline = 'Zoé: ωραίο :pog: [:pog: a surprised cat face]';
  for (const customEmoji of [[], INDEX]) {
    const lines = chatBlock(buildRequest(baseInput({ customEmoji, history, descriptions }))).split('\n');
    // Slice 2 (g): the tempo lines close `<chat>`, so the chat line is found among its lines, not at its end.
    assert.ok(
      lines.some((line) => line.endsWith(inline)),
      lines.join('\n')
    );
  }
});
