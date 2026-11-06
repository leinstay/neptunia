// The settings schema of `selfreflection` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const SELFREFLECTION: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'selfreflection.enabled',
    'types': ['boolean'],
    'reader': 'src/behavior/selfreflection.ts',
    'default': true,
    'text':
      'Whether her selfreflection posts on its day plan. Off, the scheduler plans and posts nothing; a forced post still runs',
  },
  {
    'key': 'selfreflection.schedule',
    'types': ['string', 'null'],
    'reader': 'src/behavior/selfreflection.ts',
    'default': null,
    'text':
      'Exact UTC slots of the selfreflection, `at 09:00,21:00` or `every 6h` laid from the start of the UTC day, which replace `windows` and its quiet days. A change moves the slots ahead on the current day. Null: the windows draw the day',
  },
  {
    'key': 'selfreflection.placeId',
    'types': ['string'],
    'reader': 'src/memory/db/service.ts',
    'default': '',
    'text':
      "The seed of the selfreflection's first mirror: schema v15 makes this channel's place a `selfreflection` mirror, and `scripts/config-migrate.ts --apply --db <memory.db>` then takes the key out of the local file. Nothing else reads it",
  },
  {
    'key': 'selfreflection.world',
    'types': ['boolean'],
    'reader': 'src/behavior/prompt.ts',
    'default': false,
    'text': 'Include `prompts/world.md` as a `<world>` block in selfreflection requests',
  },
  {
    'key': 'selfreflection.windows',
    'types': ['array'],
    'reader': 'src/behavior/selfreflection.ts',
    'default': [
      { 'from': 7, 'to': 11, 'posts': [0, 0] },
      { 'from': 12, 'to': 16, 'posts': [0, 1] },
      { 'from': 18, 'to': 1, 'posts': [0, 2] },
      { 'from': 1, 'to': 5, 'posts': [0, 1] },
    ],
    'text': 'Posting windows in `bot.timezone`. Each has `from`, `to` (hours) and `posts: [min, max]`',
  },
  {
    'key': 'selfreflection.quietDayChance',
    'types': ['number'],
    'reader': 'src/behavior/selfreflection.ts',
    'default': 0.3,
    'text': 'Chance of no posts for the whole day',
  },
  {
    'key': 'selfreflection.forceWaitMs',
    'types': ['number'],
    'reader': 'src/behavior/selfreflection.ts',
    'default': 120000,
    'text': 'Milliseconds a forced post waits for a running turn',
  },
  {
    'key': 'selfreflection.sceneChars',
    'types': ['number'],
    'reader': 'src/turn/request/selfreflection.ts',
    'default': 400,
    'text':
      "Characters of a past picture post's picture description that `<diary>` shows as its scene when the post has no stored plan, cut at a word boundary",
  },
  {
    'key': 'selfreflection.loop.maxSteps',
    'types': ['number'],
    'reader': 'src/turn/settings.ts',
    'default': 2,
    'text': 'Further requests one selfreflection post makes',
  },
  {
    'key': 'selfreflection.loop.timeBudgetMs',
    'types': ['number'],
    'reader': 'src/turn/settings.ts',
    'default': 600000,
    'text': 'How long calls and follow-ups may run',
  },
  {
    'key': 'selfreflection.planMaxOutputTokens',
    'types': ['number'],
    'reader': 'src/turn/selfreflection.ts',
    'default': 2000,
    'text': 'Max output tokens for the plan request',
  },
  {
    'key': 'selfreflection.planTimeoutMs',
    'types': ['number'],
    'reader': 'src/turn/selfreflection.ts',
    'default': 60000,
    'text': 'Timeout for the plan request (ms)',
  },
];
