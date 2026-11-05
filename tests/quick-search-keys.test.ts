// B5.1 of the master plan: quick search keeps its own settings under `web.quickSearch.*`, so that no key is spelled
// `web.search.*` (the name belongs to the tool she calls, `web.search`, which stays). The role `search`, its key binding
// and its model setting stay as they are; only the section moves. A local config written with the old section keeps its
// meaning through `moveConfigKeys` (src/config-moves.ts), which the loader applies before the local file is laid over
// config.json. No network and no real settings of a deployment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createLookup } from '../src/web/lookup.ts';
import type { LookupDeps } from '../src/web/lookup.ts';
import { searchModel } from '../src/llm/roles.ts';
import { searchCommand } from '../src/interface/commands/search.ts';
import { servicesStep } from '../src/setup/services.ts';
import { readConfig } from '../src/config.ts';
import { moveConfigKeys } from '../src/config-moves.ts';
import { CONFIG_SCHEMA } from '../src/config/schema.ts';
import { localConfigPath } from '../src/config/files.ts';
import { readLocalConfig } from '../src/tools/impl/shared.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { tempDir } from './fixtures/tmp.ts';
import { sourceFiles, readSource, ROOT } from './fixtures/source-tree.ts';

type Settings = Record<string, unknown>;

const FOUND = {
  ok: true,
  results: [{ title: 'Hours', url: 'https://library.example.org/hours', snippet: 'Open until eight.' }],
};

/** A lookup over a fake Brave client whose engine is chosen by `web` of the config it reads. */
function lookupOver(web: Settings) {
  const searched: Array<string> = [];
  const deps = {
    hot: { config: { web, llm: { timeoutMs: 1000 } }, prompts: {} },
    store: { getMediaCache: () => ({}), markMediaCacheDirty: () => {} },
    llm: { complete: () => Promise.resolve({ text: 'unread', usage: {}, estimated: 1 }) },
    pageFetcher: { fetchText: () => Promise.resolve({ ok: false, reason: 'network' }) },
    searches: {
      brave: {
        search: (query: string) => {
          searched.push(query);
          return Promise.resolve(FOUND);
        },
      },
      exa: { search: () => Promise.resolve(FOUND) },
    },
    keys: { brave: 'brave-key', exa: null },
    now: () => 1000,
  } as unknown as LookupDeps;
  return { lookup: createLookup(deps), searched };
}

test('the lookup runs the engine chosen under web.quickSearch', async () => {
  // Bug: the renamed section is written by setup and read by nobody, so quick search stays off.
  const { lookup, searched } = lookupOver({ quickSearch: { enabled: true, engine: 'brave', cacheHours: 24 } });
  assert.equal(lookup.searchEngine(), 'brave');
  assert.equal(lookup.hasSearch(), true);
  await lookup.searchResults('g1', 'opening hours');
  assert.deepEqual(searched, ['opening hours']);
});

test('the lookup does not read an engine left under the old web.search section', () => {
  // Bug: both spellings are read, and an old file keeps working only until someone forgets to migrate it.
  const { lookup } = lookupOver({ search: { enabled: true, engine: 'brave', cacheHours: 24 } });
  assert.equal(lookup.searchEngine(), null);
  assert.equal(lookup.hasSearch(), false);
});

test('the quick-search model is the setting web.quickSearch.model and nothing else', () => {
  // Bug: the model of the `openrouter` engine is read from the old section, so a migrated file loses it.
  assert.equal(searchModel({ web: { quickSearch: { model: 'x/quick' } } }), 'x/quick');
  assert.equal(searchModel({ web: { search: { model: 'x/old' } } }), undefined);
});

test('/search writes the engine, the model and the switch under web.quickSearch', () => {
  // Bug: the command still writes the old section, which the loader moves on every start.
  const dataDir = tempDir('nep-quick-keys-command-');
  searchCommand(dataDir, 'search.engine', { name: 'exa' });
  searchCommand(dataDir, 'search.model', { id: 'x/quick' });
  searchCommand(dataDir, 'search.disable', {});
  const web = (readLocalConfig(localConfigPath(dataDir)) as { web?: Settings }).web ?? {};
  assert.deepEqual(web.quickSearch, { engine: 'exa', model: 'x/quick', enabled: false });
  assert.equal(Object.hasOwn(web, 'search'), false);
});

test('setup writes the engine it was told under web.quickSearch', async () => {
  // Bug: setup and the command disagree about where the engine lives.
  const dataDir = tempDir('nep-quick-keys-setup-');
  const answers = ['', 'openrouter', 'x/quick'];
  await servicesStep({ dataDir }, { ask: () => Promise.resolve(answers.shift() ?? '') });
  const web = (readLocalConfig(localConfigPath(dataDir)) as { web?: Settings }).web ?? {};
  assert.deepEqual(web.quickSearch, { model: 'x/quick', engine: 'openrouter' });
  assert.equal(Object.hasOwn(web, 'search'), false);
});

test('the shipped settings and the schema name the section web.quickSearch', () => {
  // Bug: the tracked default sits under one spelling and the schema documents the other.
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8')) as {
    web: Settings;
  };
  assert.deepEqual(Object.keys(shipped.web.quickSearch as Settings).sort(), [
    'cacheHours',
    'classifierMaxOutputTokens',
    'enabled',
    'engine',
    'maxOutputTokens',
    'model',
    'rawOutputTokens',
    'timeoutMs',
  ]);
  assert.equal(Object.hasOwn(shipped.web, 'search'), false);
  const keys = CONFIG_SCHEMA.map((entry) => entry.key);
  assert.ok(keys.includes('web.quickSearch.engine'));
  assert.deepEqual(
    keys.filter((key) => key.startsWith('web.search.')),
    []
  );
});

test('moves every key of web.search under web.quickSearch and leaves the other web settings', () => {
  const given = {
    web: {
      acceptLanguage: 'en',
      links: { readCacheHours: 6 },
      search: { engine: 'exa', model: 'x/quick', enabled: false, results: 7, fallback: ['brave'] },
    },
  };
  const { config, moved, shadowed } = moveConfigKeys(given);
  assert.deepEqual(config, {
    web: {
      acceptLanguage: 'en',
      links: { readCacheHours: 6 },
      quickSearch: { engine: 'exa', model: 'x/quick', enabled: false, results: 7, fallback: ['brave'] },
    },
  });
  assert.deepEqual(moved.map((move) => move.from).sort(), [
    'web.search.enabled',
    'web.search.engine',
    'web.search.fallback',
    'web.search.model',
    'web.search.results',
  ]);
  assert.deepEqual(shadowed, []);
});

test('a key set under both spellings keeps the new one and reports the old as shadowed', () => {
  const { config, shadowed } = moveConfigKeys({
    web: { search: { engine: 'exa', model: 'x/old' }, quickSearch: { engine: 'brave' } },
  });
  assert.deepEqual(config, { web: { quickSearch: { engine: 'brave', model: 'x/old' } } });
  assert.deepEqual(shadowed, [{ from: 'web.search.engine', to: 'web.quickSearch.engine' }]);
});

test('the move is idempotent', () => {
  const once = moveConfigKeys({ web: { search: { engine: 'exa' } } });
  assert.equal(once.moved.length, 1);
  const twice = moveConfigKeys(once.config);
  assert.deepEqual(twice.config, once.config);
  assert.deepEqual(twice.moved, []);
});

test('the loader reads an old local web.search under its new name, and the cut keys inside it still go', async () => {
  // Bug: a live local file with `web.search.engine` loses quick search at the first start after the rename, or keeps
  // a key the config cut removed because the cut list still knows only the old spelling.
  const root = tempDir('nep-quick-keys-loader-');
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'config', 'config.json'),
    JSON.stringify({ web: { acceptLanguage: 'en', quickSearch: { enabled: true, engine: null, model: null } } })
  );
  fs.mkdirSync(path.join(root, 'data', 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'data', 'config', 'config.json'),
    JSON.stringify({ web: { search: { engine: 'exa', maxPerTurn: 3, results: 9 } } })
  );
  const { result } = await withCapturedLogs(
    () => readConfig(root, { privateDir: path.join(root, 'data') }) as { web: Settings }
  );
  assert.deepEqual(result.web.quickSearch, { enabled: true, engine: 'exa', model: null });
  assert.equal(Object.hasOwn(result.web, 'search'), false);
});

// ---- the lexical gate ---------------------------------------------------------------------------------------------

/** The settings paths and property chains that spell the old section; the tool name `web.search` is no path. */
const OLD_SECTION: ReadonlyArray<RegExp> = [
  /\bweb\??\.search\??\.\w/,
  /\.web\)\??\.search\b/,
  /\[\s*'web'\s*,\s*'search'/,
  /\bweb:\s*\{\s*search\s*:/,
];

test('no source file reads or writes the old web.search section', () => {
  // Bug: one reader keeps the old spelling and quick search works in a test and not in the running engine.
  const found: Array<string> = [];
  for (const file of sourceFiles(['src', 'bin', 'cli', 'interfaces'])) {
    if (file === 'src/config-moves.ts') continue;
    readSource(file)
      .split('\n')
      .forEach((line, index) => {
        if (OLD_SECTION.some((pattern) => pattern.test(line))) found.push(`${file}:${index + 1}`);
      });
  }
  assert.deepEqual(found, []);
});
