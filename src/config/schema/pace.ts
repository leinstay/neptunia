// The settings schema of `pace` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const PACE: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'pace.prepareMs',
    'types': ['number'],
    'reader': 'src/turn/phases/request/stages.ts',
    'default': 6000,
    'text':
      "Milliseconds from the turn's start before the voice request. Everything before the LLM call must finish here. `0` removes the limit",
  },
  {
    'key': 'pace.prepareSearchMs',
    'types': ['number'],
    'reader': 'src/turn/lookup.ts',
    'default': 18000,
    'text': 'Extended deadline while the search classifier runs. `0` removes the limit',
  },
  {
    'key': 'pace.prepareMediaMs',
    'types': ['number'],
    'reader': 'src/turn/settings.ts',
    'default': 20000,
    'text': 'Extended deadline on a direct call whose trigger carries a picture, GIF or video. `0` removes it',
  },
  {
    'key': 'pace.dropAfterMs',
    'types': ['number'],
    'reader': 'src/turn/phases/request/setup.ts',
    'default': 120000,
    'text': 'If the finished answer has not arrived by this time, the turn is dropped. `0` removes it',
  },
  {
    'key': 'pace.replyHedgeMs',
    'types': ['number'],
    'reader': 'src/llm/openrouter.js',
    'default': 30000,
    'text':
      'On a direct call, when the reply has no answer after this long, a second request is sent. `0` = one attempt only',
  },
  {
    'key': 'pace.typingWhilePreparing',
    'types': ['boolean'],
    'reader': 'src/turn/settings.ts',
    'default': false,
    'text': 'Show the typing indicator from the start of a turn, not only while the finished answer is typed out',
  },
  {
    'key': 'pace.unpromptedWaits',
    'types': ['boolean'],
    'reader': 'src/turn/phases/request/setup.ts',
    'default': true,
    'text': 'A turn nobody waits for ignores `prepareMs`, `prepareSearchMs` and `dropAfterMs`',
  },
  {
    'key': 'pace.settleMs',
    'types': ['number'],
    'reader': 'src/behavior/pipeline.js',
    'default': 3000,
    'text': 'Wait for the person to stop writing before reading the chat, so quick messages are answered whole',
  },
  {
    'key': 'pace.settleMaxMs',
    'types': ['number'],
    'reader': 'src/turn/sends.ts',
    'default': 8000,
    'text': 'The longest that wait may run from the calling message',
  },
];
