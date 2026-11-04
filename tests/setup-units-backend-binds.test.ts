// src/setup/install.ts and src/setup/units.ts: what the runner units are rendered with. Their binds follow the backends
// installed under `<data>/subharness/`, and the server unit's network reaches the API of each CLI. The templates are the
// real files of deploy/; no systemctl runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { installUnits } from '../src/setup/install.ts';
import type { RunResult, UnitTarget } from '../src/setup/install.ts';
import { renderUnit } from '../src/setup/units.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');

const run = (): Promise<RunResult> => Promise.resolve({ code: 0, stdout: '', stderr: '' });

/** The values of `key` in a rendered unit, its comments left out. */
const valuesOf = (text: string, key: string): Array<string> =>
  text
    .split('\n')
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));

for (const file of ['neptunia-agent-scout.service', 'neptunia-agent-server.service']) {
  test(`${file} binds the installed backend and not the uninstalled one while nothing is connected`, async () => {
    // Catches: the binds follow the connected list, so a role moved to an installed backend finds its folder hidden.
    const base = tempDir('nep-binds-');
    const dataDir = path.join(base, 'data');
    const unitDir = path.join(base, 'units');
    fs.mkdirSync(unitDir);
    writeKeysFile(dataDir, { subharness: { backends: [], key: null, modes: {} } });
    const { binary } = subharnessPlace(dataDir, 'claude');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '#!/bin/sh\n', { mode: 0o755 });
    const target: UnitTarget = {
      system: false,
      user: 'alice',
      group: 'alice',
      home: path.join(base, 'home'),
      rootDir: ROOT,
      privateDir: dataDir,
      dataDir,
      node: '/usr/bin/node',
      unitDir,
    };
    const done = await installUnits(target, run, [file]);
    assert.equal(done.ok, true);
    const unit = fs.readFileSync(path.join(unitDir, file), 'utf8');
    assert.deepEqual(valuesOf(unit, 'BindPaths'), [`-${path.join(dataDir, 'subharness', 'claude')}`]);
  });
}

test("the server unit's network reaches Anthropic's API and Cloudflare's ranges, with everything else denied", () => {
  // Catches: a claude child under the server unit cannot connect at all, or the new range replaces the ones codex needs.
  const template = fs.readFileSync(path.join(ROOT, 'deploy', 'neptunia-agent-server.service'), 'utf8');
  const unit = renderUnit(template, 'system', {
    user: 'alice',
    group: 'alice',
    home: '/home/alice',
    rootDir: '/srv/engine',
    privateDir: '/srv/engine-data',
    dataDir: '/srv/engine-data',
    node: '/usr/bin/node',
    mode: 'read',
  });
  const allowed = valuesOf(unit, 'IPAddressAllow').flatMap((value) => value.split(/\s+/));
  assert.ok(allowed.includes('160.79.104.0/23'), allowed.join(' '));
  assert.ok(allowed.includes('2607:6bc0::/48'), allowed.join(' '));
  assert.ok(allowed.includes('104.16.0.0/13'), allowed.join(' '));
  assert.deepEqual(valuesOf(unit, 'IPAddressDeny'), ['any']);
});
