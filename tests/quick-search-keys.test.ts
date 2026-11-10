// B5.1 of the master plan: quick search keeps its own settings under `web.quickSearch.*`, so that no key is spelled
// `web.search.*` (the name belongs to the tool she calls, `web.search`, which stays). The role `search`, its key binding
// and its model setting stay as they are; only the section moves. No network and no real settings of a deployment.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLookup } from '../src/web/lookup.ts';
import type { LookupDeps } from '../src/web/lookup.ts';

import { searchCommand } from '../src/interface/commands/search.ts';

import { localConfigPath } from '../src/config/files.ts';
import { readLocalConfig } from '../src/tools/operations/shared.ts';
import { tempDir } from './fixtures/tmp.ts';
import { objectMediaCache } from '../src/memory/store-media.ts';

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
    store: { ...objectMediaCache({}) },
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

test('/search writes the engine and the switch under web.quickSearch, and the model on the search chain', () => {
  // Bug: the command still writes the old section, which the loader moves on every start.
  const dataDir = tempDir('nep-quick-keys-command-');
  searchCommand(dataDir, 'search.engine', { name: 'exa' });
  // Changed: the model goes on each route of the `search` chain, so a command with no chain writes nothing (slice 4).
  assert.equal(searchCommand(dataDir, 'search.model', { id: 'x/quick' }).status, 'invalid');
  searchCommand(dataDir, 'search.disable', {});
  const web = (readLocalConfig(localConfigPath(dataDir)) as { web?: Settings }).web ?? {};
  assert.deepEqual(web.quickSearch, { engine: 'exa', enabled: false });
  assert.equal(Object.hasOwn(web, 'search'), false);
});
