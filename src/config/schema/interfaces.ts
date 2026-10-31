// The settings schema of `interfaces` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const INTERFACES: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'interfaces.mode',
    'types': ['string'],
    'reader': 'src/core.js',
    'default': 'inprocess',
    'text':
      "Where the interfaces run. `inprocess` starts the Discord interface inside the core's process. `units` starts the core with no interface, and each interface runs in its own unit (`neptunia interface run <name>`). Read once at the start of `src/index.js`, and any other value stops the start",
  },
  {
    'key': 'interfaces.drainMs',
    'types': ['number'],
    'reader': 'src/core.js',
    'default': 10000,
    'text':
      'How long a disable (`/interface disable`) gives the actions in flight to an interface (milliseconds) before the core ends them `unknown`',
  },
  {
    'key': 'interfaces.*.enabled',
    'types': ['boolean'],
    'reader': 'src/core.js',
    'default': true,
    'text':
      'Whether the interface named in place of `*` may connect. The tracked settings name no interface, so each one is enabled until this key says `false`. A `hello` of a disabled interface is refused with `interface-disabled`, read at each `hello`. `/interface disable` writes `false` here in the private settings file',
  },
];
