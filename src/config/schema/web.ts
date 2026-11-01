// The settings schema of `web` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const WEB: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'web.acceptLanguage',
    'types': ['string'],
    'reader': 'src/web/lookup.js',
    'default': 'en,ru;q=0.8',
    'text': 'Accept-Language header when a page is read',
  },
  {
    'key': 'web.links.readCacheHours',
    'types': ['number'],
    'reader': 'src/web/lookup.js',
    'default': 6,
    'text': 'Hours a page read by `web.read` is cached',
  },
  {
    'key': 'web.links.maxOutputTokens',
    'types': ['number'],
    'reader': 'src/behavior/recall.js',
    'default': 4000,
    'text': 'Max output tokens for the condenser',
  },
  {
    'key': 'web.links.fetchTimeoutMs',
    'types': ['number'],
    'reader': 'src/web/lookup.js',
    'default': 10000,
    'text': 'Download timeout per page (ms)',
  },
  {
    'key': 'web.search.enabled',
    'types': ['boolean'],
    'reader': 'src/tools/impl/status.ts',
    'default': true,
    'text': 'Run a search when the classifier fires',
  },
  {
    'key': 'web.search.engine',
    'types': ['string'],
    'reader': 'src/core.js',
    'default': 'brave',
    'text': 'Search engine: `brave`, `exa` or `openrouter`',
  },
  {
    'key': 'web.search.fallback',
    'types': ['array'],
    'reader': 'src/core.js',
    'default': [],
    'text': 'Engines tried in order on failure',
  },
  {
    'key': 'web.search.rawOutputTokens',
    'types': ['number'],
    'reader': 'src/web/lookup.js',
    'default': 256,
    'text': "Max output tokens of the `openrouter` engine's request for `web.search`",
  },
  {
    'key': 'web.search.maxOutputTokens',
    'types': ['number'],
    'reader': 'src/llm/openrouter.js',
    'default': 4000,
    'text': 'Max output tokens for the condenser',
  },
  {
    'key': 'web.search.classifierMaxOutputTokens',
    'types': ['number'],
    'reader': 'tools/search-policy-eval.mjs',
    'default': 2000,
    'text': 'Max output tokens for the search classifier the measuring tools ask (no live turn asks it)',
  },
  {
    'key': 'web.search.cacheHours',
    'types': ['number'],
    'reader': 'src/web/lookup.js',
    'default': 24,
    'text': 'Hours a cached search result is served',
  },
  {
    'key': 'web.search.timeoutMs',
    'types': ['number'],
    'reader': 'src/behavior/recall-run.js',
    'default': 10000,
    'text': 'Search request timeout (ms)',
  },
];
