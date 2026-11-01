// The settings schema of `image` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const IMAGE: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'image.maxPromptChars',
    'types': ['number'],
    'reader': 'src/behavior/prompt.js',
    'default': 1600,
    'text': 'Scene text clamped to this length',
  },
  {
    'key': 'image.reference',
    'types': ['string'],
    'reader': 'src/media/draw.ts',
    'default': 'avatar',
    'text':
      'Visual reference when the persona is in the picture. `"avatar"` downloads the bot\'s avatar; anything else sends nothing',
  },
  {
    'key': 'image.timeoutMs',
    'types': ['number'],
    'reader': 'src/media/draw.ts',
    'default': 120000,
    'text': 'Request timeout (ms)',
  },
  {
    'key': 'image.retries',
    'types': ['number'],
    'reader': 'src/llm/images.ts',
    'default': 1,
    'text': 'Retries on transient failures',
  },
  {
    'key': 'image.provider',
    'types': ['map', 'null'],
    'reader': 'src/llm/images.ts',
    'default': null,
    'text': 'Provider routing for image requests. `null` sends nothing',
  },
  {
    'key': 'image.openai.quality',
    'types': ['string'],
    'reader': 'src/llm/images.ts',
    'default': 'medium',
    'text': 'Image quality for `openai/*` models',
  },
  {
    'key': 'image.openai.moderation',
    'types': ['string'],
    'reader': 'src/llm/images.ts',
    'default': 'low',
    'text': 'Moderation level for `openai/*` models',
  },
  {
    'key': 'image.google.resolution',
    'types': ['string'],
    'reader': 'src/llm/images.ts',
    'default': '1K',
    'text': 'Output resolution for `google/*` models',
  },
];
