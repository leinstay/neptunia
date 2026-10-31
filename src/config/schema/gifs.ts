// The settings schema of `gifs` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const GIFS: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'gifs.max',
    'types': ['number'],
    'reader': 'src/turn/request/emoji-gifs.ts',
    'default': 25,
    'text': 'GIFs shown in `<gifs>`',
  },
  {
    'key': 'gifs.reactionChars',
    'types': ['number'],
    'reader': 'src/behavior/gif-pick.js',
    'default': 40,
    'text': 'Characters per reaction label',
  },
  {
    'key': 'gifs.actionChars',
    'types': ['number'],
    'reader': 'src/behavior/gif-pick.js',
    'default': 70,
    'text': 'Characters per action line',
  },
  {
    'key': 'gifs.ownMarkHours',
    'types': ['number'],
    'reader': 'src/behavior/prompt.js',
    'default': 24,
    'text': 'Hours after the persona posts a GIF during which it is named in `<gifs_recent>`. `0` turns it off',
  },
  {
    'key': 'gifs.storeMax',
    'types': ['number'],
    'reader': 'src/memory/gifs.js',
    'default': 300,
    'text': 'GIFs kept in the library',
  },
  {
    'key': 'gifs.halfLifeDays',
    'types': ['number'],
    'reader': 'src/tools/impl/media.ts',
    'default': 30,
    'text': 'Recency half-life (days)',
  },
  {
    'key': 'gifs.maxPerDay',
    'types': ['number'],
    'reader': 'src/memory/gif-watch.js',
    'default': 40,
    'text': 'GIFs the persona may post per day',
  },
  {
    'key': 'gifs.backfillMessages',
    'types': ['number'],
    'reader': 'src/core.js',
    'default': 500,
    'text': 'Messages read per channel at startup to seed the library. `0` disables',
  },
  {
    'key': 'gifs.backfillDescribe',
    'types': ['number'],
    'reader': 'src/memory/gif-backfill.js',
    'default': 20,
    'text': 'Top GIFs described right after the backfill',
  },
  {
    'key': 'gifs.recachePerRun',
    'types': ['number'],
    'reader': 'src/memory/gif-recache.js',
    'default': 50,
    'text': 'Library GIFs re-described per recache run',
  },
  {
    'key': 'gifs.pick.maxChars',
    'types': ['number'],
    'reader': 'src/behavior/gif-pick.js',
    'default': 160,
    'text': 'First message ceiling for the GIF picker',
  },
  {
    'key': 'gifs.pick.contextMessages',
    'types': ['number'],
    'reader': 'src/turn/draw-gif.ts',
    'default': 4,
    'text': 'Chat lines for the picker classifier',
  },
  {
    'key': 'gifs.pick.maxOutputTokens',
    'types': ['number'],
    'reader': 'src/turn/draw-gif.ts',
    'default': 60,
    'text': 'Max output tokens for the picker',
  },
  {
    'key': 'gifs.pick.graceMs',
    'types': ['number', 'null'],
    'reader': 'src/turn/act.ts',
    'default': 1000,
    'text': 'How long the first message waits for the picker past typing. `null` waits indefinitely',
  },
];
