// Operations: `access.*`: the tools granted to the persona (bot.access, src/tools/operations/grants.ts), keyed by
// operation name with her own user id as the one target. A grant names a skill (`memory.profile.read`), a group
// (`memory`) or `*`. A skill is granted by name whatever it does, but the irreversible and administrative ones no
// grant opens for her yet (src/tools/access.ts#NOT_GRANTABLE_TO_PERSONA). A group or `*` is stored as the read
// skills it covers now, one entry each, so a later skill and every write stay closed until granted by name. She
// never changes her own grants: `access.grant` or `access.revoke` made by her is refused.

import { grant as accessGrant, revoke as accessRevoke, hasGrant } from './grants.ts';
import { NONE, reloadNote } from './shared.ts';
import { skillNames, skillRegistry } from '../registry.ts';
import { NOT_GRANTABLE_TO_PERSONA } from '../access.ts';
import { defineOp, perEnv, invalid, denied } from './registry.ts';
import { CODE } from '../codes.ts';
import { idText, objOf, textOf } from '../types.ts';
import type { Access, Obj, OpContext } from '../types.ts';

/**
 * What a grant of `key` to the persona stores, against the skills that exist now: a skill (an
 * operation) name is itself (`names`), whatever it does, unless no grant opens it for her yet
 * (src/tools/access.ts#NOT_GRANTABLE_TO_PERSONA: `refused`); a group (a dotted prefix of a skill
 * name) or `*` is every read skill under it, with `from` the pattern.
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

const handlers = perEnv((env) => {
  const { writeLocalPath, localOrLive } = env;

  /** The persona's own user id, the one target of a grant; refused while no interface has said who she is. */
  function personaId(): string {
    const id = idText(env.selfId());
    if (id === '') throw new Error('no interface has said who the persona is yet');
    return id;
  }

  /** The non-delegable rule: a grant or revoke made by the persona (`context.actor`) is refused, whoever asked,
   * because every grant is hers and she never changes her own effective authority. */
  function refuseSelfChange(name: string, context: OpContext): void {
    if (context.actor === 'persona') throw denied(`${name}: the persona never changes her own grants`, CODE.SELF_GRANT);
  }

  /** `bot.access` as of the last write (`localOrLive`): the private settings file already holds the whole
   * merged object the moment one grant or revoke writes it (see `writeAccess`), so reading it back
   * first keeps repeated grant, revoke and list calls consistent even a moment before the next reload
   * lands. Falls back to `hot.config.bot.access` (the config/config.json default, `{}`) before
   * anything has ever been written locally. */
  function effectiveAccess(): Access {
    return objOf(localOrLive('bot.access'));
  }

  /** Writes `nextAccess` to `bot.access` in the private settings file and reloads config, the same
   * mechanism cmdSet uses; the reload's outcome. */
  function writeAccess(nextAccess: Access): boolean {
    return writeLocalPath('bot.access', nextAccess);
  }

  /** `access.grant`: every skill by name, a group or `*` its reads (expandPersonaGrant), to her id. */
  function cmdAccessGrant(args: Obj, context: OpContext): string {
    refuseSelfChange('access.grant', context);
    const key = textOf(args.command).trim();
    if (!key) throw invalid('a tool name is required');
    const self = personaId();
    const expanded = expandPersonaGrant(key);
    if (!expanded) throw invalid(`unknown skill: ${key}`, CODE.UNKNOWN_SKILL);
    if (expanded.refused.length > 0)
      throw invalid(`${key} cannot be granted to the persona yet (irreversible or administrative)`, CODE.NOT_GRANTABLE);
    if (expanded.names.length === 0)
      throw invalid(`${key} covers no read skill open to a group grant; grant it by its name`);
    let next = effectiveAccess();
    for (const name of expanded.names) next = accessGrant(next, name, { accountId: self }, { from: expanded.from });
    const ok = writeAccess(next);
    if (expanded.from) return `Granted ${key} to the persona as ${expanded.names.join(', ')} ${reloadNote(ok)}`;
    return `Granted ${key} to the persona ${reloadNote(ok)}`;
  }

  /** The stored keys a revoke of `key` touches: every one for `*`, the ones under a group, else
   * the key itself. */
  function storedKeysFor(key: string, access: Access): Array<string> {
    const keys = Object.keys(access);
    if (key === '*') return keys;
    const under = keys.filter((stored) => stored.startsWith(`${key}.`));
    return Object.hasOwn(access, key) ? [key, ...under] : under;
  }

  /** `access.revoke`: her id off the key, every key under a group, or every key for `*`. */
  function cmdAccessRevoke(args: Obj, context: OpContext): string {
    refuseSelfChange('access.revoke', context);
    const key = textOf(args.command).trim();
    if (!key) throw invalid('a tool name is required');
    const self = personaId();
    const currentAccess = effectiveAccess();
    if (!expandPersonaGrant(key) && !Object.hasOwn(currentAccess, key)) throw invalid(`unknown skill: ${key}`);

    const touched = storedKeysFor(key, currentAccess).filter((stored) =>
      hasGrant(currentAccess, stored, { accountId: self })
    );
    if (touched.length === 0) return 'Nothing to revoke';

    let next = currentAccess;
    for (const stored of touched) next = accessRevoke(next, stored, { accountId: self });
    const ok = writeAccess(next);
    const which = touched.length === 1 && touched[0] === key ? '' : ` (${touched.join(', ')})`;
    return `Revoked ${key}${which} from the persona ${reloadNote(ok)}`;
  }

  /** `access.list`: one line per stored key whose users hold her id, `<op>: user id:<her id>`, followed by
   * `(expanded from <pattern>, reads only)` when the grant came from a group or `*`; `(none)` when she holds nothing.
   * A key held only by anyone else opens nothing for her and is left out. */
  function cmdAccessList(): string {
    const self = idText(env.selfId());
    const access = effectiveAccess();
    const lines = Object.keys(access)
      .filter((key) => self !== '' && hasGrant(access, key, { accountId: self }))
      .map((key) => {
        const from = idText(objOf(objOf(access[key]).via)[`user:${self}`]);
        const line = `${key}: user id:${self}`;
        return from ? `${line} (expanded from ${from}, reads only)` : line;
      });
    return lines.length === 0 ? NONE : lines.join('\n');
  }

  return { cmdAccessGrant, cmdAccessRevoke, cmdAccessList };
});

defineOp({
  name: 'access.grant',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdAccessGrant(args, ctx),
});
defineOp({
  name: 'access.revoke',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdAccessRevoke(args, ctx),
});
defineOp({
  name: 'access.list',
  rights: { kind: 'read' },
  run: (args, ctx) => handlers(ctx.env).cmdAccessList(),
});
