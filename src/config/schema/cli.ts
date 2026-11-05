// The settings schema of `cli` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const CLI: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'cli.paste.collapseLines',
    'types': ['number'],
    'reader': 'bin/neptunia.ts',
    'default': 10,
    'text': 'A paste of more lines than this draws as one chip in the chat input. The turn still gets its exact text',
  },
  {
    'key': 'cli.paste.collapseChars',
    'types': ['number'],
    'reader': 'bin/neptunia.ts',
    'default': 2000,
    'text':
      'A paste of more characters than this draws as one chip in the chat input. The turn still gets its exact text',
  },
];
