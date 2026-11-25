// The request of a turn (src/behavior/prompt.ts): its blocks, the stable part kept first for the cache, the senses and
// the shipped prompt files it fills.
import { beforeEach, test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { userText, buildDrawPrompt } from '../../../src/behavior/prompt.ts';
import { labels } from '../../fixtures/labels.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import { createTurnRunner } from '../../fixtures/turn-runner.ts';
import { freshWorld, world, useIface, useSelf } from '../../fixtures/turn-world.ts';
import {
  NOW,
  fakeClient,
  fakeHot,
  fakeStore,
  fakeTurnChannel,
  identityCalibrator,
  normalizedTrigger,
  rawMessage,
} from '../../fixtures/turn-kit.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { buildRequest } from '../../fixtures/built-request.ts';
import type { Built } from '../../fixtures/built-request.ts';
import {
  frameOfInput,
  MIN as PROMPT_MIN,
  NOW as PROMPT_NOW,
  baseInput,
  exactly,
  fakeConfig,
  fakePrompts as promptFakePrompts,
  makeMessage,
  framed,
} from '../../fixtures/prompt-rig.ts';
import { fill } from '../../../src/format.ts';
import { blockTags } from '../../fixtures/prompt-text.ts';
import { SAFETY_MARGIN } from '../../../src/llm/budget.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnowflakeUtil } from 'discord.js';
import { joinLabels } from '../../../src/config/labels.ts';
import { deepMerge } from '../../../src/config.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, utcDay } from '../../../src/time.ts';
import { normalizeMessage } from '../../../interfaces/discord/index.ts';
import { withTextPreviews } from '../../../src/media/text-preview.ts';
import { createCalibrator } from '../../../src/llm/tokens.ts';

const URL_G1 = 'https://tenor.com/view/g1';

const CAPABILITY_TEXT = 'Εδώ ένα αυτοκόλλητο μιλά δυνατά.';

const CAPABLE = {
  gifForms: ['file', 'link'],
  emoji: { actions: ['append', 'replace'], render: { still: '[[{name}|{id}]]' } },
  text: CAPABILITY_TEXT,
};

const WAVE = { id: '7', name: 'e1', platformName: 'wave', animated: false };

beforeEach(() => {
  freshWorld();
});

function sharedLibrary() {
  return {
    nextId: 2,
    backfill: null,
    entries: {
      k1: {
        id: 'g1',
        kind: 'link',
        url: URL_G1,
        itemId: 'item-1',
        messageId: 'm-1',
        placeId: 'c1',
        count: 3,
        last: NOW - 3_600_000,
        firstSeen: NOW - 7_200_000,
        // A GIF is stored as one text.
        description: 'ναι φυσικά γνέφει',
        nativeIds: ['item-1'],
        links: [URL_G1],
        places: { c1: { count: 3, last: NOW - 3_600_000 } },
      },
    },
  };
}

async function runScene({
  reply = '<msg reply="#2">ναι, φυσικά, έλα</msg>',
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  pick = '{"pick":"none","name":null}',
  mediaPick = CAPABLE,
}: { reply?: string; pick?: string; mediaPick?: object | null } = {}) {
  if (mediaPick) {
    const port = world().port as unknown as { capabilities: () => object };
    const declared = port.capabilities.bind(port);
    port.capabilities = () => ({ ...declared(), mediaPick });
  }
  const raws = [
    rawMessage({ id: 'm0', ts: NOW - 5000, content: 'καλημέρα' }),
    rawMessage({ id: 'm1', ts: NOW - 1000, content: 'θα έρθεις απόψε;' }),
  ];
  const channel = fakeTurnChannel({ historyMessages: raws });
  const calls: Array<{ messages: Array<{ content: unknown }>; options: Record<string, Untyped> }> = [];
  const hot = fakeHot(
    {},
    {},
    {
      media: {
        maxPerTurn: 6,
        filePreviewChars: 500,
        pick: { maxOutputTokens: 17, candidates: 5, emojiCandidates: 5, emojiPerReplies: 0, emojiCooldownMinutes: 0 },
      },
      models: { routes: chainsOf({ analyzer: 'cheap/classifier' }) },
    }
  );
  Object.assign(hot.prompts, { 'classify/pick': 'Pick for {{name}}.', labels });
  const library = sharedLibrary();
  const known = { key: 'k1', ...library.entries.k1 };
  const rails: Array<{ placeId: string; state: { lastUsed?: Record<string, number> } }> = [];
  const store = Object.assign(fakeStore({ placeMemory: { emojiUsage: { '7': { count: 4, last: NOW - 1000 } } } }), {
    getGifs: () => library,
    findGif: (...given: Array<string>) => (given.at(-1) === 'g1' ? known : null),
    getEmojiRails: () => null,
    setEmojiRails: (placeId: string, state: { lastUsed?: Record<string, number> }) => {
      rails.push({ placeId, state });
    },
    recordOwnGif: () => {},
  });
  const emoji = {
    refresh: () => Promise.resolve(),
    byName: (name: string) => (name === WAVE.name ? WAVE : null),
    list: () => [WAVE],
    urlOf: () => null,
  };
  const turns = createTurnRunner({
    hot,
    store,
    emoji,
    llm: {
      complete: (messages: Array<{ content: unknown }>, options: Record<string, Untyped>) => {
        calls.push({ messages, options });
        return Promise.resolve({
          text: options?.purpose === 'media-pick' ? pick : reply,
          usage: {},
          estimated: 10,
        });
      },
    },
    calibrator: identityCalibrator(),
    client: fakeClient(),
    now: () => NOW,
  });
  const trigger = normalizedTrigger(raws[1]);
  await turns.runTurn(wrongly({ channel, mode: 'reply', trigger, triggerKind: 'mention' }));
  const own = calls.find((call) => call.options?.purpose !== 'media-pick');
  assert.ok(own);
  return {
    rails,
    picks: calls.filter((call) => call.options?.purpose === 'media-pick'),
    request: own.messages.map((message) => userText(message.content) || String(message.content)).join('\n'),
    sent: channel.sent.map((payload: { content: unknown }) => payload.content),
  };
}

test('a turn on an interface with the capability carries its text and no emoji block', async () => {
  const { request } = await runScene();
  assert.ok(request.includes(CAPABILITY_TEXT), 'the capability text');
  assert.ok(!request.includes('<emoji>'), 'no <emoji>');
  assert.ok(!request.includes(labels.senses.customEmoji), 'no rule of the core');
});

// An emoji and a sticker go by a stable name of the engine.
test('a turn on an interface without the capability carries no emoji block, no rule and no text', async () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON.
  const { picks, request, sent } = await runScene({ mediaPick: null, pick: '{"pick":"emoji","name":"e1"}' });
  assert.equal(picks.length, 0);
  assert.deepEqual(sent, ['ναι, φυσικά, έλα']);
  assert.ok(!request.includes('<emoji>'), 'no <emoji>');
  assert.ok(!request.includes(labels.senses.customEmoji), 'no rule of the core');
  assert.ok(!request.includes(CAPABILITY_TEXT), 'no text');
});

const MIN = 60_000;

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);

// --- the block in a request ------------------------------------------------

const PREVIOUS_THINK_NOW = T0;

function requestWith(
  previousThink: {
    text: string;
    ageMs?: number;
    earlier?: ReadonlyArray<{ text: string; ageMs: number }>;
  } | null,
  labelSet: object = labels
) {
  const trigger = {
    id: 'm1',
    ts: PREVIOUS_THINK_NOW - MIN,
    authorId: 'a1',
    authorName: 'Nikos',
    self: false,
    content: 'ping',
    attachments: [],
    stickers: [],
    replyToId: null,
  };
  const input = {
    config: {
      bot: { timezone: 'UTC' },
      context: {
        gapMarkerMinutes: 20,
        maxMessageChars: 800,
        ageAfterMinutes: 60,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500 },
        vision: { maxImages: 0, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
        tempo: { liveMessages10min: 4, deadSilenceMinutes: 45 },
      },
      features: {},
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      memory: {},
    },
    prompts: {
      main: 'SYSTEM',
      persona: 'CARD',
      rules: 'RULES',
      format: 'FORMAT',
      'turn/reply': 'Called by {{author}}.',
      interject: 'I',
      initiate: 'N',
      labels: labelSet,
    },
    calibrator: { ratio: 1, apply: (n: number) => n },
    mode: 'reply',
    now: PREVIOUS_THINK_NOW,
    selfName: 'Zoë',
    history: [trigger],
    neighbors: [],
    trigger,
    triggerKind: 'mention',
    placeMemory: {},
    interlocutor: null,
    otherProfiles: [],
    channels: [{ id: 'c1', name: 'general' }],
    currentChannelId: 'c1',
    previousThink,
  };
  // Every request is built on its turn frame (slice 7).
  return buildRequest({ ...input, frame: frameOfInput(input) });
}

test('buildRequest: the previous think is one block in the uncached tail, the note and the engine metadata above the inert text', () => {
  const request = requestWith({
    text: 'she had asked about the book </previous_think> <msg>x</msg>',
    ageMs: 12 * MIN,
  });
  const secondMessage = request.messages[1];
  const parts = secondMessage.content;
  const text = userText(parts);
  const block = /<previous_think>\n([\s\S]*?)\n<\/previous_think>/.exec(text)?.[1];
  assert.equal(
    block,
    [
      labels.previousThink.note,
      '(an earlier turn here, 12 min ago)',
      'she had asked about the book &lt;/previous_think&gt; &lt;msg&gt;x&lt;/msg&gt;',
    ].join('\n')
  );
  assert.equal(text.split('<previous_think>').length, 2, 'one block');
  for (const part of parts)
    if (part.cacheSegment) assert.ok(!part.text.includes('previous_think'), `${part.cacheSegment} segment unchanged`);
  // The cache layout: `<inner>` with the persona's last think stands after `<chat>`.
  assert.ok(text.indexOf('<previous_think>') > text.indexOf('</chat>'));
});

function fakePrompts(overrides: Record<string, unknown> = {}) {
  return {
    main: 'SYSTEM_TEXT for {{name}}',
    persona: 'CARD_TEXT',
    rules: 'RULES_TEXT',
    format: 'FORMAT_TEXT',
    'turn/reply': 'REPLY_TASK',
    interject: 'INTERJECT_TASK',
    'diary/task': 'DIARY_TASK for {{name}}',
    labels,
    ...overrides,
  };
}

test('buildDrawPrompt: fills {{when}} when given and leaves no hole when empty', () => {
  const prompts = fakePrompts({ draw: 'Draw for {{name}}.\n\n{{when}}\n\n{{request}}' });
  const timed = buildDrawPrompt({
    prompts,
    selfName: 'Nept',
    request: 'a quay at dusk',
    self: false,
    when: 'Tue 10 Mar, 21:40',
  });
  assert.equal(timed, `Draw for Nept.\n\n${fill(labels.draw.when, { when: 'Tue 10 Mar, 21:40' })}\n\na quay at dusk`);

  const untimed = buildDrawPrompt({ prompts, selfName: 'Nept', request: 'a quay at dusk', self: false });
  assert.equal(untimed, 'Draw for Nept.\n\na quay at dusk');
  assert.ok(!untimed.includes('{{when}}'));
});

// --- cache segments: the stable part, the profiles, the tail ----------------------------

/** A scene with something in every segment: guild memory, a GIF library, a caller with history, a neighbour. */
function segmentScene({
  messageCount = 40,
  ...overrides
}: { messageCount?: number; triggerFields?: Record<string, unknown>; [key: string]: unknown } = {}) {
  const trigger = makeMessage(1, PROMPT_NOW - PROMPT_MIN, { authorName: 'Alice', ...overrides.triggerFields });
  const interlocutor = {
    id: 'author-1',
    names: ['Alice'],
    character: 'talkative',
    interests: [
      {
        topic: 'chess',
        note: 'blitz',
        weight: 3,
        firstSeen: '2026-01-02T10:00:00.000Z',
        lastSeen: '2026-03-01T10:00:00.000Z',
      },
      {
        topic: 'tea',
        note: '',
        weight: 1,
        firstSeen: '2026-09-19T10:00:00.000Z',
        lastSeen: '2026-09-19T10:00:00.000Z',
      },
    ],
    details: [
      {
        id: 1,
        text: 'lives by the sea',
        weight: 2,
        firstSeen: '2026-02-01T10:00:00.000Z',
        lastSeen: '2026-09-20T09:30:00.000Z',
      },
    ],
    affinity: {
      score: 12,
      reason: 'kind words',
      history: [{ ts: '2026-09-19T08:00:00.000Z', delta: 3, reason: 'a gift' }],
    },
    episodes: [{ date: '2026-09-18', what: 'a long talk', quote: 'ναι', feeling: 'warm', weight: 2 }],
    messageCount,
  };
  const gifs = {
    nextId: 10,
    entries: {
      k1: {
        id: 'g1',
        kind: 'link',
        url: 'https://tenor.com/view/a-1',
        site: 'Tenor',
        name: 'A',
        itemId: 'k1',
        messageId: 'm1',
        placeId: 'c1',
        count: 4,
        last: PROMPT_NOW - 2 * 86_400_000,
        firstSeen: PROMPT_NOW - 9 * 86_400_000,
      },
      // Posted by the persona two hours ago: the own-post mark, with no age in it.
      k2: {
        id: 'g2',
        kind: 'link',
        url: 'https://tenor.com/view/b-2',
        site: 'Tenor',
        name: 'B',
        itemId: 'k2',
        messageId: 'm2',
        placeId: 'c1',
        count: 6,
        last: PROMPT_NOW - 2 * HOUR,
        firstSeen: PROMPT_NOW - 9 * 86_400_000,
        ownLast: PROMPT_NOW - 2 * HOUR,
        ownUses: 1,
      },
    },
    backfill: null,
  };
  return baseInput({
    // Unsure and stale marks on, so the profile carries every date-driven mark.
    config: fakeConfig({ memory: { interestStaleDays: 30, confirmAfter: 2 } }),
    history: [trigger],
    trigger,
    triggerKind: 'mention',
    interlocutor,
    placeMemory: {
      patterns: 'talks fast',
      self: ['likes games'],
      learned: [
        {
          id: 1,
          text: 'say hi first',
          weight: 2,
          firstSeen: '2026-09-01T10:00:00.000Z',
          lastSeen: '2026-09-10T10:00:00.000Z',
        },
      ],
    },
    gifs,
    channels: [{ id: 'c1', name: 'general', lastMessageAt: PROMPT_NOW - PROMPT_MIN, days: {} }],
    currentChannelId: 'c1',
    neighbors: [{ channelName: 'random', messages: [makeMessage(9, PROMPT_NOW - 5 * PROMPT_MIN)] }],
    ...overrides,
  });
}

// --- the stable part: the senses that read only the config --------------------------------

const EMOJI_INDEX = [
  { id: '1', name: 'alpha' },
  { id: '2', name: 'beta' },
  { id: '3', name: 'gamma' },
];

/**
 * A turn with every senses line it can have on a server and a full `<emoji>` block: the
 * ranked list and an emoji of the chat that is not on it.
 */
function cacheScene({
  triggerFields,
  ...overrides
}: { triggerFields?: Record<string, unknown>; [key: string]: unknown } = {}) {
  return segmentScene({
    config: fakeConfig({ dm: { enabled: true } }),
    triggerFields: { content: 'ωραίο :pog:', emojis: [{ id: '9', name: 'pog' }], ...triggerFields },
    placeMemory: {
      patterns: 'talks fast',
      self: ['likes games'],
      emojiUsage: { 2: { name: 'beta', count: 5, last: PROMPT_NOW - HOUR } },
    },
    customEmoji: EMOJI_INDEX,
    mediaCache: { 'emoji:9': { text: 'a surprised cat face', ts: 1 }, 'emoji:2': { text: 'a dancing bean', ts: 1 } },
    channels: [{ id: 'c1', name: 'κουζίνα', lastMessageAt: PROMPT_NOW - PROMPT_MIN, days: {} }],
    drawOn: true,
    recallAvailable: true,
    searchAvailable: true,
    elsewhereDestination: { name: 'général' },
    diaryChannel: 'ημερολόγιο',
    ...overrides,
  });
}

test('buildRequest: the stable part is byte-identical across the turns of a day, whatever the turn brings', () => {
  const user = buildRequest(cacheScene()).messages[1];
  const base = user.content[0];
  const variants = {
    'three hours later': { now: PROMPT_NOW + 3 * HOUR },
    'another author': { triggerFields: { authorId: 'author-7', authorName: 'Bob' } },
    'another channel': {
      channels: [{ id: 'c2', name: 'κήπος', lastMessageAt: PROMPT_NOW - PROMPT_MIN, days: {} }],
      currentChannelId: 'c2',
    },
    'no server search left': { recallAvailable: false },
    'no emoji in the chat': { triggerFields: { content: 'γεια', emojis: [] } },
    'the emoji ranking moved': {
      placeMemory: {
        patterns: 'talks fast',
        self: ['likes games'],
        emojiUsage: { 3: { name: 'gamma', count: 9, last: PROMPT_NOW - PROMPT_MIN } },
      },
    },
  };
  for (const [name, overrides] of Object.entries(variants)) {
    const content = buildRequest(cacheScene(overrides)).messages[1].content;
    assert.equal(content[0].cacheSegment, 'stable', name);
    assert.equal(content[0].text, base.text, name);
  }
});

test('buildRequest: throws a clear error when prompts.labels is missing', () => {
  assert.throws(() => buildRequest(baseInput({ prompts: promptFakePrompts({ labels: undefined }) })), /labels/);
});

test('buildRequest: total token usage never exceeds maxRequestTokens * the safety margin', () => {
  const history = [];
  for (let i = 1; i <= 30; i += 1) {
    history.push(makeMessage(i, PROMPT_NOW - (31 - i) * PROMPT_MIN, { content: 'word '.repeat(20) }));
  }
  const config = fakeConfig({ llm: { maxRequestTokens: 500 } });
  const request = buildRequest(baseInput({ history, config }));
  const cap = config.llm.maxRequestTokens * SAFETY_MARGIN;
  assert.ok(request.stats.used <= cap, `used ${request.stats.used} must be <= cap ${cap}`);
});

test('buildRequest: idByIndex maps every transcript index to its message id', () => {
  const history = [
    makeMessage('a', PROMPT_NOW - 3 * PROMPT_MIN),
    makeMessage('b', PROMPT_NOW - 2 * PROMPT_MIN),
    makeMessage('c', PROMPT_NOW - PROMPT_MIN),
  ];
  const request = buildRequest(baseInput({ history }));
  assert.equal(request.idByIndex.get(1), 'a');
  assert.equal(request.idByIndex.get(2), 'b');
  assert.equal(request.idByIndex.get(3), 'c');
});

test('prompt: returns the ids of the kept window, the parents and the previewed parts', () => {
  const parent = makeMessage('p1', PROMPT_NOW - 30 * PROMPT_MIN, { content: 'ο παλιός λόγος', replyParent: true });
  const withFile = makeMessage('m2', PROMPT_NOW - 2 * PROMPT_MIN, {
    authorId: 'author-x',
    attachments: [
      { id: 'f1', kind: 'text', url: 'https://cdn/notes.txt', name: 'notes.txt', previewText: 'café crème' },
    ],
  });
  const trigger = makeMessage('m3', PROMPT_NOW - PROMPT_MIN, {
    replyToId: 'p1',
    attachments: [{ id: 'i1', kind: 'image', url: 'img1' }],
  });
  const request = buildRequest(baseInput({ history: [parent, withFile, trigger], trigger, triggerKind: 'reply' }));
  assert.deepEqual(request.seen, {
    messageIds: ['p1', 'm2', 'm3'],
    parents: ['p1'],
    parts: { filePreviews: ['m2'] },
  });

  // Under a tight budget only the kept tail of the window counts as seen; a dropped parent is not listed.
  const history = [makeMessage('p0', PROMPT_NOW - 40 * PROMPT_MIN, { replyParent: true, content: 'word '.repeat(20) })];
  for (let i = 1; i <= 10; i += 1)
    history.push(makeMessage(`n${i}`, PROMPT_NOW - (11 - i) * PROMPT_MIN, { content: 'word '.repeat(20) }));
  const tight = buildRequest(baseInput({ history, config: fakeConfig({ llm: { maxRequestTokens: exactly(400) } }) }));
  const chat = tight.stats.chat;
  assert.ok(chat.dropped > 0, 'the chat is trimmed');
  const messageIds = tight.seen.messageIds;
  assert.equal(messageIds.length, chat.kept);
  assert.deepEqual(
    tight.seen.messageIds,
    history.slice(history.length - chat.kept).map((message) => message.id)
  );
  assert.deepEqual(tight.seen.parents, []);
  assert.deepEqual(tight.seen.parts, { filePreviews: [] });
});

test('buildRequest: idByIndex still covers messages later trimmed out of the rendered chat', () => {
  const history = [];
  for (let i = 1; i <= 10; i += 1) {
    history.push(makeMessage(i, PROMPT_NOW - (11 - i) * PROMPT_MIN, { content: 'word '.repeat(20) }));
  }
  // 340 was tight enough before <senses> gained the channels line (part of
  // the always-kept "fixed" section); 400 still trims the chat.
  const config = fakeConfig({ llm: { maxRequestTokens: exactly(400) } });
  const request = buildRequest(baseInput({ history, config }));
  const chat = request.stats.chat;
  assert.ok(chat.dropped > 0, 'the chat is trimmed');
  // idByIndex is built from the FULL transcript, before trimming.
  assert.equal(request.idByIndex.size, 10);
  assert.equal(request.idByIndex.get(1), 1);
});

// --- <lore> ------------------------------------------------------------------

function loreEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    title: 'The Great Flood',
    keys: ['flood'],
    text: 'It flooded once.',
    always: false,
    source: 'analyzer',
    weight: 3,
    ...overrides,
  };
}

test('buildRequest: no <lore> block when nothing matches the recent chat', () => {
  const history = [makeMessage(1, PROMPT_NOW - PROMPT_MIN, { content: 'completely unrelated chatter' })];
  const request = buildRequest(baseInput({ history, loreEntries: [loreEntry()] }));
  const secondMessage = request.messages[1];
  assert.ok(!userText(secondMessage.content).includes('<lore>'));
});

test('buildRequest: under a tiny lore cap, only the entries that fit survive', () => {
  const history = [makeMessage(1, PROMPT_NOW - PROMPT_MIN, { content: 'flood and fire, the two old stories' })];
  const config = fakeConfig({
    context: { caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1 } },
  });
  const request = buildRequest(
    baseInput({
      history,
      config,
      loreEntries: [
        loreEntry({ id: 'l1', title: 'Flood', keys: ['flood'], text: 'x'.repeat(200) }),
        loreEntry({ id: 'l2', title: 'Fire', keys: ['fire'], text: 'y'.repeat(200) }),
      ],
    })
  );
  const lore = request.stats.lore;
  assert.equal(lore.kept, 0);
});

// --- buildRequest: <@id> tokens resolved for the chat model, wired through ------

// --- buildRequest: silent members pulled into <people> by name/alias -----------

test('buildRequest: names/aliases shorter than 3 characters never trigger a pull-in', () => {
  const history = [makeMessage(1, PROMPT_NOW - PROMPT_MIN, { content: 'oh no, an ox ran off' })];
  const candidateProfiles = [{ id: 'p9', names: ['Ox'], character: 'stubborn' }];
  const request = buildRequest(baseInput({ history, candidateProfiles }));
  const secondMessage = request.messages[1];
  assert.ok(!userText(secondMessage.content).includes('character: stubborn'));
});

test('buildRequest: a candidate never mentioned in the transcript is not pulled in', () => {
  const history = [makeMessage(1, PROMPT_NOW - PROMPT_MIN, { content: 'nothing about anyone else here' })];
  const candidateProfiles = [{ id: 'p9', names: ['Dana'], character: 'sarcastic' }];
  const request = buildRequest(baseInput({ history, candidateProfiles }));
  const secondMessage = request.messages[1];
  assert.ok(!userText(secondMessage.content).includes('## Dana'));
});

// --- buildRequest: <people> priority (a)/(b)/(c) --------------------------------

test('buildRequest: a name of exactly 3 characters must match a WHOLE word, never as a prefix', () => {
  const history = [makeMessage(1, PROMPT_NOW - PROMPT_MIN, { content: 'the maximum output is high' })];
  const candidateProfiles = [{ id: 'p9', names: ['Max'], character: 'brief' }];
  const request = buildRequest(baseInput({ history, candidateProfiles }));
  const secondMessage = request.messages[1];
  const user = userText(secondMessage.content);
  assert.ok(!user.includes('## Max'), '"maximum" must not match the 3-character name "Max" as a prefix');
});

// --- the web lookup: <lookup>, read links, senses -----------------------------------

function webConfig(web: { links?: object; search?: object } = {}) {
  const config: ReturnType<typeof fakeConfig> & { web?: object } = fakeConfig();
  config.web = { links: { enabled: true, ...web.links }, quickSearch: { enabled: true, ...web.search } };
  return config;
}

function lookupOf(request: Built) {
  const secondMessage = request.messages[1];
  const text = userText(secondMessage.content);
  const match = /<lookup>\n([\s\S]*?)\n<\/lookup>/.exec(text);
  return match ? match[1] : null;
}

const LOOKUP = {
  query: 'qui a gagné la finale',
  text: 'Deux sources le confirment (example.com).',
  sources: [
    { title: 'Un', url: 'https://www.example.com/1', site: 'example.com' },
    { title: 'Deux', url: 'https://news.example.org/2', site: 'news.example.org' },
  ],
};

test('buildRequest: no lookup, or an older labels.json without labels.lookup -> no <lookup> block', () => {
  assert.equal(lookupOf(buildRequest(baseInput({ config: webConfig() }))), null);
  const { lookup: _omit, ...older } = labels;
  const request = buildRequest(
    baseInput({ config: webConfig(), lookup: LOOKUP, prompts: promptFakePrompts({ labels: older }) })
  );
  assert.equal(lookupOf(request), null);
});

// --- drawing ----------------------------------------------------------------

const DRAW_PROMPTS = {
  draw: 'Drawing for {{name}}.\n\n## Look\n\n{{appearance}}\n\n## Request\n\n{{request}}\n',
  appearance: '{{name}}: short hair, green scarf.',
};

test('buildDrawPrompt: fills name and request and blanks appearance for a non-self picture', () => {
  const text = buildDrawPrompt({ prompts: DRAW_PROMPTS, selfName: 'Nept', request: 'a cat on a roof', self: false });
  assert.ok(text.startsWith('Drawing for Nept.'));
  assert.ok(text.endsWith('a cat on a roof'));
  assert.ok(!text.includes('{{appearance}}'));
  assert.ok(!text.includes('green scarf'));
  assert.ok(!text.includes('\n\n\n'), 'the blanked appearance leaves no double blank line');
});

test('buildDrawPrompt: includes the rendered appearance for a self picture', () => {
  const text = buildDrawPrompt({ prompts: DRAW_PROMPTS, selfName: 'Nept', request: 'waving at the café', self: true });
  assert.ok(text.includes('## Look\n\nNept: short hair, green scarf.\n\n## Request'));
  assert.ok(text.endsWith('waving at the café'));
});

const HOUR = 60 * PROMPT_MIN;

// --- the cached profiles part: the interlocutor alone ------------------------------------

// --- skills discovery: the static protocol, the catalogue on request -------------------------

/** Catalogue rows as src/tools/gateway.ts#listSkills gives them. */
const SKILL_ROWS = [
  { name: 'message.create', title: 'Στείλε', whenToUse: 'σε άλλη συζήτηση', allowed: true, reason: 'carried-over' },
  { name: 'lore.list', title: '', whenToUse: '', allowed: true, reason: 'allowed' },
  { name: 'message.edit', title: 'Διόρθωσε', whenToUse: 'ένα δικό σου μήνυμα', allowed: true, reason: 'allowed' },
  {
    name: 'memory.profile.read',
    title: 'Θυμήσου',
    whenToUse: 'τις σημειώσεις σου',
    allowed: false,
    reason: 'not-allowed',
  },
  { name: 'memory.wipe', title: 'Σβήσε', whenToUse: 'ποτέ', allowed: false, reason: 'not-grantable' },
];

test("buildRequest: tool_catalogue -- the catalogue never touches the stable part, whatever the grants; the persona's tools are no block of the native transport", () => {
  const plain = buildRequest(segmentScene()).messages[1].content;
  const shown = buildRequest(segmentScene({ skillsInventory: SKILL_ROWS })).messages[1].content;
  const regranted = buildRequest(
    segmentScene({ skillsInventory: SKILL_ROWS.map((row) => ({ ...row, allowed: true, reason: 'allowed' })) })
  ).messages[1].content;
  assert.equal(plain[0].cacheSegment, 'stable');
  assert.equal(shown[0].text, plain[0].text, 'the catalogue never touches the stable part');
  assert.equal(regranted[0].text, plain[0].text, 'a grant never touches the stable part');
  const text2 = shown[0].text;
  const text = plain[0].text;
  assert.ok(!text.includes('message.create') && !text2.includes('message.create'), 'no skill row in the stable part');
  assert.equal(blockTags(userText(plain)).includes('tool_catalogue'), false, 'no catalogue without the question');
});

test('buildRequest: skills -- the tools field of the request takes its tokens off the room the sections share', () => {
  const free = buildRequest(segmentScene());
  const taken = buildRequest(segmentScene({ toolsTokens: 5000 }));
  assert.equal(taken.stats.limit, free.stats.limit - 5000);
});

/** The fixed words of a label before its first placeholder. */
const labelHead = (label: string) => label.split('{')[0];

// ---- the shipped layer --------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const PROMPTS_DIR = path.join(ROOT, 'prompts');

/** The tracked prompt files at any depth, by key: the path relative to prompts/ without `.md`, `/` between the parts. */
const PROMPT_FILES = fs
  .readdirSync(PROMPTS_DIR, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.md'))
  .map((file) => file.slice(0, -'.md'.length).split(path.sep).join('/'))
  .sort();

const BOM = String.fromCharCode(0xfeff);

/** `prompts/<name>.md` as src/hot.ts reads it: the BOM and carriage returns dropped, trimmed. */
function readPrompt(name: string) {
  const text = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8');
  return (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n/g, '\n').trim();
}

/** The tracked layer alone: config/ with the labels read joined, and prompts/, never a local override. */
const SHIPPED = {
  config: JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8')),
  prompts: {
    ...Object.fromEntries(PROMPT_FILES.map((name) => [name, readPrompt(name)])),
    labels: joinLabels(JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'labels.json'), 'utf8'))),
  },
};

// The shipped labels carry the keys of the contract (the fixture covers every one).
const LABELS = SHIPPED.prompts.labels as typeof labels;

/**
 * A prompt that carries `{{` or a `{key}` as text on purpose: its file name -> `{ literal, why }`.
 * The literal may remain in a request; anything else in braces may not. None today.
 */
const LITERAL_BRACES: Record<string, { literal: string; why: string }> = {};

/** `text` without the literals of LITERAL_BRACES. */
function withoutLiterals(text: string) {
  let rest = text;
  for (const { literal } of Object.values(LITERAL_BRACES)) rest = rest.split(literal).join('');
  return rest;
}

// The rules prompt reaches a request only while the memory table `rules` holds a rule (src/rules-list.ts). The requests
// here are built with no memory, the way a deployment starts, so it stays in NOT_BUILT: putting it in SYSTEM would mean
// a rule in every fixture, and tests/src/rules-list.test.ts already checks the block with and without one.
const SYSTEM = ['main', 'persona', 'format'];

/** Every kind of diary entry and the prompt file of its own task, which follows the common `diary/task.md`. */
const DIARY_KIND_FILES: Record<string, string> = Object.fromEntries(
  ['story', 'selfPicture', 'picture', 'photoset', 'randomSet', 'news', 'facts', 'thought', 'people', 'meme'].map(
    (kind) => [kind, `diary/kinds/${kind}`]
  )
);

/** The prompt files each request below must carry whole, by request. */
const LOADS = {
  reply: [...SYSTEM, 'turn/reply'],
  followUp: [...SYSTEM, 'turn/follow'],
  overheard: [...SYSTEM, 'turn/overheard'],
  errandResult: [...SYSTEM, 'turn/errand'],
  private: [...SYSTEM, 'turn/reply', 'turn/private'],
  draw: ['draw', 'appearance'],
  ...Object.fromEntries(
    Object.entries(DIARY_KIND_FILES).map(([kind, file]) => [`diary ${kind}`, [...SYSTEM, 'diary/task', file]])
  ),
  inner: [...SYSTEM, 'turn/inner'],
  heartbeat: [...SYSTEM, 'heartbeat/task'],
  describe: ['describe/picture'],
  avatar: ['describe/avatar'],
  describeGif: ['describe/gif'],
  describeVideo: ['describe/video'],
  rewatchAnswer: ['describe/rewatch'],
  searchSummary: ['summarize/search'],
  split: ['classify/split'],
  merge: ['classify/merge'],
  missed: ['classify/missed'],
  mediaPick: ['classify/pick'],
  humanizer: ['humanizer/linter', 'humanizer/editor'],
  turn: [...SYSTEM, 'turn/reply'],
};

/** The shipped config.json with `overrides` deep-merged over a fresh copy. */
function shippedConfig(overrides: Record<string, unknown> = {}) {
  const on = {
    models: { routes: chainsOf({ vision: 'x/vision', video: 'x/video', drawing: 'x/drawing', speech: 'x/speech' }) },
  }; // off when shipped
  return deepMerge(deepMerge(structuredClone(SHIPPED.config), on), overrides);
}

// ---- the checks -----------------------------------------------------------------

/** The text of one message content: a string as is, an array of parts as its text parts. */
function contentText(content: unknown) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** Every text a request carries, as one string. */
function requestText(messages: Array<{ content: unknown }>) {
  return messages.map((message) => contentText(message.content)).join('\n\n');
}

/** The double-brace sequences left in `text`, LITERAL_BRACES aside. */
function strayPlaceholders(text: string) {
  return [...new Set(withoutLiterals(text).match(/\{\{[^{}\n]{0,40}\}\}|\{\{/g) ?? [])];
}

/** The single-brace `{key}` label placeholders left in `text`, LITERAL_BRACES aside. */
function strayLabelKeys(text: string) {
  return [...new Set(withoutLiterals(text).match(/\{[A-Za-z_]\w*\}/g) ?? [])];
}

/** The lines of prompt `name` without a placeholder: a request that loads the file carries each one verbatim. */
function literalLines(name: string) {
  const text = (SHIPPED.prompts as Record<string, unknown>)[name] as string;
  assert.equal(typeof text, 'string', `prompts/${name}.md is not loaded`);
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('{{'));
}

/** Whether `text` carries prompt `name` whole. */
function carries(text: string, name: string) {
  return literalLines(name).every((line) => text.includes(line));
}

/**
 * Asserts one built request: no `{{placeholder}}` and no label `{key}` left, every prompt file of
 * `files` carried whole, every block of `blocks` rendered. Returns the request's text.
 */
function assertFilled(
  messages: unknown,
  { files = [], blocks = [] }: { files?: Array<string>; blocks?: Array<string> },
  where: string
) {
  assert.ok(Array.isArray(messages) && messages.length > 0, `${where}: no request was built`);
  const text = requestText(messages);
  assert.deepEqual(strayPlaceholders(text), [], `${where}: a placeholder reached the request unfilled`);
  assert.deepEqual(strayLabelKeys(text), [], `${where}: a label placeholder reached the request unfilled`);
  for (const name of files) {
    const missing = literalLines(name).filter((line) => !text.includes(line));
    assert.equal(
      missing.length,
      0,
      `${where}: prompts/${name}.md is not carried whole, e.g. ${JSON.stringify(missing.slice(0, 2))}`
    );
  }
  for (const tag of blocks) {
    if (tag === 'tempo') {
      // Slice 2 (g): `<tempo>` is the foot of `<chat>`, not a block, so its verdict line ends the chat's body.
      const chat = /<chat>\n([\s\S]*?)\n<\/chat>/.exec(text)?.[1] ?? '';
      const verdict = labelHead(LABELS.tempo.verdict);
      assert.ok(chat.split('\n').at(-1)?.startsWith(verdict), `${where}: no tempo at the foot of <chat>`);
      continue;
    }
    assert.ok(text.includes(`<${tag}>\n`), `${where}: no <${tag}> block`);
  }
  return text;
}

// ---- the scene: one server, its members and channels --------------------------------

const PROMPTS_SHIPPED_NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

const SELF_ID = '900000000000000001';

const SELF_NAME = 'Zoë';

const ANA = '411111111111111111';

const NIKOS = '422222222222222222';

const BJORN = '433333333333333333';

const ELODIE = '444444444444444444';

const GENERAL = '700000000000000001';

const GARDEN = '700000000000000002';

const DIARY = '700000000000000003';

const CHANNEL_INCREMENT: Record<string, bigint> = { [GENERAL]: 1n, [GARDEN]: 2n, [DIARY]: 3n };

const PEOPLE = {
  [ANA]: { id: ANA, name: 'Ana' },
  [NIKOS]: { id: NIKOS, name: 'Nikos' },
  [BJORN]: { id: BJORN, name: 'Björn' },
  [SELF_ID]: { id: SELF_ID, name: SELF_NAME },
};

const iso = (ms: number) => new Date(ms).toISOString();

/** A stored member profile, every field the renderers read filled. */
function profile(id: string, names: Array<string>, extra: Record<string, unknown> = {}) {
  return {
    id,
    names,
    character: `${names[0]} is curious and warm`,
    style: 'short lines, many questions',
    interests: [
      {
        topic: 'gardening',
        note: 'grows tomatoes on a balcony',
        weight: 4,
        firstSeen: iso(PROMPTS_SHIPPED_NOW - 30 * DAY_MS),
        lastSeen: iso(PROMPTS_SHIPPED_NOW - DAY_MS),
      },
      {
        topic: 'chess',
        note: '',
        weight: 1,
        firstSeen: iso(PROMPTS_SHIPPED_NOW - 200 * DAY_MS),
        lastSeen: iso(PROMPTS_SHIPPED_NOW - 200 * DAY_MS),
      },
    ],
    details: [
      {
        id: 1,
        text: 'lives near the sea',
        weight: 3,
        firstSeen: iso(PROMPTS_SHIPPED_NOW - 40 * DAY_MS),
        lastSeen: iso(PROMPTS_SHIPPED_NOW - 2 * DAY_MS),
      },
    ],
    aliases: [
      {
        name: `${names[0].slice(0, 3)}ou`,
        weight: 3,
        firstSeen: iso(PROMPTS_SHIPPED_NOW - 20 * DAY_MS),
        lastSeen: iso(PROMPTS_SHIPPED_NOW - DAY_MS),
      },
    ],
    relationship: 'an old friend of the chat',
    relationshipScore: 20,
    relationshipWrittenAt: iso(PROMPTS_SHIPPED_NOW - 10 * DAY_MS),
    affinity: {
      score: 22,
      reason: 'brought crêpes to the meetup',
      history: [{ delta: 5, ts: PROMPTS_SHIPPED_NOW - 3 * DAY_MS }],
    },
    episodes: [
      {
        date: '2026-09-28',
        what: 'taught the persona a card trick',
        quote: 'regarde bien',
        feeling: 'delighted',
        weight: 3,
        addedAt: iso(PROMPTS_SHIPPED_NOW - 7 * DAY_MS),
      },
      {
        date: '2026-10-04',
        what: 'asked about the weather',
        quote: '',
        feeling: 'calm',
        weight: 1,
        addedAt: iso(PROMPTS_SHIPPED_NOW - DAY_MS),
      },
    ],
    messageCount: 420,
    firstSeen: iso(PROMPTS_SHIPPED_NOW - 90 * DAY_MS),
    lastSeen: iso(PROMPTS_SHIPPED_NOW - 2 * MINUTE_MS),
    ...extra,
  };
}

const PROFILES: Record<string, ReturnType<typeof profile>> = {
  [ANA]: profile(ANA, ['Ana', 'Anaïs']),
  [NIKOS]: profile(NIKOS, ['Nikos']),
  [BJORN]: profile(BJORN, ['Björn']),
  [ELODIE]: profile(ELODIE, ['Élodie']),
};

const nameOf = (id: string) => {
  const names = PROFILES[id]?.names;
  return names?.[0] ?? null;
};

const GUILD_MEMORY = {
  patterns: 'quick banter, many emoji',
  starters: 'a photo of lunch, a question to the room',
  injokes: ['the eternal tomato'],
  self: ['once claimed to like rain'],
  learned: [
    {
      id: 1,
      text: 'say bonjour before anything else',
      from: `<@${ANA}>`,
      weight: 3,
      firstSeen: iso(PROMPTS_SHIPPED_NOW - 9 * DAY_MS),
      lastSeen: iso(PROMPTS_SHIPPED_NOW - DAY_MS),
    },
    {
      id: 2,
      text: 'never spoil a film',
      weight: 1,
      firstSeen: iso(PROMPTS_SHIPPED_NOW - DAY_MS),
      lastSeen: iso(PROMPTS_SHIPPED_NOW - DAY_MS),
    },
  ],
  emojiUsage: { E1: { name: 'zoe_wave', count: 4, last: PROMPTS_SHIPPED_NOW - DAY_MS } },
  updatedAt: iso(PROMPTS_SHIPPED_NOW - 3 * DAY_MS),
};

const CHANNELS = [
  {
    id: GENERAL,
    name: 'général',
    category: 'Café',
    topic: 'tout et rien',
    purpose: 'everyday chat',
    topics: 'plants, films, food',
    tone: 'warm teasing',
    lastMessageAt: PROMPTS_SHIPPED_NOW - 2 * MINUTE_MS,
    messageCount: 900,
    days: { [utcDay(PROMPTS_SHIPPED_NOW)]: 40 },
    topWriters: [
      { id: ANA, count: 30 },
      { id: NIKOS, count: 20 },
    ],
    updatedAt: iso(PROMPTS_SHIPPED_NOW - 8 * DAY_MS),
  },
  {
    id: GARDEN,
    name: 'jardin',
    category: 'Café',
    topic: null,
    purpose: 'garden photos',
    topics: 'seeds',
    tone: 'calm',
    lastMessageAt: PROMPTS_SHIPPED_NOW - 20 * MINUTE_MS,
    messageCount: 120,
    days: {},
  },
  {
    id: DIARY,
    name: 'journal',
    category: 'Notes',
    topic: 'one member per thread',
    purpose: 'personal diaries',
    topics: 'daily life',
    tone: 'quiet',
    lastMessageAt: PROMPTS_SHIPPED_NOW - 5 * MINUTE_MS,
    messageCount: 60,
    days: {},
  },
];

const LORE = [
  {
    id: 'l1',
    title: 'Le grand gel',
    keys: ['tomate'],
    text: 'The winter the balcony tomatoes froze.',
    always: false,
    source: 'analyzer',
    weight: 3,
  },
];

const CUSTOM_EMOJI = [
  { id: 'E1', name: 'zoe_wave' },
  { id: 'E2', name: 'tomate_triste' },
];

const RECENT_LINES = [
  {
    id: 1,
    at: PROMPTS_SHIPPED_NOW - 2 * HOUR_MS,
    addedAt: iso(PROMPTS_SHIPPED_NOW - HOUR_MS),
    placeId: GARDEN,
    text: `<@${NIKOS}> planted garlic`,
    who: [NIKOS],
    weight: 2,
  },
];

const LOOKUP_RESULT = {
  query: 'tomato frost',
  text: 'Tomatoes die below zero degrees [1].',
  sources: [{ title: 'Garden notes', url: 'https://www.example.com/frost', site: 'example.com' }],
};

/**
 * A discord.js-shaped message, enough for normalizeMessage: `author` a PEOPLE entry, media as
 * plain lists (attachments `{ id, name, contentType, url, size?, duration? }`, embeds as Discord
 * sends them, stickers `{ id, name, format }`, reactions `{ name, id?, count, me? }`).
 */
function promptsShippedRawMessage(
  channel: { id: string; name: string | null; category?: string | null; topic?: string | null },
  {
    ts,
    author,
    content = '',
    attachments = [],
    embeds = [],
    stickers = [],
    reactions = [],
    replyTo = null,
    mentions = [],
    forwarded = null,
  }: {
    ts: number;
    author: { id: string; name: string };
    content?: string;
    attachments?: Array<{ id: string; [key: string]: unknown }>;
    embeds?: Array<unknown>;
    stickers?: Array<{ id: string; [key: string]: unknown }>;
    reactions?: Array<{ name: string; id?: string; count: number; me?: boolean }>;
    replyTo?: string | null;
    mentions?: Array<string>;
    forwarded?: string | null;
  }
) {
  // The same id on every call: the time, and the channel as the increment.
  const id = SnowflakeUtil.generate({ timestamp: ts, increment: CHANNEL_INCREMENT[channel.id] ?? 0n }).toString();
  return {
    id,
    channelId: channel.id,
    channel: {
      name: channel.name,
      parent: channel.category ? { name: channel.category } : null,
      topic: channel.topic ?? null,
    },
    guild: null,
    author: { id: author.id, bot: false, globalName: author.name, username: author.name },
    member: { displayName: author.name },
    content,
    cleanContent: content,
    createdTimestamp: ts,
    reference: replyTo ? { messageId: replyTo } : null,
    attachments: new Map(attachments.map((a) => [a.id, a])),
    embeds,
    stickers: new Map(stickers.map((s) => [s.id, s])),
    messageSnapshots: new Map(
      forwarded
        ? [
            [
              'fwd',
              { content: forwarded, cleanContent: forwarded, attachments: new Map(), embeds: [], stickers: new Map() },
            ],
          ]
        : []
    ),
    mentions: { users: new Map(mentions.map((accountId) => [accountId, { id: accountId }])) },
    reactions: {
      cache: new Map(
        reactions.map((r, i) => [
          String(i),
          { emoji: { name: r.name, id: r.id ?? null }, count: r.count, me: r.me ?? false },
        ])
      ),
    },
    flags: { has: () => false },
  };
}

const GENERAL_INFO = { id: GENERAL, name: 'général', category: 'Café', topic: 'tout et rien' };

const GARDEN_INFO = { id: GARDEN, name: 'jardin', category: 'Café', topic: null };

const GIF_EMBED = {
  url: 'https://tenor.com/view/cat-wave-123',
  provider: { name: 'Tenor' },
  thumbnail: { url: 'https://media.tenor.com/cat.png' },
  video: { url: 'https://media.tenor.com/cat.mp4' },
};

const PAGE_EMBED = {
  url: 'https://example.org/tomates',
  title: 'Tomates en pot',
  description: 'Comment cultiver des tomates sur un balcon',
};

/** The chat of #général the turn answers, oldest first: every kind of media the transcript renders. */
function generalRaws() {
  const at = (minutes: number) => PROMPTS_SHIPPED_NOW - minutes * MINUTE_MS;
  const raws: Array<ReturnType<typeof promptsShippedRawMessage>> = [];
  const add = (fields: Parameters<typeof promptsShippedRawMessage>[1]) => {
    const raw = promptsShippedRawMessage(GENERAL_INFO, fields);
    raws.push(raw);
    return raw;
  };
  add({
    ts: at(55),
    author: PEOPLE[NIKOS],
    content: 'bonjour à tous, la tomate a gelé',
    reactions: [
      { name: '🍅', count: 3 },
      { name: 'zoe_wave', id: 'E1', count: 1, me: true },
    ],
  });
  const own = add({ ts: at(50), author: PEOPLE[SELF_ID], content: 'oh non, pauvre tomate' });
  add({
    ts: at(45),
    author: PEOPLE[BJORN],
    content: 'la preuve',
    attachments: [
      {
        id: '800000000000000001',
        name: 'photo.png',
        contentType: 'image/png',
        url: 'https://cdn.discordapp.com/attachments/1/2/photo.png',
        size: 2000,
      },
    ],
  });
  add({
    ts: at(40),
    author: PEOPLE[NIKOS],
    content: 'regardez https://tenor.com/view/cat-wave-123',
    embeds: [GIF_EMBED],
  });
  const video = add({
    ts: at(35),
    author: PEOPLE[ANA],
    content: 'une vidéo des oranges',
    attachments: [
      {
        id: '800000000000000002',
        name: 'oranges.mp4',
        contentType: 'video/mp4',
        url: 'https://cdn.discordapp.com/attachments/1/2/oranges.mp4',
        size: 90000,
        duration: 20,
      },
    ],
  });
  add({ ts: at(30), author: PEOPLE[BJORN], content: 'un article https://example.org/tomates', embeds: [PAGE_EMBED] });
  add({
    ts: at(26),
    author: PEOPLE[ANA],
    content: '',
    stickers: [{ id: '810000000000000001', name: 'tomato_dance', format: 1 }],
  });
  add({
    ts: at(22),
    author: PEOPLE[NIKOS],
    content: 'mes graines',
    attachments: [
      {
        id: '800000000000000003',
        name: 'graines.txt',
        contentType: 'text/plain',
        url: 'https://cdn.discordapp.com/attachments/1/2/graines.txt',
        size: 40,
      },
    ],
  });
  add({ ts: at(18), author: PEOPLE[BJORN], content: 'vu ailleurs', forwarded: 'le gel arrive mardi' });
  add({ ts: at(14), author: PEOPLE[SELF_ID], content: 'jolie vidéo', replyTo: video.id });
  add({ ts: at(10), author: PEOPLE[NIKOS], content: 'Zoë, tu as aimé ?', replyTo: own.id });
  add({
    ts: at(2),
    author: PEOPLE[ANA],
    content: '@Zoë de quelle couleur sont les oranges dans la vidéo ? et quand gèle la tomate ?',
    mentions: [SELF_ID],
  });
  return raws;
}

const normalize = (raws: Array<ReturnType<typeof promptsShippedRawMessage>>) =>
  raws.map((raw) => {
    const media = SHIPPED.config.media;
    const line = normalizeMessage(raw, SELF_ID, {
      videoSites: media.video.sites,
    });
    // The interface's line names its channel natively; the core reads the same line under its place.
    return { ...line, placeId: line.channelId };
  });

/** A fetch stand-in for text attachment previews: every file reads the same short text. */
const previewFetch = async () => ({
  ok: true,
  headers: { get: () => null },
  text: async () => 'graines: tomate, basilic, ail',
});

/** The #général chat, normalized, text previews filled, oldest first. */
async function generalHistory() {
  return withTextPreviews(normalize(generalRaws()), 500, previewFetch);
}

/** Captions, watched videos and read pages for every media item of `history`, as a turn hands them in. */
function mediaMaps(history: ReturnType<typeof normalize>) {
  const descriptions = new Map();
  const videos = new Map();
  const reads = new Map();
  for (const message of history) {
    for (const item of (message.attachments ?? []) as Array<{ id: string; kind: string }>) {
      if (item.kind === 'image' || item.kind === 'gif') descriptions.set(item.id, 'a tomato plant covered in frost');
      if (item.kind === 'video')
        videos.set(item.id, {
          state: 'watched',
          text: 'a person juggles three oranges',
          answer: { question: 'what colour?', text: 'orange' },
        });
    }
    for (const link of (message.links ?? []) as Array<{ id: string; kind: string }>) {
      if (link.kind === 'gif') descriptions.set(link.id, 'a cat waves');
      else reads.set(link.id, 'How to grow tomatoes in pots on a balcony.');
    }
    for (const sticker of (message.stickers ?? []) as Array<{ id: string }>)
      descriptions.set(sticker.id, 'a dancing tomato');
  }
  return { descriptions, videos, reads };
}

/** The GIF library of the server, holding the GIF of the chat. */
function gifLibrary(history: ReturnType<typeof normalize>) {
  const gif = history.flatMap((m) => m.links ?? []).find((link) => link.kind === 'gif')!;
  return {
    nextId: 2,
    entries: {
      [gif.id]: {
        id: 'g1',
        kind: 'link',
        url: gif.url,
        site: 'tenor.com',
        itemId: gif.id,
        count: 3,
        last: PROMPTS_SHIPPED_NOW - DAY_MS,
        firstSeen: PROMPTS_SHIPPED_NOW - 9 * DAY_MS,
      },
    },
  };
}

/** One neighbour channel with a line of its own. */
function neighbors() {
  const line = promptsShippedRawMessage(GARDEN_INFO, {
    ts: PROMPTS_SHIPPED_NOW - 20 * MINUTE_MS,
    author: PEOPLE[BJORN],
    content: 'les semis sont sortis',
  });
  return [{ placeId: GARDEN, channelName: 'jardin', readOnly: false, messages: normalize([line]) }];
}

/** The input of a server turn in #général answering Ana, every optional block given. */
async function turnInput(overrides: Record<string, unknown> = {}) {
  const history = await generalHistory();
  const trigger = history.at(-1);
  const { descriptions, videos, reads } = mediaMaps(history);
  const config = shippedConfig({
    // PR 7d: the switches are code; the private chats are `dm.enabled`.
    dm: { enabled: true },
    memory: { mainChannelIds: [GENERAL] },
  });
  const input = {
    config,
    prompts: SHIPPED.prompts,
    calibrator: createCalibrator(),
    mode: 'reply',
    forced: false,
    now: PROMPTS_SHIPPED_NOW,
    selfName: SELF_NAME,
    history,
    neighbors: neighbors(),
    trigger,
    triggerKind: 'mention',
    placeMemory: GUILD_MEMORY,
    interlocutor: PROFILES[ANA],
    otherProfiles: [PROFILES[NIKOS], PROFILES[BJORN]],
    candidateProfiles: Object.values(PROFILES),
    nameOf,
    channels: CHANNELS,
    loreEntries: LORE,
    currentChannelId: GENERAL,
    descriptions,
    neighborDescriptions: new Map(),
    videos,
    reads,
    lookup: LOOKUP_RESULT,
    searchAvailable: true,
    drawQuota: { spent: false, userSpent: false },
    customEmoji: CUSTOM_EMOJI,
    mediaCache: { 'emoji:E1': { text: 'a small waving hand', ts: PROMPTS_SHIPPED_NOW - DAY_MS } },
    gifs: gifLibrary(history),
    readOnlyIds: new Set([DIARY]),
    recentLines: RECENT_LINES,
    recentAudience: () => true,
    ...overrides,
  };
  // Every request is built on its turn frame (slice 7).
  return Object.hasOwn(overrides, 'frame') ? input : framed(input);
}

// The blocks a fully fed server turn renders, each headed or filled by labels. Slice 7: every request is built on its
// turn frame (docs/prompt-contract.md), so these are the frame's blocks and none of the old ones.
const TURN_BLOCKS = [
  'self',
  'senses',
  'surroundings',
  'memory',
  'people',
  'spatial_awareness',
  'chat',
  'tempo',
  'task',
];

describe('with the shipped prompts', () => {
  before(() => {
    useIface('fake');
    useSelf('900000000000000001');
  });
  after(() => {
    useIface('discord');
    useSelf('self-id');
  });

  // ---- the chat turn ----------------------------------------------------------------

  test('buildRequest: a reply fills main, persona, rules, format and turn/reply for every trigger kind', async () => {
    for (const triggerKind of ['mention', 'reply', 'followUp']) {
      const request = buildRequest(await turnInput({ triggerKind }));
      // A follow-up takes the follow-up task instead of turn/reply.md; a reply with no tagged state stays on turn/reply.md.
      const files = triggerKind === 'followUp' ? LOADS.followUp : LOADS.reply;
      const text = assertFilled(request.messages, { files, blocks: TURN_BLOCKS }, `reply (${triggerKind})`);
      assert.equal(
        carries(text, 'turn/reply'),
        triggerKind !== 'followUp',
        `${triggerKind}: which task file frames the turn`
      );
      assert.ok(
        text.includes((LABELS.triggers as Record<string, string>)[triggerKind]),
        `${triggerKind}: the trigger label fills {{trigger}}`
      );
    }
    // A Discord reply to the persona: untagged takes the follow-up task, tagged keeps turn/reply.md.
    const untagged = buildRequest(await turnInput({ triggerKind: 'reply', taggedCall: false }));
    const untaggedText = assertFilled(
      untagged.messages,
      { files: LOADS.followUp, blocks: TURN_BLOCKS },
      'reply (untagged reply)'
    );
    assert.ok(!carries(untaggedText, 'turn/reply'), 'an untagged reply: turn/reply.md is not sent as well');
    const tagged = buildRequest(await turnInput({ triggerKind: 'reply', taggedCall: true }));
    const taggedText = assertFilled(
      tagged.messages,
      { files: LOADS.reply, blocks: TURN_BLOCKS },
      'reply (tagged reply)'
    );
    assert.ok(!carries(taggedText, 'turn/follow'), 'a tagged reply: the follow-up task is not sent');
  });

  test('buildDrawPrompt: draw.md and appearance.md are filled for a picture the persona is in', () => {
    const prompt = buildDrawPrompt({
      prompts: SHIPPED.prompts,
      selfName: SELF_NAME,
      request: 'the persona waters frozen tomatoes on a balcony',
      self: true,
    });
    assertFilled([{ role: 'user', content: prompt }], { files: LOADS.draw }, 'draw');
    const without = buildDrawPrompt({
      prompts: SHIPPED.prompts,
      selfName: SELF_NAME,
      request: 'a frozen balcony',
      self: false,
    });
    assertFilled([{ role: 'user', content: without }], { files: ['draw'] }, 'draw without the persona');
    const timed = buildDrawPrompt({
      prompts: SHIPPED.prompts,
      selfName: SELF_NAME,
      request: 'a frozen balcony',
      self: false,
      when: 'Mon 5 Oct, 23:10',
    });
    const text = assertFilled([{ role: 'user', content: timed }], { files: ['draw'] }, 'draw with the local time');
    assert.ok(text.includes(fill(LABELS.draw.when, { when: 'Mon 5 Oct, 23:10' })), 'draw.when fills {{when}}');
  });
});

const OFF_LINE = 'Down for you at the moment: {abilities}.';

const SEPARATOR = ' and ';

const WORDS = {
  imagesIn: 'looking at pictures',
  videoIn: 'watching videos',
  imagesOut: 'drawing',
  audioOut: 'voice messages',
};

/** The fixture labels with the off line, its separator and the ability words. */
const OFF_LABELS = {
  ...labels,
  senses: { ...labels.senses, abilitiesOff: OFF_LINE, abilitiesOffSeparator: SEPARATOR },
  tools: { ...labels.tools, result: { ...labels.tools.result, params: { ability: WORDS } } },
};

const ALL_ON = { vision: 'x/v', video: 'x/w', drawing: 'x/d', speech: 'x/s' };

/** The request config with a chain for each role of `base` that names a model. */
const configWith = (base: Record<string, unknown>) => ({ ...fakeConfig(), models: { routes: chainsOf(base) } });

/** The line for these abilities, as the label fills it. */
const lineOf = (...abilities: Array<keyof typeof WORDS>) =>
  fill(OFF_LINE, { abilities: abilities.map((ability) => WORDS[ability]).join(SEPARATOR) });

// Bug caught: any byte of the request moving for a deployment where every role has a model.
// Changed: a config with no models has every optional role off (spec 2026-11-09-model-routes, slice 4), so the
// request with every role on is the one compared against.
test('buildRequest: an off role adds only the senses line to the request with every role on', () => {
  const prompts = promptFakePrompts({ labels: OFF_LABELS });
  const bare = buildRequest(baseInput({ prompts, config: configWith(ALL_ON) }));

  const off = buildRequest(baseInput({ prompts, config: configWith({ ...ALL_ON, speech: null }) }));
  const line = lineOf('audioOut');
  const secondMessage = off.messages[1];
  const offUser = userText(secondMessage.content).split('\n');
  assert.equal(offUser.filter((entry) => entry === line).length, 1, 'the line is in the request once');
  const secondMessage2 = bare.messages[1];
  assert.equal(offUser.filter((entry) => entry !== line).join('\n'), userText(secondMessage2.content));
  const message2 = bare.messages[0];
  const message = off.messages[0];
  assert.equal(message.content, message2.content, 'the system message is untouched');
});
