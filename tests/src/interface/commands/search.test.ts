// `/search`: quick search's engine and enabled state, its model the analyzer's.
// Quick search runs on the analyzer, so no command puts a model or a chain on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { searchCommand } from '../../../../src/interface/commands/search.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { localConfigPath } from '../../../../src/config/files.ts';
import { readLocalConfig } from '../../../../src/tools/operations/shared.ts';

type Settings = Record<string, unknown>;

test('the search commands write the same settings the search reads, and the status names the model that condenses', () => {
  // Bug: the status names a model no search request goes out on, or the commands write a key nothing reads.
  const dataDir = tempDir('nep-search-commands-');
  fs.mkdirSync(path.join(dataDir, 'config'));
  const models = { routes: { analyzer: [{ via: 'api', key: 'main', model: 'x/analyzer', effort: null }] } };
  fs.writeFileSync(path.join(dataDir, 'config', 'config.json'), JSON.stringify({ models }));
  assert.equal(searchCommand(dataDir, 'search.engine', { name: 'openrouter' }).status, 'ok');
  assert.equal(searchCommand(dataDir, 'search.engine', { name: 'bing' }).status, 'invalid');
  searchCommand(dataDir, 'search.disable', {});
  const config: unknown = JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'config.json'), 'utf8'));
  assert.deepEqual(config, { models, web: { quickSearch: { engine: 'openrouter', enabled: false } } });
  assert.match(searchCommand(dataDir, 'search.status', {}).text, /off, engine openrouter, model x\/analyzer/);
  searchCommand(dataDir, 'search.enable', {});
  assert.match(searchCommand(dataDir, 'search.status', {}).text, /quick search is on/);
});

test('/search writes the engine and the switch under web.quickSearch', () => {
  // Bug: the command still writes the old section, which the loader moves on every start.
  const dataDir = tempDir('nep-quick-keys-command-');
  searchCommand(dataDir, 'search.engine', { name: 'exa' });
  // Quick search runs on the analyzer, so no command writes a model for it.
  searchCommand(dataDir, 'search.disable', {});
  const web = (readLocalConfig(localConfigPath(dataDir)) as { web?: Settings }).web ?? {};
  assert.deepEqual(web.quickSearch, { engine: 'exa', enabled: false });
  assert.equal(Object.hasOwn(web, 'search'), false);
});

test('the status command reads off while no engine is set', () => {
  // Bug: `/search status` says on while every search is refused.
  const dataDir = tempDir('nep-quick-search-status-');
  assert.match(searchCommand(dataDir, 'search.status', {}).text, /quick search is off/);
});
