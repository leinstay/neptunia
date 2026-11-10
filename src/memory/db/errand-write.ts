// The errand store's write (src/errands/store.ts) as the writer's kind `errand` (session-write.ts): one transaction that
// brings the task board to the errand as it stands (src/board/errands.ts#applyErrandSave) and, when the save moves the
// errand to an end, writes its closing `action` line to the journal of the place it names (journal-lines.ts). A failure
// of either writes neither.

import { applyErrandSave } from '../../board/errands.ts';
import { writeJournalLines } from './journal-lines.ts';
import { namedIface } from './live-iface.ts';
import { dbOf, isFiniteNumber } from './types.ts';
import type { MemoryHandle, Row } from './types.ts';

/** One write of the errand store: the errand as it stands (null: only the delivery mark) and the closing line of an end. */
export type ErrandWrite = {
  id: string;
  at: number;
  errand: Row | null;
  delivered: boolean;
  closing: { placeId: string | null; line: Row } | null;
};

/** The write kind `errand` on the writer connection. Answers whether the save moved the errand to an end. */
export function applyErrandWrite(handle: MemoryHandle, update: Row): { ended: boolean } {
  const now = isFiniteNumber(update.now) ? update.now : Date.now();
  const at = new Date(now).toISOString();
  const iface = namedIface(update);
  return handle.transaction(() => {
    const db = dbOf(handle);
    return applyErrandSave(db, update, now, (closing) => {
      writeJournalLines(db, { placeId: closing.placeId, lines: [closing.line] }, iface, at);
    });
  });
}
