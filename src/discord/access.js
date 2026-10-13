// Owner-managed access grants: pure decision over `config.bot.access`, the
// shape `/nep access grant|revoke|list` (src/admin.js) read and write. An
// owner (`bot.owners`) always passes; everyone else needs a grant that
// matches the exact command key (`memory.show`), its group (`memory`), or
// `*`, in that order — any one match is enough, so precedence between the
// three never matters. A grant is `{ everyone, roles: [], users: [] }`;
// `grant`/`revoke` add or remove one thing from it immutably, and an entry
// left with nothing set is dropped entirely. Validating that a command key is
// one commands.js actually knows about is the caller's job (see
// src/discord/commands.js#commandKeys), not this module's — it only shapes
// and reads the grants it is given. The groups in OWNER_ONLY_GROUPS (private
// memory, the mentor, access management itself) are never opened by any
// grant, the `*` wildcard included: only an owner decides who may run what.
// The commands in MEMBER_COMMANDS (`pings`: a member's own notifications) are
// the opposite: open to every member with no grant, while
// `features.memberCommands` is on; off, only an owner runs them.

/** Command groups only an owner may ever run: no `bot.access` grant opens them. */
export const OWNER_ONLY_GROUPS = Object.freeze(['private', 'mentor', 'access', 'diary']);

/** Single commands only an owner may ever run, inside an otherwise grantable group: the
 * journal (`memory.journal`) holds the persona's hidden reasoning and every member's turns. */
export const OWNER_ONLY_COMMANDS = Object.freeze(['memory.journal']);

/** Bare command keys every member may run with no grant (a member's own settings), while
 * `features.memberCommands` is on. Never offered by `/nep access grant`. */
export const MEMBER_COMMANDS = Object.freeze(['pings']);

/** True when `key` is a member command (see MEMBER_COMMANDS): the exact bare key, nothing under it.
 * @param {unknown} key
 * @returns {boolean}
 */
export function isMemberCommand(key) {
  return typeof key === 'string' && MEMBER_COMMANDS.includes(key);
}

/** The group of a dotted command key (`memory` for `memory.show`), or null for a bare key or a non-string. */
function groupOf(key) {
  return typeof key === 'string' && key.includes('.') ? key.split('.')[0] : null;
}

/** True when `key` is an owner-only group (`private`, `mentor`, `access`) or a command in one (`private.show`).
 * @param {unknown} key
 * @returns {boolean}
 */
export function isOwnerOnly(key) {
  if (typeof key !== 'string' || !key) return false;
  if (OWNER_ONLY_COMMANDS.includes(key)) return true;
  return OWNER_ONLY_GROUPS.includes(groupOf(key) ?? key);
}

/** True when `owners` (ids, numbers or strings) lists `userId`; ids compared as strings. */
function listsOwner(owners, userId) {
  if (userId === undefined || userId === null) return false;
  return (Array.isArray(owners) ? owners : []).map(String).includes(String(userId));
}

/**
 * True when `userId` is one of `config.bot.owners`: the one owner check of the
 * owner commands (src/admin.js) and of `isAllowed` below. No user, no owner.
 * @param {object} config  The live merged config (hot.config).
 * @param {unknown} userId
 * @returns {boolean}
 */
export function isOwnerId(config, userId) {
  return listsOwner(config?.bot?.owners, userId);
}

/** True when `userId` (an owner, or matched by a grant on the exact command
 * key, its group, or `*`) may run `commandKey`. Owners always pass, even with
 * no `access` at all. A missing/invalid `access` denies everyone else, and
 * an owner-only command (see `isOwnerOnly`) denies everyone else whatever
 * `access` says. A member command (see `isMemberCommand`) passes for anyone
 * while `memberCommands` is true (`features.memberCommands`, read by the
 * caller at the moment of use); false, only an owner runs it, no grant.
 * @param {{ commandKey: string, userId: string, roleIds?: (string|number)[],
 *   owners?: (string|number)[], access?: object, memberCommands?: boolean }} args
 * @returns {boolean}
 */
export function isAllowed({ commandKey, userId, roleIds, owners, access, memberCommands = true }) {
  if (listsOwner(owners, userId)) return true;

  if (isMemberCommand(commandKey)) return memberCommands !== false;
  if (isOwnerOnly(commandKey)) return false;
  if (!access || typeof access !== 'object') return false;

  const candidates = [commandKey, groupOf(commandKey), '*'].filter((key) => typeof key === 'string' && key.length > 0);
  const roleSet = new Set((Array.isArray(roleIds) ? roleIds : []).map(String));

  for (const key of candidates) {
    const entry = access[key];
    if (!entry || typeof entry !== 'object') continue;
    if (entry.everyone === true) return true;
    if (Array.isArray(entry.users) && entry.users.map(String).includes(String(userId))) return true;
    if (Array.isArray(entry.roles) && entry.roles.some((roleId) => roleSet.has(String(roleId)))) return true;
  }

  return false;
}

/** `access[key]`, normalized to `{ everyone, roles, users }` with fresh arrays (never the caller's own). */
function entryOf(access, key) {
  const raw = access?.[key];
  return {
    everyone: raw?.everyone === true,
    roles: Array.isArray(raw?.roles) ? [...raw.roles] : [],
    users: Array.isArray(raw?.users) ? [...raw.users] : [],
  };
}

/**
 * `access` with `key`'s grant widened by exactly one of `{ everyone: true }`,
 * `{ roleId }` or `{ userId }` — never mutates `access`. Adding a role/user
 * already present is a no-op. `key` is used as given, not validated (see the
 * module header comment).
 * @param {object} access
 * @param {string} key
 * @param {{ everyone?: boolean, roleId?: (string|number), userId?: (string|number) }} what
 * @returns {object}
 */
export function grant(access, key, { everyone, roleId, userId } = {}) {
  const next = entryOf(access, key);
  if (everyone) {
    next.everyone = true;
  } else if (roleId != null) {
    const id = String(roleId);
    if (!next.roles.includes(id)) next.roles.push(id);
  } else if (userId != null) {
    const id = String(userId);
    if (!next.users.includes(id)) next.users.push(id);
  }
  return { ...(access ?? {}), [key]: next };
}

/**
 * `access` with exactly one of `{ everyone: true }`, `{ roleId }` or
 * `{ userId }` removed from `key`'s grant — never mutates `access`. An entry
 * left with nothing set (`everyone` false, both arrays empty) is deleted
 * outright rather than kept as an empty object. Revoking something not
 * present, or from a key with no entry at all, is a no-op.
 * @param {object} access
 * @param {string} key
 * @param {{ everyone?: boolean, roleId?: (string|number), userId?: (string|number) }} what
 * @returns {object}
 */
export function revoke(access, key, { everyone, roleId, userId } = {}) {
  if (!access?.[key]) return { ...(access ?? {}) };

  const next = entryOf(access, key);
  if (everyone) {
    next.everyone = false;
  } else if (roleId != null) {
    const id = String(roleId);
    next.roles = next.roles.filter((r) => String(r) !== id);
  } else if (userId != null) {
    const id = String(userId);
    next.users = next.users.filter((u) => String(u) !== id);
  }

  const out = { ...(access ?? {}) };
  if (!next.everyone && next.roles.length === 0 && next.users.length === 0) {
    delete out[key];
  } else {
    out[key] = next;
  }
  return out;
}

/**
 * True when `key`'s grant holds the one thing `what` names (`{ everyone: true }`,
 * `{ roleId }` or `{ userId }`, ids compared as strings) -- whether `revoke`
 * with the same arguments would change anything.
 * @param {object} access
 * @param {string} key
 * @param {{ everyone?: boolean, roleId?: (string|number), userId?: (string|number) }} what
 * @returns {boolean}
 */
export function hasGrant(access, key, { everyone, roleId, userId } = {}) {
  if (!access?.[key]) return false;
  const entry = entryOf(access, key);
  if (everyone) return entry.everyone;
  if (roleId != null) return entry.roles.map(String).includes(String(roleId));
  if (userId != null) return entry.users.map(String).includes(String(userId));
  return false;
}
