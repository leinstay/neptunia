// The settings schema of `recall` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const RECALL: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'recall.timeoutMs',
    'types': ['number'],
    'reader': 'src/behavior/recall.ts',
    'default': 15000,
    'text': 'Total time for the recall run',
  },
  {
    'key': 'recall.prefetch.deadlineMs',
    'types': ['number'],
    'reader': 'src/behavior/recall-run.ts',
    'default': 15000,
    'text': 'How long the prefetch may take (ms)',
  },
  {
    'key': 'recall.prefetch.maxTokens',
    'types': ['number'],
    'reader': 'src/behavior/recall.ts',
    'default': 1500,
    'text': 'Most estimated tokens of all excerpts together',
  },
  {
    'key': 'recall.prefetch.contextTokens',
    'types': ['number'],
    'reader': 'src/behavior/recall.ts',
    'default': 500,
    'text': "Most tokens of that lane's lines",
  },
  {
    'key': 'recall.prefetch.trivial',
    'types': ['array'],
    'reader': 'src/behavior/prefetch.ts',
    'default': [
      'hi',
      'hello',
      'hey',
      'yo',
      'ok',
      'okay',
      'k',
      'thanks',
      'thank you',
      'thx',
      'ty',
      'yes',
      'no',
      'yep',
      'nope',
      'lol',
      'haha',
      'good night',
      'good morning',
      'bye',
    ],
    'text': 'Bare greetings that are not searched',
  },
  {
    'key': 'recall.prefetch.deictic',
    'types': ['array'],
    'reader': 'src/behavior/prefetch.ts',
    'default': ['that', 'this', 'it', 'he', 'she', 'they', 'him', 'her', 'them', 'there', 'those', 'these'],
    'text': 'Words that make a trigger deictic',
  },
];
