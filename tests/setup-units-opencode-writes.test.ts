// src/setup/units.ts with src/subharness/place.ts: every folder an opencode child writes lies in a path its runner unit
// leaves writable. Under `ProtectHome=tmpfs` the home is an empty read-only tmpfs and `ProtectSystem=strict` makes the
// rest read-only, so a folder opencode derives from HOME is unwritable there: with no XDG_CACHE_HOME, `opencode --version`
// fails `EACCES: mkdir ~/.cache` and exits 1 inside the scout's unit (measured 2026-11-05 with a transient unit of the
// same settings). The child is a fake opencode that writes its environment to a file; the templates are deploy/'s own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInstalledBackend } from '../src/agent-runner/backend.ts';
import { renderUnit } from '../src/setup/units.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');

/** The values of `key` in a rendered unit, its comments left out. */
const valuesOf = (text: string, key: string): Array<string> =>
  text
    .split('\n')
    .filter((line) => line.startsWith(`${key}=`))
    .flatMap((line) => line.slice(key.length + 1).split(/\s+/))
    .filter(Boolean);

/** The paths a unit lets its processes write: its writable binds and paths, and its own /tmp. */
function writablePaths(unit: string): Array<string> {
  const listed = [...valuesOf(unit, 'BindPaths'), ...valuesOf(unit, 'ReadWritePaths')].map((one) =>
    one.replace(/^-/, '')
  );
  return /^PrivateTmp=yes$/m.test(unit) ? [...listed, '/tmp', '/var/tmp'] : listed;
}

const inside = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/** The folders opencode writes, from the environment it was started with: each XDG home, or its default under HOME. */
function opencodeWrites(env: Record<string, string>): Record<string, string> {
  const home = env.HOME ?? os.homedir();
  return {
    XDG_CONFIG_HOME: env.XDG_CONFIG_HOME ?? path.join(home, '.config'),
    XDG_DATA_HOME: env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: env.XDG_CACHE_HOME ?? path.join(home, '.cache'),
    XDG_STATE_HOME: env.XDG_STATE_HOME ?? path.join(home, '.local', 'state'),
  };
}

/** The environment an installed opencode is started with, read back from a fake binary that writes it to a file. */
async function childEnv(dataDir: string): Promise<Record<string, string>> {
  const dump = path.join(tempDir('nep-oc-env-'), 'env');
  const { binary } = subharnessPlace(dataDir, 'opencode');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, `#!/bin/sh\nenv > ${JSON.stringify(dump)}\nexit 0\n`, { mode: 0o755 });
  await createInstalledBackend('opencode', dataDir).run('B', { cwd: dataDir, timeoutMs: 5_000, env: {} });
  return Object.fromEntries(
    fs
      .readFileSync(dump, 'utf8')
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
  );
}

for (const [file, mode] of [
  ['neptunia-agent-scout.service', 'write'],
  ['neptunia-agent-server.service', 'read'],
] as const) {
  test(`${file} leaves every folder an opencode child writes writable`, async () => {
    // Bug: opencode derives its cache folder from HOME, which the unit mounts as an empty read-only tmpfs, so every
    // opencode run of the agent exits 1 within a second while the same run outside the unit answers.
    const dataDir = tempDir('nep-oc-unit-');
    const env = await childEnv(dataDir);
    const template = fs.readFileSync(path.join(ROOT, 'deploy', file), 'utf8');
    const unit = renderUnit(template, 'system', {
      user: 'alice',
      group: 'alice',
      home: env.HOME ?? os.homedir(),
      rootDir: ROOT,
      privateDir: dataDir,
      dataDir,
      node: process.execPath,
      mode,
      backends: ['opencode'],
    });
    const writable = writablePaths(unit);
    for (const [name, dir] of Object.entries(opencodeWrites(env)))
      assert.ok(
        writable.some((one) => inside(dir, one)),
        `${name} ${dir} lies in no writable path of the unit: ${writable.join(' ')}`
      );
  });
}
