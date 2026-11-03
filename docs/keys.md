# Keys

How a deployment holds the keys its model requests go out on, and the commands of the `neptunia` chat that change them. It is for the person who installs the engine and for whoever changes `src/keys/`.

## The key store

The model keys live in `keys.json`, in the private folder (`NEPTUNIA_PRIVATE_DIR`, else the checkout). The file has mode 600, is written whole to a temporary file and renamed over the old one, and has its mode set again on every write. `src/keys/store.ts` reads it at the moment of each use, so a key added from the chat is used by the next request and an edit by hand is read at once.

```
{
  "core":  [ { "name": "core-1", "value": "...", "grant": 200, "resetDay": 22 } ],
  "extra": { "art": "..." },
  "roles": { "drawing": "art" }
}
```

`core` is the list of core keys in order, the first being the primary. A core key may carry a `grant` (dollars) and a `resetDay` (1 to 31), both or neither. `extra` holds named keys that are not in the core list. `roles` binds a base model role to one extra key. A name is lowercase letters, digits and dashes, 1 to 32 characters, and is used once across `core` and `extra`. A value is not blank and holds no whitespace. A write keeps every section of the file it does not own.

A listing shows a key's name, its last four characters, its grant and reset day and the roles bound to it. Nothing prints a value, and an error names a code (`bad-name`, `bad-value`, `bad-grant`, `duplicate-name`, `unknown-key`, `unknown-role`, `not-bound`, `key-in-use`, `store-not-empty`, `unreadable-file`), never a value, a name that was refused or the content of the file.

While `keys.json` is absent the core takes its keys from `.env` and `llm.keyByRole` as before (see [The core](core.md#keys)). The file's existence is the switch: the next request, status read and `/model set` use the store, and `OPENROUTER_CORE_KEY` is no longer needed to start. `scripts/keys-import.ts` writes the file once from the old variables.

## The core keys and the ring

`src/keys/ring.ts` puts the failover of `src/llm/key-failover.ts` over the core list. Every role goes out on the core key it is on, the first until a budget error moves it. A budget error (HTTP 402, or 429 whose body names credits or balance) moves the role to the next key and repeats the request once on it. After the last key the role goes back to the first, and when every key failed within a minute the request fails with `keys-exhausted`, which marks the role down until 00:00 UTC. A role bound to an extra key goes out on that key alone: a budget error there is the request's error and no core key is spent.

`createLlm` takes a `keys` option, the ring or a function that gives it (null while there is no `keys.json`). With a ring the key of each request is read from it at that moment, and `apiKey`, `env` and `llm.keyByRole` are not read. The embedder, the speech synthesis, the pictures and the role health read the same ring through `keyOf` (`src/keys/ring.ts`). A request of a role with no key, with no core key and no binding, fails with `ROLE_KEY_MISSING` before anything is sent.

The memory session asks the ring too. While `keys.json` exists, `memoryKeyState` (`src/memory/db/session.ts`) takes the key the ring routes `memory` to: the extra key the role is bound to, else the core key in use. The sweep and the description review are refused `not_configured` only when the ring routes the role to no key. Without the store the session needs the variable that `llm.keyByRole.memory` names, set in `.env`.

The owner's status card reads two keys for its statistics, at the moment of the card, through `statusCardKeys` (`src/keys/card-keys.ts`). With `keys.json` the simulation's limit line uses the extra key `simulation.key` names, and the activity lines use the extra key named `management`. A missing key leaves its lines out. Without the store the two keys are `OPENROUTER_SIM_KEY` and `OPENROUTER_MANAGEMENT_KEY` of `.env`. A `keys.json` that cannot be read gives the card neither key, and the card still renders.

The usage line `llm: usage` names the key by its store name (`core-1`), and `data/usage.json` keeps the spend under that name. A key the import wrote remembers the variable it came from in the `variables` section of the file, and the spend recorded under that variable before the import counts for the key too. The grants of the core rows replace `llm.keys`: `/status` and the turns line of her wake view compute each core key's balance from its own `grant` and `resetDay`.

## The commands

The table is `src/interface/commands/table.ts`, the commands are `src/keys/commands.ts`, and the console routes every `keys.*` command and, while the store exists, `model.set` to them.

| Command | What it does |
|---|---|
| `/keys core add <name>` | Asks the key value without echo. With no core key yet it also asks the model of `core`, `memory`, `analyzer` and `embedding` in that order, each with the tracked default offered (a blank answer takes it), then sends one short request per model on the new key. Only when all four answer does it save the key and the four models. Any failure names each failed role and model and saves nothing. Later adds check the key with one `GET /auth/key` and save it. Either add then asks the grant in dollars and the day of the month it is given again, both optional (a blank answer or `none` for no grant). |
| `/keys core remove <name>` | Removes a core key. Removing the last one pauses her with the reason `no-core-key`, shown on `/status`. The next `/keys core add` resumes her, and only that pause: a pause the owner set stays, and so does the memory probe's `memory-down` ([Memory](memory.md#the-memory-probe)). |
| `/keys core list` | Each core key with its last four characters, its grant and reset day, and the one in use. |
| `/keys core grant <name> <usd> <day>`, `/keys core grant <name> none` | Sets the grant in dollars and the day of the month it is given again on a stored core key, or clears both with `none`. The value is not asked again. An amount below 0, a day outside 1 to 31, a missing day or a name that is no core key is refused and changes nothing. |
| `/keys extra add <name>`, `/keys extra remove <name>`, `/keys extra list` | The same for extra keys. An add checks the key with `/auth/key`. A key a role is bound to cannot be removed. |
| `/keys bind <role> <name>`, `/keys unbind <role>` | Sends a base role out on one extra key alone, or back to the core keys. |
| `/keys check <role>` | One minimal request for the role on the key it goes out on now. The answer names the model, the key and whether OpenRouter billed it as `is_byok`. |
| `/model set <role> [<model>] [--provider <slug>] [--effort <level>]` | For a base role or `memory`, one minimal request on the role's key first, and the model is saved only when it answers. With no model the chat asks, offering OpenRouter's `/models` for the role, and a model outside that list is checked and saved the same way. `--provider` sends the check through that provider alone and then writes the route `<model>@<role>` of `llm.providerByModel` as `{ "only": [<slug>], "allow_fallbacks": false }`, keeping `"byok": true` when the route that applies to the model and role now has it. `--effort` sends the check with `reasoning.effort` and then writes `llm.reasoningByRole.<role>`. A failed check saves no model, no route and no effort. `thinker` takes an OpenCode id, saved at once. `scout`, `server`, `dev` and `watcher` go to their subharness instead, see [Errands](errands.md#models-and-efforts-of-the-agents). A checked and saved `memory` model also returns her memory writer to the direct path. |
| `/model set memory --via <backend> <model> [--effort <level>]` | Moves her memory writer to `codex` or `claude` of the subharness after one reply on that model and effort, and writes `subharness.memory` of `keys.json`. The line never reaches the key commands, so no request goes to OpenRouter. It is refused with `unknown-backend`, `backend-unsupported` (opencode), `backend-not-connected`, `unknown-effort` or `effort-unsupported` (a claude whose `--help` lists no `--effort`) before anything runs, and a model that gives no reply is refused with `model-rejected` and changes nothing. See [Memory](memory.md#the-writers-path). |

A provider slug is lowercase letters, digits and dashes, else the line is refused with `bad-provider`. The effort is `low`, `medium` or `high`, else `unknown-effort`. Only `memory`, `analyzer`, `vision` and `video` take an effort (`REASONING_ROLES` in `src/llm/roles.ts`), and any other role is refused with `effort-unsupported`. The core is among those refused, because her own `<think>` is her thinking and her requests carry no provider reasoning. Nothing is sent for a refused line. The model list comes from `listRoleModels` in `src/keys/models.ts`, which reads each model's `architecture` from `/models`. It keeps text in and text out for `core`, `memory` and `analyzer`, image in for `vision`, video in for `video`, and image, audio or embeddings out for `drawing`, `speech` and `embedding`. A list that cannot be read is empty, and the owner types the model.

No command takes a key value as an argument: the typed line goes into the chat's history file and into the refusal that echoes it. A command that is run with no chat to ask in (`neptunia -p` without a terminal) answers `invalid`. A refusal never echoes a value, a word of the line or a name it refused.

`src/keys/check.ts` sends the probes. A chat role (`core`, `memory`, `analyzer`, `vision`, `video`) gets a completion of at most 8 tokens, `embedding` gets `POST /embeddings`, and the request is cut after 10 seconds. A 200 whose body holds an `error` object fails. The answer to a failed probe carries the provider's words cut to 500 characters with the key replaced by `***`. `speech` and `drawing` have no probe, so `/model set` saves their model unchecked and `/keys check` for them fails.

## The questions

A command that needs more than its line answers its request with status `ask` and waits. The chat reads the answer and sends a second `command.requested` that carries the same command `name`, the `dialogId` of the question and the `answer` as fields of the event, not as an entry of `args`. That request is answered by the command's next question or by its result. The fields of the protocol are in [Interfaces](interfaces.md#commands-over-the-link).

`createDialogBroker` (`src/interface/commands/dialogs.ts`) keeps the open questions in the core's memory for five minutes. An answer after that, to another command or to an unknown `dialogId` is refused as `invalid`, and the command it held ends without a result. The core neither logs nor stores an answer.

In a terminal the chat asks a secret question through `bin/secret-prompt.ts`. The readline interface draws into a writable that the question mutes, so nothing typed is echoed. One `*` stands for each character, backspace takes one away, Ctrl-C and the end of the input answer empty, and the answer is kept out of the interface's history and of `<private>/cli/history`.

## Importing the old keys

A deployment with no `keys.json` and `OPENROUTER_*_KEY` variables in its environment needs no script: the first `/keys core add` or `/keys extra add` that reaches its question runs the same import before it writes anything, and its answer starts with the names of the keys it moved.

`node scripts/keys-import.ts` reads `<private>/.env` and the effective settings and writes `keys.json` once. The core list is `llm.keyByRole.core` (a name or a list), else `OPENROUTER_CORE_KEY` then `OPENROUTER_CORE_BACKUP_KEY`. Those keys become `core-1`, `core-2` in that order and take the `llm.keys` grant of their variable. Every other set `OPENROUTER_<X>_KEY` becomes the extra key `<x>` in lowercase, underscores turned into dashes. A base role mapped by `llm.keyByRole` is bound to its key. An errand or development role (`scout`, `server`, `thinker`, `dev`) is left out and its key stays an extra key. Variables that are not `OPENROUTER_*_KEY` are never read into the store.

The script prints the keys, the bindings and what it left out by name, with the reason. A store that already holds a key is refused with one line and exit code 1. The script changes neither `.env` nor the settings. Once `keys.json` exists, `node scripts/config-migrate.ts --apply` drops `llm.keyByRole` and `llm.keys` from the local settings file and names each on a line. Without the store it keeps both and says to run `scripts/keys-import.ts` first.

## Quick search

Quick search has its own binding target and its own model, apart from the analyzer. `/keys bind search <name>` sends it out on an extra key, `/keys unbind search` returns it to the core keys, and `/keys check search` asks for one minimal reply from its model on its key. `/search` shows and changes `web.search.enabled`, `web.search.engine` and `web.search.model` (default `openai/gpt-6.1-sol`). With quick search off, `web.search` leaves her tools, her senses point her to the scout when she has `errand.run`, and `web.read` stays.
