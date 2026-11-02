// The settings schema of `heartbeat` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const HEARTBEAT: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'heartbeat.enabled',
    'types': ['boolean'],
    'reader': 'src/behavior/inner/heartbeat.ts',
    'default': true,
    'text': 'Whether she has a periodic heartbeat wake',
  },
  {
    'key': 'heartbeat.everyMinutes',
    'types': ['number'],
    'reader': 'src/behavior/inner/heartbeat.ts',
    'default': 180,
    'text': 'Heartbeat interval (minutes)',
  },
  {
    'key': 'heartbeat.jitterMinutes',
    'types': ['number'],
    'reader': 'src/behavior/inner/heartbeat.ts',
    'default': 60,
    'text': 'Jitter on the heartbeat interval',
  },
  {
    'key': 'heartbeat.historyDays',
    'types': ['number'],
    'reader': 'src/behavior/inner/settings.ts',
    'default': 14,
    'text': "Days of the record read for each person's last contact",
  },
  {
    'key': 'heartbeat.maxTokens',
    'types': ['number'],
    'reader': 'src/behavior/inner/settings.ts',
    'default': 2500,
    'text': 'Token cap of the whole heartbeat block. `0` turns the cap off',
  },
];
