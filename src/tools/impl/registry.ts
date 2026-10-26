import { CODE } from '../codes.ts';
// The registry of operations: every owner command (and later the persona's own adapter) runs
// one named operation with declared rights. It lives apart from src/tools/impl/index.ts so the area
// modules can register themselves while index.js imports them, with no import cycle.

/** The statuses an operation result may carry (src/tools/impl/index.ts#runOp); `partial`: part of it took effect (a text went out, its GIF did not). */
export const STATUSES = Object.freeze(['ok', 'denied', 'approval_required', 'invalid', 'partial', 'failed']);

const registry = new Map();

/**
 * An error an operation throws on purpose, carrying the result status and code runOp returns:
 * `invalid` for bad or missing arguments, `denied` for a refusal by rights. Its message is the
 * operator-facing summary.
 */
export class OpError extends Error {
  /**
   * @param {'invalid'|'denied'|'approval_required'} status
   * @param {string} code  A stable kebab-case code.
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'OpError';
    this.status = status;
    this.code = code;
  }
}

/** An `invalid` OpError: bad or missing arguments (`code` defaults to `invalid-args`). */
export function invalid(message, code = CODE.INVALID_ARGS) {
  return new OpError('invalid', code, message);
}

/** A `denied` OpError: the caller may not do this (`code` defaults to `owner-only`). */
export function denied(message, code = CODE.OWNER_ONLY) {
  return new OpError('denied', code, message);
}

/**
 * Registers one operation. `rights.kind` says whether it only reads or writes; `ownerOnly`
 * means no grant ever opens it; `grantable: false` means only an owner runs it unless `member`
 * opens it to every member (while `features.memberCommands` is on). Throws on a duplicate name
 * or a missing kind: both are programming errors.
 * @param {{ name: string, rights: { kind: 'read'|'write', ownerOnly?: boolean, grantable?: boolean, member?: boolean },
 *   run: (args: object, ctx: object) => unknown }} op
 * @returns {object} the frozen operation
 */
export function defineOp({ name, rights, run }) {
  if (typeof name !== 'string' || !name) throw new Error('an operation needs a name');
  if (registry.has(name)) throw new Error(`operation defined twice: ${name}`);
  if (rights?.kind !== 'read' && rights?.kind !== 'write')
    throw new Error(`operation ${name} needs rights.kind read or write`);
  if (typeof run !== 'function') throw new Error(`operation ${name} needs a run function`);
  const op = Object.freeze({ name, rights: Object.freeze({ ...rights }), run });
  registry.set(name, op);
  return op;
}

/** The operation called `name`, or null. */
export function getOp(name) {
  return registry.get(name) ?? null;
}

/** Every registered operation as `{ name, rights }`, in registration order. */
export function listOps() {
  return [...registry.values()].map(({ name, rights }) => ({ name, rights }));
}

/**
 * `factory(env)` computed once per env object: the handlers of one area module, closed over the
 * env (src/tools/impl/env.ts#createOpsEnv) they run against.
 * @template T
 * @param {(env: object) => T} factory
 * @returns {(env: object) => T}
 */
export function perEnv(factory) {
  const cache = new WeakMap();
  return (env) => {
    if (!env || typeof env !== 'object') throw new Error('an operation needs ctx.env');
    if (!cache.has(env)) cache.set(env, factory(env));
    return cache.get(env);
  };
}
