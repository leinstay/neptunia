// The settings schema of `board` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const BOARD: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'board.leaseTtlMinutes',
    'types': ['number'],
    'reader': 'src/board/board.ts',
    'default': 30,
    'text': 'Minutes a claim holds a task when the claim or the heartbeat names no lease of its own',
  },
  {
    'key': 'board.autoTriage.role',
    'types': ['string'],
    'reader': 'src/board/board.ts',
    'default': 'dev',
    'text': 'The role `task.add` with `auto` fills in when the caller left it out',
  },
  {
    'key': 'board.autoTriage.budget',
    'types': ['number'],
    'reader': 'src/board/board.ts',
    'default': 4,
    'text': 'The budget in USD `task.add` with `auto` fills in when the caller left it out',
  },
  {
    'key': 'board.autoTriage.steps',
    'types': ['number'],
    'reader': 'src/board/board.ts',
    'default': 80,
    'text': 'The step cap `task.add` with `auto` fills in when the caller left it out',
  },
  {
    'key': 'board.autoTriage.estimate',
    'types': ['number'],
    'reader': 'src/board/board.ts',
    'default': 30,
    'text': 'The estimate in minutes `task.add` with `auto` fills in when the caller left it out',
  },
  {
    'key': 'board.projects',
    'types': ['map'],
    'reader': 'src/board/board.ts',
    'default': {},
    'text':
      'Per project: `autoTriage` overrides the board-wide one field by field, and `ci: false` marks a project without CI, whose tasks a reviewer merges on recorded passing tests',
  },
  {
    'key': 'board.reapSeconds',
    'types': ['number'],
    'reader': 'src/board/board.ts',
    'default': 60,
    'text':
      'Seconds between two beats of the reaper, which returns each task whose lease expired to `approved` (`1` to `3600`)',
  },
  {
    'key': 'board.briefWaitMs',
    'types': ['number'],
    'reader': 'src/board/board.ts',
    'default': 1800000,
    'text': 'Milliseconds `task.next` holds back a task whose answer no reviewer has acted on yet (`0` to 7 days)',
  },
];
