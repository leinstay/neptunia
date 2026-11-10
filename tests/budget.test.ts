// Tests for src/llm/budget.ts: fitSections, the priority-ordered token trimmer, and the two
// pieces every request builder hands it -- requestTokenLimit (the limit) and sectionCost (the
// price of one item).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { budgetDrops, fitSections, requestTokenLimit, sectionCost, SectionsTooLargeError } from '../src/llm/budget.ts';
import { createLimits } from '../src/llm/limits.ts';
import type { Section } from '../src/llm/budget.ts';

// Every item costs its own string length in "tokens" -- makes the arithmetic
// in assertions trivial and readable.
const cost = (text: string) => text.length;

test('fitSections: required sections are kept in full even when it leaves nothing for others', () => {
  const sections: Array<Section> = [
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
  const sections: Array<Section> = [{ name: 'fixed', required: true, items: ['aaaaaaaaaa'] }]; // 10 tokens
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
  const sections: Array<Section> = [
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
  const sections: Array<Section> = [{ name: 'capped', cap: 5, items: ['aaaaa', 'bbbbb', 'ccccc'] }];
  const { kept, stats } = fitSections(sections, 1000, cost);
  assert.deepEqual(kept.capped, ['aaaaa']);
  assert.equal(stats.capped.used, 5);
  assert.equal(stats.capped.dropped, 2);
});

test("fitSections: keep 'newest' keeps a contiguous tail in original order", () => {
  // Reversed processing order is [d, c, b, a]; b is oversized so processing
  // stops there entirely (contiguous tail), even though 'a' would fit alone.
  const sections: Array<Section> = [{ name: 'chat', keep: 'newest', items: ['a', 'b'.repeat(50), 'c', 'd'] }];
  const { kept, stats } = fitSections(sections, 10, cost);
  assert.deepEqual(kept.chat, ['c', 'd']);
  assert.equal(stats.chat.dropped, 2);
});

test("fitSections: keep 'first' skips an oversized item but keeps later smaller ones", () => {
  const sections: Array<Section> = [{ name: 'ranked', keep: 'first', items: ['aa', 'b'.repeat(50), 'cc'] }];
  const { kept, stats } = fitSections(sections, 4, cost);
  assert.deepEqual(kept.ranked, ['aa', 'cc']);
  assert.equal(stats.ranked.used, 4);
  assert.equal(stats.ranked.dropped, 1);
});

test('fitSections: default (no keep) behaves like "first" -- skips oversized, keeps later smaller items', () => {
  const sections: Array<Section> = [{ name: 'plain', items: ['aa', 'b'.repeat(50), 'cc'] }];
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
  const sections: Array<Section> = [{ name: 'log', keep: 'oldest', items: ['a'.repeat(9), 'b', 'c'] }];
  const { kept, stats, used } = fitSections(sections, 7, cost);
  assert.deepEqual(kept.log, []);
  assert.deepEqual(stats.log, { used: 0, kept: 0, dropped: 3 });
  assert.equal(used, 0);
});

test('fitSections: keep oldest stops at its own cap even when the limit has room', () => {
  const sections: Array<Section> = [{ name: 'log', keep: 'oldest', cap: 7, items: ['aaa', 'bbb', 'ccc', 'd'] }];
  const { kept, stats } = fitSections(sections, 1000, cost);
  assert.deepEqual(kept.log, ['aaa', 'bbb'], 'the third item would pass the cap, so the fourth is not tried');
  assert.equal(stats.log.dropped, 2);
});

test('fitSections: keep oldest takes what the sections ahead left and leaves the rest to the ones behind', () => {
  const sections: Array<Section> = [
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
  const required: Array<Section> = [{ name: 'fixed', required: true, items: ['a'.repeat(1000)] }];
  const optional: Array<Section> = [{ name: 'chat', keep: 'newest', items: ['a'.repeat(1000), 'b'.repeat(1000)] }];
  for (const limit of [NaN, Infinity, -Infinity, -1, undefined, null, '10']) {
    const name = String(limit);
    // @ts-expect-error: the test passes limits that are not numbers on purpose; each must throw a TypeError
    assert.throws(() => fitSections(required, limit, cost), TypeError, `required sections, limit ${name}`);
    // @ts-expect-error: the test passes limits that are not numbers on purpose; each must throw a TypeError
    assert.throws(() => fitSections(optional, limit, cost), TypeError, `optional sections, limit ${name}`);
    // @ts-expect-error: the test passes limits that are not numbers on purpose; each must throw a TypeError
    assert.throws(() => fitSections([], limit, cost), TypeError, `no sections, limit ${name}`);
  }
});

test('fitSections: a broken limit is not reported as sections that are too large', () => {
  const sections: Array<Section> = [{ name: 'fixed', required: true, items: ['aaa'] }];
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

// PR 7d: `llm.safetyMargin` is the constant SAFETY_MARGIN (0.9), so every limit below is 0.9 of its cap.
// The fallback is config.json's value, read from the tracked file so the test pins no default.
const TRACKED_LIMIT = requestTokenLimit(
  JSON.parse(readFileSync(new URL('../config/config.json', import.meta.url), 'utf8')) as Record<string, unknown>
);

test("requestTokenLimit: a maxRequestTokens that is missing or not a positive finite number counts as config.json's", () => {
  assert.equal(requestTokenLimit({ llm: {} }), TRACKED_LIMIT, 'missing');
  assert.equal(requestTokenLimit({}), TRACKED_LIMIT, 'a partial config without llm');
  for (const maxRequestTokens of [0, -100, '2000']) {
    assert.equal(requestTokenLimit({ llm: { maxRequestTokens } }), TRACKED_LIMIT, String(maxRequestTokens));
  }
});

test('requestTokenLimit: the product is floored', () => {
  assert.equal(requestTokenLimit({ llm: { maxRequestTokens: 1001 } }), 900); // 900.9
  assert.equal(requestTokenLimit({ llm: { maxRequestTokens: 999 } }), 899); // 899.1
});

test('requestTokenLimit: a cap passed as the second argument replaces llm.maxRequestTokens, under the same rules', () => {
  const config = { llm: { maxRequestTokens: 2000 } };
  assert.equal(requestTokenLimit(config, 8000), 7200, 'the cap passed');
  assert.equal(requestTokenLimit(config, undefined), 1800, 'nothing passed: the cap of the config');
  for (const passed of [0, -1, NaN, Infinity, null]) {
    assert.equal(
      requestTokenLimit(config, passed),
      TRACKED_LIMIT,
      `a passed ${String(passed)} counts as config.json's`
    );
  }
  assert.equal(requestTokenLimit({}, 8000), 7200, 'a partial config: the cap passed');
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
  const sections: Array<Section> = [
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
