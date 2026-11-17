// The store's view of the owner's rules (src/memory/store.ts builds one per store), over the table `rules`
// (src/memory/db/rules.ts). `liveRules` reads the table at each call and lays over it the adds and removals the
// writer does not hold yet, so a rule shows in the next request after the command that added it. `addRule` and
// `removeRule` send their change to the writer's `rules` kind at once. A failed write is sent again by the next flush;
// the shutdown waits for it (`settle`) and logs what it lost.

import { liveRules } from './db/rules.ts';
import type { Rule } from './db/rules.ts';
import { createWritesUnderWay } from './db/writes-under-way.ts';
import type { Db } from './db/types.ts';
import type { MemoryDb } from './types.ts';
import { log } from '../log.ts';

type Seam = { db(): Db; run<TResult>(fn: () => TResult): TResult };

/** What the store offers of the rules (see the head of this file). */
export type StoreRules = {
  liveRules: () => Array<Rule>;
  addRule: (text: string) => Rule;
  removeRule: (id: string) => void;
  flush: () => void;
  settle: (options?: { final?: boolean; timeoutMs?: number }) => Promise<number>;
};

/** The rules over `memoryDb`, read through `seam`, with ids from `newId`. */
export function createStoreRules({
  memoryDb,
  seam,
  newId,
}: {
  memoryDb: MemoryDb;
  seam: Seam;
  newId: () => string;
}): StoreRules {
  const writes = createWritesUnderWay({ log, name: 'rules' });
  // The changes the database does not hold yet.
  const added = new Map<string, Rule>();
  const removed = new Set<string>();

  function send(): void {
    // A read-only handle (scripts/lib/turn-wiring.ts, scripts/recall-eval.ts) has no writer: its changes stay unwritten.
    const write = memoryDb.writeRules;
    if (!write || (added.size === 0 && removed.size === 0)) return;
    const rules = [...added.values()];
    const ids = [...removed];
    writes.track(
      async () => {
        await write({ added: rules, removed: ids });
        for (const rule of rules) added.delete(rule.id);
        for (const id of ids) removed.delete(id);
      },
      () => undefined
    );
  }

  return {
    liveRules: () => {
      const stored = seam.run(() => liveRules(seam.db()));
      const held = new Set(stored.map((rule) => rule.id));
      return [...stored, ...[...added.values()].filter((rule) => !held.has(rule.id))]
        .filter((rule) => !removed.has(rule.id))
        .map((rule) => ({ ...rule }));
    },
    addRule: (text) => {
      const rule = { id: newId(), text };
      added.set(rule.id, rule);
      send();
      return { ...rule };
    },
    removeRule: (id) => {
      removed.add(id);
      send();
    },
    flush: send,
    settle: ({ final = false, timeoutMs } = {}) =>
      memoryDb.writeRules
        ? writes.drain({ final, timeoutMs, unwritten: () => added.size + removed.size, resend: send })
        : Promise.resolve(0),
  };
}
