// The settings schema of `llm` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const LLM: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'llm.baseUrl',
    'types': ['string'],
    'reader': 'src/llm/openrouter.ts',
    'default': 'https://openrouter.ai/api/v1',
    'text': 'Chat completions endpoint',
  },
  {
    'key': 'llm.maxOutputTokens',
    'types': ['number'],
    'reader': 'src/llm/openrouter.ts',
    'default': 2000,
    'text': 'Max output tokens',
  },
  {
    'key': 'llm.maxRequestTokens',
    'types': ['number'],
    'reader': 'src/behavior/sandbox.ts',
    'default': 50000,
    'text': 'Hard token cap per request',
  },
  {
    'key': 'llm.timeoutMs',
    'types': ['number'],
    'reader': 'src/llm/openrouter.ts',
    'default': 300000,
    'text': 'Request timeout (ms)',
  },
  {
    'key': 'llm.probeTimeoutMs',
    'types': ['number'],
    'reader': 'src/tools/impl/status.ts',
    'default': 30000,
    'text': 'Timeout of each model probe and of the key reads of the status card (ms)',
  },
  {
    'key': 'llm.analyzerTimeoutMs',
    'types': ['number'],
    'reader': 'src/llm/embed.ts',
    'default': 30000,
    'text':
      "Timeout of a request on a model role other than the core's, made alongside the turn (route classifier, search classifier, recall summary). Past this the request is abandoned",
  },
  {
    'key': 'llm.retries',
    'types': ['number'],
    'reader': 'src/llm/embed.ts',
    'default': 2,
    'text': 'Retries on transient HTTP errors (408/429/5xx) and network failures. A daily-quota 429 is thrown at once',
  },
  {
    'key': 'llm.maxRequestsPerDay',
    'types': ['number'],
    'reader': 'src/behavior/pull-fetch.ts',
    'default': 5000,
    'text': 'Daily request cap',
  },
  {
    'key': 'llm.provider',
    'types': ['map', 'null'],
    'reader': 'src/llm/openrouter.ts',
    'default': null,
    'text': 'OpenRouter `provider` routing object, passed verbatim',
  },
  {
    'key': 'llm.providerByModel',
    'types': ['map'],
    'reader': 'src/llm/embed.ts',
    'default': {},
    'text': 'Per-model provider routing. See the resolution order below',
  },
  {
    'key': 'llm.keyByRole',
    'types': ['map'],
    'reader': 'src/core.ts',
    'default': {
      'scout': 'OPENROUTER_ERRAND_KEY',
      'server': 'OPENROUTER_ERRAND_KEY',
      'drawing': 'OPENROUTER_ERRAND_KEY',
      'thinker': 'OPENROUTER_DEV_KEY',
      'dev': 'OPENROUTER_DEV_KEY',
      'memory': 'OPENROUTER_MEMORY_KEY',
    },
    'text':
      'Read only while the private layer has no `keys.json`; with one, the key store decides (see [Keys](keys.md)). Maps a role name to the NAME of a `.env` variable holding an OpenRouter key, or to a list of names. The first name of a list is the primary key. When a request gets HTTP 402, or 429 with a body naming credits or balance, the role moves to the next name and the request is repeated once on it; after the last name it goes back to the first. When every key failed within a minute the request fails with `keys-exhausted` and the role counts as down until 00:00 UTC. Read at every request. A role not in the map falls back to `OPENROUTER_CORE_KEY`; the `core` role then uses `OPENROUTER_CORE_BACKUP_KEY` as its second key when that variable is set. A name that is not an `OPENROUTER_` variable or is unset is left out. The `memory` role is the exception: with `OPENROUTER_MEMORY_KEY` unset, the session is not configured and no request goes out on any other key',
  },
  {
    'key': 'llm.keys',
    'types': ['map'],
    'reader': 'src/core.ts',
    'default': {},
    'text':
      'Read only while the private layer has no `keys.json`; with one, each core key carries its own grant (see [Keys](keys.md)). The grant of each key, by the NAME of its `.env` variable: `{ "grant": USD, "resetDay": 1 to 31 }`. The balance of a key is its grant minus the cost of the requests that went out on it since the last reset (00:00 UTC on `resetDay`, the last day of a shorter month), summed from `data/usage.json`; no call to the provider. The balances of the core keys set the turns line of her wake view. A key without an entry counts 0 and is named on the status card as unconfigured',
  },
  {
    'key': 'llm.cache.ttl',
    'types': ['string'],
    'reader': 'src/behavior/prompt.ts',
    'default': '1h',
    'text': 'Cache TTL for the markers on the system message and the stable user prefix: `"1h"` or `"5m"`',
  },
  {
    'key': 'llm.cache.roles',
    'types': ['array'],
    'reader': 'src/llm/openrouter.ts',
    'default': ['core'],
    'text': 'Model roles whose requests get the cache marker. Add `analyzer` to cache its requests too',
  },
  {
    'key': 'llm.cache.models',
    'types': ['array'],
    'reader': 'src/llm/openrouter.ts',
    'default': ['anthropic/'],
    'text': 'Model id prefixes whose provider accepts the `cache_control` marker',
  },
  {
    'key': 'llm.hedge.roles',
    'types': ['array'],
    'reader': 'src/llm/openrouter.ts',
    'default': ['analyzer'],
    'text': 'Roles whose calls are hedged (two concurrent attempts, first to finish wins)',
  },
  {
    'key': 'llm.hedge.afterMs',
    'types': ['number'],
    'reader': 'src/llm/openrouter.ts',
    'default': 2500,
    'text': 'Milliseconds before the second attempt starts. `0` or below turns hedging off',
  },
  {
    'key': 'llm.hedge.timeoutMs',
    'types': ['number'],
    'reader': 'src/llm/openrouter.ts',
    'default': 8000,
    'text': "Milliseconds from the first attempt's start at which both are aborted if neither returned",
  },
  {
    'key': 'llm.hedge.longTimeoutMs',
    'types': ['number'],
    'reader': 'src/llm/openrouter.ts',
    'default': 20000,
    'text':
      'Timeout used when the caller marks the request `long: true` (the route classifier does this for a large channel list)',
  },
];
