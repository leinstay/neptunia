// Operations: `/nep access`: who besides the owners may run which operation (bot.access,
// src/discord/access.js). Owner-only. A grant names an operation (`memory.profile.read`), a group
// (`memory`) or `*`; a group or `*` is stored as the grantable read operations it covers now, one
// entry each, so a later operation and every write stay closed until granted by name. Also the
// one-time migration of the old command-key grants (`migrateStoredGrants`, run at start).

import { expandGrant, migrateGrants, describeGrants, isGrantableOp, grant as accessGrant, revoke as accessRevoke, hasGrant } from '../discord/access.js';
import { log } from '../log.js';
import { NONE, reloadNote } from './shared.js';
import { defineOp, perEnv, invalid, listOps } from './registry.js';

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

const handlers = perEnv((env) => {
  const { writeLocalPath, localOrLive } = env;

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
   * argument of src/discord/access.js#grant/#revoke/#hasGrant, `label` reads `role id:<id>`,
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

  function cmdAccessGrant(args) {
    const key = String(args?.command ?? '').trim();
    if (!key) throw invalid('an operation name is required');
    const ops = listOps();
    const expanded = expandGrant(key, ops);
    if (!expanded) throw invalid(`unknown operation: ${key}`);
    if (expanded.refused.length > 0) {
      const op = ops.find((o) => o.name === key);
      if (op?.rights?.member === true) throw invalid(`${key} is open to every member and cannot be granted`);
      throw invalid(`${key} is owner-only and cannot be granted`);
    }
    if (expanded.names.length === 0) throw invalid(`${key} covers no grantable read operation; grant a write by its name`);

    const target = accessTargetArgs(args);
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

  function cmdAccessRevoke(args) {
    const key = String(args?.command ?? '').trim();
    if (!key) throw invalid('an operation name is required');
    const currentAccess = effectiveAccess();
    if (!expandGrant(key, listOps()) && !Object.hasOwn(currentAccess ?? {}, key)) throw invalid(`unknown operation: ${key}`);

    const target = accessTargetArgs(args);
    const touched = storedKeysFor(key, currentAccess).filter((stored) => hasGrant(currentAccess, stored, target.what));
    if (touched.length === 0) return 'Nothing to revoke';

    let next = currentAccess;
    for (const stored of touched) next = accessRevoke(next, stored, target.what);
    const ok = writeAccess(next);
    const which = touched.length === 1 && touched[0] === key ? '' : ` (${touched.join(', ')})`;
    return `Revoked ${key}${which} from ${target.label} ${reloadNote(ok)}`;
  }

  /** Every grant on a grantable operation, one line each, every target with its source (see
   * src/discord/access.js#describeGrants); stale and owner-only keys open nothing and are left out. */
  function cmdAccessList() {
    const lines = describeGrants(effectiveAccess(), listOps());
    return lines.length === 0 ? NONE : lines.join('\n');
  }

  /**
   * Once per guild (`accessMigrated: 1` in data/guilds/<id>/guild.json): the stored grants,
   * keyed by the old slash-command keys, re-expanded under the operation names
   * (src/discord/access.js#migrateGrants with `legacy`, src/ops/index.js#legacyGrantOps), written
   * back to config.local.json when they changed, and a journal `system` record `access-migrated`
   * whose note lists what each grant covers now and the owner-only operations dropped.
   * @param {string} guildId
   * @param {(key: string) => ({ from: string|null, names: string[] } | null)} legacy
   * @returns {Promise<{ migrated: boolean, note?: string }>}
   */
  async function migrateStoredGrants(guildId, legacy) {
    const { store } = env;
    if (!guildId || store.getGuild(guildId)?.accessMigrated === 1) return { migrated: false };
    const before = effectiveAccess();
    const { access, report, note } = migrateGrants({ access: before, ops: listOps(), legacy });
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
  run: (args, ctx) => handlers(ctx.env).cmdAccessGrant(args),
});
defineOp({
  name: 'access.revoke',
  rights: { kind: 'write', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdAccessRevoke(args),
});
defineOp({
  name: 'access.list',
  rights: { kind: 'read', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdAccessList(),
});
