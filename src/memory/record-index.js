// The lexical index of the record (src/memory/record.js): what the automatic memory prefetch
// (src/behavior/prefetch.js, src/behavior/recall-run.js `prefetch`) searches instead of reading the
// record's last days on every turn. No model anywhere: the terms of a query are chosen by how rare
// they are in the server's own history.
//
// - Words: runs of word characters of the folded text (src/memory/recent.js#foldText), URLs left
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
// The cache (recordIndexOf) keeps one index per record object, guild and private owner: built whole
// on first use, then read again from `REFRESH_OVERLAP_MS` before its last check at most every
// `refreshMs` and rebuilt whole every `rebuildMs`, in the background (a turn uses what is there).
// The index decides only which messages to read: the caller reads them back through the record
// itself (whose reads apply the forgetting markers and the caller's scope), so a stale entry can
// rank a line but never show one.

import { foldText } from './recent.js';
import { URL_PATTERN, isWordChar } from './mentions.js';

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
function hasDigit(word) {
  return /\p{N}/u.test(word);
}

/**
 * The words of `text` as the index sees them: URLs left out, folded (foldText), runs of word
 * characters (isWordChar), at most 40 code points each, a run of 15+ digits left out. Pure.
 * @param {unknown} text
 * @returns {string[]}
 */
export function indexWords(text) {
  const out = [];
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
function splits(chars) {
  const out = [];
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
 * @param {Iterable<string>} words
 * @returns {{ endings: string[], productivity: Map<string, number> }}
 */
export function learnEndings(words) {
  const vocabulary = new Set();
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
 * @param {{ endings: string[], productivity: Map<string, number> }} learned
 * @returns {(word: string) => string}
 */
export function stemmerOf({ endings, productivity }) {
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
function chatLine(line) {
  return (
    (line?.kind === 'seen' || line?.kind === 'said') &&
    typeof line.messageId === 'string' &&
    line.messageId &&
    Number.isFinite(Date.parse(line.occurredAt))
  );
}

/** The searchable text of a record line: its text and its links' titles and descriptions. */
function lineText(line) {
  const parts = [typeof line.text === 'string' ? line.text : ''];
  for (const link of Array.isArray(line.links) ? line.links : []) {
    if (typeof link?.title === 'string') parts.push(link.title);
    if (typeof link?.description === 'string') parts.push(link.description);
  }
  return parts.join('\n');
}

/** The id of `key` in `index`, added when missing. */
function termId(index, key) {
  let id = index.terms.get(key);
  if (id === undefined) {
    id = index.postings.length;
    index.terms.set(key, id);
    index.postings.push([]);
  }
  return id;
}

/** Adds one chat line as a document (its keys, its posting entries), the message's older document marked dead. */
function addDocument(index, line, revision) {
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
      index.postings[id].push(at);
    }
  });
  index.docs.push({
    messageId: line.messageId,
    channelId: typeof line.scope?.channel === 'string' ? line.scope.channel : null,
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
function dropDocument(index, messageId) {
  const at = index.byMessage.get(messageId);
  if (at === undefined) return;
  const doc = index.docs[at];
  if (!doc.dead) {
    doc.dead = true;
    index.alive -= 1;
  }
}

/** The revision of a record line (1 when missing). */
function revisionOf(line) {
  return Number.isInteger(line?.revision) && line.revision > 0 ? line.revision : 1;
}

/**
 * Folds record lines into `index` in place: a newer revision of a message replaces its document
 * (the older one marked dead), a `deleted` line marks it dead, an older or equal revision is
 * ignored; words are keyed by the index's learned stemmer (no relearning). Returns the index. Pure
 * apart from the index.
 * @param {object} index  buildRecordIndex's
 * @param {Iterable<object>} lines
 */
export function addRecordLines(index, lines) {
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
 * document `{ messageId, channelId, scope, occurredAt, ts, revision, seq, dead }` (`seq` its words'
 * key ids in order), a posting list (document positions) per key. Pure.
 * @param {Iterable<object>} lines
 * @returns {object}
 */
export function buildRecordIndex(lines) {
  const latest = new Map();
  const deleted = new Set();
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
  const vocabulary = new Set();
  for (const line of ordered) for (const word of indexWords(lineText(line))) vocabulary.add(word);
  const learned = learnEndings(vocabulary);
  const index = {
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
function counts(doc, until, exclude) {
  return !doc.dead && !(doc.ts > until) && !exclude.has(doc.messageId);
}

/** The documents (positions) holding any of `ids`, counted ones only, ascending. */
function docsOf(index, ids, ok) {
  const out = new Set();
  for (const id of ids) for (const at of index.postings[id] ?? []) if (ok(at)) out.add(at);
  return out;
}

/** Whether the key sequence `seq` holds `phrase` (key ids) as consecutive keys. */
function holdsPhrase(seq, phrase) {
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
function phraseDocs(index, phrase, ok) {
  const lists = phrase.map((id) => index.postings[id] ?? []).sort((a, b) => a.length - b.length);
  const out = new Set();
  const others = lists.slice(1).map((list) => new Set(list));
  for (const at of lists[0]) {
    if (!ok(at) || !others.every((set) => set.has(at))) continue;
    if (holdsPhrase(index.docs[at].seq, phrase)) out.add(at);
  }
  return out;
}

/**
 * A member's names as alternates: for every word of a stored member's name or alias (folded,
 * `selfId`'s profile left out), the one-word names and aliases of that member. Pure.
 * @param {object[]} profiles
 * @param {string|null} selfId
 * @returns {Map<string, string[]>}
 */
export function nameAlternates(profiles, selfId = null) {
  const out = new Map();
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    if (!profile || typeof profile !== 'object' || (selfId !== null && String(profile.id) === String(selfId))) continue;
    const names = [
      ...(Array.isArray(profile.names) ? profile.names : []),
      ...(Array.isArray(profile.aliases) ? profile.aliases : []).map((alias) => alias?.name),
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
 * @param {object} index
 * @param {string} text
 * @param {{ until?: number, exclude?: Set<string>, skipWords?: string[], alternates?: Map<string, string[]>, quoted?: string[],
 *   maxTerms?: number, maxTermShare?: number, rareTermDf?: number, maxPhrases?: number, maxPhraseDf?: number, minPhraseShare?: number }} [options]
 */
export function indexQuery(
  index,
  text,
  { until = Infinity, exclude = new Set(), skipWords = [], alternates = new Map(), quoted = [], ...rest } = {}
) {
  const o = { ...INDEX_QUERY_DEFAULTS, ...rest };
  const ok = (at) => counts(index.docs[at], until, exclude);
  const total = Math.max(1, index.alive);
  const weightOf = (df) => Math.log(1 + total / df);
  const skip = new Set(skipWords.flatMap((word) => indexWords(word)));
  const words = indexWords(text);
  const keyOf = (word) => index.terms.get(index.stem(word));
  const terms = [];
  const seenKeys = new Set();
  for (const word of words) {
    if ([...word].length < 2 || skip.has(word)) continue;
    const own = keyOf(word);
    if (own === undefined || seenKeys.has(own)) continue;
    seenKeys.add(own);
    const ids = [own, ...(alternates.get(word) ?? []).map(keyOf).filter((id) => id !== undefined && id !== own)];
    const df = docsOf(index, ids, ok).size;
    if (df < 1 || df > Math.max(1, o.rareTermDf, o.maxTermShare * total)) continue;
    terms.push({ word, ids: [...new Set(ids)], df, weight: weightOf(df) });
  }
  terms.sort((a, b) => b.weight - a.weight);
  const phrases = [];
  const taken = new Set();
  for (const raw of quoted) {
    const ids = indexWords(raw).map(keyOf);
    if (ids.length < 1 || ids.some((id) => id === undefined)) continue;
    const df = phraseDocs(index, ids, ok).size;
    const key = ids.join(' ');
    if (df < 1 || taken.has(key)) continue;
    taken.add(key);
    phrases.push({ text: indexWords(raw).join(' '), ids, df, weight: weightOf(df) * ids.length, quoted: true });
  }
  const dfOf = new Map();
  const termDf = (id) => {
    if (!dfOf.has(id)) dfOf.set(id, docsOf(index, [id], ok).size);
    return dfOf.get(id);
  };
  const grams = [];
  for (const n of [3, 2]) {
    for (let i = 0; i + n <= words.length; i += 1) {
      const part = words.slice(i, i + n);
      if (part.some((word) => skip.has(word) || [...word].length < MIN_PHRASE_WORD_CHARS)) continue;
      const ids = part.map(keyOf);
      if (ids.some((id) => id === undefined)) continue;
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
  const inside = (small, big) =>
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
 * then the newer; at most `limit`. Each `{ messageId, channelId, occurredAt, ts, score, terms,
 * phrases }` (`terms` and `phrases` the counts matched). Pure.
 * @param {object} index
 * @param {{ terms: object[], phrases: object[] }} query
 * @param {{ until?: number, exclude?: Set<string>, allow?: ((doc: object) => boolean)|null, limit?: number, rareTermDf?: number }} [options]
 */
export function searchRecordIndex(
  index,
  query,
  { until = Infinity, exclude = new Set(), allow = null, limit = 20, rareTermDf = INDEX_QUERY_DEFAULTS.rareTermDf } = {}
) {
  const terms = Array.isArray(query?.terms) ? query.terms : [];
  const phrases = Array.isArray(query?.phrases) ? query.phrases : [];
  if (terms.length === 0 && phrases.length === 0) return [];
  const ok = (at) => counts(index.docs[at], until, exclude);
  const candidates = new Set();
  for (const term of terms) for (const at of docsOf(index, term.ids, ok)) candidates.add(at);
  for (const phrase of phrases) for (const at of phraseDocs(index, phrase.ids, ok)) candidates.add(at);

  const hits = [];
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
      channelId: doc.channelId,
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
 * @param {object} index
 * @param {unknown[]} texts
 * @param {{ terms?: object[], phrases?: object[] }|null} query
 * @returns {{ terms: number, phrases: number }}
 */
export function querySupport(index, texts, query) {
  const seqs = (Array.isArray(texts) ? texts : []).map((text) =>
    indexWords(text).map((word) => index.terms.get(index.stem(word)) ?? -1)
  );
  const keys = new Set(seqs.flat());
  const terms = (query?.terms ?? []).filter((term) => term.ids.some((id) => keys.has(id))).length;
  const phrases = (query?.phrases ?? []).filter((phrase) => seqs.some((seq) => holdsPhrase(seq, phrase.ids))).length;
  return { terms, phrases };
}

/** The cached indexes, per record object: `${guildId}:${privateUserId ?? ''}` -> entry. */
const CACHE = new WeakMap();

/** All lines of `iterate(guildId, query)`, collected. */
async function collect(record, guildId, query) {
  const lines = [];
  for await (const line of record.iterate(guildId, query)) lines.push(line);
  return lines;
}

/**
 * The record index of `record` (`iterate(guildId, query)`) for a guild (or a private owner's
 * record, `privateUserId`), cached per record object. The first call builds it whole from every
 * line (the returned promise resolves when it is built; a failed build is forgotten, the next call
 * tries again). Later calls resolve the index as it is at once and, in the background: when the last
 * check is `refreshMs` old, read the lines from REFRESH_OVERLAP_MS before it on and fold them in
 * (addRecordLines); when the build is `rebuildMs` old, build it whole again and swap it in. Never
 * rejects but for the first build.
 * @param {{ iterate: Function }} record
 * @param {string} guildId
 * @param {{ privateUserId?: string|null, now?: () => number, refreshMs?: number, rebuildMs?: number }} [options]
 * @returns {Promise<object>}
 */
export function recordIndexOf(
  record,
  guildId,
  { privateUserId = null, now = Date.now, refreshMs = 30000, rebuildMs = 60 * 60 * 1000 } = {}
) {
  if (!CACHE.has(record)) CACHE.set(record, new Map());
  const entries = CACHE.get(record);
  const key = `${guildId}:${privateUserId ?? ''}`;
  const query = privateUserId ? { privateUserId } : {};
  const entry = entries.get(key);
  if (!entry) {
    const started = now();
    const fresh = { index: null, checkedAt: started, builtAt: started, busy: false };
    fresh.ready = collect(record, guildId, query).then(
      (lines) => {
        fresh.index = buildRecordIndex(lines);
        return fresh.index;
      },
      (err) => {
        entries.delete(key);
        throw err;
      }
    );
    entries.set(key, fresh);
    return fresh.ready;
  }
  if (!entry.index) return entry.ready;
  const at = now();
  if (!entry.busy && at - entry.builtAt >= rebuildMs) {
    entry.busy = true;
    collect(record, guildId, query)
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
    collect(record, guildId, { ...query, from })
      .then((lines) => {
        addRecordLines(entry.index, lines);
        entry.checkedAt = at;
      })
      .catch(() => {})
      .finally(() => {
        entry.busy = false;
      });
  }
  return Promise.resolve(entry.index);
}
