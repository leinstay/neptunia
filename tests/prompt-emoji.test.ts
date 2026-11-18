// Custom emoji in the persona's turn (src/behavior/prompt.ts): no list since stage B8 of plan 2026-11-04-cli-and-memory, the
// interface's own line in `<senses>`, the description in the chat line, and the ranking the media pick took over.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankEmojiCandidates } from '../src/behavior/media-pick.ts';
import { userText as contentText } from '../src/behavior/prompt.ts';
import { labels } from './fixtures/labels.ts';
import { frameOfInput } from './fixtures/prompt-rig.ts';
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
  const input = {
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
  // Every request is built on its turn frame (slice 7).
  return { ...input, frame: frameOfInput(input) };
}

const INDEX = [
  { id: '1', name: 'alpha', platformName: 'alpha', animated: false },
  { id: '2', name: 'beta', platformName: 'beta', animated: true },
  { id: '3', name: 'gamma', platformName: 'gamma', animated: false },
  { id: '4', name: 'delta', platformName: 'delta', animated: false },
];

function userText(request: Built) {
  return contentText(request.messages[1].content);
}

function emojiBlock(request: Built) {
  const match = /<emoji>\n([\s\S]*?)\n<\/emoji>/.exec(userText(request));
  return match ? match[1].split('\n') : null;
}

function surroundingsOf(request: Built) {
  const match = /<surroundings>\n([\s\S]*?)\n<\/surroundings>/.exec(userText(request));
  return match ? match[1] : '';
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
  // Slice 7: every request is built on its frame, where the interface's text is in <surroundings>, never in <senses>.
  const withIndex = buildRequest(baseInput({ customEmoji: INDEX, mediaPickText: 'ένα σημάδι' }));
  assert.equal(emojiBlock(withIndex), null);
  assert.ok(surroundingsOf(withIndex).split('\n').includes('ένα σημάδι'));
  assert.ok(!sensesOf(withIndex).includes('ένα σημάδι'));
  const empty = buildRequest(baseInput({ customEmoji: [], mediaPickText: 'ένα σημάδι' }));
  assert.equal(emojiBlock(empty), null);
  assert.ok(!userText(empty).includes('ένα σημάδι'));
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

// The owner on 2026-11-17: an emoji's and a sticker's description stands in the legend, the line holds the stable name.
test('buildRequest: a chat line holds the bare stable name, with an index and without, and no bracketed description', () => {
  const history = [chatLine('1', 'ωραίο :e23:', [{ id: '9', name: 'e23' }])];
  const descriptions = new Map([['emoji:9', 'a surprised cat face']]);
  for (const customEmoji of [[], INDEX]) {
    const built = buildRequest(baseInput({ customEmoji, history, descriptions, mediaNameOf: rowOf }));
    const lines = chatBlock(built).split('\n');
    // Slice 2 (g): the tempo lines close `<chat>`, so the chat line is found among its lines, not at its end.
    assert.ok(
      lines.some((line) => line.endsWith('Zoé: ωραίο :e23:')),
      lines.join('\n')
    );
    assert.ok(!chatBlock(built).includes('a surprised cat face'), 'the description stays out of the chat');
  }
});

// The owner on 2026-11-17: the block of custom emoji and stickers is <media>.
// ---- the legend: each custom emoji and sticker of the window described once, in <media> ----

// The owner on 2026-11-17: the legend is the root block `<media>`, grouped by interface and kind, present only when
// the window holds a custom emoji or a sticker. Labels are the test's own, values are read off the request.
const LEGEND_LABELS = {
  ...labels,
  transcript: { ...labels.transcript, stickerRef: '[sticker {name}]' },
  legend: {
    line: '{name} {platformName}: {text}',
    lineNoText: 'NOTEXT {name} {platformName}',
    unreadable: 'UNSEEN {name} {platformName}',
  },
};

type Row = {
  name: string;
  kind: 'emoji' | 'sticker';
  iface: string;
  nativeId: string;
  platformName: string;
  animated: boolean;
};

const ROWS: ReadonlyArray<Row> = [
  { name: 'e23', kind: 'emoji', iface: 'discord', nativeId: '9', platformName: 'pogcat', animated: false },
  { name: 'e24', kind: 'emoji', iface: 'discord', nativeId: '10', platformName: 'wavey', animated: false },
  { name: 's12', kind: 'sticker', iface: 'discord', nativeId: '51', platformName: 'hello_cat', animated: false },
  { name: 's13', kind: 'sticker', iface: 'discord', nativeId: '52', platformName: 'dance_loop', animated: false },
];

/** The store's read of a stable name over ROWS. */
function rowOf(name: string): Row | null {
  return ROWS.find((row) => row.name === name) ?? null;
}

function legendInput(history: Array<unknown>, descriptions: Map<string, string>) {
  return baseInput({
    prompts: {
      'system-prompt': 'SYSTEM',
      'character-card': 'CARD',
      rules: 'RULES',
      format: 'FORMAT',
      reply: 'REPLY_TASK',
      labels: LEGEND_LABELS,
    },
    history,
    descriptions,
    mediaNameOf: rowOf,
  });
}

/** The body of the root block `<media>`, which stands between `</surroundings>` and `<chat>`; null when absent. */
function legendOf(request: Built): string | null {
  const text = userText(request);
  const from = Math.max(0, text.lastIndexOf('</surroundings>'));
  const to = text.indexOf('<chat>');
  const between = text.slice(from, to < 0 ? text.length : to);
  const match = /<media>([\s\S]*?)<\/media>/.exec(between);
  return match ? match[1] : null;
}

/** The lines of one kind's subtag under one interface's subtag of the legend, [] when it is absent. */
function kindLines(legend: string, iface: string, kind: string): Array<string> {
  const scope = new RegExp(`<${iface}>([\\s\\S]*?)</${iface}>`).exec(legend)?.[1] ?? '';
  const body = new RegExp(`<${kind}>([\\s\\S]*?)</${kind}>`).exec(scope)?.[1] ?? '';
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function stickerOf(id: string, name: string, url: string | null) {
  return { id, name, url };
}

test('buildRequest: no <media> block when the window holds no custom emoji and no sticker', () => {
  // Bug: the legend is printed empty on every turn and the tail grows by a block that says nothing.
  const built = buildRequest(legendInput([chatLine('1', 'γεια', [])], new Map()));
  assert.equal(legendOf(built), null);
});

test('buildRequest: an emoji of the chat stands once in <media><discord><emojis> with its platform name and description', () => {
  // Bug: the description is lost with the bracket, or the legend misses the platform name she knows it by.
  const history = [chatLine('1', 'ωραίο :e23:', [{ id: '9', name: 'e23' }])];
  const built = buildRequest(legendInput(history, new Map([['emoji:9', 'a surprised cat face']])));
  const legend = legendOf(built);
  assert.deepEqual(kindLines(legend ?? '', 'discord', 'emojis'), [':e23: pogcat: a surprised cat face']);
  assert.ok(!(legend ?? '').includes('<stickers>'), 'no stickers subtag when no sticker occurs');
});

test('buildRequest: an emoji used in three lines has one legend line', () => {
  // Bug: the legend repeats a thing once per line that uses it.
  const emojis = [{ id: '9', name: 'e23' }];
  const history = [
    chatLine('1', ':e23:', emojis, NOW - 180_000),
    chatLine('2', 'ναι :e23:', emojis, NOW - 120_000),
    chatLine('3', ':e23: :e23:', emojis, NOW - 60_000),
  ];
  const built = buildRequest(legendInput(history, new Map([['emoji:9', 'a surprised cat face']])));
  assert.deepEqual(kindLines(legendOf(built) ?? '', 'discord', 'emojis'), [':e23: pogcat: a surprised cat face']);
});

test('buildRequest: a sticker alone gives <stickers> and no <emojis>, and its chat line holds the stickerRef', () => {
  // Bug: an empty emoji subtag is printed, or the sticker keeps its description in the line.
  const history = [{ ...chatLine('1', '', []), stickers: [stickerOf('51', 's12', 'https://x/51.png')] }];
  const built = buildRequest(legendInput(history, new Map([['sticker:51', 'a cat raising one paw']])));
  const legend = legendOf(built) ?? '';
  assert.deepEqual(kindLines(legend, 'discord', 'stickers'), ['s12 hello_cat: a cat raising one paw']);
  assert.ok(!legend.includes('<emojis>'), legend);
  assert.ok(chatBlock(built).includes('[sticker s12]'), chatBlock(built));
  assert.ok(!chatBlock(built).includes('a cat raising one paw'), 'the description stays out of the chat');
});

test('buildRequest: an emoji with no description yet reads lineNoText and a sticker with no picture reads unreadable', () => {
  // Bug: a thing with nothing to say is dropped from the legend, or a Lottie sticker is offered as if it were seen.
  const history = [
    {
      ...chatLine('1', 'hm :e24:', [{ id: '10', name: 'e24' }]),
      stickers: [stickerOf('52', 's13', null)],
    },
  ];
  const built = buildRequest(legendInput(history, new Map([['sticker:52', 'a stale caption']])));
  const legend = legendOf(built) ?? '';
  assert.deepEqual(kindLines(legend, 'discord', 'emojis'), ['NOTEXT :e24: wavey']);
  assert.deepEqual(kindLines(legend, 'discord', 'stickers'), ['UNSEEN s13 dance_loop']);
});

test('buildRequest: a description of 1,400 characters stands whole in its legend line', () => {
  // Bug: the legend shortens a description as the old bracket did, and she loses the end of it.
  const long = `${'a long careful description of a cat. '.repeat(38)}END`.slice(-1400);
  assert.equal(long.length, 1400);
  const history = [chatLine('1', ':e23:', [{ id: '9', name: 'e23' }])];
  const built = buildRequest(legendInput(history, new Map([['emoji:9', long]])));
  assert.deepEqual(kindLines(legendOf(built) ?? '', 'discord', 'emojis'), [`:e23: pogcat: ${long}`]);
});

// The owner on 2026-11-17: a stable name in any block of her request has its line in the one `<media>` block, not only
// the names of `<chat>` and `<meanwhile>`. One block per request, one line per thing, none when no block names one.
const CAT = ':e23: pogcat: a surprised cat face';

function anyBlockInput(overrides: Record<string, unknown>) {
  return baseInput({
    prompts: {
      'system-prompt': 'SYSTEM',
      'character-card': 'CARD',
      rules: 'RULES',
      format: 'FORMAT',
      reply: 'REPLY_TASK',
      diary: 'DIARY_TASK',
      labels: LEGEND_LABELS,
    },
    history: [chatLine('1', 'γεια σου', [])],
    descriptions: new Map([['emoji:9', 'a surprised cat face']]),
    mediaNameOf: rowOf,
    ...overrides,
  });
}

/** The bodies of every `<media>` block of the request's user text. */
function mediaBlocks(request: Built): Array<string> {
  return [...userText(request).matchAll(/<media>\n([\s\S]*?)\n<\/media>/g)].map((match) => match[1] ?? '');
}

test('buildRequest: a self claim that names an emoji gives <media> its line', () => {
  // Bug: her stored claim about herself shows a bare `:e23:` with no line that says what it is.
  const built = buildRequest(anyBlockInput({ placeMemory: { self: ['ends a good day with :e23:'] } }));
  assert.deepEqual(
    mediaBlocks(built).map((body) => kindLines(body, 'discord', 'emojis')),
    [[CAT]]
  );
});

test('buildRequest: an intention whose text names an emoji gives <media> its line', () => {
  // Bug: `<intentions>` holds the stable name she promised to send and no block says what it is.
  const built = buildRequest(anyBlockInput({ intentions: 'send Zoé :e23: tonight' }));
  assert.deepEqual(
    mediaBlocks(built).map((body) => kindLines(body, 'discord', 'emojis')),
    [[CAT]]
  );
});

test('buildRequest: a diary scene that names an emoji gives the diary request <media> its line', () => {
  // Bug: the scene in `<inner>` keeps the stable name and the persona reads a bare code.
  // Changed: the planner's plan went with the planner, so the scene stands where the plan stood.
  const diary = { posts: [], kind: 'story', scenes: ['a calm day :e23:'] };
  const built = buildRequest(anyBlockInput({ mode: 'diary', diary }));
  assert.deepEqual(
    mediaBlocks(built).map((body) => kindLines(body, 'discord', 'emojis')),
    [[CAT]]
  );
});

test('buildRequest: an emoji named in <chat> and in a self claim has one <media> block with one line', () => {
  // Bug: each block that names a thing prints its own legend, or the legend repeats the thing.
  const built = buildRequest(
    anyBlockInput({
      history: [chatLine('1', 'ωραίο :e23:', [{ id: '9', name: 'e23' }])],
      placeMemory: { self: ['ends a good day with :e23:'] },
    })
  );
  assert.deepEqual(
    mediaBlocks(built).map((body) => kindLines(body, 'discord', 'emojis')),
    [[CAT]]
  );
});

test('buildRequest: no <media> block when only a self claim with no stable name stands', () => {
  // Bug: the wider legend prints an empty block on a request that names nothing.
  const built = buildRequest(anyBlockInput({ placeMemory: { self: ['ends a good day with tea'] } }));
  assert.deepEqual(mediaBlocks(built), []);
});
