// The settings schema of `wakes`, the wake engine every wake kind shares (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const WAKES: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'wakes.mode',
    'types': ['string'],
    'reader': 'src/behavior/inner.ts',
    'default': 'shadow',
    'text': '`shadow`: reads run, other calls are recorded but never executed. `live`: calls run on her grants',
  },
  {
    'key': 'wakes.tickSeconds',
    'types': ['number'],
    'reader': 'src/core.ts',
    'default': 60,
    'text': 'How often the scheduler looks at what is due',
  },
  {
    'key': 'wakes.caps.perChain',
    'types': ['number'],
    'reader': 'src/behavior/inner.ts',
    'default': 3,
    'text': 'Inner turns of one chain per local day',
  },
  {
    'key': 'wakes.loop.maxSteps',
    'types': ['number'],
    'reader': 'src/turn/settings.ts',
    'default': 4,
    'text': 'Tool loop bounds of an inner turn',
  },
  {
    'key': 'wakes.loop.timeBudgetMs',
    'types': ['number'],
    'reader': 'src/memory/db/service.ts',
    'default': 180000,
    'text': "Time budget of an inner turn's calls",
  },
  {
    'key': 'wakes.loop.maxCallsPerStep',
    'types': ['number'],
    'reader': 'src/turn/settings.ts',
    'default': 4,
    'text': 'Calls per answer of an inner turn',
  },
  {
    'key': 'wakes.loop.callTimeoutMs',
    'types': ['number'],
    'reader': 'src/turn/tool-round.ts',
    'default': 60000,
    'text': 'Max time per call of an inner turn',
  },
  {
    'key': 'wakes.retry.delaysMinutes',
    'types': ['array'],
    'reader': 'src/behavior/inner/settings.ts',
    'default': [1, 5, 15, 60],
    'text': 'Retry delays after a provider failure (minutes)',
  },
  {
    'key': 'wakes.retry.maxHours',
    'types': ['number'],
    'reader': 'src/behavior/inner/settings.ts',
    'default': 6,
    'text': 'Hours before retries stop',
  },
  {
    'key': 'wakes.factsKeepDays',
    'types': ['number'],
    'reader': 'src/behavior/inner/settings.ts',
    'default': 7,
    'text': 'Days an untold fact stays',
  },
  {
    'key': 'wakes.kinds.*.tools',
    'types': ['string', 'array'],
    'reader': 'src/tools/access.ts',
    'default': '*',
    'text': 'The tools a wake of the kind may call: `"*"` (when unset) for every granted tool or a list of tool names',
  },
  {
    'key': 'wakes.kinds.*.maxActs',
    'types': ['number', 'null'],
    'reader': 'src/tools/access.ts',
    'default': null,
    'text': 'The most actions a wake of the kind may take; unset or null: no cap',
  },
  {
    'key': 'wakes.kinds.*.maxTasks',
    'types': ['number', 'null'],
    'reader': 'src/tools/access.ts',
    'default': null,
    'text': 'The most errands a wake of the kind may start; unset or null: no cap',
  },
  {
    'key': 'wakes.kinds.*.inputTokens',
    'types': ['number', 'null'],
    'reader': 'src/tools/access.ts',
    'default': null,
    'text': 'The input token budget of a wake of the kind; unset or null: the loop budget',
  },
];
