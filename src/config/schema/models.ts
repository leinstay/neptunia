// The settings schema of `models` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const MODELS: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'models.base.core',
    'types': ['string', 'boolean'],
    'reader': 'src/llm/openrouter.ts',
    'default': 'anthropic/claude-opus-4.6',
    'text': "The persona's model. Purposes: `reply`, `memory-voice`",
  },
  {
    'key': 'models.base.memory',
    'types': ['string', 'boolean'],
    'reader': 'src/llm/roles.ts',
    'default': 'anthropic/claude-opus-4.6',
    'text':
      'Her memory session and description review model. Same default as `core`, not a copy. Its key is `llm.keyByRole.memory` and never falls back',
  },
  {
    'key': 'models.base.analyzer',
    'types': ['string', 'boolean'],
    'reader': 'src/behavior/mention.ts',
    'default': 'openai/gpt-6.1-sol',
    'text':
      'Picks options (address, room, route, split, gif-pick, missed, etc.), plans searches and turns sources into notes. Pin one purpose to another model with `byPurpose`',
  },
  {
    'key': 'models.base.vision',
    'types': ['string', 'boolean', 'null'],
    'reader': 'src/behavior/mention.ts',
    'default': null,
    'text': 'Describes pictures (describe, relook, avatar). Off while null',
  },
  {
    'key': 'models.base.video',
    'types': ['string', 'boolean', 'null'],
    'reader': 'src/behavior/mention.ts',
    'default': null,
    'text': 'Watches video and GIFs, looks again on questions. Off while null',
  },
  {
    'key': 'models.base.embedding',
    'types': ['string', 'boolean'],
    'reader': 'src/llm/embed.ts',
    'default': 'openai/text-embedding-3-large',
    'text': 'Turns text into vectors for meaning search. `embed.dimensions` sets the width',
  },
  {
    'key': 'models.base.speech',
    'types': ['string', 'boolean', 'null'],
    'reader': 'src/speech/synth.ts',
    'default': null,
    'text': 'Speaks her text aloud through the speech endpoint. Named on the status card, never probed. Off while null',
  },
  {
    'key': 'models.base.drawing',
    'types': ['string', 'boolean', 'null'],
    'reader': 'src/llm/images.ts',
    'default': null,
    'text': 'Generates pictures through the Images API. Only `openai/*` and `google/*` families. Off while null',
  },
  {
    'key': 'models.byPurpose',
    'types': ['map'],
    'reader': 'src/llm/embed.ts',
    'default': {},
    'text':
      "Model ids keyed by purpose string (`reply`, `lookup`, `recall-summary`, `diary-plan`, `planner`, `web-search` and the like). A match on purpose wins over the role's model. Not probed by the status card",
  },
  {
    'key': 'models.abilities',
    'types': ['map'],
    'reader': 'src/llm/roles.ts',
    'default': {
      'anthropic/claude-opus-4.6': ['text', 'imagesIn'],
      'google/gemini-3.8-flash': ['text', 'imagesIn', 'videoIn'],
      'openai/text-embedding-3-large': ['embeddings'],
      'elevenlabs/eleven-v4': ['audioOut'],
      'openai/gpt-image-2.5-flare': ['imagesOut'],
    },
    'text':
      'What each model can do, keyed by model id: a list of `text`, `imagesIn`, `imagesOut`, `videoIn`, `audioOut` and `embeddings`. A model without an entry has `text` only',
  },
  {
    'key': 'models.errands.scout',
    'types': ['string'],
    'reader': 'src/agent-runner/opencode.ts',
    'default': 'openrouter/openai/gpt-6.1-sol',
    'text': 'OpenCode model id of the scout errand agent',
  },
  {
    'key': 'models.errands.server',
    'types': ['string'],
    'reader': 'src/agent-runner/opencode.ts',
    'default': 'openrouter/openai/gpt-6.1-sol',
    'text': 'OpenCode model id of the server errand agent',
  },
  {
    'key': 'models.development.thinker',
    'types': ['string'],
    'reader': 'src/tools/impl/status.ts',
    'default': 'openrouter/anthropic/claude-opus-5.5',
    'text': 'OpenCode model id of the orchestrator',
  },
  {
    'key': 'models.development.dev',
    'types': ['string'],
    'reader': 'src/llm/roles.ts',
    'default': 'openrouter/anthropic/claude-sonnet-5.5',
    'text': 'OpenCode model id of the coding and writing worker',
  },
];
