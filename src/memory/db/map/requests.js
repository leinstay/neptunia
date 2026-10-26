// Mapper: a journal request dump `journal/requests/<day>/<turnId>-s<n>.json` (the model request and raw answer of one
// step of one turn; the engine keeps three days of them).
//
//   operational   kind request_dump: the dump verbatim, so export restores the file exactly
//   sources       kind answer, id `src:turn:<turnId>:<attemptId>:s<n>`: `think` is the thinking block of the raw
//                 answer, `text` the raw answer. The mapper cannot tell whether the turn's own answer row
//                 (journal.js, `src:turn:<turnId>:<attemptId>`) exists; sync keeps this row only when it does
//                 (`stepSourceBelongsTo`), and fromRows never reads it. The scope is `internal` (a dump does not say
//                 whose chat it was; sync narrows it to the answer row's scope).
//
// toRows(rel, dump, ctx) -> { operational, sources? }      fromRows(rows) -> the dump

import { SCOPE_INTERNAL } from '../scope.ts';
import { operationalRow } from './verbatim.js';
import { fromRows as verbatimFrom } from './verbatim.js';
import { ifaceOf, isPlainObject } from './common.js';

export const fromRows = verbatimFrom;

/** The id of a step's source row. */
export const stepSourceId = (turnId, attemptId, step) => `src:turn:${turnId}:${attemptId}:s${step}`;

/** The id of the turn's own answer row a step source belongs to (the one journal.js makes). */
export const stepSourceBelongsTo = (stepId) => String(stepId).replace(/:s\d+$/, '');

/** The text of the first `<think>` block of a raw answer, or null. */
export function thinkOf(raw) {
  const match = /<think>([\s\S]*?)<\/think>/i.exec(String(raw ?? ''));
  return match ? match[1].trim() : null;
}

export function toRows(rel, dump, ctx = {}) {
  const rows = { operational: [operationalRow('request_dump', rel, dump, ctx)] };
  if (isPlainObject(dump) && typeof dump.turnId === 'string' && dump.turnId && Number.isFinite(dump.step)) {
    const attempt = Number.isFinite(dump.attemptId) ? dump.attemptId : 0;
    rows.sources = [
      {
        id: stepSourceId(dump.turnId, attempt, dump.step),
        kind: 'answer',
        iface: ifaceOf(ctx),
        place_id: null,
        occurred_at: typeof dump.recordedAt === 'string' ? dump.recordedAt : null,
        recorded_at: typeof dump.recordedAt === 'string' ? dump.recordedAt : null,
        turn_id: dump.turnId,
        text: typeof dump.raw === 'string' ? dump.raw : null,
        think: thinkOf(dump.raw),
        ...SCOPE_INTERNAL,
        owner_file: rel,
        position: dump.step,
      },
    ];
  }
  return rows;
}
