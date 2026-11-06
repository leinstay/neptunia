// The two errand runner units (deploy/neptunia-agent-scout.service, deploy/neptunia-agent-server.service) as
// `neptunia setup` renders them: no `EnvironmentFile` line in any scope or mode, so a key never reaches a runner from a
// file beside the unit. Every key comes with the task. The interface unit keeps its own file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderUnit } from '../src/setup/units.ts';
import type { UnitVars } from '../src/setup/units.ts';

const ROOT = path.join(import.meta.dirname, '..');
const DATA = '/srv/install/data';
const VARS: UnitVars = {
  user: 'someone',
  group: 'someone',
  home: '/home/someone',
  rootDir: '/srv/install',
  privateDir: DATA,
  dataDir: DATA,
  node: '/usr/bin/node',
};

const template = (file: string): string => fs.readFileSync(path.join(ROOT, 'deploy', file), 'utf8');
const environmentFiles = (text: string): Array<string> =>
  text.split('\n').filter((line) => /^\s*EnvironmentFile\s*=/.test(line));

for (const file of ['neptunia-agent-scout.service', 'neptunia-agent-server.service']) {
  for (const scope of ['user', 'system'] as const) {
    for (const mode of ['write', 'full', 'sudo'] as const) {
      test(`${file} rendered for ${scope} in mode ${mode} has no EnvironmentFile line`, () => {
        // Bug: a key copied into <data>/clients/agent-<name>.env is read by the runner and by every unit that can read the folder.
        const unit = renderUnit(template(file), scope, { ...VARS, mode });
        assert.deepEqual(environmentFiles(unit), []);
        assert.doesNotMatch(unit, /agent-(?:scout|server)\.env/);
      });
    }
  }
}

test('the interface unit keeps its EnvironmentFile line', () => {
  // Bug: the runner fix strips the line from every unit, and the interfaces lose their tokens.
  const unit = renderUnit(template('neptunia-interface@.service'), 'system', VARS);
  assert.equal(environmentFiles(unit).length, 1);
});
