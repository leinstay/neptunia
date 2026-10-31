// The settings schema of `avatars` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const AVATARS: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'avatars.intervalMs',
    'types': ['number'],
    'reader': 'src/core.js',
    'default': 20000,
    'text': 'Milliseconds between avatar requests',
  },
  {
    'key': 'avatars.maxPerDay',
    'types': ['number'],
    'reader': 'src/memory/avatar-queue.js',
    'default': 60,
    'text': 'Avatar requests per UTC day',
  },
  {
    'key': 'avatars.descriptionChars',
    'types': ['number'],
    'reader': 'src/memory/avatar-queue.js',
    'default': 200,
    'text': 'Characters kept per description',
  },
];
