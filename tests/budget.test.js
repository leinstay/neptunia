// Tests for src/llm/budget.js: fitSections, the priority-ordered token trimmer, and the two
// pieces every request builder hands it -- requestTokenLimit (the limit) and sectionCost (the
// price of one item).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetDrops, fitSections, requestTokenLimit, sectionCost, SectionsTooLargeError } from '../src/llm/budget.js';
import { createLimits } from '../src/llm/limits.js';

// Every item costs its own string length in "tokens" -- makes the arithmetic
// in assertions trivial and readable.
const cost = (text) => text.length;

test('fitSections: required sections are kept in full even when it leaves nothing for others', () => {
  const sections = [
    { name: 'fixed', required: true, items: ['aaaaaaaaaa'] }, // 10 tokens, fits exactly
    { name: 'optional', items: ['bb'] },
  ];
  const { kept, stats } = fitSections(sections, 10, cost);
  assert.deepEqual(kept.fixed, ['aaaaaaaaaa']);
  assert.equal(stats.fixed.used, 10);
  assert.equal(stats.fixed.dropped, 0);
  assert.deepEqual(kept.optional, []); // nothing left over for the non-required section
});

test('fitSections: required sections alone over the limit throw the dedicated class, naming the overflow', () => {
  const sections = [{ name: 'fixed', required: true, items: ['aaaaaaaaaa'] }]; // 10 tokens
  assert.throws(
    () => fitSections(sections, 5, cost),
    SectionsTooLargeError,
    'a dedicated class, not just a matching message'
  );
  assert.throws(
    () => fitSections(sections, 5, cost),
    /required prompt sections exceed the token limit by 5/,
    'the message says by how much'
  );
});

test('fitSections: priority order -- earlier sections get first claim on the remaining budget', () => {
  const sections = [
    { name: 'high', items: ['aaaaa', 'bbbbb'] }, // 5 + 5 = 10
    { name: 'low', items: ['ccccc', 'dd'] }, // 5 + 2 = 7, only 4 tokens remain for it
  ];
  // Only 14 tokens total: "high" (earlier) should be fully kept, "low" partially.
  const { kept, stats } = fitSections(sections, 14, cost);
  assert.deepEqual(kept.high, ['aaaaa', 'bbbbb']);
  assert.equal(kept.low.length, 1);
  assert.equal(stats.high.dropped, 0);
  assert.equal(stats.low.dropped, 1);
});

test('fitSections: cap limits a section even when more budget remains', () => {
  const sections = [{ name: 'capped', cap: 5, items: ['aaaaa', 'bbbbb', 'ccccc'] }];
  const { kept, stats } = fitSections(sections, 1000, cost);
  assert.deepEqual(kept.capped, ['aaaaa']);
  assert.equal(stats.capped.used, 5);
  assert.equal(stats.capped.dropped, 2);
});

test("fitSections: keep 'newest' keeps a contiguous tail in original order", () => {
  // Reversed processing order is [d, c, b, a]; b is oversized so processing
  // stops there entirely (contiguous tail), even though 'a' would fit alone.
  const sections = [{ name: 'chat', keep: 'newest', items: ['a', 'b'.repeat(50), 'c', 'd'] }];
  const { kept, stats } = fitSections(sections, 10, cost);
  assert.deepEqual(kept.chat, ['c', 'd']);
  assert.equal(stats.chat.dropped, 2);
});

test("fitSections: keep 'first' skips an oversized item but keeps later smaller ones", () => {
  const sections = [{ name: 'ranked', keep: 'first', items: ['aa', 'b'.repeat(50), 'cc'] }];
  const { kept, stats } = fitSections(sections, 4, cost);
  assert.deepEqual(kept.ranked, ['aa', 'cc']);
  assert.equal(stats.ranked.used, 4);
  assert.equal(stats.ranked.dropped, 1);
});

test('fitSections: default (no keep) behaves like "first" -- skips oversized, keeps later smaller items', () => {
  const sections = [{ name: 'plain', items: ['aa', 'b'.repeat(50), 'cc'] }];
  const { kept } = fitSections(sections, 4, cost);
  assert.deepEqual(kept.plain, ['aa', 'cc']);
});

// --- keep: 'oldest' -----------------------------------------------------------

test('fitSections: keep oldest keeps a contiguous prefix and stops at the first item that does not fit', () => {
  // Prices 3, 3, 9, 1 at limit 7: the 9 does not fit, so the 1 behind it is left out too.
  const items = ['aaa', 'bbb', 'c'.repeat(9), 'd'];
  const { kept, stats, used } = fitSections([{ name: 'log', keep: 'oldest', items }], 7, cost);
  assert.deepEqual(kept.log, ['aaa', 'bbb']);
  assert.deepEqual(stats.log, { used: 6, kept: 2, dropped: 2 });
  assert.equal(used, 6);
  // The same items as a ranked list skip the 9 and go on to the 1.
  assert.deepEqual(fitSections([{ name: 'log', keep: 'first', items }], 7, cost).kept.log, ['aaa', 'bbb', 'd']);
});

test('fitSections: keep oldest keeps nothing when its first item does not fit, whatever fits behind it', () => {
  const sections = [{ name: 'log', keep: 'oldest', items: ['a'.repeat(9), 'b', 'c'] }];
  const { kept, stats, used } = fitSections(sections, 7, cost);
  assert.deepEqual(kept.log, []);
  assert.deepEqual(stats.log, { used: 0, kept: 0, dropped: 3 });
  assert.equal(used, 0);
});

test('fitSections: keep oldest stops at its own cap even when the limit has room', () => {
  const sections = [{ name: 'log', keep: 'oldest', cap: 7, items: ['aaa', 'bbb', 'ccc', 'd'] }];
  const { kept, stats } = fitSections(sections, 1000, cost);
  assert.deepEqual(kept.log, ['aaa', 'bbb'], 'the third item would pass the cap, so the fourth is not tried');
  assert.equal(stats.log.dropped, 2);
});

test('fitSections: keep oldest takes what the sections ahead left and leaves the rest to the ones behind', () => {
  const sections = [
    { name: 'fixed', required: true, items: ['ffff'] }, // 4 of 12
    { name: 'log', keep: 'oldest', items: ['aaa', 'bbb', 'ccc'] }, // 8 left: two lines, the third does not fit
    { name: 'notes', keep: 'newest', items: ['xxx', 'yy'] }, // 2 left: the newest note only
  ];
  const { kept, used } = fitSections(sections, 12, cost);
  assert.deepEqual(kept.log, ['aaa', 'bbb']);
  assert.deepEqual(kept.notes, ['yy']);
  assert.equal(used, 12);
});

// --- a limit that is not a limit ----------------------------------------------

test('fitSections: a limit that is not a finite number >= 0 throws a TypeError instead of keeping everything', () => {
  const required = [{ name: 'fixed', required: true, items: ['a'.repeat(1000)] }];
  const optional = [{ name: 'chat', keep: 'newest', items: ['a'.repeat(1000), 'b'.repeat(1000)] }];
  for (const limit of [NaN, Infinity, -Infinity, -1, undefined, null, '10']) {
    const name = String(limit);
    assert.throws(() => fitSections(required, limit, cost), TypeError, `required sections, limit ${name}`);
    assert.throws(() => fitSections(optional, limit, cost), TypeError, `optional sections, limit ${name}`);
    assert.throws(() => fitSections([], limit, cost), TypeError, `no sections, limit ${name}`);
  }
});

test('fitSections: a broken limit is not reported as sections that are too large', () => {
  const sections = [{ name: 'fixed', required: true, items: ['aaa'] }];
  for (const limit of [NaN, Infinity, -1]) {
    assert.throws(
      () => fitSections(sections, limit, cost),
      (err) => err instanceof TypeError && !(err instanceof SectionsTooLargeError),
      String(limit)
    );
  }
});

test('fitSections: a limit of 0 is a limit -- optional items are dropped and a required one throws the dedicated class', () => {
  const { kept, used } = fitSections([{ name: 'chat', items: ['a', 'b'] }], 0, cost);
  assert.deepEqual(kept.chat, []);
  assert.equal(used, 0);
  assert.throws(() => fitSections([{ name: 'fixed', required: true, items: ['a'] }], 0, cost), SectionsTooLargeError);
});

// --- requestTokenLimit ----------------------------------------------------------

test('requestTokenLimit: llm.safetyMargin counts when it is a number in (0, 1], anything else is 0.9', () => {
  const limitAt = (llm) => requestTokenLimit({ llm: { maxRequestTokens: 2000, ...llm } });
  for (const [name, llm, expected] of [
    ['0.9', { safetyMargin: 0.9 }, 1800],
    ['0', { safetyMargin: 0 }, 1800],
    ['1.5', { safetyMargin: 1.5 }, 1800],
    ['null', { safetyMargin: null }, 1800],
    ['missing', {}, 1800],
    ['a string', { safetyMargin: '0.5' }, 1800],
    // A margin inside the range is used as it is, both ends of it included.
    ['0.5', { safetyMargin: 0.5 }, 1000],
    ['1', { safetyMargin: 1 }, 2000],
  ]) {
    assert.equal(limitAt(llm), expected, `safetyMargin ${name}`);
  }
});

test('requestTokenLimit: a maxRequestTokens that is missing or not a positive finite number counts as 50000', () => {
  assert.equal(requestTokenLimit({ llm: { safetyMargin: 0.9 } }), 45000, 'missing');
  assert.equal(requestTokenLimit({ llm: { safetyMargin: 0.5 } }), 25000, 'missing, with its own margin');
  assert.equal(requestTokenLimit({ llm: {} }), 45000, 'neither key');
  assert.equal(requestTokenLimit({}), 45000, 'a partial config without llm');
  for (const maxRequestTokens of [0, -100, '2000']) {
    assert.equal(requestTokenLimit({ llm: { maxRequestTokens, safetyMargin: 0.9 } }), 45000, String(maxRequestTokens));
  }
});

test('requestTokenLimit: the product is floored', () => {
  assert.equal(requestTokenLimit({ llm: { maxRequestTokens: 1001, safetyMargin: 0.9 } }), 900); // 900.9
  assert.equal(requestTokenLimit({ llm: { maxRequestTokens: 999, safetyMargin: 0.5 } }), 499); // 499.5
});

test('requestTokenLimit: a cap passed as the second argument replaces llm.maxRequestTokens, under the same rules', () => {
  const config = { llm: { maxRequestTokens: 2000, safetyMargin: 0.5 } };
  assert.equal(requestTokenLimit(config, 8000), 4000, 'the cap passed, the margin of the config');
  assert.equal(requestTokenLimit(config, undefined), 1000, 'nothing passed: the cap of the config');
  for (const passed of [0, -1, NaN, Infinity, null]) {
    assert.equal(requestTokenLimit(config, passed), 25000, `a passed ${String(passed)} counts as 50000`);
  }
  assert.equal(requestTokenLimit({}, 8000), 7200, 'a partial config: the cap passed at the 0.9 margin');
});

// --- sectionCost ----------------------------------------------------------------

test('sectionCost: reads the calibrator at the moment of pricing, not when the function is made', () => {
  let ratio = 1;
  const price = sectionCost({ apply: (raw) => Math.ceil(raw * ratio) });
  assert.equal(price('καφές'), 5);
  ratio = 1.5;
  assert.equal(price('καφές'), 7); // ceil(3 * 1.5) + 2
});

test('fitSections: a collector gets one budget-drop per section that lost items, with the items lost', () => {
  const sections = [
    { name: 'fixed', required: true, items: ['aaaa'] },
    { name: 'chat', keep: 'newest', items: ['bbb', 'ccc', 'ddd'] },
    { name: 'emoji', items: ['e'] },
  ];
  const limits = createLimits();
  const { stats } = fitSections(sections, 7, cost, { limits });
  assert.equal(stats.chat.dropped, 2);
  assert.equal(stats.emoji.dropped, 1);
  assert.deepEqual(limits.list(), [
    { kind: 'budget-drop', where: 'chat', lost: 2 },
    { kind: 'budget-drop', where: 'emoji', lost: 1 },
  ]);
  // Without a collector nothing changes; budgetDrops reads the same entries off a stats line.
  const again = createLimits();
  budgetDrops(fitSections(sections, 7, cost).stats, again);
  assert.deepEqual(again.list(), limits.list());
});
