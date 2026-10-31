// The settings schema of `discord` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const DISCORD: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'discord.intents.presences',
    'types': ['boolean'],
    'reader': 'interfaces/discord/session.ts',
    'default': false,
    'text':
      "Request the privileged Presence intent so the persona can see members' activities in `<people_now>`. Read once at startup; a change needs a restart. The intent must also be enabled in the Discord Developer Portal",
  },
  {
    'key': 'discord.intents.members',
    'types': ['boolean'],
    'reader': 'interfaces/discord/session.ts',
    'default': false,
    'text':
      "Request the privileged Server Members intent. Same startup/restart rules. `avatars` uses it to see a changed avatar at once; without it a change is seen at the member's next message or the daily scan",
  },
];
