// The settings schema of `bot` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const BOT: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'bot.timezone',
    'types': ['string'],
    'reader': 'src/behavior/selfreflection.ts',
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
      'The person whose bound accounts are the owner, written by the first line of the command line on a raw install and by `/memory bind <iface> <account> owner`. See [Owner identity](memory.md#owner-identity)',
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
