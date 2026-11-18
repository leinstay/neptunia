// The settings schema of `models` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const MODELS: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'models.byPurpose',
    'types': ['map'],
    'reader': 'src/llm/embed.ts',
    'default': {},
    'text':
      "Model ids keyed by purpose string (`reply`, `query-builder`, `recall-summary`, `diary-planner`, `planner`, `summarize`, `web-search`, the `video` purposes `watch`, `gif`, `voice` and `rewatch`, and the like). A match on purpose wins over the role's model. Not probed by the status card",
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
    'key': 'models.agents.via',
    'types': ['map'],
    'reader': 'src/subharness/routing.ts',
    'default': {},
    'text':
      'The backend each agent runs through, by agent (`scout`, `server`): `claude`, `codex` or `opencode`. An agent with no entry has no route and its runs are refused `subharness-off`. `/model set <agent> <model> --via <route>` writes it',
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
      'What each agent may do, by the name of its unit (`server`, `scout`, `code`): `read`, `write`, `full` or `sudo`. A unit with no entry runs in its default mode, `read` for `server` and `write` for `scout` and `code` (see [Errands](errands.md#modes)). `/agent mode <unit> <mode>` writes it',
  },
  {
    'key': 'models.agents.opencodeKey',
    'types': ['string', 'null'],
    'reader': 'src/subharness/routing.ts',
    'default': null,
    'text':
      'The named key of `keys.json` that `opencode` runs on. Null while `opencode` has no login. `neptunia subharness opencode login --key <name>` sets it',
  },
  {
    'key': 'models.routes',
    'types': ['map'],
    'reader': 'src/llm/route-chain.ts',
    'default': {},
    'text':
      'The chain of routes of each model role, by role (`core`, `memory`, `analyzer`, `vision`, `video`, `embedding`, `speech`, `drawing`, `search`, `humanizer.linter`, `humanizer.writer`, `director`): an array of `{ "via": "api", "key": name, "model": id, "effort": level }` or `{ "via": "harness", "backend": "claude" or "codex", "model": id, "effort": level }`, tried in order. A role\'s model is the model of its first route. A role with no entry has no route, `director` with none takes the chain of `analyzer`, and an optional role with no entry or an empty array is off. `/model set`, `/model add` and `/model remove` write it',
  },
];
