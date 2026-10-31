// The settings schema of `route` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const ROUTE: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'route.contextMessages',
    'types': ['number'],
    'reader': 'src/behavior/route.js',
    'default': 20,
    'text': 'Recent channel messages for the classifier',
  },
  {
    'key': 'route.maxChannels',
    'types': ['number'],
    'reader': 'src/behavior/route.js',
    'default': 40,
    'text': 'Channels listed for the classifier',
  },
  {
    'key': 'route.purposeChars',
    'types': ['number'],
    'reader': 'src/behavior/route.js',
    'default': 80,
    'text': "Characters of each channel's stored purpose",
  },
  {
    'key': 'route.maxOutputTokens',
    'types': ['number'],
    'reader': 'src/behavior/route-channel.js',
    'default': 120,
    'text': 'Max output tokens',
  },
];
