// `/search` and its chain: quick search apart from the analyzer.
// Changed: quick search runs on its chain `models.routes.search` (spec 2026-11-09-model-routes, slice 4), so the
// test of a key bound to search is deleted with `llm.boundKeys`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { searchCommand } from '../src/interface/commands/search.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { ROLE_DEFAULTS, roleModel, searchModel } from '../src/llm/roles.ts';
import { tempDir } from './fixtures/tmp.ts';

test('the search commands write the same settings the search reads, and leave the analyzer alone', () => {
  // Bug: `/search model` changes the analyzer's model, or writes a key nothing reads.
  const dataDir = tempDir('nep-search-commands-');
  fs.mkdirSync(path.join(dataDir, 'config'));
  const routes = { search: [{ via: 'api', key: 'main', model: 'x/first', effort: null }] };
  fs.writeFileSync(path.join(dataDir, 'config', 'config.json'), JSON.stringify({ models: { routes } }));
  assert.equal(searchCommand(dataDir, 'search.model', { id: 'x/quick' }).status, 'ok');
  assert.equal(searchCommand(dataDir, 'search.engine', { name: 'openrouter' }).status, 'ok');
  assert.equal(searchCommand(dataDir, 'search.engine', { name: 'bing' }).status, 'invalid');
  searchCommand(dataDir, 'search.disable', {});
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'config.json'), 'utf8')) as Record<
    string,
    never
  >;
  assert.equal(searchModel(config), 'x/quick');
  assert.deepEqual(config, {
    models: { routes: { search: [{ via: 'api', key: 'main', model: 'x/quick', effort: null }] } },
    web: { quickSearch: { engine: 'openrouter', enabled: false } },
  });
  assert.equal(roleModel(config, 'analyzer'), ROLE_DEFAULTS.analyzer, 'the analyzer keeps its own model');
  assert.match(searchCommand(dataDir, 'search.status', {}).text, /off, engine openrouter, model x\/quick/);
  searchCommand(dataDir, 'search.enable', {});
  assert.match(searchCommand(dataDir, 'search.status', {}).text, /quick search is on/);
});

test('the chat parses the search commands and the binding target', () => {
  // Bug: the table lacks a command the setup promises.
  for (const line of [
    '/search',
    '/search enable',
    '/search disable',
    '/search engine brave',
    '/search model a/b',
    // Changed: quick search's key is the route of its chain; `/keys bind` and `/keys unbind` are gone.
    '/keys check search',
  ]) {
    assert.match(JSON.stringify(parseCommandLine(line)), /"name":"(search|keys)\.[a-z]+"/, line);
  }
});
