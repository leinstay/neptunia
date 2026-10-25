// The intention store's reads from the database (src/intentions/store.js reads through them). `intentions.json` is the unit of `intentions` rows and one `operational` row, and
// `intentions-archive.jsonl` the unit of the archived `intentions` rows (map/intentions.js); both come back rebuilt
// by the export. Pure functions over a read connection.

import { layerDir, unitLines, unitValue } from './common.js';

/** The value of a guild's `intentions.json` (`{ found, value }`; not found: no file). */
export const intentionsValue = (db, guildId) => unitValue(db, layerDir(guildId, null, 'intentions.json'));

/** The lines (JSON text) of a guild's `intentions-archive.jsonl`, in file order. */
export const intentionsArchiveLines = (db, guildId) => unitLines(db, layerDir(guildId, null, 'intentions-archive.jsonl'));
