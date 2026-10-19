// The pure core of the automatic memory prefetch (features.coreTools with features.memoryPrefetch):
// before a turn of the persona's tool loop that a person's new message opened, the server's own
// history and her stored memory are searched once with that message, so a reference to an old
// shared story reaches her without anyone choosing a query for her. No model writes the query and
// none reads the results before she does: the lanes are built from the messages as they were
// written (the trigger verbatim; with the line it replies to, speaker by speaker; for a short or
// deictic trigger also the few lines just before it), each lane goes through the record index (its
// rarest words and phrases, src/memory/record-index.js), the stored memory and the meaning search
// (src/behavior/recall-run.js `prefetch`), and this module decides which hits are relevant enough
// (lexicalKeep: a rare phrase, two distinctive terms, or one confirmed by its cosine), fuses the
// lanes by reciprocal rank (stored memory at half weight) and keeps a few deduplicated excerpts
// under a token cap, each cut around its best hit (focusHits). Zero excerpts is a valid answer.
// Trivial triggers (empty, a command, a bare greeting or acknowledgement -- the matching data
// `recall.prefetch.trivial`) are not searched at all. Wording lives in labels
// (`labels.prefetch.*`, rendered by src/behavior/prompt.js); this module holds the decisions only.
// Pure: no I/O, no clock.

import { estimateTokens } from '../llm/tokens.js';
import { oneLine } from '../memory/clamp.js';
import { fromTokens, isWordChar } from '../memory/mentions.js';
import { foldText } from '../memory/recent.js';
import { fallbackLookupPlan, fuseRanks, mergeWindows, recallSettings } from './recall.js';

/** The lane kinds, in the order the query basis names them. */
export const PREFETCH_LANES = Object.freeze(['message', 'reply', 'recent']);

/** The trigger kinds a prefetch never runs for: an errand's result and the turn after a failed drawing. */
const NOT_EXTERNAL = new Set(['task', 'drawFailed']);

/** Discord's inline tokens (`<@id>`, `<@!id>`, `<@&id>`, `<#id>`, `<:name:id>`, `<a:name:id>`, `<t:...>`). */
const INLINE_TOKEN_RE = /<(?:@[!&]?|#|a?:[^:>\s]+:|t:)[^>\s]*>/g;
/** The opening and closing quote marks a quoted phrase sits between. */
const QUOTE_PAIRS = Object.freeze([
  ['"', '"'],
  ['“', '”'],
  ['«', '»'],
  ['„', '“'],
]);
/** A quoted phrase this short or long (in characters) is no phrase form. */
const PHRASE_MIN_CHARS = 3;
const PHRASE_MAX_CHARS = 80;
/** The most phrases one lane carries. */
const MAX_PHRASES = 3;
/**
 * The weight of a lane's stored-memory list in the fusion (rankPrefetch): half a history list's, so the
 * chat's own stretches come first and the stored summaries take the room they leave.
 */
const MEMORY_WEIGHT = 0.5;

/**
 * Whether the automatic memory prefetch runs at all under `config` (read now): features.coreTools
 * exactly true (the switch off leaves every turn as before), features.memoryPrefetch not false
 * (a missing key counts as on) and features.recall on (recallSettings). Pure.
 * @param {object} config
 * @returns {boolean}
 */
export function prefetchOn(config) {
  return config?.features?.coreTools === true && config?.features?.memoryPrefetch !== false && recallSettings(config) !== null;
}

/** `text` without Discord's inline tokens, on one line. */
function plainText(text) {
  return oneLine(String(text ?? '').replace(INLINE_TOKEN_RE, ' '));
}

/** The words of folded `text`: runs of word characters (isWordChar). */
function wordsOf(text) {
  const words = [];
  let current = '';
  for (const ch of String(text ?? '')) {
    if (isWordChar(ch)) current += ch;
    else if (current) {
      words.push(current);
      current = '';
    }
  }
  if (current) words.push(current);
  return words;
}

/**
 * Whether a trigger's text gives nothing to search (Hermes' is_trivial_prompt, here over a chat
 * line): empty once Discord's inline tokens are left out, a command (`/` or `!` first), nothing
 * but punctuation, emoji or the persona's own names (`selfNames`, folded and dropped as whole
 * words), or -- what is left, folded, words joined by one space -- one of `trivial` (folded
 * phrases: bare greetings and acknowledgements). A short line that is not on the list (a
 * catchphrase) is not trivial. Pure.
 * @param {unknown} text
 * @param {{ trivial?: string[], selfNames?: string[] }} [options]
 * @returns {boolean}
 */
export function isTrivialTrigger(text, { trivial = [], selfNames = [] } = {}) {
  const plain = plainText(text);
  if (!plain) return true;
  if (/^[/!]/.test(plain)) return true;
  const names = new Set(selfNames.flatMap((name) => wordsOf(foldText(name))));
  const words = wordsOf(foldText(plain)).filter((word) => !names.has(word));
  if (words.length === 0) return true;
  const core = words.join(' ');
  return new Set(trivial.map((phrase) => wordsOf(foldText(phrase)).join(' '))).has(core);
}

/**
 * The quoted phrases of `text` (between a pair of QUOTE_PAIRS, or two single quotes around at
 * least two words), 3 to 80 characters each, lowercased, on one line, each once, at most three.
 * Pure.
 * @param {string} text
 * @returns {string[]}
 */
export function quotedPhrases(text) {
  const source = String(text ?? '');
  const found = [];
  const add = (raw) => {
    const phrase = oneLine(raw).toLowerCase();
    const chars = [...phrase].length;
    if (chars < PHRASE_MIN_CHARS || chars > PHRASE_MAX_CHARS || wordsOf(phrase).length === 0 || found.includes(phrase)) return;
    found.push(phrase);
  };
  for (const [open, close] of QUOTE_PAIRS) {
    let at = source.indexOf(open);
    while (at !== -1 && found.length < MAX_PHRASES) {
      const end = source.indexOf(close, at + 1);
      if (end === -1) break;
      add(source.slice(at + 1, end));
      at = source.indexOf(open, end + 1);
    }
  }
  for (const match of source.matchAll(/(?:^|\s)'([^']+)'(?=$|[\s.,!?;:])/g)) {
    if (found.length >= MAX_PHRASES) break;
    if (wordsOf(match[1]).length >= 2) add(match[1]);
  }
  return found.slice(0, MAX_PHRASES);
}

/** A chat message's name as a lane shows its speaker: the persona's own lines under `selfName`. */
function speakerOf(message, selfName) {
  return oneLine(message?.self ? selfName : (message?.authorName ?? '')) || '-';
}

/** A message's text with its `<@id>` tokens as names (nameOf), on one line. */
function textOf(message, nameOf) {
  return oneLine(fromTokens(typeof message?.content === 'string' ? message.content : '', nameOf, 'chat'));
}

/**
 * Whether a prefetch runs for this turn and over which lanes. None (`skip` with a code): no
 * trigger, or one of the persona's own (`no-trigger`); a turn no person's new message opened -- an
 * errand's result, the turn after a failed drawing, a diary post (`not-external`); a trivial
 * trigger (isTrivialTrigger with `settings.trivial` and the persona's names: `trivial`). Else the
 * lanes, each `{ kind, text, words }` -- `text` what is embedded (speakers named, `<@id>` tokens as
 * names), `words` what the lexical forms come from (the messages' own texts, no speaker names):
 * - `message`: the trigger as it was written;
 * - `reply`: when it replies to a line of `history` (`replyToId`): that line, then the trigger,
 *   each as `Name: text` on its own line;
 * - `recent`: only for a short trigger (at most `settings.shortWords` words) or one with a
 *   deictic word (`settings.deictic`, folded): the last `settings.contextLines` lines before it in
 *   `history` (not the replied-to one, not another bot's, not empty), newest first until
 *   `settings.contextTokens` would be passed, then in their order, and the trigger last, each as
 *   `Name: text`. None with `contextLines` 0 or no such line.
 * `candidate` is the trigger with this turn's text (a part of a split message), else the trigger.
 * Pure.
 * @param {{ trigger: object|null, candidate?: object|null, triggerKind?: string|null, mode?: string|null, history?: object[],
 *   settings: object, selfId?: string|null, selfName?: string, selfNames?: string[], nameOf?: ((id: string) => string|null)|null }} input
 * @returns {{ lanes: { kind: string, text: string, words: string }[], skip: string|null }}
 */
export function prefetchLanes({ trigger, candidate = trigger, triggerKind = null, mode = null, history = [], settings, selfId = null, selfName = '', selfNames = [], nameOf = null }) {
  const none = (skip) => ({ lanes: [], skip });
  if (!trigger || trigger.self === true || (selfId && String(trigger.authorId) === String(selfId))) return none('no-trigger');
  if (NOT_EXTERNAL.has(triggerKind) || mode === 'diary') return none('not-external');
  const asked = candidate ?? trigger;
  if (isTrivialTrigger(asked.content, { trivial: settings.trivial, selfNames: [selfName, ...selfNames] })) return none('trivial');
  const lines = Array.isArray(history) ? history : [];
  const own = textOf(asked, nameOf);
  const lanes = [{ kind: 'message', text: own, words: plainText(asked.content) }];
  const line = (message) => `${speakerOf(message, selfName)}: ${textOf(message, nameOf)}`;
  const parentId = typeof asked.replyToId === 'string' && asked.replyToId ? asked.replyToId : null;
  const parent = parentId ? lines.find((message) => message?.id === parentId && message.id !== asked.id) : null;
  if (parent && textOf(parent, nameOf)) {
    lanes.push({ kind: 'reply', text: `${line(parent)}\n${line(asked)}`, words: `${plainText(parent.content)}\n${plainText(asked.content)}` });
  }
  const folded = wordsOf(foldText(plainText(asked.content)));
  const deictic = new Set(settings.deictic ?? []);
  const short = folded.length <= settings.shortWords || folded.some((word) => deictic.has(word));
  if (short && settings.contextLines > 0) {
    const at = lines.findIndex((message) => message?.id === asked.id);
    const before = (at === -1 ? lines : lines.slice(0, at)).filter((message) => message && message.id !== asked.id && message.id !== parent?.id && !(message.bot && !message.self) && textOf(message, nameOf));
    const picked = [];
    let tokens = estimateTokens(line(asked));
    for (let i = before.length - 1; i >= 0 && picked.length < settings.contextLines; i -= 1) {
      const cost = estimateTokens(line(before[i]));
      if (tokens + cost > settings.contextTokens) break;
      tokens += cost;
      picked.unshift(before[i]);
    }
    if (picked.length > 0) {
      lanes.push({
        kind: 'recent',
        text: [...picked.map(line), line(asked)].join('\n'),
        words: [...picked.map((message) => plainText(message.content)), plainText(asked.content)].join('\n'),
      });
    }
  }
  return { lanes, skip: null };
}

/**
 * The prefetch lane of an inner turn (src/behavior/inner.js: no message opened it): the purposes
 * of the intentions its wakes concern, one per line, as one `wake` lane. None (`skip`
 * `no-trigger`) when no intention is concerned (a review alone). Pure.
 * @param {string[]} purposes
 * @returns {{ lanes: { kind: string, text: string, words: string }[], skip: string|null }}
 */
export function wakeLanes(purposes) {
  const texts = (Array.isArray(purposes) ? purposes : []).map((purpose) => oneLine(String(purpose ?? ''))).filter(Boolean);
  if (texts.length === 0) return { lanes: [], skip: 'no-trigger' };
  const text = texts.join('\n');
  return { lanes: [{ kind: 'wake', text, words: text }], skip: null };
}

/**
 * The stored-memory search of one lane when the record index gives no terms (indexedPlan replaces
 * its forms when it does): fallbackLookupPlan over its `words` (the stored members' names and
 * aliases it holds as `who`, its words of 5+ letters as forms, the persona's name left out, at
 * most `maxForms` each), plus its `phrases` -- the quoted phrases of the words (quotedPhrases)
 * and, for a trigger of two to `shortWords` words, the whole trigger -- searched as forms first
 * (recall's matching: folded, word endings allowed; a phrase matches consecutive words). `need`:
 * how many of the word forms an item must match to count (`minFormsMatched`, at most their
 * number; a phrase match always counts). Null when there is nothing to search. Pure.
 * @param {{ kind: string, words: string }} lane
 * @param {{ profiles?: object[], selfId?: string|null, selfName?: string, maxForms?: number, shortWords?: number, minFormsMatched?: number, trigger?: string }} options
 * @returns {{ forms: string[], who: string[], phrases: string[], need: number, from: null, to: null }|null}
 */
export function lanePlan(lane, { profiles = [], selfId = null, selfName = '', maxForms = 8, shortWords = 4, minFormsMatched = 2, trigger = '' } = {}) {
  const words = String(lane?.words ?? '');
  const plan = fallbackLookupPlan({ text: words, profiles, selfId, selfName, maxForms });
  const phrases = quotedPhrases(words);
  const whole = plainText(trigger).toLowerCase();
  const count = wordsOf(foldText(whole)).length;
  if (lane?.kind === 'message' && count >= 2 && count <= shortWords && [...whole].length <= PHRASE_MAX_CHARS && !phrases.includes(whole)) phrases.unshift(whole);
  const forms = (plan?.forms ?? []).filter((form) => !phrases.includes(form));
  const who = plan?.who ?? [];
  if (forms.length === 0 && who.length === 0 && phrases.length === 0) return null;
  const need = Math.min(Math.max(0, minFormsMatched), forms.length);
  return { forms, who, phrases, need, from: null, to: null };
}


/**
 * The plan a lane's stored-memory search uses once the record index chose its terms (`queries`:
 * src/memory/record-index.js#indexQuery's, one per index searched): the distinctive terms' words as
 * forms (the rarest first, each once, at most `maxForms`), the lane plan's own phrases (quoted) and
 * the index's phrases, the lane plan's names (`who`); `need` as lanePlan's (`minFormsMatched`, at
 * most the forms' number). The lane plan unchanged when the index gave no term and no phrase; null
 * when there is nothing to search. Pure.
 * @param {{ forms: string[], who: string[], phrases: string[] }|null} plan  lanePlan's
 * @param {{ terms: { word: string, weight: number }[], phrases: { text: string }[] }[]} queries
 * @param {{ maxForms?: number, minFormsMatched?: number }} [options]
 */
export function indexedPlan(plan, queries, { maxForms = 8, minFormsMatched = 2 } = {}) {
  const terms = (Array.isArray(queries) ? queries : []).flatMap((query) => query?.terms ?? []).sort((a, b) => b.weight - a.weight);
  const forms = [...new Set(terms.map((term) => term.word))].slice(0, Math.max(0, maxForms));
  const phrases = [...new Set([...(plan?.phrases ?? []), ...(Array.isArray(queries) ? queries : []).flatMap((query) => (query?.phrases ?? []).map((phrase) => phrase.text))])];
  if (forms.length === 0 && phrases.length === (plan?.phrases ?? []).length) return plan ?? null;
  const who = plan?.who ?? [];
  if (forms.length === 0 && who.length === 0 && phrases.length === 0) return null;
  return { forms, who, phrases, need: Math.min(Math.max(0, minFormsMatched), forms.length), from: null, to: null };
}

/**
 * The relevant record hits of one lane from every index searched (`lists`, each
 * src/memory/record-index.js#searchRecordIndex's, best first): merged by score (then the newer),
 * each message once, at most `limit`, as the rows matchRecord reads around (`{ id, channelId,
 * occurredAt, sourceIds }`). Pure.
 * @param {{ messageId: string, channelId: string|null, occurredAt: string, ts: number, score: number }[][]} lists
 * @param {number} limit
 */
export function indexRows(lists, limit) {
  const seen = new Set();
  const out = [];
  const all = (Array.isArray(lists) ? lists : []).flat().sort((a, b) => b.score - a.score || b.ts - a.ts);
  for (const hit of all) {
    if (out.length >= limit) break;
    if (!hit?.messageId || !hit.channelId || seen.has(hit.messageId)) continue;
    seen.add(hit.messageId);
    out.push({ id: hit.messageId, channelId: hit.channelId, occurredAt: hit.occurredAt, sourceIds: [] });
  }
  return out;
}

/**
 * Whether a word hit of the record index (src/memory/record-index.js#searchRecordIndex's: `terms`
 * and `phrases` matched) is relevant. Without the meaning search (`cosines` null): a phrase or at
 * least two terms. With it (`cosines`: the hits' cosines to the lane's text, a message without a
 * row in the vector index absent): a phrase always; two terms or more when the cosine is at least
 * `minMeaningScore` (or there is none); one term only when the cosine is at least
 * `singleTermScore`. Pure.
 * @param {{ messageId: string, terms: number, phrases: number }} hit
 * @param {Map<string, number>|null} cosines
 * @param {{ minMeaningScore: number, singleTermScore: number }} settings
 * @returns {boolean}
 */
export function lexicalKeep(hit, cosines, { minMeaningScore, singleTermScore }) {
  if ((hit?.phrases ?? 0) > 0) return true;
  const terms = hit?.terms ?? 0;
  if (!(cosines instanceof Map)) return terms >= 2;
  const cosine = cosines.get(hit.messageId);
  if (terms >= 2) return cosine === undefined || cosine >= minMeaningScore;
  return terms === 1 && cosine !== undefined && cosine >= singleTermScore;
}

/** A stored-memory item's key: its itemId, else its kind and text. */
function itemKey(item) {
  return typeof item?.itemId === 'string' && item.itemId ? `m:${item.itemId}` : `m:${item?.kind ?? ''}:${item?.text ?? ''}`;
}

/**
 * The excerpts a prefetch offers, best first, from what each lane's searches found (`lanes`, in
 * lane order, each `{ windows, lexical, meaning, memory }`): `windows` the record windows its
 * searches built (`{ channelId, channelName, messages, hitIds }`), `lexical` its relevant word hits
 * best first (message ids), `meaning` its meaning hits at or above the score floor, best first
 * (message ids), `memory` its relevant stored-memory items, best first. The ranked lists of every
 * lane and backend are fused by reciprocal rank (fuseRanks); the windows of all lanes are merged
 * where they share a line (mergeWindows: one excerpt per stretch of chat), each window marked
 * only with its relevant hits and ranked by its best one; a window with none is dropped; stored
 * items deduplicated by itemId (else kind and text) and ranked the same way. Returned
 * `{ kind: 'history', window, hitIds, rank }` and `{ kind: 'memory', item, rank }`, best first
 * (`rank` the 1-based fused rank). Pure.
 * @param {{ windows?: object[], lexical?: string[], meaning?: string[], memory?: object[] }[]} lanes
 * @returns {object[]}
 */
export function rankPrefetch(lanes) {
  const list = Array.isArray(lanes) ? lanes : [];
  const relevant = new Set();
  const items = new Map();
  const lists = [];
  for (const lane of list) {
    const lexical = Array.isArray(lane?.lexical) ? lane.lexical : [];
    const meaning = Array.isArray(lane?.meaning) ? lane.meaning : [];
    for (const id of [...lexical, ...meaning]) relevant.add(id);
    const memoryKeys = [];
    for (const item of Array.isArray(lane?.memory) ? lane.memory : []) {
      const key = itemKey(item);
      if (!items.has(key)) items.set(key, item);
      memoryKeys.push(key);
    }
    lists.push(lexical, meaning, memoryKeys);
  }
  const fused = fuseRanks(lists, { weights: lists.map((_, at) => (at % 3 === 2 ? MEMORY_WEIGHT : 1)) });
  const rankOf = new Map(fused.map((entry, i) => [entry.id, i + 1]));
  const windows = mergeWindows(list.flatMap((lane) => (Array.isArray(lane?.windows) ? lane.windows : [])));
  const units = [];
  for (const window of windows) {
    const hits = window.messages.map((m) => m.id).filter((id) => relevant.has(id) && rankOf.has(id));
    if (hits.length === 0) continue;
    const rank = Math.min(...hits.map((id) => rankOf.get(id)));
    units.push({ kind: 'history', window: { ...window, hitIds: new Set(hits) }, hitIds: hits.sort((a, b) => rankOf.get(a) - rankOf.get(b)), rank });
  }
  for (const [key, item] of items) if (rankOf.has(key)) units.push({ kind: 'memory', item, rank: rankOf.get(key) });
  return units.sort((a, b) => a.rank - b.rank);
}

/**
 * The hits an excerpt marks (and is cut around): of `ranked` (hit ids, best first) the best one in
 * `order` (the window's message ids in their order), then each next one whose line keeps every
 * marked line within `maxLines` lines of each other; in rank order. Pure.
 * @param {string[]} order
 * @param {string[]} ranked
 * @param {number} maxLines
 * @returns {string[]}
 */
export function focusHits(order, ranked, maxLines) {
  const at = new Map((Array.isArray(order) ? order : []).map((id, i) => [id, i]));
  const kept = [];
  let low = Infinity;
  let high = -Infinity;
  for (const id of Array.isArray(ranked) ? ranked : []) {
    if (!at.has(id)) continue;
    const i = at.get(id);
    if (kept.length > 0 && Math.max(high, i) - Math.min(low, i) > maxLines) continue;
    kept.push(id);
    low = Math.min(low, i);
    high = Math.max(high, i);
  }
  return kept;
}

/**
 * The excerpts kept from rendered candidates (`rendered`, best first, each with its `text`): at
 * most `maxExcerpts`, their texts' estimated tokens summed at most `maxTokens`; one that does not
 * fit is skipped and the next tried. Pure.
 * @template {{ text: string }} T
 * @param {T[]} rendered
 * @param {{ maxExcerpts: number, maxTokens: number }} settings
 * @returns {T[]}
 */
export function fitExcerpts(rendered, { maxExcerpts, maxTokens }) {
  const kept = [];
  let used = 0;
  for (const entry of Array.isArray(rendered) ? rendered : []) {
    if (kept.length >= maxExcerpts) break;
    const cost = estimateTokens(entry?.text ?? '');
    if (!entry?.text || used + cost > maxTokens) continue;
    used += cost;
    kept.push(entry);
  }
  return kept;
}
