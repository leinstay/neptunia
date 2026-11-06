// The lexical index of the record (src/memory/record.ts): what the automatic memory prefetch
// (src/behavior/prefetch.js, src/behavior/recall-run.js `prefetch`) searches instead of reading the
// record's last days on every turn. No model anywhere: the terms of a query are chosen by how rare
// they are in the server's own history.
//
// - Words: runs of word characters of the folded text (src/memory/recent.ts#foldText), URLs left
//   out, at most 40 characters, a run of 15+ digits (an id) left out.
// - Word endings: learned from the record's own vocabulary (learnEndings), never listed in code: an
//   ending of one to three letters counts when many stems are seen with it and with other endings.
//   A word's key (stemmerOf) is the word without the learned ending that leaves the most
//   productive stem, so the inflected forms of one word share a key in any language whose chat the
//   record holds.
// - The index (buildRecordIndex): the newest revision of every `seen` / `said` message (a deleted
//   one goes, `felt` lines are no chat), each as the sequence of its words' keys, with a posting list
//   per key. addRecordLines folds newer lines in place (a new revision replaces its message).
// - A query (indexQuery): the distinctive terms of a text -- its keys rare in the record (document
//   frequency at most `maxTermShare` of the messages or `rareTermDf`, at least one), a member's other names and
//   aliases as alternates of a name it holds, weighted by inverse document frequency, the
//   `maxTerms` rarest kept -- and its phrases: adjacent two and three words that occur in the
//   record as a phrase, rare as one and bound together (the phrase's messages at least
//   `minPhraseShare` of its rarer word's), plus the quoted phrases the caller passes.
// - A search (searchRecordIndex): the messages holding a phrase of the query, at least two of its
//   terms, or one rare term (at most `rareTermDf` messages); scored by the summed weights, best
//   first, then the newer. The caller checks the weaker ones by their cosine
//   (src/behavior/prefetch.js#lexicalKeep).
//
// The cache (recordIndexOf) keeps one index per record object, place and private owner: built whole
// on first use, then read again from `REFRESH_OVERLAP_MS` before its last check at most every
// `refreshMs` and rebuilt whole every `rebuildMs`, in the background (a turn uses what is there).
// The index decides only which messages to read: the caller reads them back through the record
// itself (whose reads apply the forgetting markers and the caller's scope), so a stale entry can
// rank a line but never show one.

import { foldText } from './recent.ts';
import { URL_PATTERN, isWordChar } from './mentions.ts';
import { isFiniteNumber, isIntegerNumber } from './types.ts';
import type { StoredRecord, Untyped } from './types.ts';
import type { RecordStore } from './record.ts';
import { asRecordLines } from './record.ts';

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
/** A word of a phrase this short (a particle, a preposition) makes no phrase of its own words. */
const MIN_PHRASE_WORD_CHARS = 3;
/** How far before its last check an incremental refresh reads again (late lines, recent edits). */
export const REFRESH_OVERLAP_MS = 24 * 60 * 60 * 1000;

/** The defaults of a query and a search (recall.prefetch carries the tuned values). */
export const INDEX_QUERY_DEFAULTS = Object.freeze({
  maxTerms: 8,
  maxTermShare: 0.002,
  maxPhrases: 3,
  maxPhraseDf: 20,
  minPhraseShare: 0.2,
  rareTermDf: 30,
});

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

/** Whether `line` is a chat line of the record (a `seen` or `said` message with an id, a channel or private scope and a time). */
function chatLine(line: IndexLine): boolean {
  return (
    (line?.kind === 'seen' || line?.kind === 'said') &&
    typeof line.messageId === 'string' &&
    line.messageId !== '' &&
    isFiniteNumber(Date.parse(line.occurredAt))
  );
}

/** The searchable text of a record line: its text and its links' titles and descriptions. */
function lineText(line: IndexLine): string {
  const parts = [typeof line.text === 'string' ? line.text : ''];
  for (const link of Array.isArray(line.links) ? line.links : []) {
    if (typeof link?.title === 'string') parts.push(link.title);
    if (typeof link?.description === 'string') parts.push(link.description);
  }
  return parts.join('\n');
}

/** Whether every key of a word list was found in the index. */
function allDefined(ids: Array<number | undefined>): ids is Array<number> {
  return ids.every((id) => id !== undefined);
}

/** A word of a query: the key ids it stands for, how many documents hold it and its weight. */
export type QueryTerm = { word: string; ids: Array<number>; df: number; weight: number };
/** A phrase of a query: its consecutive key ids, the documents holding it and its weight. */
export type QueryPhrase = { text: string; ids: Array<number>; df: number; weight: number; quoted?: boolean };

/** A message the index offers for a query, with how many terms and phrases of the query it holds. */
export type IndexHit = {
  messageId: string;
  placeId: string | null;
  occurredAt: string;
  ts: number;
  score: number;
  terms: number;
  phrases: number;
};

/** A record line as the index reads it: a chat line of the record (`seen` or `said`) with its text and link cards. */
export type IndexLine = {
  kind?: string;
  messageId: string;
  occurredAt: string;
  revision?: number;
  scope?: Untyped;
  text?: string;
  links?: Array<Untyped>;
};

/** One indexed message: its key sequence and the fields a query filters on. */
type IndexDoc = {
  messageId: string;
  placeId: string | null;
  scope: Untyped;
  occurredAt: string;
  ts: number;
  revision: number;
  seq: Int32Array;
  dead: boolean;
};

/** The in-memory index of a record: key ids per term, a posting list per key and a document per message revision. */
export type RecordIndex = {
  terms: Map<string, number>;
  postings: Array<Array<number>>;
  docs: Array<IndexDoc>;
  byMessage: Map<string, number>;
  deleted: Set<string>;
  alive: number;
  endings: Array<string>;
  stem: (word: string) => string;
};

/** The id of `key` in `index`, added when missing. */
function termId(index: RecordIndex, key: string) {
  let id = index.terms.get(key);
  if (id === undefined) {
    id = index.postings.length;
    index.terms.set(key, id);
    index.postings.push([]);
  }
  return id;
}

/** Adds one chat line as a document (its keys, its posting entries), the message's older document marked dead. */
function addDocument(index: RecordIndex, line: IndexLine, revision: number) {
  const old = index.byMessage.get(line.messageId);
  if (old !== undefined) {
    const doc = index.docs[old];
    if (doc.revision >= revision) return;
    if (!doc.dead) {
      doc.dead = true;
      index.alive -= 1;
    }
  }
  const words = indexWords(lineText(line));
  const seq = new Int32Array(words.length);
  const at = index.docs.length;
  const seen = new Set();
  words.forEach((word, i) => {
    const id = termId(index, index.stem(word));
    seq[i] = id;
    if (!seen.has(id)) {
      seen.add(id);
      const postings = index.postings[id];
      postings.push(at);
    }
  });
  index.docs.push({
    messageId: line.messageId,
    placeId: typeof line.scope?.channel === 'string' ? line.scope.channel : null,
    scope: line.scope ?? null,
    occurredAt: line.occurredAt,
    ts: Date.parse(line.occurredAt),
    revision,
    seq,
    dead: false,
  });
  index.byMessage.set(line.messageId, at);
  index.alive += 1;
}

/** A deleted message's document marked dead. */
function dropDocument(index: RecordIndex, messageId: string) {
  const at = index.byMessage.get(messageId);
  if (at === undefined) return;
  const doc = index.docs[at];
  if (!doc.dead) {
    doc.dead = true;
    index.alive -= 1;
  }
}

/** The revision of a record line (1 when missing). */
function revisionOf(line: IndexLine): number {
  return isIntegerNumber(line?.revision) && line.revision > 0 ? line.revision : 1;
}

/**
 * Folds record lines into `index` in place: a newer revision of a message replaces its document
 * (the older one marked dead), a `deleted` line marks it dead, an older or equal revision is
 * ignored; words are keyed by the index's learned stemmer (no relearning). Returns the index. Pure
 * apart from the index.
 * @param index  buildRecordIndex's
 */
export function addRecordLines(index: RecordIndex, lines: Iterable<IndexLine>): RecordIndex {
  for (const line of lines) {
    if (line?.kind === 'deleted' && typeof line.messageId === 'string') {
      dropDocument(index, line.messageId);
      index.deleted.add(line.messageId);
      continue;
    }
    if (!chatLine(line) || index.deleted.has(line.messageId)) continue;
    addDocument(index, line, revisionOf(line));
  }
  return index;
}

/**
 * The index of record lines (any order): the newest revision of each `seen` / `said` message (a
 * deleted message left out), the endings learned from their words (learnEndings), each message a
 * document `{ messageId, placeId, scope, occurredAt, ts, revision, seq, dead }` (`seq` its words'
 * key ids in order), a posting list (document positions) per key. Pure.
 */
export function buildRecordIndex(lines: Iterable<IndexLine>): RecordIndex {
  const latest = new Map<string, IndexLine>();
  const deleted = new Set<string>();
  for (const line of lines) {
    if (line?.kind === 'deleted' && typeof line.messageId === 'string') {
      deleted.add(line.messageId);
      continue;
    }
    if (!chatLine(line)) continue;
    const known = latest.get(line.messageId);
    if (!known || revisionOf(known) < revisionOf(line)) latest.set(line.messageId, line);
  }
  for (const id of deleted) latest.delete(id);
  const ordered = [...latest.values()].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const vocabulary = new Set<string>();
  for (const line of ordered) for (const word of indexWords(lineText(line))) vocabulary.add(word);
  const learned = learnEndings(vocabulary);
  const index: RecordIndex = {
    terms: new Map(),
    postings: [],
    docs: [],
    byMessage: new Map(),
    deleted,
    alive: 0,
    endings: learned.endings,
    stem: stemmerOf(learned),
  };
  for (const line of ordered) addDocument(index, line, revisionOf(line));
  return index;
}

/** Whether document `doc` counts for a query: alive, not after `until`, not excluded. */
function counts(doc: IndexDoc, until: number, exclude: Set<string>): boolean {
  return !doc.dead && !(doc.ts > until) && !exclude.has(doc.messageId);
}

/** The documents (positions) holding any of `ids`, counted ones only, ascending. */
function docsOf(index: RecordIndex, ids: Array<number>, ok: (at: number) => boolean) {
  const out = new Set<number>();
  for (const id of ids) for (const at of index.postings[id] ?? []) if (ok(at)) out.add(at);
  return out;
}

/** Whether the key sequence `seq` holds `phrase` (key ids) as consecutive keys. */
function holdsPhrase(seq: ArrayLike<number>, phrase: Array<number>): boolean {
  for (let i = 0; i + phrase.length <= seq.length; i += 1) {
    let all = true;
    for (let j = 0; j < phrase.length; j += 1) {
      if (seq[i + j] !== phrase[j]) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/** The documents (positions) holding `phrase` (key ids) as consecutive keys, counted ones only. */
function phraseDocs(index: RecordIndex, phrase: Array<number>, ok: (at: number) => boolean) {
  const lists = phrase.map((id) => index.postings[id] ?? []).sort((a, b) => a.length - b.length);
  const out = new Set<number>();
  const others = lists.slice(1).map((list) => new Set(list));
  for (const at of lists[0]) {
    if (!ok(at) || !others.every((set) => set.has(at))) continue;
    const doc = index.docs[at];
    if (holdsPhrase(doc.seq, phrase)) out.add(at);
  }
  return out;
}

/**
 * A member's names as alternates: for every word of a stored member's name or alias (folded,
 * `selfId`'s profile left out), the one-word names and aliases of that member. Pure.
 */
export function nameAlternates(
  profiles: Array<StoredRecord>,
  selfId: string | null = null
): Map<string, Array<string>> {
  const out = new Map();
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    if (!profile || typeof profile !== 'object' || (selfId !== null && String(profile.id) === String(selfId))) continue;
    const names = [
      ...(Array.isArray(profile.names) ? profile.names : []),
      ...(Array.isArray(profile.aliases) ? profile.aliases : []).map((alias: Untyped) => alias?.name),
    ].filter((name) => typeof name === 'string');
    const single = [
      ...new Set(
        names
          .map((name) => indexWords(name))
          .filter((words) => words.length === 1 && [...words[0]].length >= 3)
          .map((words) => words[0])
      ),
    ];
    if (single.length < 2) continue;
    for (const name of names) {
      for (const word of indexWords(name)) {
        if ([...word].length < 3) continue;
        const list = out.get(word) ?? [];
        for (const alt of single) if (alt !== word && !list.includes(alt)) list.push(alt);
        out.set(word, list);
      }
    }
  }
  return out;
}

/**
 * The distinctive terms and phrases of `text` over `index`, counting only documents alive, not
 * after `until` and not in `exclude` (the turn's own chat). Terms: the text's words (2+ code
 * points; `skipWords`, folded, left out -- the persona's names), each with the keys of its
 * alternates (`alternates`, nameAlternates'); document frequency `df` the documents holding any
 * of its keys; kept when 1 <= df <= max(1, `rareTermDf`, `maxTermShare` * documents) (a rare word
 * is a term however small the record); weight
 * ln(1 + documents / df); the `maxTerms` heaviest, each once by key. Phrases: the text's adjacent
 * two and three words whose keys occur together in the record as a phrase in at most
 * `maxPhraseDf` documents (at least one) and in at least `minPhraseShare` of the documents of the
 * phrase's rarer word; weight ln(1 + documents / df) times its words; the `maxPhrases` heaviest
 * (a phrase inside a kept longer one dropped); `quoted` phrases (the caller's quoted text) first
 * when they occur at all. Returned `{ docs, terms: [{ word, ids, df, weight }], phrases: [{ text,
 * ids, df, weight }] }`. Pure.
 */
export function indexQuery(
  index: RecordIndex,
  text: string,
  {
    until = Infinity,
    exclude = new Set(),
    skipWords = [],
    alternates = new Map(),
    quoted = [],
    ...rest
  }: {
    until?: number;
    exclude?: Set<string>;
    skipWords?: Array<string>;
    alternates?: Map<string, Array<string>>;
    quoted?: Array<string>;
    maxTerms?: number;
    maxTermShare?: number;
    rareTermDf?: number;
    maxPhrases?: number;
    maxPhraseDf?: number;
    minPhraseShare?: number;
  } = {}
): { docs: number; terms: Array<QueryTerm>; phrases: Array<QueryPhrase> } {
  const o = { ...INDEX_QUERY_DEFAULTS, ...rest };
  const ok = (at: number) => counts(index.docs[at], until, exclude);
  const total = Math.max(1, index.alive);
  const weightOf = (df: number) => Math.log(1 + total / df);
  const skip = new Set(skipWords.flatMap((word) => indexWords(word)));
  const words = indexWords(text);
  const keyOf = (word: string) => index.terms.get(index.stem(word));
  const terms: Array<QueryTerm> = [];
  const seenKeys = new Set<number>();
  for (const word of words) {
    if ([...word].length < 2 || skip.has(word)) continue;
    const own = keyOf(word);
    if (own === undefined || seenKeys.has(own)) continue;
    seenKeys.add(own);
    const ids = [
      own,
      ...(alternates.get(word) ?? []).map(keyOf).filter((id): id is number => id !== undefined && id !== own),
    ];
    const df = docsOf(index, ids, ok).size;
    if (df < 1 || df > Math.max(1, o.rareTermDf, o.maxTermShare * total)) continue;
    terms.push({ word, ids: [...new Set(ids)], df, weight: weightOf(df) });
  }
  terms.sort((a, b) => b.weight - a.weight);
  const phrases = [];
  const taken = new Set();
  for (const raw of quoted) {
    const ids = indexWords(raw).map(keyOf);
    if (ids.length < 1 || !allDefined(ids)) continue;
    const df = phraseDocs(index, ids, ok).size;
    const key = ids.join(' ');
    if (df < 1 || taken.has(key)) continue;
    taken.add(key);
    phrases.push({ text: indexWords(raw).join(' '), ids, df, weight: weightOf(df) * ids.length, quoted: true });
  }
  const dfOf = new Map<number, number>();
  const termDf = (id: number): number => {
    const known = dfOf.get(id);
    if (known !== undefined) return known;
    const df = docsOf(index, [id], ok).size;
    dfOf.set(id, df);
    return df;
  };
  const grams: Array<QueryPhrase> = [];
  for (const n of [3, 2]) {
    for (let i = 0; i + n <= words.length; i += 1) {
      const part = words.slice(i, i + n);
      if (part.some((word) => skip.has(word) || [...word].length < MIN_PHRASE_WORD_CHARS)) continue;
      const ids = part.map(keyOf);
      if (!allDefined(ids)) continue;
      const key = ids.join(' ');
      if (taken.has(key)) continue;
      taken.add(key);
      const df = phraseDocs(index, ids, ok).size;
      if (df < 1 || df > o.maxPhraseDf) continue;
      const rarer = Math.min(...ids.map(termDf));
      if (df < o.minPhraseShare * rarer) continue;
      grams.push({ text: part.join(' '), ids, df, weight: weightOf(df) * n });
    }
  }
  grams.sort((a, b) => b.weight - a.weight);
  const inside = (small: QueryPhrase, big: QueryPhrase) =>
    big.ids.length > small.ids.length && ` ${big.ids.join(' ')} `.includes(` ${small.ids.join(' ')} `);
  for (const gram of grams) {
    if (phrases.length >= o.maxPhrases) break;
    if (phrases.some((kept) => inside(gram, kept))) continue;
    phrases.push(gram);
  }
  return { docs: total, terms: terms.slice(0, o.maxTerms), phrases: phrases.slice(0, o.maxPhrases) };
}

/**
 * The candidate messages of `query` (indexQuery's) in `index`: a document counted (alive, not after
 * `until`, not in `exclude`) and allowed (`allow(doc)`: the caller's scope) holding a phrase of the
 * query, at least two of its terms, or one of its terms that is rare (at most `rareTermDf`
 * documents). `score`: the weights of its terms and phrases summed. Best first,
 * then the newer; at most `limit`. Each `{ messageId, placeId, occurredAt, ts, score, terms,
 * phrases }` (`terms` and `phrases` the counts matched). Pure.
 */
export function searchRecordIndex(
  index: RecordIndex,
  query: { terms: Array<QueryTerm>; phrases: Array<QueryPhrase> },
  {
    until = Infinity,
    exclude = new Set(),
    allow = null,
    limit = 20,
    rareTermDf = INDEX_QUERY_DEFAULTS.rareTermDf,
  }: {
    until?: number;
    exclude?: Set<string>;
    allow?: ((doc: Untyped) => boolean) | null;
    limit?: number;
    rareTermDf?: number;
  } = {}
): Array<IndexHit> {
  const terms = Array.isArray(query?.terms) ? query.terms : [];
  const phrases = Array.isArray(query?.phrases) ? query.phrases : [];
  if (terms.length === 0 && phrases.length === 0) return [];
  const ok = (at: number) => counts(index.docs[at], until, exclude);
  const candidates = new Set<number>();
  for (const term of terms) for (const at of docsOf(index, term.ids, ok)) candidates.add(at);
  for (const phrase of phrases) for (const at of phraseDocs(index, phrase.ids, ok)) candidates.add(at);

  const hits: Array<IndexHit> = [];
  for (const at of candidates) {
    const doc = index.docs[at];
    if (typeof allow === 'function' && !allow(doc)) continue;
    const keys = new Set(doc.seq);
    let score = 0;
    let matchedTerms = 0;
    let matchedPhrases = 0;
    let rare = false;
    for (const term of terms) {
      if (term.ids.some((id) => keys.has(id))) {
        matchedTerms += 1;
        score += term.weight;
        if (term.df <= rareTermDf) rare = true;
      }
    }
    for (const phrase of phrases) {
      if (phrase.ids.every((id) => keys.has(id)) && holdsPhrase(doc.seq, phrase.ids)) {
        matchedPhrases += 1;
        score += phrase.weight;
      }
    }
    if (!(matchedPhrases > 0 || matchedTerms >= 2 || rare)) continue;
    hits.push({
      messageId: doc.messageId,
      placeId: doc.placeId,
      occurredAt: doc.occurredAt,
      ts: doc.ts,
      score,
      terms: matchedTerms,
      phrases: matchedPhrases,
    });
  }
  hits.sort((a, b) => b.score - a.score || b.ts - a.ts);
  return hits.slice(0, Math.max(0, limit));
}

/**
 * How much of `query` (indexQuery's) `texts` hold: the distinct terms (any of a term's keys) and
 * phrases (consecutive keys) found in any of them, words keyed by the index's stemmer. What a
 * meaning hit needs besides its cosine: a word of the question (src/behavior/recall-run.js
 * `prefetch`). Pure.
 */
export function querySupport(
  index: RecordIndex,
  texts: Array<unknown>,
  query: { terms?: Array<QueryTerm>; phrases?: Array<QueryPhrase> } | null
): { terms: number; phrases: number } {
  const seqs = (Array.isArray(texts) ? texts : []).map((text) =>
    indexWords(text).map((word) => index.terms.get(index.stem(word)) ?? -1)
  );
  const keys = new Set(seqs.flat());
  const terms = (query?.terms ?? []).filter((term) => term.ids.some((id) => keys.has(id))).length;
  const phrases = (query?.phrases ?? []).filter((phrase) => seqs.some((seq) => holdsPhrase(seq, phrase.ids))).length;
  return { terms, phrases };
}

/** The cached indexes, per record object: `${placeId}` -> entry. */
type CacheEntry = {
  index: RecordIndex | null;
  ready?: Promise<RecordIndex>;
  checkedAt: number;
  builtAt: number;
  busy: boolean;
};
const CACHE = new WeakMap<object, Map<string, CacheEntry>>();

/** All lines of `iterate(placeId, query)`, collected. */
async function collect(record: Pick<RecordStore, 'iterate'>, placeId: string, query: Untyped) {
  const lines: Array<IndexLine> = [];
  for await (const line of asRecordLines(record.iterate(placeId, query))) lines.push(line);
  return lines;
}

/**
 * The record index of `record` (`iterate(placeId, query)`) for a place (or a private owner's
 * record,), cached per record object. The first call builds it whole from every
 * line (the returned promise resolves when it is built; a failed build is forgotten, the next call
 * tries again). Later calls resolve the index as it is at once and, in the background: when the last
 * check is `refreshMs` old, read the lines from REFRESH_OVERLAP_MS before it on and fold them in
 * (addRecordLines); when the build is `rebuildMs` old, build it whole again and swap it in. Never
 * rejects but for the first build.
 */
export function recordIndexOf(
  record: Pick<RecordStore, 'iterate'>,
  placeId: string,
  {
    now = Date.now,
    refreshMs = 30000,
    rebuildMs = 60 * 60 * 1000,
  }: { now?: () => number; refreshMs?: number; rebuildMs?: number } = {}
): Promise<RecordIndex> {
  const entries = CACHE.get(record) ?? new Map<string, CacheEntry>();
  CACHE.set(record, entries);
  const key = String(placeId);
  const query = {};
  const entry = entries.get(key);
  if (!entry) {
    const started = now();
    const fresh: CacheEntry = { index: null, checkedAt: started, builtAt: started, busy: false };
    const ready = collect(record, placeId, query).then(
      (lines) => {
        const built = buildRecordIndex(lines);
        fresh.index = built;
        return built;
      },
      (err) => {
        entries.delete(key);
        throw err;
      }
    );
    fresh.ready = ready;
    entries.set(key, fresh);
    return ready;
  }
  // `ready` is set together with the entry, so an entry without an index is a first build still running.
  if (!entry.index) return entry.ready as Promise<RecordIndex>;
  const at = now();
  if (!entry.busy && at - entry.builtAt >= rebuildMs) {
    entry.busy = true;
    collect(record, placeId, query)
      .then((lines) => {
        entry.index = buildRecordIndex(lines);
        entry.builtAt = at;
        entry.checkedAt = at;
      })
      .catch(() => {})
      .finally(() => {
        entry.busy = false;
      });
  } else if (!entry.busy && at - entry.checkedAt >= refreshMs) {
    entry.busy = true;
    const from = new Date(entry.checkedAt - REFRESH_OVERLAP_MS).toISOString();
    collect(record, placeId, { ...query, from })
      .then((lines) => {
        if (entry.index) addRecordLines(entry.index, lines);
        entry.checkedAt = at;
      })
      .catch(() => {})
      .finally(() => {
        entry.busy = false;
      });
  }
  return Promise.resolve(entry.index);
}
