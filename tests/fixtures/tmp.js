// Shared temp directories for tests: every directory a test file asks for is removed when the
// file's process exits, so a run leaves nothing behind under the system temp dir (TMPDIR). The
// cleanup hangs off the process rather than one test, because test files create these
// directories at module level, inside shared helpers and inside tests alike, and a failing
// test must not leave its directory behind either. Removing a directory a test already removed
// itself is a no-op.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const created = new Set();
let hooked = false;

function removeAll() {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: a directory that cannot be removed must never turn a green run red.
    }
  }
  created.clear();
}

/**
 * Creates a fresh empty directory under the system temp dir (read at call time, so TMPDIR is
 * honoured) and registers it for removal when the process exits.
 * @param {string} prefix  The directory name's prefix, e.g. 'nep-store-'.
 * @returns {string} The absolute path of the new directory.
 */
export function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.add(dir);
  if (!hooked) {
    hooked = true;
    process.on('exit', removeAll);
  }
  return dir;
}
