// The intention store's reads from the database (src/intentions/store.ts reads through them). `intentions.json` is the unit of `intentions` rows and one `operational` row, and
// `intentions-archive.jsonl` the unit of the archived `intentions` rows (map/intentions.ts); both come back rebuilt
// by the export. Pure functions over a read connection.

import { personaKey } from '../storage-keys.ts';
import { unitLines, unitValue } from './common.ts';
import type { Db } from '../types.ts';

/** The persona's active intentions (`{ found, value }`; not found: no unit). */
export const intentionsValue = (db: Db): { found: true; value: unknown } | { found: false } =>
  unitValue(db, { ...personaKey('intentions'), selector: { collection: 'active' } });

/** The lines (JSON text) of the persona's archived intentions, in order. */
export const intentionsArchiveLines = (db: Db): Array<string> =>
  unitLines(db, { ...personaKey('intentions'), selector: { collection: 'archive' } });
