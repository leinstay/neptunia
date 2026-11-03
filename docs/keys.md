# Keys

How a deployment holds the keys its requests go out on, and the commands of the `neptunia` chat that change them. It is for the person who installs the engine and for whoever changes `src/keys/`.

## The key store

Every key lives in `keys.json` in the persona folder (`data/keys.json`). The file has mode `0600`, is written whole to a temporary file and renamed over the old one, and has its mode set again on every write. Code reads it at the moment of each use, so a key added from the chat serves the next request and an edit by hand is read at once.

Requests take their keys from this file alone. A request of a role that has no key, with no core key and no binding, fails with `ROLE_KEY_MISSING` before anything is sent, and the core reads no `.env` file for it.

```json
{
  "core": [{ "name": "core-1", "value": "...", "grant": 200, "resetDay": 22 }],
  "extra": { "art": "..." },
  "roles": { "drawing": "art" },
  "services": { "youtube": "..." },
  "subharness": { "backends": ["codex"], "key": null, "modes": {}, "models": {}, "efforts": {}, "uses": {}, "memory": null },
  "simulation": { "key": null }
}
```

`core` is the list of core keys in order, the first being the primary. A core key may carry a `grant` (dollars) and a `resetDay` (1 to 31), both or neither. `extra` holds named keys that are not in the core list. `roles` binds a role to one extra key. `services` holds the optional service credentials. `subharness` and `simulation` hold what [Errands](errands.md) and the paid scripts read. A key an import wrote also leaves a `variables` section that remembers the environment variable it came from.

`src/keys/store.ts` owns `core`, `extra`, `roles` and `variables`, `src/keys/services.ts` owns `services`, and `src/keys/file.ts` reads and writes the rest whole. Each write keeps every section it does not own. A key name is lowercase letters, digits and dashes, 1 to 32 characters, starting with a letter or a digit, and is used once across `core` and `extra`. A value is not blank and holds no whitespace.

A listing shows a key's name, its last four characters, its grant and reset day and the roles bound to it. Nothing prints a value. An error names a code (`bad-name`, `bad-value`, `bad-grant`, `duplicate-name`, `unknown-key`, `unknown-role`, `not-bound`, `key-in-use`, `store-not-empty`, `unreadable-file`) and never a value, a name that was refused or the content of the file.

### Service keys

The `services` section holds the keys of features that are not model roles. Each reaches only its consumer (`serviceCredential` in `src/keys/file.ts`).

| Name | What it is for |
|---|---|
| `youtube` | The YouTube Data API key, used to read video metadata when other methods fail. |
| `brave` | The Brave Search key of the `brave` engine of quick search. |
| `exa` | The Exa key of the `exa` engine of quick search. |
| `videoProxy` | The proxy URL that video downloads go through. It may hold credentials. |

`/keys service list` shows each name as `set, ends in` and the last four characters, or `not set`. `/keys service set <name>` asks the value without echo, and `/keys service clear <name>` removes it. The `services` step of `neptunia setup` offers `youtube`.

## The core keys and the ring

`src/keys/ring.ts` puts the failover of `src/llm/key-failover.ts` over the core list. Every role goes out on the core key it is on, the first until a budget error moves it. A budget error is HTTP 402, or 429 whose body names credits or balance. It moves the role to the next key and repeats the request once on it. After the last key the role goes back to the first, and when every key failed within a minute the request fails with `keys-exhausted`, which marks the role down until 00:00 UTC. A role bound to an extra key goes out on that key alone: a budget error there is the request's error, and no core key is spent.

The embedder, the speech synthesis, the pictures and the role health read the same ring through `keyOf`. So does the memory session: `memoryKeyState` (`src/memory/db/session.ts`) takes the key the ring routes `memory` to, which is the extra key the role is bound to, else the core key in use. The sweep and the description review are refused `not_configured` only when the ring routes the role to no key.

The owner's status card reads two keys for its statistics, at the moment of the card, through `statusCardKeys` (`src/keys/card-keys.ts`). The simulation's limit line uses the extra key that `simulation.key` names, and the activity lines use the extra key named `management`. A missing key leaves its lines out, and a `keys.json` that cannot be read gives the card neither key while the card still renders.

The usage line `llm: usage` names the key by its store name (`core-1`) and the usage accumulator keeps the spend under that name. A key an import wrote counts the spend recorded under its variable before the import. The grants of the core rows give `/status` and the turns line of her wake view each core key's balance from its own `grant` and `resetDay`.

## The commands

The table is `src/interface/commands/table.ts`, the commands are `src/keys/commands.ts`, and the console routes every `keys.*` command and `model.set` to them. The roles a key can be bound to or checked for are the base model roles (`core`, `analyzer`, `vision`, `video`, `embedding`, `speech` and `drawing`), `memory` and `search`.

| Command | What it does |
|---|---|
| `/keys core add <name>` | Asks the key value without echo. With no core key yet it also asks the model of `core`, `memory`, `analyzer` and `embedding` in that order, each with the tracked default offered (a blank answer takes it), then the grant, then sends one short request per model on the new key. Only when all four answer does it save the key and the four models. Any failure names each failed role and model and saves nothing. Later adds ask the grant, check the key with one `GET /auth/key` and save it. The grant is the dollars and the day of the month it is given again, both optional (a blank answer or `none` for no grant). |
| `/keys core remove <name>` | Removes a core key. Removing the last one pauses her with the reason `no-core-key`, shown on `/status`. The next `/keys core add` resumes her, and only that pause: a pause the owner set stays, and so does the memory probe's `memory-down`. |
| `/keys core list` | Each core key with its last four characters, its grant and reset day, and the one in use. |
| `/keys core grant <name> <usd> <day>`, `/keys core grant <name> none` | Sets the grant in dollars and the day of the month it is given again on a stored core key, or clears both with `none`. The value is not asked again. An amount below 0, a day outside 1 to 31, a missing day or a name that is no core key is refused and changes nothing. |
| `/keys extra add <name>`, `/keys extra remove <name>`, `/keys extra list` | The same for extra keys. An add checks the key with `/auth/key`. A key a role is bound to cannot be removed. |
| `/keys service list`, `set <name>`, `clear <name>` | The service keys above. |
| `/keys bind <role> <name>`, `/keys unbind <role>` | Sends a role out on one extra key alone, or back to the core keys. |
| `/keys check <role>` | One minimal request for the role on the key it goes out on now. The answer names the model, the key and whether OpenRouter billed it as `is_byok`. |
| `/model set <role> [<model>] [--provider <slug>] [--effort <level>]` | For a base role or `memory`, one minimal request on the role's key first, and the model is saved only when it answers. With no model the chat asks, offering OpenRouter's `/models` for the role, and a model outside that list is checked and saved the same way. `--provider` sends the check through that provider alone and then writes the route `<model>@<role>` of `llm.providerByModel` as `{ "only": [<slug>], "allow_fallbacks": false }`, keeping `"byok": true` when the route that applies to the model and role now has it. `--effort` sends the check with `reasoning.effort` and then writes `llm.reasoningByRole.<role>`. A failed check saves no model, no route and no effort. `thinker` takes an OpenCode id, saved at once. `scout`, `server`, `dev` and `watcher` go to their subharness instead, see [Errands](errands.md). A checked and saved `memory` model also returns her memory writer to the direct path. |
| `/model set memory --via <backend> <model> [--effort <level>]` | Moves her memory writer to `codex` or `claude` of the subharness after one reply on that model and effort, and writes `subharness.memory` of `keys.json`. No request goes to OpenRouter. It is refused with `unknown-backend`, `backend-unsupported` (opencode), `backend-not-connected`, `unknown-effort` or `effort-unsupported` (a claude whose `--help` lists no `--effort`) before anything runs, and a model that gives no reply is refused with `model-rejected` and changes nothing. See [Memory](memory.md). |

A provider slug is lowercase letters, digits and dashes, else the line is refused with `bad-provider`. The effort is `low`, `medium` or `high`, else `unknown-effort`. Only `memory`, `analyzer`, `vision` and `video` take an effort (`REASONING_ROLES` in `src/llm/roles.ts`), and any other role is refused with `effort-unsupported`. The core is among those refused, because her own `<think>` is her thinking and her requests carry no provider reasoning. Nothing is sent for a refused line. The model list comes from `listRoleModels` in `src/keys/models.ts`, which reads each model's `architecture` from `/models`. It keeps text in and text out for `core`, `memory` and `analyzer`, image in for `vision`, video in for `video`, and image, audio or embeddings out for `drawing`, `speech` and `embedding`. A list that cannot be read is empty, and the owner types the model.

No command takes a key value as an argument: the typed line goes into the chat's history file and into the refusal that echoes it. A command run with no chat to ask in (`neptunia -p` without a terminal) answers `invalid`. A refusal never echoes a value, a word of the line or a name it refused.

`src/keys/check.ts` sends the probes. A chat role (`core`, `memory`, `analyzer`, `vision`, `video`) gets a completion of at most 8 tokens, `embedding` gets `POST /embeddings`, and the request is cut after 10 seconds. A 200 whose body holds an `error` object fails. The answer to a failed probe carries the provider's words cut to 500 characters with the key replaced by `***`. `speech`, `drawing` and `search` have no probe. `/keys check` for them answers `failed` with `no probe for the <role> role`, and so does `/model set speech` or `/model set drawing`, which therefore saves no model.

## The questions

A command that needs more than its line answers its request with status `ask` and waits. The chat reads the answer and sends a second `command.requested` that carries the same command `name`, the `dialogId` of the question and the `answer` as fields of the event, not as an entry of `args`. That request is answered by the command's next question or by its result. The fields of the protocol are in [Interfaces](interfaces.md).

`createDialogBroker` (`src/interface/commands/dialogs.ts`) keeps the open questions in the core's memory for five minutes. An answer after that, to another command or to an unknown `dialogId` is refused as `invalid`, and the command it held ends without a result. The core neither logs nor stores an answer.

In the plain chat a secret question goes through `bin/secret-prompt.ts`. The readline interface draws into a writable that the question mutes, so nothing typed is echoed. One `*` stands for each character, backspace takes one away, Ctrl-C and the end of the input answer empty, and the answer stays out of the interface's history and of `data/cli/history`. The interactive screen draws a secret answer as `*` and keeps it out of its history the same way.

## Importing old keys

A deployment with no `keys.json` and `OPENROUTER_*_KEY` variables in the core's process environment needs no script. The first `/keys core add` or `/keys extra add` that reaches its question runs the import before it writes anything, and its answer starts with the names of the keys it moved. `neptunia setup` writes an empty `keys.json`, so a deployment that ran setup imports nothing this way.

`node scripts/keys-import.ts` reads `<persona folder>/.env` and the effective settings and writes `keys.json` once. The core list is `llm.keyByRole.core` (a name or a list), else `OPENROUTER_CORE_KEY` then `OPENROUTER_CORE_BACKUP_KEY`. Those keys become `core-1`, `core-2` in that order and take the `llm.keys` grant of their variable. Every other set `OPENROUTER_<X>_KEY` becomes the extra key `<x>` in lowercase, underscores turned into dashes. A base role mapped by `llm.keyByRole` is bound to its key. An errand or development role (`scout`, `server`, `thinker`, `dev`) is left out and its key stays an extra key. Variables that are not `OPENROUTER_*_KEY` are never read into the store. The script prints the keys, the bindings and what it left out by name, with the reason. A store that already holds a key is refused with one line and exit code 1. The script changes neither `.env` nor the settings. Once `keys.json` holds a key, `node scripts/config-migrate.ts --apply` drops `llm.keyByRole` and `llm.keys` from the settings file and names each on a line.

[Persona file migration](persona-migration.md) runs the same import into the target folder of a migration, and it also moves `YOUTUBE_API_KEY`, `BRAVE_SEARCH_API_KEY`, `EXA_API_KEY` and `MEDIA_VIDEO_PROXY` into `services`.

## Quick search

Quick search has its own binding target and its own model, apart from the analyzer. `/keys bind search <name>` sends it out on an extra key, and `/keys unbind search` returns it to the core keys. `/search` shows and changes `web.search.enabled` (default `true`), `web.search.engine` (default `brave`) and `web.search.model` (default `openai/gpt-6.1-sol`). With quick search off, `web.search` leaves her tools, her senses point her to the scout when she has `errand.run`, and `web.read` stays. The `brave` and `exa` engines use the service keys of the same names.
