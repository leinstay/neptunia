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
  {
    'key': 'skills.run.timeoutMs',
    'types': ['number'],
    'reader': 'src/skills/settings.ts',
    'default': 60000,
    'text': 'How long one `skill.run` script may run; past it the process group is killed and the outcome is unknown',
  },
  {
    'key': 'skills.run.maxOutputBytes',
    'types': ['number'],
    'reader': 'src/skills/settings.ts',
    'default': 1000000,
    'text': 'How much one `skill.run` script may write to stdout before it is stopped',
  },
];
