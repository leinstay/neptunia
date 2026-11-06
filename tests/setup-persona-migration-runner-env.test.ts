// The persona-layer migration (src/setup/persona-migration.ts) reads a legacy private folder. A runner's environment
// file (clients/agent-scout.env, clients/agent-server.env) holds keys the runners no longer read, so the migration
// copies it nowhere and the new layer holds no such file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyPersonaLayers, planPersonaLayers } from '../src/setup/persona-migration.ts';
import { tempDir } from './fixtures/tmp.ts';

const SECRET = 'sk-legacy-RUNNER-SECRET';

function legacyFolder() {
  const base = tempDir('nep-runner-env-migration-');
  const options = {
    rootDir: path.join(base, 'engine'),
    privateDir: path.join(base, 'private'),
    dataDir: path.join(base, 'persona'),
  };
  for (const dir of Object.values(options)) fs.mkdirSync(dir);
  fs.mkdirSync(path.join(options.rootDir, 'agents'));
  fs.mkdirSync(path.join(options.rootDir, 'config'));
  fs.writeFileSync(path.join(options.rootDir, 'config', 'labels.json'), '{}');
  fs.mkdirSync(path.join(options.privateDir, 'clients'));
  for (const name of ['agent-scout.env', 'agent-server.env'])
    fs.writeFileSync(path.join(options.privateDir, 'clients', name), `OPENROUTER_ERRAND_KEY=${SECRET}\n`, {
      mode: 0o600,
    });
  return options;
}

const filesUnder = (root: string): Array<string> =>
  fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((one) => one.isFile())
    .map((one) => path.join(one.parentPath, one.name));

test('the plan proposes no step for a runner environment file', () => {
  // Bug: the clients/ folder is copied whole, so the old errand key lands in the new layer.
  const plan = planPersonaLayers(legacyFolder());
  const touched = plan.steps.flatMap((step) => [step.source, step.target]);
  assert.deepEqual(
    touched.filter((one) => /agent-(?:scout|server)\.env$/.test(one)),
    []
  );
});

test('applying the migration writes the old runner key into no file of the new layer', () => {
  // Bug: the key is copied under dataDir or into keys.json although no runner reads it.
  const options = legacyFolder();
  applyPersonaLayers(options);
  const holding = filesUnder(options.dataDir).filter((file) => fs.readFileSync(file, 'utf8').includes(SECRET));
  assert.deepEqual(holding, []);
});
