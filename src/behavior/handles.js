// Member handles: the short token the persona writes to mention someone (`@` + handle), so the
// model picks the person and the engine never guesses one from a name in her output. A handle is
// computed from the Discord user id alone (a few base-36 digits of the id's SHA-256), so the same
// member keeps the same handle across turns, restarts and requesters without anything stored;
// only code maps it back to the id. Within one request every handle is unique: on a collision
// the oldest id (the smallest snowflake) keeps the short form and the others take one more digit,
// and the members with a stored profile are placed before the ones only in view, so a passer-by
// never moves a profiled member's handle. The people directory (`<directory>`, the stable part of
// the persona's request) lists the profiled members with their handle, the names Discord gave them
// and their open aliases, sorted so its text changes only when those names do.
// Channels get handles the same way (`#` + CHANNEL_HANDLE_PREFIX + base-36 digits of the channel
// id's hash): the channel directory (`<channel_directory>`, the stable part too) lists each text
// channel the persona can read with its handle, its name and its category, sorted by id, so a
// channel she names resolves exactly and a made-up name never has to be guessed. Pure.

import { createHash } from 'node:crypto';
import { fill } from '../format.js';
import { oneLine } from '../memory/clamp.js';
import { isOpen } from '../memory/index.js';
import { outsideUrls } from '../memory/mentions.js';

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
function hashOf(id) {
  return BigInt(`0x${createHash('sha256').update(String(id)).digest('hex')}`);
}

/**
 * The handle of `id` with `digits` base-36 digits: `prefix`, then the id's SHA-256 modulo
 * 36^digits in base 36, zero-padded. The same id always gives the same handle. Pure.
 * @param {string} id
 * @param {number} [digits]  HANDLE_DIGITS by default.
 * @param {string} [prefix]  HANDLE_PREFIX (a member) by default; CHANNEL_HANDLE_PREFIX for a channel.
 * @returns {string}
 */
export function handleOf(id, digits = HANDLE_DIGITS, prefix = HANDLE_PREFIX) {
  const body = (hashOf(id) % DIGITS_BASE ** BigInt(digits)).toString(36).padStart(digits, '0');
  return `${prefix}${body}`;
}

/** Snowflakes oldest first: shorter digit strings first, then text order (any other id too). */
function compareIds(a, b) {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Every member's handle for one request. `profiled` (the members of the people directory) are
 * placed first, then `inView` (the authors of the lines shown) that are not profiled, so a member
 * in view never changes a profiled member's handle. Within each group, at HANDLE_DIGITS digits
 * and then one more each round: the ids that share a handle (or meet one already given) keep it
 * only for the oldest of them (compareIds), when it is still free; the others go on. The result
 * depends on the two sets only, never on their order. Blank and repeated ids are skipped. Pure.
 * @param {{ profiled?: Iterable<string>, inView?: Iterable<string> }} groups
 * @param {{ prefix?: string }} [options]  The handles' first character (HANDLE_PREFIX by default).
 * @returns {Map<string, string>}  id -> handle (without the `@`).
 */
export function assignHandles({ profiled = [], inView = [] } = {}, { prefix = HANDLE_PREFIX } = {}) {
  const handles = new Map();
  const taken = new Set();
  const place = (ids) => {
    let pending = [...new Set([...ids].filter((id) => id !== undefined && id !== null && String(id) !== '').map(String))]
      .filter((id) => !handles.has(id))
      .sort(compareIds);
    for (let digits = HANDLE_DIGITS; pending.length > 0 && digits <= MAX_DIGITS; digits += 1) {
      const groups = new Map();
      for (const id of pending) {
        const handle = handleOf(id, digits, prefix);
        if (!groups.has(handle)) groups.set(handle, []);
        groups.get(handle).push(id);
      }
      const next = [];
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

/** Non-blank one-line strings of `values`, each once, in code point order. */
function sortedNames(values) {
  const names = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string') continue;
    const name = oneLine(value);
    if (name) names.add(name);
  }
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The people directory's members from the stored profiles of the served guild: one entry per
 * member, never the persona herself (`selfId`; bots get no profile: the live pipeline skips
 * their lines). `names`: the stored
 * names Discord gave them; `aliases`: their open stored aliases (src/memory/interests.js#isOpen),
 * as stored, without one equal to a name. Both one-line, each once, in code point order, so
 * the stored order (the newest name first) never moves the text. A member with neither is
 * left out. Sorted by their first name (else first alias), then id. No notes, games or weights.
 * Pure.
 * @param {Iterable<object>} profiles  store.listUserProfiles of the served guild.
 * @param {{ selfId?: string|null }} [options]
 * @returns {{ id: string, names: string[], aliases: string[] }[]}
 */
export function directoryEntries(profiles, { selfId = null } = {}) {
  const self = selfId === undefined || selfId === null ? null : String(selfId);
  const byId = new Map();
  for (const profile of profiles ?? []) {
    if (!profile || typeof profile !== 'object' || profile.id === undefined || profile.id === null) continue;
    const id = String(profile.id);
    if (id === '' || id === self || byId.has(id)) continue;
    const names = sortedNames(profile.names);
    const aliases = sortedNames((Array.isArray(profile.aliases) ? profile.aliases : []).filter((alias) => isOpen(alias)).map((alias) => alias?.name)).filter(
      (alias) => !names.includes(alias),
    );
    if (names.length === 0 && aliases.length === 0) continue;
    byId.set(id, { id, names, aliases });
  }
  const keyOf = (entry) => entry.names[0] ?? entry.aliases[0];
  return [...byId.values()].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    return ka < kb ? -1 : ka > kb ? 1 : compareIds(a.id, b.id);
  });
}

/** The names of a directory line: each as a JSON string (quoted, escaped), joined by ", ". */
function quotedList(names) {
  return names.map((name) => JSON.stringify(name)).join(', ');
}

/**
 * The `<directory>` block's body: `labels.directory.lead` (when set), then one line per entry
 * with a handle -- `labels.directory.lineAliases` (`{handle}` `{names}` `{aliases}`) for a member
 * with aliases when that label is set, else `labels.directory.line` (`{handle}` `{names}`).
 * `{handle}` is the exact token to write, `@` included; `{names}` and `{aliases}` are quoted
 * lists (quotedList). '' without `labels.directory.line` or without a line. Pure.
 * @param {{ id: string, names: string[], aliases: string[] }[]} entries  directoryEntries'.
 * @param {Map<string, string>} handles  id -> handle (assignHandles').
 * @param {object} labels
 * @returns {string}
 */
export function renderDirectory(entries, handles, labels) {
  const l = labels?.directory;
  if (typeof l?.line !== 'string' || !l.line) return '';
  const lines = [];
  for (const entry of entries ?? []) {
    const handle = handles?.get(entry.id);
    if (!handle) continue;
    const values = { handle: `@${handle}`, names: quotedList(entry.names) };
    lines.push(
      entry.aliases.length > 0 && typeof l.lineAliases === 'string' && l.lineAliases
        ? fill(l.lineAliases, { ...values, aliases: quotedList(entry.aliases) })
        : fill(l.line, values),
    );
  }
  if (lines.length === 0) return '';
  return [typeof l.lead === 'string' ? l.lead : '', ...lines].filter(Boolean).join('\n');
}

/**
 * `text` with every whole `@handle` of `ids` (handle -> member id) turned into a real mention
 * (`<@id>`), outside URLs (src/memory/mentions.js#outsideUrls). Only the exact token counts: no
 * word character right before the `@` or after the handle, case as given. A handle-shaped token
 * (`@` + HANDLE_PREFIX + base-36 digits) the map does not hold stays as written and is counted in
 * `unknown`; any other `@word` (a name) stays as written. Pure.
 * @param {string} text
 * @param {Map<string, string>} ids  handle (without `@`) -> member id.
 * @returns {{ text: string, userIds: string[], unknown: number }}  `userIds`: the members
 *   mentioned, each once, in order (allowedMentions).
 */
export function resolveHandles(text, ids) {
  const userIds = [];
  let unknown = 0;
  const resolved = outsideUrls(String(text ?? ''), (part) =>
    part.replace(HANDLE_TOKEN_RE, (match, handle) => {
      const id = ids instanceof Map ? ids.get(handle) : undefined;
      if (id === undefined || id === null) {
        unknown += 1;
        return match;
      }
      if (!userIds.includes(String(id))) userIds.push(String(id));
      return `<@${id}>`;
    }),
  );
  return { text: resolved, userIds, unknown };
}

/**
 * Every channel's handle for one request: assignHandles over `ids` with CHANNEL_HANDLE_PREFIX,
 * so the oldest of two channels sharing a handle keeps the short form and the other takes one
 * more digit. A channel handle never equals a member handle (another prefix). Pure.
 * @param {Iterable<string>} ids
 * @returns {Map<string, string>}  channel id -> handle (without the `#`).
 */
export function assignChannelHandles(ids) {
  return assignHandles({ profiled: ids ?? [] }, { prefix: CHANNEL_HANDLE_PREFIX });
}

/**
 * The channel directory's entries: one per channel id of `channels` (`{ id, name, category? }`)
 * with a non-blank name, the first given winning; `name` and `category` one-line (`category`
 * null when blank or missing). Sorted by id (oldest first), so the text moves only when a channel
 * is added, removed or renamed -- never with activity, position or time. Pure.
 * @param {Iterable<{ id: string, name: string, category?: string|null }>} channels
 * @returns {{ id: string, name: string, category: string|null }[]}
 */
export function channelDirectoryEntries(channels) {
  const byId = new Map();
  for (const channel of channels ?? []) {
    if (!channel || typeof channel !== 'object' || channel.id === undefined || channel.id === null) continue;
    const id = String(channel.id);
    const name = typeof channel.name === 'string' ? oneLine(channel.name) : '';
    if (id === '' || !name || byId.has(id)) continue;
    const category = typeof channel.category === 'string' ? oneLine(channel.category) : '';
    byId.set(id, { id, name, category: category || null });
  }
  return [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
}

/**
 * The `<channel_directory>` block's body: `labels.channelDirectory.lead` (when set), then one line
 * per entry with a handle -- `labels.channelDirectory.lineCategory` (`{handle}` `{name}`
 * `{category}`) for a channel with a category when that label is set, else
 * `labels.channelDirectory.line` (`{handle}` `{name}`). `{handle}` is the exact token to write,
 * `#` included; `{name}` and `{category}` are JSON strings (quoted, escaped). '' without
 * `labels.channelDirectory.line` or without a line. Pure.
 * @param {{ id: string, name: string, category: string|null }[]} entries  channelDirectoryEntries'.
 * @param {Map<string, string>} handles  channel id -> handle (assignChannelHandles').
 * @param {object} labels
 * @returns {string}
 */
export function renderChannelDirectory(entries, handles, labels) {
  const l = labels?.channelDirectory;
  if (typeof l?.line !== 'string' || !l.line) return '';
  const lines = [];
  for (const entry of entries ?? []) {
    const handle = handles?.get(entry.id);
    if (!handle) continue;
    const values = { handle: `#${handle}`, name: JSON.stringify(entry.name) };
    lines.push(
      entry.category && typeof l.lineCategory === 'string' && l.lineCategory
        ? fill(l.lineCategory, { ...values, category: JSON.stringify(entry.category) })
        : fill(l.line, values),
    );
  }
  if (lines.length === 0) return '';
  return [typeof l.lead === 'string' ? l.lead : '', ...lines].filter(Boolean).join('\n');
}

/**
 * Every member's names for one request: the directory entries' names and aliases, then the names
 * the lines carry -- an author's name (never the persona's or a bot's) and the names of the members
 * a line mentions (`mentionedUsers`, `{ id, name }`, interfaces/discord/collect.js). id -> names,
 * each once, in the order met. Pure.
 * @param {{ id: string, names: string[], aliases: string[] }[]} entries  directoryEntries'.
 * @param {Iterable<object>} lines  Normalized messages.
 * @returns {Map<string, string[]>}
 */
export function memberNameMap(entries, lines) {
  const map = new Map();
  const add = (id, name) => {
    if (id === undefined || id === null || typeof name !== 'string') return;
    const text = oneLine(name);
    if (!text) return;
    const key = String(id);
    if (!map.has(key)) map.set(key, []);
    if (!map.get(key).includes(text)) map.get(key).push(text);
  };
  for (const entry of entries ?? []) for (const name of [...entry.names, ...entry.aliases]) add(entry.id, name);
  for (const line of lines ?? []) {
    if (!line || typeof line !== 'object') continue;
    if (!line.self && !line.bot) add(line.authorId, line.authorName);
    for (const user of Array.isArray(line.mentionedUsers) ? line.mentionedUsers : []) add(user?.id, user?.name);
  }
  return map;
}

export { untaggedNames, withUserHandles } from '../handles-text.js';
