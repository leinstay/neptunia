// The operations layer: one typed operation behind every owner command and every tool of the persona.
// `runOp(name, args, ctx)` checks the caller's rights (owner-only before any grant; grants are stored per
// operation name, src/tools/impl/grants.ts), runs the operation and always answers
// `{ status, code, summary, data }`: it never throws. The owner's console (src/interface/commands/console.ts) and
// her tools (src/tools/definitions.ts) name the operations directly.

import { log } from '../../log.js';
import { OpError, STATUSES, getOp } from './registry.ts';
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
import './errand.ts';
import './board.ts';
import './intention.ts';
import './places.ts';
import './skills.ts';
import './inner.ts';
import './search.ts';
import { CODE } from '../codes.ts';
import { idText, isObj, objOf } from '../types.ts';
import type { Obj, OpContext, Rights } from '../types.ts';

/** The result of an operation as `runOp` answers it. */
export type OpResult = { status: string; code: string; summary: string; data: unknown };

export { defineOp, listOps, OpError, invalid, denied } from './registry.ts';

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
  const code = rightsRefusal(op, {
    userId: ctx?.userId,
    roleIds: ctx?.roleIds,
    config: ctx?.env?.hot?.config,
    asOwner: ctx?.asOwner === true,
  });
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
 * Runs `name` WITHOUT the rights check: for src/admin.js#run, which the tests drive directly, and for
 * her own calls, whose grant the skill gateway checks. Same result shape as `runOp`; never throws.
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
