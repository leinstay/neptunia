import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Lookup } from '../../../../src/turn/calls.ts';
import { type Frame, frameOf, type FrameParty } from '../../../../src/turn/request/frame.ts';
import { buildRequest, type Built } from '../../../fixtures/built-request.ts';
import { frameInput, ROOM_CHAIN } from '../../../fixtures/frame-input.ts';
import { labels } from '../../../fixtures/labels.ts';
import { type FakePlace, line, meanwhileReads } from '../../../fixtures/meanwhile-reads.ts';
import { mindOfEntries, personEntry, placeEntry } from '../../../fixtures/mind-entries.ts';
import {
  fakePrompts,
  frameOfInput,
  makeMessage,
  MIN,
  NOW,
  baseInput as promptReaderBaseInput,
  fakeConfig as promptReaderFakeConfig,
} from '../../../fixtures/prompt-rig.ts';
import { shippedLabels } from '../../../fixtures/shipped-labels.ts';

const MINUTE = 60_000;

// An hour edge: the bucket of a one-hour TTL starts here.
const EDGE = Date.UTC(2026, 8, 20, 10, 0, 0);

function fakeConfig(overrides: { features?: object; cache?: object } = {}) {
  return {
    bot: { timezone: 'UTC' },
    context: {
      gapMarkerMinutes: 20,
      maxMessageChars: 800,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500 },
      vision: { maxImages: 0, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
      customEmoji: { max: 30 },
    },
    features: { ...overrides.features },
    gifs: { max: 20, halfLifeDays: 30, ownMarkHours: 24 },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9, cache: { ttl: '1h', ...overrides.cache } },
    memory: {},
  };
}

function baseInput(overrides: Record<string, unknown> & { now?: number } = {}) {
  const now = overrides.now ?? EDGE + 10 * MINUTE;
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
    now,
    selfName: 'Nept',
    history: [
      {
        id: '1',
        ts: now - 60_000,
        authorId: 'a',
        authorName: 'Zoé',
        self: false,
        content: 'γεια',
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

// B7: the GIF list left the request, so the test of its order inside one bucket went with it.

// --- `<surroundings>`, held per bucket by place and version, opens the cached `memory` part (2026-11-11) -------------

const ROOT_LINK = { id: 'place:root', kind: 'server', name: 'Αγορά' };

const ROOM = frameOf(frameInput({ chain: [{ id: 'place:room', kind: 'channel', name: 'γενικά' }, ROOT_LINK] }));

const GARDEN = frameOf(frameInput({ chain: [{ id: 'place:garden', kind: 'channel', name: 'κήπος' }, ROOT_LINK] }));

/** A reply in `frame` whose place has `purpose` under the description versions `versions`. */
function placed(
  frame: Frame,
  {
    purpose,
    versions,
    now,
    self = ['likes tea'],
  }: { purpose: string; versions: Array<string>; now: number; self?: Array<string> },
  stableFreeze: Map<string, unknown>
) {
  return {
    ...baseInput({ now, stableFreeze, placeMemory: { self } }),
    surroundings: { interfaceText: 'IFACE_TEXT', root: null, place: { purpose }, versions },
    frame,
  };
}

/** The text of the part of `request` cached under `segment`. */
function segmentText(request: Built, segment: string): string {
  const [, user] = request.messages;
  const part = user.content.find((entry) => entry.cacheSegment === segment);
  assert.ok(part, `the request has a ${segment} part`);
  return part.text;
}

/** `<surroundings>` as it opens the cached `memory` part of `request`. */
function surroundingsText(request: Built): string {
  const text = segmentText(request, 'memory');
  assert.ok(text.startsWith('<surroundings>\n'), text);
  return text.slice(0, text.indexOf('</surroundings>'));
}

test('buildRequest: two requests of one place within a bucket have byte-identical stable parts and <surroundings>', () => {
  // Bug: a memory batch or a field edit under the same description version rewrites the cached prefix mid-bucket.
  const stableFreeze = new Map<string, unknown>();
  const first = buildRequest(
    placed(ROOM, { purpose: 'μιλάμε για τσάι', versions: ['ver:1'], now: EDGE + 10 * MINUTE }, stableFreeze)
  );
  const second = buildRequest(
    placed(
      ROOM,
      {
        purpose: 'μιλάμε για καφέ',
        versions: ['ver:1'],
        now: EDGE + 50 * MINUTE,
        self: ['likes tea', 'hates mornings'],
      },
      stableFreeze
    )
  );
  assert.equal(segmentText(second, 'stable'), segmentText(first, 'stable'));
  assert.equal(surroundingsText(second), surroundingsText(first));
  assert.ok(surroundingsText(first).includes('μιλάμε για τσάι'));
});

test('buildRequest: a new description version of the place changes <surroundings> within the bucket', () => {
  // Bug: the freeze keyed by place alone keeps a stale description for up to an hour after the memory rewrote it.
  const stableFreeze = new Map<string, unknown>();
  buildRequest(
    placed(ROOM, { purpose: 'μιλάμε για τσάι', versions: ['ver:1'], now: EDGE + 10 * MINUTE }, stableFreeze)
  );
  const renewed = buildRequest(
    placed(ROOM, { purpose: 'μιλάμε για καφέ', versions: ['ver:2'], now: EDGE + 20 * MINUTE }, stableFreeze)
  );
  assert.ok(surroundingsText(renewed).includes('μιλάμε για καφέ'));
});

test('buildRequest: a request of another place differs from the first only in <surroundings> of the cached prefix', () => {
  // Bug: a place fact inside the stable part breaks the cache of `<self>` at every change of room.
  const stableFreeze = new Map<string, unknown>();
  const room = buildRequest(
    placed(ROOM, { purpose: 'μιλάμε για τσάι', versions: ['ver:1'], now: EDGE + 10 * MINUTE }, stableFreeze)
  );
  const garden = buildRequest(
    placed(GARDEN, { purpose: 'φυτεύουμε ντομάτες', versions: ['ver:9'], now: EDGE + 11 * MINUTE }, stableFreeze)
  );
  const [roomSystem] = room.messages;
  const [gardenSystem] = garden.messages;
  assert.equal(gardenSystem.content, roomSystem.content);
  assert.equal(segmentText(garden, 'stable'), segmentText(room, 'stable'));
  assert.notEqual(surroundingsText(garden), surroundingsText(room));
});

const TIMEZONE = 'Europe/Moscow';

const ELENI = personEntry('111', 'Ελένη', { evidence: 'counterpart', relation: 'ΣΧΕΣΗ-ΕΛΕΝΗΣ' });

// A party carries the id the interface names them by (plan 2026-11-08 ids-by-links, slice 7b): the request no longer
// parses it out of the account id.
const AS_ELENI: FrameParty = { personId: ELENI.personId, accountId: 'fake:111', nativeId: '111', name: 'Ελένη' };

const CLUB = placeEntry('place:club', 'λέσχη', { purpose: 'ΣΚΟΠΟΣ-ΛΕΣΧΗΣ' });

const FRAME = frameOf(
  frameInput({ now: NOW, timezone: TIMEZONE, author: AS_ELENI, trigger: { messageId: 'm1', authorId: '111' } })
);

const WHEREABOUTS = { kind: 'place', iface: 'fake', private: false, chain: ROOM_CHAIN };

const CONTEXT = {
  meanwhile: { messages: 8, around: 2 },
  recall: { extractChars: 1200, maxItems: 6 },
};

const HISTORY = [makeMessage('m1', NOW - MIN, { authorId: '111', authorName: 'Ελένη', content: 'γεια σου' })];

const LOOKUP: Lookup = {
  turnId: 'turn:7',
  at: NOW - 2 * MIN,
  tool: 'memory.search',
  args: { query: 'ΕΡΩΤΗΜΑ-ΚΗΠΟΣ' },
  place: { id: 'place:room', path: ['fake', 'Αγορά', 'γενικά'] },
  status: 'ok',
  extract: 'ΑΠΟΣΠΑΣΜΑ-ΚΗΠΟΥ',
  sourceIds: ['src:fake:m50:1:seen'],
  anchorMessageIds: ['m1'],
};

/** The club with a line of the persona's among three of Eleni's. */
const CLUB_LINES: FakePlace = {
  id: 'place:club',
  path: ['fake', 'Αγορά', 'λέσχη'],
  dm: false,
  lines: [
    line('place:club', 'c1', NOW - 40 * MIN, '111', 'πρώτη'),
    line('place:club', 'c2', NOW - 39 * MIN, '111', 'δεύτερη'),
    line('place:club', 'c3', NOW - 38 * MIN, null, 'δική της'),
    line('place:club', 'c4', NOW - 37 * MIN, '111', 'τρίτη'),
  ],
};

const nameOf = (id: string): string | null => (id === '111' ? 'Ελένη' : null);

function request(over: Record<string, unknown> = {}): Built {
  return buildRequest(
    promptReaderBaseInput({
      config: promptReaderFakeConfig({ context: CONTEXT }),
      prompts: fakePrompts({ labels: shippedLabels }),
      frame: FRAME,
      whereabouts: WHEREABOUTS,
      history: HISTORY,
      trigger: HISTORY[0],
      triggerKind: 'mention',
      nameOf,
      mind: mindOfEntries({ people: [ELENI], places: [CLUB] }),
      lookups: [LOOKUP],
      myDay: ['09:00 έγραψα στη λέσχη'],
      meanwhileReads: meanwhileReads([CLUB_LINES]),
      ...over,
    })
  );
}

/** Every root block of the user message as `<segment> <tag>`, in order. */
function emittedBlocks({ messages }: Built): Array<string> {
  const [, user] = messages;
  return user.content.flatMap((part) =>
    [...String(part.text).matchAll(/^<([a-z_]+)>\n[\s\S]*?\n<\/\1>$/gm)].map(
      (match) => `${part.cacheSegment ?? 'tail'} ${match[1]}`
    )
  );
}

// The cached segment `memory` runs from `<surroundings>` to the last block before `<chat>`.
test("the root tags of a reply are the frame's list in its order, the stable segment holds exactly <self> and the memory segment <surroundings> to <meanwhile>", () => {
  // Bug: an old block such as <senses> or <channel_directory> stays in the request, or the tail keeps the old order.
  const built = request();
  // `<surroundings>`, `<memory>` and `<meanwhile>` repeat between turns and end right before `<chat>`, so they form the
  // cached segment `memory`, and `<surroundings>` has no marker of its own.
  const cached: Record<string, string> = {
    self: 'stable',
    surroundings: 'memory',
    memory: 'memory',
    meanwhile: 'memory',
  };
  // The cache layout makes `<found>` a root tag of the frame; this request finds nothing.
  // The block of custom emoji and stickers is <media>.
  // The <media> block is absent when the window holds no custom emoji and no sticker.
  const expected = FRAME.blocks
    .filter((name) => name !== 'persona' && name !== 'found' && name !== 'media')
    .map((name) => `${cached[name] ?? 'tail'} ${name}`);
  assert.deepEqual(emittedBlocks(built), expected);
});
