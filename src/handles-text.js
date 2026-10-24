// The pure text pieces of member handles that the transcript renderer (src/format.js) needs, in a
// module of their own so it never imports src/behavior/handles.js (which imports src/format.js):
// a mention in a line's text written as the member's `@handle` (withUserHandles) and the tags of
// the persona's own text that named a member without the handle (untaggedNames). No imports from
// format.js. src/behavior/handles.js re-exports both.

import { isWordChar, outsideUrls } from './memory/mentions.js';

/**
 * The first of `entries` (`{ name }`, longest name first) written whole right after the `@` at
 * `at` of `text`, else undefined. Whole: no word character right before the `@` or after the
 * name. `fold` compares in lower case. Pure.
 */
function nameAt(text, at, entries, fold) {
  if (isWordChar(text[at - 1])) return undefined;
  return entries.find(({ name }) => {
    const written = text.slice(at + 1, at + 1 + name.length);
    return (fold ? written.toLowerCase() === name.toLowerCase() : written === name) && !isWordChar(text[at + 1 + name.length]);
  });
}

/** Entries of `{ name, ... }` for the names of `ids`, longest name first. */
function nameEntries(ids, names, extra) {
  const out = [];
  for (const id of ids) for (const name of names.get(String(id)) ?? []) out.push({ ...extra(String(id)), name, id: String(id) });
  return out.sort((a, b) => b.name.length - a.name.length);
}

/**
 * `text` (a transcript line as Discord's cleanContent reads it) with every member it really
 * mentions (`mentionedIds`) written as `@handle` instead of `@DisplayName`: each whole `@name` of
 * those members' `names` (exact case; the longest first; URLs left alone) whose member has a
 * handle in `handles` (id -> handle). A mentioned member without a handle keeps the name. Pure.
 * @param {string} text
 * @param {Iterable<string>} mentionedIds
 * @param {{ names: Map<string, string[]>, handles: Map<string, string> }} members
 * @returns {string}
 */
export function withUserHandles(text, mentionedIds, { names, handles }) {
  if (typeof text !== 'string' || !text.includes('@')) return text;
  const entries = nameEntries(
    [...new Set([...(mentionedIds ?? [])].map(String))].filter((id) => handles.has(id)),
    names,
    (id) => ({ handle: handles.get(id) }),
  );
  if (entries.length === 0) return text;
  return outsideUrls(text, (part) => {
    let out = '';
    let index = 0;
    while (index < part.length) {
      const at = part.indexOf('@', index);
      if (at === -1) break;
      out += part.slice(index, at);
      const entry = nameAt(part, at, entries, false);
      if (entry) {
        out += `@${entry.handle}`;
        index = at + 1 + entry.name.length;
      } else {
        out += '@';
        index = at + 1;
      }
    }
    return out + part.slice(index);
  });
}

/**
 * The tags in `text` that went nowhere: every whole `@name` (any case; the longest name first;
 * URLs left alone) of a member in `names` (id -> names and aliases) who has a handle in `handles`
 * (id -> handle) and is not among `mentionedIds` (the members the post really mentions). A name
 * that a mentioned member also carries counts as theirs. Each member once, in order of
 * appearance. Pure.
 * @param {string} text
 * @param {{ names: Map<string, string[]>, handles: Map<string, string>, mentionedIds?: Iterable<string> }} members
 * @returns {{ name: string, id: string, handle: string }[]}  `name`: as written, without the `@`.
 */
export function untaggedNames(text, { names, handles, mentionedIds = [] }) {
  if (typeof text !== 'string' || !text.includes('@') || !(names instanceof Map) || !(handles instanceof Map)) return [];
  const mentioned = new Set([...mentionedIds].map(String));
  const ids = [...names.keys()].filter((id) => handles.has(id));
  // The members really mentioned come first among equal names: their name is not an untagged one.
  const entries = nameEntries(ids, names, (id) => ({ handle: handles.get(id), mentioned: mentioned.has(id) })).sort(
    (a, b) => b.name.length - a.name.length || Number(b.mentioned) - Number(a.mentioned),
  );
  const found = [];
  outsideUrls(text, (part) => {
    for (let at = part.indexOf('@'); at !== -1; at = part.indexOf('@', at + 1)) {
      const entry = nameAt(part, at, entries, true);
      if (!entry || entry.mentioned || found.some((hit) => hit.id === entry.id)) continue;
      found.push({ name: part.slice(at + 1, at + 1 + entry.name.length), id: entry.id, handle: entry.handle });
    }
    return part;
  });
  return found;
}
