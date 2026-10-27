// The errand store's reads from the database (src/errands/store.js reads through them). `errands.json` is the unit of
// `work` rows and one `operational` row, `errands.jsonl` the unit of `work_events` rows (map/errands.js); both come back
// rebuilt by the export. Pure functions over a read connection.

import { layerDir, unitLines, unitValue } from './common.js';

/** The value of a guild's `errands.json` (`{ found, value }`; not found: no file). */
export const errandsValue = (db, guildId) => unitValue(db, layerDir(guildId, null, 'errands.json'));

/** The lines (JSON text) of a guild's `errands.jsonl`, in file order. */
export const errandEventLines = (db, guildId) => unitLines(db, layerDir(guildId, null, 'errands.jsonl'));
