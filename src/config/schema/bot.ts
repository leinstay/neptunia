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
      "The owner's meta-person, whose bound accounts are the owner: the command line's account, and every account bound with `/memory bind`. The first line of the command line on a raw install writes it, and so does `/memory bind <iface> <account> owner` while it is empty. See [Owner identity](memory.md#owner-identity)",
  },
  {
    'key': 'bot.mnemonic',
    'types': ['string'],
    'reader': 'src/interface/phrase-codes.ts',
    'default': 'en',
    'text':
      'The language of the word list of the one-time phrases that prove an account, `en` for `src/mnemonic/bip-en` or `ru` for `src/mnemonic/bip-ru`. `/mnemonic` shows it and `/mnemonic en` or `/mnemonic ru` switches it, for the owner only. A phrase issued before a switch is refused after it. See [Phrase codes](interfaces.md#phrase-codes)',
  },
  {
    'key': 'bot.access',
    'types': ['map'],
    'reader': 'src/behavior/sandbox.ts',
    'default': {},
    'text':
      'The tools granted to the persona, each an operation name holding her user id, written by `/tools grant` and `/tools revoke`. See [Access](cli.md#access)',
  },
];
