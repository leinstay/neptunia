// The operations layer: one typed operation behind every owner command, the same ones the
// persona's adapter will call later. `runOp(name, args, ctx)` checks the caller's rights
// (owner-only before any grant; grants are stored per operation name, src/tools/impl/grants.ts),
// runs the operation and always answers
// `{ status, code, summary, data }` -- it never throws. The slash commands arrive under
// their command keys (`memory.show`, `media`, ...): COMMAND_TO_OP maps each one onto its
// operation and arguments; src/admin.js renders the result as the reply. The persona's skills
// do not read the tree: they have a table of their own (src/tools/definitions.ts).

import { log } from '../../log.js';
import { COMMAND_TABLE } from './catalog.ts';
import { OpError, STATUSES, getOp, listOps } from './registry.ts';
import { rightsRefusal } from './rights.ts';
import './status.ts';
import './config.ts';
import './pause.ts';
import './draw.ts';
import './voice.ts';
import './pings.ts';
import './media.ts';
import './model.ts';
import './route.ts';
import './rule.ts';
import './access.ts';
import './alias.ts';
import './learning.ts';
import './lore.ts';
import './memory.ts';
import './message.ts';
import './task.ts';
import './intent.ts';
import './places.ts';
import './skills.ts';
import './inner.ts';
import './search.ts';
import { CODE } from '../codes.ts';
import { idText, isObj, objOf } from '../types.ts';
import type { Obj, OpContext, Rights } from '../types.ts';

/** What a command key resolves to: an operation with its arguments, or why its arguments pick none. */
export type Resolved = { op: string; args: Obj | undefined } | { invalid: string };

/** One entry of a command table: an operation name (same arguments), or a function of the arguments. */
type Target = string | ((args: Obj | undefined) => Resolved);

/** The result of an operation as `runOp` answers it. */
export type OpResult = { status: string; code: string; summary: string; data: unknown };

export { defineOp, listOps, OpError, invalid, denied } from './registry.ts';

/** `args` with `kind` set, for the media commands that became one operation per action. */
function withKind(kind: string): (op: string) => (args: Obj | undefined) => Resolved {
  return (op) => (args) => ({ op, args: { ...args, kind } });
}

const emoji = withKind('emoji');
const gifs = withKind('gifs');

/** True when an optional argument was not given (absent, null or empty text). */
function absent(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * The `option` argument picking one operation among `table` (`{ value: operation }`): the
 * operation with the arguments as given, or `{ invalid }` naming the values when the argument is
 * missing or unknown. `byAction` reads `action` (with `kind` for media).
 */
function byOption(option: string, table: Record<string, string>): (args: Obj | undefined) => Resolved {
  return (args) => {
    const value = idText(objOf(args)[option]);
    const op = table[value];
    if (!Object.hasOwn(table, value) || op === undefined)
      return { invalid: `${option} must be one of: ${Object.keys(table).join(', ')}` };
    return { op, args };
  };
}

const byAction = (actions: Record<string, string>): ((args: Obj | undefined) => Resolved) =>
  byOption('action', actions);

/**
 * The command keys of the tree (src/tools/impl/catalog.ts#COMMAND_TABLE, `<group>.<name>` or a bare
 * `<name>`) -> operation: an operation name (same arguments), or `(args) => ({ op, args })` where
 * the arguments pick the operation (`media`, `message.react`, `task.intent` and `task.inner` by `action`,
 * `pings` by `mode`), or `{ invalid }` when they cannot. A key not listed
 * here runs nothing.
 */
export const COMMAND_TO_OP: Readonly<Record<string, Target>> = Object.freeze({
  status: 'status.show',
  set: 'config.set',
  unset: 'config.unset',
  pause: 'bot.pause',
  resume: 'bot.resume',
  draw: 'draw.create',
  pings: (args) => ({ op: absent(objOf(args).mode) ? 'pings.get' : 'pings.set', args }),
  media: byAction({ status: 'media.status', rescan: 'media.rescan', recache: 'media.recache' }),
  'model.show': 'model.show',
  'model.set': 'model.set',
  'route.list': 'route.list',
  'route.set': 'route.set',
  'route.remove': 'route.remove',
  'rule.add': 'rule.add',
  'rule.list': 'rule.list',
  'rule.remove': 'rule.remove',
  'access.grant': 'access.grant',
  'access.revoke': 'access.revoke',
  'access.list': 'access.list',
  'alias.add': 'alias.add',
  'alias.remove': 'alias.remove',
  'learning.add': 'learning.add',
  'learning.remove': 'learning.remove',
  'lore.add': 'lore.add',
  'lore.list': 'lore.list',
  'lore.show': 'lore.show',
  'lore.remove': 'lore.remove',
  'memory.show': 'memory.profile.read',
  'memory.channel': 'memory.channel.read',
  'memory.server': 'memory.server.read',
  'memory.recent': 'memory.recent.read',
  'memory.affinity': 'memory.affinity.read',
  'memory.journal': 'memory.journal.read',
  'memory.archive': 'memory.archive.read',
  'memory.restore': 'memory.restore',
  'memory.snapshot': 'memory.snapshot',
  'memory.private': 'memory.private.read',
  'message.create': 'message.create',
  'message.edit': 'message.edit',
  'message.delete': 'message.delete',
  'message.react': byAction({ add: 'message.react.add', remove: 'message.react.remove' }),
  'task.run': 'task.run',
  // Her own call adds `action`: read or resolve a finished task (src/tools/impl/catalog.ts, the leaf's persona-only options).
  'task.status': (args) =>
    objOf(args).action === undefined
      ? { op: 'task.status', args }
      : byAction({ read: 'task.read', resolve: 'task.resolve' })(args),
  'task.cancel': 'task.cancel',
  'task.list': 'task.list',
  'task.search': 'web.search',
  'task.read': 'web.read',
  'task.look': 'media.look',
  'task.find': 'media.find',
  'task.intent': byAction({ add: 'intent.set', update: 'intent.update', cancel: 'intent.cancel', list: 'intent.list' }),
  'task.inner': byAction({ stop: 'inner.stop', start: 'inner.start', status: 'inner.status' }),
  'task.places': 'places.list',
  'task.skills': 'skills.describe',
  'task.conversation': 'conversation.read',
  'memory.search': 'memory.search',
});

/**
 * The slash-command keys of the tree before the operations layer -> operation, the same shape as
 * COMMAND_TO_OP: kept only so `legacyGrantOps` can read the grants stored under those keys (the
 * one-time migration, src/tools/impl/grants.ts#migrateGrants). Never dispatched.
 */
const LEGACY_COMMAND_TO_OP: Readonly<Record<string, Target>> = Object.freeze({
  status: 'status.show',
  set: 'config.set',
  unset: 'config.unset',
  pause: 'bot.pause',
  resume: 'bot.resume',
  interject: 'message.create',
  initiate: 'message.create',
  draw: 'draw.create',
  pings: (args) => ({ op: absent(objOf(args).mode) ? 'pings.get' : 'pings.set', args }),
  'emoji.status': emoji('media.status'),
  'emoji.rescan': emoji('media.rescan'),
  'gifs.status': gifs('media.status'),
  'gifs.rescan': gifs('media.rescan'),
  'gifs.recache': gifs('media.recache'),
  'model.show': 'model.show',
  'model.set': 'model.set',
  'route.list': 'route.list',
  'route.set': 'route.set',
  'route.remove': 'route.remove',
  'rule.add': 'rule.add',
  'rule.list': 'rule.list',
  'rule.remove': 'rule.remove',
  'access.grant': 'access.grant',
  'access.revoke': 'access.revoke',
  'access.list': 'access.list',
  'alias.add': 'alias.add',
  'alias.remove': 'alias.remove',
  'learned.add': 'learning.add',
  'learned.remove': 'learning.remove',
  'lore.add': 'lore.add',
  'lore.list': 'lore.list',
  'lore.show': 'lore.show',
  'lore.remove': 'lore.remove',
  'memory.show': 'memory.profile.read',
  'memory.channel': 'memory.channel.read',
  'memory.server': 'memory.server.read',
  'memory.recent': 'memory.recent.read',
  'memory.affinity': 'memory.affinity.read',
  'memory.journal': 'memory.journal.read',
  'memory.archive': 'memory.archive.read',
  'memory.restore': 'memory.restore',
  'memory.snapshot': 'memory.snapshot',
  'private.show': 'memory.private.read',
});

/** `table[key]` resolved with `args`; null for a key the table does not hold. */
function resolveIn(table: Readonly<Record<string, Target>>, key: string, args: Obj | undefined): Resolved | null {
  const target = table[key];
  if (!Object.hasOwn(table, key) || target === undefined) return null;
  return typeof target === 'function' ? target(args) : { op: target, args };
}

/**
 * The operation and arguments a command key runs, `{ invalid }` (an operator-facing message)
 * when its arguments pick none, or null for a key with no operation.
 */
export function resolveCommand(commandKey: unknown, args: unknown = {}): Resolved | null {
  return resolveIn(COMMAND_TO_OP, idText(commandKey), objOf(args));
}

/**
 * The operations an old (slash-command key) grant covered, for the one-time migration of the
 * stored grants (src/tools/impl/grants.ts#migrateGrants): `*` -> every operation (`from: '*'`); an
 * old command key -> the operation it runs with no optional argument (`memory.affinity` ->
 * `memory.affinity.read`); an old group -> its keys' operations (`from` the group); a key with
 * no operation (`ping`, `reload`, `learned.list` and the other removed commands) -> null: such a
 * grant is dropped.
 */
export function legacyGrantOps(key: string): { from: string | null; names: Array<string> } | null {
  if (key === '*') return { from: '*', names: listOps().map((op) => op.name) };
  const opOf = (full: string): string => {
    const resolved = resolveIn(LEGACY_COMMAND_TO_OP, full, {});
    return resolved !== null && 'op' in resolved ? resolved.op : '';
  };
  if (Object.hasOwn(LEGACY_COMMAND_TO_OP, key)) return { from: null, names: [opOf(key)] };
  const under = Object.keys(LEGACY_COMMAND_TO_OP).filter((full) => full.startsWith(`${key}.`));
  if (under.length === 0) return null;
  return { from: key, names: [...new Set(under.map(opOf))] };
}

/** A refusal result. */
function refusal(status: string, code: string, summary: string): OpResult {
  return { status, code, summary, data: null };
}

/**
 * Null when the caller (`ctx.userId`, `ctx.roleIds`) may run `op`, else the `denied` result with
 * its code: src/tools/impl/rights.ts#rightsRefusal over `bot.owners`, `bot.access` and `features`, all
 * read now. `owner-only` for an owner-only operation, `not-grantable` for one no grant opens (a
 * member operation while `features.memberCommands` is off included), else `not-granted`.
 */
function checkRights(op: { name: string; rights: Rights }, ctx: Partial<OpContext> | undefined): OpResult | null {
  const code = rightsRefusal(op, { userId: ctx?.userId, roleIds: ctx?.roleIds, config: ctx?.env?.hot?.config });
  if (code === null) return null;
  if (code === CODE.NOT_GRANTED) return refusal('denied', code, 'Not allowed');
  return refusal('denied', code, `${op.name} is owner-only`);
}

/** What an operation's `run` returned, as a result: a full result passes through; a reply text
 * or `{ text, files }` is an `ok` whose summary is the text and whose data holds the value.
 * Exported for the tests' fake admin, which answers in the same shape. */
export function asResult(value: unknown): OpResult {
  if (isObj(value) && typeof value.status === 'string' && STATUSES.includes(value.status)) return value as OpResult;
  if (isObj(value)) return { status: 'ok', code: CODE.OK, summary: idText(value.text), data: value };
  const text = idText(value);
  return { status: 'ok', code: CODE.OK, summary: text, data: { text } };
}

/**
 * Runs `name` WITHOUT the rights check: only for src/admin.js#run, which the tests drive directly
 * and the slash commands no longer use for an operation (they call `runOp`, rights included).
 * Same result shape as `runOp`; never throws.
 * `ctx` is `{ env, guildId, channelId, userId, roleIds }`.
 */
export async function runOpPrechecked(name: string, args: Obj = {}, ctx: Partial<OpContext> = {}): Promise<OpResult> {
  const op = getOp(name);
  if (!op) return refusal('invalid', CODE.UNKNOWN_OP, `unknown operation: ${name}`);
  try {
    return asResult(await op.run(args ?? {}, ctx as OpContext));
  } catch (err) {
    if (err instanceof OpError) return refusal(err.status, err.code, err.message);
    const given = objOf(err);
    const code = typeof given.code === 'string' && given.code ? given.code : CODE.ERROR;
    log.warn('ops: failed', { name, code });
    return refusal('failed', code, err instanceof Error ? err.message : idText(given.message) || idText(err));
  }
}

/**
 * Runs one operation for a caller: rights first (see `checkRights`), then the operation.
 * Never throws: `{ status: 'ok'|'denied'|'approval_required'|'invalid'|'failed', code, summary, data }`.
 * `ctx` is `{ env, guildId, channelId, userId, roleIds }`; `env` from src/tools/impl/env.ts#createOpsEnv.
 */
export async function runOp(name: string, args: Obj = {}, ctx: Partial<OpContext> = {}): Promise<OpResult> {
  const op = getOp(name);
  if (!op) return refusal('invalid', CODE.UNKNOWN_OP, `unknown operation: ${name}`);
  const refused = checkRights(op, ctx);
  if (refused) {
    log.info('ops: denied', { name, code: refused.code });
    return refused;
  }
  return runOpPrechecked(name, args, ctx);
}
