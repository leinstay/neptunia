// Owner-managed access grants, keyed by operation name (src/tools/impl/registry.ts): a pure decision
// over `config.bot.access`, the shape `/nep access grant|revoke|list` (src/tools/impl/access.ts) read
// and write. An owner (`bot.owners`) always passes. Then the operation's own rights decide:
// `ownerOnly` or `grantable: false` refuse everyone else whatever is stored, `*` included; a
// `member` operation is open to every member while `features.memberCommands` is on; anything
// else needs a grant stored on its exact name. A grant on a group (`memory`) or on `*` is never
// stored as such: `expandGrant` turns it, at grant time, into the grantable READ operations that
// exist then, one entry each, so a later operation (and every write) stays closed until it is
// granted by name. A grant is `{ everyone, roles: [], users: [], via? }`; `via` names the group
// or `*` a target came from (`everyone`, `role:<id>`, `user:<id>` -> the pattern), only so
// `access list` can say where a right came from. `migrateGrants` re-expands the old command-key
// grants under the operation names once (src/tools/impl/access.ts#migrateStoredGrants).

import { idText, isObj, listOf, objOf } from '../types.ts';
import type { Access, GrantEntry, GrantTarget, Obj, OpInfo } from '../types.ts';

/** True when `owners` (ids, numbers or strings) lists `userId`; ids compared as strings. */
function listsOwner(owners: unknown, userId: unknown): boolean {
  if (userId === undefined || userId === null) return false;
  return listOf(owners).map(idText).includes(idText(userId));
}

/**
 * True when `userId` is one of `config.bot.owners`: the one owner check of the owner commands
 * (src/admin.js, src/tools/impl/index.ts) and of `isAllowed` below. No user, no owner. `config` is the live merged
 * config (hot.config).
 */
export function isOwnerId(config: unknown, userId: unknown): boolean {
  return listsOwner(objOf(objOf(config).bot).owners, userId);
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
 * True when the caller may run `op`. Order: an owner passes; an `ownerOnly` or `grantable: false`
 * operation refuses everyone else, `*` included; a `member` operation passes anyone while
 * `features.memberCommands` is not false (read by the caller at the moment of use), else only an
 * owner; anything else passes on a grant stored on the exact operation name (everyone, one of the
 * caller's roles, or the caller). No descriptor or an access that is not an object: refused.
 */
export function isAllowed({
  op,
  member,
  access,
  owners,
  features,
}: {
  op: Partial<OpInfo> | null | undefined;
  member?: { userId?: unknown; roleIds?: ReadonlyArray<unknown> };
  access?: unknown;
  owners?: unknown;
  features?: unknown;
}): boolean {
  const userId = member?.userId;
  if (listsOwner(owners, userId)) return true;

  const rights = op?.rights;
  if (rights === undefined || typeof op?.name !== 'string') return false;
  if (rights.ownerOnly === true) return false;
  if (rights.member === true) return objOf(features).memberCommands !== false;
  if (rights.grantable === false) return false;
  if (!isObj(access)) return false;

  const entry = access[op.name];
  if (!isObj(entry)) return false;
  if (entry.everyone === true) return true;
  if (Array.isArray(entry.users) && entry.users.map(idText).includes(idText(userId))) return true;
  const roleSet = new Set(listOf(member?.roleIds).map(idText));
  return Array.isArray(entry.roles) && entry.roles.some((roleId) => roleSet.has(idText(roleId)));
}

/**
 * What a grant of `key` stores, against the operations that exist now (`ops`, as
 * src/tools/impl/registry.ts#listOps gives them): an operation name is itself (`names`) or, when no
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
function targetKey({ everyone, roleId, userId }: GrantTarget = {}): string | null {
  if (everyone) return 'everyone';
  if (roleId != null) return `role:${roleId}`;
  if (userId != null) return `user:${userId}`;
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
function holds(entry: GrantEntry, { everyone, roleId, userId }: GrantTarget = {}): boolean {
  if (everyone) return entry.everyone;
  if (roleId != null) return entry.roles.map(idText).includes(idText(roleId));
  if (userId != null) return entry.users.map(idText).includes(idText(userId));
  return false;
}

/**
 * `access` with `key`'s grant widened by exactly one of `{ everyone: true }`, `{ roleId }` or
 * `{ userId }` -- never mutates `access`. Adding a target already present is a no-op, except
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
  } else if (what.userId != null) {
    const id = idText(what.userId);
    if (!next.users.map(idText).includes(id)) next.users.push(id);
  }
  if (target) {
    if (!from) delete next.via[target];
    else if (!had) next.via[target] = from;
  }
  return { ...objOf(access), [key]: stored(next) };
}

/**
 * `access` with exactly one of `{ everyone: true }`, `{ roleId }` or `{ userId }` removed from
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
  } else if (what.userId != null) {
    const id = idText(what.userId);
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
 * or `{ userId }`, ids compared as strings) -- whether `revoke` with the same arguments would
 * change anything.
 */
export function hasGrant(access: unknown, key: string, what: GrantTarget = {}): boolean {
  if (!objOf(access)[key]) return false;
  return holds(entryOf(access, key), what);
}

/** Every target `entry` holds, as `grant`'s `what` argument. */
function targetsOf(entry: GrantEntry): Array<GrantTarget> {
  const out: Array<GrantTarget> = [];
  if (entry.everyone) out.push({ everyone: true });
  for (const roleId of entry.roles) out.push({ roleId: idText(roleId) });
  for (const userId of entry.users) out.push({ userId: idText(userId) });
  return out;
}

/**
 * The stored grants re-expanded under the operation names, once (the old ones were keyed by
 * slash-command key, matched by group and `*` at check time). Per stored key: an operation name
 * stays as it is (dropped when no grant may open it); otherwise `legacy(key)` -- the operations
 * the old key ran (`from` null) or, for an old group or `*`, every operation under it (`from` the
 * pattern) -- decides: an old exact key keeps every grantable operation it ran, read or write; an
 * old group or `*` keeps only the grantable READ ones; whatever is owner-only, or a key that runs
 * no operation any more, is dropped and named. Pure; running it again on its result changes nothing.
 */
export function migrateGrants({
  access,
  ops,
  legacy,
}: {
  access: unknown;
  ops: ReadonlyArray<OpInfo>;
  legacy: ((key: string) => { from: string | null; names: Array<string> } | null) | null;
}): { access: Access; report: Array<GrantReport>; note: string } {
  const list = ops;
  const byName = new Map(list.map((op) => [op.name, op]));
  let next: Access = {};
  const report: Array<GrantReport> = [];
  const source = objOf(access);
  /** The operation `name` of the list; a name taken from `byName` always has one. */
  const opOf = (name: string): OpInfo => byName.get(name) ?? { name, rights: { kind: 'write', ownerOnly: true } };

  for (const [key, raw] of Object.entries(source)) {
    if (!isObj(raw)) continue;
    const entry = entryOf(source, key);
    if (byName.has(key)) {
      const op = opOf(key);
      if (isGrantableOp(op)) {
        next = { ...next, [key]: mergeEntry(next[key], entry) };
        report.push({ key, covers: [key], dropped: [] });
      } else {
        report.push({ key, covers: [], dropped: op.rights.member === true ? [] : [key] });
      }
      continue;
    }
    const mapped = typeof legacy === 'function' ? legacy(key) : null;
    const names = [...new Set(mapped?.names ?? [])].filter((name) => byName.has(name));
    const from = mapped?.from ?? null;
    const covers = names.filter((name) => isGrantableOp(opOf(name)) && (!from || opOf(name).rights.kind === 'read'));
    // A member operation is open without a grant: nothing is lost, so it is not named as dropped.
    const dropped = mapped
      ? names.filter((name) => !isGrantableOp(opOf(name)) && opOf(name).rights.member !== true)
      : [key];
    for (const name of covers) {
      for (const what of targetsOf(entry)) next = grant(next, name, what, { from });
    }
    report.push({ key, covers, dropped });
  }

  const note = report
    .map(({ key, covers, dropped }) => {
      const head = `${key} -> ${covers.length ? covers.join(', ') : 'nothing'}`;
      return dropped.length ? `${head}; dropped (owner-only): ${dropped.join(', ')}` : head;
    })
    .join(' | ');
  return { access: next, report, note };
}

/** What the migration did with one stored key: the operations it now covers and the ones it dropped. */
export type GrantReport = { key: string; covers: Array<string>; dropped: Array<string> };

/** `incoming` (an already-migrated entry) merged over `current`, its sources kept. */
function mergeEntry(current: unknown, incoming: GrantEntry): Obj {
  const base = entryOf({ e: current }, 'e');
  const roles = [...new Set([...base.roles, ...incoming.roles].map(idText))];
  const users = [...new Set([...base.users, ...incoming.users].map(idText))];
  return stored({ everyone: base.everyone || incoming.everyone, roles, users, via: { ...incoming.via, ...base.via } });
}

/**
 * One line per stored grant on a grantable operation that exists, or on a key of `alsoKeys` (the
 * persona's skills no person may hold, src/tools/impl/access.ts); stale keys and owner-only ones open
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
      for (const id of entry.users) parts.push(label(`user id:${idText(id)}`, { userId: idText(id) }));
      return `${key}: ${parts.join(', ')}`;
    });
}
