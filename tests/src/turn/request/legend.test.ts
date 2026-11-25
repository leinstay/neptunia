// Tests for src/turn/request/legend.ts: the body of the root block `<media>`, the legend of custom emoji and stickers.
// Each custom emoji and sticker the window uses stands once, under its interface and its kind, with its stable name,
// its platform name and its full description. Contract:
//   legendText(items: ReadonlyArray<{ iface, kind: 'emoji' | 'sticker', name, platformName, text: string | null,
//     readable: boolean }>, labels: Labels): string
// The labels are the test's own: a test reads structure and the values that pass through, never a label's wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legendText } from '../../../../src/turn/request/legend.ts';
import { labels } from '../../../fixtures/labels.ts';
import { userText as contentText } from '../../../../src/behavior/prompt.ts';
import { withCacheMarker } from '../../../../src/llm/openrouter.ts';
import { frameOf, type FrameParty } from '../../../../src/turn/request/frame.ts';
import { buildRequest, type Built } from '../../../fixtures/built-request.ts';
import { blockOf, EMOJI_NAME, frameTurn } from '../../../fixtures/diary-frame.ts';
import { frameInput, ROOM_CHAIN } from '../../../fixtures/frame-input.ts';
import { line, meanwhileReads } from '../../../fixtures/meanwhile-reads.ts';
import { mindOfEntries, personEntry } from '../../../fixtures/mind-entries.ts';
import {
  baseInput,
  fakeConfig,
  fakePrompts,
  frameOfInput,
  makeMessage,
  MIN,
  NOW,
} from '../../../fixtures/prompt-rig.ts';
import { shippedLabels } from '../../../fixtures/shipped-labels.ts';

const LABELS = {
  ...labels,
  legend: {
    line: '{name} {platformName}: {text}',
    lineNoText: 'NOTEXT {name} {platformName}',
    unreadable: 'UNSEEN {name} {platformName}',
  },
};

type Item = Parameters<typeof legendText>[0][number];

function emoji(name: string, platformName: string, text: string | null, iface = 'discord'): Item {
  return { iface, kind: 'emoji', name, platformName, text, readable: true };
}

function sticker(name: string, platformName: string, text: string | null, readable = true): Item {
  return { iface: 'discord', kind: 'sticker', name, platformName, text, readable };
}

/** The subtags of `text` in the order they open, nested ones included. */
function tagsOf(text: string): Array<string> {
  return [...text.matchAll(/<([a-z_]+)>/g)].map((match) => match[1]);
}

/** The lines of one kind's subtag under one interface's subtag, [] when it is absent. */
function kindLines(text: string, iface: string, kind: string): Array<string> {
  const scope = new RegExp(`<${iface}>([\\s\\S]*?)</${iface}>`).exec(text)?.[1] ?? '';
  const body = new RegExp(`<${kind}>([\\s\\S]*?)</${kind}>`).exec(scope)?.[1] ?? '';
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

test('legendText is empty when no item is given', () => {
  // Bug: the block's frame is printed with nothing in it.
  assert.equal(legendText([], LABELS), '');
});

test('legendText groups by interface, then emojis before stickers, holding only the interfaces and kinds that occur', () => {
  // Bug: the kinds mix in one list, or an empty `<stickers>` is printed for an interface that has none.
  const text = legendText(
    [
      emoji('e5', 'blob', 'a blob', 'matrix'),
      sticker('s12', 'wave', 'a cat raising one paw'),
      emoji('e23', 'kekw', 'a frog laughing'),
    ],
    LABELS
  );
  assert.deepEqual(tagsOf(text), ['discord', 'emojis', 'stickers', 'matrix', 'emojis']);
  assert.deepEqual(kindLines(text, 'discord', 'emojis'), [':e23: kekw: a frog laughing']);
  assert.deepEqual(kindLines(text, 'discord', 'stickers'), ['s12 wave: a cat raising one paw']);
  assert.deepEqual(kindLines(text, 'matrix', 'emojis'), [':e5: blob: a blob']);
});

test('legendText lists the things of a kind in the order of their numbers', () => {
  // Bug: the names sort as text, so `e12` stands before `e3` and the order moves as names are issued.
  const text = legendText([emoji('e12', 'twelve', 'twelve'), emoji('e3', 'three', 'three')], LABELS);
  assert.deepEqual(kindLines(text, 'discord', 'emojis'), [':e3: three: three', ':e12: twelve: twelve']);
});

test('legendText keeps a description of 1,400 characters whole', () => {
  // Bug: the legend shortens a description, and the persona loses the end of what the helper saw.
  const long = `${'x'.repeat(1396)} END`;
  assert.equal(long.length, 1400);
  const text = legendText([emoji('e23', 'kekw', long)], LABELS);
  assert.deepEqual(kindLines(text, 'discord', 'emojis'), [`:e23: kekw: ${long}`]);
});

test('legendText writes a thing with no description yet in lineNoText', () => {
  // Bug: a thing not yet described is dropped, and the persona meets a name the legend does not explain.
  const text = legendText([emoji('e24', 'wavey', null), sticker('s14', 'nod', null)], LABELS);
  assert.deepEqual(kindLines(text, 'discord', 'emojis'), ['NOTEXT :e24: wavey']);
  assert.deepEqual(kindLines(text, 'discord', 'stickers'), ['NOTEXT s14 nod']);
});

test('legendText writes a sticker with no picture in unreadable, whatever text it carries', () => {
  // Bug: a Lottie sticker reads as seen, from a caption nobody could have made of it.
  const text = legendText([sticker('s13', 'dance_loop', 'a stale caption', false)], LABELS);
  assert.deepEqual(kindLines(text, 'discord', 'stickers'), ['UNSEEN s13 dance_loop']);
});

const ELENI = personEntry('111', 'Ελένη', { evidence: 'counterpart', relation: 'ΣΧΕΣΗ-ΕΛΕΝΗΣ' });

const AS_ELENI: FrameParty = { personId: ELENI.personId, accountId: 'fake:111', nativeId: '111', name: 'Ελένη' };

const FRAME = frameOf(
  frameInput({ now: NOW, timezone: 'Europe/Moscow', author: AS_ELENI, trigger: { messageId: 'm1', authorId: '111' } })
);

const nameOf = (id: string): string | null => (id === '111' ? 'Ελένη' : null);

// ---- the legend ----------------------------------------------------------------------------------------------------

// The block of custom emoji and stickers is <media>.
// The legend `<media>` stands in the tail, after `<meanwhile>` and before `<chat>`, and
// reads the custom emoji of the lines of `<chat>` and of `<meanwhile>`. The labels are the test's own.
const LEGEND_LABELS = {
  ...shippedLabels,
  transcript: { ...shippedLabels.transcript, stickerRef: '[sticker {name}]' },
  legend: {
    line: '{name} {platformName}: {text}',
    lineNoText: 'NOTEXT {name} {platformName}',
    unreadable: 'UNSEEN {name} {platformName}',
  },
};

type NameRow = {
  name: string;
  kind: 'emoji' | 'sticker';
  iface: string;
  nativeId: string;
  platformName: string;
  animated: boolean;
};

const NAME_ROWS: ReadonlyArray<NameRow> = [
  { name: 'e23', kind: 'emoji', iface: 'discord', nativeId: '901', platformName: 'pogcat', animated: false },
  { name: 'e24', kind: 'emoji', iface: 'discord', nativeId: '902', platformName: 'wavey', animated: false },
];

const rowOf = (name: string): NameRow | null => NAME_ROWS.find((row) => row.name === name) ?? null;

/** A reply whose trigger line reads `content` with `emojis`, and whose `<meanwhile>` holds the persona's line `elsewhere`. */
function legendRequest(content: string, emojis: Array<{ id: string; name: string }>, elsewhere: string): Built {
  const trigger = makeMessage('m1', NOW - MIN, { authorId: '111', authorName: 'Ελένη', content, emojis });
  return buildRequest(
    baseInput({
      config: fakeConfig({ context: { meanwhile: { messages: 8, around: 2 } } }),
      prompts: fakePrompts({ labels: LEGEND_LABELS }),
      frame: FRAME,
      whereabouts: { kind: 'place', iface: 'fake', private: false, chain: ROOM_CHAIN },
      history: [trigger],
      trigger,
      triggerKind: 'mention',
      nameOf,
      mind: mindOfEntries({ people: [ELENI] }),
      descriptions: new Map([
        ['emoji:901', 'a surprised cat face'],
        ['emoji:902', 'a cat waving a paw'],
      ]),
      mediaNameOf: rowOf,
      meanwhileReads: meanwhileReads([
        {
          id: 'place:room1',
          path: ['fake', 'Αγορά', 'αίθουσα1'],
          dm: false,
          lines: [line('place:room1', 'c1', NOW - 40 * MIN, null, elsewhere)],
        },
      ]),
    })
  );
}

/** The user message as one text. */
const userOf = (built: Built): string => {
  const [, message] = built.messages;
  return message.content.map((part) => String(part.text ?? '')).join('');
};

test('<media> stands as a root block after </meanwhile> and before <chat>, in the uncached tail', () => {
  // Bug: the legend lands in the cached memory segment, so a new emoji in the chat rewrites the cache; or it stands
  // after <chat>, below the lines that refer to it.
  const built = legendRequest('δες :e23:', [{ id: '901', name: 'e23' }], 'εκεί');
  const user = userOf(built);
  const legendAt = user.indexOf('\n<media>', user.indexOf('</meanwhile>'));
  assert.ok(user.indexOf('</meanwhile>') > 0, 'the request has <meanwhile>');
  assert.ok(legendAt > 0, user);
  assert.ok(legendAt < user.indexOf('<chat>'), '<media> before <chat>');
  const sent = withCacheMarker(built.messages, '1h');
  const parts = (sent[1].content as Array<{ text?: string; cache_control?: unknown }>).filter(
    (part) => typeof part.text === 'string'
  );
  const lastMarked = parts.findLastIndex((part) => Object.hasOwn(part, 'cache_control'));
  const next = String(parts[lastMarked + 1]?.text);
  assert.match(String(parts[lastMarked]?.text), /<\/meanwhile>\n\n$/, 'the cached part still ends with <meanwhile>');
  assert.match(next, /^<media>/, 'the tail opens with <media>');
});

test('an emoji used only in a <meanwhile> window still stands in <media>', () => {
  // Bug: the legend reads the chat alone, and the persona's own line elsewhere names an emoji they cannot look up.
  const built = legendRequest('γεια σου', [], 'τέλεια :e24:');
  const user = userOf(built);
  const legend = user.slice(user.indexOf('</meanwhile>'), user.indexOf('<chat>'));
  assert.ok(legend.includes('<media>'), user);
  assert.ok(legend.includes(':e24: wavey: a cat waving a paw'), legend);
  assert.ok(!legend.includes(':e23:'), 'only what occurs');
});

// A custom emoji stands in every text under its stable name, and its description stands once
// in the block `<media>` of the request that names it.
test('a past entry that names a custom emoji gives the diary turn <media> with its line', async () => {
  // Bug: the legend covers `<chat>` and `<meanwhile>` alone, so an entry in `<diary>` keeps a bare code.
  const run = await frameTurn({ emoji: 'named', entries: 2, entryGist: (index) => `ΣΕΛΙΔΑ-${index} :e1:` });
  const text = run.writer[0] ?? '';
  assert.ok(blockOf(text, 'media').includes(`:e1: ${EMOJI_NAME}`), text.slice(-1500));
});

const PROMPT_EMOJI_NOW = Date.UTC(2026, 8, 20, 10, 0, 0);

function promptEmojiFakeConfig(overrides: { caps?: object } = {}) {
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
    memory: {},
  };
}

function promptEmojiBaseInput(overrides = {}) {
  const input = {
    config: promptEmojiFakeConfig(),
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
    now: PROMPT_EMOJI_NOW,
    selfName: 'Nept',
    history: [
      {
        id: '1',
        ts: PROMPT_EMOJI_NOW - 60_000,
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

function userText(request: Built) {
  const secondMessage = request.messages[1];
  return contentText(secondMessage.content);
}

// ---- a custom emoji of the chat is described once, in <emoji> ----------------

function chatLine(id: string, content: string, emojis: Array<unknown>, ts = PROMPT_EMOJI_NOW - 60_000) {
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

// The block of custom emoji and stickers is <media>.
// ---- the legend: each custom emoji and sticker of the window described once, in <media> ----

// The legend is the root block `<media>`, grouped by interface and kind, present only when
// the window holds a custom emoji or a sticker. Labels are the test's own, values are read off the request.
const PROMPT_EMOJI_LEGEND_LABELS = {
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
function promptEmojiRowOf(name: string): Row | null {
  return ROWS.find((row) => row.name === name) ?? null;
}

function legendInput(history: Array<unknown>, descriptions: Map<string, string>) {
  return promptEmojiBaseInput({
    prompts: {
      main: 'SYSTEM',
      persona: 'CARD',
      rules: 'RULES',
      format: 'FORMAT',
      'turn/reply': 'REPLY_TASK',
      labels: PROMPT_EMOJI_LEGEND_LABELS,
    },
    history,
    descriptions,
    mediaNameOf: promptEmojiRowOf,
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
function promptEmojiKindLines(legend: string, iface: string, kind: string): Array<string> {
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
  // Bug: the description is lost with the bracket, or the legend misses the platform name the persona knows it by.
  const history = [chatLine('1', 'ωραίο :e23:', [{ id: '9', name: 'e23' }])];
  const built = buildRequest(legendInput(history, new Map([['emoji:9', 'a surprised cat face']])));
  const legend = legendOf(built);
  assert.deepEqual(promptEmojiKindLines(legend ?? '', 'discord', 'emojis'), [':e23: pogcat: a surprised cat face']);
  assert.ok(!(legend ?? '').includes('<stickers>'), 'no stickers subtag when no sticker occurs');
});

test('buildRequest: an emoji used in three lines has one legend line', () => {
  // Bug: the legend repeats a thing once per line that uses it.
  const emojis = [{ id: '9', name: 'e23' }];
  const history = [
    chatLine('1', ':e23:', emojis, PROMPT_EMOJI_NOW - 180_000),
    chatLine('2', 'ναι :e23:', emojis, PROMPT_EMOJI_NOW - 120_000),
    chatLine('3', ':e23: :e23:', emojis, PROMPT_EMOJI_NOW - 60_000),
  ];
  const built = buildRequest(legendInput(history, new Map([['emoji:9', 'a surprised cat face']])));
  assert.deepEqual(promptEmojiKindLines(legendOf(built) ?? '', 'discord', 'emojis'), [
    ':e23: pogcat: a surprised cat face',
  ]);
});

test('buildRequest: a sticker alone gives <stickers> and no <emojis>, and its chat line holds the stickerRef', () => {
  // Bug: an empty emoji subtag is printed, or the sticker keeps its description in the line.
  const history = [{ ...chatLine('1', '', []), stickers: [stickerOf('51', 's12', 'https://x/51.png')] }];
  const built = buildRequest(legendInput(history, new Map([['sticker:51', 'a cat raising one paw']])));
  const legend = legendOf(built) ?? '';
  assert.deepEqual(promptEmojiKindLines(legend, 'discord', 'stickers'), ['s12 hello_cat: a cat raising one paw']);
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
  assert.deepEqual(promptEmojiKindLines(legend, 'discord', 'emojis'), ['NOTEXT :e24: wavey']);
  assert.deepEqual(promptEmojiKindLines(legend, 'discord', 'stickers'), ['UNSEEN s13 dance_loop']);
});

test('buildRequest: a description of 1,400 characters stands whole in its legend line', () => {
  // Bug: the legend shortens a description as the old bracket did, and the persona loses the end of it.
  const long = `${'a long careful description of a cat. '.repeat(38)}END`.slice(-1400);
  assert.equal(long.length, 1400);
  const history = [chatLine('1', ':e23:', [{ id: '9', name: 'e23' }])];
  const built = buildRequest(legendInput(history, new Map([['emoji:9', long]])));
  assert.deepEqual(promptEmojiKindLines(legendOf(built) ?? '', 'discord', 'emojis'), [`:e23: pogcat: ${long}`]);
});

// A stable name in any block of the persona's request has its line in the one `<media>` block, not only
// the names of `<chat>` and `<meanwhile>`. One block per request, one line per thing, none when no block names one.
const CAT = ':e23: pogcat: a surprised cat face';

function anyBlockInput(overrides: Record<string, unknown>) {
  return promptEmojiBaseInput({
    prompts: {
      main: 'SYSTEM',
      persona: 'CARD',
      rules: 'RULES',
      format: 'FORMAT',
      'turn/reply': 'REPLY_TASK',
      'diary/task': 'DIARY_TASK',
      labels: PROMPT_EMOJI_LEGEND_LABELS,
    },
    history: [chatLine('1', 'γεια σου', [])],
    descriptions: new Map([['emoji:9', 'a surprised cat face']]),
    mediaNameOf: promptEmojiRowOf,
    ...overrides,
  });
}

/** The bodies of every `<media>` block of the request's user text. */
function mediaBlocks(request: Built): Array<string> {
  return [...userText(request).matchAll(/<media>\n([\s\S]*?)\n<\/media>/g)].map((match) => match[1] ?? '');
}

test('buildRequest: a self claim that names an emoji gives <media> its line', () => {
  // Bug: the persona's stored claim about themselves shows a bare `:e23:` with no line that says what it is.
  const built = buildRequest(anyBlockInput({ placeMemory: { self: ['ends a good day with :e23:'] } }));
  assert.deepEqual(
    mediaBlocks(built).map((body) => promptEmojiKindLines(body, 'discord', 'emojis')),
    [[CAT]]
  );
});

test('buildRequest: an intention whose text names an emoji gives <media> its line', () => {
  // Bug: `<intentions>` holds the stable name the persona promised to send and no block says what it is.
  const built = buildRequest(anyBlockInput({ intentions: 'send Zoé :e23: tonight' }));
  assert.deepEqual(
    mediaBlocks(built).map((body) => promptEmojiKindLines(body, 'discord', 'emojis')),
    [[CAT]]
  );
});

test('buildRequest: a diary scene that names an emoji gives the diary request <media> its line', () => {
  // Bug: the scene in `<inner>` keeps the stable name and the persona reads a bare code.
  // Changed: the planner's plan went with the planner, so the scene stands where the plan stood.
  const diary = { posts: [], kind: 'story', scenes: ['a calm day :e23:'] };
  const built = buildRequest(anyBlockInput({ mode: 'diary', diary }));
  assert.deepEqual(
    mediaBlocks(built).map((body) => promptEmojiKindLines(body, 'discord', 'emojis')),
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
    mediaBlocks(built).map((body) => promptEmojiKindLines(body, 'discord', 'emojis')),
    [[CAT]]
  );
});

test('buildRequest: no <media> block when only a self claim with no stable name stands', () => {
  // Bug: the wider legend prints an empty block on a request that names nothing.
  const built = buildRequest(anyBlockInput({ placeMemory: { self: ['ends a good day with tea'] } }));
  assert.deepEqual(mediaBlocks(built), []);
});
