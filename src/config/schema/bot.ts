// The settings schema of `bot` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const BOT: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'bot.timezone',
    'types': ['string'],
    'reader': 'src/behavior/diary.ts',
    'default': 'UTC',
    'text': 'Timezone for model timestamps',
  },
  {
    'key': 'bot.owners',
    'types': ['array'],
    'reader': 'src/behavior/core-pause.ts',
    'default': [],
    'text': 'User IDs for owner commands',
  },
  {
    'key': 'bot.nameTriggers',
    'types': ['array'],
    'reader': 'src/behavior/sandbox.js',
    'default': [],
    'text': 'Extra trigger strings besides @mention',
  },
  {
    'key': 'bot.guildId',
    'types': ['string'],
    'reader': 'src/core.js',
    'default': '',
    'text': 'Server to lock to; auto-detected if in exactly one',
  },
  {
    'key': 'bot.dryRunChannelId',
    'types': ['string'],
    'reader': 'src/behavior/limits.js',
    'default': '',
    'text': 'Channel for the dry-run mirror',
  },
  {
    'key': 'bot.access',
    'types': ['map'],
    'reader': 'src/behavior/sandbox.js',
    'default': {},
    'text':
      'Who besides owners may run which operations, written by `/tools grant` and `/tools revoke`. See [Access](cli.md#access)',
  },
];
