// The core key list with the failover of src/llm/key-failover.ts over it. A role bound to an extra key goes out on that
// key alone, with no failover; every other role goes out on the core keys, the first until a budget error moves the
// role on. The names come from the key store at the moment of each call, so a key added or removed from the chat
// changes the next request. Names only leave this module with a value in `route`, which src/llm/openrouter.ts reads.

import type { KeyFailover, KeyState } from '../llm/key-failover.ts';
import type { KeyStore } from './store.ts';

export type KeyRoute = { name: string; value: string };

export type KeyRing = {
  /** The key the next request of `role` goes out on, null when there is none (no core key and no binding). */
  route(role: string): KeyRoute | null;
  /** The failover's list for `role`: the core names, or the one bound name. */
  names(role: string): Array<string>;
  /** A budget error on `name`: the name to repeat on, or null when the list holds one key or is spent. */
  failed(role: string, name: string, status: number): string | null;
  /** The roles that switched keys. */
  states(): Array<KeyState>;
  /** The extra keys some role is bound to, each with its roles. Names only. */
  bound(): Array<{ name: string; roles: Array<string> }>;
  /** The grant of each core key that has one, by name. */
  grants(): Record<string, { grant: number; resetDay: number }>;
};

/**
 * The value of the key `role` goes out on: what the modules that look their own key up (the embedder, the speech
 * synthesis, the pictures) call. '' when the ring has none.
 */
export type KeyOf = (role: string) => string | null;

export function createKeyRing({ store, failover }: { store: KeyStore; failover: KeyFailover }): KeyRing {
  function names(role: string): Array<string> {
    const bound = store.boundTo(role);
    return bound === null ? store.coreNames() : [bound];
  }

  return {
    names,
    route(role) {
      const list = names(role);
      if (list.length === 0) return null;
      const name = failover.current(role, list);
      const value = store.valueOf(name);
      return value === null ? null : { name, value };
    },
    failed: (role, name, status) => failover.failed(role, names(role), name, status),
    states: () => failover.states(),
    grants() {
      const grants: Record<string, { grant: number; resetDay: number }> = {};
      for (const row of store.list().core) {
        if (row.grant !== null && row.resetDay !== null)
          grants[row.name] = { grant: row.grant, resetDay: row.resetDay };
      }
      return grants;
    },
    bound: () =>
      store
        .list()
        .extra.filter((row) => row.roles.length > 0)
        .map((row) => ({ name: row.name, roles: row.roles })),
  };
}
