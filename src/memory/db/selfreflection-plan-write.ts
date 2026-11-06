// The writer of the owner's plan fill (selfreflection-plan-fill.ts): a reconstructed plan into an old selfreflection entry's
// `extra`, on the writer connection. Kept apart from the run so the writer worker loads no model client.

import { projectRow } from './graph.ts';
import { asText, dbOf } from './types.ts';
import type { MemoryHandle, Row } from './types.ts';

/** A reconstructed plan, as `extra.plan` stores it. */
export type FilledPlan = { brief: string; seeds: Array<Array<string>>; seed: number; reconstructed: true };

/** The entry's metadata when it reads as an object (an empty one for none), else null. */
export function extraOf(raw: unknown): Row | null {
  if (raw === null || raw === undefined || raw === '') return {};
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Row) : null;
  } catch {
    return null;
  }
}

/**
 * The write of `applyMemoryWrite` kind `selfreflection-plan-fill`: `{ id, plan, now? }`, one transaction. The live entry
 * `id` with no plan gains `plan` in its `extra`, every other key kept; an entry with a plan, a retired one and one whose
 * `extra` cannot be read change nothing (`written` 0).
 */
export function applySelfreflectionPlanFill(handle: MemoryHandle, update: Row): { written: number } {
  const plan = update.plan as Row | null | undefined;
  if (!plan || typeof plan !== 'object' || typeof plan.brief !== 'string' || plan.reconstructed !== true)
    throw Object.assign(new Error('BAD_PLAN'), { code: 'BAD_PLAN' });
  const at = new Date(typeof update.now === 'number' ? update.now : Date.now()).toISOString();
  return handle.transaction(() => {
    const db = dbOf(handle);
    const row = db.prepare('SELECT id, extra FROM selfreflection WHERE id = ? AND retired_at IS NULL').get(update.id);
    const extra = row ? extraOf(row.extra) : null;
    if (!row || extra === null || extra.plan !== undefined) return { written: 0 };
    db.prepare('UPDATE selfreflection SET extra = ? WHERE id = ?').run(JSON.stringify({ ...extra, plan }), row.id);
    projectRow(db, 'selfreflection', { id: asText(row.id) }, { at });
    return { written: 1 };
  });
}
