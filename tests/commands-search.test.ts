// `/search` and its binding target: quick search apart from the analyzer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { searchCommand } from '../src/interface/commands/search.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { createKeyRing } from '../src/keys/ring.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { createKeyFailover } from '../src/llm/key-failover.ts';
import { roleModel, searchModel } from '../src/llm/roles.ts';
import { tempDir } from './fixtures/tmp.ts';

test('the search commands write the same settings the search reads, and leave the analyzer alone', () => {
  // Bug: `/search model` changes the analyzer's model, or writes a key nothing reads.
  const dataDir = tempDir('nep-search-commands-');
  fs.mkdirSync(path.join(dataDir, 'config'));
  assert.equal(searchCommand(dataDir, 'search.model', { id: 'x/quick' }).status, 'ok');
  assert.equal(searchCommand(dataDir, 'search.engine', { name: 'openrouter' }).status, 'ok');
  assert.equal(searchCommand(dataDir, 'search.engine', { name: 'bing' }).status, 'invalid');
  searchCommand(dataDir, 'search.disable', {});
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'config.json'), 'utf8')) as Record<
    string,
    never
  >;
  assert.equal(searchModel(config), 'x/quick');
  assert.deepEqual(config, { web: { quickSearch: { model: 'x/quick', engine: 'openrouter', enabled: false } } });
  assert.equal(roleModel({ ...config, models: { base: { analyzer: 'x/analyzer' } } }, 'analyzer'), 'x/analyzer');
  assert.match(searchCommand(dataDir, 'search.status', {}).text, /off, engine openrouter, model x\/quick/);
  searchCommand(dataDir, 'search.enable', {});
  assert.match(searchCommand(dataDir, 'search.status', {}).text, /quick search is on/);
});

test('a key bound to search leaves the analyzer on the core keys, and unbinding restores the core keys', () => {
  // Bug: binding quick search moves the analyzer to another key, or an unbind leaves search on the extra key.
  const privateDir = tempDir('nep-search-key-');
  const store = createKeyStore({ privateDir });
  store.addCore({ name: 'core-1', value: 'core-value' });
  store.addExtra({ name: 'searcher', value: 'search-value' });
  store.bind('search', 'searcher');
  const ring = createKeyRing({ store, failover: createKeyFailover({ now: () => 1000 }) });
  assert.equal(ring.route('search')?.value, 'search-value');
  assert.equal(ring.route('analyzer')?.value, 'core-value');
  store.unbind('search');
  assert.equal(ring.route('search')?.value, 'core-value');
});

test('the chat parses the search commands and the binding target', () => {
  // Bug: the table lacks a command the setup promises.
  for (const line of [
    '/search',
    '/search enable',
    '/search disable',
    '/search engine brave',
    '/search model a/b',
    '/keys bind search k',
    '/keys unbind search',
    '/keys check search',
  ]) {
    assert.match(JSON.stringify(parseCommandLine(line)), /"name":"(search|keys)\.[a-z]+"/, line);
  }
});
