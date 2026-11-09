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
    'key': 'llm.routeRetryMinutes',
    'types': ['number'],
    'reader': 'src/llm/chain-client.ts',
    'default': 30,
    'text':
      'How long a role stays on a later route of its chain after a route was unavailable, before its next request tries the first route again (minutes). Read at each request',
  },
  {
    'key': 'llm.routeEffort',
    'types': ['map'],
    'reader': 'src/llm/chain-client.ts',
    'default': { 'core': 'disabled' },
    'text':
      'The effort a route of a role takes when its text names none, by role, on the scale `disabled`, `low`, `medium`, `high`. On an API route `disabled` sends no `reasoning` and a level sends it as `reasoning.effort`. A harness cannot turn its thinking off, so `disabled` runs it at `low`, its lowest level (`--effort low` for claude, `model_reasoning_effort=low` for codex), and a level runs it at that level. Shipped with `core` at `disabled`. An effort the route names wins. Read at each request',
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
