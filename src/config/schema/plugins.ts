// The settings schema of `plugins` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const PLUGINS: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'plugins.callDeadlineMs',
    'types': ['number'],
    'reader': 'src/plugins/settings.ts',
    'default': 30000,
    'text':
      "How long a call to a plugin's tool may take (milliseconds). Past it the core gives her the result `plugin-no-answer`, and an answer that arrives later is dropped. Read at each call",
  },
  {
    'key': 'plugins.*.enabled',
    'types': ['boolean'],
    'reader': 'src/plugins/settings.ts',
    'default': false,
    'text':
      'Whether the plugin named in place of `*` is on. The tracked settings name no plugin, so each one is off until this key says `true`. A `hello` of a plugin that is off is refused with `plugin-disabled`, read at each `hello`. `/plugins enable` writes `true` here in the private settings file and `/plugins disable` writes `false`',
  },
];
