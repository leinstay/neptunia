// The one-time phrases that prove an account (src/interface/phrase-codes.ts): six distinct words drawn from a word
// list, accepted when all six stand in a message in any order and in any form the stemmer folds to the same key, and
// only while the message holds at most eighteen words of the list. The phrase is kept as a salted hash. The list is
// a file of src/mnemonic/ that `bot.mnemonic` picks by language. Synthetic words, a fixed draw and temporary folders
// only, except for the two shipped lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createPhraseCodes, mnemonicOf, readWordList, wordListOf } from '../src/interface/phrase-codes.ts';
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

test('reads one word per line, folded to lower case, and skips blank lines and repeats', () => {
  assert.deepEqual(readWordList('Abandon\n\n badge \nabandon\n'), ['abandon', 'badge']);
});

/** A root with a `src/mnemonic/` folder that holds one file per language. */
function rootWith(files: Record<string, string>): string {
  const rootDir = tempDir('nep-phrase-root-');
  fs.mkdirSync(path.join(rootDir, 'src', 'mnemonic'), { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(rootDir, 'src', 'mnemonic', name), text);
  return rootDir;
}

test('reads the file of the language `bot.mnemonic` names', () => {
  const rootDir = rootWith({ 'bip-en': 'abandon\nbadge\n', 'bip-ru': 'город\nдорога\n' });
  assert.deepEqual(wordListOf({ config: { bot: { mnemonic: 'ru' } }, rootDir }), ['город', 'дорога']);
  assert.deepEqual(wordListOf({ config: { bot: { mnemonic: 'en' } }, rootDir }), ['abandon', 'badge']);
});

test('reads the English list when `bot.mnemonic` is absent or names no language', () => {
  const rootDir = rootWith({ 'bip-en': 'abandon\n', 'bip-ru': 'город\n' });
  assert.deepEqual(wordListOf({ config: { bot: {} }, rootDir }), ['abandon']);
  assert.deepEqual(wordListOf({ config: { bot: { mnemonic: '../../etc/passwd' } }, rootDir }), ['abandon']);
});

test('reads an empty list when the language has no file', () => {
  const rootDir = rootWith({ 'bip-en': 'abandon\n' });
  assert.deepEqual(wordListOf({ config: { bot: { mnemonic: 'ru' } }, rootDir }), []);
});

test('names the language the setting holds, English when it holds none', () => {
  assert.equal(mnemonicOf({ bot: { mnemonic: 'ru' } }), 'ru');
  assert.equal(mnemonicOf({ bot: { mnemonic: 'de' } }), 'en');
  assert.equal(mnemonicOf(undefined), 'en');
});

test('ships two lists of 2048 distinct words each, one word per line and no comment', () => {
  const rootDir = path.resolve(import.meta.dirname, '..');
  for (const language of ['en', 'ru']) {
    const file = fs.readFileSync(path.join(rootDir, 'src', 'mnemonic', `bip-${language}`), 'utf8');
    assert.equal(file.includes('#'), false, language);
    assert.equal(readWordList(file).length, 2048, language);
    assert.equal(file.split('\n').filter((line) => line.trim() !== '').length, 2048, language);
  }
});

test('refuses a phrase issued from one list once the other list is the setting', () => {
  const rootDir = rootWith({
    'bip-en': WORDS.join('\n'),
    'bip-ru': ['город', 'дорога', 'школа', 'река', 'лес', 'гора', 'море', 'поле'].join('\n'),
  });
  const config = { bot: { mnemonic: 'en' } };
  const codes = createPhraseCodes({
    words: () => wordListOf({ config, rootDir }),
    matcher: () => PLAIN,
  });
  const { phrase, seal } = issued(codes);
  assert.equal(codes.holds(seal, phrase), true);
  config.bot.mnemonic = 'ru';
  assert.equal(codes.holds(seal, phrase), false);
});
