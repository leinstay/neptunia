// What the watcher may read. It runs inside the core's unit, and in the system scope the rendered core service joins the
// group that reads the journal, and a user unit, which cannot set groups, does not name it.
// Changed: the watcher's own unit is gone (owner, 2026-11-09); the core's unit carries the group. Under `ProtectSystem=strict` the unit folder stays
// readable, so a report that said it could not read the folder came from `readUnits`: one failed read of an entry blanks
// the whole category, and a real folder holds `neptunia-core.service.d`, a drop-in directory that `readFileSync` refuses
// with EISDIR. No systemd is touched; the folder is a temporary one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderUnit } from '../src/setup/units.ts';
import type { UnitVars } from '../src/setup/units.ts';
import { collectTrash } from '../src/watcher/trash.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');
const VARS: UnitVars = {
  user: 'someone',
  group: 'someone',
  home: '/home/someone',
  rootDir: '/srv/install',
  privateDir: '/srv/install/data',
  dataDir: '/srv/install/data',
  node: '/usr/bin/node',
};

const rendered = (scope: 'user' | 'system'): Array<string> =>
  renderUnit(fs.readFileSync(path.join(ROOT, 'deploy', 'neptunia-core.service'), 'utf8'), scope, VARS).split('\n');

test('the rendered system core joins the group that reads the journal, and a user core names no group', () => {
  // Bug: the watcher the core starts runs as a user outside `systemd-journal`, journalctl answers nothing, and the report says the
  // server was quiet. A user manager refuses `SupplementaryGroups=` with status 216, so that form must not carry it.
  assert.ok(rendered('system').includes('SupplementaryGroups=systemd-journal'));
  assert.equal(
    rendered('user').some((line) => line.startsWith('SupplementaryGroups=')),
    false
  );
});

function folders() {
  const root = tempDir('nep-watcher-access-');
  const installDir = path.join(root, 'install');
  const unitDir = path.join(root, 'units');
  fs.mkdirSync(installDir);
  fs.mkdirSync(unitDir);
  return { root, installDir, unitDir };
}

const collect = ({ installDir, unitDir }: ReturnType<typeof folders>) =>
  collectTrash({
    installDir,
    // The lead: the watcher left development and reads no checkout (owner, 2026-11-06).
    unitDir,
    env: { NEPTUNIA_UNIT_SCOPE: 'system' },
    run: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
  });

test('a drop-in directory beside the units leaves the unit category readable', async () => {
  // Bug: `neptunia-core.service.d` makes the read of every unit throw, so each report lists the units as unavailable.
  const where = folders();
  fs.writeFileSync(path.join(where.unitDir, 'neptunia-gone.service'), `[Service]\nExecStart=${where.root}/gone/tool\n`);
  fs.mkdirSync(path.join(where.unitDir, 'neptunia-core.service.d'));
  fs.writeFileSync(path.join(where.unitDir, 'neptunia-core.service.d', 'limits.conf'), '[Service]\nMemoryMax=1G\n');
  const trash = await collect(where);
  assert.deepEqual(
    trash.unavailable.filter((one) => one.category === 'units'),
    []
  );
  assert.ok(trash.items.some((item) => item.category === 'units' && item.name === 'neptunia-gone.service'));
});

test('one unreadable unit is left out and the others are still judged', async () => {
  // Bug: a dangling link in the folder has the same effect as the directory, for one leftover file.
  const where = folders();
  fs.writeFileSync(path.join(where.unitDir, 'neptunia-gone.service'), `[Service]\nExecStart=${where.root}/gone/tool\n`);
  fs.symlinkSync(path.join(where.root, 'nowhere'), path.join(where.unitDir, 'neptunia-dangling.service'));
  const trash = await collect(where);
  assert.deepEqual(
    trash.unavailable.filter((one) => one.category === 'units'),
    []
  );
  assert.ok(trash.items.some((item) => item.category === 'units' && item.name === 'neptunia-gone.service'));
});
