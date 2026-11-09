// Operations: `access.*`: who besides the owners may run which operation (bot.access,
// src/tools/operations/grants.ts). Owner-only. A grant names an operation (`memory.profile.read`), a group
// (`memory`) or `*`; a group or `*` is stored as the grantable read operations it covers now, one
// entry each, so a later operation and every write stay closed until granted by name. The persona
// gets her skills the same way, with her (the bot's own user) as the target: any operation by
// name, owner-only ones included (src/tools/registry.ts), but the irreversible and
// administrative ones no grant opens for her yet (src/tools/access.ts#NOT_GRANTABLE_TO_PERSONA);
// a group or `*` stores the read operations under it. She never changes her own rights: a grant or
// revoke she makes whose target reaches her (herself, everyone, a role she holds) is refused.

import {
  expandGrant,
  describeGrants,
  isGrantableOp,
  grant as accessGrant,
  revoke as accessRevoke,
  hasGrant,
} from './grants.ts';
import { NONE, reloadNote } from './shared.ts';
import { skillNames, skillRegistry } from '../registry.ts';
import { NOT_GRANTABLE_TO_PERSONA } from '../access.ts';
import { defineOp, perEnv, invalid, denied, listOps } from './registry.ts';
import { CODE } from '../codes.ts';
import { idText, isObj, objOf, textOf } from '../types.ts';
import type { Access, GrantTarget, Obj, OpContext, OpInfo } from '../types.ts';

/**
 * Every key `access.grant` accepts, for the autocomplete: `*`, each group (a dotted prefix
 * of an operation name) that covers at least one grantable read operation, then every grantable
 * operation name. Pure over `ops` (src/tools/operations/registry.ts#listOps).
 */
export function grantKeys(ops: ReadonlyArray<OpInfo>): Array<string> {
  const groups = new Set<string>();
  for (const op of ops) {
    if (!isGrantableOp(op) || op.rights.kind !== 'read') continue;
    const parts = op.name.split('.');
    for (let i = 1; i < parts.length; i += 1) groups.add(parts.slice(0, i).join('.'));
  }
  return ['*', ...groups, ...ops.filter(isGrantableOp).map((op) => op.name)];
}

/**
 * What a grant of `key` to the persona stores, against the skills that exist now: a skill (an
 * operation) name is itself (`names`), whatever it does, unless no grant opens it for her yet
 * (src/tools/access.ts#NOT_GRANTABLE_TO_PERSONA: `refused`); a group (a dotted prefix of a skill
 * name) or `*` is every read skill under it, owner-only ones included (they run only when an
 * owner asks), with `from` the pattern.
 * Null when `key` names no skill.
 */
export function expandPersonaGrant(
  key: string
): { from: string | null; names: Array<string>; refused: Array<string> } | null {
  if (skillNames().includes(key))
    return NOT_GRANTABLE_TO_PERSONA.includes(key)
      ? { from: null, names: [], refused: [key] }
      : { from: null, names: [key], refused: [] };
  const under = [...skillRegistry().values()].filter(
    (skill) => key === '*' || (typeof key === 'string' && key !== '' && skill.name.startsWith(`${key}.`))
  );
  if (under.length === 0) return null;
  const names = under
    .filter((skill) => skill.kind === 'read' && !NOT_GRANTABLE_TO_PERSONA.includes(skill.name))
    .map((skill) => skill.name);
  return { from: key, names, refused: [] };
}

/** True when a stored key can only be the persona's: a skill name no grant to a person opens. */
function personaOnlyKey(key: string, ops: ReadonlyArray<OpInfo>): boolean {
  return skillNames().includes(key) && !isGrantableOp(ops.find((op) => op.name === key));
}

const handlers = perEnv((env) => {
  const { writeLocalPath, localOrLive } = env;
  const { reads } = env;

  /** The persona's own member id (the persona as a grant target), or null before the interface has said who she is. */
  function personaId(): string | null {
    const id = env.selfId();
    return id === undefined || id === null || id === '' ? null : id;
  }

  /** True when `what` (accessTargetArgs') targets the persona herself. */
  function targetsPersona(what: GrantTarget | null | undefined): boolean {
    const id = personaId();
    return id !== null && what?.accountId != null && idText(what.accountId) === id;
  }

  /** The ids of the groups the persona holds in the served root (the interface's member info), [] when unknown. */
  async function personaRoleIds(context: OpContext): Promise<Array<string>> {
    const placeId = env.resolvedPlaceId(context);
    const self = personaId();
    if (!reads || !placeId || self === null) return [];
    const found = await reads.memberInfo({ placeId, accountId: self });
    return found?.member?.groupIds ?? [];
  }

  /**
   * The non-delegable rule: made by the persona (`context.actor`), a grant or revoke whose target
   * reaches her -- herself, everyone, or a role she holds -- is refused, whoever asked: she never
   * changes her own effective authority, directly or indirectly.
   */
  async function refuseSelfChange(name: string, what: GrantTarget, context: OpContext): Promise<void> {
    if (context.actor !== 'persona') return;
    const reachesHer =
      targetsPersona(what) ||
      what.everyone === true ||
      (what.roleId != null && (await personaRoleIds(context)).includes(idText(what.roleId)));
    if (reachesHer) throw denied(`${name}: the persona never changes rights that reach her`, CODE.SELF_GRANT);
  }

  /** `bot.access` as of the last write (`localOrLive`): the private settings file already holds the whole
   * merged object the moment one grant/revoke writes it (see `writeAccess`), so reading it back
   * first keeps repeated grant/revoke/list calls consistent even a moment before the next reload
   * lands. Falls back to `hot.config.bot.access` (the config/config.json default, `{}`) before
   * anything has ever been written locally. */
  function effectiveAccess(): Access {
    return objOf(localOrLive('bot.access'));
  }

  /** Writes `nextAccess` to `bot.access` in the private settings file and reloads config -- the same
   * mechanism cmdSet uses; the reload's outcome. */
  function writeAccess(nextAccess: Access): boolean {
    return writeLocalPath('bot.access', nextAccess);
  }

  /** `{ what, label }` for whichever one target option (or neither) was given: `what` is the
   * argument of src/tools/operations/grants.ts#grant/#revoke/#hasGrant, `label` reads `role id:<id>`,
   * `user id:<id>` or `everyone` (plain text: a multi-line reply is code-fenced, where a mention
   * would show as raw markup). */
  function accessTargetArgs(args: Obj): { what: GrantTarget; label: string } {
    const roleId = idText(args.roleId);
    const accountId = idText(args.accountId);
    if (roleId && accountId) throw invalid('give a role or a user, not both');
    if (roleId) return { what: { roleId }, label: `role id:${roleId}` };
    if (accountId) return { what: { accountId }, label: `user id:${accountId}` };
    return { what: { everyone: true }, label: 'everyone' };
  }

  /** A grant to the persona (expandPersonaGrant): every skill by name, a group or `*` its reads. */
  function grantToPersona(key: string, target: { what: GrantTarget; label: string }): string {
    const expanded = expandPersonaGrant(key);
    if (!expanded) throw invalid(`unknown skill: ${key}`, CODE.UNKNOWN_SKILL);
    if (expanded.refused.length > 0)
      throw invalid(`${key} cannot be granted to the persona yet (irreversible or administrative)`, CODE.NOT_GRANTABLE);
    if (expanded.names.length === 0)
      throw invalid(`${key} covers no read skill open to a group grant; grant it by its name`);
    let next = effectiveAccess();
    for (const name of expanded.names) next = accessGrant(next, name, target.what, { from: expanded.from });
    const ok = writeAccess(next);
    if (expanded.from) return `Granted ${key} to ${target.label} as ${expanded.names.join(', ')} ${reloadNote(ok)}`;
    return `Granted ${key} to ${target.label} ${reloadNote(ok)}`;
  }

  async function cmdAccessGrant(args: Obj, context: OpContext): Promise<string> {
    const key = textOf(args.command).trim();
    if (!key) throw invalid('an operation name is required');
    const target = accessTargetArgs(args);
    await refuseSelfChange('access.grant', target.what, context);
    if (targetsPersona(target.what)) return grantToPersona(key, target);
    const ops = listOps();
    const expanded = expandGrant(key, ops);
    if (!expanded) throw invalid(`unknown operation: ${key}`);
    if (expanded.refused.length > 0) {
      const op = ops.find((o) => o.name === key);
      if (op?.rights.member === true) throw invalid(`${key} is open to every member and cannot be granted`);
      throw invalid(`${key} is owner-only and cannot be granted`);
    }
    if (expanded.names.length === 0)
      throw invalid(`${key} covers no grantable read operation; grant a write by its name`);

    let next = effectiveAccess();
    for (const name of expanded.names) next = accessGrant(next, name, target.what, { from: expanded.from });
    const ok = writeAccess(next);

    const byName = new Map(ops.map((op) => [op.name, op]));
    const lines: Array<string> = [];
    if (expanded.from) {
      lines.push(`Granted ${key} to ${target.label} as ${expanded.names.join(', ')} ${reloadNote(ok)}`);
      lines.push('Note: a group or * opens only the read operations that exist now; grant a write by its name.');
    } else {
      lines.push(`Granted ${key} to ${target.label} ${reloadNote(ok)}`);
      if (byName.get(key)?.rights.kind === 'write')
        lines.push('Note: this opens commands that change memory or config.');
    }
    return lines.join('\n');
  }

  /** The stored keys a revoke of `key` touches: every one for `*`, the ones under a group, else
   * the key itself. */
  function storedKeysFor(key: string, access: Access): Array<string> {
    const keys = Object.keys(access);
    if (key === '*') return keys;
    const under = keys.filter((stored) => stored.startsWith(`${key}.`));
    return Object.hasOwn(access, key) ? [key, ...under] : under;
  }

  async function cmdAccessRevoke(args: Obj, context: OpContext): Promise<string> {
    const key = textOf(args.command).trim();
    if (!key) throw invalid('an operation name is required');
    const target = accessTargetArgs(args);
    await refuseSelfChange('access.revoke', target.what, context);
    const currentAccess = effectiveAccess();
    const known = expandGrant(key, listOps()) || (targetsPersona(target.what) && expandPersonaGrant(key));
    if (!known && !Object.hasOwn(currentAccess, key)) throw invalid(`unknown operation: ${key}`);

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
   * line each, every target with its source (see src/tools/operations/grants.ts#describeGrants); stale keys
   * open nothing and are left out. */
  function cmdAccessList(): string {
    const ops = listOps();
    const access: Access = { ...effectiveAccess() };
    const selfId = personaId();
    const alsoKeys: Array<string> = [];
    for (const key of skillNames().filter((name) => personaOnlyKey(name, ops))) {
      const entry = objOf(access[key]);
      const users = Array.isArray(entry.users) ? (entry.users as Array<unknown>).map(idText) : [];
      if (selfId && users.includes(selfId)) {
        const kept = objOf(entry.via)[`user:${selfId}`];
        const via = isObj(entry.via) && kept ? { via: { [`user:${selfId}`]: kept } } : {};
        access[key] = { everyone: false, roles: [], users: [selfId], ...via };
        alsoKeys.push(key);
      }
    }
    const lines = describeGrants(access, ops, { alsoKeys });
    return lines.length === 0 ? NONE : lines.join('\n');
  }

  return {
    effectiveAccess,
    writeAccess,
    accessTargetArgs,
    cmdAccessGrant,
    cmdAccessRevoke,
    cmdAccessList,
  };
});

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
