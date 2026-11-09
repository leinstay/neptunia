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
      'Her memory session and description review model. Same default as `core`, not a copy. Its key is the extra key `llm.boundKeys` binds to `memory`, else the core keys',
  },
  {
    'key': 'models.base.analyzer',
    'types': ['string', 'boolean'],
    'reader': 'src/behavior/mention.ts',
    'default': 'openai/gpt-6.1-sol',
    'text':
      'Picks options (address, room, route, split, media-pick, missed, etc.), plans searches and turns sources into notes. Pin one purpose to another model with `byPurpose`',
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
      "Model ids keyed by purpose string (`reply`, `query-builder`, `recall-summary`, `selfreflection-planner`, `planner`, `web-search` and the like). A match on purpose wins over the role's model. Not probed by the status card",
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
    'reader': 'src/tools/operations/status.ts',
    'default': 'openrouter/openai/gpt-6.1-sol',
    'text': 'OpenCode model id of the scout errand agent',
  },
  {
    'key': 'models.errands.server',
    'types': ['string'],
    'reader': 'src/tools/operations/status.ts',
    'default': 'openrouter/openai/gpt-6.1-sol',
    'text': 'OpenCode model id of the server errand agent',
  },
  {
    'key': 'models.development.thinker',
    'types': ['string'],
    'reader': 'src/tools/operations/status.ts',
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
  {
    'key': 'models.agents.via',
    'types': ['map'],
    'reader': 'src/subharness/routing.ts',
    'default': {},
    'text':
      'The backend each agent runs through, by agent (`scout`, `server`, `dev`, `watcher`, `thinker`): `claude`, `codex` or `opencode`. An agent with no entry has no route and its runs are refused `subharness-off`. `/model set <agent> <model> --via <route>` writes it',
  },
  {
    'key': 'models.agents.model',
    'types': ['map'],
    'reader': 'src/subharness/routing.ts',
    'default': {},
    'text': "The model each agent runs on, by agent. An agent with no entry runs on its backend's own default",
  },
  {
    'key': 'models.agents.effort',
    'types': ['map'],
    'reader': 'src/subharness/routing.ts',
    'default': {},
    'text': "The reasoning effort each agent runs at, by agent. An agent with no entry runs at its model's default",
  },
  {
    'key': 'models.agents.provider',
    'types': ['map'],
    'reader': 'src/subharness/routing.ts',
    'default': {},
    'text':
      'The OpenRouter provider each agent on `opencode` is pinned to, by agent, with no fallback. `/model set <agent> <model> --via opencode-harness --provider <slug>` writes it',
  },
  {
    'key': 'models.agents.mode',
    'types': ['map'],
    'reader': 'src/subharness/routing.ts',
    'default': {},
    'text':
      'What each agent may do, by agent: `read`, `write`, `full` or `sudo`. An agent with no entry runs in its default mode (see [Errands](errands.md)). `/subharness mode <agent> <mode>` writes it',
  },
  {
    'key': 'models.agents.opencodeKey',
    'types': ['string', 'null'],
    'reader': 'src/subharness/routing.ts',
    'default': null,
    'text':
      'The extra key of `keys.json` that `opencode` runs on. Null while `opencode` has no login. `neptunia subharness opencode login --key <name>` sets it',
  },
  {
    'key': 'models.harness.core',
    'types': ['map', 'null'],
    'reader': 'src/subharness/routing.ts',
    'default': null,
    'text':
      'Her core\'s subscription route, `{ "backend": "claude" or "codex", "model": id, "effort": level or null }`. Null is the OpenRouter API. `/model set core <model> --via <route>` writes it after one reply, and `/model set core <model>` clears it',
  },
  {
    'key': 'models.harness.memory',
    'types': ['map', 'null'],
    'reader': 'src/subharness/routing.ts',
    'default': null,
    'text':
      "The memory writer's path through a subharness, in the shape of `models.harness.core`. Null is the direct path on the memory role's key. `/model set memory <model> --via <route>` writes it after one reply",
  },
];
