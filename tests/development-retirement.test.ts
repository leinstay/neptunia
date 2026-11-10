// The development run has one way to start: the long-lived worker. The executor beat, its timer and its direct dev run
// are gone from code, units and docs, nothing the persona, the watcher or a wake runs can start an agent, and the
// rendered unit calls no retired word. Read as text and through the setup's own render, without systemd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import * as units from '../src/setup/units.ts';
import type { UnitVars } from '../src/setup/units.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');
const UNIT = 'neptunia-development.service';
const RETIRED_WORDS = [
  'worker selfimprovement',
  'neptunia-selfimprovement',
  'bin/selfimprovement',
  'selfimprovement/service',
  'createSelfimprovement',
  'runSelfimprovement',
  'SELFIMPROVEMENT_UNIT_FILES',
];
const VARS: UnitVars = {
  user: 'alice',
  group: 'alice',
  home: '/home/alice',
  rootDir: '/srv/engine',
  privateDir: '/srv/engine-data',
  dataDir: '/srv/engine-data',
  node: '/home/alice/.nvm/bin/node',
};

/** Every file under the tracked folders a user or an agent reads, as paths from the root; no test and no fixture. */
function trackedText(): Array<string> {
  const walk = (dir: string): Array<string> =>
    fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === 'node_modules') return [];
      const relative = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(relative) : [relative];
    });
  return ['bin', 'deploy', 'docs', 'src', 'scripts', 'prompts', 'agents', 'config'].flatMap(walk);
}

const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** The source files in `dirs` that import `target`, by a relative import ending in that path. */
function importersOf(target: string, dirs: ReadonlyArray<string>): Array<string> {
  return trackedText()
    .filter((file) => file.endsWith('.ts') && dirs.some((dir) => file.startsWith(`${dir}/`) || file === dir))
    .filter((file) => new RegExp(`from '[^']*${target.replaceAll('.', '\\.')}'`).test(read(file)))
    .sort();
}

test('the rendered unit runs the long-lived worker and calls no retired word', () => {
  // Catches: a oneshot that exits after a pass, or a unit that keeps calling the removed subcommand.
  const template = read(path.join('deploy', UNIT));
  for (const scope of ['user', 'system'] as const) {
    const text = units.renderUnit(template, scope, VARS);
    assert.match(text, /^ExecStart=\/home\/alice\/\.nvm\/bin\/node bin\/neptunia\.ts worker development$/m);
    assert.match(text, /^Restart=on-failure$/m);
    assert.doesNotMatch(text, /^Type=oneshot$/m);
    for (const word of RETIRED_WORDS) assert.equal(text.includes(word), false, word);
  }
});

test('stopping the unit takes every agent child with it', () => {
  // Catches: `KillMode=process` leaves a detached agent running after a restart, which then races the resumed run.
  assert.doesNotMatch(read(path.join('deploy', UNIT)), /^KillMode=(process|none)$/m);
});

test('neptunia worker development exists, and says why when it has no way to the board', () => {
  // Catches: the unit starts a subcommand the entry point does not know, or a worker that waits for ever on nothing.
  const dir = tempDir('nep-development-entry-');
  const done = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'neptunia.ts'), 'worker', 'development'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 8000,
    env: { PATH: process.env.PATH, TMPDIR: dir, NEPTUNIA_DATA_DIR: dir },
  });
  assert.equal(done.status, 1, done.stdout + done.stderr);
  assert.match(done.stderr, /board/);
});

test('the agent seam is imported by the worker entry point, and the wake, her tools and the watcher never reach the worker', () => {
  // Catches: a turn, a wake or the watcher gaining a way to start a development run.
  const seam = importersOf('subharness/run.ts', ['bin']);
  assert.ok(seam.includes(path.join('bin', 'development.ts')), seam.join(', '));
  assert.ok(!seam.includes(path.join('bin', 'selfimprovement.ts')), seam.join(', '));
  assert.deepEqual(
    importersOf('development/worker.ts', ['src/behavior', 'src/tools', 'src/watcher', 'src/core.ts', 'src/turn']),
    []
  );
});
