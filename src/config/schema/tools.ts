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
    'reader': 'src/behavior/sandbox.js',
    'default': 4500,
    'text': "Characters of a tool's returned data shown in a call's result",
  },
  {
    'key': 'tools.markTextMaxChars',
    'types': ['number'],
    'reader': 'src/behavior/sandbox.js',
    'default': 200,
    'text': "Characters of the operation's own error message shown in the transcript mark. `0` = never show it",
  },
  {
    'key': 'tools.destructiveCooldownMinutes',
    'types': ['number'],
    'reader': 'src/tools/gateway.ts',
    'default': 10,
    'text': 'Minutes between two destructive skill calls from the same channel',
  },
  {
    'key': 'tools.callTimeoutMs',
    'types': ['number'],
    'reader': 'src/behavior/sandbox.js',
    'default': 120000,
    'text': 'How long a skill call may run before its outcome is `unknown`',
  },
  {
    'key': 'tools.transport',
    'types': ['string'],
    'reader': 'src/behavior/sandbox.js',
    'default': 'native',
    'text':
      'How tools reach the model. `native`: structured tool calls. `text`: tools described in the prompt, calls as `<tool_call>` blocks',
  },
  {
    'key': 'tools.loop.maxSteps',
    'types': ['number'],
    'reader': 'src/turn/tool-round.ts',
    'default': 3,
    'text': 'Most further requests one turn makes after her calls',
  },
  {
    'key': 'tools.loop.timeBudgetMs',
    'types': ['number'],
    'reader': 'src/turn/settings.ts',
    'default': 20000,
    'text': 'How long the calls and follow-ups may run',
  },
  {
    'key': 'tools.loop.maxCallsPerStep',
    'types': ['number'],
    'reader': 'src/turn/settings.ts',
    'default': 4,
    'text': 'Most calls of one answer that run',
  },
  {
    'key': 'tools.loop.stepReserveTokens',
    'types': ['number'],
    'reader': 'src/turn/request/head.ts',
    'default': 6000,
    'text': 'Tokens the first request leaves for the follow-up requests. `0` = no reserve',
  },
];
