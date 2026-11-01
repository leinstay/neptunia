// The settings schema of `skills` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const SKILLS: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'skills.reviewDays',
    'types': ['number'],
    'reader': 'src/skills/settings.ts',
    'default': 30,
    'text': 'Days an active skill may go unread before `/skills` marks it for review; nothing is deleted',
  },
];
