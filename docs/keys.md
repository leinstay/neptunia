# Keys and models

The persona's model credentials live in `data/keys.json`. Interface and skill credentials live beside the module they belong to. Use the CLI dialogs to create or change them; secret values are not printed.

## Core and extra keys

`/keys core add` adds an OpenRouter key and checks the models selected for its roles. Core keys form the normal credential pool. Named extra keys let a particular service or role use a separate account.

Use `/keys` to inspect the available commands, `/keys bind` to select an extra key for a target, and `/keys check` to check a supported target. `/model set` changes a model role. The command's result reports whether validation succeeded; a model name alone does not prove that the selected account can use it.

[`checkRole`](../src/keys/check.ts) sends one minimal request for the role on the role's key. Chat roles get a short completion, `embedding` a short embedding, and `speech` a synthesis of two characters on the speech endpoint with `speech.voice`. A failed check means the provider or the network said no. `drawing` has no probe, because one request bills a whole picture, so `/keys check drawing` answers `unsupported` and sends nothing, and `/model set drawing` saves the model unverified. A role that is off answers `not_configured`. Neither answer says anything about the key.

The base conversation roles, the memory writer and the delegated agents are distinct routes. A subscription login for an agent backend does not replace the OpenRouter keys used by the core. See [setup](setup.md#subharness-backends) for those logins.

## Model sources

A source is OpenRouter or a subharness backend that is installed and logged in. `/model set <role> <model> --via <backend> [--effort <effort>]` serves every agent role (`scout`, `server`, `dev`, `watcher`, `thinker`) and `memory`, and it writes the source, the model and the effort in one change. `/model set <agent> <model>` with no `--via` keeps the source in force. An effort that is not given stays while the source stays and goes with a source that changes, because no reply checked it there.

`checkedSelection` in `src/subharness/selection.ts` checks the source first, then asks one reply from that model, and saves only when the source can still run and nobody changed the selection during the reply. A refusal saves nothing and answers one of these codes.

| Code | Meaning |
|---|---|
| `not-installed` | The backend is not installed; no request was sent |
| `not-logged-in` | The backend is installed with no login; no request was sent |
| `model-rejected` | The reply did not come; the answer carries the backend's last line |
| `role-unsupported` | The role has no subharness path, as `speech` and `drawing`; no request was sent |
| `selection-changed` | Another selection of that role was made during the reply |
| `source-changed` | The source logged out during the reply |

`modelChoices` in `src/subharness/model-sources.ts` lists the choices of a role by source, so one model name from two sources stays two choices. It labels the fixed names of `codex` and `claude` as suggestions, reports a missing install, a missing login and a provider's refusal as separate notices, and sends no model request. `memory` is never offered `opencode`, which takes no system prompt of its own.

`keys.json` holds a role's source in `subharness.uses` and the memory writer's in `subharness.memory`. A store with the older list `subharness.backends`, or the single `subharness.backend`, reads each agent that names no source as using the list's first name, and the next write leaves the list out.

## Quick search

Quick search has its own `web.search.engine`, `web.search.model` and `search` key binding, independent of the analyzer. Neither setting has a default, so it stays off until `neptunia setup` or `/search engine` chooses an engine. The engines are `openrouter`, `brave` and `exa`, and nothing answers in place of the chosen one. `openrouter` needs `web.search.model` and uses the core key pool unless `search` is bound to a named extra key. It sends a model request with the search plugin, so the model and its cost matter. `brave` and `exa` need their service keys, and they condense a search for the diary on `web.search.model` when one is set.

`cutConfigKeys` of [src/config/cut.ts](../src/config/cut.ts) drops a retired `web.search.fallback` from a settings layer and leaves its engine as it is, so an `openrouter` layer needs its own `web.search.model`. The core warns once per process about a layer with retired keys.

Use `/search` to inspect and change the engine, model and enabled state. Use `/keys bind search <name>` for an extra key and `/keys check search` to validate the binding.

[Deep search](errands.md) runs through the scout. Its availability and credentials are separate from quick search.

## Service and module keys

`/keys service set <name>` prompts for a service value. Supported service names include `youtube`, `brave`, `exa` and `videoProxy`. The [setup guide](setup.md#optional-modules) links to the YouTube API instructions.

`/interface token set discord` writes Discord's token to `data/interfaces/discord/credentials.json`. A skill's setup contract declares its own secrets. Removing a platform's credentials does not remove stored memories from it.

Back up credentials with the complete persona, keep the backup private and do not commit credentials to Git. Key files are not encrypted by the engine. [Persona migration](persona-migration.md) covers moving them without printing their values.

Read the implementation in [key management](../src/keys/) and [search commands](../src/interface/commands/search.ts).
