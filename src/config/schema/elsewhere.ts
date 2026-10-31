// The settings schema of `elsewhere` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const ELSEWHERE: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'elsewhere.settleSeconds',
    'types': ['number'],
    'reader': 'src/behavior/spontaneous.js',
    'default': 90,
    'text': 'Seconds after the last message in the source channel before the call is answered',
  },
  {
    'key': 'elsewhere.settleMaxSeconds',
    'types': ['number'],
    'reader': 'src/pipeline/settle.ts',
    'default': 300,
    'text': 'Maximum seconds before the answer fires regardless',
  },
  {
    'key': 'elsewhere.rememberPings',
    'types': ['number'],
    'reader': 'src/pipeline/settle.ts',
    'default': 20,
    'text': 'Calls remembered per channel',
  },
  {
    'key': 'elsewhere.pingMaxAgeDays',
    'types': ['number'],
    'reader': 'src/pipeline/call-outcome.ts',
    'default': 7,
    'text': 'Days before a remembered call expires',
  },
];
