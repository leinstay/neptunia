// The map of the offline conversion to places: what a storage key of a shipped database becomes, and what a stored scope and
// a stored JSON value lose. Pure; the rows and the files are src/memory/migration/convert.ts.

import type { StorageKey, StorageSelector } from '../db/storage-keys.ts';

/** The id of the persona's subject. */
export const PERSONA = { type: 'persona' as const, id: 'persona:local' };

/** The partition a direct chat with no community was kept under, and the scope of a line with none at all. */
const NO_COMMUNITY = 'no-community';

/** Collections of one persona, whatever server they were kept under. */
const PERSONA_KINDS = new Set(['diary', 'intentions', 'errands', 'inner']);
/** What stays with an account: its own profile, what it said in private, and the previous texts of its profile. */
const ACCOUNT_KINDS = new Set(['user', 'private', 'versions']);

export type MapFailure = { code: 'NO_DM_PLACE'; id: string };

/** The DM place of an account, from the stored rows. */
export type DmPlaceOf = (accountId: string) => string | null;

const fabricated = (id: string): boolean => id.endsWith(':guild:') || id.endsWith(`:guild:${NO_COMMUNITY}`);

function neutralSelector(selector: StorageSelector | undefined): StorageSelector | undefined {
  if (!selector) return undefined;
  const named = (selector as { versionKind?: string }).versionKind;
  return named === 'guild' ? { ...selector, versionKind: 'place' } : selector;
}

/** The neutral key of a stored one; `{ failure }` when an account's collection has no DM place to go to. */
export function neutralKey(old: StorageKey, dmPlaceOf: DmPlaceOf, unitId: string): StorageKey | MapFailure {
  const kind = (old.kind as string) === 'guild' ? 'place' : old.kind;
  const selector = neutralSelector(old.selector);
  const rest = { ...(old.partition ? { partition: old.partition } : {}), ...(selector ? { selector } : {}) };
  if (PERSONA_KINDS.has(kind)) return { kind, subject: PERSONA, ...rest };
  if (old.subject.type === 'persona') return { kind, subject: old.subject, ...rest };
  if (old.subject.type === 'account') {
    if (ACCOUNT_KINDS.has(kind)) return { kind, subject: old.subject, ...rest };
    const place = dmPlaceOf(old.subject.id);
    if (place === null) return { code: 'NO_DM_PLACE', id: unitId };
    return { kind, subject: { type: 'place', id: place }, ...rest };
  }
  if (old.subject.type === 'place' && fabricated(old.subject.id)) return { kind, subject: PERSONA, ...rest };
  return { kind, subject: old.subject, ...rest };
}

type Json = unknown;

/** A scope's new words: the place of a conversation, with no server named and no native member. */
export function neutralScope(
  scope: Record<string, Json>,
  key: StorageKey,
  iface: string,
  dmPlaceOf: DmPlaceOf
): Record<string, Json> {
  const { guild, user, private: isPrivate, ...rest } = scope;
  if (typeof user === 'string' && user) {
    const account = `${iface}:${user}`;
    const place = isPrivate === true || key.subject.type === 'place' ? dmPlaceOf(account) : null;
    if (place !== null && (isPrivate === true || key.subject.id === place)) return { ...rest, place, private: true };
    return { ...rest, user: account, ...(isPrivate === true ? { private: true } : {}) };
  }
  if (guild === true) return key.subject.type === 'place' ? { ...rest, place: key.subject.id } : rest;
  return scope;
}

const isRecord = (value: unknown): value is Record<string, Json> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * A state value with its diary's day plan under the persona: the newest of the plans its communities held, a plan already
 * under the persona winning a tie, with its done marks and its hunger as they were.
 */
export function personaDayPlan(state: Json): Json {
  if (!isRecord(state) || !isRecord(state.diary)) return state;
  const dayOf = (plan: Record<string, Json>): string => (typeof plan.day === 'string' ? plan.day : '');
  const { persona, ...others } = state.diary;
  let newest = isRecord(persona) ? persona : null;
  for (const plan of Object.values(others)) {
    if (isRecord(plan) && (newest === null || dayOf(plan) > dayOf(newest))) newest = plan;
  }
  return { ...state, diary: newest === null ? {} : { persona: newest } };
}

/** A stored JSON value with the old identifiers gone: no server named, `channelId` as `placeId`. */
export function neutralJson(value: Json): Json {
  if (typeof value === 'string') return value === 'channelId' ? 'placeId' : value === 'channelIds' ? 'placeIds' : value;
  if (Array.isArray(value)) return value.map(neutralJson);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, Json> = {};
  for (const [name, field] of Object.entries(value)) {
    if (name === 'guildId' || name === 'guildIds') continue;
    if (name === 'guild' && field === true) continue;
    if (name === 'channelId') out.placeId = neutralJson(field);
    else if (name === 'channelIds') out.placeIds = neutralJson(field);
    else out[name] = neutralJson(field);
  }
  return out;
}
