// The names a turn turns into mentions and the profiles it shows: `@name` written by the model resolved against the
// people the request showed and the root's directory, the stored names that count, the profiles of the people
// most recently active, the note on tags that went nowhere, and whom a message notifies under each member's ping state.
// src/behavior/turn.ts calls them while it renders a post and builds a request, and her `message.create`
// (src/tools/operations/message.ts) asks mentionsUnderPings too. The replay sandbox (src/behavior/sandbox.ts) reads
// pickOtherProfiles through its re-export.

import { accountOf } from '../memory/addresses.ts';
import { untaggedNames } from '../behavior/handles.ts';
import { fill } from '../format.ts';
import { outsideUrls } from '../memory/mentions.ts';
import { listOf, objOf } from '../tools/types.ts';
import type { PingState } from '../memory/pings.ts';
import type { Mentions } from '../protocol/actions.ts';

/** A member id as the sources give it. */
type Id = string | number;

/** A name and the member it belongs to. */
export type NamedMember = { name: string; id: string };

/** A line of the history, as far as the mention matching reads it. */
type MentionLine = { self?: boolean; bot?: boolean; authorName?: string | null; authorId?: string };

/**
 * The name matching of features.mentionHandles off (kept for rollback; with it on, renderPost
 * resolves only `@handle`, src/behavior/handles.ts#resolveHandles).
 * Turn `@nick` written by the model into real mentions for people the request showed: the
 * authors of `history` (the lines shown), then the stored names in `knownNames` (the members
 * whose profile the request showed, the authors of the pulled lines shown). A transcript
 * author wins a name a stored profile shares, the last author of a display name wins, and of
 * two stored profiles sharing a name the first handed over wins. Longer names are matched
 * first, so a multi-word name is never cut at a shorter one it starts with. A URL in the text
 * is left exactly as written (src/memory/mentions.ts#outsideUrls).
 * What is left falls back to `directory` (mentionDirectory: every member of the served place
 * the bot knows): matched case-insensitively, longest first, only as a whole name (no letter,
 * digit or underscore right after it); a name one of the request's own sources gives in any
 * case keeps that member, any other resolves only when exactly one member carries it, and a
 * name two or more members share stays text.
 * `history` holds normalized lines (`authorName`, `authorId`, `self`, `bot`); `accountIds` are the members pinged
 * (allowedMentions).
 */
export function resolveMentions(
  text: string,
  history: Iterable<MentionLine>,
  knownNames: Iterable<{ name: unknown; id: Id | null | undefined }> = [],
  directory: Iterable<{ name: unknown; id: Id | null | undefined } | null | undefined> = []
): { text: string; accountIds: Array<string | undefined> } {
  const people = new Map<string, string | undefined>();
  for (const { name, id } of knownNames) {
    if (typeof name !== 'string' || !name.trim() || id === undefined || id === null || people.has(name)) continue;
    people.set(name, String(id));
  }
  for (const message of history) {
    if (!message.self && message.authorName) people.set(message.authorName, message.authorId);
  }
  const names = [...people.keys()].sort((a, b) => b.length - a.length);
  const fallback = fallbackNames(people, directory);
  const accountIds = new Set<string | undefined>();
  // An `@name` inside a URL (a channel handle on a video site) is part of the address.
  const resolved = outsideUrls(text, (part) => {
    let out = part;
    for (const name of names) {
      if (!out.includes(`@${name}`)) continue;
      out = out.replaceAll(`@${name}`, `<@${people.get(name)}>`);
      accountIds.add(people.get(name));
    }
    return fallback.size > 0 ? resolveFallback(out, fallback, accountIds) : out;
  });
  return { text: resolved, accountIds: [...accountIds] };
}

/**
 * The fallback's case-folded names (resolveMentions) → the one member each resolves to, or
 * null when it stays text: a name the request's own sources (`people`, the request's own names → member ids) give
 * in any case keeps their member (null when they give it to two), else the one directory member carrying it
 * (null when two or more do).
 */
function fallbackNames(
  people: Map<string, string | undefined>,
  directory: Iterable<{ name: unknown; id: Id | null | undefined } | null | undefined>
): Map<string, string | null> {
  const idsOf = (pairs: Iterable<[unknown, Id | null | undefined]>) => {
    const byKey = new Map<string, Set<string>>();
    for (const [name, id] of pairs) {
      if (typeof name !== 'string' || !name.trim() || id === undefined || id === null) continue;
      const key = name.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, new Set());
      byKey.get(key)?.add(String(id));
    }
    return byKey;
  };
  const listed = idsOf([...directory].map((entry): [unknown, Id | null | undefined] => [entry?.name, entry?.id]));
  if (listed.size === 0) return new Map();
  const shown = idsOf(people);
  const fallback = new Map<string, string | null>();
  for (const [key, ids] of listed) {
    const owners = shown.get(key) ?? ids;
    fallback.set(key, owners.size === 1 ? [...owners][0] : null);
  }
  return fallback;
}

/**
 * `part` (outside URLs, after the exact pass) with every whole `@name` of `fallback` that
 * resolves turned into a mention, longest first; the members mentioned are added to `accountIds`.
 * A mention already made (`<@id>`) is never matched again.
 */
function resolveFallback(
  part: string,
  fallback: Map<string, string | null>,
  accountIds: Set<string | undefined>
): string {
  const lower = part.toLowerCase();
  const candidates = [...fallback.keys()].filter((key) => fallback.get(key) !== null && lower.includes(`@${key}`));
  if (candidates.length === 0) return part;
  candidates.sort((a, b) => b.length - a.length);
  const escaped = candidates.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(?<!<)@(?:${escaped.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  return part.replace(pattern, (match) => {
    const id = fallback.get(match.slice(1).toLowerCase());
    if (!id) return match;
    accountIds.add(id);
    return `<@${id}>`;
  });
}

/** A member of the directory, as the interface reported it. */
type DirectoryMember = {
  id?: Id | null;
  name?: unknown;
  displayName?: unknown;
  nickname?: unknown;
  bot?: unknown;
  user?: { id?: Id | null; bot?: unknown; globalName?: unknown; username?: unknown } | null;
};

/** A stored profile, as far as the directory reads it. */
type DirectoryProfile = { id?: Id | null; names?: unknown; aliases?: unknown };

/**
 * The fallback directory `@name` resolves by after the request's own sources (resolveMentions):
 * every name of every member of the served root the core knows without asking the interface --
 * the member directory (`members`: `{ id, name, bot }` as `membership.changed` reported them, a member's
 * other names too when the record carries them) and the stored profiles (`profiles`: names and aliases,
 * store.listUserProfiles).
 * Never the persona herself (`selfId`).
 */
export function mentionDirectory({
  members = [],
  profiles = [],
  selfId = null,
}: {
  members?: Iterable<unknown>;
  profiles?: Iterable<unknown>;
  selfId?: string | null;
} = {}): Array<NamedMember> {
  const entries: Array<NamedMember> = [];
  const seen = new Set<string>();
  const self = selfId === null || selfId === undefined ? null : String(selfId);
  const add = (name: unknown, id: string) => {
    if (typeof name !== 'string' || !name.trim()) return;
    const key = `${id}\u0000${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ name, id });
  };
  const cached = [...members].filter(
    (member): member is DirectoryMember => Boolean(member) && typeof member === 'object'
  );
  const idOf = (member: DirectoryMember) => member.id ?? member.user?.id;
  const counts = (id: Id | null | undefined): boolean => id !== undefined && id !== null && String(id) !== self;
  for (const member of cached) {
    const id = idOf(member);
    if (!counts(id)) continue;
    for (const name of [
      member.name,
      member.displayName,
      member.nickname,
      member.user?.globalName,
      member.user?.username,
    ])
      add(name, String(id));
  }
  for (const entry of profiles) {
    if (!entry || typeof entry !== 'object') continue;
    const profile: DirectoryProfile = entry;
    if (!counts(profile.id)) continue;
    for (const name of listOf(profile.names)) add(name, String(profile.id));
    for (const alias of listOf(profile.aliases)) add(objOf(alias).name, String(profile.id));
  }
  return entries;
}

/** Whether a profile's `names` is a list (a stored profile may lack it). */
const isNameList = (names: ReadonlyArray<string> | null | undefined): names is ReadonlyArray<string> =>
  Array.isArray(names);

/**
 * The stored names `@name` may resolve by besides the transcript's display names (see
 * resolveMentions): every name of each member whose profile the request showed (`peopleShown`,
 * buildRequest's, in its order), then every stored name of each author of the pulled lines shown (`shownLines`) --
 * those lines carry the name the platform gave, often not the one the persona remembers them by. `profileOf` gives
 * the stored profile of a member, or null.
 */
export function storedNames(
  peopleShown: ReadonlyArray<{ id: string; names: ReadonlyArray<string> }> | null | undefined,
  shownLines: Iterable<{ self?: boolean; bot?: boolean; authorId?: string | null }>,
  profileOf: (accountId: string) => { names?: ReadonlyArray<string> | null } | null | undefined
): Array<NamedMember> {
  const known: Array<NamedMember> = [];
  for (const person of peopleShown ?? []) {
    for (const name of person.names) known.push({ name, id: person.id });
  }
  const authors = new Set<string>();
  for (const line of shownLines) {
    if (line.self || !line.authorId || authors.has(line.authorId)) continue;
    const authorId = line.authorId;
    authors.add(authorId);
    const names = profileOf(authorId)?.names;
    if (isNameList(names)) for (const name of names) known.push({ name, id: authorId });
  }
  return known;
}

/** The profiles of other people a request shows. Production value, config cut of 2026-10-31. */
const OTHER_PROFILES = 6;

/**
 * Profiles of the people most recently active in the transcript (at most `count`), excluding `exceptId`.
 * Also used by the replay sandbox (src/behavior/sandbox.ts) with a store-shaped reader.
 */
export function pickOtherProfiles<TProfile>(
  store: { getUser: (accountId: string | undefined) => TProfile | null | undefined },
  placeId: string,
  history: ReadonlyArray<{ self?: boolean; bot?: boolean; authorId?: string }>,
  exceptId: string | undefined,
  count: number = OTHER_PROFILES
): Array<TProfile> {
  const seen = new Set<string | undefined>();
  const profiles: Array<TProfile> = [];
  for (const message of [...history].reverse()) {
    if (message.self || message.authorId === exceptId || seen.has(message.authorId)) continue;
    seen.add(message.authorId);
    const profile = store.getUser(accountOf(store, String(message.authorId)));
    if (profile) profiles.push(profile);
    if (profiles.length >= count) break;
  }
  return profiles;
}

/**
 * What a post of hers tells her about the tags that went nowhere: one `labels.tools.result.untaggedNote`
 * (`{name}`, `{handle}`) per member whose name she wrote after `@` instead of their handle
 * (src/behavior/handles.ts#untaggedNames over the request's handles and names), joined by a space.
 * '' without handles (`handles`: handle -> member id), without the label or when nothing went nowhere. Pure.
 * `text` is the text as she wrote it.
 */
export function untaggedNote(
  text: string,
  {
    handles = null,
    memberNames = null,
    mentionedIds = [],
  }: {
    handles?: Map<string, string> | null;
    memberNames?: Map<string, Array<string>> | null;
    mentionedIds?: Array<string>;
  },
  labels?: { tools?: { result?: { untaggedNote?: unknown } } } | null
): string {
  const toolResults = labels?.tools?.result;
  const template = toolResults?.untaggedNote;
  if (typeof template !== 'string' || !template || !(handles instanceof Map) || !(memberNames instanceof Map))
    return '';
  const handleById = new Map([...handles].map(([handle, id]) => [String(id), handle]));
  return untaggedNames(text, { names: memberNames, handles: handleById, mentionedIds })
    .map((hit) => fill(template, { name: `@${hit.name}`, handle: hit.handle }))
    .join(' ');
}

/**
 * Who one of her messages notifies, under each member's own ping state (`stateOf`, store.getPings): every posting path
 * (a turn's messages, her `message.create`, a selfreflection entry) asks here. The message concerns the author it
 * replies to (`repliedAuthorId`, when `replying`) and every member it names (`users`). A member with `off` is left out
 * of `users` and gets no reply ping. `notify` is set, true, only when the message concerns someone and every one of
 * them has `on`. `asked` is set whenever the message concerns someone: the named members whose state is `on`, in the
 * order named, and whether the replied author's state is `on`. An interface that sends silently pings exactly those.
 */
export function mentionsUnderPings({
  users,
  repliedAuthorId = null,
  replying = true,
  stateOf,
}: {
  users: ReadonlyArray<string | null | undefined>;
  repliedAuthorId?: string | null;
  replying?: boolean;
  stateOf: (accountId: string) => PingState;
}): Mentions {
  const states = new Map<string, PingState>();
  const state = (id: string): PingState => {
    if (!states.has(id)) states.set(id, stateOf(id));
    return states.get(id) ?? null;
  };
  const named = users.filter((id): id is string => typeof id === 'string' && id !== '');
  const replied = replying && repliedAuthorId ? repliedAuthorId : null;
  const concerned = [...new Set([...(replied ? [replied] : []), ...named])];
  const notify = concerned.length > 0 && concerned.every((id) => state(id) === 'on');
  return {
    users: named.filter((id) => state(id) !== 'off'),
    repliedUser: replying && (replied === null || state(replied) !== 'off'),
    ...(notify ? { notify: true } : {}),
    ...(concerned.length > 0
      ? {
          asked: {
            users: named.filter((id) => state(id) === 'on'),
            repliedUser: replied !== null && state(replied) === 'on',
          },
        }
      : {}),
  };
}
