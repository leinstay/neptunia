// Archive collections are selected by semantic scope, subject and UTC month.

import { placeOrPersona } from '../storage-keys.ts';
import { listUnits, subjectOf } from '../storage-units.ts';
import { unitLines } from './common.ts';
import type { Db } from '../types.ts';

export function archiveMonths(db: Db, placeId: string | null): Array<string> {
  return listUnits(db, { kind: 'archive', subject: placeOrPersona('archive', placeId).subject })
    .map((unit) => unit.key.partition!)
    .filter(Boolean)
    .sort();
}

export function archiveLines(db: unknown, placeId: string | null, month: string): Array<string> {
  return unitLines(db, placeOrPersona('archive', placeId, { partition: month }));
}

/** Every holder of an archive: the places, and null for the persona's own. */
export function archiveHolders(db: Db): Array<string | null> {
  const holders = new Set<string | null>();
  for (const unit of listUnits(db, { kind: 'archive' })) {
    const subject = subjectOf(unit);
    holders.add(subject.type === 'persona' ? null : subject.id);
  }
  return [...holders].sort((a, b) => String(a).localeCompare(String(b)));
}
