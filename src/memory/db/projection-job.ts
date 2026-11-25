// The writer's projection job (write kind `project`, session-write.ts): one tick of the graph projection a migration left
// pending (graph.ts#projectPending) and the stems of new lines (stems.ts#fillStems). The service runs it while either is
// due (service.ts#startProject).

import { graphPending, projectPending } from './graph.ts';
import { fillStems, stemsPending } from './stems.ts';
import { dbOf, isFiniteNumber, isWholeNumber } from './types.ts';
import type { MemoryHandle, Row } from './types.ts';

/** One run of the job: `sliceUnits` and `maxSlices` bound the projection. Answers what it projected and stamped. */
export function applyProjectWrite(handle: MemoryHandle, update: Row): { units: number; done: boolean; stems: number } {
  const at = new Date(isFiniteNumber(update.now) ? update.now : Date.now()).toISOString();
  // The projection and the stems run their own transactions.
  return project(handle, update, at);
}

function project(handle: MemoryHandle, update: Row, at: string): { units: number; done: boolean; stems: number } {
  const out = { units: 0, done: true, stems: 0 };
  if (graphPending(handle)) {
    const slice = isWholeNumber(update.sliceUnits) && update.sliceUnits > 0 ? update.sliceUnits : undefined;
    const projected = projectPending(handle, {
      at,
      ...(slice ? { sliceUnits: slice } : {}),
      maxSlices: isWholeNumber(update.maxSlices) && update.maxSlices > 0 ? update.maxSlices : 1,
    });
    out.units = projected.units;
    out.done = projected.done;
  }
  if (stemsPending(dbOf(handle))) out.stems = fillStems(dbOf(handle))?.stamped ?? 0;
  return out;
}
