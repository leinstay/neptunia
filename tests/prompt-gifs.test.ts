// The transcript's GIF handles of buildRequest (src/behavior/prompt.ts), a turn that carries no GIF library, and the
// line of a library GIF media.find writes (src/behavior/prompt.ts#gifLine). Stage B7 of plan 2026-11-04-cli-and-memory
// took `<gifs>`, `<gifs_recent>` and `senses.gifs` out of the turn: the tests of that block's order, cap and own-post mark
// went with it, and the candidate list has its tests in tests/media-pick.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gifLine, userText as contentText } from '../src/behavior/prompt.ts';
import { rankGifs } from '../src/memory/gifs.ts';
import { labels } from './fixtures/labels.ts';
import { frameOfInput } from './fixtures/prompt-rig.ts';
import { buildRequest } from './fixtures/built-request.ts';
import type { Built } from './fixtures/built-request.ts';

const NOW = Date.UTC(2026, 8, 20, 10, 0, 0);
const DAY = 86_400_000;

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
    // PR 7d: the GIF list's measures are constants (25 entries, 24 hours of own posts).
    llm: { maxRequestTokens: 50000 },
    lore: { scanMessages: 30 },
    memory: {},
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  const input = {
    config: fakeConfig(),
    prompts: {
      main: 'SYSTEM',
      persona: 'CARD',
      rules: 'RULES',
      format: 'FORMAT',
      'turn/reply': 'REPLY_TASK',
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
  // Every request is built on its turn frame (slice 7).
  return { ...input, frame: frameOfInput(input) };
}

/** A library entry: a link GIF keyed `k<n>` with handle `g<n>`. */
function linkEntry(n: number, count: number, last = NOW - DAY) {
  return {
    id: `g${n}`,
    kind: 'link',
    url: `https://tenor.com/view/gif-${n}`,
    site: 'Tenor',
    name: `Danse ${n}`,
    itemId: `k${n}`,
    messageId: `m${n}`,
    placeId: 'c1',
    count,
    last,
    firstSeen: last,
  };
}

function library(entries: Array<{ itemId: string; [key: string]: unknown }>, nextId = 100) {
  return { nextId, entries: Object.fromEntries(entries.map((entry) => [entry.itemId, entry])), backfill: null };
}

function userText(request: Built) {
  return contentText(request.messages[1].content);
}

/** B7: the lines media.find writes, in rank order: the same line a GIF's entry always had. */
function findLines(gifs: unknown, mediaCache: object | undefined, given: Record<string, unknown> = labels) {
  return rankGifs(gifs, 30).map((entry) => gifLine(entry, mediaCache, given, { ownMarkHours: 0, now: 0 }));
}

const THREE = library([linkEntry(1, 2), linkEntry(2, 9), linkEntry(3, 5)]);

// PR 7d: `gifs.max` is the constant 25, so the library holds 26 entries.
test("gifLine: the cached caption under the entry's itemId, entryNoText otherwise", () => {
  const mediaCache = {
    k2: { text: 'a cat dancing on a ὄρνις', ts: NOW },
    k3: { miss: 'error', ts: NOW },
  };
  const lines = findLines(THREE, mediaCache);
  assert.deepEqual(lines, ['g2 -- a cat dancing on a ὄρνις', 'g3', 'g1']);
});

/** A full-sentence caption of about 190 characters, the shape the describer stores. */
function longCaption(n: number) {
  return `Un chat roux numéro ${n} danse sur une table de cuisine en agitant les pattes, puis il glisse lentement et tombe sur le dos pendant que quelqu'un rit derrière la caméra du téléphone.`;
}

// The owner on 2026-11-17: a GIF is shown whole in its line; the cut at 70 characters goes.
test('gifLine: a 190-character caption is shown whole, with no ellipsis', () => {
  const caption = longCaption(2);
  const mediaCache = { k2: { text: caption, ts: NOW, watched: true, gif: true } };
  const lines = findLines(THREE, mediaCache);
  assert.equal(lines[0], `g2 -- ${caption}`);
});

test('buildRequest: a library gif in the chat carries its handle; a reposted link is matched by its url', () => {
  const history = [
    {
      ...baseInput().history[0],
      links: [{ id: 'k2', kind: 'gif', url: 'https://tenor.com/view/gif-2', site: 'Tenor', title: 'Danse 2' }],
    },
    {
      ...baseInput().history[0],
      id: '2',
      links: [{ id: '2#e0', kind: 'gif', url: 'https://tenor.com/view/gif-3', site: 'Tenor', title: 'Danse 3' }],
    },
  ];
  const descriptions = new Map([['k2', 'a cat dancing']]);
  const text = userText(buildRequest(baseInput({ gifs: THREE, history, descriptions })));
  assert.ok(text.includes('[gif g2: a cat dancing]'));
  assert.ok(text.includes('[gif g3: Danse 3]'));
});

// The owner on 2026-11-17: a GIF tag in the chat holds the whole description; the per-field cut goes.
test('buildRequest: a GIF tag in the chat holds its whole 300-character description', () => {
  const description = `${longCaption(2)} ${longCaption(3)}`.slice(0, 300);
  const mediaCache = { k2: { text: description, ts: NOW, watched: true, gif: true } };
  const history = [
    {
      ...baseInput().history[0],
      links: [{ id: 'k2', kind: 'gif', url: 'https://tenor.com/view/gif-2', site: 'Tenor', title: 'Danse 2' }],
    },
  ];
  const descriptions = new Map([['k2', description]]);
  const request = buildRequest(baseInput({ gifs: library([linkEntry(2, 9)]), mediaCache, history, descriptions }));
  const text = userText(request);
  assert.ok(text.includes(`[gif g2: ${description}]`), text);
  assert.ok(!text.includes('…'));
});
