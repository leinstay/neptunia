// The owner's rules (`rules`): one row per rule, its text and when it was added. The store
// (src/memory/store-rules.ts) issues a rule's id and sends each add and each removal to the writer kind `rules`
// (session-write.ts). Removing a rule deletes its row, on the owner's word. `liveRules` reads the rules in the order
// they were added.

import { dbOf, isFiniteNumber } from './types.ts';
import type { Db, MemoryHandle, Row } from './types.ts';

/** One live rule. */
export type Rule = { id: string; text: string };

/** One write: the rules a store added and the ids it removed. */
export type RulesWrite = { added: ReadonlyArray<Rule>; removed: ReadonlyArray<string> };

const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** The stored rules, the first added first. */
export function liveRules(db: Db): Array<Rule> {
  const rows = db.prepare('SELECT id, text FROM rules ORDER BY added_at, rowid').all();
  return rows.flatMap(({ id, text }): Array<Rule> => (filled(id) && filled(text) ? [{ id, text }] : []));
}

/** Stores one write in the caller's transaction: an added rule is inserted, a removed one deleted. */
export function writeRules(db: Db, write: RulesWrite, at: number): { added: number; removed: number } {
  const stamp = new Date(at).toISOString();
  const insert = db.prepare('INSERT OR IGNORE INTO rules (id, text, added_at) VALUES (?, ?, ?)');
  const remove = db.prepare('DELETE FROM rules WHERE id = ?');
  for (const rule of write.added) insert.run(rule.id, rule.text, stamp);
  let removed = 0;
  for (const id of write.removed) removed += Number(remove.run(id).changes ?? 0);
  return { added: write.added.length, removed };
}

/** A write as the writer receives it, checked. */
function rulesWriteOf(update: Row): RulesWrite {
  const refused = Object.assign(new Error('RULES_WRITE'), { code: 'RULES_WRITE' });
  const { added, removed } = update;
  if (!Array.isArray(added) || !Array.isArray(removed)) throw refused;
  const rules = added.map((rule: unknown): Rule => {
    if (rule === null || typeof rule !== 'object') throw refused;
    const { id, text } = rule as Record<string, unknown>;
    if (!filled(id) || !filled(text)) throw refused;
    return { id, text };
  });
  if (!removed.every(filled)) throw refused;
  return { added: rules, removed };
}

/** The write kind `rules` on the writer connection (session-write.ts). */
export function applyRulesWrite(handle: MemoryHandle, update: Row): { added: number; removed: number } {
  const write = rulesWriteOf(update);
  const at = isFiniteNumber(update.now) ? update.now : Date.now();
  return handle.transaction(() => writeRules(dbOf(handle), write, at));
}
