// Tests for src/behavior/pull.js: the pure core of the pulled channel block
// (which channels a turn pulls, the window that ends at a channel's newest
// message, the pictures that may get a caption, the context.pull settings and
// the features.channelPull switch). No I/O: the clock is passed in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PULL_DEFAULTS,
  explicitChannelIds,
  isTooOld,
  pullPictures,
  pullSettings,
  pullTargets,
  pullWindow,
} from '../src/behavior/pull.js';

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// The owner's example: the channel's last message was at 10:00 two days ago.
const LAST = Date.UTC(2026, 9, 3, 10, 0, 0);

/** A normalized message of another member; `channels` are its explicit `<#id>` mentions. */
function msg(
  id,
  ts,
  {
    channels = [],
    content = 'καλημέρα',
    attachments = [],
    links = [],
    stickers = [],
    emojis = [],
    bot = false,
    self = false,
  } = {}
) {
  return {
    id,
    ts,
    channelId: 'ch-there',
    authorId: `u-${id}`,
    authorName: `Zoé ${id}`,
    self,
    bot,
    content,
    mentionedChannelIds: channels,
    attachments,
    links,
    stickers,
    emojis,
  };
}

/** A custom emoji as interfaces/discord/collect.js normalizes it. */
function emoji(id) {
  return { id, name: `έμοτζι_${id}`, animated: false, url: `https://cdn.example/emojis/${id}.png` };
}

/** `minutes` before the anchor `LAST`. */
function at(minutes) {
  return LAST - minutes * MIN;
}

function image(id) {
  return { id, kind: 'image', url: `https://cdn.example/${id}.png`, name: `${id}.png` };
}

function ids(messages) {
  return messages.map((m) => m.id);
}

// ---- settings -----------------------------------------------------------------

test('pullSettings: zeros and false are live values, garbage falls back, counts are floored', () => {
  assert.deepEqual(pullSettings({}), { ...PULL_DEFAULTS });

  const live = pullSettings({
    context: {
      pull: {
        windowMinutes: 30,
        minMessages: 0,
        maxMessages: 12,
        maxPictures: 0,
        maxNewDescriptions: 0,
        describeTimeoutMs: 0,
        scanMessages: 0,
        maxChannels: 2,
        maxAgeDays: 30,
        sameAudience: false,
        seenTtlMinutes: 0,
        keepMinutes: 0,
        keepTurns: 0,
      },
    },
  });
  assert.deepEqual(live, {
    windowMinutes: 30,
    minMessages: 0,
    maxMessages: 12,
    maxPictures: 0,
    maxNewDescriptions: 0,
    describeTimeoutMs: 0,
    scanMessages: 0,
    maxChannels: 2,
    maxAgeDays: 30,
    sameAudience: false,
    seenTtlMinutes: 0,
    keepMinutes: 0,
    keepTurns: 0,
  });

  const broken = pullSettings({
    context: {
      pull: {
        windowMinutes: -1,
        minMessages: 'λίγα',
        maxMessages: 0,
        maxPictures: null,
        maxNewDescriptions: -2,
        describeTimeoutMs: 'soon',
        scanMessages: Number.NaN,
        maxChannels: -1,
        maxAgeDays: -3,
        sameAudience: 'no',
        seenTtlMinutes: -5,
        keepMinutes: -1,
        keepTurns: 'λίγες',
      },
    },
  });
  assert.deepEqual(broken, { ...PULL_DEFAULTS }, 'only false turns sameAudience off; every bad number falls back');

  const fractional = pullSettings({
    context: { pull: { windowMinutes: 30.5, maxMessages: 12.7, maxChannels: 1.9, maxPictures: 2.5, maxAgeDays: 1.5 } },
  });
  assert.equal(fractional.maxMessages, 12, 'counts are floored');
  assert.equal(fractional.maxChannels, 1);
  assert.equal(fractional.maxPictures, 2);
  assert.equal(fractional.windowMinutes, 30.5, 'a duration is not a count: kept as given');
  assert.equal(fractional.maxAgeDays, 1.5);
});

// ---- explicitChannelIds ----------------------------------------------------------

test('explicitChannelIds: newest mention first, each id once', () => {
  const messages = [
    msg('m1', at(5), { channels: ['ch-a', 'ch-b'] }),
    msg('m2', at(4)),
    msg('m3', at(3), { channels: ['ch-c', 'ch-a'] }),
    null,
    { id: 'm4', ts: at(1), content: 'όχι λίστα' },
  ];
  assert.deepEqual(explicitChannelIds(messages), ['ch-c', 'ch-a', 'ch-b']);
  assert.deepEqual(explicitChannelIds([]), []);
  assert.deepEqual(explicitChannelIds(undefined), []);
  assert.deepEqual(
    explicitChannelIds([msg('m5', at(0), { channels: ['', 7, null, 'ch-d'] })]),
    ['ch-d'],
    'only non-empty string ids'
  );
});

// ---- pullTargets -----------------------------------------------------------------

/** pullTargets with every argument defaulted to an ordinary turn in `ch-here`. */
function targets(overrides = {}) {
  return pullTargets({
    source: null,
    history: [],
    trigger: null,
    extra: [],
    currentChannelId: 'ch-here',
    scanMessages: 20,
    maxChannels: 1,
    isPullable: () => true,
    ...overrides,
  });
}

test('pullTargets: the source comes first and counts toward maxChannels', () => {
  const history = [msg('m1', at(2), { channels: ['ch-diary'] })];
  const trigger = msg('t', at(1), { channels: ['ch-source', 'ch-memes'] });

  assert.deepEqual(targets({ source: { channelId: 'ch-source', reason: 'routed' }, history, trigger }), [
    { channelId: 'ch-source', reason: 'routed' },
  ]);
  assert.deepEqual(
    targets({ source: { channelId: 'ch-source', reason: 'noticed' }, history, trigger, maxChannels: 3 }),
    [
      { channelId: 'ch-source', reason: 'noticed' },
      { channelId: 'ch-memes', reason: 'mention' },
      { channelId: 'ch-diary', reason: 'mention' },
    ],
    'a source also mentioned explicitly is pulled once, as the source'
  );
  assert.deepEqual(
    targets({ source: { channelId: 'ch-source', reason: 'routed' }, history, trigger, maxChannels: 0 }),
    [{ channelId: 'ch-source', reason: 'routed' }],
    'the source is the turn itself: it is kept even when maxChannels leaves no slot'
  );
  assert.deepEqual(
    targets({ source: { channelId: 'ch-source', reason: 'routed' }, isPullable: () => false }),
    [{ channelId: 'ch-source', reason: 'routed' }],
    'isPullable judges mentions and route ids, not the source the caller already chose'
  );
  assert.deepEqual(targets({ history, maxChannels: 0 }), [], 'without a source maxChannels 0 pulls nothing');
});

test('pullTargets: a source in the current channel is dropped, the chat already shows it', () => {
  const trigger = msg('t', at(0), { channels: ['ch-memes'] });
  assert.deepEqual(targets({ source: { channelId: 'ch-here', reason: 'routed' } }), []);
  assert.deepEqual(
    targets({ source: { channelId: 'ch-here', reason: 'noticed' }, trigger }),
    [{ channelId: 'ch-memes', reason: 'mention' }],
    'the slot it would have taken goes to the next candidate'
  );
});

test('pullTargets: without isPullable only the source is kept', () => {
  const trigger = msg('t', at(0), { channels: ['ch-mirror'] });
  const history = [msg('m1', at(2), { channels: ['ch-diary'] })];
  const base = { history, trigger, extra: ['ch-route'], currentChannelId: 'ch-here', scanMessages: 20, maxChannels: 3 };
  assert.deepEqual(pullTargets(base), [], 'fail closed: no predicate, no mention or route id');
  assert.deepEqual(
    pullTargets({ ...base, isPullable: true }),
    [],
    'a predicate that is not a function counts as missing'
  );
  assert.deepEqual(pullTargets({ ...base, source: { channelId: 'ch-source', reason: 'routed' } }), [
    { channelId: 'ch-source', reason: 'routed' },
  ]);
  assert.deepEqual(pullTargets(), [], 'no arguments at all');
});

test('pullTargets: a refused mention leaves its slot to the next candidate', () => {
  const history = [msg('m1', at(10), { channels: ['ch-diary'] })];
  const trigger = msg('t', at(0), { channels: ['ch-mod'] });
  const asked = [];
  const isPullable = (id) => {
    asked.push(id);
    return id !== 'ch-mod';
  };
  assert.deepEqual(targets({ history, trigger, extra: ['ch-mod', 'ch-route'], maxChannels: 1, isPullable }), [
    { channelId: 'ch-diary', reason: 'mention' },
  ]);
  assert.deepEqual(asked, ['ch-mod', 'ch-diary'], 'asked in priority order, never after the slots are full');

  asked.length = 0;
  assert.deepEqual(targets({ history, trigger, extra: ['ch-mod', 'ch-route'], maxChannels: 3, isPullable }), [
    { channelId: 'ch-diary', reason: 'mention' },
    { channelId: 'ch-route', reason: 'route' },
  ]);
  assert.deepEqual(asked, ['ch-mod', 'ch-diary', 'ch-route'], 'a refused id is asked once, not again as a route id');

  asked.length = 0;
  assert.deepEqual(targets({ history, trigger, maxChannels: 1, isPullable: () => (asked.push('x'), true) }), [
    { channelId: 'ch-mod', reason: 'mention' },
  ]);
  assert.equal(asked.length, 1, 'a full slot list asks nothing more');
});

test("pullTargets: a channel mention in another bot's message does not pull", () => {
  const history = [
    msg('m1', at(5), { channels: ['ch-diary'] }),
    msg('b1', at(2), { channels: ['ch-rules'], bot: true }),
    msg('s1', at(1), { channels: ['ch-own'], self: true }),
  ];
  const trigger = msg('t', at(0));
  assert.deepEqual(targets({ history, trigger, maxChannels: 1 }), [{ channelId: 'ch-diary', reason: 'mention' }]);
  assert.deepEqual(
    targets({ history, trigger: null, maxChannels: 5 }),
    [{ channelId: 'ch-diary', reason: 'mention' }],
    "neither a bot's line nor the persona's own line pulls"
  );
  assert.deepEqual(
    targets({ history, trigger, scanMessages: 2, maxChannels: 5 }),
    [],
    'the skipped lines still use up the scanned span'
  );
});

test('pullTargets: the current channel and unpullable ids are skipped', () => {
  const history = [
    msg('m1', at(3), { channels: ['ch-ok'] }),
    msg('m2', at(2), { channels: ['ch-here', 'ch-thread'] }),
    msg('m3', at(1), { channels: ['ch-mirror'] }),
  ];
  const pullable = (id) => id !== 'ch-thread' && id !== 'ch-mirror';
  assert.deepEqual(targets({ history, maxChannels: 5, isPullable: pullable }), [
    { channelId: 'ch-ok', reason: 'mention' },
  ]);
  assert.deepEqual(
    targets({ history, maxChannels: 5, isPullable: pullable, extra: ['ch-here', 'ch-mirror'] }),
    [{ channelId: 'ch-ok', reason: 'mention' }],
    'route ids pass the same checks'
  );
});

test('pullTargets: route ids come after explicit mentions', () => {
  const trigger = msg('t', at(0), { channels: ['ch-said'] });
  assert.deepEqual(targets({ trigger, extra: ['ch-route', 'ch-said'], maxChannels: 3 }), [
    { channelId: 'ch-said', reason: 'mention' },
    { channelId: 'ch-route', reason: 'route' },
  ]);
  assert.deepEqual(targets({ trigger, extra: ['ch-route'], maxChannels: 1 }), [
    { channelId: 'ch-said', reason: 'mention' },
  ]);
  assert.deepEqual(targets({ extra: ['ch-route', 42, ''], maxChannels: 3 }), [
    { channelId: 'ch-route', reason: 'route' },
  ]);
  assert.deepEqual(targets({ extra: undefined, maxChannels: 3 }), []);
});

test('pullTargets: the trigger and the last scanMessages of the history are scanned, the trigger once', () => {
  const trigger = msg('t', at(0), { channels: ['ch-trigger'] });
  const history = [
    msg('m1', at(10), { channels: ['ch-old'] }),
    msg('m2', at(9), { channels: ['ch-mid'] }),
    msg('m3', at(8)),
    trigger,
  ];
  assert.deepEqual(
    targets({ history, trigger, scanMessages: 2, maxChannels: 5 }).map((t) => t.channelId),
    ['ch-trigger', 'ch-mid'],
    'the trigger does not use up one of the scanned history messages'
  );
  assert.deepEqual(
    targets({ history, trigger, scanMessages: 0, maxChannels: 5 }).map((t) => t.channelId),
    ['ch-trigger']
  );
  assert.deepEqual(
    targets({ history, trigger: null, scanMessages: 20, maxChannels: 5 }).map((t) => t.channelId),
    ['ch-trigger', 'ch-mid', 'ch-old'],
    'a spontaneous turn scans its history alone'
  );
});

test('pullTargets: channelPull off keeps only the source', () => {
  const trigger = msg('t', at(0), { channels: ['ch-said'] });
  assert.deepEqual(targets({ trigger, extra: ['ch-route'], maxChannels: 3, channelPull: false }), []);
  assert.deepEqual(
    targets({
      source: { channelId: 'ch-source', reason: 'routed' },
      trigger,
      extra: ['ch-route'],
      maxChannels: 3,
      channelPull: false,
    }),
    [{ channelId: 'ch-source', reason: 'routed' }]
  );
});

// ---- pullWindow ------------------------------------------------------------------

test('pullWindow: keeps every message within windowMinutes before the anchor', () => {
  const messages = [
    msg('a', at(90)),
    msg('b', at(61)),
    msg('c', at(60)),
    msg('d', at(40)),
    msg('e', at(15)),
    msg('f', at(0)),
  ];
  const result = pullWindow(messages, {
    anchorTs: LAST,
    windowMinutes: 60,
    minMessages: 2,
    maxMessages: 60,
    pageFull: false,
    now: NOW,
  });
  assert.deepEqual(ids(result.messages), ['c', 'd', 'e', 'f'], 'the window edge itself is inside');
  assert.equal(result.olderNotShown, true);
  assert.equal(result.skip, null);
});

test('pullWindow: the window ends at the anchor, not at now', () => {
  const messages = [msg('a', at(90)), msg('b', at(50)), msg('c', at(0))];
  const result = pullWindow(messages, { anchorTs: LAST, windowMinutes: 60, minMessages: 1, maxMessages: 60, now: NOW });
  assert.deepEqual(
    ids(result.messages),
    ['b', 'c'],
    'two days after the anchor the window is still 9:00-10:00 of that day'
  );
  assert.equal(result.skip, null);
});

test('pullWindow: without an anchor the window ends at the newest message whatever its age while maxAgeDays is 0', () => {
  const yearAgo = NOW - 300 * DAY;
  const messages = [msg('a', yearAgo - 120 * MIN), msg('b', yearAgo - 30 * MIN), msg('c', yearAgo)];
  for (const maxAgeDays of [undefined, 0]) {
    const result = pullWindow(messages, { windowMinutes: 60, minMessages: 1, maxMessages: 60, maxAgeDays, now: NOW });
    assert.deepEqual(ids(result.messages), ['b', 'c'], `maxAgeDays ${maxAgeDays}`);
    assert.equal(result.olderNotShown, true);
    assert.equal(result.skip, null);
  }
});

test('pullWindow: a positive maxAgeDays refuses an older channel with too-old', () => {
  const messages = [msg('a', at(30)), msg('b', at(0))];
  assert.deepEqual(
    pullWindow(messages, { windowMinutes: 60, minMessages: 1, maxMessages: 60, maxAgeDays: 1, now: NOW }),
    {
      messages: [],
      olderNotShown: false,
      skip: 'too-old',
    }
  );
  const recent = pullWindow(messages, { windowMinutes: 60, minMessages: 1, maxMessages: 60, maxAgeDays: 3, now: NOW });
  assert.deepEqual(ids(recent.messages), ['a', 'b']);
  assert.equal(recent.skip, null);
});

test('isTooOld: maxAgeDays 0 never refuses, a positive one refuses only past it', () => {
  assert.equal(isTooOld(NOW - 900 * DAY, { maxAgeDays: 0, now: NOW }), false);
  assert.equal(isTooOld(NOW - 900 * DAY, { now: NOW }), false, 'the default is no limit');
  assert.equal(isTooOld(NOW - 2 * DAY, { maxAgeDays: 2, now: NOW }), false, 'exactly maxAgeDays old is still pulled');
  assert.equal(isTooOld(NOW - 2 * DAY - 1, { maxAgeDays: 2, now: NOW }), true);
  assert.equal(isTooOld(null, { maxAgeDays: 2, now: NOW }), false, 'an unknown age is not judged here');
});

test('pullWindow: fewer than minMessages inside takes the last minMessages', () => {
  // A burst the day before, then a lone question an hour later than the window reaches.
  const burst = [0, 1, 2, 3, 4].map((i) => msg(`b${i}`, at(24 * 60 - i)));
  const lone = msg('q', at(0), { content: '?' });
  const result = pullWindow([...burst, lone], {
    anchorTs: LAST,
    windowMinutes: 60,
    minMessages: 5,
    maxMessages: 60,
    now: NOW,
  });
  assert.deepEqual(
    ids(result.messages),
    ['b1', 'b2', 'b3', 'b4', 'q'],
    'the tail of the burst is shown regardless of time'
  );
  assert.equal(result.olderNotShown, true);

  const all = pullWindow([...burst, lone], {
    anchorTs: LAST,
    windowMinutes: 60,
    minMessages: 10,
    maxMessages: 60,
    now: NOW,
  });
  assert.deepEqual(ids(all.messages), ['b0', 'b1', 'b2', 'b3', 'b4', 'q']);
  assert.equal(all.olderNotShown, false, 'nothing older exists and the page was not full');
});

test('pullWindow: keeps the newest maxMessages and flags older ones', () => {
  const messages = Array.from({ length: 10 }, (_, i) => msg(`m${i}`, at(50 - i * 5)));
  const result = pullWindow(messages, { anchorTs: LAST, windowMinutes: 60, minMessages: 5, maxMessages: 4, now: NOW });
  assert.deepEqual(ids(result.messages), ['m6', 'm7', 'm8', 'm9']);
  assert.equal(result.olderNotShown, true);

  const whole = pullWindow(messages, {
    anchorTs: LAST,
    windowMinutes: 60,
    minMessages: 5,
    maxMessages: 60,
    pageFull: false,
    now: NOW,
  });
  assert.equal(whole.messages.length, 10);
  assert.equal(whole.olderNotShown, false);
  const fullPage = pullWindow(messages, {
    anchorTs: LAST,
    windowMinutes: 60,
    minMessages: 5,
    maxMessages: 60,
    pageFull: true,
    now: NOW,
  });
  assert.equal(fullPage.messages.length, 10);
  assert.equal(fullPage.olderNotShown, true, 'a full page means the channel holds older messages than the page');

  const capped = pullWindow(messages, { anchorTs: LAST, windowMinutes: 60, minMessages: 8, maxMessages: 3, now: NOW });
  assert.deepEqual(ids(capped.messages), ['m7', 'm8', 'm9'], 'maxMessages is the ceiling even over minMessages');
});

test('pullWindow: messages after the anchor are left out', () => {
  const [a, b, c, d] = [msg('a', at(30)), msg('b', at(0)), msg('c', at(-5)), msg('d', at(-90))];
  const messages = [b, d, a, c];
  const before = ids(messages);
  const result = pullWindow(messages, {
    anchorTs: LAST,
    windowMinutes: 60,
    minMessages: 1,
    maxMessages: 60,
    pageFull: false,
    now: NOW,
  });
  assert.deepEqual(ids(result.messages), ['a', 'b'], 'in time order whatever the input order');
  assert.equal(result.olderNotShown, false, 'newer messages left out are not older ones');
  assert.deepEqual(ids(messages), before, 'the input is not changed');

  const unanchored = pullWindow(messages, { windowMinutes: 60, minMessages: 2, maxMessages: 60, now: NOW });
  assert.deepEqual(ids(unanchored.messages), ['c', 'd'], 'the newest message is the anchor, not the last one given');
  assert.deepEqual(ids(messages), before);
});

test('pullWindow: an empty channel or nothing up to the anchor is skipped with empty', () => {
  assert.deepEqual(pullWindow([], { now: NOW }), { messages: [], olderNotShown: false, skip: 'empty' });
  assert.deepEqual(pullWindow(undefined, { now: NOW }), { messages: [], olderNotShown: false, skip: 'empty' });
  assert.deepEqual(pullWindow([msg('a', at(-1))], { anchorTs: LAST, now: NOW }), {
    messages: [],
    olderNotShown: false,
    skip: 'empty',
  });
});

// ---- pullPictures ----------------------------------------------------------------

test('pullPictures: newest first, at most maxPictures, the rest counted', () => {
  const messages = [
    msg('m1', at(30), { attachments: [image('a1'), image('a2')] }),
    msg('m2', at(20), {
      links: [{ id: 'link:λ', kind: 'link', thumbnailUrl: 'https://cdn.example/l.png', title: 'Café' }],
      stickers: [{ id: 's1', name: 'σ', url: 'https://cdn.example/s1.png' }],
    }),
    msg('m3', at(10), { attachments: [image('c1'), image('c2'), image('c3')] }),
  ];
  const { items, rest, overflow } = pullPictures(messages, 4);
  assert.deepEqual(
    items.map((item) => item.itemId),
    ['c1', 'c2', 'c3', 'link:λ'],
    'newest message first, each message in its own order'
  );
  assert.equal(items[0].messageId, 'm3');
  assert.deepEqual(
    rest.map((item) => item.itemId),
    ['sticker:s1', 'a1', 'a2']
  );
  assert.equal(overflow, 3, 'the sticker of m2 and both pictures of m1');

  assert.deepEqual(pullPictures(messages, 0).items, []);
  assert.equal(pullPictures(messages, 0).rest.length, 7);
  assert.equal(pullPictures(messages, 0).overflow, 7);
  assert.equal(pullPictures(messages, 2.5).items.length, 2, 'a fractional maxPictures is floored');
});

test('pullPictures: pictures past maxPictures are returned for the cache, not only counted', () => {
  const same = { id: 'link:same', kind: 'link', thumbnailUrl: 'https://cdn.example/same.png', title: 'Crème' };
  const messages = Array.from({ length: 12 }, (_, i) =>
    msg(`m${i}`, at(60 - i), { attachments: [image(`p${i}`)], links: i === 0 || i === 11 ? [same] : [] })
  );
  const { items, rest, overflow } = pullPictures(messages, 10);
  assert.deepEqual(
    items.map((item) => item.itemId),
    ['p11', 'link:same', 'p10', 'p9', 'p8', 'p7', 'p6', 'p5', 'p4', 'p3']
  );
  assert.deepEqual(
    rest.map((item) => [item.itemId, item.messageId]),
    [
      ['p2', 'm2'],
      ['p1', 'm1'],
      ['p0', 'm0'],
    ],
    'same order, the repeated link only once, at its newest message'
  );
  assert.equal(overflow, rest.length);
  assert.equal(
    new Set([...items, ...rest].map((item) => item.itemId)).size,
    13,
    'every picture of the window, each once'
  );
});

test('pullPictures: custom emoji come apart from the pictures, each once at its newest message', () => {
  const messages = [
    msg('m1', at(20), { emojis: [emoji('e1'), emoji('e2')], attachments: [image('a1')] }),
    msg('m2', at(10), { emojis: [emoji('e1')], attachments: [image('b1')] }),
  ];
  const { items, rest, overflow, emoji: emojiItems } = pullPictures(messages, 1);
  assert.deepEqual(
    items.map((item) => item.itemId),
    ['b1']
  );
  assert.deepEqual(
    rest.map((item) => item.itemId),
    ['a1']
  );
  assert.equal(overflow, 1, 'emoji never count toward maxPictures or the overflow');
  assert.deepEqual(
    emojiItems.map((item) => [item.itemId, item.messageId, item.kind]),
    [
      ['emoji:e1', 'm2', 'emoji'],
      ['emoji:e2', 'm1', 'emoji'],
    ]
  );
  assert.deepEqual(pullPictures(messages, 0).emoji.length, 2, 'emoji are returned whatever maxPictures says');
});

test('pullPictures: only describable pictures, each picture once', () => {
  const link = { id: 'link:same', kind: 'link', thumbnailUrl: 'https://cdn.example/same.png', title: 'Crème' };
  const messages = [
    msg('m1', at(20), { links: [link], content: 'ü' }),
    msg('m2', at(10), {
      links: [link, { id: 'link:rich', kind: 'rich', thumbnailUrl: 'https://cdn.example/rich.png' }],
      attachments: [{ id: 'f1', kind: 'file', url: 'https://cdn.example/f1.zip', name: 'f1.zip' }],
    }),
  ];
  const { items, overflow } = pullPictures(messages, 10);
  assert.deepEqual(
    items.map((item) => [item.itemId, item.messageId]),
    [['link:same', 'm2']],
    'the same link twice is one picture, at its newest message'
  );
  assert.equal(overflow, 0);
});

test('pullTargets: kept ids come after mentions and route ids, fill only free slots, reason kept', () => {
  assert.deepEqual(targets({ maxChannels: 2, kept: ['ch-k'], extra: ['ch-r'] }), [
    { channelId: 'ch-r', reason: 'route' },
    { channelId: 'ch-k', reason: 'kept' },
  ]);
  assert.deepEqual(targets({ maxChannels: 1, kept: ['ch-k'], extra: ['ch-r'] }), [
    { channelId: 'ch-r', reason: 'route' },
  ]);
  assert.deepEqual(
    targets({ maxChannels: 1, kept: ['ch-here', 'ch-k'] }),
    [{ channelId: 'ch-k', reason: 'kept' }],
    'never the current channel'
  );
});
