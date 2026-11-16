// The words of a text as the memory database's word search sees them, and the word endings learned
// from those words. No model anywhere and no list of endings in code.
//
// - Words (indexWords): runs of word characters of the folded text (src/memory/recent.ts#foldText),
//   URLs left out, at most 40 characters, a run of 15+ digits (an id) left out.
// - Word endings (learnEndings): an ending of one to three letters counts when many stems of the
//   vocabulary are seen with it and with other endings. A word's key (stemmerOf) is the word without
//   the learned ending that leaves the most productive stem, so the inflected forms of one word share
//   a key in any language the text is written in. src/memory/db/stems.ts learns the endings from the
//   database's own text and keeps them.

import { foldText } from './recent.ts';
import { URL_PATTERN, isWordChar } from './mentions.ts';
import type { Untyped } from './types.ts';

/** A URL in a text: its words (scheme, host, path, ids) are no words of the chat. */
const URL_RE = new RegExp(URL_PATTERN, 'g');
/** A word longer than this (in code points) is no word: a pasted token, a link's tail. */
const MAX_WORD_CHARS = 40;
/** A run of this many digits or more is an id, not a word. */
const ID_DIGITS = 15;
/** The longest learned ending, in letters. */
const MAX_ENDING_CHARS = 3;
/** The shortest stem a learned ending may leave. */
const MIN_STEM_CHARS = 3;
/** A stem seen with this many endings (the bare stem counting as one) votes for each of them. */
const MIN_STEM_FORMS = 3;
/** An ending needs this share of the vocabulary's words as votes (at least MIN_ENDING_VOTES). */
const ENDING_VOTE_SHARE = 0.002;
const MIN_ENDING_VOTES = 5;
/** The most endings learned. */
const MAX_ENDINGS = 80;

/** Whether `word` holds a digit. */
function hasDigit(word: string): boolean {
  return /\p{N}/u.test(word);
}

/**
 * The words of `text` as the index sees them: URLs left out, folded (foldText), runs of word
 * characters (isWordChar), at most 40 code points each, a run of 15+ digits left out. Pure.
 */
export function indexWords(text: unknown): Array<string> {
  const out: Array<Untyped> = [];
  let current = '';
  const push = () => {
    if (!current) return;
    const chars = [...current].length;
    if (chars <= MAX_WORD_CHARS && !(chars >= ID_DIGITS && /^\p{N}+$/u.test(current))) out.push(current);
    current = '';
  };
  for (const ch of foldText(String(text ?? '').replace(URL_RE, ' '))) {
    if (isWordChar(ch)) current += ch;
    else push();
  }
  push();
  return out;
}

/** The splits of `word` (code points) into a stem of MIN_STEM_CHARS+ and an ending of one to MAX_ENDING_CHARS letters. */
function splits(chars: Array<string>): Array<{ stem: string; ending: string }> {
  const out: Array<{ stem: string; ending: string }> = [];
  for (let k = 1; k <= MAX_ENDING_CHARS && chars.length - k >= MIN_STEM_CHARS; k += 1) {
    const ending = chars.slice(chars.length - k).join('');
    if (!/^\p{L}+$/u.test(ending)) break;
    out.push({ stem: chars.slice(0, chars.length - k).join(''), ending });
  }
  return out;
}

/**
 * The word endings of a vocabulary (`words`, distinct or not; words with a digit ignored): for each
 * stem of MIN_STEM_CHARS+ letters, the endings (one to MAX_ENDING_CHARS letters) it is seen with,
 * the bare stem counting as one when it is a word itself; a stem seen with MIN_STEM_FORMS or more
 * votes for each of its endings. An ending with at least ENDING_VOTE_SHARE of the vocabulary's size
 * in votes (never under MIN_ENDING_VOTES) is learned; at most MAX_ENDINGS, the most voted first.
 * Returns the endings and the productivity of each stem (how many learned endings it is seen with,
 * the bare stem counting) for stemmerOf. Pure.
 */
export function learnEndings(words: Iterable<string>): { endings: Array<string>; productivity: Map<string, number> } {
  const vocabulary = new Set<string>();
  for (const word of words) if (typeof word === 'string' && word && !hasDigit(word)) vocabulary.add(word);
  const formsOf = new Map();
  for (const word of vocabulary) {
    for (const { stem, ending } of splits([...word])) {
      if (!formsOf.has(stem)) formsOf.set(stem, new Set(vocabulary.has(stem) ? [''] : []));
      formsOf.get(stem).add(ending);
    }
  }
  const votes = new Map();
  for (const forms of formsOf.values()) {
    if (forms.size < MIN_STEM_FORMS) continue;
    for (const ending of forms) if (ending) votes.set(ending, (votes.get(ending) ?? 0) + 1);
  }
  const floor = Math.max(MIN_ENDING_VOTES, Math.ceil(vocabulary.size * ENDING_VOTE_SHARE));
  const endings = [...votes]
    .filter(([, count]) => count >= floor)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_ENDINGS)
    .map(([ending]) => ending);
  const learned = new Set(endings);
  const productivity = new Map();
  for (const [stem, forms] of formsOf) {
    let count = 0;
    for (const ending of forms) if (ending === '' || learned.has(ending)) count += 1;
    if (count >= 2) productivity.set(stem, count);
  }
  return { endings, productivity };
}

/**
 * The key function of a learned vocabulary (learnEndings): a word with a digit is its own key; else,
 * of its splits into a learned ending and a stem longer than the ending, the stem seen with the most
 * learned endings (ties: the longer stem) when that is two or more and more than the word itself is
 * seen with; else the word. So the inflected forms of a word the record holds share one key.
 * Memoized. Pure.
 */
export function stemmerOf({
  endings,
  productivity,
}: {
  endings: Array<string>;
  productivity: Map<string, number>;
}): (word: string) => string {
  const known = new Set(endings);
  const memo = new Map();
  return (word) => {
    if (memo.has(word)) return memo.get(word);
    let key = word;
    if (!hasDigit(word)) {
      let best = Math.max(1, productivity.get(word) ?? 0);
      for (const { stem, ending } of splits([...word])) {
        const score = productivity.get(stem) ?? 0;
        if (known.has(ending) && [...stem].length > [...ending].length && score > best) {
          best = score;
          key = stem;
        }
      }
    }
    if (memo.size < 200000) memo.set(word, key);
    return key;
  };
}
