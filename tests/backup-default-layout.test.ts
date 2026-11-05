// Where a default install's backups end up and who can read them. `memoryDb.backup.dir` defaults to `../backups/memory`,
// which in a default install is `backups/memory` inside the checkout, so git must ignore it: a copy of `keys.json` must
// never be one `git add` away from a public repository. Each backup folder is 700 and its `keys.json` is 600, whatever
// mode the source happens to have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_DEFAULTS, backupDatabase } from '../src/memory/db/backup.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');

const modeOf = (file: string): number => fs.statSync(file).mode & 0o777;

test('git ignores the backups folder of a default install', () => {
  // Bug: `git status` shows the persona's memory and keys as new files in the checkout, one `git add` from a push.
  const relative = path.join('backups', 'memory', '2026-11-05-030000-memory', 'keys.json');
  const answer = spawnSync('git', ['check-ignore', '-q', relative], { cwd: ROOT });
  assert.equal(answer.status, 0, 'git check-ignore: 0 is ignored, 1 is not');
});

test('the default backup folder is 700 and holds no keys.json, even from a looser source', () => {
  // Bug: a keys.json left at 644 by hand is copied as it is, and every daily backup repeats the leak for a week.
  // The owner's word of 2026-11-05: a backup holds no secret at all, so the key file is left out, not kept at 600.
  const install = tempDir('nep-backup-layout-');
  const data = path.join(install, 'data');
  fs.mkdirSync(data);
  const db = path.join(data, 'memory.db');
  openMemoryDb(db).close();
  fs.writeFileSync(path.join(data, 'keys.json'), '{"core":[]}');
  fs.chmodSync(path.join(data, 'keys.json'), 0o644);
  const to = path.join(path.resolve(data, BACKUP_DEFAULTS.dir), '2026-11-05-030000-memory');
  backupDatabase({ db, data, to, now: () => Date.UTC(2026, 10, 5, 3) });
  assert.equal(modeOf(to), 0o700);
  assert.equal(modeOf(path.dirname(to)), 0o700);
  assert.equal(fs.existsSync(path.join(to, 'keys.json')), false);
});
