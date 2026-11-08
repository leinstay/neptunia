# Keys and models

The persona's model credentials live in `data/keys.json`. Interface and skill credentials live beside the module they belong to. Use the CLI dialogs to create or change them; secret values are not printed.

## Core and extra keys

`/keys core add` adds an OpenRouter key and checks the models selected for its roles. Core keys form the normal credential pool. Named extra keys let a particular service or role use a separate account.

Use `/keys` to inspect the available commands, `/keys bind` to select an extra key for a target, and `/keys check` to check a supported target. `/model set` changes a model role. The command's result reports whether validation succeeded; a model name alone does not prove that the selected account can use it.

[`checkRole`](../src/keys/check.ts) sends one minimal request for the role on the role's key. Chat roles get a short completion, `embedding` a short embedding, and `speech` a synthesis of two characters on the speech endpoint with `speech.voice`. A failed check means the provider or the network said no. `drawing` has no probe, because one request bills a whole picture, so `/keys check drawing` answers `unsupported` and sends nothing, and `/model set drawing` saves the model unverified. A role that is off answers `not_configured`. Neither answer says anything about the key.

A role that runs through a harness needs no API key, and a missing key does not stop it. `/keys core remove` of the last core key pauses her with `no-core-key` only while her core runs on the API (`subharness.core` absent). While it runs through `claude` or `codex`, the key goes, the answer names the harness, and she keeps running. `/keys check core` on such a core with no key answers that the role needs no key, and `/model set core <model>` with no `--via` is refused with no key and no binding, so her route stays on the harness. The same holds for `memory` and the simulation: the key ring and the role health (`roleKeyCheck` in `src/llm/role-health.ts`) count a role whose `keys.json` record names a backend as served, and the `harnessOf` dependency of `createKeysCommands` reads that record through `subscriptionPath` and `memoryPath`. The memory session's sweep and its description review take the writer's path at the moment they run (`refusalOf` and `memoryKeyState` in `src/memory/db/session.ts`, `reviewRefusal` in `src/memory/db/describe.ts`, the `sessionPath` dependency of the memory service), so a writer on a harness runs with no memory key. A role on the API with no key is reported missing as before.

`/keys check memory` checks the path the memory writer runs on, which `src/subharness/memory-path.ts` reads from `keys.json`. On `direct-api` it is the request on the memory key, and the answer ends with `(direct path)`. While the writer runs through `claude-harness` or `codex-harness`, it is the probe of `src/subharness/memory-probe.ts` through that backend, the answer names the backend and model, and no request goes out on the OpenRouter key, so the check needs no core key.

The base chat roles, the memory writer and the delegated agents are distinct routes. `/model set core` and `/keys check core` record their check for [chat readiness](setup.md#chat-readiness), so a launch sends no model request of its own. A subscription login for an agent backend does not replace the OpenRouter keys used by the core. See [setup](setup.md#subharness-backends) for those logins.

## Model sources

The owner reads and types four route names: `direct-api` for OpenRouter, and `claude-harness`, `codex-harness` and `opencode-harness` for the three CLIs. `src/subharness/route-names.ts` maps them at the edge, to render a route and to read `--via`. `keys.json`, the folders under `data/subharness/`, the binaries and the log fields keep the stored word (`claude`, `codex`, `opencode`). A `--via` value that is no route name, including the stored words, is refused with `unknown-backend`, and the answer names the four. `--via direct-api` on `core`, `memory` or `simulation` returns the role to the API as the same command with no `--via` does, and an agent refuses it with `backend-unsupported`.

A source is OpenRouter or a subharness backend that is installed and logged in. `/model set <role> <model> --via <route> [--effort <effort>]` serves every agent role (`scout`, `server`, `dev`, `watcher`, `thinker`) and `memory`, and it writes the source, the model and the effort in one change. `/model set <agent> <model>` with no `--via` keeps the source in force. An effort that is not given stays while the source stays and goes with a source that changes, because no reply checked it there. `--provider <slug>` with `--via opencode-harness` pins an agent to one OpenRouter provider, see [errands](errands.md#the-provider-of-an-opencode-route).

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

The memory writer differs by path, and `memoryCapabilities` in `src/subharness/memory-writer.ts` says how. On `claude-harness` the session's system text replaces the CLI's own and the run has no tools, and its usage splits into prompt, cached and completion tokens. On `codex-harness` the system text comes first on its stdin, its own instructions stay in force, its sandbox is read-only and its usage is one total, counted as input. `memoryDb.session.maxOutputTokens` reaches `claude` as `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, which it enforces. `codex` has no such control. That gap shows in `/subharness status` and in a passing memory probe on `codex`, and nothing trims her answer instead. An envelope with `stop_reason` `refusal` or `max_tokens` is a failed run (`model-refused`, `output-truncated`), which leaves the session's cursor where it was. The memory probe fails with `not-logged-in` and no model run when the vendor's own status says so, she sleeps with `memory-down`, and no other source answers in its place. `session_runs.model` holds `<backend>:<model>` for a run on a subharness, successful or not, and the role's model on the direct path.

`keys.json` holds a role's source in `subharness.uses` and the memory writer's in `subharness.memory`. A store with the older list `subharness.backends`, or the single `subharness.backend`, reads each agent that names no source as using the list's first name, and the next write leaves the list out.

## Her core on a subscription

`/model set core <model> --via claude-harness` or `--via codex-harness` moves her turns from the OpenRouter API to the subscription that CLI is logged into, after one reply on that model and its optional `--effort <level>` through it. `src/subharness/subscription-path.ts` keeps the route in `keys.json` as `subharness.core`, in the shape of the memory writer's record, and reads it at every request, so the next turn takes it. `/model set core <model>` with no `--via` checks the API model, saves it and clears the record, which returns her turns to `direct-api`; `/model set core <model> --via direct-api` does the same. `opencode-harness` is refused with `backend-unsupported`, because `opencode run` takes no system prompt of its own. The simulation has a record of its own, `subharness.simulation`. `/model set simulation <model> --via claude-harness` or `--via codex-harness` sets it, and `/model set simulation direct-api` (or `/model set simulation <model> --via direct-api`) clears it. The older `/model set simulation api` still clears it. A paid script reads that record and never the core's. `/subharness status` ends with a `core` row and a `simulation` row, each `direct-api` or `via <harness> <model>` with its effort. A row is marked `unavailable` while its backend cannot run, and `no thinking control` on Codex.

`createSubscriptionClient` in `src/subharness/subscription-client.ts` sits in front of the API client and takes the requests of the role `core` alone. The analyzer, vision, memory and every other role go to the API client unchanged. The step loop calls it once per step, as it calls the API. A turn's first step starts one `claude -p` or `codex exec` from the persona's own install in `data/subharness/<backend>/`, with her system text in place of the CLI's prompt and her user text on stdin. The later steps of the turn continue that process. Claude runs with `--system-prompt`, `--tools ""`, `--setting-sources ""`, `--no-session-persistence`, `--strict-mcp-config` and `--output-format stream-json`, and its native thinking is off through `MAX_THINKING_TOKENS=0`. Codex reads her system text from the file `-c model_instructions_file` names, runs `--ephemeral` with the user config ignored, and has its shell, patch, image and web tools turned off. The child gets the plain host variables and the backend's home, never a key of the core.

Her tools reach the CLI as the MCP server `nep`. The CLI starts `bin/neptunia-mcp.ts` with the core socket and a file that holds a token for this turn alone. The server lists her tool definitions with their names bare, and Claude shows them to the model as `mcp__nep__<name>`. Each call travels over the core socket to the tool bridge of `src/subharness/tool-bridge.ts` and waits there while the step loop runs it through the gateway and the executors, as on the API. The next step hands the result back. A token that is unknown, or whose turn has ended, is refused with `turn-unknown`. A run that ended on tool calls and gets no next step within `llm.subscription.holdMs`, 60000 milliseconds by default, is killed.

Each step passes the token cap and the daily request cap before anything starts, records its tokens in `/usage` at no cost and writes one `model_requests` row whose backend is `claude` or `codex`. A failed step rejects with one of these codes, and her turn's `reason` carries it:

| Code | When |
|---|---|
| `not-installed` | The backend's binary is not in its place, and nothing starts |
| `subscription-exhausted` | The window is spent: Claude rejected the request in a `rate_limit_event` or ended with status 429, or Codex named a usage limit |
| `subscription-login` | The CLI is not logged in |
| `subscription-failed` | Any other failed run, or a CLI that ended before its answer |
| `subscription-timeout` | No event came within the request's timeout, or the request was aborted |
| `subscription-lost` | A later step names tool calls that no open run holds |

`llm.subscription.fallback` at `true` sends a failed step and every later step of that turn to the API with the same messages, when `keys.json` holds a key for the route (a core key, or one bound to the role). With no key the step fails as if fallback were off, and no API request is made. A refusal of either rail never goes there. `llm.subscription.thinking` at `true` leaves Claude's native thinking on. Both are `false` by default. Codex has no switch that turns a reasoning model's thinking off.

The paid scripts `scripts/replay.ts`, `scripts/inner-week.ts`, `scripts/memory-session.ts` and `scripts/recall-eval.ts` take their client from `simulationLlm` in `scripts/lib/cli.ts`. A script reads `subharness.simulation` once when it starts, keeps that route to its end and prints on stderr which route it spends. With no record, every request spends the simulation key, and the script stops with one line while the simulation is off. With a record, the requests of the role `core` run through the subscription client on that route, under the same rails, settings and codes as her turns. Every other role spends the simulation key. While the simulation is off, those requests are refused with `simulation-off` and the core requests still run. For a core step with tools the script serves a tool bridge of its own on a Unix socket in a new folder of mode 700 under `TMPDIR`, `bin/neptunia-mcp.ts` connects there in place of the core socket, and the script's step loop runs each call in its own process as a live turn does. A memory session sends only requests of the role `memory`, so `scripts/memory-session.ts` spends the simulation key on either route.

## The model selector

`/model` in the chat opens `ModelPicker` in `cli/model-picker.ts` and runs nothing until a choice needs it. The same bare word in a shell stays `/model show`, and every other `/model` line stays a command. The steps are category, role, provider type, source, model, effort and review. Main holds `core`, `drawing`, `speech` (shown as Voice), `memory`, `analyzer`, `vision`, `video` and `embedding`. Errand holds `scout` and `server`, Development holds `thinker` and `dev`, and `watcher` is a utility row under Development with no `models.development` key.

The selector reads `/model sources <role>`, whose JSON comes from `roleSources` in `src/subharness/model-capabilities.ts`. That read sends no model request and returns key names, never values. Each source row starts with its route name, and the selector commits that name as `--via`. Each source has a `code`, and any code other than `ok` is a disabled row with its reason. The codes are `not-installed`, `not-logged-in`, `no-key`, `provider-rejected` and `role-unsupported`. A direct-only role shows the three backends as `role-unsupported` without starting them, and an agent has no API row because an agent cannot run on the direct path. OpenRouter's models reach an agent through `opencode`, and only while `opencode` can run.

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
