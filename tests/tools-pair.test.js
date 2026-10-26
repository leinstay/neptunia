// Tests for tools/lib/pair.mjs: the trigger list, the blind order, the sheet and the tally of
// the paired replay (tools/replay.mjs --pair, tools/replay-score.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTriggers, pairOrder, renderSheet, sheetPairIds, tallyScores, escapeHtml } from '../tools/lib/pair.mjs';

const CH = '123456789012345678';
const M1 = '223456789012345678';
const M2 = '323456789012345678';

test('pair: parseTriggers reads channel, trigger and an optional turn id, skipping comments', () => {
  const text = `# the harness set\n${CH} ${M1}\n\n  ${CH}   ${M2} t-9c2e-1  # with its turn\n`;
  assert.deepEqual(parseTriggers(text), [
    { channelId: CH, triggerId: M1, turnId: null },
    { channelId: CH, triggerId: M2, turnId: 't-9c2e-1' },
  ]);
  assert.throws(() => parseTriggers(`${CH}\n`), /line 1/);
  assert.throws(() => parseTriggers(`${CH} ${M1}\n${CH} abc\n`), /line 2/);
  assert.throws(() => parseTriggers(`${CH} ${M1} not-a-turn\n`), /line 1/);
});

test('pair: pairOrder draws the first side of each pair from rng', () => {
  const values = [0.1, 0.9, 0.5, 0.49];
  let i = 0;
  assert.deepEqual(
    pairOrder(4, () => values[i++]),
    ['A', 'B', 'B', 'A']
  );
  assert.deepEqual(
    pairOrder(0, () => 0),
    []
  );
});

test('pair: renderSheet shows both answers unlabelled, escaped, and sheetPairIds reads the ids back', () => {
  const html = renderSheet([
    {
      id: 'p1',
      context: [{ author: 'Ζωή', text: 'hello <b>there</b>' }],
      first: { messages: ['side one'], reactions: [], gif: null, drawings: [], posts: [], skip: false },
      second: {
        messages: [],
        reactions: [{ emoji: 'wave' }],
        gif: null,
        drawings: [{ text: 'a cat <i>on</i> a roof' }],
        posts: [{ text: 'posted elsewhere' }],
        skip: false,
      },
    },
    { id: 'p"2', context: [], first: null, second: { messages: [], reactions: [], skip: true } },
  ]);
  assert.ok(html.includes('hello &lt;b&gt;there&lt;/b&gt;'));
  assert.ok(html.includes('side one'));
  assert.ok(html.includes('reaction: wave'));
  assert.ok(
    html.includes('drawing: a cat &lt;i&gt;on&lt;/i&gt; a roof'),
    'a picture she drew (her draw.create call) is shown'
  );
  assert.ok(html.includes('posted: posted elsewhere'), 'so is the text of a message call');
  assert.ok(html.includes('(stays silent)'));
  assert.ok(html.includes('(no answer: the request failed)'));
  // Blind: nothing on the sheet names a side.
  assert.ok(!/\b(side|prompts)\s*[AB]\b/.test(html));
  assert.ok(!html.includes('>A<') && !html.includes('>B<'));
  assert.deepEqual(sheetPairIds(html), ['p1', 'p"2']);
  assert.equal(escapeHtml(`a&<>"'`), 'a&amp;&lt;&gt;&quot;&#39;');
});

test('pair: tallyScores maps positions to sides through the key and counts the unscored', () => {
  const key = {
    pairs: { p1: { first: 'A' }, p2: { first: 'B' }, p3: { first: 'B' }, p4: { first: 'A' }, p5: { first: 'A' } },
  };
  const scores = { p1: 'first', p2: 'first', p3: 'second', p4: 'even', p5: 'maybe' };
  const result = tallyScores({ ids: ['p1', 'p2', 'p3', 'p4', 'p5'], key, scores });
  assert.deepEqual(result.pairs, [
    { id: 'p1', verdict: 'A' },
    { id: 'p2', verdict: 'B' },
    { id: 'p3', verdict: 'A' },
    { id: 'p4', verdict: 'even' },
    { id: 'p5', verdict: 'unscored' },
  ]);
  assert.deepEqual(result.totals, { A: 2, B: 1, even: 1, unscored: 1 });
  assert.throws(() => tallyScores({ ids: ['p9'], key, scores }), /p9/);
});
