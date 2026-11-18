// `/search`: quick search's engine and enabled state, its model the analyzer's.
// Changed: quick search runs on the analyzer, so `/search model` and the `search` chain it wrote are gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { searchCommand } from '../src/interface/commands/search.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { tempDir } from './fixtures/tmp.ts';

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

test('the chat parses the search commands and the binding target', () => {
  // Bug: the table lacks a command the setup promises.
  for (const line of [
    '/search',
    '/search enable',
    '/search disable',
    '/search engine brave',
    // Changed: quick search runs on the analyzer, so its routes are checked as the analyzer's.
    '/keys check analyzer',
  ]) {
    assert.match(JSON.stringify(parseCommandLine(line)), /"name":"(search|keys)\.[a-z]+"/, line);
  }
  // Changed: quick search has no chain of its own, so no command puts a model on it.
  assert.doesNotMatch(JSON.stringify(parseCommandLine('/search model a/b')), /"name":"search\.model"/);
});
