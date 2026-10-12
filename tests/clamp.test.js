// Tests for src/memory/clamp.js: clampText -- the boundary-aware, tolerant,
// token-safe replacement for a blind `.slice(0, limit)`. Pure, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampAtBoundary, clampChars, clampText, clampWithEllipsis, countDashes, oneLine, stripDashes } from '../src/memory/clamp.js';

// ---- non-string / empty --------------------------------------------------

test('clampText: a non-string returns an empty string', () => {
  assert.equal(clampText(undefined, 10), '');
  assert.equal(clampText(42, 10), '');
});

// ---- under / at / over the tolerance -------------------------------------

test('clampText: text under the limit is returned trimmed, unchanged', () => {
  assert.equal(clampText('  hello world  ', 20), 'hello world');
});

test('clampText: text exactly at the tolerance ceiling is kept whole', () => {
  const text = 'a'.repeat(10);
  assert.equal(clampText(text, 8, { tolerance: 1.25 }), text);
});

test('clampText: text past the tolerance ceiling is cut down to it', () => {
  const text = 'x'.repeat(11); // limit 8 * 1.25 = 10
  const result = clampText(text, 8, { tolerance: 1.25 });
  assert.ok(result.length <= 10);
  assert.equal(result, 'x'.repeat(10));
});

// ---- sentence boundary preferred ------------------------------------------

test('clampText: prefers the end of the last complete sentence when it keeps >= 60% of the allowed length', () => {
  const text = 'Alpha bravo charlie delta echo. Foxtrot golf hotel india juliet kilo lima mike november oscar.';
  const result = clampText(text, 40, { tolerance: 1 });
  assert.equal(result, 'Alpha bravo charlie delta echo.');
});

test('clampText: a sentence end followed by a closing quote/bracket is kept with it', () => {
  const text = 'He said "stop now." Then he left the room entirely for good this time around.';
  const result = clampText(text, 25, { tolerance: 1 });
  assert.equal(result, 'He said "stop now."');
});

test('clampText: a sentence boundary kept only when it retains at least 60% of the allowed length', () => {
  // "Hi." ends at index 3; allowed length 20; 3 is well under 60% of 20 (12) -> word boundary used instead.
  const text = 'Hi. And then a very long continuation that keeps going for a while yet.';
  const result = clampText(text, 20, { tolerance: 1 });
  assert.equal(result, 'Hi. And then a very');
});

// ---- word boundary fallback ------------------------------------------------

test('clampText: falls back to the last whitespace when no usable sentence boundary exists', () => {
  const text = 'alpha bravo charlie delta echo foxtrot golf';
  const result = clampText(text, 20, { tolerance: 1 });
  assert.equal(result, 'alpha bravo charlie');
});

// ---- single very long word: hard cut allowed only then --------------------

test('clampText: a single very long word with no boundary at all is hard-cut at the tolerance ceiling', () => {
  const text = 'x'.repeat(100);
  const result = clampText(text, 20, { tolerance: 1 });
  assert.equal(result, 'x'.repeat(20));
});

test('clampText: a hard cut is only used when there really is no earlier boundary', () => {
  const text = `${'a'.repeat(5)} ${'b'.repeat(100)}`;
  const result = clampText(text, 20, { tolerance: 1 });
  // the last whitespace (right after the first word) is preferred over cutting mid-word.
  assert.equal(result, 'aaaaa');
});

// ---- token safety: never split a <@digits> mention ------------------------

test('clampText: a token that fits entirely before the cut, right at the boundary, is kept whole', () => {
  const text = 'ping <@123456789012345678> please respond soon about the thing we discussed yesterday';
  const result = clampText(text, 26, { tolerance: 1 }); // "ping <@123456789012345678>" is exactly 26 chars
  assert.equal(result, 'ping <@123456789012345678>');
});

test('clampText: a token that would be split is dropped entirely, leaving no partial marker', () => {
  // No whitespace before the token, so the only cut left is the hard one at 10 code points,
  // which lands inside the token (code points 3 to 23).
  const text = 'abc<@999999999999999999> and more words after it';
  const result = clampText(text, 10, { tolerance: 1 });
  assert.equal(result, 'abc', 'the straddling token is dropped whole, not chopped');
  assert.ok(!result.includes('<@'));
});

// ---- dangling opening bracket / trailing separator -------------------------

test('clampText: a dangling opening bracket left at the cut is stripped', () => {
  // The word cut lands on the space right after the bracket, so the bracket is the last thing kept.
  for (const open of ['(', '[']) {
    const text = `plays chess ${open} mostly on weekends with friends`;
    assert.equal(clampText(text, 16, { tolerance: 1 }), 'plays chess', `word cut after ${open}`);
  }
  // A hard cut (no whitespace at all) leaves it glued to the word before it.
  assert.equal(clampText('abc(defghijklmnop', 4, { tolerance: 1 }), 'abc', 'hard cut after (');
});

test('clampText: a trailing comma left at the cut is stripped', () => {
  const text = 'likes cats, dogs, and other animals of many different kinds and sizes';
  const result = clampText(text, 11, { tolerance: 1 });
  assert.ok(!result.endsWith(','));
});

// ---- surrogate pairs / emoji never split -----------------------------------

test('clampText: length is counted in code points, not UTF-16 units', () => {
  const emoji = '🎉'; // 1 code point, 2 UTF-16 units
  const text = emoji.repeat(5); // 5 code points, 10 UTF-16 units
  assert.equal(clampText(text, 5, { tolerance: 1 }), text, 'fits exactly in 5 code points, not cut');
  assert.equal(clampText(text, 4, { tolerance: 1 }), emoji.repeat(4));
});

// ---- tolerance sanitization -------------------------------------------------

test('clampText: a non-number tolerance is treated as a hard limit (1)', () => {
  const text = 'x'.repeat(10);
  assert.equal(clampText(text, 8, { tolerance: 'garbage' }), 'x'.repeat(8));
  assert.equal(clampText(text, 8, { tolerance: null }), 'x'.repeat(8));
});

test('clampText: a tolerance below 1 is treated as a hard limit (1)', () => {
  const text = 'x'.repeat(10);
  assert.equal(clampText(text, 8, { tolerance: 0.5 }), 'x'.repeat(8));
  assert.equal(clampText(text, 8, { tolerance: -3 }), 'x'.repeat(8));
});

test('clampText: tolerance >= 1 is used as given', () => {
  const text = 'x'.repeat(20);
  assert.equal(clampText(text, 8, { tolerance: 2 }), 'x'.repeat(16));
});

// ---- non-finite / missing limit --------------------------------------------

test('clampText: a non-finite or non-positive limit means no clamp at all', () => {
  const text = 'hello world';
  assert.equal(clampText(text, undefined), text);
  assert.equal(clampText(text, 0), text);
  assert.equal(clampText(text, Infinity), text);
});

// ---- never exceeds limit * tolerance ---------------------------------------

test('clampText: never returns a string longer than limit * tolerance, across many shapes', () => {
  const limit = 15;
  const tolerance = 1.25;
  const maxAllowed = Math.floor(limit * tolerance);
  const samples = [
    'x'.repeat(200),
    'word '.repeat(50),
    'One sentence here. Another one follows right after it without delay.',
    `prefix <@111111111111111111> ${'y'.repeat(100)}`,
    'πολλές λέξεις εδώ που ξεπερνούν σίγουρα το όριο που έχουμε ορίσει',
  ];
  for (const sample of samples) {
    const result = clampText(sample, limit, { tolerance });
    assert.ok(Array.from(result).length <= maxAllowed, `"${sample}" -> "${result}" exceeds ${maxAllowed}`);
  }
});

// ---- non-ASCII (Greek / accented Latin) ------------------------------------

test('clampText: cuts a Greek sentence at a word boundary, not mid-word', () => {
  const text = 'Αυτή είναι μια πολύ μεγάλη πρόταση που σίγουρα ξεπερνά το όριο που έχει οριστεί εδώ';
  const result = clampText(text, 20, { tolerance: 1 });
  assert.equal(result, 'Αυτή είναι μια πολύ');
});

// ---- oneLine / clampChars ----------------------------------------------------

test('oneLine: collapses every whitespace run to one space and trims', () => {
  assert.equal(oneLine('  καλή\n\tμέρα \r\n  φίλε  '), 'καλή μέρα φίλε');
  assert.equal(oneLine(null), '');
  assert.equal(oneLine(42), '42');
});

test('clampChars: cuts at most max code points, never inside a surrogate pair', () => {
  assert.equal(clampChars('café', 3), 'caf');
  assert.equal(clampChars('a😀b', 2), 'a😀');
  assert.equal(clampChars('abc', 2.9), 'ab');
  assert.equal(clampChars('abc', 0), '');
  assert.equal(clampChars('abc', 10), 'abc');
});

test('clampChars: a max that is not a finite non-negative number leaves the text whole', () => {
  for (const max of [undefined, NaN, -1, '2']) {
    assert.equal(clampChars('abc', max), 'abc', `max ${String(max)}`);
  }
  assert.equal(clampChars(null, 5), '');
});

// ---- clampWithEllipsis ----------------------------------------------------

test('clampWithEllipsis: a cut text ends at a word boundary with an ellipsis, within the limit', () => {
  const out = clampWithEllipsis('ένας γάτος χορεύει πάνω στο τραπέζι', 14);
  assert.equal(out, 'ένας γάτος…');
  assert.ok([...out].length <= 14);
});

test('clampWithEllipsis: a text within the limit is returned trimmed, no ellipsis', () => {
  assert.equal(clampWithEllipsis('  café crème  ', 20), 'café crème');
  assert.equal(clampWithEllipsis('café crème', 10), 'café crème');
});

test('clampWithEllipsis: a cut at a complete sentence gets no ellipsis', () => {
  assert.equal(clampWithEllipsis('Il pleut. Le chat dort sur le canapé depuis midi', 14), 'Il pleut.');
});

test('clampWithEllipsis: a limit that is not a positive number leaves the text whole; a non-string is empty', () => {
  assert.equal(clampWithEllipsis('café crème brûlée', 0), 'café crème brûlée');
  assert.equal(clampWithEllipsis('café crème brûlée', undefined), 'café crème brûlée');
  assert.equal(clampWithEllipsis(null, 10), '');
});

// ---- stripDashes / countDashes ---------------------------------------------

test('stripDashes: guillemets become plain double quotes, with or without dashes', () => {
  assert.equal(stripDashes('«μια φράση» είναι έτσι'), '"μια φράση" είναι έτσι');
  assert.equal(stripDashes('«α» — «β»'), '"α" "β"');
  assert.equal(stripDashes('no quotes here'), 'no quotes here');
});

test('stripDashes: an em or en dash between words becomes one space, spaced or not', () => {
  assert.equal(stripDashes('λέξη — λέξη'), 'λέξη λέξη');
  assert.equal(stripDashes('λέξη—λέξη'), 'λέξη λέξη');
  assert.equal(stripDashes('café – crème'), 'café crème');
  assert.equal(stripDashes('café–crème'), 'café crème');
  assert.equal(stripDashes('un  —  deux — — trois'), 'un deux trois');
});

test('stripDashes: a dash at the start or end goes with its space; a dash-only text becomes empty', () => {
  assert.equal(stripDashes('— όχι'), 'όχι');
  assert.equal(stripDashes('ναι —'), 'ναι');
  assert.equal(stripDashes('—'), '');
  assert.equal(stripDashes(' – — '), '');
});

test('stripDashes: a dash-only line inside a text becomes empty, other lines keep their breaks', () => {
  assert.equal(stripDashes('πρώτη\n—\nτρίτη — τέλος'), 'πρώτη\n\nτρίτη τέλος');
});

test('stripDashes: hyphens are untouched -- compounds, times and links stay', () => {
  const text = 'peut-être à 10-12 h, voir https://example.com/a-b-c -- ok - non';
  assert.equal(stripDashes(text), text);
});

test('stripDashes: mixed scripts, and a non-string reads as empty', () => {
  assert.equal(stripDashes('Ζωή—Zoé – Ελένη — Hélène'), 'Ζωή Zoé Ελένη Hélène');
  assert.equal(stripDashes(null), '');
});

test('countDashes: em and en dashes counted, hyphens not', () => {
  assert.equal(countDashes('a — b – c - d —— e'), 4);
  assert.equal(countDashes('peut-être'), 0);
  assert.equal(countDashes(undefined), 0);
});

test('clampWithEllipsis: a limit of 1 is a hard cut with no room for the ellipsis', () => {
  assert.equal(clampWithEllipsis('café crème', 1), 'c');
});

test('clampAtBoundary: text within the limit is returned unchanged', () => {
  assert.equal(clampAtBoundary('One. Two.', 9), 'One. Two.');
  assert.equal(clampAtBoundary('  spaced  ', 50), '  spaced  ');
});

test('clampAtBoundary: cuts at the last sentence end past 60% of the limit', () => {
  assert.equal(clampAtBoundary('Aaaa bbbb. Cccc dddd eeee', 16), 'Aaaa bbbb.');
});

test('clampAtBoundary: cuts at a word boundary when no sentence end is late enough', () => {
  assert.equal(clampAtBoundary('Hi. alpha beta gamma delta', 16), 'Hi. alpha beta');
});

test('clampAtBoundary: never cuts inside a mention token', () => {
  const out = clampAtBoundary('say hi<@123456789> and more words', 12);
  assert.ok(!out.includes('<@'));
  assert.equal(out, 'say');
});

test('clampAtBoundary: handles Greek and accented text by code points', () => {
  assert.equal(clampAtBoundary('άλφα βήτα γάμμα δέλτα', 12), 'άλφα βήτα');
  assert.equal(clampAtBoundary('café crème brûlée', 11), 'café crème');
});

test('clampAtBoundary: a max that is not a finite non-negative number leaves the text whole', () => {
  assert.equal(clampAtBoundary('abc def', undefined), 'abc def');
  assert.equal(clampAtBoundary('abc', 0), '');
});
