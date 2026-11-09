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
    'reader': 'src/tools/operations/status.ts',
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
    'reader': 'src/llm/openrouter.ts',
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
    'key': 'llm.reasoningByRole',
    'types': ['map'],
    'reader': 'src/llm/roles.ts',
    'default': {},
    'text':
      'The reasoning effort of a role by role name, `{ "effort": "low" }`, `medium` or `high`, sent as `reasoning` on each request of the role that has no reasoning of its own. Read for `memory`, `analyzer`, `vision` and `video`, never for the core. `/model set <role> <model> --effort <level>` writes it',
  },
  {
    'key': 'llm.keyByRole',
    'types': ['map'],
    'reader': 'src/llm/role-keys.ts',
    'default': {
      'thinker': 'OPENROUTER_DEV_KEY',
      'dev': 'OPENROUTER_DEV_KEY',
      'memory': 'OPENROUTER_MEMORY_KEY',
    },
    'text':
      'Read only while the private layer has no `keys.json`; with one, the key store decides (see [Keys](keys.md)). Maps a role name to the NAME of a `.env` variable holding an OpenRouter key, or to a list of names. The first name of a list is the primary key. When a request gets HTTP 402, or 429 with a body naming credits or balance, the role moves to the next name and the request is repeated once on it; after the last name it goes back to the first. When every key failed within a minute the request fails with `keys-exhausted` and the role counts as down until 00:00 UTC. Read at every request. A role not in the map falls back to `OPENROUTER_CORE_KEY`, except that `scout`, `server` and `drawing` have no entry and get a key from a `keys.json` binding only, never the main key; the `core` role then uses `OPENROUTER_CORE_BACKUP_KEY` as its second key when that variable is set. A name that is not an `OPENROUTER_` variable or is unset is left out. The `memory` role is the exception: with `OPENROUTER_MEMORY_KEY` unset, the session is not configured and no request goes out on any other key',
  },

  {
    'key': 'llm.boundKeys',
    'types': ['map'],
    'reader': 'src/subharness/routing.ts',
    'default': {},
    'text':
      'The extra key of `keys.json` each role goes out on, by role: a base model role or `search`. A role with no entry goes out on the core keys. `/keys bind <role> <name>` writes an entry and `/keys unbind <role>` removes it',
  },
  {
    'key': 'llm.simulationKey',
    'types': ['string', 'null'],
    'reader': 'src/subharness/routing.ts',
    'default': null,
    'text':
      'The extra key of `keys.json` the paid scripts spend. Null is the simulation off, and the scripts refuse to run. `simulation enable --key <name>` sets it and `simulation disable` clears it',
  },
  {
    'key': 'llm.cache.ttl',
    'types': ['string'],
    'reader': 'src/llm/openrouter.ts',
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
  {
    'key': 'llm.subscription.fallback',
    'types': ['boolean'],
    'reader': 'src/subharness/subscription-client.ts',
    'default': false,
    'text':
      "While her core runs through a subscription CLI (`/model set core <model> --via claude-harness` or `--via codex-harness`), `true` sends a step that failed on it, and every later step of that turn, to the API with the same messages. With `false` the step fails and she reads its code. A paid script on the simulation's route (`/model set simulation <model> --via claude-harness`) reads it too and sends such a step to the simulation key. A refusal of the token or daily rail never goes to the API. Read at every failed step",
  },
  {
    'key': 'llm.subscription.thinking',
    'types': ['boolean'],
    'reader': 'src/subharness/subscription-client.ts',
    'default': false,
    'text':
      "`false` turns Claude's native thinking off with `MAX_THINKING_TOKENS=0` and asks Codex for no reasoning summary. Codex has no switch that turns a reasoning model's thinking off. Read at the start of each run",
  },
  {
    'key': 'llm.subscription.holdMs',
    'types': ['number'],
    'reader': 'src/subharness/subscription-client.ts',
    'default': 60000,
    'text':
      'How long a subscription run whose last step ended on tool calls waits for its next step before its process is killed (ms). Read after each such step',
  },
];
