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
  {
    'key': 'cli.mouse',
    'types': ['boolean'],
    'reader': 'bin/neptunia.ts',
    'default': true,
    'text':
      "Whether the chat takes mouse reports: the wheel scrolls the transcript, a drag selects transcript text and copies it to the terminal's clipboard, and a click places the caret in the input. Shift with the mouse still reaches the terminal's own selection in most terminals. Read when the chat opens",
  },
  {
    'key': 'cli.bindings',
    'types': ['array'],
    'reader': 'bin/neptunia.ts',
    'default': [],
    'text':
      'Overrides of the chat keys, each `{ context, key, action }`. A collision or an action the context does not allow shows when the chat opens and is not bound. Read when the chat opens',
  },
];
