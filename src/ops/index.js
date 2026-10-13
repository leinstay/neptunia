// The operations layer: one typed operation behind every owner command, the same ones the
// persona's adapter will call later. `runOp(name, args, ctx)` checks the caller's rights
// (owner-only before any grant; grants are stored per operation name, src/discord/access.js),
// runs the operation and always answers
// `{ status, code, summary, data }` -- it never throws. The slash commands arrive under
// their command keys (`memory.show`, `media`, ...): COMMAND_TO_OP maps each one onto its
// operation and arguments; src/admin.js renders the result as the reply.

import { isAllowed } from '../discord/access.js';
import { log } from '../log.js';
import { OpError, STATUSES, getOp, listOps } from './registry.js';
import './status.js';
import './config.js';
import './pause.js';
import './talk.js';
import './draw.js';
import './pings.js';
import './media.js';
import './model.js';
import './route.js';
import './rule.js';
import './access.js';
import './warmup.js';
import './diary.js';
import './alias.js';
import './learning.js';
import './lore.js';
import './memory.js';

export { defineOp, listOps, OpError, invalid, denied } from './registry.js';

/** `args` with `kind` set, for the media commands that became one operation per action. */
function withKind(kind) {
  return (op) => (args) => ({ op, args: { ...args, kind } });
}

const emoji = withKind('emoji');
const gifs = withKind('gifs');

/** True when an optional argument was not given (absent, null or empty text). */
function absent(value) {
  return value === undefined || value === null || value === '';
}

/**
 * An `action` option (with `kind` for media) picking one operation among `actions`
 * (`{ action: operation }`): the operation with the arguments as given, or `{ invalid }` naming
 * the actions when the action is missing or unknown.
 */
function byAction(actions) {
  return (args) => {
    const action = args?.action;
    if (!Object.hasOwn(actions, String(action))) return { invalid: `action must be one of: ${Object.keys(actions).join(', ')}` };
    return { op: actions[action], args };
  };
}

/**
 * The command keys of the tree (src/discord/commands.js#COMMAND_TABLE, `<group>.<name>` or a bare
 * `<name>`) -> operation: an operation name (same arguments), or `(args) => ({ op, args })` where
 * the arguments pick the operation (`talk`, `media` and `memory.private` by `action`, `pings` by
 * `mode`, `memory.affinity` by `score`), or `{ invalid }` when they cannot. The mentor and the
 * commands the tree dropped (`ping`, `reload`, `learned.list`) are not operations; src/admin.js
 * still runs them itself.
 */
export const COMMAND_TO_OP = Object.freeze({
  status: 'status.show',
  set: 'config.set',
  unset: 'config.unset',
  pause: 'bot.pause',
  resume: 'bot.resume',
  draw: 'draw.create',
  pings: (args) => ({ op: absent(args?.mode) ? 'pings.get' : 'pings.set', args }),
  talk: byAction({ interject: 'talk.interject', initiate: 'talk.initiate' }),
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
  'warmup.run': 'warmup.run',
  'warmup.users': 'warmup.users',
  'warmup.channels': 'warmup.channels',
  'warmup.server': 'warmup.server',
  'warmup.people': 'warmup.people',
  'warmup.status': 'warmup.status',
  'warmup.stop': 'warmup.stop',
  'warmup.reset': 'warmup.reset',
  'diary.set': 'diary.set',
  'diary.show': 'diary.show',
  'diary.off': 'diary.off',
  'diary.post': 'diary.post',
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
  'memory.refresh': 'memory.refresh',
  'memory.forget': 'memory.forget',
  'memory.affinity': (args) => ({ op: absent(args?.score) ? 'memory.affinity.read' : 'memory.affinity.set', args }),
  'memory.wipe': 'memory.wipe',
  'memory.journal': 'memory.journal.read',
  'memory.archive': 'memory.archive.read',
  'memory.restore': 'memory.restore',
  'memory.snapshot': 'memory.snapshot',
  'memory.private': byAction({ show: 'memory.private.read', forget: 'memory.private.forget', purge: 'memory.private.purge' }),
});

/**
 * The slash-command keys of the tree before the operations layer -> operation, the same shape as
 * COMMAND_TO_OP: kept only so `legacyGrantOps` can read the grants stored under those keys (the
 * one-time migration, src/discord/access.js#migrateGrants). Never dispatched.
 */
const LEGACY_COMMAND_TO_OP = Object.freeze({
  status: 'status.show',
  set: 'config.set',
  unset: 'config.unset',
  pause: 'bot.pause',
  resume: 'bot.resume',
  interject: 'talk.interject',
  initiate: 'talk.initiate',
  draw: 'draw.create',
  pings: (args) => ({ op: absent(args?.mode) ? 'pings.get' : 'pings.set', args }),
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
  'warmup.run': 'warmup.run',
  'warmup.users': 'warmup.users',
  'warmup.channels': 'warmup.channels',
  'warmup.server': 'warmup.server',
  'warmup.people': 'warmup.people',
  'warmup.status': 'warmup.status',
  'warmup.stop': 'warmup.stop',
  'warmup.reset': 'warmup.reset',
  'diary.set': 'diary.set',
  'diary.show': 'diary.show',
  'diary.off': 'diary.off',
  'diary.post': 'diary.post',
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
  'memory.refresh': 'memory.refresh',
  'memory.forget': 'memory.forget',
  'memory.affinity': (args) => ({ op: absent(args?.score) ? 'memory.affinity.read' : 'memory.affinity.set', args }),
  'memory.wipe': 'memory.wipe',
  'memory.journal': 'memory.journal.read',
  'memory.archive': 'memory.archive.read',
  'memory.restore': 'memory.restore',
  'memory.snapshot': 'memory.snapshot',
  'private.show': 'memory.private.read',
  'private.forget': 'memory.private.forget',
  'private.purge': 'memory.private.purge',
});

/** `table[key]` resolved with `args`; null for a key the table does not hold. */
function resolveIn(table, key, args) {
  if (!Object.hasOwn(table, key)) return null;
  const target = table[key];
  return typeof target === 'function' ? target(args) : { op: target, args };
}

/**
 * The operation and arguments a command key runs, `{ invalid }` (an operator-facing message)
 * when its arguments pick none, or null for a key with no operation.
 * @param {string} commandKey
 * @param {object} [args]
 * @returns {{ op: string, args: object } | { invalid: string } | null}
 */
export function resolveCommand(commandKey, args = {}) {
  return resolveIn(COMMAND_TO_OP, commandKey, args);
}

/**
 * The operations an old (slash-command key) grant covered, for the one-time migration of the
 * stored grants (src/discord/access.js#migrateGrants): `*` -> every operation (`from: '*'`); an
 * old command key -> the operation it runs with no optional argument (`memory.affinity` ->
 * `memory.affinity.read`); an old group -> its keys' operations (`from` the group); a key with
 * no operation (`ping`, `reload`, `learned.list`, `mentor.*`, now owner-only) -> null.
 * @param {string} key
 * @returns {{ from: string|null, names: string[] } | null}
 */
export function legacyGrantOps(key) {
  if (key === '*') return { from: '*', names: listOps().map((op) => op.name) };
  if (Object.hasOwn(LEGACY_COMMAND_TO_OP, key)) return { from: null, names: [resolveIn(LEGACY_COMMAND_TO_OP, key, {}).op] };
  const under = Object.keys(LEGACY_COMMAND_TO_OP).filter((full) => full.startsWith(`${key}.`));
  if (under.length === 0) return null;
  return { from: key, names: [...new Set(under.map((full) => resolveIn(LEGACY_COMMAND_TO_OP, full, {}).op))] };
}

/** A refusal result. */
function refusal(status, code, summary) {
  return { status, code, summary, data: null };
}

/**
 * Null when the caller (`ctx.userId`, `ctx.roleIds`) may run `op`, else the `denied` result with
 * its code: src/discord/access.js#isAllowed over `bot.owners`, `bot.access` and `features`, all
 * read now. `owner-only` for an owner-only operation, `not-grantable` for one no grant opens (a
 * member operation while `features.memberCommands` is off included), else `not-granted`.
 */
function checkRights(op, ctx) {
  const config = ctx?.env?.hot?.config;
  const allowed = isAllowed({
    op,
    member: { userId: ctx?.userId, roleIds: ctx?.roleIds },
    access: config?.bot?.access ?? {},
    owners: config?.bot?.owners ?? [],
    features: config?.features,
  });
  if (allowed) return null;
  const { rights } = op;
  if (rights.ownerOnly === true) return refusal('denied', 'owner-only', `${op.name} is owner-only`);
  if (rights.grantable === false || rights.member === true) return refusal('denied', 'not-grantable', `${op.name} is owner-only`);
  return refusal('denied', 'not-granted', 'Not allowed');
}

/** What an operation's `run` returned, as a result: a full result passes through; a reply text
 * or `{ text, files }` is an `ok` whose summary is the text and whose data holds the value.
 * Exported for src/admin.js, whose few commands with no operation answer in the same shape. */
export function asResult(value) {
  if (value && typeof value === 'object' && STATUSES.includes(value.status)) return value;
  if (value && typeof value === 'object') return { status: 'ok', code: 'ok', summary: String(value.text ?? ''), data: value };
  const text = String(value ?? '');
  return { status: 'ok', code: 'ok', summary: text, data: { text } };
}

/**
 * Runs `name` WITHOUT the rights check: only for src/admin.js#run, which the tests drive directly
 * and the slash commands no longer use for an operation (they call `runOp`, rights included).
 * Same result shape as `runOp`; never throws.
 * @param {string} name
 * @param {object} args
 * @param {object} ctx  `{ env, guildId, channelId, userId, roleIds }`
 * @returns {Promise<{ status: string, code: string, summary: string, data: unknown }>}
 */
export async function runOpPrechecked(name, args = {}, ctx = {}) {
  const op = getOp(name);
  if (!op) return refusal('invalid', 'unknown-op', `unknown operation: ${name}`);
  try {
    return asResult(await op.run(args ?? {}, ctx));
  } catch (err) {
    if (err instanceof OpError) return refusal(err.status, err.code, err.message);
    const code = typeof err?.code === 'string' && err.code ? err.code : 'error';
    log.warn('ops: failed', { name, code });
    return refusal('failed', code, String(err?.message ?? err));
  }
}

/**
 * Runs one operation for a caller: rights first (see `checkRights`), then the operation.
 * Never throws: `{ status: 'ok'|'denied'|'approval_required'|'invalid'|'failed', code, summary, data }`.
 * @param {string} name
 * @param {object} args
 * @param {object} ctx  `{ env, guildId, channelId, userId, roleIds }`; `env` from src/ops/env.js#createOpsEnv
 */
export async function runOp(name, args = {}, ctx = {}) {
  const op = getOp(name);
  if (!op) return refusal('invalid', 'unknown-op', `unknown operation: ${name}`);
  const refused = checkRights(op, ctx);
  if (refused) {
    log.info('ops: denied', { name, code: refused.code });
    return refused;
  }
  return runOpPrechecked(name, args, ctx);
}
