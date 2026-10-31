// The settings schema of `errands` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const ERRANDS: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'errands.opencodePath',
    'types': ['string'],
    'reader': 'bin/neptunia.ts',
    'default': '/opt/opencode/bin/opencode',
    'text': 'Path to the OpenCode binary',
  },
  {
    'key': 'errands.toolResultChars',
    'types': ['number'],
    'reader': 'bin/neptunia.ts',
    'default': 6000,
    'text': 'Cap on each tool result the agent sees',
  },
  {
    'key': 'errands.keepFilesHours',
    'types': ['number'],
    'reader': 'src/agent-runner/sweep.js',
    'default': 24,
    'text': "Hours a task's output files are kept",
  },
  {
    'key': 'errands.recentLines',
    'types': ['number'],
    'reader': 'src/errands/service.ts',
    'default': 6,
    'text': 'Lines of the channel given to the runner as context',
  },
  {
    'key': 'errands.maxOpen',
    'types': ['number'],
    'reader': 'src/errands/store.ts',
    'default': 3,
    'text': 'Errands open at once, all agents together',
  },
  {
    'key': 'errands.resultMaxChars',
    'types': ['number'],
    'reader': 'src/behavior/sandbox.js',
    'default': 3000,
    'text': "Characters of an errand's result in the `<errand_result>` block",
  },
  {
    'key': 'errands.unreadShown',
    'types': ['number'],
    'reader': 'src/errands/blocks.ts',
    'default': 5,
    'text': 'Finished errands with unread results in `<errands>`',
  },
  {
    'key': 'errands.resultRetrySeconds',
    'types': ['number'],
    'reader': 'src/errands/turns.ts',
    'default': 30,
    'text': 'Seconds before a result turn is tried again',
  },
  {
    'key': 'errands.resultCooldownSeconds',
    'types': ['number'],
    'reader': 'src/errands/turns.ts',
    'default': 60,
    'text': 'Seconds between result turns in the same conversation',
  },
];
