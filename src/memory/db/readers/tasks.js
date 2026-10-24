// The errand task store's reads from the database (stage W1; src/errands/store.js dispatches to them under
// authority `db`). `tasks.json` is the unit of `work` rows and one `operational` row, `tasks.jsonl` the unit of
// `work_events` rows (map/tasks.js); both come back rebuilt by the export. Pure functions over a read connection.

import { layerDir, unitLines, unitValue } from './common.js';

/** The value of a guild's `tasks.json` (`{ found, value }`; not found: no file). */
export const tasksValue = (db, guildId) => unitValue(db, layerDir(guildId, null, 'tasks.json'));

/** The lines (JSON text) of a guild's `tasks.jsonl`, in file order. */
export const taskEventLines = (db, guildId) => unitLines(db, layerDir(guildId, null, 'tasks.jsonl'));
