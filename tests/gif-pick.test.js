// Tests for src/behavior/gif-pick.js: the GIF picker's pure side -- its settings,
// when it runs, the whole captioned library it lists and how its answer is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  GIF_PICK_DEFAULTS,
  captionedEntries,
  gifPickSettings,
  parseGifPick,
  pickCandidates,
  pickContext,
  renderGifLibrary,
} from '../src/behavior/gif-pick.js';
import { labels } from './fixtures/labels.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const HOUR = 3_600_000;
const SETTINGS = { maxChars: 20, contextMessages: 4, maxOutputTokens: 60 };
// The per-field caps off: every caption whole.
const WHOLE = { reactionChars: 0, actionChars: 0 };

/** A ranked library entry (rankGifs' shape) with its handle and item id. */
function entry(id, fields = {}) {
  return {
    key: `k-${id}`,
    id,
    kind: 'link',
    url: `https://tenor.com/view/${id}`,
    itemId: `item-${id}`,
    count: 1,
    last: NOW - HOUR,
    ...fields,
  };
}

test("gifPickSettings: each key read from gifs.pick, an unusable one takes config.json's value", () => {
  assert.deepEqual(
    gifPickSettings({ gifs: { pick: { maxChars: 30.7, contextMessages: 0, maxOutputTokens: 9, graceMs: 250.9 } } }),
    { maxChars: 30, contextMessages: 0, maxOutputTokens: 9, graceMs: 250 }
  );
  assert.deepEqual(
    gifPickSettings({ gifs: { pick: { maxChars: -1, contextMessages: 'x', maxOutputTokens: 0, graceMs: -5 } } }),
    { ...GIF_PICK_DEFAULTS }
  );
  assert.equal(
    gifPickSettings({ gifs: { pick: { graceMs: null } } }).graceMs,
    null,
    'null: wait for the answer however long'
  );
  assert.deepEqual(gifPickSettings({}), { ...GIF_PICK_DEFAULTS });
});

test('config.json: gifs.pick equals the code defaults and the picker ships on', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.gifs.pick, { ...GIF_PICK_DEFAULTS });
  assert.equal(config.features.gifPicker, true);
});

test('pickCandidates: a short reply, no GIF of its own and a captioned library run the picker', () => {
  assert.equal(pickCandidates({ text: 'ναι, σίγουρα', postsGif: false, captioned: 3 }, SETTINGS), true);
});

test('pickCandidates: the length counts code points and maxChars is inclusive', () => {
  const twenty = 'é'.repeat(20);
  assert.equal(pickCandidates({ text: twenty, postsGif: false, captioned: 1 }, SETTINGS), true);
  assert.equal(pickCandidates({ text: `${twenty}é`, postsGif: false, captioned: 1 }, SETTINGS), false);
  assert.equal(
    pickCandidates({ text: '😀'.repeat(20), postsGif: false, captioned: 1 }, SETTINGS),
    true,
    'an emoji is one code point'
  );
});

test('pickCandidates: under gifs.pick.maxChars 160 a 160-character message is a candidate, 161 is not', () => {
  const settings = gifPickSettings({ gifs: { pick: { maxChars: 160 } } });
  const long = 'ά'.repeat(160);
  assert.equal(pickCandidates({ text: long, postsGif: false, captioned: 1 }, settings), true);
  assert.equal(pickCandidates({ text: `${long}ά`, postsGif: false, captioned: 1 }, settings), false);
});

test('pickCandidates: a turn posting a GIF, an empty library or an empty reply skip the picker', () => {
  assert.equal(pickCandidates({ text: 'ναι', postsGif: true, captioned: 3 }, SETTINGS), false);
  assert.equal(pickCandidates({ text: 'ναι', postsGif: false, captioned: 0 }, SETTINGS), false);
  assert.equal(pickCandidates({ text: '  ', postsGif: false, captioned: 3 }, SETTINGS), false);
  assert.equal(pickCandidates(null, SETTINGS), false);
});

test('captionedEntries: the entries with a cached caption, in the given order; a miss, blank text or no cache leaves one out', () => {
  const entries = [entry('g1'), entry('g2'), entry('g3'), entry('g4')];
  const mediaCache = {
    'item-g1': { text: 'νεύμα' },
    'item-g2': { miss: true },
    'item-g3': { text: '   ' },
    'item-g4': { text: 'Crème' },
  };
  assert.deepEqual(
    captionedEntries(entries, mediaCache, 70).map((e) => e.id),
    ['g1', 'g4']
  );
  assert.deepEqual(captionedEntries(entries, null, 70), []);
  assert.deepEqual(captionedEntries(null, mediaCache, 70), []);
});

test('renderGifLibrary: every captioned entry, in the given order, through labels.gifs.entry; uncaptioned ones left out', () => {
  const entries = Array.from({ length: 50 }, (_, i) => entry(`g${i + 1}`));
  const mediaCache = Object.fromEntries(
    entries.filter((_, i) => i !== 1).map((e) => [e.itemId, { text: `κάτι ${e.id}` }])
  );
  mediaCache['item-g3'] = { miss: true };
  const lines = renderGifLibrary(entries, mediaCache, labels, { now: NOW, ownMarkHours: 24, ...WHOLE });
  assert.equal(lines.length, 48, 'the whole library, not a top slice; g2 has no caption, g3 a miss');
  assert.equal(lines[0], 'g1 -- κάτι g1');
  assert.equal(lines[1], 'g4 -- κάτι g4');
  assert.equal(lines.includes(labels.gifs.header), false, 'no header');
});

test("renderGifLibrary: the persona's recent post carries the own mark within ownMarkHours, not past it", () => {
  const entries = [entry('g1', { ownLast: NOW - 2 * HOUR }), entry('g2', { ownLast: NOW - 30 * HOUR })];
  const mediaCache = { 'item-g1': { text: 'χαμόγελο' }, 'item-g2': { text: 'νεύμα' } };
  assert.deepEqual(
    renderGifLibrary(entries, mediaCache, labels, { now: NOW, ownMarkHours: 24, ...WHOLE }),
    ['g2 -- νεύμα', 'g1 -- χαμόγελο (you, 2 h)'],
    'the marked one after the unmarked'
  );
  assert.deepEqual(
    renderGifLibrary(entries, mediaCache, labels, { now: NOW, ownMarkHours: 0, ...WHOLE }),
    ['g1 -- χαμόγελο', 'g2 -- νεύμα'],
    '0 = never'
  );
});

test('renderGifLibrary: an older one-line caption is cut to actionChars at a word boundary, marked with an ellipsis', () => {
  const mediaCache = { 'item-g1': { text: 'ένας γάτος χορεύει πάνω στο τραπέζι' } };
  const [line] = renderGifLibrary([entry('g1')], mediaCache, labels, {
    now: NOW,
    ownMarkHours: 24,
    reactionChars: 0,
    actionChars: 12,
  });
  assert.equal(line, 'g1 -- ένας γάτος…');
});

test('renderGifLibrary: a three-field caption renders as the main request does, through labels.gifs.entryFields', () => {
  const entries = [entry('g1', { ownLast: NOW - 2 * HOUR }), entry('g2')];
  const mediaCache = {
    'item-g1': {
      text: 'a cat lifts its chin',
      reaction: 'firm agreement',
      action: 'a cat lifts its chin',
      screen: 'yes.',
      watched: true,
      gif: true,
    },
    'item-g2': {
      text: 'a caracal stares ahead',
      reaction: 'waiting',
      action: 'a caracal stares ahead',
      screen: '',
      watched: true,
      gif: true,
    },
  };
  assert.deepEqual(
    renderGifLibrary(entries, mediaCache, labels, { now: NOW, ownMarkHours: 24, reactionChars: 40, actionChars: 70 }),
    ['g2 -- waiting; a caracal stares ahead', 'g1 -- firm agreement; a cat lifts its chin; "yes." (you, 2 h)']
  );
});

test('renderGifLibrary: own-marked entries come after all unmarked ones, each group in the given order', () => {
  const entries = [
    entry('g1', { ownLast: NOW - 1 * HOUR }),
    entry('g2'),
    entry('g3', { ownLast: NOW - 3 * HOUR }),
    entry('g4'),
    entry('g5', { ownLast: NOW - 30 * HOUR }),
  ];
  const mediaCache = Object.fromEntries(entries.map((e) => [e.itemId, { text: 'κάτι ' + e.id }]));
  const lines = renderGifLibrary(entries, mediaCache, labels, { now: NOW, ownMarkHours: 24, ...WHOLE });
  assert.deepEqual(lines, [
    'g2 -- κάτι g2',
    'g4 -- κάτι g4',
    'g5 -- κάτι g5',
    'g1 -- κάτι g1 (you, 1 h)',
    'g3 -- κάτι g3 (you, 3 h)',
  ]);
});

test('renderGifLibrary: no entries, no cache or labels without gifs.entry list nothing', () => {
  assert.deepEqual(renderGifLibrary([], {}, labels, { now: NOW, ownMarkHours: 24, ...WHOLE }), []);
  assert.deepEqual(renderGifLibrary([entry('g1')], null, labels, { now: NOW, ownMarkHours: 24, ...WHOLE }), []);
  const noEntry = { ...labels, gifs: { ...labels.gifs, entry: undefined } };
  assert.deepEqual(
    renderGifLibrary([entry('g1')], { 'item-g1': { text: 'χαμόγελο' } }, noEntry, {
      now: NOW,
      ownMarkHours: 24,
      ...WHOLE,
    }),
    []
  );
});

/** A chat line of the picker's history. */
function line(id) {
  return { id, ts: NOW, authorName: 'Zoé', content: `λόγια ${id}` };
}

test('pickContext: the last contextMessages lines; the answered line among them is named by its place', () => {
  const history = ['m1', 'm2', 'm3', 'm4', 'm5'].map(line);
  const last = pickContext(history, { contextMessages: 3, answeredId: 'm5' });
  assert.deepEqual([last.messages.map((m) => m.id), last.answeredIndex], [['m3', 'm4', 'm5'], 3]);
  const inside = pickContext(history, { contextMessages: 3, answeredId: 'm4' });
  assert.deepEqual(
    [inside.messages.map((m) => m.id), inside.answeredIndex],
    [['m3', 'm4', 'm5'], 2],
    'not the last line'
  );
});

test('pickContext: an older answered line comes first, before the last lines', () => {
  const history = ['m1', 'm2', 'm3', 'm4', 'm5'].map(line);
  const older = pickContext(history, { contextMessages: 2, answeredId: 'm1' });
  assert.deepEqual([older.messages.map((m) => m.id), older.answeredIndex], [['m1', 'm4', 'm5'], 1]);
});

test('pickContext: an unknown answered line, none, or 0 context lines mark nothing', () => {
  const history = ['m1', 'm2', 'm3'].map(line);
  assert.deepEqual(pickContext(history, { contextMessages: 2, answeredId: 'elsewhere' }), {
    messages: history.slice(1),
    answeredIndex: null,
  });
  assert.deepEqual(pickContext(history, { contextMessages: 2 }), { messages: history.slice(1), answeredIndex: null });
  assert.deepEqual(pickContext(history, { contextMessages: 0, answeredId: 'm1' }), {
    messages: [],
    answeredIndex: null,
  });
  assert.deepEqual(pickContext(null, { contextMessages: 2, answeredId: 'm1' }), { messages: [], answeredIndex: null });
});

test('parseGifPick: a single line equal to a listed handle, trimmed and in any case, returns the listed handle', () => {
  const handles = ['g1', 'g12', 'g172'];
  assert.equal(parseGifPick('g172', handles), 'g172');
  assert.equal(parseGifPick('  G12 \n', handles), 'g12');
});

test('parseGifPick: none, an unlisted handle, extra text, several lines or no text return null', () => {
  const handles = ['g1', 'g12'];
  for (const answer of ['none', 'NONE', 'g2', 'g1 fits', 'g1\ng12', '`g1`', '', null, undefined]) {
    assert.equal(parseGifPick(answer, handles), null, String(answer));
  }
  assert.equal(parseGifPick('g1', []), null);
});
