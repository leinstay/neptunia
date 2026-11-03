// The offline persona-layer migration after the plugin mechanism retired: a legacy `plugins.local/` folder is not
// converted and not dropped, so the owner can still find the files it held.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyPersonaLayers } from '../src/setup/persona-migration.ts';
import { tempDir } from './fixtures/tmp.ts';

test('holds the files of a legacy plugins.local folder and copies none of them', () => {
  // Catches a migration that silently drops an unknown legacy folder once nothing reads it any more.
  const base = tempDir('nep-persona-plugins-');
  const options = {
    rootDir: path.join(base, 'engine'),
    privateDir: path.join(base, 'private'),
    dataDir: path.join(base, 'persona'),
  };
  for (const dir of Object.values(options)) fs.mkdirSync(dir);
  fs.mkdirSync(path.join(options.privateDir, 'plugins.local', 'echo'), { recursive: true });
  fs.writeFileSync(path.join(options.privateDir, 'plugins.local', 'echo', 'plugin.json'), '{"name":"echo"}');
  const plan = applyPersonaLayers(options);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(
    plan.held.map((entry) => entry.path),
    ['plugins.local']
  );
  assert.equal(fs.existsSync(path.join(options.privateDir, 'plugins.local', 'echo', 'plugin.json')), true);
  assert.deepEqual(fs.readdirSync(options.dataDir), []);
});
