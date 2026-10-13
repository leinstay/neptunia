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
// triggers, lore keys and the `<people>` name scan. And the lesson teacher
// rule (`teacherToken`, `TEACHER_TOKEN_RE`): which member taught the persona a
// thing, one rule for both analyzer modes (src/memory/update.js#parseLearnedOps
// and src/memory/voice.js#splitDecision), so switching modes never changes a
// lesson's teacher.
//
// Channels go the same way back out: `linkChannels` turns the `#name` the
// persona writes into the `<#id>` link the chat shows as a channel. And a forget takes a member
// out of a kept text (`redactUser`): their token and their names become a neutral word.

/**
 * The digits of a Discord member id, as a regex source: the one id range every
 * pattern that reads an id out of text is built from (`<@id>` tokens,
 * `(id:...)` markers, a taught item's `from`).
 */
export const ID_DIGITS = '\\d{17,20}';

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

/**
 * Turn every `#name` of a known channel in the persona's outgoing `text` into
 * the real channel link `<#id>` -- incoming `<#id>` mentions reach the model as
 * `#name` (src/discord/collect.js), so this is the way back out. Exact,
 * case-sensitive names, the longest first (a name may be a prefix of another);
 * a match counts only when the character before `#` is not a word character
 * and the one after the name is not a word character either (or the end). An
 * existing `<#id>` link is left alone; text without `#` comes back unchanged.
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

  let result = '';
  let index = 0;
  while (index < text.length) {
    const at = text.indexOf('#', index);
    if (at === -1) break;
    result += text.slice(index, at);
    const before = text[at - 1];
    let linked = null;
    if (before !== '<' && !isWordChar(before)) {
      linked = known.find(({ name }) => text.startsWith(name, at + 1) && !isWordChar(text[at + 1 + name.length])) ?? null;
    }
    if (linked) {
      result += `<#${linked.id}>`;
      index = at + 1 + linked.name.length;
    } else {
      result += '#';
      index = at + 1;
    }
  }
  return result + text.slice(index);
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
