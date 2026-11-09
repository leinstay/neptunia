// The choice of a model role's current key among its list (the core key names of the key ring, src/keys/ring.ts), kept
// in process memory. A request that gets a budget error (HTTP 402, or 429 whose body names credits or balance) on the
// current key moves the role to the next one and repeats once (src/llm/openrouter.ts#createLlm). After the last key the
// role goes back to the first, unless every key failed within the last minute: then the list is exhausted. Names only,
// never a key value. Pure apart from the injected clock and the log line.

import { log } from '../log.ts';
import { MINUTE_MS } from '../time.ts';

/** A role that switched keys: the key name it is on now and when it moved (ms). */
export type KeyState = { role: string; key: string; switchedAt: number | null };

export type KeyFailover = {
  /** The role's current key among `names`: the first until a switch, and again when the current one is not in `names`. */
  current(role: string, names: ReadonlyArray<string>): string;
  /**
   * A request of `role` on `failedName` got a budget error with `status`. Returns the name to repeat the request on,
   * or null when the list holds one key or every key failed within the last minute. A `failedName` that is not the
   * current key (a concurrent request) gives the current key and changes nothing. Else the role moves to the next key
   * (the first after the last), `switchedAt` is stored and `llm: key switched` (`role`, `from`, `to`, `status`) logged.
   */
  failed(role: string, names: ReadonlyArray<string>, failedName: string, status: number): string | null;
  /** The roles that switched at least once. */
  states(): Array<KeyState>;
};

/** How long a failure of a key counts against the list: past it the key may have been refilled. */
const EXHAUSTED_WINDOW_MS = MINUTE_MS;

/** The words of a 429 body that say the account is out of credit rather than rate limited. */
const BUDGET_WORDS = /credit|balance/i;

/** Whether an answer with `status` and `body` means the key's credit is spent: a 402, or a 429 that names credits or balance. */
export function isBudgetError(status: unknown, body: unknown): boolean {
  if (status === 402) return true;
  if (status !== 429) return false;
  const text = typeof body === 'string' ? body : body === undefined || body === null ? '' : JSON.stringify(body);
  return BUDGET_WORDS.test(text);
}

type RoleKeys = { key: string; switchedAt: number | null };

export function createKeyFailover({ now }: { now: () => number }): KeyFailover {
  const roles = new Map<string, RoleKeys>();
  const failedAt = new Map<string, number>();
  const failureKey = (role: string, name: string): string => `${role}\n${name}`;

  function current(role: string, names: ReadonlyArray<string>): string {
    const key = roles.get(role)?.key;
    return key !== undefined && names.includes(key) ? key : (names[0] ?? '');
  }

  return {
    current,
    failed(role, names, failedName, status) {
      if (names.length < 2) return null;
      const on = current(role, names);
      if (failedName !== on) return on;
      const at = now();
      failedAt.set(failureKey(role, failedName), at);
      const allFailed = names.every(
        (name) => at - (failedAt.get(failureKey(role, name)) ?? -Infinity) < EXHAUSTED_WINDOW_MS
      );
      if (allFailed) return null;
      const to = names[(names.indexOf(on) + 1) % names.length] ?? on;
      roles.set(role, { key: to, switchedAt: at });
      log.warn('llm: key switched', { role, from: on, to, status });
      return to;
    },
    states() {
      return [...roles].map(([role, state]) => ({ role, key: state.key, switchedAt: state.switchedAt }));
    },
  };
}
