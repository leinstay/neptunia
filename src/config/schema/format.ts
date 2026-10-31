// The settings schema of `format` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const FORMAT: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'format.stripDashes',
    'types': ['boolean'],
    'reader': 'src/turn/phases/response.ts',
    'default': true,
    'text':
      'Remove em dashes and en dashes from `<msg>` texts before posting. Guillemets become `"`. Only `false` turns it off',
  },
];
