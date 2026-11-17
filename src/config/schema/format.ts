// The settings schema of `format` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const FORMAT: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'format.stripDashes',
    'types': ['boolean'],
    'reader': 'src/turn/phases/response.ts',
    'default': true,
    'text':
      'Remove em dashes and en dashes from `<msg>` texts and from the text of her own `message.create` and `message.edit` calls before posting. Guillemets become `"`. Only `false` turns it off',
  },
];
