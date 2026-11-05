// The transcript's GIF handles of buildRequest (src/behavior/prompt.ts), a turn that carries no GIF library, and the
// line of a library GIF media.find writes (src/behavior/prompt.ts#gifLine). Stage B7 of plan 2026-11-04-cli-and-memory
// took `<gifs>`, `<gifs_recent>` and `senses.gifs` out of the turn: the tests of that block's order, cap and own-post mark
// went with it, and the candidate list has its tests in tests/media-pick.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gifFieldChars, gifLine, userText as contentText } from '../src/behavior/prompt.ts';
import { rankGifs } from '../src/memory/gifs.ts';
import { labels } from './fixtures/labels.ts';
import { buildRequest, type Built, type Part } from './fixtures/built-request.ts';

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
    // PR 7d: the GIF list's measures are constants (25 entries, 40 and 70 characters a field, 24 hours of own posts).
    llm: { maxRequestTokens: 50000 },
    lore: { scanMessages: 30 },
    memory: {},
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
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
  return rankGifs(gifs, 30).map((entry) =>
    gifLine(entry, mediaCache, given, { ...gifFieldChars(), ownMarkHours: 0, now: 0 })
  );
}

function gifsBlock(request: Built) {
  const match = /<gifs>\n([\s\S]*?)\n<\/gifs>/.exec(userText(request));
  return match ? match[1].split('\n') : null;
}

function sensesOf(request: Built) {
  const match = /<senses>\n([\s\S]*?)\n<\/senses>/.exec(userText(request));
  return match ? match[1] : '';
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

test('buildRequest: a library, empty or not, gives no <gifs> block and no senses line', () => {
  for (const input of [baseInput({ gifs: library([]) }), baseInput(), baseInput({ gifs: THREE })]) {
    const request = buildRequest(input);
    assert.equal(gifsBlock(request), null);
    assert.ok(!sensesOf(request).includes(labels.senses.gifs));
  }
});

test('buildRequest: a labels.json without the gifs keys renders no block and no senses line', () => {
  const older = { ...labels, gifs: undefined, senses: { ...labels.senses, gifs: undefined } };
  const request = buildRequest(baseInput({ gifs: THREE, prompts: { ...baseInput().prompts, labels: older } }));
  assert.equal(gifsBlock(request), null);
  assert.ok(!userText(request).includes('undefined'));
});

/** A full-sentence caption of about 190 characters, the shape the describer stores. */
function longCaption(n: number) {
  return `Un chat roux numéro ${n} danse sur une table de cuisine en agitant les pattes, puis il glisse lentement et tombe sur le dos pendant que quelqu'un rit derrière la caméra du téléphone.`;
}

test('gifLine: cuts an older one-line caption to gifs.actionChars at a word boundary with an ellipsis; the stored caption is untouched', () => {
  const caption = longCaption(2);
  const mediaCache = { k2: { text: caption, ts: NOW } };
  // PR 7d: `gifs.actionChars` is the constant 70.
  const lines = findLines(THREE, mediaCache);
  const line = lines[0];
  assert.ok(line.startsWith('g2 -- '), line);
  const shown = line.slice('g2 -- '.length);
  assert.ok([...shown].length <= 70, shown);
  assert.ok(shown.endsWith('…'), 'the cut is marked');
  const kept = shown.slice(0, -1);
  assert.ok(caption.startsWith(kept), 'a prefix of the caption');
  assert.equal(caption[kept.length], ' ', 'cut where a word ends');
  assert.equal(mediaCache.k2.text, caption);

  const short = { k2: { text: 'a cat', ts: NOW } };
  assert.equal(findLines(THREE, short)[0], 'g2 -- a cat');
});

test('gifLine: renders a three-field caption through labels.gifs.entryFields', () => {
  const mediaCache = {
    k2: {
      text: 'a cat lifts its chin',
      reaction: 'firm agreement',
      action: 'a cat lifts its chin',
      screen: 'ναί.',
      ts: NOW,
      watched: true,
      gif: true,
    },
    k3: { text: 'a man runs', ts: NOW, watched: true, gif: true },
  };
  const lines = findLines(THREE, mediaCache);
  assert.deepEqual(
    lines,
    ['g2 -- firm agreement; a cat lifts its chin; "ναί."', 'g3 -- a man runs', 'g1'],
    'an older caption keeps labels.gifs.entry'
  );
});

test('gifLine: empty fields leave no dangling separator or empty quotes', () => {
  const entryOf = (fields: Record<string, string>) => {
    const mediaCache = {
      k2: { text: fields.action || fields.reaction || fields.screen, ...fields, ts: NOW, watched: true, gif: true },
    };
    return findLines(library([linkEntry(2, 9)]), mediaCache)[0];
  };
  assert.equal(
    entryOf({ reaction: '', action: 'a caracal stares', screen: "j'attends" }),
    'g2 -- a caracal stares; "j\'attends"',
    'no reaction'
  );
  assert.equal(
    entryOf({ reaction: 'waiting', action: 'a caracal stares', screen: '' }),
    'g2 -- waiting; a caracal stares',
    'no on-screen text'
  );
  assert.equal(
    entryOf({ reaction: 'waiting', action: '', screen: "j'attends" }),
    'g2 -- waiting; "j\'attends"',
    'no action'
  );
  assert.equal(
    entryOf({ reaction: '', action: 'a caracal stares', screen: '' }),
    'g2 -- a caracal stares',
    'the action alone'
  );
});

test('gifLine: entryFields keeps the label as written around the fields; a brace in a caption stays text', () => {
  const custom = { ...labels, gifs: { ...labels.gifs, entryFields: '[{id}] {action} ({reaction}) «{text}» end' } };
  const mediaCache = {
    k2: { text: 'a {id} sign', reaction: '', action: 'a {id} sign', screen: 'όχι', ts: NOW, watched: true, gif: true },
  };
  assert.equal(findLines(library([linkEntry(2, 9)]), mediaCache, custom)[0], '[g2] a {id} sign «όχι» end');
});

test('gifLine: gifs.reactionChars and gifs.actionChars cut a three-field caption at render time, the cache untouched', () => {
  // PR 7d: `gifs.reactionChars` and `gifs.actionChars` are the constants 40 and 70, so the fields are longer than that.
  const reaction = 'quiet firm agreement with a slow nod and a small smile that says yes';
  const mediaCache = {
    k2: {
      text: 'a cat lifts its chin',
      reaction,
      action: 'a cat lifts its chin slowly, looks at the camera, blinks twice and turns away from the window light',
      screen: 'yes yes yes yes yes yes yes yes yes yes yes yes yes yes',
      ts: NOW,
      watched: true,
      gif: true,
    },
  };
  assert.equal(
    findLines(library([linkEntry(2, 9)]), mediaCache)[0],
    'g2 -- quiet firm agreement with a slow nod…; a cat lifts its chin slowly, looks at the camera, blinks twice and…; "yes yes yes yes yes yes yes yes yes yes…"'
  );
  assert.equal(mediaCache.k2.reaction, reaction);
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

// A 60-character on-screen text, stored whole by the describer.
const WHOLE_SCREEN = 'Ἐν ἀρχῇ ἦν ὁ λόγος καὶ ὁ λόγος ἦν πρὸς τὸν θεόν, καὶ θεὸς ἦν';

test('buildRequest: a whole stored on-screen text is still cut per field in the line and in the chat', () => {
  const mediaCache = {
    k2: {
      text: 'a cat lifts its chin',
      reaction: 'firm agreement',
      action: 'a cat lifts its chin',
      screen: WHOLE_SCREEN,
      ts: NOW,
      watched: true,
      gif: true,
    },
  };
  const history = [
    {
      ...baseInput().history[0],
      links: [{ id: 'k2', kind: 'gif', url: 'https://tenor.com/view/gif-2', site: 'Tenor', title: 'Danse 2' }],
    },
  ];
  const descriptions = new Map([['k2', 'a cat lifts its chin']]);
  const request = buildRequest(baseInput({ gifs: library([linkEntry(2, 9)]), mediaCache, history, descriptions }));
  const line = findLines(library([linkEntry(2, 9)]), mediaCache)[0];
  const screen = line.match(/"(.*)"$/)![1];
  assert.ok([...screen].length <= 40 && screen.endsWith('…'), `the library cuts the on-screen text: ${screen}`);
  assert.ok(
    userText(request).includes(`[gif g2 -- firm agreement; a cat lifts its chin; "${screen}"]`),
    'the chat cuts it the same way'
  );
  assert.equal(mediaCache.k2.screen, WHOLE_SCREEN, 'the cache untouched');
});
