// The explicit legacy export: the value of one unit named by the path a shipped data directory gave it.

import { unitValue } from '../db/readers/common.ts';
import { hasStorageUnits } from '../db/storage-units.ts';
import type { Db } from '../db/types.ts';
import { classify } from './classify.ts';

/**
 * The value of one JSON memory unit, built from the database alone. `relPath` is relative to the data root
 * (`guilds/<id>/users/<id>.json`). Not found, with the reason: `unmapped` (not a memory unit, or not a JSON one),
 * `missing` (the database holds no unit for it), `empty` (the unit has no rows).
 */
export function exportOne(
  database: unknown,
  relPath: string
): { found: true; value: unknown } | { found: false; reason: string } {
  const db = ((database as { db?: Db }).db ?? database) as Db; // an `openMemoryDb` handle or its connection
  const info = classify(relPath);
  if (!info || 'skipped' in info || info.format !== 'json') return { found: false, reason: 'unmapped' };
  const full = info.guildId === undefined ? info.unit : `guilds/${info.guildId}/${info.unit}`;
  const file = hasStorageUnits(db)
    ? db
        .prepare(
          'SELECT 1 FROM legacy_unit_aliases a JOIN storage_units u ON u.id=a.unit_id WHERE a.path=? AND u.retired_at IS NULL'
        )
        .get(full)
    : db.prepare('SELECT 1 AS ok FROM files WHERE path = ? AND gone_at IS NULL').get(full);
  if (!file) return { found: false, reason: 'missing' };
  const read = unitValue(db, full);
  if (!read.found) return { found: false, reason: 'empty' };
  return { found: true, value: JSON.parse(JSON.stringify(read.value)) as unknown };
}
