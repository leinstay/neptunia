// The settings schema of `gifs` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const GIFS: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'gifs.pick.maxOutputTokens',
    'types': ['number'],
    'reader': 'src/turn/draw-gif.ts',
    'default': 60,
    'text': 'Max output tokens for the picker',
  },
];
