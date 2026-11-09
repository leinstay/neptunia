// The one-time phrases that prove an account (src/interface/phrase-codes.ts): six distinct words drawn from a word
// list, accepted when all six stand in a message in any order and in any form the stemmer folds to the same key, and
// only while the message holds at most eighteen words of the list. The phrase is kept as a salted hash. The list is
// a file of config/ named by `bot.phraseWords`, overridden by the same file in the deployment's config/. Synthetic
// words, a fixed draw and temporary folders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createPhraseCodes, readWordList, wordListOf } from '../src/interface/phrase-codes.ts';
import type { IssuedPhrase, Matcher, PhraseCodes } from '../src/interface/phrase-codes.ts';
import { tempDir } from './fixtures/tmp.ts';

const WORDS = [
  'abandon',
  'badge',
  'cabin',
  'dance',
  'eagle',
  'fabric',
  'galaxy',
  'habit',
  'ice',
  'jacket',
  'kangaroo',
  'labor',
  'machine',
  'napkin',
  'oak',
  'paddle',
  'quantum',
  'rabbit',
  'saddle',
  'table',
  'umbrella',
  'vacuum',
  'wagon',
  'yard',
  'zebra',
];
const PLAIN: Matcher = { stem: (word) => word, endings: [] };

/** Codes over `WORDS` whose draw walks the list from `start`, so the phrase is known and differs per `start`. */
function codesOf(matcher: Matcher = PLAIN, words: ReadonlyArray<string> = WORDS, start = 0): PhraseCodes {
  let at = start;
  return createPhraseCodes({ words: () => words, matcher: () => matcher, draw: (below) => at++ % below });
}

function issued(codes: PhraseCodes): IssuedPhrase {
  const one = codes.issue();
  if (one === null) return assert.fail('no phrase was issued');
  return one;
}

test('issues six distinct words of the list as the phrase', () => {
  const { phrase } = issued(codesOf());
  const words = phrase.split(' ');
  assert.equal(words.length, 6);
  assert.equal(new Set(words).size, 6);
  assert.ok(words.every((word) => WORDS.includes(word)));
});

test('accepts the six words in any order among other words', () => {
  const codes = codesOf();
  const { phrase, seal } = issued(codes);
  const reversed = phrase.split(' ').reverse().join(', ');
  assert.equal(codes.holds(seal, `here it is: ${reversed}!`), true);
});

test('accepts a word in an inflected form the stemmer folds to the same key', () => {
  const codes = codesOf({ stem: (word) => word, endings: ['ed', 's'] });
  const { phrase, seal } = issued(codes);
  const [first, ...others] = phrase.split(' ');
  assert.equal(first, 'abandon');
  assert.equal(codes.holds(seal, ['abandoned', ...others].join(' ')), true);
});

test('refuses a message that holds five of the six words', () => {
  const codes = codesOf();
  const { phrase, seal } = issued(codes);
  assert.equal(codes.holds(seal, phrase.split(' ').slice(1).join(' ')), false);
});

test('refuses a message with nineteen words of the list even when all six are present', () => {
  const codes = codesOf();
  const { phrase, seal } = issued(codes);
  const others = WORDS.filter((word) => !phrase.split(' ').includes(word));
  assert.equal(codes.holds(seal, [phrase, ...others.slice(0, 13)].join(' ')), false);
});

test('accepts a message with eighteen words of the list when all six are present', () => {
  const codes = codesOf();
  const { phrase, seal } = issued(codes);
  const others = WORDS.filter((word) => !phrase.split(' ').includes(word));
  assert.equal(codes.holds(seal, [phrase, ...others.slice(0, 12)].join(' ')), true);
});

test('refuses the phrase of another issue', () => {
  const codes = codesOf(PLAIN, WORDS, 0);
  const first = issued(codes);
  const second = issued(codesOf(PLAIN, WORDS, 10));
  assert.equal(codes.holds(first.seal, second.phrase), false);
});

test('keeps the phrase only as a salted hash', () => {
  const { phrase, seal } = issued(codesOf());
  const kept = JSON.stringify(seal);
  for (const word of phrase.split(' ')) assert.equal(kept.includes(word), false, word);
});

test('refuses content that is no text', () => {
  const codes = codesOf();
  const { seal } = issued(codes);
  assert.equal(codes.holds(seal, undefined), false);
});

test('issues nothing from a list of fewer than six words', () => {
  assert.equal(codesOf(PLAIN, WORDS.slice(0, 5)).issue(), null);
});

test('reads one word per line and skips blank lines and comment lines', () => {
  assert.deepEqual(readWordList('# a list\nAbandon\n\n badge \nabandon\n'), ['abandon', 'badge']);
});

test("reads the list the setting names from the deployment's config before the tracked one", () => {
  const rootDir = tempDir('nep-phrase-root-');
  const privateDir = tempDir('nep-phrase-private-');
  fs.mkdirSync(path.join(rootDir, 'config'));
  fs.mkdirSync(path.join(privateDir, 'config'));
  fs.writeFileSync(path.join(rootDir, 'config', 'words.txt'), 'abandon\nbadge\n');
  const hot = { config: { bot: { phraseWords: 'words.txt' } }, rootDir, privateDir };
  assert.deepEqual(wordListOf(hot), ['abandon', 'badge']);
  fs.writeFileSync(path.join(privateDir, 'config', 'words.txt'), 'cabin\n');
  assert.deepEqual(wordListOf(hot), ['cabin']);
});

test('reads an empty list when the named file exists in neither layer', () => {
  const rootDir = tempDir('nep-phrase-root-');
  const hot = { config: { bot: { phraseWords: 'missing.txt' } }, rootDir, privateDir: rootDir };
  assert.deepEqual(wordListOf(hot), []);
});
