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
    'text':
      'Native ids of the home interface that count as owners until `bot.ownerPerson` is set; the input of that migration',
  },
  {
    'key': 'bot.ownerPerson',
    'types': ['string'],
    'reader': 'src/tools/impl/grants.ts',
    'default': '',
    'text':
      'The person whose bound accounts are the owner, written by `/memory bind <iface> <account> owner`. See [One person, several accounts](memory.md#one-person-several-accounts)',
  },
  {
    'key': 'bot.nameTriggers',
    'types': ['array'],
    'reader': 'src/behavior/sandbox.ts',
    'default': [],
    'text': 'Extra trigger strings besides @mention',
  },
  {
    'key': 'bot.guildId',
    'types': ['string'],
    'reader': 'src/core.ts',
    'default': '',
    'text': 'Server to lock to; auto-detected if in exactly one',
  },
  {
    'key': 'bot.access',
    'types': ['map'],
    'reader': 'src/behavior/sandbox.ts',
    'default': {},
    'text':
      'Who besides owners may run which operations, written by `/tools grant` and `/tools revoke`. See [Access](cli.md#access)',
  },
];
