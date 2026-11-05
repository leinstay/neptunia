// scripts/config-migrate.ts and the config cut on `errands.backend`: the key left the settings when the subharness took
// over the agent backend, so a local layer that still holds it loses it, with a line that says where the choice is made now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../scripts/config-migrate.ts';
import { cutConfigKeys } from '../src/config/cut.ts';
import { tempDir } from './fixtures/tmp.ts';

test('the cut takes errands.backend out of a local layer and keeps its neighbours', () => {
  // Bug: the key stays and /config check reports it as unknown after the schema row left.
  const { config, cut } = cutConfigKeys({ errands: { backend: 'claude', maxOpen: 5 } });
  assert.deepEqual(cut, ['errands.backend']);
  assert.deepEqual(config, { errands: { maxOpen: 5 } });
});

test('the migration names the account command on the line it drops errands.backend with', async () => {
  // Bug: the owner's choice of backend vanishes from the file and nothing says where to make it again.
  const file = path.join(tempDir('nep-migrate-'), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ errands: { backend: 'claude' } }));
  const report = await main(['--dry-run', '--file', file]);
  const line = report.split('\n').find((one) => one.startsWith('errands.backend dropped'));
  // Changed: a subharness has no enable step, its login makes it available.
  assert.ok(line?.includes('subharness <codex|claude|opencode> login'));
});
