// A member is stored and passed to the model as an id token, never as a
// nickname -- Discord display names change daily, so free text that names
// someone by nickname rots the moment they rename (see
// docs/prompt-contract.md, "Members are referred to by id, never by
// nickname"). This module is the one place that converts between the two
// representations:
//
//   toTokens     the analyzer's free text -> tokens, on the way IN (a model
//                that writes `Name (id:123...)` instead of the bare token is
//                normalized rather than rejected)
//   fromTokens   tokens -> display text, on the way OUT: the member's current
//                name for the chat model, `name (id:123...)` for the analyzer
//   tokenIds     the member ids a stored text's tokens name
//
// Pure, no discord.js dependency: `isKnownId`/`nameOf`/`namesOf` are injected
// so the caller decides what "known" means (an author of the batch, an
// existing stored profile, ...) and where a display name comes from.
//
// It also owns the two text primitives those conversions rest on and other
// modules share: `ID_DIGITS` (the id range every id pattern is built from) and
// the whole-word test (`isWordChar`, `occursAsWholeWord`) used by name
// triggers, lore keys and the `<people>` name scan, with its ending-tolerant
// variant (`occursAsWordStem`) used by recall's forms. And the lesson teacher
// rule (`teacherToken`, `TEACHER_TOKEN_RE`): which member taught the persona a
// thing, one rule for both analyzer modes (src/memory/update.js#parseLearnedOps
// and src/memory/voice.js#splitDecision), so switching modes never changes a
// lesson's teacher.
//
// Channels go the same way back out: `linkChannels` turns the `#name` the
// persona writes into the `<#id>` link the chat shows as a channel, and `linkMessageNumbers` turns a
// transcript number `#93` into the jump link of that message. And a forget takes a member
// out of a kept text (`redactUser`): their token and their names become a neutral word.
// A written channel name is matched by its core too (`channelCore`, `matchChannel`): the name
// without leading and trailing emoji or symbols, folded, since models copy those unreliably.
// A URL the persona writes is never rewritten on the way out (`URL_PATTERN`, `outsideUrls`):
// a `#name` or `@name` inside it is part of the address.

import { foldText } from './recent.js';

/**
 * The digits of a Discord member id, as a regex source: the one id range every
 * pattern that reads an id out of text is built from (`<@id>` tokens,
 * `(id:...)` markers, a taught item's `from`).
 */
export const ID_DIGITS = '\\d{17,20}';

/**
 * An http(s) URL as written in a text, as a regex source: from the scheme up to
 * the next whitespace or angle bracket (a `<url>` keeps its brackets outside).
 * The one pattern for the URLs the persona reads (src/discord/collect.js caps
 * their length), the ones she writes (left alone on the way out), and the ones
 * src/memory/clamp.js#stripUrls takes out of every text her memory stores.
 */
export const URL_PATTERN = 'https?:\\/\\/[^\\s<>]+';

/**
 * `text` with `convert` applied to every stretch outside its URLs
 * (URL_PATTERN), the URLs kept exactly as written. `convert` may get ''. Pure.
 * @param {string} text
 * @param {(part: string) => string} convert
 * @returns {string}
 */
export function outsideUrls(text, convert) {
  let result = '';
  let index = 0;
  for (const match of text.matchAll(new RegExp(URL_PATTERN, 'g'))) {
    result += convert(text.slice(index, match.index)) + match[0];
    index = match.index + match[0].length;
  }
  return result + convert(text.slice(index));
}

const TOKEN_RE = new RegExp(`<@(${ID_DIGITS})>`, 'g');
const ID_MARKER_RE = new RegExp(`\\(id:(${ID_DIGITS})\\)`, 'g');

/**
 * A lesson's teacher in its stored form: the whole value is exactly one `<@id>` token (group 1 =
 * the id). No `g` flag, so the shared pattern keeps no state between calls.
 */
export const TEACHER_TOKEN_RE = new RegExp(`^<@(${ID_DIGITS})>$`);
// The other form the analyzer may write a teacher in: one `name (id:...)` reference, the name any
// text without parentheses or angle brackets (several words, or none).
const TEACHER_REF_RE = new RegExp(`^[^()<>]*\\(id:(${ID_DIGITS})\\)$`);

/**
 * A lesson's teacher (the `from` of a taught item) as the `<@id>` token it is stored as. `from`,
 * trimmed, must be exactly one `<@id>` token or one `name (id:...)` reference (whatever the name)
 * of an id `isKnownId` accepts; anything else -- a bare name, an unknown id, two references, other
 * text around them -- gives undefined: a teacher is never guessed from the text or the batch.
 * @param {unknown} from
 * @param {(id: string) => boolean} isKnownId  Not a function -> no id is known.
 * @returns {string|undefined}
 */
export function teacherToken(from, isKnownId) {
  if (typeof from !== 'string') return undefined;
  const trimmed = from.trim();
  const id = TEACHER_TOKEN_RE.exec(trimmed)?.[1] ?? TEACHER_REF_RE.exec(trimmed)?.[1];
  return id && typeof isKnownId === 'function' && isKnownId(id) ? `<@${id}>` : undefined;
}

/**
 * How much of `before` (the text immediately preceding an `(id:...)` marker)
 * is "the name" when no known name matched: the single name-like word
 * (letters, digits, apostrophes, hyphens -- deliberately no spaces or
 * sentence punctuation) directly touching the marker, plus one optional
 * space. A name is rarely more than one word in the wild, and guessing
 * several words would as often as not swallow an unrelated preceding word
 * instead (a verb or preposition ending right before the marker, e.g.
 * "trusts NAME (id:...)" or "argued with NAME (id:...)" -- both extremely
 * common, and only the single trailing word is ever the actual name).
 * Returns 0 when `before` does not end in a name-like word at all (nothing
 * to convert -- the marker is then left exactly as written).
 * @param {string} before
 * @returns {number}
 */
function fallbackNameLength(before) {
  const hasSpace = before.endsWith(' ');
  const stripped = hasSpace ? before.slice(0, -1) : before;
  const match = /[\p{L}\p{N}][\p{L}\p{N}'’-]*$/u.exec(stripped);
  return match ? match[0].length + (hasSpace ? 1 : 0) : 0;
}

/**
 * How much of `before` is "the name" when `names` (the member's known
 * names, longest first) are given: the longest name that `before`, with at
 * most one trailing space ignored, ends with -- exact, case-sensitive. `-1`
 * when none of them match (the caller then falls back to `fallbackNameLength`).
 * @param {string} before
 * @param {string[]} names  Already sorted longest-first.
 * @returns {number}
 */
function knownNameLength(before, names) {
  const hasSpace = before.endsWith(' ');
  const stripped = hasSpace ? before.slice(0, -1) : before;
  for (const name of names) {
    if (name && stripped.endsWith(name)) return name.length + (hasSpace ? 1 : 0);
  }
  return -1;
}

/**
 * Turn `Name (id:123456789012345678)` written by the model into the token
 * `<@123456789012345678>`, but only when `isKnownId(id)` is true -- an
 * unrecognised id, and everything else in `text`, is left untouched.
 *
 * `namesOf(id)` (optional), when it returns a non-empty array, makes the
 * match NAME-AWARE instead of guessing a word count: the longest of the
 * member's known names (case-sensitive, exact) that the text immediately
 * before the marker ends with (ignoring one trailing space) is consumed as
 * the name, however many words it has -- so "Al Sus (id:...)" round-trips
 * correctly even though "Al Sus" is two words. Without a match among the
 * known names, or without `namesOf` at all, this falls back to consuming
 * the single name-like word touching the marker (see `fallbackNameLength`);
 * a marker with no name-like word before it at all is left untouched.
 * Already idempotent: a token contains no `(id:...)` for the pattern to
 * match again.
 * @param {string} text
 * @param {(id: string) => boolean} isKnownId
 * @param {(id: string) => (string[]|null|undefined)} [namesOf]
 * @returns {string}
 */
export function toTokens(text, isKnownId, namesOf) {
  if (typeof text !== 'string' || !text) return text;

  let result = '';
  let lastIndex = 0;
  for (const match of text.matchAll(ID_MARKER_RE)) {
    const id = match[1];
    const markerStart = match.index;
    const markerEnd = markerStart + match[0].length;
    const before = text.slice(lastIndex, markerStart);

    if (!isKnownId(id)) {
      result += before + match[0];
      lastIndex = markerEnd;
      continue;
    }

    const rawNames = typeof namesOf === 'function' ? namesOf(id) : null;
    const names = Array.isArray(rawNames)
      ? [...new Set(rawNames.filter((n) => typeof n === 'string' && n))].sort((a, b) => b.length - a.length)
      : [];

    let consumed = names.length > 0 ? knownNameLength(before, names) : -1;
    if (consumed === -1) consumed = fallbackNameLength(before);

    if (consumed === 0) {
      // Nothing name-like precedes the marker -- leave it exactly as written.
      result += before + match[0];
      lastIndex = markerEnd;
      continue;
    }

    result += before.slice(0, before.length - consumed);
    result += `<@${id}>`;
    lastIndex = markerEnd;
  }
  result += text.slice(lastIndex);
  return result;
}

/**
 * Resolve every `<@id>` token in `text` back to display text.
 * `mode: 'chat'` -> the member's current name alone (so `@name` mention
 * resolution downstream still works); `mode: 'analyzer'` -> `name (id:123...)`.
 * `nameOf(id)` returning anything other than a non-empty string leaves that
 * token exactly as written (an id the caller cannot currently resolve).
 * @param {string} text
 * @param {(id: string) => (string|null|undefined)} nameOf
 * @param {'chat'|'analyzer'} mode
 * @returns {string}
 */
export function fromTokens(text, nameOf, mode) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(TOKEN_RE, (whole, id) => {
    const name = typeof nameOf === 'function' ? nameOf(id) : null;
    if (typeof name !== 'string' || !name) return whole;
    return mode === 'analyzer' ? `${name} (id:${id})` : name;
  });
}

/**
 * The member ids `text` names through `<@id>` tokens, each once, in the order
 * they first appear -- how a stored text's member list is computed by code
 * rather than taken from the model (src/memory/recent.js). An `(id:...)`
 * marker is not a token; a non-string `text` names nobody.
 * @param {unknown} text
 * @returns {string[]}
 */
export function tokenIds(text) {
  if (typeof text !== 'string' || !text) return [];
  return [...new Set(Array.from(text.matchAll(TOKEN_RE), (match) => match[1]))];
}

/**
 * Whether `ch` is a word character: a letter, a digit or an underscore, in any
 * script. `undefined` (before the start or past the end of a string) is not.
 * @param {string|undefined} ch
 * @returns {boolean}
 */
export function isWordChar(ch) {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}

/**
 * Whether `needleLower` occurs in `haystackLower` as a whole word/phrase
 * (Unicode-aware boundaries, see `isWordChar`). Every occurrence is tried, so
 * one inside a longer word does not hide a later whole one; an empty needle
 * never occurs.
 * @param {string} haystackLower
 * @param {string} needleLower
 * @returns {boolean}
 */
export function occursAsWholeWord(haystackLower, needleLower) {
  if (!needleLower) return false;
  let from = 0;
  for (;;) {
    const at = haystackLower.indexOf(needleLower, from);
    if (at === -1) return false;
    const before = haystackLower[at - 1];
    const after = haystackLower[at + needleLower.length];
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = at + 1;
  }
}

/** A form word this long or longer matches by its stem (occursAsWordStem). */
const STEM_MIN_WORD = 5;
/** Letters cut from a form word's end to make its stem. */
const STEM_CUT = 2;
/** The shortest stem. */
const STEM_MIN = 4;
/** How many letters a matched text word may run past the form word. */
const STEM_MAX_EXTRA = 3;

/** The words of `text`: maximal runs of word characters (`isWordChar`), each as its code points. */
function wordsOf(text) {
  const words = [];
  let current = null;
  for (const ch of text) {
    if (isWordChar(ch)) (current ??= []).push(ch);
    else if (current) {
      words.push(current);
      current = null;
    }
  }
  if (current) words.push(current);
  return words;
}

/** Whether the text word `word` matches the form word `formWord` (both code point arrays) by the stem rule. */
function wordMatches(word, formWord) {
  const whole = formWord.length < STEM_MIN_WORD || formWord.some((ch) => /\p{N}/u.test(ch));
  if (whole) return word.length === formWord.length && word.every((ch, i) => ch === formWord[i]);
  const stem = Math.max(STEM_MIN, formWord.length - STEM_CUT);
  if (word.length < stem || word.length > formWord.length + STEM_MAX_EXTRA) return false;
  for (let i = 0; i < stem; i += 1) if (word[i] !== formWord[i]) return false;
  return true;
}

/**
 * Whether `form` occurs in `text` allowing word endings, both already folded
 * (src/memory/recent.js#foldText) -- recall's matching of a form against stored
 * text, tolerant of inflection. Words are runs of `isWordChar`. A form word of
 * 5+ letters without digits matches a text word that starts with its stem (the
 * word minus its last 2 letters, never under 4 letters) and is at most 3
 * letters longer than the form word; a shorter form word or one with digits
 * matches only a whole equal word. A multi-word form matches consecutive text
 * words in order, each by that rule. A form without word characters falls back
 * to `occursAsWholeWord`; an empty form never occurs.
 * @param {string} text
 * @param {string} form
 * @returns {boolean}
 */
export function occursAsWordStem(text, form) {
  if (!form) return false;
  const formWords = wordsOf(form);
  if (formWords.length === 0) return form.trim() ? occursAsWholeWord(text, form) : false;
  const words = wordsOf(text);
  for (let start = 0; start + formWords.length <= words.length; start += 1) {
    if (formWords.every((formWord, i) => wordMatches(words[start + i], formWord))) return true;
  }
  return false;
}

/** Leading or trailing characters that are no letter and no digit: emoji, symbols, punctuation, joiners. */
const CORE_EDGES_RE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
/** One emoji-like character a written channel name may carry around its core (never punctuation or space). */
const NAME_DECOR_RE = /[\p{So}\p{Sk}\p{Cf}\p{M}\p{Emoji_Presentation}]/u;

/**
 * The core of a channel name: folded (src/memory/recent.js#foldText: case and accents) with every
 * leading and trailing character that is no letter and no digit cut off -- emoji, symbols,
 * punctuation, variation selectors, joiners. '' when nothing is left. Models copy a leading emoji
 * of a channel name unreliably; the core is what they keep.
 * @param {unknown} name
 * @returns {string}
 */
export function channelCore(name) {
  return foldText(name).replace(CORE_EDGES_RE, '');
}

/**
 * The channel a written name names among `channels` (`{ id, name }`): the one whose name is exactly
 * `written`, else the one whose core (channelCore) equals its core; `'ambiguous'` when several
 * share that name or core (never a guess), null when none or `written` has no core.
 * @param {string} written  The name as written, without its `#`.
 * @param {Iterable<{ id: string, name: string }>} channels
 * @returns {{ id: string, name: string } | 'ambiguous' | null}
 */
export function matchChannel(written, channels) {
  const list = [...(channels ?? [])].filter((channel) => channel && typeof channel.name === 'string' && channel.name && channel.id !== undefined && channel.id !== null);
  const given = String(written ?? '');
  const exact = list.filter((channel) => channel.name === given);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return 'ambiguous';
  const core = channelCore(given);
  if (!core) return null;
  const same = list.filter((channel) => channelCore(channel.name) === core);
  if (same.length === 1) return same[0];
  return same.length > 1 ? 'ambiguous' : null;
}

/**
 * The channel whose core is written at `at` of `text` (after the `#`, with any emoji before it),
 * and where the written name ends (its trailing emoji included), or null: the longest unambiguous
 * core of `byCore` whose fold equals the text's run from the first word character, ending at a
 * word boundary.
 */
function coreAt(text, at, byCore) {
  let start = at;
  while (start < text.length && !isWordChar(text[start]) && NAME_DECOR_RE.test(String.fromCodePoint(text.codePointAt(start)))) {
    start += String.fromCodePoint(text.codePointAt(start)).length;
  }
  if (!isWordChar(text[start])) return null;
  for (const [core, channel] of byCore) {
    // A fold keeps the length of a run or shortens it (combining marks go): try ends from the core's length on.
    for (let end = start + 1; end <= Math.min(text.length, start + core.length * 2 + 2); end += 1) {
      if (isWordChar(text[end])) continue;
      if (foldText(text.slice(start, end)) !== core) continue;
      let stop = end;
      while (stop < text.length && !isWordChar(text[stop]) && NAME_DECOR_RE.test(String.fromCodePoint(text.codePointAt(stop)))) {
        stop += String.fromCodePoint(text.codePointAt(stop)).length;
      }
      return { channel, end: stop };
    }
  }
  return null;
}

/**
 * Turn every `#name` of a known channel in the persona's outgoing `text` into
 * the real channel link `<#id>` -- incoming `<#id>` mentions reach the model as
 * `#name` (src/discord/collect.js), so this is the way back out. Exact,
 * case-sensitive names first, the longest first (a name may be a prefix of another);
 * then, failing that, the core (channelCore, matchChannel's rule): the written name with other or
 * no leading emoji, in any case and accents, links to the one channel with that core, never to
 * one of several sharing it, the longest core first, its trailing emoji taken along;
 * a match counts only when the character before `#` is not a word character
 * and the one after the name is not a word character either (or the end). An
 * existing `<#id>` link and a `#` inside a URL (outsideUrls) are left alone;
 * text without `#` comes back unchanged.
 * @param {string} text
 * @param {Iterable<{ id: string, name: string }>} channels  The served guild's text channels.
 * @returns {string}
 */
export function linkChannels(text, channels) {
  if (typeof text !== 'string' || !text.includes('#') || !channels) return text;
  const known = [];
  for (const channel of channels) {
    if (typeof channel?.id === 'string' && channel.id && typeof channel.name === 'string' && channel.name) known.push(channel);
  }
  if (known.length === 0) return text;
  known.sort((a, b) => b.name.length - a.name.length);
  // Each core shared by exactly one channel, the longest first.
  const counts = new Map();
  for (const channel of known) {
    const core = channelCore(channel.name);
    if (core) counts.set(core, [...(counts.get(core) ?? []), channel]);
  }
  const byCore = new Map(
    [...counts.entries()].filter(([, channels]) => channels.length === 1).sort((a, b) => b[0].length - a[0].length).map(([core, [channel]]) => [core, channel]),
  );

  return outsideUrls(text, (part) => linkChannelsIn(part, known, byCore));
}

/** linkChannels over one stretch of text holding no URL. */
function linkChannelsIn(text, known, byCore) {
  let result = '';
  let index = 0;
  while (index < text.length) {
    const at = text.indexOf('#', index);
    if (at === -1) break;
    result += text.slice(index, at);
    const before = text[at - 1];
    let linked = null;
    if (before !== '<' && !isWordChar(before)) {
      const exact = known.find(({ name }) => text.startsWith(name, at + 1) && !isWordChar(text[at + 1 + name.length])) ?? null;
      linked = exact ? { channel: exact, end: at + 1 + exact.name.length } : coreAt(text, at + 1, byCore);
    }
    if (linked) {
      result += `<#${linked.channel.id}>`;
      index = linked.end;
    } else {
      result += '#';
      index = at + 1;
    }
  }
  return result + text.slice(index);
}

/** Spans `linkMessageNumbers` leaves alone: fenced code, inline code, and URLs already in the text. */
const PROTECTED_SPAN_RE = /```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+/g;
const MESSAGE_NUMBER_RE = /(?<![\p{L}\p{N}_&#<])#(\d+)(?![\p{L}\p{N}_])/gu;

/**
 * Turn every transcript number `#n` in the persona's outgoing `text` into the jump link of the
 * message it names, so the chat shows a clickable pill instead of a bare number. A token counts
 * when `n` is digits, the character before `#` is not a word character, `&`, `#` or `<`, and the
 * one after the digits is not a word character; a number `resolve` does not know stays as
 * written. Code spans and URLs already present are skipped.
 * @param {string} text
 * @param {(n: number) => (string|null|undefined)} resolve  Number -> link, or null when unmapped.
 * @returns {string}
 */
export function linkMessageNumbers(text, resolve) {
  if (typeof text !== 'string' || !text.includes('#') || typeof resolve !== 'function') return text;
  const convert = (part) =>
    part.replace(MESSAGE_NUMBER_RE, (whole, digits) => {
      const link = resolve(Number(digits));
      return typeof link === 'string' && link ? link : whole;
    });
  let result = '';
  let index = 0;
  for (const match of text.matchAll(PROTECTED_SPAN_RE)) {
    result += convert(text.slice(index, match.index)) + match[0];
    index = match.index + match[0].length;
  }
  return result + convert(text.slice(index));
}

/** The fewest word characters a name needs before `redactUser` replaces it (a shorter one is too common a word). */
const MIN_REDACT_NAME = 3;

/**
 * `text` with one member taken out of it (a forget, src/memory/store.js#forgetUser): every
 * `<@id>` / `<@!id>` token of `userId` and every one of `names` occurring as a whole word
 * (case-insensitive, any script; the longest first; a name with fewer than three word characters
 * is left alone) replaced by `token`. Anything that is not a string comes back unchanged.
 * @param {unknown} text
 * @param {{ userId: string, names?: string[], token: string }} opts
 * @returns {unknown}
 */
export function redactUser(text, { userId, names = [], token }) {
  if (typeof text !== 'string' || !text) return text;
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = text.split(`<@${userId}>`).join(token).split(`<@!${userId}>`).join(token);
  const usable = [...new Set((Array.isArray(names) ? names : []).filter((name) => typeof name === 'string').map((name) => name.trim()))]
    .filter((name) => [...name].filter((ch) => isWordChar(ch) && ch !== '_').length >= MIN_REDACT_NAME)
    .sort((a, b) => b.length - a.length);
  for (const name of usable) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escape(name)}(?![\\p{L}\\p{N}_])`, 'giu'), () => token);
  }
  return out;
}
