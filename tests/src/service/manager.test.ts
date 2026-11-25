// Tests for src/service/manager.ts: the scope of the units, found by the core unit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { unitScope } from '../../../src/service/manager.ts';
import { tempDir } from '../../fixtures/tmp.ts';

test('the user scope is found by the core unit, so setup, service and /logs agree', () => {
  // Catches: the scope read from another unit's timer alone, so a user install with no timer manages system units.
  const config = tempDir('nep-scope-');
  const env = { XDG_CONFIG_HOME: config };
  assert.equal(unitScope(env), 'system');
  fs.mkdirSync(path.join(config, 'systemd', 'user'), { recursive: true });
  fs.writeFileSync(path.join(config, 'systemd', 'user', 'neptunia-core.service'), '[Unit]\n');
  assert.equal(unitScope(env), 'user');
  assert.equal(unitScope({ ...env, NEPTUNIA_UNIT_SCOPE: 'system' }), 'system');
});
