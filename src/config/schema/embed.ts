// The settings schema of `embed` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const EMBED: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'embed.dimensions',
    'types': ['number'],
    'reader': 'src/llm/embed.js',
    'default': 1024,
    'text': 'Dimensions requested from the embedding model',
  },
  {
    'key': 'embed.batch',
    'types': ['number'],
    'reader': 'src/memory/embedder.js',
    'default': 64,
    'text': 'Lines flushed in one embedding request by the live queue (`embedIndex`)',
  },
  {
    'key': 'embed.flushSeconds',
    'types': ['number'],
    'reader': 'src/core.js',
    'default': 180,
    'text': 'Seconds between live queue flushes',
  },
  {
    'key': 'embed.queueMax',
    'types': ['number'],
    'reader': 'src/memory/embedder.js',
    'default': 2000,
    'text': 'Lines the live queue holds in memory',
  },
  {
    'key': 'embed.catchUpHours',
    'types': ['number'],
    'reader': 'src/core.js',
    'default': 72,
    'text': 'At start and hourly, re-embed anything from this many hours that the index is missing',
  },
  {
    'key': 'embed.catchUpEveryMinutes',
    'types': ['number'],
    'reader': 'src/core.js',
    'default': 60,
    'text': 'Minutes between catch-up sweeps',
  },
];
