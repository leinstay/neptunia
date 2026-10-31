// The settings schema of `image` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const IMAGE: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'image.maxPerDay',
    'types': ['number'],
    'reader': 'src/llm/images.js',
    'default': 50,
    'text': 'Daily generation cap',
  },
  {
    'key': 'image.maxPerUserPerDay',
    'types': ['number'],
    'reader': 'src/llm/images.js',
    'default': 50,
    'text': 'Daily cap per member',
  },
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
    'reader': 'src/media/draw.js',
    'default': 'avatar',
    'text':
      'Visual reference when the persona is in the picture. `"avatar"` downloads the bot\'s avatar; anything else sends nothing',
  },
  {
    'key': 'image.referenceMaxBytes',
    'types': ['number'],
    'reader': 'src/media/fetch-image.js',
    'default': 4000000,
    'text': 'Max avatar file size (bytes)',
  },
  {
    'key': 'image.outputFormat',
    'types': ['string'],
    'reader': 'src/llm/images.js',
    'default': 'png',
    'text': 'Output format (`png`, `jpeg`, `webp`)',
  },
  {
    'key': 'image.aspectRatio',
    'types': ['string'],
    'reader': 'src/llm/images.js',
    'default': 'auto',
    'text': 'Aspect ratio. For Google models, `auto` is omitted',
  },
  {
    'key': 'image.timeoutMs',
    'types': ['number'],
    'reader': 'src/media/draw.js',
    'default': 120000,
    'text': 'Request timeout (ms)',
  },
  {
    'key': 'image.retries',
    'types': ['number'],
    'reader': 'src/llm/images.js',
    'default': 1,
    'text': 'Retries on transient failures',
  },
  {
    'key': 'image.provider',
    'types': ['map', 'null'],
    'reader': 'src/llm/images.js',
    'default': null,
    'text': 'Provider routing for image requests. `null` sends nothing',
  },
  {
    'key': 'image.openai.quality',
    'types': ['string'],
    'reader': 'src/llm/images.js',
    'default': 'medium',
    'text': 'Image quality for `openai/*` models',
  },
  {
    'key': 'image.openai.background',
    'types': ['string'],
    'reader': 'src/llm/images.js',
    'default': 'auto',
    'text': 'Background mode for `openai/*` models',
  },
  {
    'key': 'image.openai.moderation',
    'types': ['string'],
    'reader': 'src/llm/images.js',
    'default': 'low',
    'text': 'Moderation level for `openai/*` models',
  },
  {
    'key': 'image.google.resolution',
    'types': ['string'],
    'reader': 'src/llm/images.js',
    'default': '1K',
    'text': 'Output resolution for `google/*` models',
  },
];
