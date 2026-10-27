// The registry of operations: every owner command (and later the persona's own adapter) runs
// one named operation with declared rights. It lives apart from src/tools/impl/index.ts so the area
// modules can register themselves while index.js imports them, with no import cycle.

import { CODE } from '../codes.ts';
import type { Obj, OpContext, Rights } from '../types.ts';
import type { Env } from './env.ts';

/** The statuses an operation result may carry (src/tools/impl/index.ts#runOp); `partial`: part of it took effect (a text went out, its GIF did not). */
export const STATUSES = Object.freeze(['ok', 'denied', 'approval_required', 'invalid', 'partial', 'failed']);

/** What an operation runs: its arguments and its context; what it answers is read by `runOp`. */
export type OpRun = (args: Obj, ctx: OpContext) => unknown;

/** A registered operation: frozen. */
export type Op = Readonly<{ name: string; rights: Readonly<Rights>; run: OpRun }>;

/** The statuses an `OpError` carries. */
export type OpErrorStatus = 'invalid' | 'denied' | 'approval_required';

const registry = new Map<string, Op>();

/**
 * An error an operation throws on purpose, carrying the result status and code runOp returns:
 * `invalid` for bad or missing arguments, `denied` for a refusal by rights. Its message is the
 * operator-facing summary.
 */
export class OpError extends Error {
  status: OpErrorStatus;
  /** A stable kebab-case code. */
  code: string;

  constructor(status: OpErrorStatus, code: string, message: string) {
    super(message);
    this.name = 'OpError';
    this.status = status;
    this.code = code;
  }
}

/** An `invalid` OpError: bad or missing arguments (`code` defaults to `invalid-args`). */
export function invalid(message: string, code: string = CODE.INVALID_ARGS): OpError {
  return new OpError('invalid', code, message);
}

/** A `denied` OpError: the caller may not do this (`code` defaults to `owner-only`). */
export function denied(message: string, code: string = CODE.OWNER_ONLY): OpError {
  return new OpError('denied', code, message);
}

/**
 * Registers one operation. `rights.kind` says whether it only reads or writes; `ownerOnly`
 * means no grant ever opens it; `grantable: false` means only an owner runs it unless `member`
 * opens it to every member (while `features.memberCommands` is on). Throws on a duplicate name
 * or a missing kind: both are programming errors. Resolves to the frozen operation.
 */
export function defineOp({ name, rights, run }: { name: string; rights: Rights; run: OpRun }): Op {
  if (typeof name !== 'string' || !name) throw new Error('an operation needs a name');
  if (registry.has(name)) throw new Error(`operation defined twice: ${name}`);
  if (
    (rights as Partial<Rights> | undefined)?.kind !== 'read' &&
    (rights as Partial<Rights> | undefined)?.kind !== 'write'
  )
    throw new Error(`operation ${name} needs rights.kind read or write`);
  if (typeof run !== 'function') throw new Error(`operation ${name} needs a run function`);
  const op: Op = Object.freeze({ name, rights: Object.freeze({ ...rights }), run });
  registry.set(name, op);
  return op;
}

/** The operation called `name`, or null. */
export function getOp(name: string): Op | null {
  return registry.get(name) ?? null;
}

/** Every registered operation as `{ name, rights }`, in registration order. */
export function listOps(): Array<{ name: string; rights: Readonly<Rights> }> {
  return [...registry.values()].map(({ name, rights }) => ({ name, rights }));
}

/**
 * `factory(env)` computed once per env object: the handlers of one area module, closed over the
 * env (src/tools/impl/env.ts#createOpsEnv) they run against.
 */
export function perEnv<T>(factory: (env: Env) => T): (env: Env) => T {
  const cache = new WeakMap<Env, T>();
  return (env) => {
    if (typeof env !== 'object') throw new Error('an operation needs ctx.env');
    let handlers = cache.get(env);
    if (handlers === undefined) {
      handlers = factory(env);
      cache.set(env, handlers);
    }
    return handlers;
  };
}
