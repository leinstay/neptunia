// The settings schema of `tools` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const TOOLS: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'tools.safeMode',
    'types': ['boolean'],
    'reader': 'src/tools/access.ts',
    'default': false,
    'text': "Only the persona's reply effects pass; every other tool is refused",
  },
  {
    'key': 'tools.resultMaxChars',
    'types': ['number'],
    'reader': 'src/turn/settings.ts',
    'default': 8000,
    'text': "Characters of a tool's returned data shown in a call's result",
  },
  {
    'key': 'tools.destructiveCooldownMinutes',
    'types': ['number'],
    'reader': 'src/tools/gateway.ts',
    'default': 10,
    'text':
      'Minutes after a destructive skill call that succeeded before the next one of that skill from the same channel',
  },
  {
    'key': 'tools.callTimeoutMs',
    'types': ['number'],
    'reader': 'src/turn/skill-calls.ts',
    'default': 120000,
    'text': 'How long a skill call may run before its outcome is `unknown`',
  },
  {
    'key': 'tools.loop.maxSteps',
    'types': ['number'],
    'reader': 'src/turn/tool-round.ts',
    'default': 100,
    'text': "Most further requests one turn makes after the persona's calls",
  },
  {
    'key': 'tools.loop.timeBudgetMs',
    'types': ['number'],
    'reader': 'src/turn/settings.ts',
    'default': 150000,
    'text': 'How long the calls and follow-ups may run',
  },
  {
    'key': 'tools.loop.maxCallsPerStep',
    'types': ['number'],
    'reader': 'src/turn/settings.ts',
    'default': 8,
    'text': 'Most calls of one answer that run',
  },
  {
    'key': 'tools.loop.stepReserveTokens',
    'types': ['number'],
    'reader': 'src/turn/request/head.ts',
    'default': 6000,
    'text': 'Tokens the first request leaves for the follow-up requests. `0` = no reserve',
  },
  {
    'key': 'tools.loop.remindAfterSteps',
    'types': ['number'],
    'reader': 'src/turn/settings.ts',
    'default': 2,
    'text':
      'Answers with calls in a row after which every further request tells the persona how many they made. `0` = off',
  },
];
