// The intention store's reads from the database (src/intentions/store.ts reads through them). `intentions.json` is the unit of `intentions` rows and one `operational` row, and
// `intentions-archive.jsonl` the unit of the archived `intentions` rows (map/intentions.ts); both come back rebuilt
// by the export. Pure functions over a read connection.

import { communityKey } from '../storage-keys.ts';
import { LEGACY_IFACE } from '../legacy-namespace.ts';
import { unitLines, unitValue } from './common.ts';
import type { Db } from '../types.ts';

/** The value of a guild's `intentions.json` (`{ found, value }`; not found: no file). */
export const intentionsValue = (
  db: Db,
  guildId: string,
  iface = LEGACY_IFACE
): { found: true; value: unknown } | { found: false } =>
  unitValue(db, communityKey('intentions', guildId, { iface, selector: { collection: 'active' } }));

/** The lines (JSON text) of a guild's `intentions-archive.jsonl`, in file order. */
export const intentionsArchiveLines = (db: Db, guildId: string, iface = LEGACY_IFACE): Array<string> =>
  unitLines(db, communityKey('intentions', guildId, { iface, selector: { collection: 'archive' } }));
