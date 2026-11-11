// Owner-managed access grants, keyed by operation name (src/tools/operations/registry.ts): a pure decision
// over `config.bot.access`, the shape `access.grant|revoke|list` (src/tools/operations/access.ts) read
// and write. An owner (`isOwnerId` below) always passes. Then the operation's own rights decide:
// `ownerOnly` or `grantable: false` refuse everyone else whatever is stored, `*` included; a
// `member` operation is open to every member while `features.memberCommands` is on; anything
// else needs a grant stored on its exact name. A grant on a group (`memory`) or on `*` is never
// stored as such: `expandGrant` turns it, at grant time, into the grantable READ operations that
// exist then, one entry each, so a later operation (and every write) stays closed until it is
// granted by name. A grant is `{ everyone, roles: [], users: [], via? }`; `via` names the group
// or `*` a target came from (`everyone`, `role:<id>`, `user:<id>` -> the pattern), only so
// `access list` can say where a right came from.

import { idText, isObj, listOf, objOf } from '../types.ts';
import type { Access, GrantEntry, GrantTarget, Obj, OpInfo } from '../types.ts';

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

/**
 * True when a grant may ever open `op`: not owner-only, not `grantable: false`, not a member
 * operation (open without a grant).
 */
export function isGrantableOp(op: Partial<OpInfo> | null | undefined): boolean {
  const rights = op?.rights;
  return rights !== undefined && rights.ownerOnly !== true && rights.grantable !== false && rights.member !== true;
}

/**
 * True when the caller may run `op`. Order: an account `owners` lists passes (src/tools/operations/rights.ts asks the
 * owner check first and lists none); an `ownerOnly` or `grantable: false`
 * operation refuses everyone else, `*` included; a `member` operation passes anyone; anything else passes on a grant stored on the exact operation name (everyone, one of the
 * caller's roles, or the caller). No descriptor or an access that is not an object: refused.
 */
export function isAllowed({
  op,
  member,
  access,
  owners,
}: {
  op: Partial<OpInfo> | null | undefined;
  member?: { accountId?: unknown; roleIds?: ReadonlyArray<unknown> };
  access?: unknown;
  owners?: unknown;
}): boolean {
  const accountId = member?.accountId;
  if (accountId != null && listOf(owners).map(idText).includes(idText(accountId))) return true;
  const rights = op?.rights;
  if (rights === undefined || typeof op?.name !== 'string') return false;
  if (rights.ownerOnly === true) return false;
  if (rights.member === true) return true;
  if (rights.grantable === false) return false;
  if (!isObj(access)) return false;

  const roleSet = new Set(listOf(member?.roleIds).map(idText));
  return grantNamesFor(op.name).some((key) => {
    const entry = access[key];
    if (!isObj(entry)) return false;
    if (entry.everyone === true) return true;
    if (Array.isArray(entry.users) && entry.users.map(idText).includes(idText(accountId))) return true;
    return Array.isArray(entry.roles) && entry.roles.some((roleId) => roleSet.has(idText(roleId)));
  });
}

/**
 * What a grant of `key` stores, against the operations that exist now (`ops`, as
 * src/tools/operations/registry.ts#listOps gives them): an operation name is itself (`names`) or, when no
 * grant may open it, `refused`; a group (a whole dotted prefix of some operation, `memory`,
 * `memory.affinity`) or `*` is every grantable READ operation under it, with `from` the pattern.
 * Null when `key` names nothing.
 */
export function expandGrant(
  key: string,
  ops: ReadonlyArray<OpInfo>
): { from: string | null; names: Array<string>; refused: Array<string> } | null {
  const list = ops;
  const exact = list.find((op) => op.name === key);
  if (exact)
    return isGrantableOp(exact) ? { from: null, names: [key], refused: [] } : { from: null, names: [], refused: [key] };
  const under =
    key === '*' ? list : list.filter((op) => typeof key === 'string' && key && op.name.startsWith(`${key}.`));
  if (under.length === 0) return null;
  return {
    from: key,
    names: under.filter((op) => isGrantableOp(op) && op.rights.kind === 'read').map((op) => op.name),
    refused: [],
  };
}

/** The `via` key of one grant target: `everyone`, `role:<id>` or `user:<id>`; null for none. */
function targetKey({ everyone, roleId, accountId }: GrantTarget = {}): string | null {
  if (everyone) return 'everyone';
  if (roleId != null) return `role:${roleId}`;
  if (accountId != null) return `user:${accountId}`;
  return null;
}

/** `access[key]`, normalized to `{ everyone, roles, users, via }` with fresh arrays and a fresh `via` (never the caller's own). */
function entryOf(access: unknown, key: string): GrantEntry {
  const raw = objOf(objOf(access)[key]);
  return {
    everyone: raw.everyone === true,
    roles: [...listOf(raw.roles)],
    users: [...listOf(raw.users)],
    via: { ...objOf(raw.via) },
  };
}

/** `entry` as stored: `via` only when it names something. */
function stored(entry: GrantEntry): Obj {
  const { via, ...rest } = entry;
  return Object.keys(via).length > 0 ? { ...rest, via } : rest;
}

/** True when `entry` already holds the target `what` names. */
function holds(entry: GrantEntry, { everyone, roleId, accountId }: GrantTarget = {}): boolean {
  if (everyone) return entry.everyone;
  if (roleId != null) return entry.roles.map(idText).includes(idText(roleId));
  if (accountId != null) return entry.users.map(idText).includes(idText(accountId));
  return false;
}

/**
 * `access` with `key`'s grant widened by exactly one of `{ everyone: true }`, `{ roleId }` or
 * `{ accountId }` -- never mutates `access`. Adding a target already present is a no-op, except
 * that a direct grant (no `from`) of a target that came from a group or `*` makes it direct.
 * `from` (the group or `*` this grant was expanded from) is kept for `describeGrants`; it never
 * replaces a direct grant. `key` is used as given (see `expandGrant`).
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
  if (what.everyone) {
    next.everyone = true;
  } else if (what.roleId != null) {
    const id = idText(what.roleId);
    if (!next.roles.map(idText).includes(id)) next.roles.push(id);
  } else if (what.accountId != null) {
    const id = idText(what.accountId);
    if (!next.users.map(idText).includes(id)) next.users.push(id);
  }
  if (target) {
    if (!from) delete next.via[target];
    else if (!had) next.via[target] = from;
  }
  return { ...objOf(access), [key]: stored(next) };
}

/**
 * `access` with exactly one of `{ everyone: true }`, `{ roleId }` or `{ accountId }` removed from
 * `key`'s grant, its source with it -- never mutates `access`. An entry left with nothing set is
 * deleted outright. Revoking something not present, or from a key with no entry, is a no-op.
 */
export function revoke(access: unknown, key: string, what: GrantTarget = {}): Access {
  if (!objOf(access)[key]) return { ...objOf(access) };

  const next = entryOf(access, key);
  if (what.everyone) {
    next.everyone = false;
  } else if (what.roleId != null) {
    const id = idText(what.roleId);
    next.roles = next.roles.filter((r) => idText(r) !== id);
  } else if (what.accountId != null) {
    const id = idText(what.accountId);
    next.users = next.users.filter((u) => idText(u) !== id);
  }
  const target = targetKey(what);
  if (target) delete next.via[target];

  const out: Access = { ...objOf(access) };
  if (!next.everyone && next.roles.length === 0 && next.users.length === 0) {
    delete out[key];
  } else {
    out[key] = stored(next);
  }
  return out;
}

/**
 * True when `key`'s grant holds the one thing `what` names (`{ everyone: true }`, `{ roleId }`
 * or `{ accountId }`, ids compared as strings) -- whether `revoke` with the same arguments would
 * change anything.
 */
export function hasGrant(access: unknown, key: string, what: GrantTarget = {}): boolean {
  if (!objOf(access)[key]) return false;
  return holds(entryOf(access, key), what);
}

/**
 * One line per stored grant on a grantable operation that exists, or on a key of `alsoKeys` (the
 * persona's skills no person may hold, src/tools/operations/access.ts); stale keys and owner-only ones open
 * nothing for a person and are left out: `<op>: everyone, role id:<id>, user id:<id>`, a target
 * that came from a group or `*` followed by `(expanded from <pattern>, reads only)`.
 */
export function describeGrants(
  access: unknown,
  ops: ReadonlyArray<OpInfo>,
  { alsoKeys = [] }: { alsoKeys?: ReadonlyArray<string> } = {}
): Array<string> {
  const byName = new Map(ops.map((op) => [op.name, op]));
  const source = objOf(access);
  return Object.keys(source)
    .filter((key) => (isGrantableOp(byName.get(key)) || alsoKeys.includes(key)) && isObj(source[key]))
    .map((key) => {
      const entry = entryOf(source, key);
      const label = (text: string, what: GrantTarget): string => {
        const target = targetKey(what);
        const from = target === null ? undefined : entry.via[target];
        return from ? `${text} (expanded from ${idText(from)}, reads only)` : text;
      };
      const parts: Array<string> = [];
      if (entry.everyone) parts.push(label('everyone', { everyone: true }));
      for (const id of entry.roles) parts.push(label(`role id:${idText(id)}`, { roleId: idText(id) }));
      for (const id of entry.users) parts.push(label(`user id:${idText(id)}`, { accountId: idText(id) }));
      return `${key}: ${parts.join(', ')}`;
    });
}
