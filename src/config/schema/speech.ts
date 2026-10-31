// The settings schema of `speech` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const SPEECH: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'speech.voice',
    'types': ['string'],
    'reader': 'src/speech/synth.js',
    'default': 'jessica',
    'text': 'Voice name passed to the speech endpoint',
  },
  {
    'key': 'speech.maxPerDay',
    'types': ['number'],
    'reader': 'src/speech/index.js',
    'default': 100,
    'text': 'Daily voice messages',
  },
  {
    'key': 'speech.maxChars',
    'types': ['number'],
    'reader': 'src/speech/index.js',
    'default': 1500,
    'text': 'Max text characters per voice message',
  },
  {
    'key': 'speech.usdPerMillionChars',
    'types': ['number'],
    'reader': 'src/speech/synth.js',
    'default': 40,
    'text': "Estimated cost for the tool gateway's budget",
  },
  {
    'key': 'speech.timeoutMs',
    'types': ['number'],
    'reader': 'src/speech/synth.js',
    'default': 60000,
    'text': 'Speech request timeout (ms)',
  },
  {
    'key': 'speech.prepareMaxOutputTokens',
    'types': ['number'],
    'reader': 'src/speech/index.js',
    'default': 1500,
    'text': 'Max output tokens for the pronunciation preparation pass',
  },
];
