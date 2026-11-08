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
    'key': 'bot.ownerPerson',
    'types': ['string'],
    'reader': 'src/tools/operations/grants.ts',
    'default': '',
    'text':
      "The owner's meta-person, whose bound accounts are the owner: the command line's account, and every account paired with `/interfaces pair` or bound with `/memory bind`. The first line of the command line on a raw install writes it, and so does `/memory bind <iface> <account> owner` while it is empty. See [Owner identity](memory.md#owner-identity)",
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
