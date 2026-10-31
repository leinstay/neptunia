// Which model roles are globally failing, kept in memory per role for the life of the process. A role is down when
// its model is switched off (`models.base.<role>: false`), when its key is missing (`hasKey`, the core's own
// resolution of `llm.keyByRole`), after a 401, a 402 or a 404, after a 429 whose answer says the daily limit is spent
// (src/llm/openrouter.js#providerLimitOf), or after three malformed answers in a row. One failed request of any other
// kind leaves the role up. A failing role is tried again on a backoff of 1, 5, 15 and then every 60 minutes, and it
// clears on its first success. src/core.js builds one tracker and hands it to the turn runner, the admin and the
// describer's model client; the tool gateway (src/tools/gateway.ts#abilityRoute) reads it to route a tool role's call,
// and `/status` lists `failing`. Pure apart from the injected clock.

import { BASE_ROLES, CORE_ROLE, roleModel } from './roles.js';
import { providerLimitOf, roleApiKey } from './openrouter.js';

/** Why a role is down. */
export type RoleDownReason =
  'no-model' | 'no-key' | 'unauthorized' | 'payment' | 'not-found' | 'daily-limit' | 'malformed';

/** A role that is down: why, and when it may be called again (null while the config or the key keeps it down). */
export type RoleDown = { role: string; reason: RoleDownReason; retryAt: number | null };

/** The tracker every caller of a model role shares. */
export type RoleHealth = {
  /** A request of `role` failed with `err`; only a global failure changes the state. */
  failed(role: string, err: unknown): void;
  /** A request of `role` answered: the role is up again. */
  succeeded(role: string): void;
  /** A request of `role` answered with something unusable. */
  malformed(role: string): void;
  /** Null when `role` may be called now, else why not. */
  down(config: unknown, role: string): RoleDown | null;
  /** Every base role that is down or still failing, in the display order of the base roles. */
  failing(config: unknown): Array<RoleDown>;
};

const MINUTE_MS = 60_000;
/** The waits between the tries of a failing role (plan 4.8, 2026-10-25); the last one repeats. */
const BACKOFF_MINUTES = [1, 5, 15, 60] as const;
/** Malformed answers in a row that put a role down (plan 4.8). */
const MALFORMED_IN_A_ROW = 3;

/** The HTTP statuses that say the role cannot work at all until someone fixes it. */
const GLOBAL_STATUS: Readonly<Record<number, RoleDownReason>> = Object.freeze({
  401: 'unauthorized',
  402: 'payment',
  404: 'not-found',
});

/** The reason a failed request puts its role down for, or null when it is a failure of that one request. */
function globalReasonOf(err: unknown): RoleDownReason | null {
  const limit: unknown = providerLimitOf(err);
  if (limit === null || typeof limit !== 'object') return null;
  const status: unknown = Reflect.get(limit, 'status');
  if (status === 429) return Reflect.get(limit, 'kind') === 'daily' ? 'daily-limit' : null;
  return typeof status === 'number' && Object.hasOwn(GLOBAL_STATUS, status) ? (GLOBAL_STATUS[status] ?? null) : null;
}

/** The reason the config or the key keeps `role` down, else null. A null or missing model is the role's default. */
function configReasonOf(config: unknown, role: string, hasKey: (role: string) => boolean): RoleDownReason | null {
  const models: unknown = config !== null && typeof config === 'object' ? Reflect.get(config, 'models') : null;
  const base: unknown = models !== null && typeof models === 'object' ? Reflect.get(models, 'base') : null;
  const model: unknown = base !== null && typeof base === 'object' ? Reflect.get(base, role) : undefined;
  if (model === false) return 'no-model';
  return hasKey(role) ? null : 'no-key';
}

type Failure = { reason: RoleDownReason; tries: number; retryAt: number };

export function createRoleHealth({
  now,
  hasKey,
}: {
  now: () => number;
  hasKey: (role: string) => boolean;
}): RoleHealth {
  const failures = new Map<string, Failure>();
  const malformedRuns = new Map<string, number>();

  function fail(role: string, reason: RoleDownReason): void {
    const tries = (failures.get(role)?.tries ?? 0) + 1;
    const minutes = BACKOFF_MINUTES[Math.min(tries, BACKOFF_MINUTES.length) - 1] ?? 60;
    failures.set(role, { reason, tries, retryAt: now() + minutes * MINUTE_MS });
  }

  return {
    failed(role, err) {
      const reason = globalReasonOf(err);
      if (reason !== null) fail(role, reason);
    },
    succeeded(role) {
      failures.delete(role);
      malformedRuns.delete(role);
    },
    malformed(role) {
      const run = (malformedRuns.get(role) ?? 0) + 1;
      malformedRuns.set(role, run);
      if (run >= MALFORMED_IN_A_ROW) fail(role, 'malformed');
    },
    down(config, role) {
      const kept = configReasonOf(config, role, hasKey);
      if (kept !== null) return { role, reason: kept, retryAt: null };
      const failure = failures.get(role);
      // A retry that is due lets one call through; the state stays until that call succeeds or fails again.
      return failure !== undefined && now() < failure.retryAt
        ? { role, reason: failure.reason, retryAt: failure.retryAt }
        : null;
    },
    failing(config) {
      const rows: Array<RoleDown> = [];
      for (const role of BASE_ROLES) {
        const kept = configReasonOf(config, role, hasKey);
        const failure = failures.get(role);
        if (kept !== null) rows.push({ role, reason: kept, retryAt: null });
        else if (failure !== undefined) rows.push({ role, reason: failure.reason, retryAt: failure.retryAt });
      }
      return rows;
    },
  };
}

/** The chat client the describer calls: one completion of messages under request options naming the role. */
type Completing = { complete: (messages: unknown, options?: unknown) => Promise<unknown> };

/**
 * `llm` with every request of one of `roles` reported to `health`: an answer clears the role, an answer with no text
 * counts as malformed, a failure counts as `health` judges it. A request on the core model (`options.model`, a call
 * routed there) reports nothing. Everything else about the request passes through unchanged.
 */
export function reportingLlm<TClient extends Completing>(
  llm: TClient,
  { health, hot, roles }: { health: RoleHealth; hot: unknown; roles: ReadonlyArray<string> }
): TClient {
  const config = (): unknown => configOf(hot);
  const roleOf = (options: unknown): string | null => {
    const given = options !== null && typeof options === 'object' ? options : {};
    const role: unknown = Reflect.get(given, 'role');
    if (typeof role !== 'string' || !roles.includes(role)) return null;
    return Reflect.get(given, 'model') === roleModel(config(), CORE_ROLE) ? null : role;
  };
  const complete = async (messages: unknown, options?: unknown): Promise<unknown> => {
    const role = roleOf(options);
    if (role === null) return llm.complete(messages, options);
    try {
      const answer = await llm.complete(messages, options);
      const text: unknown = answer !== null && typeof answer === 'object' ? Reflect.get(answer, 'text') : null;
      if (typeof text === 'string' && text.trim() !== '') health.succeeded(role);
      else health.malformed(role);
      return answer;
    } catch (err) {
      health.failed(role, err);
      throw err;
    }
  };
  // The describer reads the client's other methods (`capLeft`) too: they stay the client's own.
  return Object.assign(Object.create(llm) as TClient, { complete });
}

/** The live config of `hot` (`{ config, prompts }`), read at the call. */
function configOf(hot: unknown): unknown {
  return hot !== null && typeof hot === 'object' ? Reflect.get(hot, 'config') : undefined;
}

/**
 * The `hasKey` of the core's tracker: whether the key a request of `role` goes out on (src/llm/openrouter.js#roleApiKey
 * over `llm.keyByRole` in the live config of `hot`, the parsed `.env` and the main key) is set.
 */
export function roleKeyCheck({
  hot,
  env,
  mainKey,
}: {
  hot: unknown;
  env: Readonly<Record<string, string | undefined>>;
  mainKey: string;
}): (role: string) => boolean {
  return (role) => {
    const config = configOf(hot);
    // roleApiKey reads the config as a loose object and copes with any shape.
    const key: unknown = roleApiKey(config as object, env, role, mainKey);
    return typeof key === 'string' && key !== '';
  };
}
