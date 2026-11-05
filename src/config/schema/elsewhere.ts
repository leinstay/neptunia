// The settings schema of `elsewhere` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const ELSEWHERE: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'elsewhere.maxPlaces',
    'types': ['number'],
    'reader': 'src/behavior/elsewhere-pick.ts',
    'default': 40,
    'text': 'Other places offered to the elsewhere pick, the most recently active or attended',
  },
  {
    'key': 'elsewhere.maxEpisodes',
    'types': ['number'],
    'reader': 'src/behavior/elsewhere-pick.ts',
    'default': 30,
    'text': 'Stored exchanges offered to the elsewhere pick, the newest',
  },
  {
    'key': 'elsewhere.maxOutputTokens',
    'types': ['number'],
    'reader': 'src/behavior/elsewhere-pick.ts',
    'default': 120,
    'text': 'Max output tokens for the elsewhere pick',
  },
  {
    'key': 'elsewhere.pickTimeoutMs',
    'types': ['number', 'null'],
    'reader': 'src/behavior/elsewhere-pick.ts',
    'default': 3000,
    'text': 'How long the turn waits for the pick (ms). `null` waits as long as the turn does',
  },
];
