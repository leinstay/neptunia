// The settings schema of `missed` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const MISSED: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'missed.sweepDelaySeconds',
    'types': ['number'],
    'reader': 'src/behavior/missed.js',
    'default': 90,
    'text': 'Seconds after the last candidate before the sweep runs',
  },
  {
    'key': 'missed.sweepMaxDelaySeconds',
    'types': ['number'],
    'reader': 'src/behavior/missed.js',
    'default': 240,
    'text': 'The sweep fires no later than this many seconds after the last candidate',
  },
  {
    'key': 'missed.expireMinutes',
    'types': ['number'],
    'reader': 'src/behavior/missed.js',
    'default': 5,
    'text': 'Minutes before a candidate expires. A question mark uses `questionExpireMinutes`',
  },
  {
    'key': 'missed.questionExpireMinutes',
    'types': ['number'],
    'reader': 'src/behavior/missed.js',
    'default': 15,
    'text': 'Expiry for a message with a question mark',
  },
  {
    'key': 'missed.channelCooldownMinutes',
    'types': ['number'],
    'reader': 'src/behavior/missed.js',
    'default': 5,
    'text': 'Minimum minutes between recovery turns in the same channel',
  },
  {
    'key': 'missed.contextMessages',
    'types': ['number'],
    'reader': 'src/behavior/missed.js',
    'default': 20,
    'text': "Recent channel messages included in the analyzer's transcript",
  },
  {
    'key': 'missed.maxOutputTokens',
    'types': ['number'],
    'reader': 'src/behavior/missed.js',
    'default': 2000,
    'text': 'Max output tokens for the analyzer',
  },
];
