// Tests for src/discord/format.js: pure transcript/time formatting. Every
// word comes from `labels` (tests/fixtures/labels.js is an English fixture
// covering the full prompt-contract key list); a second, non-English labels
// object proves nothing in the code is language-bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fill,
  fillGifFields,
  formatClock,
  formatDate,
  formatNow,
  formatDuration,
  localHour,
  formatTranscript,
  renderTranscript,
  computeTempo,
  renderTempo,
  withTriggers,
  withCalls,
} from '../src/discord/format.js';
import { labels } from './fixtures/labels.js';

const TZ = 'Europe/Moscow'; // fixed UTC+3, no DST -- safe for exact arithmetic in tests
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// A handful of non-Latin (Greek) values proves the code never assumes
// English/labels language; only the values differ, the code path is identical.
const grLabels = {
  ...labels,
  locale: 'el-GR',
  self: '{name} (εσύ)',
  units: { lessThanMinute: 'λιγότερο από ένα λεπτό', minute: 'λεπτό', hour: 'ώρα', day: 'μέρα' },
  transcript: {
    ...labels.transcript,
    gap: '--- πέρασαν {duration} ---',
    empty: '(κενό)',
  },
};

function msg(id, ts, overrides = {}) {
  return { id, ts, authorId: 'u1', authorName: 'Nick', content: 'text', channelId: 'c1', channelName: 'general', ...overrides };
}

// --- fill --------------------------------------------------------------

test('fill: leaves unknown keys untouched', () => {
  assert.equal(fill('{duration} passed', {}), '{duration} passed');
});

test('fill: a missing/empty template returns an empty string', () => {
  assert.equal(fill(undefined, { duration: '5 min' }), '');
  assert.equal(fill('', { duration: '5 min' }), '');
  assert.equal(fill(null, {}), '');
});

// --- clock / date / now / localHour -------------------------------------

test('formatClock: renders the time converted into the given timezone and locale', () => {
  const ts = Date.UTC(2026, 8, 20, 10, 30, 0); // 10:30 UTC -> 13:30 Moscow
  assert.equal(formatClock(ts, TZ, 'en-US'), '13:30');
});

test('formatClock: crossing midnight in the target timezone', () => {
  const ts = Date.UTC(2026, 8, 19, 21, 5, 0); // 21:05 UTC Sep 19 -> 00:05 Moscow Sep 20
  assert.equal(formatClock(ts, TZ, 'en-US'), '00:05');
});

test('formatDate: uses the LOCAL date, not the UTC date', () => {
  const ts = Date.UTC(2026, 8, 19, 21, 5, 0); // UTC date is the 19th, Moscow date is the 20th
  assert.equal(formatDate(ts, TZ, 'en-US'), formatDate(Date.UTC(2026, 8, 20, 0, 5, 0), TZ, 'en-US'));
});

test('formatNow: combines full date, clock and the timezone name', () => {
  const ts = Date.UTC(2026, 8, 20, 10, 30, 0);
  const now = formatNow(ts, TZ, 'en-US');
  assert.ok(now.includes('13:30'));
  assert.ok(now.includes('(Europe/Moscow)'));
});

test('localHour: returns the local hour 0-23 for the given timezone, locale-independent', () => {
  assert.equal(localHour(Date.UTC(2026, 8, 20, 10, 30, 0), TZ), 13);
  assert.equal(localHour(Date.UTC(2026, 8, 19, 21, 5, 0), TZ), 0);
});

// --- formatDuration boundaries -------------------------------------------

test('formatDuration: under a minute', () => {
  assert.equal(formatDuration(59_999, labels.units), 'less than a minute');
});

test('formatDuration: exactly one minute, and minutes under an hour, render as N min', () => {
  const rows = [
    { label: 'exactly one minute', ms: MIN, expected: '1 min' },
    { label: 'minutes under an hour', ms: 5 * MIN, expected: '5 min' },
  ];
  for (const { label, ms, expected } of rows) {
    assert.equal(formatDuration(ms, labels.units), expected, label);
  }
});

test('formatDuration: exactly one hour, no leftover minutes', () => {
  assert.equal(formatDuration(HOUR, labels.units), '1 h');
});

test('formatDuration: exactly one day, no leftover hours', () => {
  assert.equal(formatDuration(DAY, labels.units), '1 d');
});

test('formatDuration: days with leftover hours (contract example)', () => {
  assert.equal(formatDuration(2 * DAY + 4 * HOUR, labels.units), '2 d 4 h');
});

test('formatDuration: rounding at 59 min 30s+ rolls over to the hour form, not "60 min"', () => {
  const text = formatDuration(59 * MIN + 30_000, labels.units);
  assert.equal(text, '1 h');
  assert.ok(!text.includes('60'));
});

test('formatDuration: rounding at 23 h 59.5 min rolls over to the day form, not "24 h"', () => {
  const text = formatDuration(23 * HOUR + 59 * MIN + 30_000, labels.units);
  assert.equal(text, '1 d');
  assert.ok(!text.includes('24'));
});

// --- formatTranscript: gap markers and date changes -----------------------

test('formatTranscript: no marker for a gap under the threshold, same day', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0), msg('b', t0 + 5 * MIN)];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(!items[1].text.includes('passed'));
});

test('formatTranscript: a gap exactly at the threshold also gets a marker (inclusive), as does one over it', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const rows = [
    { label: 'a gap over the threshold gets a "passed" marker', gap: 25 * MIN, expected: '--- 25 min passed ---' },
    { label: 'a gap exactly at the threshold also gets a marker (inclusive)', gap: 20 * MIN, expected: '--- 20 min passed ---' },
  ];
  for (const { label, gap, expected } of rows) {
    const messages = [msg('a', t0), msg('b', t0 + gap)];
    const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
    assert.ok(items[1].text.startsWith(expected), `${label}: ${JSON.stringify(items[1].text)}`);
  }
});

test('formatTranscript: a date change under the gap threshold gets a plain date marker', () => {
  const before = Date.UTC(2026, 8, 19, 20, 55, 0);
  const after = Date.UTC(2026, 8, 19, 21, 4, 0);
  const messages = [msg('a', before), msg('b', after)];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  const expectedDate = formatDate(after, TZ, labels.locale);
  assert.ok(items[1].text.startsWith(`--- ${expectedDate} ---`));
});

test('formatTranscript: a gap over the threshold AND a date change combines both in one marker', () => {
  const before = Date.UTC(2026, 8, 19, 20, 0, 0);
  const after = Date.UTC(2026, 8, 19, 23, 12, 0); // gap 3h12m, day changes
  const messages = [msg('a', before), msg('b', after)];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  const expectedDate = formatDate(after, TZ, labels.locale);
  assert.ok(items[1].text.startsWith(`--- 3 h 12 min passed · ${expectedDate} ---`));
});

test('formatTranscript: labels drive the wording even for non-English deployments', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0), msg('b', t0 + 25 * MIN)];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels: grLabels });
  assert.ok(items[1].text.startsWith('--- πέρασαν 25 λεπτό ---'));
});

// --- formatTranscript: line ages against the request's clock --------------

const AGE_NOW = Date.UTC(2026, 8, 20, 10, 0, 0); // 13:00 Moscow
const ageOptions = { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels, ageMinutes: 60 };

test('formatTranscript: a chat line older than ageMinutes carries its age, a recent one keeps the bare clock', () => {
  const messages = [msg('a', AGE_NOW - 2 * HOUR), msg('b', AGE_NOW - 10 * MIN)];
  const items = formatTranscript(messages, { ...ageOptions, now: AGE_NOW });
  assert.equal(items[0].text, '#1 [11:00 · 2 h ago] Nick: text');
  // The gap marker keeps its own wording alongside the ages.
  assert.equal(items[1].text, '--- 1 h 50 min passed ---\n#2 [12:50] Nick: text');
});

test('formatTranscript: a line exactly ageMinutes old already carries its age', () => {
  const items = formatTranscript([msg('a', AGE_NOW - 30 * MIN)], { ...ageOptions, ageMinutes: 30, now: AGE_NOW });
  assert.equal(items[0].text, '#1 [12:30 · 30 min ago] Nick: text');
});

test('formatTranscript: the age follows the request clock, two clocks give two ages for the same lines', () => {
  const messages = [msg('a', AGE_NOW - 2 * HOUR)];
  const first = formatTranscript(messages, { ...ageOptions, now: AGE_NOW });
  const later = formatTranscript(messages, { ...ageOptions, now: AGE_NOW + 3 * HOUR + 15 * MIN });
  assert.equal(first[0].text, '#1 [11:00 · 2 h ago] Nick: text');
  assert.equal(later[0].text, '#1 [11:00 · 5 h 15 min ago] Nick: text');
});

test('formatTranscript: no now, no ages', () => {
  const items = formatTranscript([msg('a', AGE_NOW - 2 * HOUR)], ageOptions);
  assert.equal(items[0].text, '#1 [11:00] Nick: text');
});

test('formatTranscript: labels without transcript.timeAged (absent or blank) keep the plain head', () => {
  const messages = [msg('a', AGE_NOW - 2 * HOUR)];
  const { timeAged, ...olderTranscript } = labels.transcript;
  assert.ok(timeAged);
  for (const transcript of [olderTranscript, { ...labels.transcript, timeAged: '' }]) {
    const items = formatTranscript(messages, { ...ageOptions, labels: { ...labels, transcript }, now: AGE_NOW });
    assert.equal(items[0].text, '#1 [11:00] Nick: text');
  }
});

test('formatTranscript: memory mode never shows ages', () => {
  const items = formatTranscript([msg('a', AGE_NOW - 2 * HOUR, { authorId: '42' })], { ...ageOptions, mode: 'memory', now: AGE_NOW });
  assert.equal(items[0].text, '## #general (id:c1)\n[11:00] Nick (id:42): text');
});

test('formatTranscript: the date marker and the date header still render alongside ages', () => {
  const before = Date.UTC(2026, 8, 19, 20, 55, 0); // 23:55 Moscow
  const after = Date.UTC(2026, 8, 19, 21, 4, 0); // 00:04 Moscow, the next day
  const now = Date.UTC(2026, 8, 20, 9, 4, 0);
  const items = formatTranscript([msg('a', before), msg('b', after)], { ...ageOptions, now });
  assert.equal(items[0].text, '#1 [23:55 · 12 h 9 min ago] Nick: text');
  assert.equal(items[1].text, `--- ${formatDate(after, TZ, labels.locale)} ---\n#2 [00:04 · 12 h ago] Nick: text`);
  const rendered = renderTranscript(items, TZ, labels).split('\n');
  assert.equal(rendered[0], `=== ${formatDate(before, TZ, labels.locale)} ===`);
});

test('formatTranscript: a gap marker with a date change renders alongside ages', () => {
  const before = Date.UTC(2026, 8, 19, 20, 0, 0); // 23:00 Moscow
  const after = Date.UTC(2026, 8, 19, 23, 12, 0); // 02:12 Moscow, the next day
  const items = formatTranscript([msg('a', before), msg('b', after)], { ...ageOptions, now: after + 2 * HOUR });
  assert.equal(items[1].text, `--- 3 h 12 min passed · ${formatDate(after, TZ, labels.locale)} ---\n#2 [02:12 · 2 h ago] Nick: text`);
});

test('formatTranscript: the age head takes its wording and units from the labels', () => {
  const greek = { ...grLabels, transcript: { ...grLabels.transcript, timeAged: '[{clock} · πριν από {age}]' } };
  const items = formatTranscript([msg('a', AGE_NOW - 2 * HOUR)], { ...ageOptions, labels: greek, now: AGE_NOW });
  assert.equal(items[0].text, '#1 [11:00 · πριν από 2 ώρα] Nick: text');
});

// --- formatTranscript: indexOffset (a second block continues the numbering) ---

function offsetMessages() {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  return [
    msg('a', t0, { content: 'πρώτο' }),
    msg('b', t0 + MIN, { content: 'δεύτερο', replyToId: 'a' }),
    msg('c', t0 + 2 * MIN, { content: 'τρίτο', replyToId: 'outside' }),
    msg('d', t0 + 3 * MIN, { content: 'café', replyToId: 'b' }),
  ];
}

const offsetOptions = { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels };

test('formatTranscript: indexOffset shifts every index and reply target', () => {
  const items = formatTranscript(offsetMessages(), { ...offsetOptions, indexOffset: 7 });
  assert.deepEqual(
    items.map((item) => item.index),
    [8, 9, 10, 11],
  );
  assert.deepEqual(
    items.map((item) => item.text),
    [
      '#8 [13:00] Nick: πρώτο',
      '#9 [13:01] Nick: δεύτερο (replying to #8, Nick: "πρώτο")',
      '#10 [13:02] Nick: τρίτο (replying to an older message)',
      '#11 [13:03] Nick: café (replying to #9, Nick: "δεύτερο")',
    ],
  );
});

test('formatTranscript: no offset keeps 1..N', () => {
  const expected = [
    { id: 'a', index: 1, ts: Date.UTC(2026, 8, 20, 10, 0, 0), text: '#1 [13:00] Nick: πρώτο' },
    { id: 'b', index: 2, ts: Date.UTC(2026, 8, 20, 10, 1, 0), text: '#2 [13:01] Nick: δεύτερο (replying to #1, Nick: "πρώτο")' },
    { id: 'c', index: 3, ts: Date.UTC(2026, 8, 20, 10, 2, 0), text: '#3 [13:02] Nick: τρίτο (replying to an older message)' },
    { id: 'd', index: 4, ts: Date.UTC(2026, 8, 20, 10, 3, 0), text: '#4 [13:03] Nick: café (replying to #2, Nick: "δεύτερο")' },
  ];
  assert.deepEqual(formatTranscript(offsetMessages(), offsetOptions), expected);
  assert.deepEqual(formatTranscript(offsetMessages(), { ...offsetOptions, indexOffset: undefined }), expected);
  assert.deepEqual(formatTranscript(offsetMessages(), { ...offsetOptions, indexOffset: null }), expected);
  assert.deepEqual(formatTranscript(offsetMessages(), { ...offsetOptions, indexOffset: 0 }), expected);
});

// --- formatTranscript: a reply quotes its parent ---------------------------

test('formatTranscript: a reply to the persona names its self label and quotes its line', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, { self: true, authorName: 'Nept', content: 'πάμε για καφέ' }),
    msg('b', t0 + MIN, { content: 'ναι!', replyToId: 'a' }),
  ];
  const items = formatTranscript(messages, { ...offsetOptions, replyQuoteChars: 40 });
  assert.equal(items[1].text, '#2 [13:01] Nick: ναι! (replying to #1, Nept (you): "πάμε για καφέ")');
});

test('formatTranscript: a long parent is quoted on one line, cut at a word boundary with an ellipsis', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, { authorName: 'Éloïse', content: 'je préfère\nles penalties à la dernière minute, toujours' }),
    msg('b', t0 + MIN, { content: 'ok', replyToId: 'a' }),
  ];
  const items = formatTranscript(messages, { ...offsetOptions, replyQuoteChars: 24 });
  assert.equal(items[1].text, '#2 [13:01] Nick: ok (replying to #1, Éloïse: "je préfère les…")');
});

test('formatTranscript: a media-only parent quotes its media label; one with nothing quotes an empty string', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, { content: '', attachments: [{ id: 'p1', kind: 'image' }] }),
    msg('b', t0 + MIN, { content: '' }),
    msg('c', t0 + 2 * MIN, { content: 'ωραίο', replyToId: 'a' }),
    msg('d', t0 + 3 * MIN, { content: 'τι;', replyToId: 'b' }),
  ];
  const items = formatTranscript(messages, { ...offsetOptions, replyQuoteChars: 40 });
  assert.equal(items[2].text, '#3 [13:02] Nick: ωραίο (replying to #1, Nick: "[image]")');
  assert.equal(items[3].text, '#4 [13:03] Nick: τι; (replying to #2, Nick: "")');
});

test('formatTranscript: an indexOffset given but not a whole number of at least 0 throws a RangeError', () => {
  // A caller bug (say NaN from summing an undefined count) must not silently
  // renumber a second block from #1 over the chat's own indices.
  for (const indexOffset of [-3, 2.5, Number.NaN, Infinity, '4', {}]) {
    assert.throws(() => formatTranscript(offsetMessages(), { ...offsetOptions, indexOffset }), RangeError, String(indexOffset));
  }
});

test('formatTranscript: indexOffset in memory mode moves only item.index, the text has no #index', () => {
  const plain = formatTranscript(offsetMessages(), { ...offsetOptions, mode: 'memory' });
  const shifted = formatTranscript(offsetMessages(), { ...offsetOptions, mode: 'memory', indexOffset: 5 });
  assert.deepEqual(
    shifted.map((item) => item.text),
    plain.map((item) => item.text),
  );
  assert.deepEqual(
    shifted.map((item) => item.index),
    [6, 7, 8, 9],
  );
});

test('formatTranscript: attachments and stickers get tagged', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, {
      content: '',
      attachments: [{ kind: 'image' }, { kind: 'file', name: 'report.pdf' }],
      stickers: [{ id: 's1', name: 'pepe', format: 1, url: 'https://media.discordapp.net/stickers/s1.png?size=160' }],
    }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(items[0].text.includes('[image]'));
  assert.ok(items[0].text.includes('[file: report.pdf]'));
  assert.ok(items[0].text.includes('[sticker: pepe]'));
});

test('formatTranscript: a media tag rendering empty (missing label key) never leaves a double space', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const noImageLabel = { ...labels, transcript: { ...labels.transcript, image: undefined } };
  const messages = [
    msg('a', t0, {
      content: 'text before',
      attachments: [{ kind: 'image' }],
      stickers: [{ id: 's1', name: 'pepe', format: 1, url: 'https://media.discordapp.net/stickers/s1.png?size=160' }],
    }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels: noImageLabel });
  assert.ok(!items[0].text.includes('  '), `expected no double space, got: ${JSON.stringify(items[0].text)}`);
  assert.ok(items[0].text.includes('text before [sticker: pepe]'));
});

test('formatTranscript: a forward with an empty-rendering media tag never leaves a double space', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const noImageLabel = { ...labels, transcript: { ...labels.transcript, image: undefined } };
  const messages = [
    msg('a', t0, {
      content: '',
      forwardedFrom: null,
      forwarded: [{ content: 'the news', attachments: [{ kind: 'image' }], links: [], stickers: [] }],
    }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels: noImageLabel });
  assert.ok(!items[0].text.includes('  '), `expected no double space, got: ${JSON.stringify(items[0].text)}`);
  assert.ok(items[0].text.includes('[forwarded: the news]'));
});

test('formatTranscript: content longer than maxChars is truncated with an ellipsis', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const items = formatTranscript([msg('a', t0, { content: 'a'.repeat(10) })], {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 5,
    selfName: 'Nept',
    labels,
  });
  assert.ok(items[0].text.includes('aaaaa…'));
  assert.ok(!items[0].text.includes('aaaaaa'));
});

test('formatTranscript: mode "memory" drops the #index and adds the user id, a reply outside the list renders replyToOld', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0, { authorName: 'Nick', authorId: '42', content: 'hello', replyToId: 'ghost' })];
  const items = formatTranscript(messages, {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
    mode: 'memory',
  });
  assert.equal(items[0].text.split('\n').at(-1), '[13:00] Nick (id:42): hello (replying to an older message)');
  assert.ok(!items[0].text.includes('#1'));
});

test('formatTranscript: mode "memory" marks a reply to a member\'s line with replyToMemory, no #index', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, { authorName: 'Éloïse', authorId: '7', content: 'je préfère\nles penalties à la dernière minute, toujours' }),
    msg('b', t0 + MIN, { authorName: 'Nick', authorId: '42', content: 'ok', replyToId: 'a', attachments: [{ id: 'p1', kind: 'image' }] }),
  ];
  const items = formatTranscript(messages, { ...offsetOptions, mode: 'memory', replyQuoteChars: 24 });
  assert.equal(items[1].text, '[13:01] Nick (id:42): ok (reply to Éloïse: je préfère les…) [image]');
});

test('formatTranscript: mode "memory" names the persona\'s self label in a reply to its own line', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, { self: true, authorName: 'Nept', content: 'πάμε για καφέ' }),
    msg('b', t0 + MIN, { authorName: 'Nick', authorId: '42', content: 'ναι!', replyToId: 'a' }),
  ];
  const items = formatTranscript(messages, { ...offsetOptions, mode: 'memory', replyQuoteChars: 40 });
  assert.equal(items[1].text, '[13:01] Nick (id:42): ναι! (reply to Nept (you): πάμε για καφέ)');
});

test('formatTranscript: the memory reply marker leaves chat mode output unchanged', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, { authorName: 'Éloïse', content: 'πάμε' }),
    msg('b', t0 + MIN, { content: 'ναι!', replyToId: 'a', attachments: [{ id: 'p1', kind: 'image' }] }),
    msg('c', t0 + 2 * MIN, { content: 'τι;', replyToId: 'ghost' }),
  ];
  const items = formatTranscript(messages, { ...offsetOptions, replyQuoteChars: 40 });
  assert.equal(items[1].text, '#2 [13:01] Nick: ναι! (replying to #1, Éloïse: "πάμε") [image]');
  assert.equal(items[2].text, '#3 [13:02] Nick: τι; (replying to an older message)');
});

test('formatTranscript: mode "memory" marks a message addressed to the persona with a leading arrow', () => {
  const t0 = Date.UTC(2026, 8, 20, 14, 32, 0);
  const items = formatTranscript([msg('a', t0, { authorName: 'nick', authorId: '1', content: 'text', direct: true })], {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
    mode: 'memory',
  });
  const lines = items[0].text.split('\n');
  assert.equal(lines.at(-1), '→ [17:32] nick (id:1): text');
});

test('formatTranscript: mode "memory" leaves a non-direct message unmarked', () => {
  const t0 = Date.UTC(2026, 8, 20, 14, 32, 0);
  const items = formatTranscript([msg('a', t0, { authorName: 'nick', authorId: '1', content: 'text', direct: false })], {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
    mode: 'memory',
  });
  const lines = items[0].text.split('\n');
  assert.equal(lines.at(-1), '[17:32] nick (id:1): text');
  assert.ok(!items[0].text.includes('→'));
});

test('formatTranscript: "direct" has no effect in chat mode', () => {
  const t0 = Date.UTC(2026, 8, 20, 14, 32, 0);
  const items = formatTranscript([msg('a', t0, { content: 'text', direct: true })], {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
  });
  assert.ok(!items[0].text.includes('→'));
});

test('formatTranscript: mode "memory" for the persona\'s own line omits the id', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const items = formatTranscript([msg('a', t0, { self: true, content: 'hi' })], {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
    mode: 'memory',
  });
  assert.ok(items[0].text.includes('Nept (you): hi'));
  const messageLine = items[0].text.split('\n').at(-1);
  assert.ok(!messageLine.includes('(id:'));
});

// --- formatTranscript: mode "memory" groups by channel ----------------------

test('formatTranscript: mode "memory" does not repeat the heading while the channel stays the same', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, { channelId: 'c1', channelName: 'general' }),
    msg('b', t0 + MIN, { channelId: 'c1', channelName: 'general' }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels, mode: 'memory' });
  assert.ok(!items[1].text.includes('##'));
});

test('formatTranscript: mode "memory" opens a new heading when the channel changes', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, { channelId: 'c1', channelName: 'general' }),
    msg('b', t0 + MIN, { channelId: 'c2', channelName: 'random' }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels, mode: 'memory' });
  assert.ok(items[0].text.startsWith('## #general (id:c1)\n'));
  assert.ok(items[1].text.startsWith('## #random (id:c2)\n'));
});

test('formatTranscript: mode "memory" re-opens a heading when returning to a previously-seen channel', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, { channelId: 'c1', channelName: 'general' }),
    msg('b', t0 + MIN, { channelId: 'c2', channelName: 'random' }),
    msg('c', t0 + 2 * MIN, { channelId: 'c1', channelName: 'general' }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels, mode: 'memory' });
  assert.ok(items[2].text.startsWith('## #general (id:c1)\n'));
});

test('formatTranscript: mode "memory" gap markers are computed within a channel run, not across a switch', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, { channelId: 'c1', channelName: 'general' }),
    // Big gap AND a channel switch: must show only the heading, no "passed" marker.
    msg('b', t0 + 5 * HOUR, { channelId: 'c2', channelName: 'random' }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels, mode: 'memory' });
  assert.ok(!items[1].text.includes('passed'));
  assert.ok(items[1].text.startsWith('## #random (id:c2)\n'));
});

test('formatTranscript: mode "memory" still marks a gap within the same channel run', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, { channelId: 'c1', channelName: 'general' }),
    msg('b', t0 + 25 * MIN, { channelId: 'c1', channelName: 'general' }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels, mode: 'memory' });
  assert.ok(items[1].text.includes('25 min passed'));
});

test('formatTranscript: chat mode never adds a channel heading, even across a channelId change', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0, { channelId: 'c1' }), msg('b', t0 + MIN, { channelId: 'c2' })];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(!items[0].text.includes('##'));
  assert.ok(!items[1].text.includes('##'));
});

// --- formatTranscript: new media forms (images, gifs, video, voice, audio,
// links, forwarded, imageAttached) ------------------------------------------

test('formatTranscript: an image attached to this request renders imageAttached with its index', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0, { content: '', attachments: [{ id: 'att1', kind: 'image', name: 'pic.png' }] })];
  const attachedIndex = new Map([['att1', 2]]);
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels, attachedIndex });
  assert.ok(items[0].text.includes('[picture #2, attached]'));
});

test('formatTranscript: an attached image with a caption renders imageAttachedDescribed, marker and caption together', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0, { content: '', attachments: [{ id: 'att1', kind: 'image', name: 'pic.png' }] })];
  const attachedIndex = new Map([['att1', 2]]);
  const descriptions = new Map([['att1', 'a grey cat sleeping']]);
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels, attachedIndex, descriptions });
  assert.ok(items[0].text.includes('[picture #2, attached; helper caption: a grey cat sleeping]'));
});

test('formatTranscript: an older labels.json with no imageAttachedDescribed key falls back to the bare imageAttached', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const oldLabels = { ...labels, transcript: { ...labels.transcript, imageAttachedDescribed: undefined } };
  const messages = [msg('a', t0, { content: '', attachments: [{ id: 'att1', kind: 'image', name: 'pic.png' }] })];
  const attachedIndex = new Map([['att1', 1]]);
  const descriptions = new Map([['att1', 'a grey cat sleeping']]);
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels: oldLabels, attachedIndex, descriptions });
  assert.ok(items[0].text.includes('[picture #1, attached]'));
  assert.ok(!items[0].text.includes('grey cat'));
});

// --- formatTranscript: a plain 'link' embed's thumbnail can be described too
// -- the link/linkText tag itself never swaps, one extra tag follows.

test('formatTranscript: a link thumbnail description appends thumbnailDescribed, the link tag stays', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, {
      content: '',
      links: [{ id: 'link:abcd1234', kind: 'link', site: 'YouTube', title: 'Cool video', thumbnailUrl: 'https://i.ytimg.com/x.jpg' }],
    }),
  ];
  const blind = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(blind[0].text.includes('[link: YouTube — Cool video]'));
  assert.ok(!blind[0].text.includes('thumbnail'));

  const described = formatTranscript(messages, {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
    descriptions: new Map([['link:abcd1234', 'a cat plays piano']]),
  });
  assert.ok(described[0].text.includes('[link: YouTube — Cool video] [thumbnail: a cat plays piano]'));
});

test('formatTranscript: an older labels.json with no thumbnailDescribed key renders the plain link tag only', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const oldLabels = { ...labels, transcript: { ...labels.transcript, thumbnailDescribed: undefined } };
  const messages = [
    msg('a', t0, {
      content: '',
      links: [{ id: 'link:abcd1234', kind: 'link', site: 'YouTube', title: 'Cool video', thumbnailUrl: 'https://i.ytimg.com/x.jpg' }],
    }),
  ];
  const items = formatTranscript(messages, {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels: oldLabels,
    descriptions: new Map([['link:abcd1234', 'a cat plays piano']]),
  });
  assert.ok(items[0].text.includes('[link: YouTube — Cool video]'));
  assert.ok(!items[0].text.includes('a cat plays piano'));
  assert.ok(!items[0].text.includes('  '), 'no stray double space from the omitted tag');
});

// --- formatTranscript: video states ------------------------------------

function videoTranscript(messages, extra = {}) {
  return formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels, ...extra });
}

const T0 = Date.UTC(2026, 8, 20, 10, 0, 0);
const videoMsg = () => msg('a', T0, { content: '', attachments: [{ id: 'v1', kind: 'video', name: 'clip.mp4', durationSec: 65 }] });
const ytLink = { id: 'link:abcd1234', kind: 'link', site: 'YouTube', title: 'Cool video', thumbnailUrl: 'https://i.ytimg.com/x.jpg' };

test('formatTranscript: a watched video renders videoWatched', () => {
  const items = videoTranscript([videoMsg()], { videos: new Map([['v1', { state: 'watched', text: 'a dog runs' }]]) });
  assert.ok(items[0].text.endsWith('[video: clip.mp4, 1:05, watched: a dog runs]'));
});

test('formatTranscript: the reason code is swapped for its label, for all four codes', () => {
  const cases = [
    [{ state: 'limit', reason: 'length' }, 'too long'],
    [{ state: 'limit', reason: 'size' }, 'too big'],
    [{ state: 'limit', reason: 'daily' }, 'daily limit'],
    [{ state: 'error' }, 'failed'],
  ];
  for (const [video, label] of cases) {
    const items = videoTranscript([videoMsg()], { videos: new Map([['v1', video]]) });
    assert.ok(items[0].text.endsWith(`[video: clip.mp4, 1:05, not watched: ${label}]`), items[0].text);
  }
});

test('formatTranscript: a reason code missing from labels.transcript.videoReason renders empty, never the code', () => {
  const partial = { ...labels, transcript: { ...labels.transcript, videoReason: undefined } };
  const items = videoTranscript([videoMsg()], { labels: partial, videos: new Map([['v1', { state: 'error' }]]) });
  assert.ok(items[0].text.endsWith('[video: clip.mp4, 1:05, not watched: ]'));
  assert.ok(!items[0].text.includes('error'));
});

test('formatTranscript: a watched link keeps the link tag, linkWatched follows', () => {
  const messages = [msg('a', T0, { content: '', links: [ytLink] })];
  const items = videoTranscript(messages, {
    descriptions: new Map([['link:abcd1234', 'a stage']]),
    videos: new Map([['link:abcd1234', { state: 'watched', text: 'a talk about bridges' }]]),
  });
  assert.ok(items[0].text.endsWith('[link: YouTube — Cool video] [watched: a talk about bridges]'));
  assert.ok(!items[0].text.includes('[thumbnail:'));
});

test('formatTranscript: a forwarded snapshot\'s video also reads its state', () => {
  const messages = [
    msg('a', T0, {
      content: '',
      forwarded: [{ content: '', attachments: [{ id: 'v9', kind: 'video', name: 'ρολόι.mp4', durationSec: 3 }], links: [] }],
    }),
  ];
  const items = videoTranscript(messages, { videos: new Map([['v9', { state: 'watched', text: 'a clock ticks' }]]) });
  assert.ok(items[0].text.includes('[forwarded: [video: ρολόι.mp4, 0:03, watched: a clock ticks]]'));
});

test('formatTranscript: labels without the video keys render byte-for-byte as before, video states ignored', () => {
  const oldTranscript = { ...labels.transcript };
  for (const key of ['videoWatched', 'videoNotWatched', 'videoNotWatchedFrame', 'linkWatched', 'linkNotWatched', 'linkNotWatchedFrame', 'videoReason']) {
    delete oldTranscript[key];
  }
  const oldLabels = { ...labels, transcript: oldTranscript };
  const messages = [
    msg('a', T0, { content: 'look', attachments: [{ id: 'v1', kind: 'video', name: 'clip.mp4', durationSec: 65 }], links: [ytLink] }),
  ];
  const context = {
    attachedIndex: new Map([['link:abcd1234', 1]]),
    descriptions: new Map([['v1', 'a dog runs']]),
  };
  const before = videoTranscript(messages, { labels: oldLabels, ...context });
  const after = videoTranscript(messages, {
    labels: oldLabels,
    ...context,
    videos: new Map([
      ['v1', { state: 'watched', text: 'the whole clip' }],
      ['link:abcd1234', { state: 'error' }],
    ]),
  });
  assert.equal(after[0].text, before[0].text);
  assert.ok(before[0].text.endsWith('look [video: clip.mp4, 1:05: a dog runs] [link: YouTube — Cool video] [its still frame is attached image 1]'));
});

// --- formatTranscript: stickers ---------------------------------------

function stickerItem(id, name, url) {
  return { id, name, url };
}

test('formatTranscript: a described sticker (not attached) renders stickerDescribed', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0, { content: '', stickers: [stickerItem('s1', 'pepe', 'https://x/s1.png')] })];
  const items = formatTranscript(messages, {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
    descriptions: new Map([['sticker:s1', 'a frog giving a thumbs up']]),
  });
  assert.ok(items[0].text.includes('[sticker: pepe: a frog giving a thumbs up]'));
});

test('formatTranscript: an older labels.json with no stickerDescribed key falls back to the plain sticker tag', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const oldLabels = { ...labels, transcript: { ...labels.transcript, stickerDescribed: undefined } };
  const messages = [msg('a', t0, { content: '', stickers: [stickerItem('s1', 'pepe', 'https://x/s1.png')] })];
  const items = formatTranscript(messages, {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels: oldLabels,
    descriptions: new Map([['sticker:s1', 'a frog giving a thumbs up']]),
  });
  assert.ok(items[0].text.includes('[sticker: pepe]'));
  assert.ok(!items[0].text.includes('thumbs up'));
});

// --- formatTranscript: custom emoji -----------------------------------

test('formatTranscript: a described custom emoji appends ONE emojiDescribed tag, text keeps reading :name:', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0, { content: 'nice :pog:', emojis: [{ id: 'e1', name: 'pog' }] })];
  const items = formatTranscript(messages, {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
    descriptions: new Map([['emoji:e1', 'a surprised cat face']]),
  });
  assert.ok(items[0].text.includes('nice :pog: [:pog: a surprised cat face]'));
});

test('formatTranscript: an undescribed custom emoji renders no extra tag at all', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0, { content: 'nice :pog:', emojis: [{ id: 'e1', name: 'pog' }] })];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(items[0].text.endsWith('nice :pog:'));
  assert.ok(!items[0].text.includes('[:pog:'));
});

test('formatTranscript: an older labels.json with no emojiDescribed key renders no extra tag, today\'s behaviour', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const oldLabels = { ...labels, transcript: { ...labels.transcript, emojiDescribed: undefined } };
  const messages = [msg('a', t0, { content: 'nice :pog:', emojis: [{ id: 'e1', name: 'pog' }] })];
  const items = formatTranscript(messages, {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels: oldLabels,
    descriptions: new Map([['emoji:e1', 'a surprised cat face']]),
  });
  assert.equal(items[0].text.includes('a surprised cat face'), false);
  assert.ok(!items[0].text.includes('  '));
});

test('formatTranscript: emojiInline false keeps the bare :name: with no description tag', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0, { content: 'nice :pog:', emojis: [{ id: 'e1', name: 'pog' }] })];
  const items = formatTranscript(messages, {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
    descriptions: new Map([['emoji:e1', 'a surprised cat face']]),
    emojiInline: false,
  });
  assert.equal(items[0].text, '#1 [13:00] Nick: nice :pog:');
});

test('formatTranscript: a forwarded message-snapshot wraps its content and media in labels.transcript.forwarded', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, {
      content: '',
      forwarded: [{ content: 'look at this', attachments: [{ id: 'f1', kind: 'image', name: 'x.png' }], links: [], stickers: [] }],
    }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(items[0].text.includes('[forwarded: look at this [image]]'));
});

test('formatTranscript: a forward with a resolved source channel name uses labels.transcript.forwardedFrom', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, {
      content: '',
      forwardedFrom: 'announcements',
      forwarded: [{ content: 'big news', attachments: [], links: [], stickers: [] }],
    }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(items[0].text.includes('[forwarded from #announcements: big news]'));
  assert.ok(!items[0].text.includes('[forwarded: big news]'));
});

test('formatTranscript: a forward whose source channel is unresolved (forwardedFrom null) falls back to plain forwarded', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, {
      content: '',
      forwardedFrom: null,
      forwarded: [{ content: 'big news', attachments: [], links: [], stickers: [] }],
    }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(items[0].text.includes('[forwarded: big news]'));
});

test('formatTranscript: an older labels.json with no forwardedFrom key falls back to plain forwarded, even with a resolved channel', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const oldLabels = { ...labels, transcript: { ...labels.transcript, forwardedFrom: undefined } };
  const messages = [
    msg('a', t0, {
      content: '',
      forwardedFrom: 'announcements',
      forwarded: [{ content: 'big news', attachments: [], links: [], stickers: [] }],
    }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels: oldLabels });
  assert.ok(items[0].text.includes('[forwarded: big news]'));
});

test('formatTranscript: a media-only forwarded snapshot (no text) still renders its media inside the wrapper', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, {
      content: '',
      forwardedFrom: 'media-dump',
      forwarded: [{ content: '', attachments: [{ id: 'f1', kind: 'image', name: 'x.png' }], links: [], stickers: [] }],
    }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(items[0].text.includes('[forwarded from #media-dump: [image]]'));
});

// --- renderTranscript -------------------------------------------------------

test('renderTranscript: prefixes a date header taken from the first item', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const items = formatTranscript([msg('a', t0, { content: 'hi' })], {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
  });
  const rendered = renderTranscript(items, TZ, labels);
  const expectedDate = formatDate(t0, TZ, labels.locale);
  assert.ok(rendered.startsWith(`=== ${expectedDate} ===\n`));
});

// --- computeTempo ------------------------------------------------------------

test('computeTempo: with a trigger, the trigger message itself is excluded from counts', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const m1 = msg('a', now - 5 * MIN);
  const trigger = msg('t', now);
  const tempo = computeTempo([m1, trigger], now, trigger);
  assert.equal(tempo.last10min, 1); // only m1, trigger excluded
  assert.equal(tempo.hasTrigger, true);
});

test('computeTempo: silence before the trigger is measured to the trigger, not to "now"', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const m1 = msg('a', now - 30 * MIN);
  const trigger = msg('t', now - 5 * MIN); // trigger happened 5 min ago, processed just now
  const tempo = computeTempo([m1, trigger], now, trigger);
  assert.equal(tempo.silenceMs, 25 * MIN); // trigger.ts - m1.ts, not now - m1.ts
});

test('computeTempo: without a trigger, silence is measured up to "now"', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const m1 = msg('a', now - 15 * MIN);
  const tempo = computeTempo([m1], now, null);
  assert.equal(tempo.silenceMs, 15 * MIN);
  assert.equal(tempo.hasTrigger, false);
});

test('computeTempo: silenceMs is null for an empty channel', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const tempo = computeTempo([], now, null);
  assert.equal(tempo.silenceMs, null);
});

test('computeTempo: authorsLastHour counts distinct non-self authors only', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const messages = [
    msg('a', now - 10 * MIN, { authorId: 'u1' }),
    msg('b', now - 20 * MIN, { authorId: 'u1' }),
    msg('c', now - 30 * MIN, { authorId: 'u2' }),
    msg('d', now - 40 * MIN, { self: true, authorId: 'self' }),
  ];
  const tempo = computeTempo(messages, now, null);
  assert.equal(tempo.authorsLastHour, 2);
});

test('computeTempo: lastIsOwn reflects whether the very last message was the persona\'s', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const messages = [msg('a', now - 20 * MIN), msg('b', now - 5 * MIN, { self: true })];
  const tempo = computeTempo(messages, now, null);
  assert.equal(tempo.lastIsOwn, true);
});

test('computeTempo: sinceOwnMs is measured from "now", even in trigger mode', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const own = msg('a', now - 60 * MIN, { self: true });
  const trigger = msg('t', now - 5 * MIN);
  const tempo = computeTempo([own, trigger], now, trigger);
  assert.equal(tempo.sinceOwnMs, 60 * MIN);
});

test('computeTempo: sinceOwnMs is null when the persona has never posted', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const tempo = computeTempo([msg('a', now - MIN)], now, null);
  assert.equal(tempo.sinceOwnMs, null);
});

// --- renderTempo -------------------------------------------------------------

function baseTempo(overrides = {}) {
  return {
    last10min: 0,
    lastHour: 0,
    lastDay: 0,
    authorsLastHour: 0,
    silenceMs: 10 * MIN,
    lastIsOwn: false,
    sinceOwnMs: null,
    hasTrigger: false,
    ...overrides,
  };
}

// The verdict must look at silence, not only at message counts (a channel
// with 2 messages 4 minutes ago is live, not dead -- see the dry-run case
// below). The behaviour tests pin their own thresholds instead of leaning on
// the code fallback.
const THRESHOLDS = { liveMessages10min: 4, deadSilenceMinutes: 45 };

test('renderTempo: fewer messages in the last 10 min than the live threshold are not live', () => {
  const { verdictLive, verdictSlow, verdictDead } = labels.tempo;
  const rows = [
    {
      label: 'one under the live threshold is not live',
      tempo: { last10min: THRESHOLDS.liveMessages10min - 1, silenceMs: 10 * MIN },
      present: [],
      absent: [verdictLive],
    },
    {
      label: 'dry-run case -- 2 messages in the last 10 min, 4 min of silence -> "slow", not "dead"',
      tempo: { last10min: 2, silenceMs: 4 * MIN },
      present: [verdictSlow],
      absent: [verdictDead, verdictLive],
    },
  ];
  for (const { label, tempo, present, absent } of rows) {
    const text = renderTempo(baseTempo(tempo), labels, THRESHOLDS);
    for (const verdict of present) assert.ok(text.includes(verdict), `${label}: expected ${verdict}`);
    for (const verdict of absent) assert.ok(!text.includes(verdict), `${label}: unexpected ${verdict}`);
  }
});

test('renderTempo: messages at the live threshold -> the "live" verdict, even with long silence', () => {
  const text = renderTempo(baseTempo({ last10min: THRESHOLDS.liveMessages10min, silenceMs: 50 * MIN }), labels, THRESHOLDS);
  assert.ok(text.includes(labels.tempo.verdictLive));
});

test('renderTempo: silence just under the dead threshold -> the "slow" verdict, not dead', () => {
  const text = renderTempo(baseTempo({ last10min: 0, silenceMs: THRESHOLDS.deadSilenceMinutes * MIN - 1000 }), labels, THRESHOLDS);
  assert.ok(text.includes(labels.tempo.verdictSlow));
});

test('renderTempo: an empty channel (silenceMs null) -> the "dead" verdict', () => {
  const text = renderTempo(baseTempo({ last10min: 0, silenceMs: null }), labels, THRESHOLDS);
  assert.ok(text.includes(labels.tempo.verdictDead));
});

test('renderTempo: custom thresholds are honoured', () => {
  const thresholds = { liveMessages10min: 2, deadSilenceMinutes: 5 };
  const live = renderTempo(baseTempo({ last10min: 2, silenceMs: 0 }), labels, thresholds);
  assert.ok(live.includes(labels.tempo.verdictLive));
  const dead = renderTempo(baseTempo({ last10min: 0, silenceMs: 5 * MIN }), labels, thresholds);
  assert.ok(dead.includes(labels.tempo.verdictDead));
  const slow = renderTempo(baseTempo({ last10min: 0, silenceMs: 4 * MIN }), labels, thresholds);
  assert.ok(slow.includes(labels.tempo.verdictSlow));
});

test('renderTempo: silence exactly at the dead threshold -> "dead" (inclusive)', () => {
  const text = renderTempo(baseTempo({ last10min: 0, silenceMs: THRESHOLDS.deadSilenceMinutes * MIN }), labels, THRESHOLDS);
  assert.ok(text.includes(labels.tempo.verdictDead));
});

test('renderTempo: null silenceMs describes an empty channel', () => {
  const text = renderTempo(baseTempo({ silenceMs: null }), labels, THRESHOLDS);
  assert.ok(text.includes(labels.tempo.emptyChannel));
});

test('renderTempo: hasTrigger phrases silence via silenceBeforeTrigger', () => {
  const text = renderTempo(baseTempo({ hasTrigger: true, silenceMs: 5 * MIN }), labels, THRESHOLDS);
  assert.ok(text.includes('before the message that called you, the channel was silent for: 5 min'));
});

test('renderTempo: without a trigger, silence is phrased via lastMessageAgo', () => {
  const text = renderTempo(baseTempo({ hasTrigger: false, silenceMs: 5 * MIN }), labels, THRESHOLDS);
  assert.ok(text.includes('the last message in the channel was: 5 min ago'));
});

test('renderTempo: mentions when the last own message went unanswered (no trigger)', () => {
  const text = renderTempo(baseTempo({ lastIsOwn: true, hasTrigger: false }), labels, THRESHOLDS);
  assert.ok(text.includes(labels.tempo.ownUnanswered));
});

test('renderTempo: does not mention the unanswered line when there is a trigger', () => {
  const text = renderTempo(baseTempo({ lastIsOwn: true, hasTrigger: true }), labels, THRESHOLDS);
  assert.ok(!text.includes(labels.tempo.ownUnanswered));
});

test('format: the code fallbacks equal the values in config.json', () => {
  const shipped = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')).context;
  // Tempo: a thresholds argument that is missing, or missing a key, reads as the shipped pair.
  const { liveMessages10min, deadSilenceMinutes } = shipped.tempo;
  const probes = [
    { last10min: liveMessages10min - 1, silenceMs: 0 },
    { last10min: liveMessages10min, silenceMs: 0 },
    { last10min: 0, silenceMs: deadSilenceMinutes * MIN - 1 },
    { last10min: 0, silenceMs: deadSilenceMinutes * MIN },
  ];
  for (const probe of probes) {
    const expected = renderTempo(baseTempo(probe), labels, shipped.tempo);
    assert.equal(renderTempo(baseTempo(probe), labels), expected, JSON.stringify(probe));
    assert.equal(renderTempo(baseTempo(probe), labels, {}), expected, JSON.stringify(probe));
  }
  // Reactions per message: the omitted option reads as the shipped number.
  const T = Date.UTC(2026, 8, 20, 10, 0, 0);
  const reactions = Array.from({ length: shipped.reactionsPerMessage + 3 }, (_, i) => ({ emoji: `:e${i}:`, count: 1, mine: false }));
  const options = { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels };
  assert.deepEqual(
    formatTranscript([msg('1', T, { reactions })], options),
    formatTranscript([msg('1', T, { reactions })], { ...options, reactionsPerMessage: shipped.reactionsPerMessage }),
  );
  // The reply quote: the omitted option reads as the shipped length.
  const long = Array.from({ length: shipped.replyQuoteChars }, (_, i) => `λέξη${i}`).join(' ');
  const thread = [msg('1', T, { content: long }), msg('2', T + MIN, { replyToId: '1' })];
  const withShipped = formatTranscript(thread, { ...options, maxChars: 0, replyQuoteChars: shipped.replyQuoteChars });
  assert.notEqual(withShipped[1].text, formatTranscript(thread, { ...options, maxChars: 0, replyQuoteChars: shipped.replyQuoteChars + 10 })[1].text);
  assert.equal(formatTranscript(thread, { ...options, maxChars: 0 })[1].text, withShipped[1].text);
});

// --- formatTranscript: a second look on a question (videoAnswered) -----------------

const answered = { question: 'τι χρώμα είναι;', text: 'κόκκινο' };

test('formatTranscript: a watched video with an answer renders videoAnswered right after videoWatched', () => {
  const items = videoTranscript([videoMsg()], { videos: new Map([['v1', { state: 'watched', text: 'a dog runs', answer: answered }]]) });
  assert.ok(items[0].text.endsWith('[video: clip.mp4, 1:05, watched: a dog runs] [looked again for "τι χρώμα είναι;": κόκκινο]'));
});

test('formatTranscript: labels without videoAnswered render an answered video exactly as a plain watched one', () => {
  const oldLabels = { ...labels, transcript: { ...labels.transcript, videoAnswered: undefined } };
  const messages = [msg('a', T0, { content: '', attachments: [{ id: 'v1', kind: 'video', name: 'clip.mp4', durationSec: 65 }], links: [ytLink] })];
  const context = { attachedIndex: new Map([['v1', 1]]) };
  const plain = videoTranscript(messages, {
    labels: oldLabels,
    ...context,
    videos: new Map([
      ['v1', { state: 'watched', text: 'a dog runs' }],
      ['link:abcd1234', { state: 'watched', text: 'a talk' }],
    ]),
  });
  const withAnswers = videoTranscript(messages, {
    labels: oldLabels,
    ...context,
    videos: new Map([
      ['v1', { state: 'watched', text: 'a dog runs', answer: answered }],
      ['link:abcd1234', { state: 'watched', text: 'a talk', answer: answered }],
    ]),
  });
  assert.deepEqual(withAnswers, plain);
  assert.ok(!withAnswers[0].text.includes('κόκκινο'));
});

// --- formatTranscript: a second look at a picture (imageAnswers -> imageAnswered) ---

const pictureMsg = () => msg('a', T0, { content: '', attachments: [{ id: 'p1', kind: 'image', name: 'singes.png' }] });

test('formatTranscript: a picture with an answer renders imageAnswered right after its own tag, attached or not', () => {
  const imageAnswers = new Map([['p1', answered]]);
  const descriptions = new Map([['p1', 'deux singes']]);
  const plain = videoTranscript([pictureMsg()], { imageAnswers, descriptions });
  assert.ok(plain[0].text.endsWith('[image: deux singes] [picture checked again for "τι χρώμα είναι;": κόκκινο]'), plain[0].text);
  const attached = videoTranscript([pictureMsg()], { imageAnswers, attachedIndex: new Map([['p1', 1]]) });
  assert.ok(attached[0].text.endsWith(`${fill(labels.transcript.imageAttached, { n: 1 })} [picture checked again for "τι χρώμα είναι;": κόκκινο]`));
});

test('formatTranscript: an attached captioned picture keeps its answer when imageAttachedDescribed is blanked', () => {
  const oldLabels = { ...labels, transcript: { ...labels.transcript, imageAttachedDescribed: undefined } };
  const items = videoTranscript([pictureMsg()], {
    labels: oldLabels,
    imageAnswers: new Map([['p1', answered]]),
    descriptions: new Map([['p1', 'deux singes']]),
    attachedIndex: new Map([['p1', 1]]),
  });
  assert.ok(items[0].text.endsWith(`${fill(labels.transcript.imageAttached, { n: 1 })} [picture checked again for "τι χρώμα είναι;": κόκκινο]`));
});

test('formatTranscript: labels without imageAnswered render an answered picture exactly as a plain one', () => {
  const oldLabels = { ...labels, transcript: { ...labels.transcript, imageAnswered: undefined } };
  const descriptions = new Map([['p1', 'deux singes']]);
  const plain = videoTranscript([pictureMsg()], { labels: oldLabels, descriptions });
  const withAnswer = videoTranscript([pictureMsg()], { labels: oldLabels, descriptions, imageAnswers: new Map([['p1', answered]]) });
  assert.deepEqual(withAnswer, plain);
});

test('formatTranscript: a GIF with an answer renders videoAnswered after its tag; gone with videoAnswered blanked, whatever imageAnswered says', () => {
  const gifMsg = () => msg('a', T0, { content: '', attachments: [{ id: 'g1', kind: 'gif', name: 'miroir.gif' }] });
  const descriptions = new Map([['g1', 'une femme devant un miroir']]);
  const imageAnswers = new Map([['g1', answered]]);
  const items = videoTranscript([gifMsg()], { descriptions, imageAnswers });
  const tag = `${fill(labels.transcript.gifDescribed, { text: 'une femme devant un miroir' })} ${fill(labels.transcript.videoAnswered, answered)}`;
  assert.ok(items[0].text.endsWith(tag), items[0].text);

  const noVideoAnswers = { ...labels, transcript: { ...labels.transcript, videoAnswered: undefined } };
  const plain = videoTranscript([gifMsg()], { labels: noVideoAnswers, descriptions });
  assert.deepEqual(videoTranscript([gifMsg()], { labels: noVideoAnswers, descriptions, imageAnswers }), plain);
});

// --- formatTranscript: a link page read by the web lookup (reads -> linkRead)

test('formatTranscript: reads appends linkRead after the link tag and its other extras', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, {
      content: 'regarde',
      links: [
        { id: 'a#e0', kind: 'link', site: 'example.org', title: 'Crêpes', thumbnailUrl: 'https://example.org/t.jpg', url: 'https://example.org/c' },
        { id: 'a#e1', kind: 'link', site: 'other.org', title: 'Autre', url: 'https://other.org/x' },
      ],
    }),
  ];
  const items = formatTranscript(messages, {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
    descriptions: new Map([['a#e0', 'une assiette']]),
    reads: new Map([['a#e0', 'une recette simple, 3 œufs']]),
  });
  assert.ok(
    items[0].text.includes('[link: example.org — Crêpes] [thumbnail: une assiette] [page read: une recette simple, 3 œufs] [link: other.org — Autre]'),
    items[0].text,
  );
});

test('formatTranscript: an older labels.json with no linkRead key ignores reads, rendering as before', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const oldLabels = { ...labels, transcript: { ...labels.transcript, linkRead: undefined } };
  const messages = [msg('a', t0, { content: '', links: [{ id: 'a#e0', kind: 'link', site: 'example.org', title: 'Crêpes', url: 'https://example.org/c' }] })];
  const options = { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept' };
  const withReads = formatTranscript(messages, { ...options, labels: oldLabels, reads: new Map([['a#e0', 'texte']]) });
  const without = formatTranscript(messages, { ...options, labels });
  assert.equal(withReads[0].text, without[0].text);
  assert.ok(!withReads[0].text.includes('texte'));
});

// --- formatTranscript: reactions ---------------------------------------

function reactionTranscript(messages, extra = {}) {
  return formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels, seeReactions: true, ...extra });
}

test('formatTranscript: reactions are rendered after the text', () => {
  const T = Date.UTC(2026, 8, 20, 10, 0, 0);
  const items = reactionTranscript([msg('1', T, { reactions: [{ emoji: '🍣', count: 2, mine: false }] })]);
  assert.ok(items[0].text.endsWith('text [reactions: 🍣 x2]'), items[0].text);
});

test('formatTranscript: reactions follow the media tags, in both modes', () => {
  const T = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('1', T, {
      attachments: [{ id: 'p1', kind: 'image', name: 'a.png' }],
      reactions: [{ emoji: ':κάτι:', count: 3, mine: false }, { emoji: '🍣', count: 1, mine: false }],
    }),
  ];
  for (const mode of ['chat', 'memory']) {
    const items = reactionTranscript(messages, { mode });
    assert.ok(items[0].text.endsWith('text [image] [reactions: :κάτι: x3 · 🍣 x1]'), items[0].text);
  }
});

test('formatTranscript: the bot\'s own reaction uses reactionMine', () => {
  const T = Date.UTC(2026, 8, 20, 10, 0, 0);
  const items = reactionTranscript([
    msg('1', T, { reactions: [{ emoji: '👍', count: 3, mine: true }, { emoji: '🍣', count: 1, mine: false }] }),
  ]);
  assert.ok(items[0].text.endsWith('[reactions: 👍 x3 (yours too) · 🍣 x1]'), items[0].text);
});

test('formatTranscript: at most reactionsPerMessage items', () => {
  const T = Date.UTC(2026, 8, 20, 10, 0, 0);
  const reactions = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((name, i) => ({ emoji: `:${name}:`, count: 8 - i, mine: false }));
  const capped = reactionTranscript([msg('1', T, { reactions })], { reactionsPerMessage: 2 });
  assert.ok(capped[0].text.endsWith('[reactions: :a: x8 · :b: x7]'), capped[0].text);
});

test('formatTranscript: reactionSeparator parts reactions, names inside one reaction keep ", "', () => {
  const T = Date.UTC(2026, 8, 20, 10, 0, 0);
  const users = [{ id: '7', name: 'Ἄννα', bot: false }, { id: '8', name: 'Bé', bot: false }];
  const own = msg('1', T, { self: true, reactions: [{ emoji: '😂', count: 2, mine: false, users }, { emoji: '👍', count: 2, mine: false }] });
  const items = reactionTranscript([own], { reactionNames: true });
  assert.ok(items[0].text.endsWith('[reactions: 😂 by Ἄννα, Bé · 👍 x2]'), items[0].text);
  const noKey = { ...labels, transcript: { ...labels.transcript, reactionSeparator: undefined } };
  const old = reactionTranscript([msg('1', T, { reactions: [{ emoji: '😂', count: 2, mine: false }, { emoji: '👍', count: 1, mine: false }] })], { labels: noKey });
  assert.ok(old[0].text.endsWith('[reactions: 😂 x2, 👍 x1]'), old[0].text);
});

test('formatTranscript: seeReactions=false renders none', () => {
  const T = Date.UTC(2026, 8, 20, 10, 0, 0);
  const items = reactionTranscript([msg('1', T, { reactions: [{ emoji: '🍣', count: 2, mine: false }] })], { seeReactions: false });
  assert.ok(items[0].text.endsWith(': text'), items[0].text);
  assert.ok(!items[0].text.includes('🍣'));
});

test('formatTranscript: labels without transcript.reactions render none', () => {
  const T = Date.UTC(2026, 8, 20, 10, 0, 0);
  const oldLabels = {
    ...labels,
    transcript: { ...labels.transcript, reactions: undefined, reactionItem: undefined, reactionMine: undefined },
  };
  const items = reactionTranscript([msg('1', T, { reactions: [{ emoji: '🍣', count: 2, mine: true }] })], { labels: oldLabels });
  assert.ok(items[0].text.endsWith(': text'), items[0].text);
});

// --- A library GIF's three caption fields (transcript.gifKnownFields) -----------

const GIF_T = Date.UTC(2026, 8, 20, 10, 0, 0);
const GIF_LINK = { id: 'm1#e0', kind: 'gif', url: 'https://tenor.com/view/chat-123', site: 'Tenor', title: 'Chat' };
const GIF_FILE = { id: 'att9', kind: 'gif', url: 'https://cdn.discordapp.com/a/att9/réaction.gif', name: 'réaction.gif' };
const GIF_FULL = { reaction: 'accord ferme', action: 'un chat lève le menton', screen: 'ναι' };

function gifLines(fields, { labelSet = labels, handles = true, item = GIF_LINK } = {}) {
  const message = msg('m1', GIF_T, item === GIF_FILE ? { attachments: [item] } : { links: [item] });
  return formatTranscript([message], {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 800,
    selfName: 'Nept',
    labels: labelSet,
    descriptions: new Map([[item.id, 'un chat lève le menton']]),
    gifHandles: handles ? new Map([[item.id, 'g4']]) : undefined,
    gifFields: fields ? new Map([[item.id, fields]]) : undefined,
  })[0].text;
}

test('formatTranscript: a library GIF with its three fields renders transcript.gifKnownFields', () => {
  const tag = fillGifFields(labels.transcript.gifKnownFields, 'g4', GIF_FULL);
  assert.equal(tag, '[gif g4 -- accord ferme; un chat lève le menton; "ναι"]');
  assert.ok(gifLines(GIF_FULL).endsWith(tag));
  assert.ok(gifLines(GIF_FULL, { item: GIF_FILE }).endsWith(tag), 'an attachment alike');
});

test('formatTranscript: gifKnownFields leaves out an empty field with its separator', () => {
  assert.ok(gifLines({ reaction: '', action: '', screen: 'ναι' }).endsWith('[gif g4 -- "ναι"]'));
  assert.ok(gifLines({ reaction: 'accord ferme', action: '', screen: '' }).endsWith('[gif g4 -- accord ferme]'));
  assert.ok(gifLines({ reaction: '', action: 'un chat', screen: 'ναι' }).endsWith('[gif g4 -- un chat; "ναι"]'));
});

test('formatTranscript: without a reaction or on-screen text a library GIF keeps gifKnown', () => {
  const known = fill(labels.transcript.gifKnown, { id: 'g4', text: 'un chat lève le menton' });
  assert.ok(gifLines({ reaction: '', action: 'un chat lève le menton', screen: '' }).endsWith(known));
  assert.ok(gifLines(null).endsWith(known));
});

test('formatTranscript: a blanked transcript.gifKnownFields falls back to gifKnown, then to gifDescribed', () => {
  const blanked = { ...labels, transcript: { ...labels.transcript, gifKnownFields: '' } };
  assert.ok(gifLines(GIF_FULL, { labelSet: blanked }).endsWith(fill(labels.transcript.gifKnown, { id: 'g4', text: 'un chat lève le menton' })));
  const bothBlanked = { ...labels, transcript: { ...labels.transcript, gifKnownFields: '', gifKnown: '' } };
  assert.ok(gifLines(GIF_FULL, { labelSet: bothBlanked }).endsWith(fill(labels.transcript.gifDescribed, { text: 'un chat lève le menton' })));
});

test('formatTranscript: a GIF without a handle keeps gifDescribed with the action line only', () => {
  const line = gifLines(GIF_FULL, { handles: false });
  assert.ok(line.endsWith(fill(labels.transcript.gifDescribed, { text: 'un chat lève le menton' })), line);
  assert.ok(!line.includes('accord ferme') && !line.includes('ναι'));
});

test('fillGifFields: a field the template names but the values lack is left out; {text} and {screen} are both slots', () => {
  assert.equal(fillGifFields('{id}: {reaction}; {action}; "{text}"', 'g1', { reaction: 'r', action: 'a', text: 't' }), 'g1: r; a; "t"');
  assert.equal(fillGifFields('{id}: {reaction}; "{screen}"', 'g1', { reaction: 'r' }), 'g1: r');
  assert.equal(fillGifFields('{id}', 'g1', { reaction: 'r' }), 'g1');
});

// --- the turn trigger of the persona's own lines -------------------------

// Two questions, then the persona's lines: #3 posted by the turn #1 started, #4 a reply to #2
// posted by the same turn, #5 a reply to #2 posted by the turn #2 started.
function triggerScene(overrides = {}) {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  return [
    msg('q1', t0, { authorName: 'Éloïse', content: 'tu viens ce soir ?' }),
    msg('q2', t0 + 30_000, { authorName: 'Nick', content: 'et le lapin ?' }),
    msg('a1', t0 + MIN, { self: true, authorName: 'Nept', content: 'ναι', triggerId: 'q1', ...overrides.a1 }),
    msg('a2', t0 + 2 * MIN, { self: true, authorName: 'Nept', content: 'κοιμάται', replyToId: 'q2', triggerId: 'q1', ...overrides.a2 }),
    msg('a3', t0 + 3 * MIN, { self: true, authorName: 'Nept', content: 'ακόμα', replyToId: 'q2', triggerId: 'q2', ...overrides.a3 }),
  ];
}

test('formatTranscript: a plain line of the persona names the message that started its turn', () => {
  const items = formatTranscript(triggerScene(), offsetOptions);
  assert.equal(items[2].text, '#3 [13:01] Nept (you) (turn triggered by #1): ναι');
});

test('formatTranscript: a reply of the persona to another message than its trigger shows both', () => {
  const items = formatTranscript(triggerScene(), offsetOptions);
  assert.equal(items[3].text, '#4 [13:02] Nept (you) (turn triggered by #1): κοιμάται (replying to #2, Nick: "et le lapin ?")');
});

test('formatTranscript: a reply of the persona to its own trigger shows the reply marker only', () => {
  const items = formatTranscript(triggerScene(), offsetOptions);
  assert.equal(items[4].text, '#5 [13:03] Nept (you): ακόμα (replying to #2, Nick: "et le lapin ?")');
});

test('formatTranscript: a trigger outside the list renders triggeredByOlder, never a number', () => {
  const items = formatTranscript(triggerScene().slice(2), offsetOptions);
  assert.equal(items[0].text, '#1 [13:01] Nept (you) (turn triggered by an older message): ναι');
  // The trigger equal to the reply target still shows the reply marker only.
  assert.equal(items[2].text, '#3 [13:03] Nept (you): ακόμα (replying to an older message)');
});

test('formatTranscript: the trigger number follows indexOffset', () => {
  const items = formatTranscript(triggerScene(), { ...offsetOptions, indexOffset: 40 });
  assert.equal(items[2].text, '#43 [13:01] Nept (you) (turn triggered by #41): ναι');
});

test('formatTranscript: lines without a trigger render exactly as before', () => {
  const linked = formatTranscript(triggerScene({ a1: { triggerId: undefined }, a2: { triggerId: null }, a3: { triggerId: undefined } }), offsetOptions);
  const bare = formatTranscript(
    triggerScene().map(({ triggerId, ...message }) => message),
    offsetOptions,
  );
  assert.deepEqual(linked, bare);
  assert.equal(bare[2].text, '#3 [13:01] Nept (you): ναι');
});

test('formatTranscript: a trigger on another member\'s line, in memory mode or with blanked labels shows no marker', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const member = formatTranscript([msg('q1', t0), msg('b', t0 + MIN, { content: 'ok', triggerId: 'q1' })], offsetOptions);
  assert.equal(member[1].text, '#2 [13:01] Nick: ok');
  const memory = formatTranscript(triggerScene(), { ...offsetOptions, mode: 'memory' });
  assert.ok(memory.every((item) => !item.text.includes('triggered')), memory.map((item) => item.text).join('\n'));
  const blanked = { ...labels, transcript: { ...labels.transcript, triggeredBy: '', triggeredByOlder: '' } };
  const quiet = formatTranscript(triggerScene(), { ...offsetOptions, labels: blanked });
  assert.equal(quiet[2].text, '#3 [13:01] Nept (you): ναι');
  const older = formatTranscript(triggerScene().slice(2), { ...offsetOptions, labels: blanked });
  assert.equal(older[0].text, '#1 [13:01] Nept (you): ναι');
});

test('withTriggers: the persona\'s lines with a known link carry their trigger id; every other line is the same object', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const lines = [msg('q1', t0), msg('a1', t0 + MIN, { self: true }), msg('a2', t0 + 2 * MIN, { self: true }), msg('x', t0 + 3 * MIN)];
  const links = new Map([
    ['a1', 'q1'],
    ['x', 'q1'],
  ]);
  const out = withTriggers(lines, links);
  assert.equal(out.length, 4);
  assert.equal(out[1].triggerId, 'q1');
  assert.notEqual(out[1], lines[1], 'a new object: the fetched line is never changed');
  assert.equal(lines[1].triggerId, undefined);
  assert.equal(out[0], lines[0]);
  assert.equal(out[2], lines[2], 'a line of hers without a link is left alone');
  assert.equal(out[3], lines[3], "a member's line never carries a trigger");
  // A lookup function serves as well; no links or no list changes nothing.
  assert.equal(withTriggers(lines, (id) => (id === 'a2' ? 'q1' : null))[2].triggerId, 'q1');
  assert.equal(withTriggers(lines, null), lines);
  assert.deepEqual(withTriggers(null, links), []);
});

// --- the persona's skill calls on her own lines ---------------------------

// #1 a question in c1, #2 and #3 her lines of one turn (p1, p2), #4 a later member line. The
// turn also made a call; `posted` lists every message that turn posted (any channel).
const CALL_T0 = Date.UTC(2026, 8, 20, 10, 0, 0);
function callScene() {
  return [
    msg('q1', CALL_T0, { authorName: 'Éloïse', content: 'tu peux corriger ?' }),
    msg('p1', CALL_T0 + MIN, { self: true, authorName: 'Nept', content: 'ναι' }),
    msg('p2', CALL_T0 + 2 * MIN, { self: true, authorName: 'Nept', content: 'μια στιγμή' }),
    msg('q2', CALL_T0 + 5 * MIN, { authorName: 'Nick', content: 'alors ?' }),
  ];
}
const channelNames = new Map([
  ['c1', 'général'],
  ['c9', 'νέα'],
]);
const LINK = (channelId, messageId) => `https://discord.com/channels/g1/${channelId}/${messageId}`;
const resolvers = { nameOf: (id) => channelNames.get(id) ?? null, linkOf: LINK };
const call = (overrides = {}) => ({
  channelId: 'c1',
  at: CALL_T0 + 2 * MIN + 10_000,
  skill: 'message.edit',
  status: 'ok',
  target: { messageId: 'p1', channelId: 'c1' },
  postedId: null,
  posted: ['p1', 'p2'],
  ...overrides,
});

test('withCalls: a call rides on the last line its turn posted in the channel where it was made', () => {
  const lines = callScene();
  const out = withCalls(lines, { calls: [call()] }, resolvers);
  assert.equal(out[1], lines[1], 'an earlier line of the same turn is left alone');
  assert.deepEqual(out[2].calls, [
    { skill: 'message.edit', status: 'ok', targetId: 'p1', targetLink: LINK('c1', 'p1'), targetChannel: 'général', postedLink: null, ts: CALL_T0 + 2 * MIN + 10_000 },
  ]);
  assert.notEqual(out[2], lines[2], 'a new object: the fetched line is never changed');
  assert.equal(lines[2].calls, undefined);
  const items = formatTranscript(out, offsetOptions);
  assert.equal(items[2].text, '#3 [13:02] Nept (you): μια στιγμή [called message.edit on #2: done]');
  assert.equal(items[1].text, '#2 [13:01] Nept (you): ναι');
});

test('withCalls: a turn that posted nothing here shows the call as a standalone line of hers at the call time, without a number', () => {
  const lines = callScene();
  const out = withCalls(lines, { calls: [call({ posted: [], at: CALL_T0 + 3 * MIN, skill: 'lore.list', target: { messageId: null, channelId: null } })] }, resolvers);
  assert.equal(out[2].calls, undefined);
  assert.equal(out[2].callsAfter.length, 1, 'after the last line at or before the call');
  const items = formatTranscript(out, offsetOptions);
  assert.equal(items.length, 4, 'no item and no number of its own');
  assert.equal(items[2].text, '#3 [13:02] Nept (you): μια στιγμή\n[13:03] Nept (you): [called lore.list in #général: done]');
  assert.equal(items[3].text, '#4 [13:05] Nick: alors ?');
  // A call made before the first line in view is out of view.
  const early = withCalls(lines, { calls: [call({ posted: [], at: CALL_T0 - MIN })] }, resolvers);
  assert.ok(early.every((message, i) => message === lines[i]));
  // A call made in another channel never lands here.
  const elsewhere = withCalls(lines, { calls: [call({ channelId: 'c7', posted: [] })] }, resolvers);
  assert.ok(elsewhere.every((message, i) => message === lines[i]));
});

test('withCalls: a call that posted in another channel names it and links the post where it was made; the post there says where it came from', () => {
  const here = callScene();
  const there = [
    msg('z1', CALL_T0 + MIN, { channelId: 'c9', channelName: 'νέα', content: 'salut' }),
    msg('x1', CALL_T0 + 2 * MIN + 5000, { channelId: 'c9', channelName: 'νέα', self: true, authorName: 'Nept', content: 'καλημέρα' }),
  ];
  const marks = {
    calls: [call({ skill: 'message.create', target: { messageId: null, channelId: 'c9' }, postedId: 'x1', posted: ['p1', 'p2', 'x1'] })],
    postedFrom: new Map([['x1', 'c1']]),
  };
  const inA = formatTranscript(withCalls(here, marks, resolvers), offsetOptions);
  assert.equal(inA[2].text, `#3 [13:02] Nept (you): μια στιγμή [called message.create in #νέα: done, posted as ${LINK('c9', 'x1')}]`);
  const inB = withCalls(there, marks, resolvers);
  assert.equal(inB[1].calls, undefined, 'the call itself shows only where it was made');
  assert.equal(inB[1].callsAfter, undefined);
  const items = formatTranscript(inB, offsetOptions);
  assert.equal(items[1].text, '#2 [13:02] Nept (you) (posted from #général): καλημέρα');
  // A lookup function serves as well; a post in its own channel says nothing.
  const own = withCalls(here, { calls: [], postedFrom: (id) => (id === 'p1' ? 'c1' : null) }, resolvers);
  assert.ok(own.every((message, i) => message === here[i]));
});

test('formatTranscript: a call status renders through transcript.callStatus, an unlisted one as its code', () => {
  for (const status of ['ok', 'denied', 'invalid', 'not_configured', 'unknown', 'partial', 'failed']) {
    const items = formatTranscript(withCalls(callScene(), { calls: [call({ status })] }, resolvers), offsetOptions);
    assert.ok(items[2].text.endsWith(`[called message.edit on #2: ${labels.transcript.callStatus[status]}]`), items[2].text);
  }
  const odd = formatTranscript(withCalls(callScene(), { calls: [call({ status: 'strange' })] }, resolvers), offsetOptions);
  assert.ok(odd[2].text.endsWith('[called message.edit on #2: strange]'), odd[2].text);
});

test('formatTranscript: a call that did not work says why: its argument, its message or its channel, else the code\'s reason, else the status alone', () => {
  const reasons = labels.transcript.callReasons;
  const ended = (detail, extra = {}) => formatTranscript(withCalls(callScene(), { calls: [call({ status: 'invalid', detail, ...extra })] }, resolvers), offsetOptions)[2].text;
  const status = labels.transcript.callStatus.invalid;
  const withReason = (reason) => fill(labels.transcript.callStatusReason, { status, reason });
  // The live failure: a deletion without the message it should delete.
  assert.ok(ended({ kind: 'missing-arg', code: 'invalid-args', arg: 'message' }).endsWith(`[called message.edit on #2: ${withReason(fill(reasons['missing-arg'], { arg: 'message' }))}]`));
  // A channel she may not write in, named.
  const channel = ended({ kind: 'channel-no-permission', code: 'channel-no-permission', arg: null }, { target: { messageId: null, channelId: 'c9' } });
  assert.ok(channel.endsWith(`[called message.edit in #νέα: ${withReason(fill(reasons['channel-no-permission'], { channel: 'νέα' }))}]`), channel);
  // A phrase whose placeholder cannot be filled gives way to the code's reason in skills.result.reasons.
  const unnamed = ended({ kind: 'channel-no-permission', code: 'channel-no-permission', arg: null }, { target: { messageId: null, channelId: 'c5' } });
  assert.ok(unnamed.endsWith(`[called message.edit: ${withReason(labels.skills.result.reasons['channel-no-permission'])}]`), unnamed);
  // A kind without a phrase of its own: the code's reason, else reasons.other.
  assert.ok(ended({ kind: 'target-ambiguous', code: 'target-ambiguous', arg: null }).endsWith(`: ${withReason(labels.skills.result.reasons['target-ambiguous'])}]`));
  assert.ok(ended({ kind: 'strange', code: 'strange', arg: null }).endsWith(`: ${withReason(labels.skills.result.reasons.other)}]`));
  // The operation's own message: after the specific phrase, before the generic phrase of the code and reasons.other.
  assert.ok(ended({ kind: 'strange', code: 'strange', arg: null, text: 'the diary has no channel set' }).endsWith(`: ${withReason('the diary has no channel set')}]`));
  assert.ok(ended({ kind: 'target-ambiguous', code: 'target-ambiguous', arg: null, text: 'two channels' }).endsWith(`: ${withReason('two channels')}]`));
  assert.ok(ended({ kind: 'missing-arg', code: 'invalid-args', arg: 'message', text: 'Invalid arguments' }).endsWith(`: ${withReason(fill(reasons['missing-arg'], { arg: 'message' }))}]`));
  // No detail, or no callStatusReason label: the status word alone, as before.
  assert.ok(ended(null).endsWith(`[called message.edit on #2: ${status}]`));
  const plain = { ...labels, transcript: { ...labels.transcript, callStatusReason: '' } };
  const marked = withCalls(callScene(), { calls: [call({ status: 'invalid', detail: { kind: 'missing-arg', code: 'invalid-args', arg: 'message' } })] }, resolvers);
  assert.ok(formatTranscript(marked, { ...offsetOptions, labels: plain })[2].text.endsWith(`[called message.edit on #2: ${status}]`));
});

test('formatTranscript: a call target out of view renders as its link, else its channel, else nothing', () => {
  const gone = formatTranscript(withCalls(callScene(), { calls: [call({ target: { messageId: 'old', channelId: 'c9' } })] }, resolvers), offsetOptions);
  assert.ok(gone[2].text.endsWith(`[called message.edit on ${LINK('c9', 'old')}: done]`), gone[2].text);
  const unlinked = formatTranscript(withCalls(callScene(), { calls: [call({ target: { messageId: 'old', channelId: 'c9' } })] }, { ...resolvers, linkOf: () => null }), offsetOptions);
  assert.ok(unlinked[2].text.endsWith('[called message.edit in #νέα: done]'), unlinked[2].text);
  const nameless = formatTranscript(withCalls(callScene(), { calls: [call({ target: { messageId: null, channelId: 'c5' } })] }, resolvers), offsetOptions);
  assert.ok(nameless[2].text.endsWith('[called message.edit: done]'), nameless[2].text);
});

test('formatTranscript: blanked call labels, memory mode and no marks render the lines as before', () => {
  const marked = withCalls(callScene(), { calls: [call(), call({ posted: [], at: CALL_T0 + 3 * MIN })], postedFrom: new Map() }, resolvers);
  const bare = formatTranscript(callScene(), offsetOptions);
  const blanked = { ...labels, transcript: { ...labels.transcript, called: '' } };
  assert.deepEqual(formatTranscript(marked, { ...offsetOptions, labels: blanked }), bare);
  const memory = formatTranscript(marked, { ...offsetOptions, mode: 'memory' });
  assert.ok(memory.every((item) => !item.text.includes('called')), memory.map((item) => item.text).join('\n'));
  assert.equal(withCalls(callScene(), null, resolvers).length, 4);
  assert.deepEqual(withCalls(null, { calls: [call()] }, resolvers), []);
});

test('withCalls: marking lines again replaces the marks, never doubles them', () => {
  const marks = { calls: [call(), call({ posted: [], at: CALL_T0 + 3 * MIN, skill: 'lore.list' })] };
  const once = withCalls(callScene(), marks, resolvers);
  const twice = withCalls(once, marks, resolvers);
  assert.deepEqual(formatTranscript(twice, offsetOptions), formatTranscript(once, offsetOptions));
  assert.equal(twice[2].calls.length, 1);
  assert.equal(twice[2].callsAfter.length, 1);
  // No marks any more: the old ones are dropped.
  const cleared = withCalls(once, { calls: [] }, resolvers);
  assert.deepEqual(formatTranscript(cleared, offsetOptions), formatTranscript(callScene(), offsetOptions));
});
