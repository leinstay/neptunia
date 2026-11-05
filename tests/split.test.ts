// Tests for src/behavior/split.ts: the cheap pre-filter in front of the splitter, its settings and
// the strict parse of its answer. Every behaviour test sets its own settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldShortParts, mayHaveParts, parseSplitAnswer, splitCandidate } from '../src/behavior/split.ts';

const SETTINGS = { minChars: 40, maxTasks: 3, contextMessages: 2, maxOutputTokens: 100 };
// PR 7d: the split switch is code.
const config = (split = SETTINGS) => ({ split });
const LONG = 'πρώτα πες μου ποιος είναι ο Νίκος, μετά κοίτα το κανάλι της Ελένης; και το μιμίδιο είναι αστείο.';

test('mayHaveParts: long text with two separators passes', () => {
  assert.equal(mayHaveParts(LONG, 40), true);
});

test('mayHaveParts: text under minChars never passes', () => {
  assert.equal(mayHaveParts('ποιος, τι; πού.', 40), false);
});

test('mayHaveParts: long text with fewer than two separators does not pass', () => {
  assert.equal(mayHaveParts('a'.repeat(60), 40), false);
  assert.equal(mayHaveParts(`${'b'.repeat(60)}?`, 40), false);
});

test('mayHaveParts: a run of separators counts once', () => {
  assert.equal(mayHaveParts(`${'c'.repeat(60)}?!...`, 40), false);
  assert.equal(mayHaveParts(`${'c'.repeat(30)}?! ${'d'.repeat(30)}.`, 40), true);
});

test('mayHaveParts: line breaks and semicolons are separators', () => {
  assert.equal(mayHaveParts(`${'e'.repeat(30)}\n${'f'.repeat(30)}; g`, 40), true);
});

test('mayHaveParts: links and Discord tokens neither count toward length nor bring separators', () => {
  const linkOnly = 'https://www.example.com/a.b.c?d=1,2;3 <@123456789012345678> <#123456789012345679>';
  assert.equal(mayHaveParts(linkOnly, 40), false);
});

test('splitCandidate: a direct call of every kind with structured text is a candidate', () => {
  // Plan 2026-11-04-cli-and-memory B1 and B2: the `name` kind is gone with name triggers, and `split` runs for every
  // started turn, an overheard one included.
  for (const kind of ['mention', 'reply', 'followUp', 'overheard', 'private']) {
    assert.equal(splitCandidate({ content: LONG }, kind, config()), true, kind);
  }
});

// Plan 2026-11-04-cli-and-memory B2: `missed` turns do not split; the overheard line moved to the test above.
test('splitCandidate: a missed-answer recovery and an unprompted turn never are', () => {
  assert.equal(splitCandidate({ content: LONG }, 'missed', config()), false);
  assert.equal(splitCandidate(null, null, config()), false);
});

test('parseSplitAnswer: the word one is one request', () => {
  assert.deepEqual(parseSplitAnswer('one', 3), { parts: null, reason: 'one' });
  assert.deepEqual(parseSplitAnswer('  One \n', 3), { parts: null, reason: 'one' });
});

test('parseSplitAnswer: dash lines are the parts, whitespace collapsed', () => {
  assert.deepEqual(parseSplitAnswer('- ποιος είναι ο Νίκος\n\n-   κοίτα  το κανάλι\n', 3), {
    parts: ['ποιος είναι ο Νίκος', 'κοίτα το κανάλι'],
    reason: 'parts',
  });
});

test('parseSplitAnswer: more parts than maxTasks are cut', () => {
  assert.deepEqual(parseSplitAnswer('- a\n- b\n- c\n- d', 3).parts, ['a', 'b', 'c']);
});

test('parseSplitAnswer: anything else is one request, unparsed', () => {
  for (const text of [
    '- only one part',
    'two\n- a\n- b',
    '- a\nmore text\n- b',
    '1. a\n2. b',
    '-a\n-b',
    '- a\n- ',
    'yes',
  ]) {
    assert.deepEqual(parseSplitAnswer(text, 3), { parts: null, reason: 'unparsed' }, JSON.stringify(text));
  }
});

test('parseSplitAnswer: an empty or missing answer is empty', () => {
  assert.deepEqual(parseSplitAnswer('  \n', 3), { parts: null, reason: 'empty' });
  assert.deepEqual(parseSplitAnswer(undefined, 3), { parts: null, reason: 'empty' });
});

const OPENER = 'θα έχει μειονεκτήματα;';
const ARGUMENT = 'αφού ο καθένας ζει μόνος του και κανείς δεν φταίει';
const CLOSER = 'τι μπορεί να κάνει λοιπόν μια φίλη;';
const FOLD = { maxTasks: 4, minPartChars: 30 };

test('parseSplitAnswer: a two-part answer with a short opener folds to one', () => {
  assert.deepEqual(
    parseSplitAnswer(
      `- ${OPENER}
- ${ARGUMENT} ${CLOSER}`,
      FOLD
    ),
    { parts: null, reason: 'folded' }
  );
});

test('parseSplitAnswer: a short middle part joins the next one', () => {
  assert.deepEqual(
    parseSplitAnswer(
      `- ${ARGUMENT}
- ${OPENER}
- ${CLOSER}`,
      FOLD
    ),
    {
      parts: [ARGUMENT, `${OPENER} ${CLOSER}`],
      reason: 'parts',
    }
  );
});

test('parseSplitAnswer: a short last part joins the previous one', () => {
  assert.deepEqual(
    parseSplitAnswer(
      `- ${ARGUMENT}
- ${CLOSER}
- ${OPENER}`,
      FOLD
    ),
    {
      parts: [ARGUMENT, `${CLOSER} ${OPENER}`],
      reason: 'parts',
    }
  );
});

test('parseSplitAnswer: minPartChars 0 or a bare maxTasks number folds nothing', () => {
  const answer = `- ${OPENER}
- ${ARGUMENT}`;
  assert.deepEqual(parseSplitAnswer(answer, { maxTasks: 4, minPartChars: 0 }).parts, [OPENER, ARGUMENT]);
  assert.deepEqual(parseSplitAnswer(answer, 4).parts, [OPENER, ARGUMENT]);
});

test('parseSplitAnswer: settings without minPartChars fold at the shipped default', () => {
  assert.deepEqual(
    parseSplitAnswer(
      `- ναι;
- ${ARGUMENT}`,
      { maxTasks: 4 }
    ),
    { parts: null, reason: 'folded' }
  );
});

test('foldShortParts: a part exactly at the minimum stays', () => {
  const exact = 'é'.repeat(10);
  assert.deepEqual(foldShortParts([exact, 'à'.repeat(12)], 10), [exact, 'à'.repeat(12)]);
  assert.deepEqual(foldShortParts(['é'.repeat(9), 'à'.repeat(12)], 10), [`${'é'.repeat(9)} ${'à'.repeat(12)}`]);
});

test('foldShortParts: links and Discord tokens do not count toward the length', () => {
  const padded = 'κοίτα <@123456789012345678> https://www.example.com/a/very/long/path <:emoji:123456789012345679>';
  assert.deepEqual(foldShortParts([padded, ARGUMENT], 20), [`${padded} ${ARGUMENT}`]);
});

test('foldShortParts: folding repeats until every part meets the minimum', () => {
  assert.deepEqual(foldShortParts(['αα', 'ββ', 'γγ', ARGUMENT], 10), [`αα ββ γγ ${ARGUMENT}`]);
  assert.deepEqual(foldShortParts([ARGUMENT, 'αα', 'ββ'], 10), [`${ARGUMENT} αα ββ`]);
});

test('foldShortParts: does not change its input', () => {
  const parts = ['αα', ARGUMENT];
  foldShortParts(parts, 10);
  assert.deepEqual(parts, ['αα', ARGUMENT]);
});
