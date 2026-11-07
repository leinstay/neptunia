// The token limit buildRequest (src/behavior/prompt.ts) fits a request under: 0.9 of the request cap
// (src/llm/budget.ts#requestTokenLimit, SAFETY_MARGIN); a picture in the chat
// reserves nothing (none is attached, the persona reads its caption).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labels } from './fixtures/labels.ts';
import { buildRequest, type Part } from './fixtures/built-request.ts';
import { frameOfInput } from './fixtures/prompt-rig.ts';

const NOW = Date.UTC(2026, 8, 20, 10, 0, 0);
// prompt.js keeps this many tokens for the tags around the blocks.
const TAG_OVERHEAD = 60;

function input({ llm = {}, vision = {}, picture = false } = {}) {
  const trigger = {
    id: '1',
    ts: NOW - 60_000,
    authorId: 'a',
    authorName: 'Zoé',
    self: false,
    content: 'regarde',
    attachments: picture ? [{ id: 'p1', kind: 'image', name: 'photo.png', url: 'https://cdn.example/photo.png' }] : [],
    stickers: [],
    replyToId: null,
  };
  const base = {
    config: {
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
          pulled: 4000,
        },
        vision: { ...vision },
      },
      features: {},
      llm: { maxRequestTokens: 50000, ...llm },
      lore: { scanMessages: 30 },
      memory: {},
    },
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
    history: [trigger],
    neighbors: [],
    trigger,
    triggerKind: 'mention',
    placeMemory: {},
    interlocutor: null,
    otherProfiles: [],
  };
  // Every request is built on its turn frame (slice 7).
  return { ...base, frame: frameOfInput(base) };
}

test('buildRequest: a picture in the chat reserves nothing of the budget -- it is never attached, whatever tokensPerImage says', () => {
  const withPicture = buildRequest(input({ vision: { tokensPerImage: 1000 }, picture: true }));
  assert.equal(withPicture.stats.limit, Math.floor(50000 * 0.9) - TAG_OVERHEAD);
  assert.ok(withPicture.messages[1].content.every((part: Part) => part.type === 'text'));
  assert.equal('images' in withPicture.stats, false);
});
