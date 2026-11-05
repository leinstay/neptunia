# Keys and models

The persona's model credentials live in `data/keys.json`. Interface and skill credentials live beside the module they belong to. Use the CLI dialogs to create or change them; secret values are not printed.

## Core and extra keys

`/keys core add` adds an OpenRouter key and checks the models selected for its roles. Core keys form the normal credential pool. Named extra keys let a particular service or role use a separate account.

Use `/keys` to inspect the available commands, `/keys bind` to select an extra key for a target, and `/keys check` to check a supported target. `/model set` changes a model role. The command's result reports whether validation succeeded; a model name alone does not prove that the selected account can use it.

[`checkRole`](../src/keys/check.ts) sends one minimal request for the role on the role's key. Chat roles get a short completion, `embedding` a short embedding, and `speech` a synthesis of two characters on the speech endpoint with `speech.voice`. A failed check means the provider or the network said no. `drawing` has no probe, because one request bills a whole picture, so `/keys check drawing` answers `unsupported` and sends nothing, and `/model set drawing` saves the model unverified. A role that is off answers `not_configured`. Neither answer says anything about the key.

`/keys check memory` checks the path the memory writer runs on, which `src/subharness/memory-path.ts` reads from `keys.json`. On the direct path it is the request on the memory key, and the answer ends with `(direct path)`. While the writer runs through `claude` or `codex`, it is the probe of `src/subharness/memory-probe.ts` through that backend, the answer names the backend and model, and no request goes out on the OpenRouter key, so the check needs no core key.

The base conversation roles, the memory writer and the delegated agents are distinct routes. `/model set core` and `/keys check core` record their check for [chat readiness](setup.md#chat-readiness), so a launch sends no model request of its own. A subscription login for an agent backend does not replace the OpenRouter keys used by the core. See [setup](setup.md#subharness-backends) for those logins.

## Model sources

A source is OpenRouter or a subharness backend that is installed and logged in. `/model set <role> <model> --via <backend> [--effort <effort>]` serves every agent role (`scout`, `server`, `dev`, `watcher`, `thinker`) and `memory`, and it writes the source, the model and the effort in one change. `/model set <agent> <model>` with no `--via` keeps the source in force. An effort that is not given stays while the source stays and goes with a source that changes, because no reply checked it there. `--provider <slug>` with `--via opencode` pins an agent to one OpenRouter provider, see [errands](errands.md#the-provider-of-an-opencode-route).

`checkedSelection` in `src/subharness/selection.ts` checks the source first, then asks one reply from that model, and saves only when the source can still run and nobody changed the selection during the reply. A refusal saves nothing and answers one of these codes.

| Code | Meaning |
|---|---|
| `not-installed` | The backend is not installed; no request was sent |
| `not-logged-in` | The backend is installed with no login; no request was sent |
| `model-rejected` | The reply did not come; the answer carries the backend's last line |
| `role-unsupported` | The role has no subharness path, as `speech` and `drawing`; no request was sent |
| `selection-changed` | Another selection of that role was made during the reply |
| `source-changed` | The source logged out during the reply |

A level past `low`, `medium` and `high` needs proof from the installed binary. `effortLevelsOfHelp` in `src/subharness/place.ts` reads the list a `--effort` flag prints in its `--help`, as `(low, medium, high, xhigh, max)`, and `setAgentModel` and `setMemoryPath` store `xhigh` or `max` only from a backend that lists it. `--effort default` on an agent drops the stored level, so it runs at its model's default. The direct path takes `low`, `medium` and `high` alone.

`modelChoices` in `src/subharness/model-sources.ts` lists the choices of a role by source, so one model name from two sources stays two choices. It labels the fixed names of `codex` and `claude` as suggestions, reports a missing install, a missing login and a provider's refusal as separate notices, and sends no model request. `memory` is never offered `opencode`, which takes no system prompt of its own.

The memory writer differs by path, and `memoryCapabilities` in `src/subharness/memory-writer.ts` says how. On `claude` the session's system text replaces the CLI's own and the run has no tools, and its usage splits into prompt, cached and completion tokens. On `codex` the system text comes first on its stdin, its own instructions stay in force, its sandbox is read-only and its usage is one total, counted as input. `memoryDb.session.maxOutputTokens` reaches `claude` as `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, which it enforces. `codex` has no such control. That gap shows in `/subharness status` and in a passing memory probe on `codex`, and nothing trims her answer instead. An envelope with `stop_reason` `refusal` or `max_tokens` is a failed run (`model-refused`, `output-truncated`), which leaves the session's cursor where it was. The memory probe fails with `not-logged-in` and no model run when the vendor's own status says so, she sleeps with `memory-down`, and no other source answers in its place. `session_runs.model` holds `<backend>:<model>` for a run on a subharness, successful or not, and the role's model on the direct path.

`keys.json` holds a role's source in `subharness.uses` and the memory writer's in `subharness.memory`. A store with the older list `subharness.backends`, or the single `subharness.backend`, reads each agent that names no source as using the list's first name, and the next write leaves the list out.

## The model selector

`/model` in the chat opens `ModelPicker` in `cli/model-picker.ts` and runs nothing until a choice needs it. The same bare word in a shell stays `/model show`, and every other `/model` line stays a command. The steps are category, role, provider type, source, model, effort and review. Main holds `core`, `drawing`, `speech` (shown as Voice), `memory`, `analyzer`, `vision`, `video` and `embedding`. Errand holds `scout` and `server`, Development holds `thinker` and `dev`, and `watcher` is a utility row under Development with no `models.development` key.

The selector reads `/model sources <role>`, whose JSON comes from `roleSources` in `src/subharness/model-capabilities.ts`. That read sends no model request and returns key names, never values. Each source has a `code`, and any code other than `ok` is a disabled row with its reason. The codes are `not-installed`, `not-logged-in`, `no-key`, `provider-rejected` and `role-unsupported`. A direct-only role shows the three backends as `role-unsupported` without starting them, and an agent has no API row because an agent cannot run on the direct path. OpenRouter's models reach an agent through `opencode`, and only while `opencode` can run.

A model row says how it is known. `observed` came from the provider's listing now. `suggestion` is a name from `FIXED_MODELS`, which nobody checked against this account until the review saves it, and a typed name is `unknown`. The effort step offers keep, the model's default and the levels the installed binary's help lists. A backend whose help lists none offers keep and default alone. A direct-path source has no effort step, and `/model set <role> <model> --effort <effort>` stays the way to set its effort.

Enter on a disabled source lists the commands that repair it: `/subharness <backend> login`, or `/keys core add <name>`, `/keys extra add <name>` and `/keys bind <role> <name>`. A key value goes through the chat's masked question and never enters the selector's state. After a success the selector reads the sources again and lands on the same source. A vendor login needs a terminal, so in the chat it answers the shell command to run, and the unfinished selection stays.

The review's Enter sends one `model.set`, the same checked command a typed line runs. A refusal stays on the review with its code and reason and saves nothing. An answer that belongs to an older revision of the selection changes nothing, so going back during a check leaves the new selection alone.

## Quick search

Quick search has its own `web.quickSearch.engine`, `web.quickSearch.model` and `search` key binding, independent of the analyzer. Neither setting has a default, so it stays off until `neptunia setup` or `/search engine` chooses an engine. The engines are `openrouter`, `brave` and `exa`, and nothing answers in place of the chosen one. `openrouter` needs `web.quickSearch.model` and uses the core key pool unless `search` is bound to a named extra key. It sends a model request with the search plugin, so the model and its cost matter. `brave` and `exa` need their service keys, and they condense a search for the selfreflection on `web.quickSearch.model` when one is set.

`cutConfigKeys` of [src/config/cut.ts](../src/config/cut.ts) drops a retired `web.quickSearch.fallback` from a settings layer and leaves its engine as it is, so an `openrouter` layer needs its own `web.quickSearch.model`. The core warns once per process about a layer with retired keys.

Use `/search` to inspect and change the engine, model and enabled state. Use `/keys bind search <name>` for an extra key and `/keys check search` to validate the binding.

[Deep search](errands.md) runs through the scout. Its availability and credentials are separate from quick search.

## Service and module keys

`/keys service set <name>` prompts for a service value. Supported service names include `youtube`, `brave`, `exa` and `proxy`. The [setup guide](setup.md#optional-modules) links to the YouTube API instructions. `proxy` is the URL of the engine proxy, which `/proxy set` stores too and `/proxy on` puts in force (see [Proxy](proxy.md)).

`/interfaces token set discord` writes Discord's token to `data/interfaces/discord/credentials.json`. A skill's setup contract declares its own secrets. Removing a platform's credentials does not remove stored memories from it.

Back up credentials with the complete persona, keep the backup private and do not commit credentials to Git. Key files are not encrypted by the engine. [Persona migration](persona-migration.md) covers moving them without printing their values.

Read the implementation in [key management](../src/keys/) and [search commands](../src/interface/commands/search.ts).
