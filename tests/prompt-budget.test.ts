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

// --- slice 8 of the turn frame: the chat window trims in steps (`context.chatSteps`) ----------------------------------

/** A reply over `count` chat lines of one length, the newest the trigger, under `maxRequestTokens` and `chatSteps`. */
function chatInput(count: number, maxRequestTokens: number, chatSteps: Array<number>) {
  const lines = Array.from({ length: count }, (_, i) => ({
    id: String(1000 + i),
    ts: NOW - (count - i) * 60_000,
    authorId: i % 2 === 0 ? 'a' : 'b',
    authorName: i % 2 === 0 ? 'Zoé' : 'Ελένη',
    self: false,
    content: `γραμμή ${1000 + i} με λίγες λέξεις για το μέτρημα`,
    attachments: [],
    stickers: [],
    replyToId: null,
  }));
  const base = input();
  const trigger = lines[lines.length - 1];
  const config = {
    ...base.config,
    context: { ...base.config.context, chatSteps },
    llm: { ...base.config.llm, maxRequestTokens },
  };
  const loose = { ...base, config, history: lines, trigger };
  return { ...loose, frame: frameOfInput(loose) };
}

/** The request cap under which a request of 70 lines keeps about `share` of its chat lines when nothing cuts them in steps. */
function capKeeping(share: number, chatSteps: Array<number>): number {
  const roomy = buildRequest(chatInput(70, 200_000, chatSteps));
  const chat = roomy.stats.chat as { used: number; kept: number };
  assert.equal(chat.kept, 70, 'the roomy request keeps every line');
  const rest = roomy.stats.used - chat.used;
  return Math.ceil((rest + Math.floor(chat.used * share) + TAG_OVERHEAD) / 0.9);
}

test('buildRequest: a chat cut lands on the nearest lower step of context.chatSteps, never between two steps', () => {
  // Bug: a cut to whatever fits moves the kept window by one line per turn, so no two turns share a cached chat.
  const steps = [100, 60, 30, 10];
  const request = buildRequest(chatInput(70, capKeeping(45 / 70, steps), steps));
  assert.equal((request.stats.chat as { kept: number }).kept, 30);
});

test('buildRequest: the chat steps are read from the setting at the moment of use', () => {
  // Bug: steps hard-coded in the budget ignore an owner's context.chatSteps.
  const steps = [50, 20];
  const request = buildRequest(chatInput(70, capKeeping(45 / 70, steps), steps));
  assert.equal((request.stats.chat as { kept: number }).kept, 20);
});
