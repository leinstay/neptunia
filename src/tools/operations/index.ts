// The operations layer: one typed operation behind every owner command and every tool of the persona.
// `runOp(name, args, ctx)` runs the operation and always answers `{ status, code, summary, data }`: it never throws.
// It checks no caller: only the owner types commands, and her grant decides her own calls (src/tools/gateway.ts).
// The owner's console (src/interface/commands/console.ts) and her tools (src/tools/definitions.ts) name the
// operations directly.

import { log } from '../../log.ts';
import { OpError, STATUSES, getOp } from './registry.ts';
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
import './skill.ts';
import './watcher.ts';
import './intention.ts';
import './places.ts';
import './skills.ts';
import './search.ts';
import { CODE } from '../codes.ts';
import { idText, isObj, objOf } from '../types.ts';
import type { Obj, OpContext } from '../types.ts';

/** The result of an operation as `runOp` answers it. */
export type OpResult = { status: string; code: string; summary: string; data: unknown };

export { defineOp, listOps, OpError, invalid, denied } from './registry.ts';

/** A refusal result. */
function refusal(status: string, code: string, summary: string): OpResult {
  return { status, code, summary, data: null };
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
 * Runs one operation. Never throws: `{ status: 'ok'|'denied'|'approval_required'|'invalid'|'failed', code, summary, data }`.
 * `ctx` is `{ env, placeId, accountId, roleIds }`; `env` from src/tools/operations/env.ts#createOpsEnv.
 */
export async function runOp(name: string, args: Obj = {}, ctx: Partial<OpContext> = {}): Promise<OpResult> {
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
