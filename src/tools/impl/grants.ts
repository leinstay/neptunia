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

/** True when `owners` (ids, numbers or strings) lists `userId`; ids compared as strings. */
function listsOwner(owners, userId) {
  if (userId === undefined || userId === null) return false;
  return (Array.isArray(owners) ? owners : []).map(String).includes(String(userId));
}

/**
 * True when `userId` is one of `config.bot.owners`: the one owner check of the owner commands
 * (src/admin.js, src/tools/impl/index.ts) and of `isAllowed` below. No user, no owner.
 * @param {object} config  The live merged config (hot.config).
 * @param {unknown} userId
 * @returns {boolean}
 */
export function isOwnerId(config, userId) {
  return listsOwner(config?.bot?.owners, userId);
}

/**
 * True when a grant may ever open `op`: not owner-only, not `grantable: false`, not a member
 * operation (open without a grant).
 * @param {{ rights?: object } | null | undefined} op
 * @returns {boolean}
 */
export function isGrantableOp(op) {
  const rights = op?.rights;
  return Boolean(rights) && rights.ownerOnly !== true && rights.grantable !== false && rights.member !== true;
}

/**
 * True when the caller may run `op`. Order: an owner passes; an `ownerOnly` or `grantable: false`
 * operation refuses everyone else, `*` included; a `member` operation passes anyone while
 * `features.memberCommands` is not false (read by the caller at the moment of use), else only an
 * owner; anything else passes on a grant stored on the exact operation name (everyone, one of the
 * caller's roles, or the caller). No descriptor or an access that is not an object: refused.
 * @param {{ op: { name: string, rights: object } | null, member?: { userId?: string, roleIds?: (string|number)[] },
 *   access?: object, owners?: (string|number)[], features?: object }} args
 * @returns {boolean}
 */
export function isAllowed({ op, member, access, owners, features }) {
  const userId = member?.userId;
  if (listsOwner(owners, userId)) return true;

  const rights = op?.rights;
  if (!rights || typeof op.name !== 'string') return false;
  if (rights.ownerOnly === true) return false;
  if (rights.member === true) return features?.memberCommands !== false;
  if (rights.grantable === false) return false;
  if (!access || typeof access !== 'object' || Array.isArray(access)) return false;

  const entry = access[op.name];
  if (!entry || typeof entry !== 'object') return false;
  if (entry.everyone === true) return true;
  if (Array.isArray(entry.users) && entry.users.map(String).includes(String(userId))) return true;
  const roleSet = new Set((Array.isArray(member?.roleIds) ? member.roleIds : []).map(String));
  return Array.isArray(entry.roles) && entry.roles.some((roleId) => roleSet.has(String(roleId)));
}

/**
 * What a grant of `key` stores, against the operations that exist now (`ops`, as
 * src/tools/impl/registry.ts#listOps gives them): an operation name is itself (`names`) or, when no
 * grant may open it, `refused`; a group (a whole dotted prefix of some operation, `memory`,
 * `memory.affinity`) or `*` is every grantable READ operation under it, with `from` the pattern.
 * Null when `key` names nothing.
 * @param {string} key
 * @param {{ name: string, rights: object }[]} ops
 * @returns {{ from: string|null, names: string[], refused: string[] } | null}
 */
export function expandGrant(key, ops) {
  const list = Array.isArray(ops) ? ops : [];
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
function targetKey({ everyone, roleId, userId } = {}) {
  if (everyone) return 'everyone';
  if (roleId != null) return `role:${roleId}`;
  if (userId != null) return `user:${userId}`;
  return null;
}

/** `access[key]`, normalized to `{ everyone, roles, users, via }` with fresh arrays and a fresh `via` (never the caller's own). */
function entryOf(access, key) {
  const raw = access?.[key];
  const via = raw?.via && typeof raw.via === 'object' && !Array.isArray(raw.via) ? { ...raw.via } : {};
  return {
    everyone: raw?.everyone === true,
    roles: Array.isArray(raw?.roles) ? [...raw.roles] : [],
    users: Array.isArray(raw?.users) ? [...raw.users] : [],
    via,
  };
}

/** `entry` as stored: `via` only when it names something. */
function stored(entry) {
  const { via, ...rest } = entry;
  return Object.keys(via).length > 0 ? { ...rest, via } : rest;
}

/** True when `entry` already holds the target `what` names. */
function holds(entry, { everyone, roleId, userId } = {}) {
  if (everyone) return entry.everyone;
  if (roleId != null) return entry.roles.map(String).includes(String(roleId));
  if (userId != null) return entry.users.map(String).includes(String(userId));
  return false;
}

/**
 * `access` with `key`'s grant widened by exactly one of `{ everyone: true }`, `{ roleId }` or
 * `{ userId }` -- never mutates `access`. Adding a target already present is a no-op, except
 * that a direct grant (no `from`) of a target that came from a group or `*` makes it direct.
 * `from` (the group or `*` this grant was expanded from) is kept for `describeGrants`; it never
 * replaces a direct grant. `key` is used as given (see `expandGrant`).
 * @param {object} access
 * @param {string} key
 * @param {{ everyone?: boolean, roleId?: (string|number), userId?: (string|number) }} what
 * @param {{ from?: string|null }} [options]
 * @returns {object}
 */
export function grant(access, key, what = {}, { from = null } = {}) {
  const next = entryOf(access, key);
  const target = targetKey(what);
  const had = holds(next, what);
  if (what.everyone) {
    next.everyone = true;
  } else if (what.roleId != null) {
    const id = String(what.roleId);
    if (!next.roles.map(String).includes(id)) next.roles.push(id);
  } else if (what.userId != null) {
    const id = String(what.userId);
    if (!next.users.map(String).includes(id)) next.users.push(id);
  }
  if (target) {
    if (!from) delete next.via[target];
    else if (!had) next.via[target] = from;
  }
  return { ...(access ?? {}), [key]: stored(next) };
}

/**
 * `access` with exactly one of `{ everyone: true }`, `{ roleId }` or `{ userId }` removed from
 * `key`'s grant, its source with it -- never mutates `access`. An entry left with nothing set is
 * deleted outright. Revoking something not present, or from a key with no entry, is a no-op.
 * @param {object} access
 * @param {string} key
 * @param {{ everyone?: boolean, roleId?: (string|number), userId?: (string|number) }} what
 * @returns {object}
 */
export function revoke(access, key, what = {}) {
  if (!access?.[key]) return { ...(access ?? {}) };

  const next = entryOf(access, key);
  if (what.everyone) {
    next.everyone = false;
  } else if (what.roleId != null) {
    const id = String(what.roleId);
    next.roles = next.roles.filter((r) => String(r) !== id);
  } else if (what.userId != null) {
    const id = String(what.userId);
    next.users = next.users.filter((u) => String(u) !== id);
  }
  const target = targetKey(what);
  if (target) delete next.via[target];

  const out = { ...(access ?? {}) };
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
 * @param {object} access
 * @param {string} key
 * @param {{ everyone?: boolean, roleId?: (string|number), userId?: (string|number) }} what
 * @returns {boolean}
 */
export function hasGrant(access, key, what = {}) {
  if (!access?.[key]) return false;
  return holds(entryOf(access, key), what);
}

/** Every target `entry` holds, as `grant`'s `what` argument. */
function targetsOf(entry) {
  const out = [];
  if (entry.everyone) out.push({ everyone: true });
  for (const roleId of entry.roles) out.push({ roleId: String(roleId) });
  for (const userId of entry.users) out.push({ userId: String(userId) });
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
 * @param {{ access: object, ops: { name: string, rights: object }[],
 *   legacy: (key: string) => ({ from: string|null, names: string[] } | null) }} args
 * @returns {{ access: object, report: { key: string, covers: string[], dropped: string[] }[], note: string }}
 */
export function migrateGrants({ access, ops, legacy }) {
  const list = Array.isArray(ops) ? ops : [];
  const byName = new Map(list.map((op) => [op.name, op]));
  let next = {};
  const report = [];
  const source = access && typeof access === 'object' && !Array.isArray(access) ? access : {};

  for (const [key, raw] of Object.entries(source)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = entryOf(source, key);
    if (byName.has(key)) {
      const op = byName.get(key);
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
    const covers = names.filter(
      (name) => isGrantableOp(byName.get(name)) && (!from || byName.get(name).rights.kind === 'read')
    );
    // A member operation is open without a grant: nothing is lost, so it is not named as dropped.
    const dropped = mapped
      ? names.filter((name) => !isGrantableOp(byName.get(name)) && byName.get(name).rights.member !== true)
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

/** `incoming` (an already-migrated entry) merged over `current`, its sources kept. */
function mergeEntry(current, incoming) {
  const base = entryOf({ e: current }, 'e');
  const roles = [...new Set([...base.roles, ...incoming.roles].map(String))];
  const users = [...new Set([...base.users, ...incoming.users].map(String))];
  return stored({ everyone: base.everyone || incoming.everyone, roles, users, via: { ...incoming.via, ...base.via } });
}

/**
 * One line per stored grant on a grantable operation that exists, or on a key of `alsoKeys` (the
 * persona's skills no person may hold, src/tools/impl/access.ts); stale keys and owner-only ones open
 * nothing for a person and are left out: `<op>: everyone, role id:<id>, user id:<id>`, a target
 * that came from a group or `*` followed by `(expanded from <pattern>, reads only)`.
 * @param {object} access
 * @param {{ name: string, rights: object }[]} ops
 * @param {{ alsoKeys?: string[] }} [options]
 * @returns {string[]}
 */
export function describeGrants(access, ops, { alsoKeys = [] } = {}) {
  const byName = new Map((Array.isArray(ops) ? ops : []).map((op) => [op.name, op]));
  const source = access && typeof access === 'object' && !Array.isArray(access) ? access : {};
  return Object.keys(source)
    .filter(
      (key) =>
        (isGrantableOp(byName.get(key)) || alsoKeys.includes(key)) && source[key] && typeof source[key] === 'object'
    )
    .map((key) => {
      const entry = entryOf(source, key);
      const label = (text, what) => {
        const from = entry.via[targetKey(what)];
        return from ? `${text} (expanded from ${from}, reads only)` : text;
      };
      const parts = [];
      if (entry.everyone) parts.push(label('everyone', { everyone: true }));
      for (const id of entry.roles) parts.push(label(`role id:${id}`, { roleId: id }));
      for (const id of entry.users) parts.push(label(`user id:${id}`, { userId: id }));
      return `${key}: ${parts.join(', ')}`;
    });
}
