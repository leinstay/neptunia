// The settings schema of `relationships` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const RELATIONSHIPS: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'relationships.maxDeltaPerUpdate',
    'types': ['number'],
    'reader': 'src/memory/affinity.js',
    'default': 15,
    'text': 'Max score change per update',
  },
  {
    'key': 'relationships.historySize',
    'types': ['number'],
    'reader': 'src/memory/affinity.js',
    'default': 10,
    'text': 'Attitude changes kept per member',
  },
  {
    'key': 'relationships.shownMoves',
    'types': ['number'],
    'reader': 'src/turn/request/head.ts',
    'default': 4,
    'text': 'Attitude moves shown in `<people_now>`. `0` hides them',
  },
  {
    'key': 'relationships.damping',
    'types': ['boolean'],
    'reader': 'src/memory/affinity.js',
    'default': true,
    'text': 'Damp score changes that push further from zero; changes toward zero apply in full',
  },
  {
    'key': 'relationships.dampingPower',
    'types': ['number'],
    'reader': 'src/memory/affinity.js',
    'default': 1,
    'text': 'Exponent of the damping factor',
  },
  {
    'key': 'relationships.decayPerDay',
    'types': ['number'],
    'reader': 'src/core.js',
    'default': 0.04,
    'text': 'Daily drift toward zero. `0` or missing = off',
  },
  {
    'key': 'relationships.decayPower',
    'types': ['number'],
    'reader': 'src/memory/affinity.js',
    'default': 1,
    'text': 'Exponent of the decay curve',
  },
  {
    'key': 'relationships.rewriteOnBandChange',
    'types': ['boolean'],
    'reader': 'src/memory/affinity.js',
    'default': true,
    'text': 'Flag the stored `relationship` text for rewrite when the attitude band changes',
  },
  {
    'key': 'relationships.rewriteOnDrift',
    'types': ['number'],
    'reader': 'src/memory/affinity.js',
    'default': 8,
    'text': 'Flag for rewrite when the score has drifted this many points. `0` = off',
  },
  {
    'key': 'relationships.rewriteAfterMoves',
    'types': ['number'],
    'reader': 'src/memory/affinity.js',
    'default': 6,
    'text': 'Flag for rewrite after this many history entries. `0` = off',
  },
  {
    'key': 'relationships.bandHysteresis',
    'types': ['number'],
    'reader': 'src/memory/affinity.js',
    'default': 2,
    'text': 'Points past the band edge before a change counts',
  },
  {
    'key': 'relationships.textChars',
    'types': ['number'],
    'reader': 'src/memory/db/describe.js',
    'default': 800,
    'text': 'Max characters for the relationship text',
  },
];
