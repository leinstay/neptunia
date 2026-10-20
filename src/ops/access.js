// Operations: `/nep access`: who besides the owners may run which operation (bot.access,
// src/ops/grants.js). Owner-only. A grant names an operation (`memory.profile.read`), a group
// (`memory`) or `*`; a group or `*` is stored as the grantable read operations it covers now, one
// entry each, so a later operation and every write stay closed until granted by name. The persona
// gets her skills the same way, with her (the bot's own user) as the target: any operation by
// name, owner-only ones included (src/skills/registry.js), but the irreversible and
// administrative ones no grant opens for her yet (src/skills/access.js#NOT_GRANTABLE_TO_PERSONA);
// a group or `*` stores the read operations under it. She never changes her own rights: a grant or
// revoke she makes whose target reaches her (herself, everyone, a role she holds) is refused.
// Also, at start, the grants of renamed operations moved under their new name (RENAMED_OPS) and
// the one-time migration of the old command-key grants (`migrateStoredGrants`), which leaves her
// grants as they are.

import { expandGrant, migrateGrants, describeGrants, isGrantableOp, grant as accessGrant, revoke as accessRevoke, hasGrant } from './grants.js';
import { isPlainObject } from '../config.js';
import { log } from '../log.js';
import { NONE, reloadNote } from './shared.js';
import { skillNames, skillRegistry } from '../skills/registry.js';
import { NOT_GRANTABLE_TO_PERSONA } from '../skills/access.js';
import { defineOp, perEnv, invalid, denied, listOps } from './registry.js';
import { CODE } from '../skills/codes.js';

/**
 * Every key `/nep access grant` accepts, for the autocomplete: `*`, each group (a dotted prefix
 * of an operation name) that covers at least one grantable read operation, then every grantable
 * operation name. Pure over `ops` (src/ops/registry.js#listOps).
 * @param {{ name: string, rights: object }[]} ops
 * @returns {string[]}
 */
export function grantKeys(ops) {
  const groups = new Set();
  for (const op of ops) {
    if (!isGrantableOp(op) || op.rights.kind !== 'read') continue;
    const parts = op.name.split('.');
    for (let i = 1; i < parts.length; i += 1) groups.add(parts.slice(0, i).join('.'));
  }
  return ['*', ...groups, ...ops.filter(isGrantableOp).map((op) => op.name)];
}

/** Operations merged under another name: an old grant on the key holds on the value now. */
export const RENAMED_OPS = Object.freeze({ 'talk.interject': 'message.create', 'talk.initiate': 'message.create' });

/**
 * `access` with every grant on a key of `renames` moved under its new name, each target (everyone,
 * a role, a user) kept and joined with what the new name already held; null when nothing was
 * renamed. Pure; never mutates `access`.
 * @param {object} access
 * @param {Record<string, string>} [renames]
 * @returns {object|null}
 */
export function renameGrants(access, renames = RENAMED_OPS) {
  if (!isPlainObject(access)) return null;
  const old = Object.keys(renames).filter((key) => isPlainObject(access[key]));
  if (old.length === 0) return null;
  let next = { ...access };
  for (const key of old) {
    const entry = access[key];
    const targets = [
      ...(entry.everyone === true ? [{ everyone: true }] : []),
      ...(Array.isArray(entry.roles) ? entry.roles.map((roleId) => ({ roleId: String(roleId) })) : []),
      ...(Array.isArray(entry.users) ? entry.users.map((userId) => ({ userId: String(userId) })) : []),
    ];
    delete next[key];
    for (const what of targets) next = accessGrant(next, renames[key], what);
  }
  return next;
}

/**
 * What a grant of `key` to the persona stores, against the skills that exist now: a skill (an
 * operation) name is itself (`names`), whatever it does, unless no grant opens it for her yet
 * (src/skills/access.js#NOT_GRANTABLE_TO_PERSONA: `refused`); a group (a dotted prefix of a skill
 * name) or `*` is every read skill under it, owner-only ones included (they run only when an
 * owner asks), with `from` the pattern.
 * Null when `key` names no skill.
 * @param {string} key
 * @returns {{ from: string|null, names: string[], refused: string[] } | null}
 */
export function expandPersonaGrant(key) {
  if (skillNames().includes(key)) return NOT_GRANTABLE_TO_PERSONA.includes(key) ? { from: null, names: [], refused: [key] } : { from: null, names: [key], refused: [] };
  const under = [...skillRegistry().values()].filter((skill) => key === '*' || (typeof key === 'string' && key !== '' && skill.name.startsWith(`${key}.`)));
  if (under.length === 0) return null;
  const names = under.filter((skill) => skill.kind === 'read' && !NOT_GRANTABLE_TO_PERSONA.includes(skill.name)).map((skill) => skill.name);
  return { from: key, names, refused: [] };
}

/** True when a stored key can only be the persona's: a skill name no grant to a person opens. */
function personaOnlyKey(key, ops) {
  return skillNames().includes(key) && !isGrantableOp(ops.find((op) => op.name === key));
}

const handlers = perEnv((env) => {
  const { writeLocalPath, localOrLive, client } = env;

  /** The bot's own user id (the persona as a grant target), or null before the client is ready. */
  function personaId() {
    const id = client?.user?.id;
    return id === undefined || id === null || id === '' ? null : String(id);
  }

  /** True when `what` (accessTargetArgs') targets the persona herself. */
  function targetsPersona(what) {
    const id = personaId();
    return id !== null && what?.userId != null && String(what.userId) === id;
  }

  /** The role ids the persona holds in the served guild (the client's member cache), [] when unknown. */
  function personaRoleIds(context) {
    const guildId = env.resolvedGuildId(context);
    const roles = client?.guilds?.cache?.get?.(guildId)?.members?.me?.roles?.cache;
    return roles && typeof roles.keys === 'function' ? [...roles.keys()].map(String) : [];
  }

  /**
   * The non-delegable rule: made by the persona (`context.actor`), a grant or revoke whose target
   * reaches her -- herself, everyone, or a role she holds -- is refused, whoever asked: she never
   * changes her own effective authority, directly or indirectly.
   */
  function refuseSelfChange(name, what, context) {
    if (context?.actor !== 'persona') return;
    const reachesHer = targetsPersona(what) || what?.everyone === true || (what?.roleId != null && personaRoleIds(context).includes(String(what.roleId)));
    if (reachesHer) throw denied(`${name}: the persona never changes rights that reach her`, CODE.SELF_GRANT);
  }

  /** `bot.access` as of the last write (`localOrLive`): config.local.json already holds the whole
   * merged object the moment one grant/revoke writes it (see `writeAccess`), so reading it back
   * first keeps repeated grant/revoke/list calls consistent even a moment before the next reload
   * lands. Falls back to `hot.config.bot.access` (the base config.json default, `{}`) before
   * anything has ever been written locally. */
  function effectiveAccess() {
    return localOrLive('bot.access') ?? {};
  }

  /** Writes `nextAccess` to `bot.access` in config.local.json and reloads config -- the same
   * mechanism cmdSet uses; the reload's outcome. */
  function writeAccess(nextAccess) {
    return writeLocalPath('bot.access', nextAccess);
  }

  /** `{ what, label }` for whichever one target option (or neither) was given: `what` is the
   * argument of src/ops/grants.js#grant/#revoke/#hasGrant, `label` reads `role id:<id>`,
   * `user id:<id>` or `everyone` (plain text: a multi-line reply is code-fenced, where a mention
   * would show as raw markup). */
  function accessTargetArgs(args) {
    const roleId = args?.roleId;
    const userId = args?.userId;
    if (roleId && userId) throw invalid('give a role or a user, not both');
    if (roleId) return { what: { roleId: String(roleId) }, label: `role id:${roleId}` };
    if (userId) return { what: { userId: String(userId) }, label: `user id:${userId}` };
    return { what: { everyone: true }, label: 'everyone' };
  }

  /** A grant to the persona (expandPersonaGrant): every skill by name, a group or `*` its reads. */
  function grantToPersona(key, target) {
    const expanded = expandPersonaGrant(key);
    if (!expanded) throw invalid(`unknown skill: ${key}`, CODE.UNKNOWN_SKILL);
    if (expanded.refused.length > 0) throw invalid(`${key} cannot be granted to the persona yet (irreversible or administrative)`, CODE.NOT_GRANTABLE);
    if (expanded.names.length === 0) throw invalid(`${key} covers no read skill open to a group grant; grant it by its name`);
    let next = effectiveAccess();
    for (const name of expanded.names) next = accessGrant(next, name, target.what, { from: expanded.from });
    const ok = writeAccess(next);
    if (expanded.from) return `Granted ${key} to ${target.label} as ${expanded.names.join(', ')} ${reloadNote(ok)}`;
    return `Granted ${key} to ${target.label} ${reloadNote(ok)}`;
  }

  function cmdAccessGrant(args, context) {
    const key = String(args?.command ?? '').trim();
    if (!key) throw invalid('an operation name is required');
    const target = accessTargetArgs(args);
    refuseSelfChange('access.grant', target.what, context);
    if (targetsPersona(target.what)) return grantToPersona(key, target);
    const ops = listOps();
    const expanded = expandGrant(key, ops);
    if (!expanded) throw invalid(`unknown operation: ${key}`);
    if (expanded.refused.length > 0) {
      const op = ops.find((o) => o.name === key);
      if (op?.rights?.member === true) throw invalid(`${key} is open to every member and cannot be granted`);
      throw invalid(`${key} is owner-only and cannot be granted`);
    }
    if (expanded.names.length === 0) throw invalid(`${key} covers no grantable read operation; grant a write by its name`);

    let next = effectiveAccess();
    for (const name of expanded.names) next = accessGrant(next, name, target.what, { from: expanded.from });
    const ok = writeAccess(next);

    const byName = new Map(ops.map((op) => [op.name, op]));
    const lines = [];
    if (expanded.from) {
      lines.push(`Granted ${key} to ${target.label} as ${expanded.names.join(', ')} ${reloadNote(ok)}`);
      lines.push('Note: a group or * opens only the read operations that exist now; grant a write by its name.');
    } else {
      lines.push(`Granted ${key} to ${target.label} ${reloadNote(ok)}`);
      if (byName.get(key)?.rights?.kind === 'write') lines.push('Note: this opens commands that change memory or config.');
    }
    return lines.join('\n');
  }

  /** The stored keys a revoke of `key` touches: every one for `*`, the ones under a group, else
   * the key itself. */
  function storedKeysFor(key, access) {
    const keys = Object.keys(access ?? {});
    if (key === '*') return keys;
    const under = keys.filter((stored) => stored.startsWith(`${key}.`));
    return Object.hasOwn(access ?? {}, key) ? [key, ...under] : under;
  }

  function cmdAccessRevoke(args, context) {
    const key = String(args?.command ?? '').trim();
    if (!key) throw invalid('an operation name is required');
    const target = accessTargetArgs(args);
    refuseSelfChange('access.revoke', target.what, context);
    const currentAccess = effectiveAccess();
    const known = expandGrant(key, listOps()) || (targetsPersona(target.what) && expandPersonaGrant(key));
    if (!known && !Object.hasOwn(currentAccess ?? {}, key)) throw invalid(`unknown operation: ${key}`);

    const touched = storedKeysFor(key, currentAccess).filter((stored) => hasGrant(currentAccess, stored, target.what));
    if (touched.length === 0) return 'Nothing to revoke';

    let next = currentAccess;
    for (const stored of touched) next = accessRevoke(next, stored, target.what);
    const ok = writeAccess(next);
    const which = touched.length === 1 && touched[0] === key ? '' : ` (${touched.join(', ')})`;
    return `Revoked ${key}${which} from ${target.label} ${reloadNote(ok)}`;
  }

  /** Every grant on a grantable operation, and the persona's on the operations only she may be
   * granted (owner-only ones: her user id alone, a stale grant to anyone else opens nothing), one
   * line each, every target with its source (see src/ops/grants.js#describeGrants); stale keys
   * open nothing and are left out. */
  function cmdAccessList() {
    const ops = listOps();
    const access = { ...effectiveAccess() };
    const selfId = personaId();
    const alsoKeys = [];
    for (const key of skillNames().filter((name) => personaOnlyKey(name, ops))) {
      const users = isPlainObject(access[key]) && Array.isArray(access[key].users) ? access[key].users.map(String) : [];
      if (selfId && users.includes(selfId)) {
        const via = isPlainObject(access[key].via) && access[key].via[`user:${selfId}`] ? { via: { [`user:${selfId}`]: access[key].via[`user:${selfId}`] } } : {};
        access[key] = { everyone: false, roles: [], users: [selfId], ...via };
        alsoKeys.push(key);
      }
    }
    const lines = describeGrants(access, ops, { alsoKeys });
    return lines.length === 0 ? NONE : lines.join('\n');
  }

  /**
   * Once per guild (`accessMigrated: 1` in data/guilds/<id>/guild.json): the stored grants,
   * keyed by the old slash-command keys, re-expanded under the operation names
   * (src/ops/grants.js#migrateGrants with `legacy`, src/ops/index.js#legacyGrantOps), written
   * back to config.local.json when they changed, and a journal `system` record `access-migrated`
   * whose note lists what each grant covers now and the owner-only operations dropped.
   * @param {string} guildId
   * @param {(key: string) => ({ from: string|null, names: string[] } | null)} legacy
   * @returns {Promise<{ migrated: boolean, note?: string }>}
   */
  async function migrateStoredGrants(guildId, legacy) {
    const { store } = env;
    // Renamed operations first, every start: a no-op once nothing is stored under an old name.
    const renamed = renameGrants(effectiveAccess());
    if (renamed) {
      writeAccess(renamed);
      log.info('access: renamed', { names: Object.keys(RENAMED_OPS).length });
    }
    if (!guildId || store.getGuild(guildId)?.accessMigrated === 1) return { migrated: false };
    const before = effectiveAccess();
    const ops = listOps();
    // The persona's grants on skills no person may hold are hers as they are: never migrated.
    const kept = {};
    const rest = {};
    for (const [key, entry] of Object.entries(before ?? {})) (personaOnlyKey(key, ops) ? kept : rest)[key] = entry;
    const { access: migrated, report, note } = migrateGrants({ access: rest, ops, legacy });
    const access = { ...migrated, ...kept };
    if (JSON.stringify(access) !== JSON.stringify(before ?? {})) writeAccess(access);
    store.updateGuild(guildId, { accessMigrated: 1 });
    const dropped = report.reduce((sum, line) => sum + line.dropped.length, 0);
    log.info('access: migrated', { guildId, grants: report.length, dropped });
    await env.journalSystem(guildId, { event: 'access-migrated', note: note || NONE });
    return { migrated: true, note };
  }

  return { effectiveAccess, writeAccess, accessTargetArgs, cmdAccessGrant, cmdAccessRevoke, cmdAccessList, migrateStoredGrants };
});

/**
 * The one-time migration of the stored grants for `guildId` (see `migrateStoredGrants` above),
 * against the ops env `env` (src/ops/env.js#createOpsEnv).
 * @param {object} env
 * @param {string} guildId
 * @param {(key: string) => ({ from: string|null, names: string[] } | null)} legacy
 */
export function migrateStoredGrants(env, guildId, legacy) {
  return handlers(env).migrateStoredGrants(guildId, legacy);
}

defineOp({
  name: 'access.grant',
  rights: { kind: 'write', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdAccessGrant(args, ctx),
});
defineOp({
  name: 'access.revoke',
  rights: { kind: 'write', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdAccessRevoke(args, ctx),
});
defineOp({
  name: 'access.list',
  rights: { kind: 'read', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdAccessList(),
});
