// The memory a tool reads: the memory database of a data directory (`<dataDir>/memory.db`, or the file given), opened
// read only with no writer lock, as the `memoryDb` the memory modules take (src/memory/record.js, archive.js,
// vectors.js, store.js, src/intentions/store.js, src/errands/store.js, the recall runner). The seam has no writer, so a
// module built on it reads the database and writes nothing to it. A database that is not there is no memory:
// `memoryDb` is null, and the modules find nothing (the store and the module stores keep their cache only; the
// record's, the archive's and the index's reads answer `DB_CLOSED`).
//
//   readOnlyMemory(dataDir, { file }) -> { memoryDb, close(), found }
//
// The database must be a copy or a quiet file (a live process may write it meanwhile; its readers still see whole
// transactions).

import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../../src/memory/db/open.js';

/**
 * The read-only memory of `dataDir` (see the head of this file). `close()` closes the database; `found` says whether
 * there was one.
 * @param {string} dataDir
 * @param {{ file?: string|null }} [options]  `file`: the database, when not `<dataDir>/memory.db`
 * @returns {{ memoryDb: { readHandle: () => object|null, database: () => object|null }|null, close: () => void, found: boolean }}
 */
export function readOnlyMemory(dataDir, { file = null } = {}) {
  const dbFile = file ?? path.join(dataDir, 'memory.db');
  const handle = fs.existsSync(dbFile) ? openMemoryDb(dbFile, { readOnly: true }) : null;
  let open = handle !== null;
  return {
    memoryDb: handle ? { readHandle: () => (open ? handle : null), database: () => (open ? handle.db : null) } : null,
    close: () => {
      if (!open) return;
      open = false;
      handle.close();
    },
    found: handle !== null,
  };
}
