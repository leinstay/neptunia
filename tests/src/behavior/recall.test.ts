// Tests for src/behavior/recall.ts: the pure core of recall (the memory match, window rendering, the persona's own
// search plan). No I/O, no real clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HIT_MARK,
  RRF_K,
  cutStretch,
  followChat,
  fuseRanks,
  matchMemory,
  meaningQuery,
  memorySearchPlan,
  mergeWindows,
  renderRecallWindows,
  scanArchive,
  stretchText,
} from '../../../src/behavior/recall.ts';
import { labels } from '../../fixtures/labels.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { asRecord } from '../../fixtures/records.ts';
import { ANA, BERLIN, ELO, HOUR, KITE, MINUTE, NOW, archived, ep, msg } from '../../fixtures/recall-kit.ts';
import { shippedLabels } from '../../fixtures/shipped-labels.ts';
import { mediaNamesOf } from '../../fixtures/media-namer.ts';

// The casts through `Parameters<typeof f>` hand a function a fake that carries only the fields the test reads.

/** The snowflake's timestamp back in ms. */

// ---- settings ------------------------------------------------------------------------------

// ---- the persona's terms and time range ----------------------------------------------------

test('memorySearchPlan: terms are cleaned, bounded in length and words, capped at maxForms', () => {
  const plan = memorySearchPlan({
    terms: 'a, "Νέο Έτος", one two three four, ' + 'x'.repeat(41) + ', ÉTÉ., été, b2, c3, d4',
    maxForms: 4,
    now: NOW,
  });
  assert.deepEqual(plan?.forms, ['νέο έτος', 'été', 'b2', 'c3']);
});

test('memorySearchPlan: a range alone makes a search; one date is that whole local day', () => {
  assert.deepEqual(memorySearchPlan({ when: '2025-12-18', timezone: BERLIN, now: NOW }), {
    forms: [],
    who: [],
    from: Date.UTC(2025, 11, 17, 23, 0),
    to: Date.UTC(2025, 11, 18, 23, 0) - 1,
  });
});

test('memorySearchPlan: a range across a daylight saving change keeps local wall times', () => {
  const plan = memorySearchPlan({ when: '2026-03-28 18:00 .. 2026-03-29 06:00', timezone: BERLIN, now: NOW });
  assert.equal(plan?.from, Date.UTC(2026, 2, 28, 17, 0), 'before the change: +01:00');
  assert.equal(plan?.to, Date.UTC(2026, 2, 29, 4, 0), 'after the change: +02:00');
  const days = memorySearchPlan({ when: '2025-10-26..2025-10-26', timezone: BERLIN, now: NOW });
  assert.equal(asRecord(days).to + 1 - asRecord(days).from, 25 * HOUR, 'a fall-back day lasts 25 hours');
});

test('memorySearchPlan: reversed bounds are swapped, a future end is clamped, a future start drops the range', () => {
  const reversed = memorySearchPlan({ when: '2026-01-01 .. 2025-12-31', timezone: 'UTC', now: NOW });
  assert.equal(reversed?.from, Date.UTC(2025, 11, 31));
  assert.equal(reversed?.to, Date.UTC(2026, 0, 2) - 1);
  const today = memorySearchPlan({ when: '2026-10-05', timezone: 'UTC', now: NOW });
  assert.equal(today?.to, NOW);
  assert.equal(memorySearchPlan({ when: '2026-12-01', timezone: 'UTC', now: NOW }), null);
});

test('memorySearchPlan: an open side is allowed; an unparsable side gives no range', () => {
  const open = memorySearchPlan({ when: '2025-12-31 18:00 ..', timezone: 'UTC', now: NOW });
  assert.deepEqual([open?.from, open?.to], [Date.UTC(2025, 11, 31, 18, 0), null]);
  const bad = memorySearchPlan({ terms: 'κουνέλι', when: '2025-12-31 .. soon', timezone: 'UTC', now: NOW });
  assert.deepEqual(bad, { forms: ['κουνέλι'], who: [], from: null, to: null });
  assert.equal(memorySearchPlan({ when: '2025-02-30', now: NOW }), null, 'a date that does not exist');
});

// ---- the plan ------------------------------------------------------------------------------

// ---- clusters and windows ------------------------------------------------------------------

test('mergeWindows: windows of one channel sharing a message become one', () => {
  const t = Date.UTC(2026, 9, 1, 15);
  const merged = mergeWindows([
    { placeId: 'c1', channelName: 'general', messages: [msg('m1', t), msg('m2', t + 1)], hitIds: ['m1'] },
    { placeId: 'c2', channelName: 'garden', messages: [msg('n1', t)], hitIds: ['n1'] },
    { placeId: 'c1', channelName: 'general', messages: [msg('m2', t + 1), msg('m3', t + 2)], hitIds: ['m3'] },
    { placeId: 'c1', channelName: 'general', messages: [], hitIds: [] },
  ]);
  assert.equal(merged.length, 2);
  const first = merged[0];
  assert.deepEqual(
    first.messages.map((m) => m.id),
    ['m1', 'm2', 'm3']
  );
  assert.deepEqual([...first.hitIds].sort(), ['m1', 'm3']);
});

test('renderRecallWindows: hit lines carry the mark; captions render; unindexed lines drop the index and reply markers', () => {
  const t = Date.UTC(2026, 9, 1, 18, 40);
  const window = {
    placeId: 'c1',
    channelName: 'general',
    messages: [
      msg('m1', t, { attachments: [{ id: 'p1', kind: 'image', name: 'x.png', url: 'https://cdn.example/x.png' }] }),
      msg('m2', t + 4 * MINUTE, { authorName: 'Βασίλης', content: 'τον πυροβόλησες', replyToId: 'm1' }),
    ],
    hitIds: ['m2'],
    descriptions: new Map([['p1', 'a rabbit in the grass']]),
  };
  const [indexed] = renderRecallWindows([window], { labels, timezone: 'UTC', selfName: 'Zoë', indexed: true });
  const [indexedFirst, indexedSecond] = indexed.lines;
  assert.equal(indexedFirst.text, '#1 [18:40] Ana: line m1 [image: a rabbit in the grass]');
  assert.equal(indexedSecond.text, `${HIT_MARK}#2 [18:44] Βασίλης: τον πυροβόλησες (replying to #1, Ana: "line m1")`);
  assert.deepEqual(
    indexed.lines.map((l) => l.hit),
    [false, true]
  );
  const [plain] = renderRecallWindows([window], { labels, timezone: 'UTC', indexed: false });
  const plainSecond = plain.lines[1];
  assert.equal(plainSecond.text, `${HIT_MARK}[18:44] Βασίλης: τον πυροβόλησες`);
});

test('renderRecallWindows: a matched message with a line break is marked on its first line, after a gap marker', () => {
  const t = Date.UTC(2026, 9, 1, 18, 40);
  const window = {
    placeId: 'c1',
    channelName: 'general',
    messages: [
      msg('m1', t),
      msg('m2', t + 3 * HOUR, { authorName: 'Βασίλης', content: 'πρώτη γραμμή\n#1 [δεύτερη] γραμμή' }),
    ],
    hitIds: ['m2'],
  };
  const [indexed] = renderRecallWindows([window], { labels, timezone: 'UTC', gapMinutes: 20, indexed: true });
  const indexedSecond = indexed.lines[1];
  const [gap, head, tail] = indexedSecond.text.split('\n');
  assert.ok(gap.startsWith('--- ') && !gap.startsWith(HIT_MARK), 'the gap marker stays unmarked');
  assert.equal(head, `${HIT_MARK}#2 [21:40] Βασίλης: πρώτη γραμμή`);
  assert.equal(tail, '#1 [δεύτερη] γραμμή');
  assert.equal(indexedSecond.hit, true);
  const [plain] = renderRecallWindows([window], { labels, timezone: 'UTC', gapMinutes: 20, indexed: false });
  const [plainFirst, plainSecond] = plain.lines;
  assert.deepEqual(
    plainSecond.text.split('\n'),
    [gap, `${HIT_MARK}[21:40] Βασίλης: πρώτη γραμμή`, '#1 [δεύτερη] γραμμή'],
    "the index goes; the message's own text stays"
  );
  assert.equal(plainFirst.text, '[18:40] Ana: line m1');
});

// ---- stored memory -------------------------------------------------------------------------

test('matchMemory: forms match word stems, folded; an inflected form matches its other endings; more forms rank first', () => {
  const profiles = [
    {
      id: ANA,
      names: ['Ana'],
      aliases: [],
      episodes: [
        ep('2026-10-01', 'shot the κουνέλι behind the shed', { weight: 5 }),
        ep('2026-10-02', 'held a funeral for the κουνέλι at the κουνελιού grave', { weight: 1 }),
        ep('2026-09-01', 'showed photos of κουνελάκια', { weight: 5 }),
        ep('2026-09-02', 'said nothing about animals', { quote: 'το ΚΟΥΝΈΛΙ μου', weight: 2 }),
      ],
    },
  ];
  const lore = [
    {
      id: 'l1',
      title: 'Le Lapin',
      keys: ['lapin'],
      text: 'The rabbit of the garden, buried in L’Été.',
      weight: 3,
      updatedAt: '2026-09-10T00:00:00.000Z',
    },
    { id: 'l2', title: 'Lapinouchette', keys: ['lapinouchette'], text: 'A plush toy.', weight: 3 },
    { id: 'l3', title: 'Lapins', keys: ['lapins'], text: 'The hutch.', weight: 1 },
  ];
  const items = matchMemory({ forms: ['κουνέλι', 'κουνελιού', 'ete'], profiles, lore, max: 10 });
  assert.deepEqual(
    items.map((i) => [i.kind, i.score, i.text]),
    [
      ['episode', 2, 'shot the κουνέλι behind the shed'],
      ['episode', 2, 'said nothing about animals "το ΚΟΥΝΈΛΙ μου"'],
      ['episode', 2, 'held a funeral for the κουνέλι at the κουνελιού grave'],
      ['episode', 1, 'showed photos of κουνελάκια'],
      ['lore', 1, 'Le Lapin: The rabbit of the garden, buried in L’Été.'],
    ],
    'κουνελιού reaches κουνέλι by its stem; κουνελάκια is in reach of κουνέλι only'
  );
  assert.deepEqual([items[0].date, items[0].accountId], ['2026-10-01', ANA]);
  assert.deepEqual([items[4].date, items[4].accountId], [null, null]);
  assert.deepEqual(
    matchMemory({ forms: ['lapin'], lore, max: 10 }).map((i) => i.text),
    ['Le Lapin: The rabbit of the garden, buried in L’Été.', 'Lapins: The hutch.'],
    'an ending matches, a word four letters longer does not'
  );
  assert.equal(matchMemory({ forms: ['κουνέλι'], profiles, max: 1 }).length, 1, 'capped at max');
  assert.deepEqual(matchMemory({ forms: ['κουνέλι'], profiles, max: 0 }), []);
  assert.deepEqual(matchMemory({ forms: [], who: [], profiles, lore, max: 10 }), [], 'nothing asked, nothing found');
});

test('matchMemory: a feeling is never searched; learned items are', () => {
  const profiles = [
    {
      id: ANA,
      names: ['Ana'],
      episodes: [ep('2026-10-01', 'a quiet evening', { feeling: 'the κουνέλι made her sad' })],
    },
  ];
  const learned = [
    {
      id: 1,
      text: 'a κουνέλι lives in the garden',
      from: `<@${ELO}>`,
      weight: 1,
      firstSeen: '2026-09-01T00:00:00.000Z',
      lastSeen: '2026-09-05T00:00:00.000Z',
    },
  ];
  const items = matchMemory({ forms: ['κουνέλι'], profiles, learned, max: 10, timezone: 'Europe/Berlin' });
  assert.deepEqual(
    items.map((i) => [i.kind, i.date, i.accountId, i.text]),
    // matchMemory takes no recent lines: the prefetch dropped their items after they had taken places in the limit.
    [['learned', null, ELO, 'a κουνέλι lives in the garden']]
  );
});

test("matchMemory: name forms bring the member's moments and the lines that name them", () => {
  const profiles = [
    {
      id: KITE,
      names: ['Kitezu'],
      aliases: [{ name: 'Κιτέζου', weight: 1 }],
      episodes: [
        ep('2026-01-01', 'won the chess night', { weight: 2 }),
        ep('2025-06-01', 'moved to the coast', { weight: 4 }),
      ],
    },
    {
      id: ANA,
      names: ['Ana'],
      episodes: [
        ep('2026-05-01', `argued with <@${KITE}> about chess`, { weight: 1 }),
        ep('2026-05-02', 'baked bread', { weight: 5 }),
      ],
    },
  ];
  const items = matchMemory({ forms: [], who: ['κιτέζου'], profiles, max: 10 });
  assert.deepEqual(
    items.map((i) => [i.accountId, i.text, i.score]),
    [
      [KITE, 'moved to the coast', 1],
      [KITE, 'won the chess night', 1],
      [ANA, `argued with <@${KITE}> about chess`, 1],
    ]
  );
  const both = matchMemory({ forms: ['chess'], who: ['kitezu'], profiles, max: 10 });
  assert.deepEqual(both.map((i) => [i.text, i.score]).slice(0, 2), [
    ['won the chess night', 2],
    [`argued with <@${KITE}> about chess`, 2],
  ]);
});

test('matchMemory: a range keeps only dated items inside it', () => {
  const profiles = [
    {
      id: ANA,
      names: ['Ana'],
      episodes: [
        ep('2025-12-31', 'κουνέλι fireworks'),
        ep('2026-01-01', 'κουνέλι brunch'),
        ep('2026-01-03', 'κουνέλι walk'),
        { what: 'κουνέλι undated', weight: 3 },
      ],
    },
  ];
  const lore = [{ title: 'κουνέλι', keys: ['κουνέλι'], text: 'timeless' }];
  const from = Date.UTC(2025, 11, 31, 23);
  const to = Date.UTC(2026, 0, 1, 23) - 1;
  const items = matchMemory({
    forms: ['κουνέλι'],
    profiles,
    lore,
    from,
    to,
    max: 10,
    timezone: 'Europe/Berlin',
  });
  // matchMemory takes no recent lines, so the line inside the range is no item.
  assert.deepEqual(
    items.map((i) => i.text),
    ['κουνέλι brunch']
  );
  const open = matchMemory({ forms: ['κουνέλι'], profiles, from: Date.UTC(2026, 0, 2), max: 10 });
  assert.deepEqual(
    open.map((i) => i.text),
    ['κουνέλι walk'],
    'an open end'
  );
});

test('cutStretch: whole lines go from the far ends, matched lines stay', () => {
  const lines = ['aaaa', 'bbbb', 'cccc', 'HHHH', 'dddd'].map((text) => ({ text, hit: text === 'HHHH' }));
  assert.deepEqual(
    cutStretch(lines, 14).map((l) => l.text),
    ['cccc', 'HHHH', 'dddd']
  );
  assert.deepEqual(
    cutStretch(lines, 9).map((l) => l.text),
    ['HHHH', 'dddd']
  );
  assert.deepEqual(
    cutStretch(lines, 1).map((l) => l.text),
    ['HHHH'],
    'a matched line is never dropped'
  );
  assert.deepEqual(
    cutStretch(lines, 1000).map((l) => l.text),
    lines.map((l) => l.text)
  );
});

// ---- the current chat, the persona's own stretches, the summary's context --------------

test('mergeWindows: a merged window overlaps the chat when any of its parts does', () => {
  const t = Date.UTC(2026, 9, 1, 15);
  const merged = mergeWindows([
    { placeId: 'c1', channelName: 'general', messages: [msg('m1', t), msg('m2', t + 1)], hitIds: ['m1'] },
    {
      placeId: 'c1',
      channelName: 'general',
      messages: [msg('m2', t + 1), msg('m3', t + 2)],
      hitIds: ['m3'],
      overlapsChat: true,
    },
    { placeId: 'c2', channelName: 'garden', messages: [msg('n1', t)], hitIds: ['n1'] },
  ]);
  assert.deepEqual(
    merged.map((w) => w.overlapsChat),
    [true, false]
  );
});

// ---- the archive and the recent record as sources -------------------------------------------

test('followChat: takes the following lines until a silence longer than the gap or the cap', () => {
  const T = NOW - HOUR;
  const after = [5, 1, 3, 9, 30].map((m) => ({ id: `a${m}`, ts: T + m * MINUTE }));
  const ids = (list: Untyped) => list.map((m: Untyped) => m.id);
  assert.deepEqual(
    ids(followChat(T, after, { followMessages: 24, followGapMinutes: 5 })),
    ['a1', 'a3', 'a5', 'a9'],
    'oldest first; 9 -> 30 is a silence'
  );
  assert.deepEqual(ids(followChat(T, after, { followMessages: 2, followGapMinutes: 5 })), ['a1', 'a3'], 'the cap');
  assert.deepEqual(
    ids(followChat(T, after, { followMessages: 24, followGapMinutes: 1 })),
    ['a1'],
    'a shorter gap stops sooner'
  );
  assert.deepEqual(
    followChat(T - 10 * MINUTE, after, { followMessages: 24, followGapMinutes: 5 }),
    [],
    'a silence right after the last line'
  );
  assert.deepEqual(followChat(T, after, { followMessages: 0, followGapMinutes: 5 }), [], 'followMessages 0: off');
});

// ---- meaning search: the query, the fusion, the record and memory joins ------------------------

test('fuseRanks: reciprocal rank fusion with k = 60; an item of both lists leads, a tie goes to the earlier list', () => {
  assert.equal(RRF_K, 60);
  const fused = fuseRanks([
    ['m1', 'both', 'm3'],
    ['both', 'w2'],
  ]);
  assert.deepEqual(
    fused.map((f) => f.id),
    ['both', 'm1', 'w2', 'm3']
  );
  assert.equal(fused[0].score, 1 / 62 + 1 / 61);
  assert.deepEqual(fused[0].ranks, [2, 1]);
  assert.deepEqual(fused[2].ranks, [null, 2]);
  assert.deepEqual(
    fuseRanks([['a'], ['b']]).map((f) => f.id),
    ['a', 'b'],
    'equal ranks: the earlier list first'
  );
  assert.deepEqual(
    fuseRanks([[], ['x', 'y']]).map((f) => f.id),
    ['x', 'y'],
    'one list alone keeps its order'
  );
  assert.deepEqual(
    fuseRanks([['a', 'a', 'b']]).map((f) => [f.id, f.ranks[0]]),
    [
      ['a', 1],
      ['b', 3],
    ],
    'a repeat keeps its first rank'
  );
  const weighted = fuseRanks([['half'], ['full']], { weights: [0.5] });
  assert.deepEqual(
    weighted.map((f) => [f.id, f.score]),
    [
      ['full', 1 / 61],
      ['half', 0.5 / 61],
    ],
    'a list weighs its weight; a missing weight is 1'
  );
});

test('meaningQuery: the question as written with its tokens resolved; with the reply option the replied line first', () => {
  const parent = { id: 'p1', content: 'ποιος έφερε το κέικ της <@411111111111111111>;' };
  const question = { id: 'q1', content: '  και ποιος\nτο έφτιαξε;  ', replyToId: 'p1' };
  const nameOf = (id: string) => (id === ANA ? 'Ana' : null);
  assert.deepEqual(meaningQuery({ candidate: question, lines: [parent], nameOf }), {
    text: 'και ποιος το έφτιαξε;',
    form: 'question',
  });
  assert.deepEqual(meaningQuery({ candidate: question, lines: [parent], withReply: true, nameOf }), {
    text: 'ποιος έφερε το κέικ της Ana;\nκαι ποιος το έφτιαξε;',
    form: 'question+reply',
  });
  assert.equal(
    meaningQuery({ candidate: { ...question, replyToId: 'gone' }, lines: [parent], withReply: true })?.form,
    'question',
    'the replied line not at hand'
  );
  assert.equal(
    meaningQuery({ candidate: { id: 'q2', content: '   ' } } as unknown as Parameters<typeof meaningQuery>[0]),
    null
  );
  assert.equal(meaningQuery({ candidate: null }), null);
});

// memory.search (the persona's own call, src/tools/tools.ts): the persona's arguments, read without a helper.

test("memorySearchPlan: the persona's terms and people first, then the question's long words and a stored name it holds; a time range bounds; a channel is kept", () => {
  const now = Date.UTC(2026, 9, 17, 12);
  const profiles = [
    { id: 'u7', names: ['lefteris_k'], aliases: [{ name: 'Λευτέρης' }] },
    { id: 'self', names: ['Zoë'], aliases: [] },
  ];
  const plan = memorySearchPlan({
    question: 'Τι είπε ο Λευτέρης για το παιχνίδι;',
    people: 'Ἀλέξανδρος, Éloïse',
    terms: 'κόκκινο φεγγάρι; λαγός',
    when: '2026-09-01..2026-09-30',
    placeId: 'c2',
    profiles,
    selfId: 'self',
    selfName: 'Zoë',
    maxForms: 3,
    timezone: 'UTC',
    now,
  });
  assert.deepEqual(plan?.forms, ['κόκκινο φεγγάρι', 'λαγός', 'παιχνίδι']);
  assert.deepEqual(plan?.who, ['ἀλέξανδρος', 'éloïse', 'λευτέρης']);
  assert.deepEqual([plan?.from, plan?.to], [Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 1) - 1]);
  assert.equal(plan?.placeId, 'c2');
  assert.equal(asRecord(plan).locator, undefined, "the persona's range bounds the search");
  // Nothing to search: null. A range alone is a question.
  assert.equal(memorySearchPlan({ question: 'τι;', now }), null);
  assert.deepEqual(memorySearchPlan({ question: 'τι;', when: '2026-10-01', now, timezone: 'UTC' }), {
    forms: [],
    who: [],
    from: Date.UTC(2026, 9, 1),
    to: Date.UTC(2026, 9, 2) - 1,
  });
});

const PLACE_DAY_NOW = Date.parse('2026-11-05T12:00:00.000Z');

test('memorySearchPlan keeps a channel with nothing else, and still answers null for nothing at all', () => {
  assert.deepEqual(memorySearchPlan({ placeId: 'c1', now: PLACE_DAY_NOW }), {
    forms: [],
    who: [],
    from: null,
    to: null,
    placeId: 'c1',
  });
  assert.equal(memorySearchPlan({ now: PLACE_DAY_NOW }), null);
});

test('recall: archive hits match as archived <kind> with the date and dedupe against hot by itemId', async () => {
  const profiles = [
    { id: ANA, names: ['Ana'], aliases: [], episodes: [{ ...ep('2026-10-02', 'fed the κουνέλι'), itemId: 'ep-hot' }] },
  ];
  const entries = [
    archived(
      'episode',
      'ep-hot',
      { what: 'fed the κουνέλι an old carrot' } as unknown as Parameters<typeof archived>[2],
      { observedAt: { date: '2026-10-02', precision: 'day' } }
    ),
    archived(
      'episode',
      'ep-old',
      { what: 'buried the κουνέλι', quote: '', feeling: '' } as unknown as Parameters<typeof archived>[2],
      { recordedAt: '2026-09-01T00:00:00.000Z' }
    ),
    archived(
      'episode',
      'ep-old',
      { what: 'buried the κουνέλι under the oak', quote: 'αντίο', feeling: '' } as unknown as Parameters<
        typeof archived
      >[2],
      { recordedAt: '2026-09-20T00:00:00.000Z' }
    ),
    archived('episode', 'ep-felt', {
      what: 'a quiet evening',
      feeling: 'the κουνέλι made her sad',
    } as unknown as Parameters<typeof archived>[2]),
    archived('interest', 'in-1', { topic: 'pets', note: 'keeps one' } as unknown as Parameters<typeof archived>[2], {
      neutral: 'Ana keeps a κουνέλι',
      observedAt: { date: '2026-07-01T22:30:00.000Z', precision: 'time' },
    }),
  ];
  const scanned = await scanArchive(
    (async function* () {
      yield* entries;
    })(),
    { forms: ['κουνέλι'], profiles, max: 6, timezone: BERLIN }
  );
  assert.ok(!scanned.some((e) => e.itemId === 'ep-felt'), 'a feeling is never searched');
  const items = matchMemory({ forms: ['κουνέλι'], profiles, archived: scanned, max: 10, timezone: BERLIN });
  assert.deepEqual(
    items.map((i) => [i.kind, i.itemId, i.date, i.accountId, i.text]),
    [
      ['episode', 'ep-hot', '2026-10-02', ANA, 'fed the κουνέλι'],
      ['archived episode', 'ep-old', '2026-08-01', ANA, 'buried the κουνέλι under the oak "αντίο"'],
      ['archived interest', 'in-1', '2026-07-02', ANA, 'pets: keeps one'],
    ],
    'the hot copy wins its itemId, the newest revision of an archived item stands for it, a time is dated in the zone'
  );
  const ranged = matchMemory({
    forms: ['κουνέλι'],
    profiles,
    archived: scanned,
    from: Date.UTC(2026, 6, 25),
    to: Date.UTC(2026, 7, 5),
    max: 10,
    timezone: BERLIN,
  });
  assert.deepEqual(
    ranged.map((i) => i.itemId),
    ['ep-old'],
    'a when: range matches observedAt'
  );
});

// The rule of 2026-11-17: one `<media>` block per request, one line per thing. A stretch the persona looked up stands in
// `<recall>` with bare stable names, and their lines join the root `<media>`; a tool result read on its own keeps its
// legend. The emoji and its names are the test's.
const LANTERN = {
  name: 'e5',
  kind: 'emoji' as const,
  iface: 'fake',
  nativeId: '505',
  platformName: 'φαναράκι',
  animated: false,
};
const LANTERN_NAMES = mediaNamesOf([LANTERN]);

/** A tool result's stretch as memory.search gives it: its own legend, then the line that names `:e5:`. */
const LANTERN_STRETCH = stretchText(
  [{ id: 'm50', text: '[10:00] Ελένη: ΦΑΝΟΣ :e5:' }],
  [{ id: 'm50', content: 'ΦΑΝΟΣ :e5:', emojis: [{ id: '505', name: 'e5' }] }],
  shippedLabels,
  LANTERN_NAMES
);

test("a stretch read by a tool outside the persona's request keeps its own <media> legend before its line", () => {
  // Bug: the fix of `<recall>` strips the legend from the tool result too, and the result names a bare code.
  assert.match(LANTERN_STRETCH, /^<media>\n[\s\S]*:e5: φαναράκι[\s\S]*<\/media>\n\[10:00\] Ελένη: ΦΑΝΟΣ :e5:$/);
});
