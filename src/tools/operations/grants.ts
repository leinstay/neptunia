// The owner check, and the persona's grants keyed by operation name: a pure decision over `config.bot.access`, the
// shape `access.grant|revoke|list` (src/tools/operations/access.ts) read and write. A grant is
// `{ users: [<her id>], via? }`; `via` names the group or `*` her id came from (`user:<id>` -> the pattern), only so
// `access list` can say where a grant came from. A write of a key stores that shape alone, so a stored `everyone` or
// `roles` leaves with the next write of its key.

import { idText, listOf, objOf } from '../types.ts';
import type { Access, GrantEntry, GrantTarget, Obj } from '../types.ts';

/** What the owner check reads about the caller's account, on the interface of the current event or turn. */
export type OwnerAccounts = {
  /** True when the owner bound the account `native` to `person`. */
  isBoundTo(person: string, native: string): boolean;
};

let ownerAccounts: OwnerAccounts | null = null;

/**
 * Installs the reader behind the owner check and returns its removal. The core does this once, since the check runs
 * under every operation, tool call and private-chat gate of the process, each of which knows only the live config.
 */
export function useOwnerAccounts(accounts: OwnerAccounts): () => void {
  ownerAccounts = accounts;
  return () => {
    if (ownerAccounts === accounts) ownerAccounts = null;
  };
}

/** `bot.ownerPerson` of the live config, or null while it is unset. */
export function ownerPersonOf(config: unknown): string | null {
  const person = idText(objOf(objOf(config).bot).ownerPerson);
  return person === '' ? null : person;
}

/**
 * The one owner check of the owner commands and the private-chat gate: the caller is the owner when the owner bound
 * the caller's account, by `/memory bind`, to the meta-person `bot.ownerPerson` names. Nobody is while
 * that setting is unset or the accounts cannot be read, and no user is the owner. `config` is the live merged config
 * (hot.config).
 */
export function isOwnerId(config: unknown, accountId: unknown): boolean {
  const person = ownerPersonOf(config);
  if (idText(accountId) === '' || person === null) return false;
  return ownerAccounts?.isBoundTo(person, idText(accountId)) === true;
}

/**
 * True when the caller of an operation is an owner: the owner's console (`context.asOwner`, which only the command
 * desk sets, for the `cli` principal) or a user `isOwnerId` accepts. The owner check of every operation that
 * shows or does more for an owner.
 */
export function isOwnerCaller(
  config: unknown,
  context: { accountId?: unknown; asOwner?: unknown } | null | undefined
): boolean {
  return context?.asOwner === true || isOwnerId(config, context?.accountId);
}

/**
 * The tools merged into another, old name to current name: a stored grant or envelope entry under the old name stands for
 * the current tool. The six narrow reads of one subject stay the owner's tools under their own names, and a grant of
 * any of them opens her memory.read.
 */
const MERGED_INTO: Readonly<Record<string, string>> = Object.freeze({
  'memory.affinity.read': 'memory.profile.read',
  'errand.status': 'errand.list',
  'memory.profile.read': 'memory.read',
  'memory.channel.read': 'memory.read',
  'memory.server.read': 'memory.read',
  'memory.recent.read': 'memory.read',
  'lore.list': 'memory.read',
  'lore.show': 'memory.read',
});

/** The names a stored grant or envelope entry may use for `name`: itself and every tool merged into it, at any depth. */
export function grantNamesFor(name: string): Array<string> {
  const names = [name];
  for (let i = 0; i < names.length; i += 1)
    for (const old of Object.keys(MERGED_INTO))
      if (MERGED_INTO[old] === names[i] && !names.includes(old)) names.push(old);
  return names;
}

/** The `via` key of one grant target: `user:<id>`, or null for none. */
function targetKey({ accountId }: GrantTarget = {}): string | null {
  return accountId == null ? null : `user:${accountId}`;
}

/** `access[key]`, normalized to `{ users, via }` with a fresh array and a fresh `via` (never the caller's own). */
function entryOf(access: unknown, key: string): GrantEntry {
  const raw = objOf(objOf(access)[key]);
  return { users: [...listOf(raw.users)], via: { ...objOf(raw.via) } };
}

/** `entry` as stored: `via` only when it names something. */
function stored(entry: GrantEntry): Obj {
  const { via, users } = entry;
  return Object.keys(via).length > 0 ? { users, via } : { users };
}

/** True when `entry` already holds the id `what` names. */
function holds(entry: GrantEntry, { accountId }: GrantTarget = {}): boolean {
  return accountId != null && entry.users.map(idText).includes(idText(accountId));
}

/**
 * `access` with `key`'s grant widened by `{ accountId }`, never mutating `access`. Adding an id already present
 * changes nothing, except that a direct grant (no `from`) of an id that came from a group or `*` makes it direct.
 * `from` (the group or `*` this grant was expanded from) is kept for `access.list`; it never replaces a direct grant.
 * `key` is used as given (see src/tools/operations/access.ts#expandPersonaGrant).
 */
export function grant(
  access: unknown,
  key: string,
  what: GrantTarget = {},
  { from = null }: { from?: string | null } = {}
): Access {
  const next = entryOf(access, key);
  const target = targetKey(what);
  const had = holds(next, what);
  if (what.accountId != null && !had) next.users.push(idText(what.accountId));
  if (target) {
    if (!from) delete next.via[target];
    else if (!had) next.via[target] = from;
  }
  return { ...objOf(access), [key]: stored(next) };
}

/**
 * `access` with `{ accountId }` removed from `key`'s grant, its source with it, never mutating `access`. An entry
 * left with no user is deleted outright. Revoking an id not present, or from a key with no entry, changes nothing.
 */
export function revoke(access: unknown, key: string, what: GrantTarget = {}): Access {
  if (!objOf(access)[key] || !holds(entryOf(access, key), what)) return { ...objOf(access) };

  const next = entryOf(access, key);
  const id = idText(what.accountId);
  next.users = next.users.filter((u) => idText(u) !== id);
  const target = targetKey(what);
  if (target) delete next.via[target];

  const out: Access = { ...objOf(access) };
  if (next.users.length === 0) delete out[key];
  else out[key] = stored(next);
  return out;
}

/**
 * True when `key`'s grant lists the id `{ accountId }` names, compared as a string: whether `revoke` with the same
 * arguments would change anything.
 */
export function hasGrant(access: unknown, key: string, what: GrantTarget = {}): boolean {
  if (!objOf(access)[key]) return false;
  return holds(entryOf(access, key), what);
}
