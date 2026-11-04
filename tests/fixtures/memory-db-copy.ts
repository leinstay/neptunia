// A migrated memory database of its own for each test: a copy of one template file, because running the migrations
// takes 85 ms per database and these tests open one each. The copies live under TMPDIR and go with the process.
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../../src/memory/db/open.ts';
import { tempDir } from './tmp.ts';

let template: string | null = null;

export function freshMemoryDb(): ReturnType<typeof openMemoryDb> {
  if (template === null) {
    template = path.join(tempDir('nep-memory-template-'), 'memory.db');
    openMemoryDb(template).close();
  }
  const copy = path.join(tempDir('nep-memory-copy-'), 'memory.db');
  fs.copyFileSync(template, copy);
  return openMemoryDb(copy);
}
