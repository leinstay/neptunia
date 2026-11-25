// Tests for src/behavior/prefetch.ts: the pure core of the automatic memory prefetch -- when it
// runs, which triggers are trivial, the query lanes, the stored-memory plan of a lane, what counts
// as relevant, the fusion and deduplication across lanes, the focus of an excerpt, and the caps.
// No I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fitExcerpts,
  focusHits,
  isTrivialTrigger,
  lanePlan,
  lexicalKeep,
  prefetchLanes,
  quotedPhrases,
  rankPrefetch,
  wakeLanes,
} from '../../../src/behavior/prefetch.ts';
import { recallSettings } from '../../../src/behavior/recall.ts';
import { call, toolAnswer } from '../../fixtures/tool-answers.ts';
import { NOW, WEB_CONFIG, coreTurn, requestText } from '../../fixtures/turn-harness.ts';
import { addLine, addRoom, noteInterface, openWorld, rootId } from '../../fixtures/memory-db/mind-world.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { asRecord } from '../../fixtures/records.ts';

const SETTINGS = {
  ...recallSettings({})!.prefetch,
  trivial: ['hi', 'ok', 'thanks', 'good night'],
  deictic: ['that', 'this'],
  shortWords: 4,
  contextLines: 3,
  contextTokens: 500,
};

function msg(
  id: string,
  content: string,
  {
    authorName = 'Ana',
    authorId = 'u1',
    self = false,
    bot = false,
    ts = 1000,
    replyToId = null,
  }: {
    authorName?: string;
    authorId?: string;
    self?: boolean;
    bot?: boolean;
    ts?: number;
    replyToId?: string | null;
  } = {}
) {
  return { id, placeId: 'c1', authorId, authorName, self, bot, content, ts, replyToId };
}

test("isTrivialTrigger: empty, a command, only the persona's name or emoji, a bare greeting; a short catchphrase is not", () => {
  const opts = { trivial: SETTINGS.trivial, selfNames: ['Zoë'] };
  for (const text of [
    '',
    '   ',
    '<@123456789012345678>',
    '/nep status',
    '!ping',
    '?!',
    'zoe',
    'Zoë, hi!',
    'OK',
    'thanks!!',
    'Good   Night',
  ]) {
    assert.equal(isTrivialTrigger(text, opts), true, text);
  }
  for (const text of ['plus ultra', 'ok but why', 'hi there, remember the dog?', 'κουνέλι']) {
    assert.equal(isTrivialTrigger(text, opts), false, text);
  }
});

test('quotedPhrases: phrases between quote pairs, lowercased, each once, at most three', () => {
  assert.deepEqual(quotedPhrases('he said "Plus Ultra" and «το δάσος», then "plus ultra" again'), [
    'plus ultra',
    'το δάσος',
  ]);
  assert.deepEqual(quotedPhrases("it's 'the forest and the dog' picture"), ['the forest and the dog']);
  assert.deepEqual(quotedPhrases('no quotes here'), []);
});

// A bot is a person to the persona, so a bot's line before a short trigger joins the recent lane.
test('prefetchLanes: the trigger verbatim; with its replied-to line speaker by speaker; a short or deictic one with the lines before it', () => {
  const history = [
    msg('a', 'το δάσος και ο σκύλος', { authorName: 'Éloïse', authorId: 'u2' }),
    msg('b', 'Birthdays!', { bot: true, authorName: 'Bot' }),
    msg('c', 'ναι το θυμάμαι', { self: true }),
    msg('d', 'what did he mean?', { authorName: 'Nikos', authorId: 'u3', replyToId: 'a' }),
  ];
  const { lanes, skip } = prefetchLanes({ trigger: history[3], history, settings: SETTINGS, selfName: 'Zoë' });
  assert.equal(skip, null);
  assert.deepEqual(
    lanes.map((lane) => lane.kind),
    ['message', 'reply', 'recent']
  );
  assert.equal(lanes[0].text, 'what did he mean?');
  assert.equal(lanes[1].text, 'Éloïse: το δάσος και ο σκύλος\nNikos: what did he mean?');
  assert.equal(lanes[1].words, 'το δάσος και ο σκύλος\nwhat did he mean?', 'no speaker names in the lexical words');
  assert.equal(
    lanes[2].text,
    'Bot: Birthdays!\nZoë: ναι το θυμάμαι\nNikos: what did he mean?',
    'not the replied line again; a bot line is a line'
  );
  // A long trigger: no recent lane.
  const long = msg('e', 'tell me again about that long story we had with the forest and the dog');
  const longLanes = prefetchLanes({
    trigger: long,
    history: [...history, long],
    settings: { ...SETTINGS, deictic: [] },
    selfName: 'Zoë',
  }).lanes;
  assert.deepEqual(
    longLanes.map((lane) => lane.kind),
    ['message']
  );
  // A deictic word opens it whatever the length.
  assert.ok(
    prefetchLanes({ trigger: long, history: [...history, long], settings: SETTINGS, selfName: 'Zoë' }).lanes.some(
      (lane) => lane.kind === 'recent'
    )
  );
  // contextLines 0: none.
  assert.ok(
    !prefetchLanes({
      trigger: history[3],
      history,
      settings: { ...SETTINGS, contextLines: 0 },
      selfName: 'Zoë',
    }).lanes.some((lane) => lane.kind === 'recent')
  );
  // contextTokens bound the lines taken.
  const tight = prefetchLanes({
    trigger: history[3],
    history,
    settings: { ...SETTINGS, contextTokens: 1 },
    selfName: 'Zoë',
  }).lanes;
  assert.ok(!tight.some((lane) => lane.kind === 'recent'));
});

test("prefetchLanes: never for the persona's own line, an errand result, a diary post or a trivial trigger", () => {
  const t = msg('t', 'θυμάσαι το δάσος;');
  assert.equal(prefetchLanes({ trigger: null, settings: SETTINGS }).skip, 'no-trigger');
  assert.equal(prefetchLanes({ trigger: { ...t, self: true }, settings: SETTINGS }).skip, 'no-trigger');
  assert.equal(prefetchLanes({ trigger: t, selfId: 'u1', settings: SETTINGS }).skip, 'no-trigger');
  assert.equal(prefetchLanes({ trigger: t, triggerKind: 'errand', settings: SETTINGS }).skip, 'not-external');
  assert.equal(prefetchLanes({ trigger: t, mode: 'diary', settings: SETTINGS }).skip, 'not-external');
  assert.equal(prefetchLanes({ trigger: msg('t', 'ok'), settings: SETTINGS }).skip, 'trivial');
  // A split message's part: the part's text is the trigger.
  const part = prefetchLanes({
    trigger: t,
    candidate: { ...t, content: 'και ο σκύλος;' },
    history: [t],
    settings: SETTINGS,
  });
  const lane = part.lanes[0];
  assert.equal(lane.text, 'και ο σκύλος;');
});

test('lanePlan: long words and stored names as forms, a short trigger as a phrase', () => {
  const profiles = [{ id: 'u2', names: ['Éloïse'], aliases: [] }];
  const plan = lanePlan(
    { kind: 'message', words: 'Éloïse, η ζωγραφιά με το δάσος και τον σκύλο' },
    { profiles, trigger: 'Éloïse, η ζωγραφιά με το δάσος και τον σκύλο' }
  );
  assert.deepEqual(plan!.who, ['éloïse']);
  assert.deepEqual(plan!.forms, ['ζωγραφιά', 'δάσος', 'σκύλο']);
  assert.equal(plan!.need, 2);
  const short = lanePlan({ kind: 'message', words: 'plus ultra' }, { trigger: 'plus ultra' });
  assert.deepEqual([short!.phrases, short!.forms, short!.need], [['plus ultra'], ['ultra'], 1]);
  assert.equal(lanePlan({ kind: 'reply', words: 'a b' }, { trigger: 'a b' }), null, 'nothing to search');
});

test('lexicalKeep: a phrase always; two terms unless the cosine is weak; one term only with a good cosine; words alone without the meaning search', () => {
  const settings = { minMeaningScore: 0.35, singleTermScore: 0.45 };
  const cosines = new Map([
    ['two-weak', 0.2],
    ['two-ok', 0.4],
    ['one-ok', 0.5],
    ['one-weak', 0.4],
  ]);
  const keep = (messageId: string, terms: number, phrases = 0, map: Map<string, number> | null = cosines) =>
    lexicalKeep({ messageId, terms, phrases }, map, settings);
  assert.equal(keep('two-weak', 1, 1), true, 'a phrase');
  assert.equal(keep('two-weak', 2), false);
  assert.equal(keep('two-ok', 2), true);
  assert.equal(keep('two-unknown', 3), true, 'no vector row: the words decide');
  assert.equal(keep('one-ok', 1), true);
  assert.equal(keep('one-weak', 1), false);
  assert.equal(keep('one-unknown', 1), false, 'one term needs its cosine');
  assert.equal(keep('one-ok', 1, 0, null), false, 'without the meaning search one term is never enough');
  assert.equal(keep('two-weak', 2, 0, null), true);
});

test('focusHits: the best hit, then the next ones that keep the marked lines close together', () => {
  const order = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9'];
  assert.deepEqual(focusHits(order, ['m5', 'm0', 'm7', 'm9', 'm4'], 3), ['m5', 'm7', 'm4']);
  assert.deepEqual(focusHits(order, ['zz', 'm2'], 3), ['m2'], 'a hit outside the window is skipped');
  assert.deepEqual(focusHits(order, [], 3), []);
});

test('rankPrefetch: lanes fused by rank, windows sharing a line merged into one excerpt, marked with relevant hits only; stored items deduplicated', () => {
  const order = ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'z1'];
  const w = (ids: Array<string>, hitIds: Array<string>, placeId = 'c2') => ({
    placeId,
    channelName: 'garden',
    messages: ids.map((id: string) => ({ id, ts: order.indexOf(id) })),
    hitIds: new Set(hitIds),
  });
  const lanes = [
    { windows: [w(['a1', 'a2', 'a3'], ['a2', 'a3']), w(['b1', 'b2'], ['b2'])], lexical: ['a2', 'b2'] },
    { windows: [w(['a3', 'a4'], ['a3'])], meaning: ['a3'] },
    { memory: [{ kind: 'episode', itemId: 'ep1', text: 'x' }] },
    {
      memory: [
        { kind: 'episode', itemId: 'ep1', text: 'x' },
        { kind: 'lore', itemId: null, text: 'y' },
      ],
    },
    { windows: [w(['z1'], ['z1'])], lexical: [] },
  ];
  const units = rankPrefetch(lanes);
  const history = units.filter((unit) => unit.kind === 'history');
  assert.equal(history.length, 2, 'the two windows sharing a3 are one; a window with no relevant hit is dropped');
  const joined = history[0];
  const joinedWindow = joined.window;
  assert.deepEqual(
    joinedWindow.messages.map((m) => m.id),
    ['a1', 'a2', 'a3', 'a4']
  );
  assert.deepEqual([...joinedWindow.hitIds].sort(), ['a2', 'a3']);
  const bestHit = joined.hitIds[0];
  assert.equal(bestHit, 'a2', 'its best hit first');
  assert.deepEqual(
    units.filter((unit) => unit.kind === 'memory').map((unit) => unit.item.itemId),
    ['ep1', null],
    'one copy per item'
  );
  assert.ok(
    units.every((unit, i) => i === 0 || units[i - 1].rank <= unit.rank),
    'best first'
  );
  const first = rankPrefetch([
    { memory: [{ kind: 'episode', itemId: 'ep9', text: 'x' }], windows: [w(['b1'], ['b1'])], lexical: ['b1'] },
  ]);
  assert.deepEqual(
    first.map((unit) => unit.kind),
    ['history', 'memory'],
    'a stored item counts half a history hit of the same rank'
  );
});

test('fitExcerpts: at most maxExcerpts, within maxTokens; one that does not fit is skipped and the next tried', () => {
  const big = { text: 'x'.repeat(4000) };
  const small = (n: number) => ({ text: `line ${n}` });
  assert.deepEqual(fitExcerpts([small(1), big, small(2), small(3)], { maxExcerpts: 2, maxTokens: 100 }), [
    small(1),
    small(2),
  ]);
  assert.deepEqual(fitExcerpts([big], { maxExcerpts: 5, maxTokens: 100 }), [], 'zero excerpts allowed');
});

test('wakeLanes: the purposes of the intentions as one wake lane; none without a purpose', () => {
  assert.deepEqual(wakeLanes(['a', ' b ']), { lanes: [{ kind: 'wake', text: 'a\nb', words: 'a\nb' }], skip: null });
  assert.deepEqual(wakeLanes([]), { lanes: [], skip: 'no-trigger' });
});

/** A recall runner fake: records each run and answers `quotes`. */
function fakeRecall(
  quotes = [
    {
      placeId: 'c2',
      channelName: 'jardin',
      startTs: NOW - 3 * 86_400_000,
      lines: '[09:00] Éloïse: ένα κουνέλι στον κήπο',
    },
  ]
) {
  const runs: Array<Untyped> = [];
  return {
    runs,
    available: () => true,
    run: async (args: unknown) => (runs.push(args), { text: null, stretch: null, people: [], quotes, stats: {} }),
  };
}

// The automatic memory prefetch: once per new trigger of a person, before the persona's tool loop, no model
// in it; its block stands in the uncached tail of every request of the turn, right before the chat.

/** A recall runner whose prefetch answers `found` and notes each call (with fakeRecall's run). */
function prefetchRecall(
  found = {
    status: 'ok',
    basis: ['message'],
    excerpts: [
      {
        source: 'history',
        placeId: 'c2',
        channelName: 'jardin',
        startTs: Date.UTC(2026, 9, 2, 9),
        id: 'r9',
        ids: ['r9'],
        hitIds: ['r9'],
        lines: '>> [09:00] Éloïse: το δάσος και ο σκύλος',
      },
    ],
    ms: 3,
  }
) {
  const recall = fakeRecall();
  asRecord(recall).prefetches = [];
  asRecord(recall).prefetch = async (args: unknown) => (asRecord(recall).prefetches.push(args), found);
  return recall;
}

test("prefetch: a reply carries the prefetch's find in <found> after <chat>, in the uncached tail of every step, and no <retrieved>", async () => {
  // Slice 4: the find of `<retrieved>` moves to `<found>` (the prefetch's hits enter the graph reader's seeds). The
  // line is stored as the memory stores every line, under its source id.
  const mind = openWorld();
  noteInterface(mind, 'fake', [{ id: 'g1', name: 'Γαία' }]);
  const room = addRoom(mind.db, { iface: 'fake', native: 'c2', root: rootId('fake', 'g1'), name: 'jardin' });
  const at = '2026-10-02T09:00:00.000Z';
  addLine(mind.db, {
    id: 'src:fake:r9:1:seen',
    iface: 'fake',
    place: room,
    author: 'self',
    text: 'το δάσος και ο σκύλος',
    at,
  });
  const recall = prefetchRecall();
  const run = await coreTurn({
    answers: [toolAnswer('', [call('memory.search', { question: 'το δάσος' })]), '<msg>ναι, ο σκύλος</msg>'],
    allowed: ['memory.search'],
    features: { recall: true },
    config: WEB_CONFIG,
    runner: { recall, journalDb: () => mind.db, memoryContext: () => ({ kind: 'group', iface: 'fake' }) },
    content: 'θυμάσαι τη ζωγραφιά με το δάσος;',
  } as unknown as Parameters<typeof coreTurn>[0]);
  mind.close();
  const { calls } = run.llm;
  for (const i of [0, 1]) {
    const [, user] = calls[i];
    type Part = { type?: string; text?: string; cacheSegment?: string };
    const parts = (Array.isArray(user.content) ? user.content : []) as Array<Part>;
    const texts = parts.filter((part) => part.type === 'text');
    const { text = '', cacheSegment } = texts[texts.length - 1] ?? {};
    assert.equal(cacheSegment ?? null, null, 'the tail carries no cache segment');
    const found = /<found>\n([\s\S]*?)\n<\/found>/.exec(text)?.[1] ?? '';
    assert.ok(found.includes('το δάσος και ο σκύλος'), text);
    // The cache layout: `<found>` is a root tag after `<chat>`, out of `<memory>`.
    assert.ok(text.indexOf('<found>') > text.indexOf('</chat>'), 'after <chat>, out of <memory>');
    assert.ok(!text.includes('<retrieved>'));
  }
});

// Slice 7: the routed turn and its `<retrieved>` status line are deleted, so what is left is the trivial trigger.
test('prefetch: a trivial trigger is not searched and the request carries no <retrieved>', async () => {
  const trivial = prefetchRecall();
  const greeted = await coreTurn({
    answers: ['<msg>γεια</msg>'],
    features: { recall: true },
    config: WEB_CONFIG,
    runner: { recall: trivial },
    content: 'ok',
  } as unknown as Parameters<typeof coreTurn>[0]);
  assert.equal(asRecord(trivial).prefetches.length, 0);
  assert.ok(greeted.logs.some((entry) => entry.msg === 'recall: prefetch skipped' && entry.reason === 'trivial'));
  assert.ok(!requestText(greeted.llm, 0).includes('<retrieved>'));
});

test('prefetch: a failing runner never fails the turn', async () => {
  const recall = fakeRecall();
  asRecord(recall).prefetch = async () => {
    throw new Error('boom');
  };
  // Slice 7: the routed turn, whose `<retrieved>` said unavailable, is deleted; a reply carries no status line.
  const run = await coreTurn({
    answers: ['<msg>δεν ξέρω</msg>'],
    features: { recall: true },
    config: WEB_CONFIG,
    runner: { recall },
    content: 'θυμάσαι τη ζωγραφιά;',
  } as unknown as Parameters<typeof coreTurn>[0]);
  assert.equal(asRecord(run.result).outcome, 'spoke');
});
