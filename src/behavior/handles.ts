// Member handles: the short token the persona writes to mention someone (`@` + handle), so the
// model picks the person and the engine never guesses one from a name in her output. A handle is
// computed from the platform's user id alone (a few base-36 digits of the id's SHA-256), so the same
// member keeps the same handle across turns, restarts and requesters without anything stored;
// only code maps it back to the id. Within one request every handle is unique: on a collision
// the oldest id (the smallest snowflake) keeps the short form and the others take one more digit,
// and the members with a stored profile are placed before the ones only in view, so a passer-by
// never moves a profiled member's handle. The people directory (`<directory>`, the stable part of
// the persona's request) lists the profiled members with their handle, the names the platform gave them
// and their open aliases, sorted so its text changes only when those names do.
// Channels get handles the same way (`#` + CHANNEL_HANDLE_PREFIX + base-36 digits of the channel
// id's hash): the channel directory (`<channel_directory>`, the stable part too) lists each text
// channel the persona can read with its handle and its name, sorted by id, so a
// channel she names resolves exactly and a made-up name never has to be guessed. Pure.

import { createHash } from 'node:crypto';
import { oneLine } from '../memory/clamp.ts';
import { outsideUrls } from '../memory/mentions.ts';
import type { Untyped } from '../tools/types.ts';

/** The first character of every handle: tells a handle from a name after `@`. */
export const HANDLE_PREFIX = 'u';
/** The first character of every channel handle: a channel's handle is `#` + this + digits. */
export const CHANNEL_HANDLE_PREFIX = 'c';
/** Base-36 digits of a handle without a collision. */
export const HANDLE_DIGITS = 4;
// 256 bits of SHA-256 hold 49 base-36 digits: past that two ids would share their whole hash.
const MAX_DIGITS = 49;
const DIGITS_BASE = 36n;

// `@` + a handle-shaped token, whole: no word character right before the `@` or after the token.
const HANDLE_TOKEN_RE = new RegExp(`(?<![\\p{L}\\p{N}_])@(${HANDLE_PREFIX}[0-9a-z]+)(?![\\p{L}\\p{N}_])`, 'gu');

/** The id's SHA-256 as one number (the digits a handle is cut from). */
function hashOf(id: Untyped) {
  return BigInt(`0x${createHash('sha256').update(String(id)).digest('hex')}`);
}

/**
 * The handle of `id` with `digits` base-36 digits: `prefix`, then the id's SHA-256 modulo
 * 36^digits in base 36, zero-padded. The same id always gives the same handle. Pure.
 * @param [digits]  HANDLE_DIGITS by default.
 * @param [prefix]  HANDLE_PREFIX (a member) by default; CHANNEL_HANDLE_PREFIX for a channel.
 */
export function handleOf(id: string, digits: number = HANDLE_DIGITS, prefix: string = HANDLE_PREFIX): string {
  const body = (hashOf(id) % DIGITS_BASE ** BigInt(digits)).toString(36).padStart(digits, '0');
  return `${prefix}${body}`;
}

/** Snowflakes oldest first: shorter digit strings first, then text order (any other id too). */
function compareIds(a: Untyped, b: Untyped) {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Every member's handle for one request. `profiled` (the members of the people directory) are
 * placed first, then `inView` (the authors of the lines shown) that are not profiled, so a member
 * in view never changes a profiled member's handle. Within each group, at HANDLE_DIGITS digits
 * and then one more each round: the ids that share a handle (or meet one already given) keep it
 * only for the oldest of them (compareIds), when it is still free; the others go on. The result
 * depends on the two sets only, never on their order. Blank and repeated ids are skipped. Pure.
 * @param [options]  The handles' first character (HANDLE_PREFIX by default).
 * @returns id -> handle (without the `@`).
 */
export function assignHandles(
  { profiled = [], inView = [] }: { profiled?: Iterable<string>; inView?: Iterable<string> } = {},
  { prefix = HANDLE_PREFIX }: { prefix?: string } = {}
): Map<string, string> {
  const handles = new Map<string, string>();
  const taken = new Set<string>();
  const place = (ids: Untyped) => {
    let pending = [
      ...new Set([...ids].filter((id) => id !== undefined && id !== null && String(id) !== '').map(String)),
    ]
      .filter((id) => !handles.has(id))
      .sort(compareIds);
    for (let digits = HANDLE_DIGITS; pending.length > 0 && digits <= MAX_DIGITS; digits += 1) {
      const groups = new Map<string, Array<string>>();
      for (const id of pending) {
        const handle = handleOf(id, digits, prefix);
        if (!groups.has(handle)) groups.set(handle, []);
        groups.get(handle)?.push(id);
      }
      const next: Array<string> = [];
      for (const [handle, group] of groups) {
        if (taken.has(handle)) {
          next.push(...group);
          continue;
        }
        handles.set(group[0], handle);
        taken.add(handle);
        next.push(...group.slice(1));
      }
      pending = next.sort(compareIds);
    }
  };
  place(profiled);
  place(inView);
  return handles;
}

/**
 * `text` with every whole `@handle` of `ids` (handle -> member id) turned into a real mention
 * (`<@id>`), outside URLs (src/memory/mentions.ts#outsideUrls). Only the exact token counts: no
 * word character right before the `@` or after the handle, case as given. A handle-shaped token
 * (`@` + HANDLE_PREFIX + base-36 digits) the map does not hold stays as written and is counted in
 * `unknown`; any other `@word` (a name) stays as written. Pure.
 * @param ids  handle (without `@`) -> member id.
 * @returns `accountIds`: the members
 *   mentioned, each once, in order (allowedMentions).
 */
export function resolveHandles(
  text: string,
  ids: Map<string, string>
): { text: string; accountIds: Array<string>; unknown: number } {
  const accountIds: Array<string> = [];
  let unknown = 0;
  const resolved = outsideUrls(String(text ?? ''), (part) =>
    part.replace(HANDLE_TOKEN_RE, (match, handle) => {
      const id = ids instanceof Map ? ids.get(handle) : undefined;
      if (id === undefined || id === null) {
        unknown += 1;
        return match;
      }
      if (!accountIds.includes(String(id))) accountIds.push(String(id));
      return `<@${id}>`;
    })
  );
  return { text: resolved, accountIds, unknown };
}

/** How many lengths past HANDLE_DIGITS widenHandles reads: a third id on one handle is rare already. */
const WIDEN_EXTRA_DIGITS = 2;

/**
 * `shown` (one request's handle -> id) with, behind it, the handle every id of `ids` has in any
 * request: handleOf at HANDLE_DIGITS digits and at each of WIDEN_EXTRA_DIGITS more, since a
 * collision in the request that showed it may have lengthened it. A handle two ids of `ids` share
 * is left out, so a collision is never guessed, and a handle of `shown` keeps its id. A handle
 * depends on the id alone, so this resolves a handle she carries from an earlier request (an
 * intention, her last think) for a member or channel this request did not show. Pure.
 * @param [prefix]  HANDLE_PREFIX (members) by default; CHANNEL_HANDLE_PREFIX for channels.
 * @returns handle (without the sigil) -> id.
 */
export function widenHandles(
  shown: ReadonlyMap<string, string> | null,
  ids: Iterable<string>,
  prefix: string = HANDLE_PREFIX
): Map<string, string> {
  const owners = new Map<string, string | null>();
  const unique = new Set([...ids].filter((id) => id !== undefined && id !== null && String(id) !== '').map(String));
  for (const id of unique)
    for (let digits = HANDLE_DIGITS; digits <= HANDLE_DIGITS + WIDEN_EXTRA_DIGITS; digits += 1) {
      const handle = handleOf(id, digits, prefix);
      owners.set(handle, owners.has(handle) && owners.get(handle) !== id ? null : id);
    }
  const widened = new Map<string, string>();
  for (const [handle, id] of owners) if (id !== null) widened.set(handle, id);
  for (const [handle, id] of shown ?? []) widened.set(handle, id);
  return widened;
}

/**
 * Every channel's handle for one request: assignHandles over `ids` with CHANNEL_HANDLE_PREFIX,
 * so the oldest of two channels sharing a handle keeps the short form and the other takes one
 * more digit. A channel handle never equals a member handle (another prefix). Pure.
 * @returns channel id -> handle (without the `#`).
 */
export function assignChannelHandles(ids: Iterable<string>): Map<string, string> {
  return assignHandles({ profiled: ids ?? [] }, { prefix: CHANNEL_HANDLE_PREFIX });
}

/** A normalized message, as far as the name map reads it. */
type NamedLine = {
  self?: boolean;
  bot?: boolean;
  authorId?: string | null;
  authorName?: string | null;
  mentionedUsers?: Array<{ id?: string | null; name?: string | null } | null>;
};

/**
 * Every member's names for one request: the directory entries' names and aliases, then the names
 * the lines carry -- an author's name (never the persona's or a bot's) and the names of the members
 * a line mentions (`mentionedUsers`, `{ id, name }`, src/protocol/events.ts). id -> names,
 * each once, in the order met. Pure.
 * @param entries  directoryEntries'.
 * @param lines  Normalized messages.
 */
export function memberNameMap(
  entries: Array<{ id: string; names: Array<string>; aliases: Array<string> }>,
  lines: Iterable<NamedLine>
): Map<string, Array<string>> {
  const map = new Map<string, Array<string>>();
  const add = (id: string | null | undefined, name: string | null | undefined) => {
    if (id === undefined || id === null || typeof name !== 'string') return;
    const text = oneLine(name);
    if (!text) return;
    const key = String(id);
    const names = map.get(key) ?? [];
    map.set(key, names);
    if (!names.includes(text)) names.push(text);
  };
  for (const entry of entries ?? []) for (const name of [...entry.names, ...entry.aliases]) add(entry.id, name);
  for (const line of lines ?? []) {
    if (!line || typeof line !== 'object') continue;
    if (!line.self && !line.bot) add(line.authorId, line.authorName);
    for (const user of Array.isArray(line.mentionedUsers) ? line.mentionedUsers : []) add(user?.id, user?.name);
  }
  return map;
}

export { untaggedNames, withUserHandles } from '../handles-text.ts';
