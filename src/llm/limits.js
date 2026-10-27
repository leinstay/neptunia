// The limits that bit during one turn or one memory batch, collected where the cut happens:
// a budget that dropped a block's items, a prompt the provider counted well above its estimate,
// a completion that reached its output cap, messages
// past the per-turn cap joined into the last one kept, a text
// attachment cut at its preview size, a request on a model role other than `core` left behind by the deadline, one that
// failed and was replaced by a fallback (the search classifier's recall on the question's words), a daily
// counter that refused, a memory field refused over its limit or cut on its first write, the
// tool loop's calls dropped once its steps or its time were spent (`loop-cap`). The
// journal's turn and memory records carry the list, so nothing is cut silently. Pure.

/** Every kind a limit entry may have, in the order the design names them. */
export const LIMIT_KINDS = Object.freeze([
  'budget-drop',
  'estimate-off',
  'output-cap',
  // Nothing writes it; journal records of earlier runs carry it and are read back by tools/lib/report.mjs.
  'message-cut',
  'message-merge',
  'preview-cut',
  'helper-timeout',
  'helper-fallback',
  'daily-cap',
  'over-limit',
  'clamp',
  'loop-cap',
]);

const KNOWN = new Set(LIMIT_KINDS);

/**
 * A fresh collector, one per turn attempt or per memory batch.
 * @returns {{
 *   add(entry: { kind: string, where?: string|null, lost?: number|null, detail?: string }): void,
 *   list(): Array<{ kind: string, where: string|null, lost: number|null, detail?: string }>,
 * }}
 *   `add` takes one limit that bit: `kind` (one of LIMIT_KINDS; anything else is ignored),
 *   `where` (the section, field, stage or counter; null when not a string), `lost` (how much was
 *   lost, in the unit of the kind; null when not a finite number) and an optional `detail`
 *   string. `list` returns copies of the entries in the order they were added.
 */
export function createLimits() {
  const entries = [];
  return {
    add(entry) {
      if (!entry || typeof entry !== 'object' || !KNOWN.has(entry.kind)) return;
      const item = {
        kind: entry.kind,
        where: typeof entry.where === 'string' && entry.where ? entry.where : null,
        lost: Number.isFinite(entry.lost) ? entry.lost : null,
      };
      if (typeof entry.detail === 'string' && entry.detail) item.detail = entry.detail;
      entries.push(item);
    },
    list() {
      return entries.map((item) => ({ ...item }));
    },
  };
}
