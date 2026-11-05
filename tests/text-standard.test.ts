// The check behind the English standard of stored text (master plan U.2): whether the letters of a think or a media
// description are mostly of another script, with what stands in quotes left out, since speech, captions and on-screen
// text are quoted in their original language. Pure, no model. The Cyrillic samples are escapes so this file stays
// readable on any terminal; the rest is synthetic Greek.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOffScript } from '../src/memory/text-standard.ts';

const RUSSIAN = 'Кот сидит на диване';

// Bug: the check knows only Cyrillic and a description in another script passes as English.
test('text mostly in a non-Latin script is off script, whichever script it is', () => {
  assert.equal(isOffScript(RUSSIAN), true);
  assert.equal(isOffScript('Μια γάτα κάθεται στον καναπέ'), true);
  assert.equal(isOffScript('猫がソファに座っている'), true);
});

// Bug: an English description is described again and paid for twice.
test('English text is on script', () => {
  assert.equal(isOffScript('A cat sits on a sofa.'), false);
});

// Bug: accented Latin letters count as another script and French or Polish words trip the check.
test('accented Latin letters are Latin', () => {
  assert.equal(isOffScript('Déjà vu à la crème brûlée, żółć'), false);
});

// Bug: a description that quotes its caption, as the standard asks, is flagged for doing so.
test('what stands in quotes does not count', () => {
  for (const quoted of [
    `A sign reads "${RUSSIAN}".`,
    `A sign reads «${RUSSIAN}».`,
    `A sign reads “${RUSSIAN}”.`,
    `A sign reads „${RUSSIAN}“.`,
  ])
    assert.equal(isOffScript(quoted), false, quoted);
});

// Bug: one stray quote mark hides a whole description in another script.
test('a quote mark with no partner hides nothing', () => {
  assert.equal(isOffScript(`A sign reads " ${RUSSIAN} ${RUSSIAN} ${RUSSIAN}`), true);
});

// Bug: an apostrophe opens a quote and hides the Greek between two contractions.
test('an apostrophe is no quote mark', () => {
  assert.equal(isOffScript(`it's ${RUSSIAN} ${RUSSIAN} ${RUSSIAN} it's`), true);
});

// Bug: a description of nothing but a quoted caption counts as another script.
test('a description that is all quote is on script', () => {
  assert.equal(isOffScript(`"${RUSSIAN}"`), false);
});

// Bug: digits, emoji or punctuation count as letters and shift the share.
test('only letters count', () => {
  assert.equal(isOffScript('Γάτα 1234567890 🐈🐈🐈 !!! ???'), true);
  assert.equal(isOffScript('Cat 1234567890 🐈🐈🐈 !!! ???'), false);
});

// Bug: "mostly" read as "at least half" flags an even mix.
test('exactly half of the letters is not mostly', () => {
  assert.equal(isOffScript('abcd αβγδ'), false);
  assert.equal(isOffScript('abc αβγδ'), true);
});

// Bug: a text with no letters divides by zero and reads as off script.
test('a text with no letters is on script', () => {
  assert.equal(isOffScript(''), false);
  assert.equal(isOffScript('123 🐈'), false);
});
