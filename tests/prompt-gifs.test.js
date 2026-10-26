// The `<gifs>` block, the `senses.gifs` line and the transcript's GIF handles
// of buildRequest (src/behavior/prompt.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, userText as contentText } from '../src/behavior/prompt.js';
import { formatDuration } from '../src/format.js';
import { labels } from './fixtures/labels.js';

const NOW = Date.UTC(2026, 8, 20, 10, 0, 0);
const DAY = 86_400_000;

function fakeConfig(overrides = {}) {
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
      vision: { maxImages: 0, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
      customEmoji: { max: 30 },
    },
    features: { vision: false, ...overrides.features },
    gifs: { max: 20, halfLifeDays: 30, ...overrides.gifs },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
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
    calibrator: { ratio: 1, apply: (n) => n },
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
    guildMemory: {},
    interlocutor: null,
    otherProfiles: [],
    ...overrides,
  };
}

/** A library entry: a link GIF keyed `k<n>` with handle `g<n>`. */
function linkEntry(n, count, last = NOW - DAY) {
  return {
    id: `g${n}`,
    kind: 'link',
    url: `https://tenor.com/view/gif-${n}`,
    site: 'Tenor',
    name: `Danse ${n}`,
    itemId: `k${n}`,
    messageId: `m${n}`,
    channelId: 'c1',
    count,
    last,
    firstSeen: last,
  };
}

function library(entries, nextId = 100) {
  return { nextId, entries: Object.fromEntries(entries.map((entry) => [entry.itemId, entry])), backfill: null };
}

function userText(request) {
  return contentText(request.messages[1].content);
}

function gifsBlock(request) {
  const match = /<gifs>\n([\s\S]*?)\n<\/gifs>/.exec(userText(request));
  return match ? match[1].split('\n') : null;
}

function sensesOf(request) {
  const match = /<senses>\n([\s\S]*?)\n<\/senses>/.exec(userText(request));
  return match ? match[1] : '';
}

const THREE = library([linkEntry(1, 2), linkEntry(2, 9), linkEntry(3, 5)]);

test('buildRequest: <gifs> lists the library by rank, header first, handles only without captions', () => {
  const lines = gifsBlock(buildRequest(baseInput({ gifs: THREE })));
  assert.deepEqual(lines, [labels.gifs.header, 'g2', 'g3', 'g1']);
});

test('buildRequest: <gifs> shows only the top gifs.max entries (read at use)', () => {
  const config = fakeConfig({ gifs: { max: 2 } });
  const lines = gifsBlock(buildRequest(baseInput({ config, gifs: THREE })));
  assert.deepEqual(lines, [labels.gifs.header, 'g2', 'g3']);
});

test("buildRequest: <gifs> attaches the cached caption under the entry's itemId, entryNoText otherwise", () => {
  const mediaCache = {
    k2: { text: 'a cat dancing on a ὄρνις', ts: NOW },
    k3: { miss: 'error', ts: NOW },
  };
  const lines = gifsBlock(buildRequest(baseInput({ gifs: THREE, mediaCache })));
  assert.deepEqual(lines, [labels.gifs.header, 'g2 -- a cat dancing on a ὄρνις', 'g3', 'g1']);
});

test('buildRequest: features.gifs off -> no <gifs> block, no senses line, no handles in the chat', () => {
  const config = fakeConfig({ features: { gifs: false } });
  const history = [
    {
      ...baseInput().history[0],
      links: [{ id: 'k2', kind: 'gif', url: 'https://tenor.com/view/gif-2', site: 'Tenor', title: 'Danse 2' }],
    },
  ];
  const request = buildRequest(baseInput({ config, gifs: THREE, history }));
  assert.equal(gifsBlock(request), null);
  assert.ok(!sensesOf(request).includes(labels.senses.gifs));
  assert.ok(userText(request).includes('[gif: Danse 2]'));
});

test('buildRequest: an empty or missing library -> no <gifs> block and no senses line', () => {
  const empty = buildRequest(baseInput({ gifs: library([]) }));
  assert.equal(gifsBlock(empty), null);
  assert.ok(!sensesOf(empty).includes(labels.senses.gifs));
  const none = buildRequest(baseInput());
  assert.equal(gifsBlock(none), null);
  assert.ok(!sensesOf(none).includes(labels.senses.gifs));
});

test('buildRequest: senses.gifs shows when the feature is on and the library is non-empty', () => {
  const request = buildRequest(baseInput({ gifs: THREE }));
  assert.ok(sensesOf(request).split('\n').includes(labels.senses.gifs));
});

test('buildRequest: a labels.json without the gifs keys renders no block and no senses line', () => {
  const older = { ...labels, gifs: undefined, senses: { ...labels.senses, gifs: undefined } };
  const request = buildRequest(baseInput({ gifs: THREE, prompts: { ...baseInput().prompts, labels: older } }));
  assert.equal(gifsBlock(request), null);
  assert.ok(!userText(request).includes('undefined'));
});

test('buildRequest: context.caps.gifs trims entries from the bottom, a cap below the header drops the block', () => {
  const many = library(Array.from({ length: 20 }, (_, i) => linkEntry(i + 1, 40 - i)));
  const full = buildRequest(baseInput({ gifs: many }));
  assert.equal(gifsBlock(full).length, 21);

  const tight = buildRequest(baseInput({ gifs: many, config: fakeConfig({ caps: { gifs: 20 } }) }));
  const lines = gifsBlock(tight);
  assert.ok(lines.length > 1 && lines.length < 21);
  assert.equal(lines[0], labels.gifs.header);
  assert.deepEqual(
    lines.slice(1),
    Array.from({ length: lines.length - 1 }, (_, i) => `g${i + 1}`)
  );
  assert.ok(tight.stats.gifs.used <= 20);

  const none = buildRequest(baseInput({ gifs: many, config: fakeConfig({ caps: { gifs: 1 } }) }));
  assert.equal(gifsBlock(none), null);
});

/** A full-sentence caption of about 190 characters, the shape the describer stores. */
function longCaption(n) {
  return `Un chat roux numéro ${n} danse sur une table de cuisine en agitant les pattes, puis il glisse lentement et tombe sur le dos pendant que quelqu'un rit derrière la caméra du téléphone.`;
}

test('buildRequest: <gifs> cuts an older one-line caption to gifs.actionChars at a word boundary with an ellipsis; the stored caption is untouched', () => {
  const caption = longCaption(2);
  const mediaCache = { k2: { text: caption, ts: NOW } };
  const config = fakeConfig({ gifs: { actionChars: 40 } });
  const lines = gifsBlock(buildRequest(baseInput({ config, gifs: THREE, mediaCache })));
  const line = lines[1];
  assert.ok(line.startsWith('g2 -- '), line);
  const shown = line.slice('g2 -- '.length);
  assert.ok([...shown].length <= 40, shown);
  assert.ok(shown.endsWith('…'), 'the cut is marked');
  const kept = shown.slice(0, -1);
  assert.ok(caption.startsWith(kept), 'a prefix of the caption');
  assert.equal(caption[kept.length], ' ', 'cut where a word ends');
  assert.equal(mediaCache.k2.text, caption);

  const short = { k2: { text: 'a cat', ts: NOW } };
  assert.equal(gifsBlock(buildRequest(baseInput({ config, gifs: THREE, mediaCache: short })))[1], 'g2 -- a cat');
});

test('buildRequest: <gifs> renders a three-field caption through labels.gifs.entryFields', () => {
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
  const lines = gifsBlock(buildRequest(baseInput({ gifs: THREE, mediaCache })));
  assert.deepEqual(
    lines,
    [labels.gifs.header, 'g2 -- firm agreement; a cat lifts its chin; "ναί."', 'g3 -- a man runs', 'g1'],
    'an older caption keeps labels.gifs.entry'
  );
});

test('buildRequest: empty fields leave no dangling separator or empty quotes', () => {
  const entryOf = (fields) => {
    const mediaCache = {
      k2: { text: fields.action || fields.reaction || fields.screen, ...fields, ts: NOW, watched: true, gif: true },
    };
    return gifsBlock(buildRequest(baseInput({ gifs: library([linkEntry(2, 9)]), mediaCache })))[1];
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

test('buildRequest: entryFields keeps the label as written around the fields; a brace in a caption stays text', () => {
  const custom = { ...labels, gifs: { ...labels.gifs, entryFields: '[{id}] {action} ({reaction}) «{text}» end' } };
  const mediaCache = {
    k2: { text: 'a {id} sign', reaction: '', action: 'a {id} sign', screen: 'όχι', ts: NOW, watched: true, gif: true },
  };
  const input = baseInput({ gifs: library([linkEntry(2, 9)]), mediaCache });
  input.prompts = { ...input.prompts, labels: custom };
  assert.equal(gifsBlock(buildRequest(input))[1], '[g2] a {id} sign «όχι» end');
});

test('buildRequest: gifs.reactionChars and gifs.actionChars cut a three-field caption at render time, the cache untouched', () => {
  const mediaCache = {
    k2: {
      text: 'a cat lifts its chin',
      reaction: 'quiet firm agreement',
      action: 'a cat lifts its chin slowly',
      screen: 'yes yes yes',
      ts: NOW,
      watched: true,
      gif: true,
    },
  };
  const config = fakeConfig({ gifs: { reactionChars: 8, actionChars: 14 } });
  assert.equal(
    gifsBlock(buildRequest(baseInput({ config, gifs: library([linkEntry(2, 9)]), mediaCache })))[1],
    'g2 -- quiet…; a cat lifts…; "yes yes…"'
  );
  assert.equal(mediaCache.k2.reaction, 'quiet firm agreement');
});

test('buildRequest: with gifs.actionChars the same context.caps.gifs holds more entries than with full captions', () => {
  const many = library(Array.from({ length: 40 }, (_, i) => linkEntry(i + 1, 80 - i)));
  const mediaCache = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`k${i + 1}`, { text: longCaption(i + 1), ts: NOW }])
  );
  const shownWith = (actionChars) => {
    const config = fakeConfig({ gifs: { max: 40, actionChars }, caps: { gifs: 900 } });
    return gifsBlock(buildRequest(baseInput({ config, gifs: many, mediaCache }))).length - 1;
  };
  const full = shownWith(0);
  const clamped = shownWith(70);
  assert.ok(full > 0 && full < 40, `full captions: ${full}`);
  assert.ok(clamped > full, `clamped ${clamped} vs full ${full}`);
});

test('buildRequest: <gifs> closes the stable part, right after <about_chat>; <server> and <emoji> follow in the tail', () => {
  const guildMemory = { patterns: 'short lines' };
  const history = [{ ...baseInput().history[0], channelId: 'c1', channelName: 'general' }];
  const customEmoji = [{ id: '1', name: 'alpha' }];
  const request = buildRequest(baseInput({ gifs: THREE, customEmoji, guildMemory, history, currentChannelId: 'c1' }));
  const text = userText(request);
  const aboutIdx = text.indexOf('<about_chat>');
  const gifsIdx = text.indexOf('<gifs>\n');
  const serverIdx = text.indexOf('<server>');
  const emojiIdx = text.indexOf('<emoji>\n');
  assert.ok(aboutIdx !== -1 && emojiIdx !== -1 && gifsIdx !== -1 && serverIdx !== -1);
  assert.ok(aboutIdx < gifsIdx && gifsIdx < serverIdx && serverIdx < emojiIdx);
  const stable = request.messages[1].content[0];
  assert.equal(stable.cacheSegment, 'stable');
  assert.ok(stable.text.endsWith('</gifs>\n\n'), stable.text);
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

test('buildRequest: a whole stored on-screen text is still cut per field in <gifs> and in the chat', () => {
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
  const line = gifsBlock(request)[1];
  const screen = line.match(/"(.*)"$/)[1];
  assert.ok([...screen].length <= 40 && screen.endsWith('…'), `the library cuts the on-screen text: ${screen}`);
  assert.ok(
    userText(request).includes(`[gif g2 -- firm agreement; a cat lifts its chin; "${screen}"]`),
    'the chat cuts it the same way'
  );
  assert.equal(mediaCache.k2.screen, WHOLE_SCREEN, 'the cache untouched');
});

test('buildRequest: the chat cuts gifKnownFields by gifs.reactionChars / gifs.actionChars, read at the moment of use', () => {
  const mediaCache = {
    k2: {
      text: 'a cat lifts its chin slowly',
      reaction: 'quiet firm agreement',
      action: 'a cat lifts its chin slowly',
      screen: 'yes yes yes',
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
  const descriptions = new Map([['k2', 'a cat lifts its chin slowly']]);
  const config = fakeConfig({ gifs: { reactionChars: 8, actionChars: 14 } });
  const text = userText(
    buildRequest(baseInput({ config, gifs: library([linkEntry(2, 9)]), mediaCache, history, descriptions }))
  );
  assert.ok(text.includes('[gif g2 -- quiet…; a cat lifts…; "yes yes…"]'), text);
});

const HOUR = 3_600_000;

/** THREE with g2 posted by the persona `agoMs` before NOW and g3 posted 30 h before. */
function withOwnPosts(agoMs) {
  return library([
    linkEntry(1, 2),
    { ...linkEntry(2, 9), ownLast: NOW - agoMs, ownUses: 2 },
    { ...linkEntry(3, 5), ownLast: NOW - 30 * HOUR, ownUses: 1 },
  ]);
}

function gifsRecentBlock(request) {
  const match = /<gifs_recent>\n([\s\S]*?)\n<\/gifs_recent>/.exec(userText(request));
  return match ? match[1].split('\n') : null;
}

test('buildRequest: <gifs> never marks a gif the persona posted; <gifs_recent> in the tail names it with gifs.ownMark and its age', () => {
  const config = fakeConfig({ gifs: { ownMarkHours: 24 } });
  const request = buildRequest(baseInput({ config, gifs: withOwnPosts(2 * HOUR) }));
  assert.deepEqual(gifsBlock(request), [labels.gifs.header, 'g2', 'g3', 'g1'], 'rank order, no mark');
  assert.deepEqual(
    gifsRecentBlock(request),
    [`g2 (you, ${formatDuration(2 * HOUR, labels.units)})`],
    'g3 is outside the window'
  );
  // In the tail: after the stable part's <gifs>, never inside a cached part.
  const parts = request.messages[1].content;
  assert.ok(!parts.filter((part) => part.cacheSegment).some((part) => part.text.includes('<gifs_recent>')));
  assert.ok(userText(request).indexOf('<gifs_recent>') > userText(request).indexOf('</gifs>'));
});

test("buildRequest: <gifs_recent> lists the persona's posts newest first, only GIFs the <gifs> list shows", () => {
  const config = fakeConfig({ gifs: { ownMarkHours: 24, max: 3 } });
  const gifs = library([
    { ...linkEntry(1, 9), ownLast: NOW - 3 * HOUR },
    linkEntry(2, 7),
    { ...linkEntry(3, 5), ownLast: NOW - HOUR },
    { ...linkEntry(4, 1), ownLast: NOW - 10 * 60_000 },
  ]);
  const request = buildRequest(baseInput({ config, gifs }));
  assert.deepEqual(gifsBlock(request), [labels.gifs.header, 'g1', 'g2', 'g3']);
  assert.deepEqual(gifsRecentBlock(request), [
    `g3 (you, ${formatDuration(HOUR, labels.units)})`,
    `g1 (you, ${formatDuration(3 * HOUR, labels.units)})`,
  ]);
});

test('buildRequest: gifs.ownMarkHours 0 -> no <gifs_recent>', () => {
  const config = fakeConfig({ gifs: { ownMarkHours: 0 } });
  const request = buildRequest(baseInput({ config, gifs: withOwnPosts(2 * HOUR) }));
  assert.deepEqual(gifsBlock(request), [labels.gifs.header, 'g2', 'g3', 'g1']);
  assert.equal(gifsRecentBlock(request), null);
});

test('buildRequest: a labels.json without gifs.ownMark -> no <gifs_recent>, the list unchanged', () => {
  const { ownMark, ...gifsLabels } = labels.gifs;
  const older = { ...labels, gifs: gifsLabels };
  const config = fakeConfig({ gifs: { ownMarkHours: 24 } });
  const request = buildRequest(
    baseInput({ config, gifs: withOwnPosts(2 * HOUR), prompts: { ...baseInput().prompts, labels: older } })
  );
  assert.deepEqual(gifsBlock(request), [older.gifs.header, 'g2', 'g3', 'g1']);
  assert.equal(gifsRecentBlock(request), null);
});
