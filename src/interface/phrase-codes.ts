// The one-time phrases that prove an account belongs to someone, after the owner's design of 2026-10-16: six distinct
// words drawn from a word list with `node:crypto`, accepted when all six stand in a message in any order and in any
// grammatical form, and only while the message holds at most eighteen words of the list, so pasting the whole list
// fails. A word matches a word of the list when both share a key: the word itself, its key under the memory's learned
// stemmer, or the word without one of the stemmer's learned endings (src/memory/db/stems.ts, `loadStemmer`). The
// phrase is kept only as a salted SHA-256 hash of its six words in list order, so a seal can be written to disk and a
// message is checked by hashing each set of six of the list words it holds.
//
// The list is a file of `src/mnemonic/` with one word per line and no comment, `bip-en` or `bip-ru`, picked by
// `bot.mnemonic` at each use. A phrase issued under one language holds none of the other's words, so a switch refuses
// every phrase issued before it. Used by the owner's pairing
// (src/interface/pairing.ts) and her link tool (src/interface/person-link.ts). Nothing here logs.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadStemmer } from '../memory/db/stems.ts';
import type { Db } from '../memory/db/types.ts';
import { indexWords } from '../memory/record-index.ts';

/** How many words a phrase has. */
export const PHRASE_WORDS = 6;
/** The most words of the list a message may hold and still be checked. */
export const MAX_DICTIONARY_WORDS = 18;
/** A phrase as a label shows it, six words joined by one space, for a line that carries one. */
export const PHRASE_PATTERN = '[\\p{L}\\p{N}]+(?: [\\p{L}\\p{N}]+){5}';
/** The most distinct list words a message may match; past it the sets of six to hash grow too many. */
const MAX_CANDIDATES = 24;
/** Draws before the issue gives up finding six words that no shared key confuses. */
const MAX_DRAWS = 1000;

/** How the words of a message are folded to keys: the learned stemmer and its endings. */
export type Matcher = { stem: (word: string) => string; endings: ReadonlyArray<string> };
/** What is kept of a phrase: a random salt and the hash of its words. */
export type Seal = { salt: string; hash: string };
/** A phrase to show once, and its seal to keep. */
export type IssuedPhrase = { phrase: string; seal: Seal };
export type PhraseCodes = {
  /** A fresh phrase, or null when the list holds fewer than six words that no shared key confuses. */
  issue(): IssuedPhrase | null;
  /** Whether `text` holds the six words of `seal` within the limit of list words. */
  holds(seal: Seal, text: unknown): boolean;
};

/** The matcher of exact words, while the memory has no learned stemmer. */
const EXACT: Matcher = { stem: (word) => word, endings: [] };

/** The memory's learned stemmer as a matcher; exact words while the database is closed. */
export function matcherOf(db: Db | null): Matcher {
  return db === null ? EXACT : loadStemmer(db);
}

/** The keys a word matches by: itself, its stem, and itself without each learned ending shorter than what stays. */
function keysOf(word: string, matcher: Matcher): Set<string> {
  const keys = new Set([word, matcher.stem(word)]);
  const chars = [...word];
  for (const ending of matcher.endings) {
    const size = [...ending].length;
    if (size > 0 && chars.length - size > size && word.endsWith(ending))
      keys.add(chars.slice(0, chars.length - size).join(''));
  }
  return keys;
}

/** The words of a list file: one per line, folded as the memory folds text, blank lines skipped. */
export function readWordList(text: string): Array<string> {
  const words = new Set<string>();
  for (const line of text.split('\n')) {
    const [word] = indexWords(line);
    if (word !== undefined) words.add(word);
  }
  return [...words];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The languages of the shipped lists, `src/mnemonic/bip-<language>`. */
export const MNEMONIC_LANGUAGES: ReadonlyArray<string> = ['en', 'ru'];

/** The language `bot.mnemonic` holds in `config`, `en` when it holds none of the shipped ones. */
export function mnemonicOf(config: unknown): string {
  const bot = isRecord(config) ? config.bot : null;
  const language = isRecord(bot) ? bot.mnemonic : null;
  return typeof language === 'string' && MNEMONIC_LANGUAGES.includes(language) ? language : 'en';
}

/** The list of the language `bot.mnemonic` holds, from the engine's `src/mnemonic/`; empty when the file is missing. */
export function wordListOf(hot: { readonly config: unknown; rootDir: string }): Array<string> {
  const file = path.join(hot.rootDir, 'src', 'mnemonic', `bip-${mnemonicOf(hot.config)}`);
  return fs.existsSync(file) ? readWordList(fs.readFileSync(file, 'utf8')) : [];
}

/** The phrase codes of the running core: the list of the language `bot.mnemonic` holds and the memory's stemmer, both read at use. */
export function phraseCodesOf(
  hot: { readonly config: unknown; readonly rootDir?: string },
  database: () => Db | null
): PhraseCodes {
  return createPhraseCodes({
    words: () => (hot.rootDir === undefined ? [] : wordListOf({ config: hot.config, rootDir: hot.rootDir })),
    matcher: () => matcherOf(database()),
  });
}

/** The hash of six list words under a salt, in list order so that the order typed does not count. */
function hashOf(salt: string, words: ReadonlyArray<string>): string {
  return createHash('sha256')
    .update(`${salt}\n${[...words].sort().join(' ')}`)
    .digest('hex');
}

/** Every set of `size` of `items`, each in the order of `items`. */
function* setsOf(items: ReadonlyArray<string>, size: number, from = 0): Generator<Array<string>> {
  if (size === 0) {
    yield [];
    return;
  }
  for (let at = from; at <= items.length - size; at += 1)
    for (const rest of setsOf(items, size - 1, at + 1)) yield [items[at] ?? '', ...rest];
}

const sameHash = (left: string, right: string): boolean =>
  left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));

export function createPhraseCodes({
  words,
  matcher,
  draw = (below) => randomInt(0, below),
}: {
  /** The word list, read at each use. */
  words: () => ReadonlyArray<string>;
  /** How words fold to keys, read at each use. */
  matcher: () => Matcher;
  /** A whole number in [0, below) from the system's secure source. */
  draw?: (below: number) => number;
}): PhraseCodes {
  return {
    issue() {
      const list = words();
      const fold = matcher();
      const chosen: Array<string> = [];
      const taken = new Set<string>();
      for (let tries = 0; chosen.length < PHRASE_WORDS && tries < MAX_DRAWS && list.length > 0; tries += 1) {
        const word = list[draw(list.length)] ?? '';
        const keys = keysOf(word, fold);
        if ([...keys].some((key) => taken.has(key))) continue;
        chosen.push(word);
        for (const key of keys) taken.add(key);
      }
      if (chosen.length < PHRASE_WORDS) return null;
      const salt = randomBytes(16).toString('hex');
      return { phrase: chosen.join(' '), seal: { salt, hash: hashOf(salt, chosen) } };
    },
    holds(seal, text) {
      if (typeof text !== 'string') return false;
      const fold = matcher();
      const byKey = new Map<string, Set<string>>();
      for (const word of words())
        for (const key of keysOf(word, fold)) byKey.set(key, (byKey.get(key) ?? new Set()).add(word));
      const candidates = new Set<string>();
      let dictionaryWords = 0;
      for (const token of indexWords(text)) {
        const hits = [...keysOf(token, fold)].flatMap((key) => [...(byKey.get(key) ?? [])]);
        if (hits.length === 0) continue;
        dictionaryWords += 1;
        for (const hit of hits) candidates.add(hit);
      }
      if (dictionaryWords > MAX_DICTIONARY_WORDS || candidates.size > MAX_CANDIDATES) return false;
      for (const six of setsOf([...candidates], PHRASE_WORDS))
        if (sameHash(hashOf(seal.salt, six), seal.hash)) return true;
      return false;
    },
  };
}
