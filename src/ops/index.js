// The operations layer: one typed operation behind every owner command, the same ones the
// persona's adapter will call later. `runOp(name, args, ctx)` checks the caller's rights
// (owner-only before any grant, `*` never past it), runs the operation and always answers
// `{ status, code, summary, data }` -- it never throws. The slash commands still arrive under
// their old keys (`memory.show`, `emoji.status`, ...): COMMAND_TO_OP maps each one onto its
// operation and arguments; src/admin.js renders the result as the reply.

import { isAllowed, isOwnerId } from '../discord/access.js';
import { log } from '../log.js';
import { OpError, STATUSES, getOp } from './registry.js';
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
 * The old command keys (src/discord/commands.js#commandKeys) -> operation: an operation name
 * (same arguments), or `(args) => ({ op, args })` where the arguments pick the operation or add
 * one. The mentor and the commands the new tree drops (`ping`, `reload`, `learned.list`) are not
 * operations; src/admin.js still runs them itself.
 */
export const COMMAND_TO_OP = Object.freeze({
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

/**
 * The operation and arguments an old command key runs, or null for a key with no operation.
 * @param {string} commandKey
 * @param {object} [args]
 * @returns {{ op: string, args: object } | null}
 */
export function resolveCommand(commandKey, args = {}) {
  if (!Object.hasOwn(COMMAND_TO_OP, commandKey)) return null;
  const target = COMMAND_TO_OP[commandKey];
  return typeof target === 'function' ? target(args) : { op: target, args };
}

/** A refusal result. */
function refusal(status, code, summary) {
  return { status, code, summary, data: null };
}

/**
 * Null when the caller (`ctx.userId`, `ctx.roleIds`) may run `op`, else the `denied` result.
 * An owner (`bot.owners`, read now) always may; then an owner-only operation is refused before
 * any grant is looked at; a member operation is open while `features.memberCommands` is on; a
 * non-grantable one is refused; anything else needs a `bot.access` grant matched by operation
 * name, its group or `*` (src/discord/access.js#isAllowed).
 */
function checkRights(op, ctx) {
  const config = ctx?.env?.hot?.config;
  if (isOwnerId(config, ctx?.userId)) return null;
  const { rights } = op;
  if (rights.ownerOnly === true) return refusal('denied', 'owner-only', `${op.name} is owner-only`);
  if (rights.member === true && config?.features?.memberCommands !== false) return null;
  if (rights.grantable === false || rights.member === true) return refusal('denied', 'not-grantable', `${op.name} is owner-only`);
  const granted = isAllowed({
    commandKey: op.name,
    userId: ctx?.userId,
    roleIds: ctx?.roleIds,
    owners: config?.bot?.owners ?? [],
    access: config?.bot?.access ?? {},
    memberCommands: false,
  });
  return granted ? null : refusal('denied', 'not-granted', 'Not allowed');
}

/** What an operation's `run` returned, as a result: a full result passes through; a reply text
 * or `{ text, files }` is an `ok` whose summary is the text and whose data holds the value. */
function toResult(value) {
  if (value && typeof value === 'object' && STATUSES.includes(value.status)) return value;
  if (value && typeof value === 'object') return { status: 'ok', code: 'ok', summary: String(value.text ?? ''), data: value };
  const text = String(value ?? '');
  return { status: 'ok', code: 'ok', summary: text, data: { text } };
}

/**
 * Runs `name` WITHOUT the rights check: only for an adapter that has already decided the caller
 * may run it (the slash commands, through src/admin.js#isAllowed on the old command key, until
 * access is keyed by operation). Same result shape as `runOp`; never throws.
 * @param {string} name
 * @param {object} args
 * @param {object} ctx  `{ env, guildId, channelId, userId, roleIds }`
 * @returns {Promise<{ status: string, code: string, summary: string, data: unknown }>}
 */
export async function runOpPrechecked(name, args = {}, ctx = {}) {
  const op = getOp(name);
  if (!op) return refusal('invalid', 'unknown-op', `unknown operation: ${name}`);
  try {
    return toResult(await op.run(args ?? {}, ctx));
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
