// The settings schema of `web` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const WEB: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'web.acceptLanguage',
    'types': ['string'],
    'reader': 'src/web/lookup.ts',
    'default': 'en,ru;q=0.8',
    'text': 'Accept-Language header when a page is read',
  },
  {
    'key': 'web.links.readCacheHours',
    'types': ['number'],
    'reader': 'src/web/lookup.ts',
    'default': 6,
    'text': 'Hours a page read by `web.read` is cached',
  },
  {
    'key': 'web.links.maxOutputTokens',
    'types': ['number'],
    'reader': 'src/behavior/recall.ts',
    'default': 4000,
    'text': 'Max output tokens for the condenser',
  },
  {
    'key': 'web.links.fetchTimeoutMs',
    'types': ['number'],
    'reader': 'src/web/lookup.ts',
    'default': 10000,
    'text': 'Download timeout per page (ms)',
  },
  {
    'key': 'web.search.enabled',
    'types': ['boolean'],
    'reader': 'src/tools/impl/status.ts',
    'default': true,
    'text': 'Whether quick search may run once an engine is chosen. `web.read` does not depend on it',
  },
  {
    'key': 'web.search.engine',
    'types': ['string', 'null'],
    'reader': 'src/web/lookup.ts',
    'default': null,
    'text':
      'The one engine of quick search: `brave`, `exa` or `openrouter`. `null` leaves quick search off, and nothing answers for a chosen engine that fails',
  },
  {
    'key': 'web.search.model',
    'types': ['string', 'null'],
    'reader': 'src/llm/roles.ts',
    'default': null,
    'text':
      'The model of the `openrouter` engine and of the search summary, apart from the analyzer. `null` leaves the `openrouter` engine off',
  },
  {
    'key': 'web.search.rawOutputTokens',
    'types': ['number'],
    'reader': 'src/web/lookup.ts',
    'default': 256,
    'text': "Max output tokens of the `openrouter` engine's request for `web.search`",
  },
  {
    'key': 'web.search.maxOutputTokens',
    'types': ['number'],
    'reader': 'src/llm/openrouter.ts',
    'default': 4000,
    'text': 'Max output tokens for the condenser',
  },
  {
    'key': 'web.search.classifierMaxOutputTokens',
    'types': ['number'],
    'reader': 'scripts/search-policy-eval.ts',
    'default': 2000,
    'text': 'Max output tokens for the search classifier the measuring tools ask (no live turn asks it)',
  },
  {
    'key': 'web.search.cacheHours',
    'types': ['number'],
    'reader': 'src/web/lookup.ts',
    'default': 24,
    'text': 'Hours a cached search result is served',
  },
  {
    'key': 'web.search.timeoutMs',
    'types': ['number'],
    'reader': 'src/behavior/recall-run.ts',
    'default': 10000,
    'text': 'Search request timeout (ms)',
  },
];
