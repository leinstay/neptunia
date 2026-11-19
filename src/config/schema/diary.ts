// The settings schema of `diary` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const DIARY: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'diary.enabled',
    'types': ['boolean'],
    'reader': 'src/behavior/diary.ts',
    'default': true,
    'text':
      'Whether her diary posts on its day plan. Off, the scheduler plans and posts nothing; a forced post still runs',
  },
  {
    'key': 'diary.schedule',
    'types': ['string', 'null'],
    'reader': 'src/behavior/diary.ts',
    'default': null,
    'text':
      'Exact UTC slots of the diary, `at 09:00,21:00` or `every 6h` laid from the start of the UTC day, which replace `windows` and its quiet days. A change moves the slots ahead on the current day. Null: the windows draw the day',
  },
  {
    'key': 'diary.windows',
    'types': ['array'],
    'reader': 'src/behavior/diary.ts',
    'default': [
      { 'from': 7, 'to': 11, 'posts': [0, 0] },
      { 'from': 12, 'to': 16, 'posts': [0, 1] },
      { 'from': 18, 'to': 1, 'posts': [0, 2] },
      { 'from': 1, 'to': 5, 'posts': [0, 1] },
    ],
    'text': 'Posting windows in `bot.timezone`. Each has `from`, `to` (hours) and `posts: [min, max]`',
  },
  {
    'key': 'diary.quietDayChance',
    'types': ['number'],
    'reader': 'src/behavior/diary.ts',
    'default': 0.3,
    'text': 'Chance of no posts for the whole day',
  },
  {
    'key': 'diary.voiceChance',
    'types': ['number'],
    'reader': 'src/behavior/diary.ts',
    'default': 0.1,
    'text':
      'Chance, from 0 to 1, that an entry of a kind with no picture is voiced when the turn offers `voice.say`; 0 voices none. Read at each entry',
  },
  {
    'key': 'diary.writerEntries',
    'types': ['number'],
    'reader': 'src/turn/request/diary.ts',
    'default': 30,
    'text': 'How many of the newest stored entries `<diary>` shows the diary turn, newest first',
  },
  {
    'key': 'diary.loop.maxSteps',
    'types': ['number'],
    'reader': 'src/turn/settings.ts',
    'default': 50,
    'text': 'Further requests one diary post makes',
  },
  {
    'key': 'diary.loop.timeBudgetMs',
    'types': ['number'],
    'reader': 'src/turn/settings.ts',
    'default': 1000000,
    'text': 'How long calls and follow-ups may run',
  },
];
