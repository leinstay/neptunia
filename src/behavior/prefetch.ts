// The pure core of the automatic memory prefetch:
// before a turn of the persona's tool loop that a person's new message opened, the server's own
// history and her stored memory are searched once with that message, so a reference to an old
// shared story reaches her without anyone choosing a query for her. No model writes the query and
// none reads the results before she does: the lanes are built from the messages as they were
// written (the trigger verbatim; with the line it replies to, speaker by speaker; for a short or
// deictic trigger also the few lines just before it), each lane goes through the record index (its
// rarest words and phrases, src/memory/record-index.js), the stored memory and the meaning search
// (src/behavior/recall-run.ts `prefetch`), and this module decides which hits are relevant enough
// (lexicalKeep: a rare phrase, two distinctive terms, or one confirmed by its cosine), fuses the
// lanes by reciprocal rank (stored memory at half weight) and keeps a few deduplicated excerpts
// under a token cap, each cut around its best hit (focusHits). Zero excerpts is a valid answer.
// Trivial triggers (empty, a command, a bare greeting or acknowledgement -- the matching data
// `recall.prefetch.trivial`) are not searched at all. Wording lives in labels
// (`labels.prefetch.*`, rendered by src/behavior/prompt.ts); this module holds the decisions only.
// Pure: no I/O, no clock.

import { estimateTokens } from '../llm/tokens.ts';
import { oneLine } from '../memory/clamp.ts';
import { fromTokens, isWordChar } from '../memory/mentions.ts';
import { foldText } from '../memory/recent.ts';
import { fallbackLookupPlan, fuseRanks, mergeWindows, recallSettings } from './recall.ts';
import type { prefetchSettingsOf } from './recall.ts';
import type { MergeWindowsInput, MergeWindowsResult } from './recall-types.ts';
/** The fields of a chat line the prefetch lanes read; the caller's lines hold more. */
export type PrefetchLine = {
  id?: string;
  self?: boolean;
  bot?: boolean;
  authorId?: string | null;
  authorName?: string;
  content?: string | null;
  replyToId?: string | null;
};
import type { Untyped } from '../tools/types.ts';

/** The trigger kinds a prefetch never runs for: an errand's result. */
const NOT_EXTERNAL = new Set<string | null>(['errand']);

/** The inline tokens of the core's text grammar (`<@id>`, `<@!id>`, `<@&id>`, `<#id>`, `<:name:id>`, `<a:name:id>`, `<t:...>`). */
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
 * Whether the automatic memory prefetch runs at all under `config` (read now): whenever recall has
 * settings (recallSettings). Pure.
 */
export function prefetchOn(config: Record<string, Untyped>): boolean {
  return recallSettings(config) !== null;
}

/** `text` without its inline tokens, on one line. */
function plainText(text: string | null | undefined) {
  return oneLine(String(text ?? '').replace(INLINE_TOKEN_RE, ' '));
}

/** The words of folded `text`: runs of word characters (isWordChar). */
function wordsOf(text: string) {
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
 * line): empty once the inline tokens are left out, a command (`/` or `!` first), nothing
 * but punctuation, emoji or the persona's own names (`selfNames`, folded and dropped as whole
 * words), or -- what is left, folded, words joined by one space -- one of `trivial` (folded
 * phrases: bare greetings and acknowledgements). A short line that is not on the list (a
 * catchphrase) is not trivial. Pure.
 */
export function isTrivialTrigger(
  text: string | null | undefined,
  { trivial = [], selfNames = [] }: { trivial?: Array<string>; selfNames?: Array<string> } = {}
): boolean {
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
 */
export function quotedPhrases(text: string): Array<string> {
  const source = String(text ?? '');
  const found: Array<Untyped> = [];
  const add = (raw: Untyped) => {
    const phrase = oneLine(raw).toLowerCase();
    const chars = [...phrase].length;
    if (chars < PHRASE_MIN_CHARS || chars > PHRASE_MAX_CHARS || wordsOf(phrase).length === 0 || found.includes(phrase))
      return;
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
function speakerOf(message: PrefetchLine | null | undefined, selfName: string) {
  return oneLine(message?.self ? selfName : (message?.authorName ?? '')) || '-';
}

/** A message's text with its `<@id>` tokens as names (nameOf), on one line. */
function textOf(message: PrefetchLine | null | undefined, nameOf: ((id: string) => string | null) | null) {
  return oneLine(fromTokens(typeof message?.content === 'string' ? message.content : '', nameOf, 'chat'));
}

/**
 * Whether a prefetch runs for this turn and over which lanes. None (`skip` with a code): no
 * trigger, or one of the persona's own (`no-trigger`); a turn no person's new message opened -- an
 * errand's result, the turn after a failed drawing, a selfreflection post (`not-external`); a trivial
 * trigger (isTrivialTrigger with `settings.trivial` and the persona's names: `trivial`). Else the
 * lanes, each `{ kind, text, words }` -- `text` what is embedded (speakers named, `<@id>` tokens as
 * names), `words` what the lexical forms come from (the messages' own texts, no speaker names):
 * - `message`: the trigger as it was written;
 * - `reply`: when it replies to a line of `history` (`replyToId`): that line, then the trigger,
 *   each as `Name: text` on its own line;
 * - `recent`: only for a short trigger (at most `settings.shortWords` words) or one with a
 *   deictic word (`settings.deictic`, folded): the last `settings.contextLines` lines before it in
 *   `history` (not the replied-to one, not empty), newest first until
 *   `settings.contextTokens` would be passed, then in their order, and the trigger last, each as
 *   `Name: text`. None with `contextLines` 0 or no such line.
 * `candidate` is the trigger with this turn's text (a part of a split message), else the trigger.
 * Pure.
 */
export function prefetchLanes({
  trigger,
  candidate = trigger,
  triggerKind = null,
  mode = null,
  history = [],
  settings,
  selfId = null,
  selfName = '',
  selfNames = [],
  nameOf = null,
}: {
  trigger: PrefetchLine | null;
  candidate?: PrefetchLine | null;
  triggerKind?: string | null;
  mode?: string | null;
  history?: Array<PrefetchLine>;
  settings: ReturnType<typeof prefetchSettingsOf>;
  selfId?: string | null;
  selfName?: string;
  selfNames?: Array<string>;
  nameOf?: ((id: string) => string | null) | null;
}): { lanes: Array<{ kind: string; text: string; words: string }>; skip: string | null } {
  const none = (skip: Untyped) => ({ lanes: [], skip });
  if (!trigger || trigger.self === true || (selfId && String(trigger.authorId) === String(selfId)))
    return none('no-trigger');
  if (NOT_EXTERNAL.has(triggerKind) || mode === 'selfreflection') return none('not-external');
  const asked = candidate ?? trigger;
  if (isTrivialTrigger(asked.content, { trivial: settings.trivial, selfNames: [selfName, ...selfNames] }))
    return none('trivial');
  const lines = Array.isArray(history) ? history : [];
  const own = textOf(asked, nameOf);
  const lanes = [{ kind: 'message', text: own, words: plainText(asked.content) }];
  const line = (message: PrefetchLine) => `${speakerOf(message, selfName)}: ${textOf(message, nameOf)}`;
  const parentId = typeof asked.replyToId === 'string' && asked.replyToId ? asked.replyToId : null;
  const parent = parentId ? lines.find((message) => message?.id === parentId && message.id !== asked.id) : null;
  if (parent && textOf(parent, nameOf)) {
    lanes.push({
      kind: 'reply',
      text: `${line(parent)}\n${line(asked)}`,
      words: `${plainText(parent.content)}\n${plainText(asked.content)}`,
    });
  }
  const folded = wordsOf(foldText(plainText(asked.content)));
  const deictic = new Set(settings.deictic ?? []);
  const short = folded.length <= settings.shortWords || folded.some((word) => deictic.has(word));
  if (short && settings.contextLines > 0) {
    const at = lines.findIndex((message) => message?.id === asked.id);
    const before = (at === -1 ? lines : lines.slice(0, at)).filter(
      (message) => message && message.id !== asked.id && message.id !== parent?.id && textOf(message, nameOf)
    );
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
 * The prefetch lane of an inner turn (src/behavior/inner.ts: no message opened it): the purposes
 * of the intentions its wakes concern, one per line, as one `wake` lane. None (`skip`
 * `no-trigger`) when no intention is concerned (a review alone). Pure.
 */
export function wakeLanes(purposes: Array<string>): {
  lanes: Array<{ kind: string; text: string; words: string }>;
  skip: string | null;
} {
  const texts = (Array.isArray(purposes) ? purposes : [])
    .map((purpose) => oneLine(String(purpose ?? '')))
    .filter(Boolean);
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
 */
export function lanePlan(
  lane: { kind: string; words: string },
  {
    profiles = [],
    selfId = null,
    selfName = '',
    maxForms = 8,
    shortWords = 4,
    minFormsMatched = 2,
    trigger = '',
  }: {
    profiles?: Array<Record<string, Untyped>>;
    selfId?: string | null;
    selfName?: string;
    maxForms?: number;
    shortWords?: number;
    minFormsMatched?: number;
    trigger?: string;
  } = {}
): { forms: Array<string>; who: Array<string>; phrases: Array<string>; need: number; from: null; to: null } | null {
  const words = String(lane?.words ?? '');
  const plan = fallbackLookupPlan({ text: words, profiles, selfId, selfName, maxForms });
  const phrases = quotedPhrases(words);
  const whole = plainText(trigger).toLowerCase();
  const count = wordsOf(foldText(whole)).length;
  if (
    lane?.kind === 'message' &&
    count >= 2 &&
    count <= shortWords &&
    [...whole].length <= PHRASE_MAX_CHARS &&
    !phrases.includes(whole)
  )
    phrases.unshift(whole);
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
 * @param plan  lanePlan's
 */
export function indexedPlan(
  plan: { forms: Array<string>; who: Array<string>; phrases: Array<string> } | null,
  queries: Array<{ terms: Array<{ word: string; weight: number }>; phrases: Array<{ text: string }> }>,
  { maxForms = 8, minFormsMatched = 2 }: { maxForms?: number; minFormsMatched?: number } = {}
):
  | { forms: Array<string>; who: Array<string>; phrases: Array<string> }
  | { forms: Array<string>; who: Array<string>; phrases: Array<string>; need: number; from: null; to: null }
  | null {
  const terms = (Array.isArray(queries) ? queries : [])
    .flatMap((query) => query?.terms ?? [])
    .sort((a, b) => b.weight - a.weight);
  const forms = [...new Set(terms.map((term) => term.word))].slice(0, Math.max(0, maxForms));
  const phrases = [
    ...new Set([
      ...(plan?.phrases ?? []),
      ...(Array.isArray(queries) ? queries : []).flatMap((query) =>
        (query?.phrases ?? []).map((phrase) => phrase.text)
      ),
    ]),
  ];
  if (forms.length === 0 && phrases.length === (plan?.phrases ?? []).length) return plan ?? null;
  const who = plan?.who ?? [];
  if (forms.length === 0 && who.length === 0 && phrases.length === 0) return null;
  return { forms, who, phrases, need: Math.min(Math.max(0, minFormsMatched), forms.length), from: null, to: null };
}

/**
 * Whether a word hit of the record index (src/memory/record-index.js#searchRecordIndex's: `terms`
 * and `phrases` matched) is relevant. Without the meaning search (`cosines` null): a phrase or at
 * least two terms. With it (`cosines`: the hits' cosines to the lane's text, a message without a
 * row in the vector index absent): a phrase always; two terms or more when the cosine is at least
 * `minMeaningScore` (or there is none); one term only when the cosine is at least
 * `singleTermScore`. Pure.
 */
/** One media item a search found, as the prefetch keeps it: at its latest use, by its words or its meaning. */
type FoundItem = {
  latest: { messageId: string };
  streams: ReadonlyArray<string>;
  terms: number;
  cosine: number | null;
};

/** The messages a lane's media items answer through, kept by the same floors a line's words and meaning are. */
export function itemLines(
  hits: ReadonlyArray<FoundItem>,
  shown: { has(id: string): boolean },
  settings: { minMeaningScore: number; singleTermScore: number; strongMeaningScore: number }
): { lexical: Array<string>; meaning: Array<string> } {
  const items = hits.filter((hit) => shown.has(hit.latest.messageId));
  const heard = items.filter(
    (hit) =>
      (hit.streams.includes('words') || hit.streams.includes('trigram')) &&
      lexicalKeep({ messageId: hit.latest.messageId, terms: hit.terms, phrases: 0 }, null, settings)
  );
  const meant = items.filter(
    (hit) =>
      hit.streams.includes('meaning') &&
      (hit.cosine ?? -1) >= settings.minMeaningScore &&
      ((hit.cosine ?? -1) >= settings.strongMeaningScore || hit.terms > 0)
  );
  return { lexical: heard.map((hit) => hit.latest.messageId), meaning: meant.map((hit) => hit.latest.messageId) };
}

export function lexicalKeep(
  hit: { messageId: string; terms: number; phrases: number },
  cosines: Map<string, number> | null,
  { minMeaningScore, singleTermScore }: { minMeaningScore: number; singleTermScore: number }
): boolean {
  if ((hit?.phrases ?? 0) > 0) return true;
  const terms = hit?.terms ?? 0;
  if (!(cosines instanceof Map)) return terms >= 2;
  const cosine = cosines.get(hit.messageId);
  if (terms >= 2) return cosine === undefined || cosine >= minMeaningScore;
  return terms === 1 && cosine !== undefined && cosine >= singleTermScore;
}

/** A stored-memory item's key: its itemId, else its kind and text. */
function itemKey(item: Untyped) {
  return typeof item?.itemId === 'string' && item.itemId
    ? `m:${item.itemId}`
    : `m:${item?.kind ?? ''}:${item?.text ?? ''}`;
}

/** One excerpt rankPrefetch offers: a window of the record with its relevant hits, or a stored item. */
export type PrefetchUnit =
  | { kind: 'history'; window: MergeWindowsResult; hitIds: Array<string>; rank: number }
  | { kind: 'memory'; item: Untyped; rank: number };

/**
 * The excerpts a prefetch offers, best first, from what each lane's searches found (`lanes`, in
 * lane order, each `{ windows, lexical, meaning, memory }`): `windows` the record windows its
 * searches built (`{ placeId, channelName, messages, hitIds }`), `lexical` its relevant word hits
 * best first (message ids), `meaning` its meaning hits at or above the score floor, best first
 * (message ids), `memory` its relevant stored-memory items, best first. The ranked lists of every
 * lane and backend are fused by reciprocal rank (fuseRanks); the windows of all lanes are merged
 * where they share a line (mergeWindows: one excerpt per stretch of chat), each window marked
 * only with its relevant hits and ranked by its best one; a window with none is dropped; stored
 * items deduplicated by itemId (else kind and text) and ranked the same way. Returned
 * `{ kind: 'history', window, hitIds, rank }` and `{ kind: 'memory', item, rank }`, best first
 * (`rank` the 1-based fused rank). Pure.
 */
export function rankPrefetch(
  lanes: Array<{
    windows?: Array<MergeWindowsInput>;
    lexical?: Array<string>;
    meaning?: Array<string>;
    memory?: Array<Untyped>;
  }>
): Array<PrefetchUnit> {
  const list = Array.isArray(lanes) ? lanes : [];
  const relevant = new Set<string>();
  const items = new Map<string, Untyped>();
  const lists: Array<Array<string>> = [];
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
  const rankOf = new Map<string, number>(fused.map((entry, i): [string, number] => [String(entry.id), i + 1]));
  // Every id asked for passed `rankOf.has`, so the fallback never applies.
  const rankAt = (id: string): number => rankOf.get(id) ?? Number.POSITIVE_INFINITY;
  const windows = mergeWindows(list.flatMap((lane) => (Array.isArray(lane?.windows) ? lane.windows : [])));
  const units: Array<PrefetchUnit> = [];
  for (const window of windows) {
    const hits = window.messages.map((m: { id: string }) => m.id).filter((id) => relevant.has(id) && rankOf.has(id));
    if (hits.length === 0) continue;
    const rank = Math.min(...hits.map(rankAt));
    units.push({
      kind: 'history',
      window: { ...window, hitIds: new Set(hits) },
      hitIds: hits.sort((a, b) => rankAt(a) - rankAt(b)),
      rank,
    });
  }
  for (const [key, item] of items) if (rankOf.has(key)) units.push({ kind: 'memory', item, rank: rankAt(key) });
  return units.sort((a, b) => a.rank - b.rank);
}

/**
 * The hits an excerpt marks (and is cut around): of `ranked` (hit ids, best first) the best one in
 * `order` (the window's message ids in their order), then each next one whose line keeps every
 * marked line within `maxLines` lines of each other; in rank order. Pure.
 */
export function focusHits(order: Array<string>, ranked: Array<string>, maxLines: number): Array<string> {
  const at = new Map<string, number>((Array.isArray(order) ? order : []).map((id, i) => [id, i]));
  const kept: Array<string> = [];
  let low = Infinity;
  let high = -Infinity;
  for (const id of Array.isArray(ranked) ? ranked : []) {
    if (!at.has(id)) continue;
    const i = at.get(id) ?? 0; // `at.has(id)` held, so the fallback never applies
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
 */
export function fitExcerpts<TExcerpt extends { text: string }>(
  rendered: Array<TExcerpt>,
  { maxExcerpts, maxTokens }: { maxExcerpts: number; maxTokens: number }
): Array<TExcerpt> {
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
