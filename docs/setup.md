# Setup

`neptunia setup` configures the installation belonging to the current user, with no core running. Run it at a terminal to answer questions. It starts the core at its end, so restore a persona's files before running it. [Getting started](getting-started.md#first-run) walks through a first run.

Interactive setup uses a keyboard selector for `on` or `off` and `yes` or `no` questions. Other answers use a text field with the offered default. Secret fields are masked, and Esc cancels setup. Run it again to continue. The owner chat also provides a `/setup` panel for later configuration.

## One flow and its steps

`neptunia setup` takes `--system` and `--node <path>` and no other word. Each step below checks whether its work is done and skips it, so running the command again resumes after a failure and adds what an earlier run left out. A step's name exits `2` and runs nothing. `neptunia setup subharness <backend>` exits `2` and names `neptunia subharness <backend> login`. To repeat the mechanics or the watcher alone, use `neptunia services <name> setup`, `enable` and `disable` from [the CLI](cli.md#scheduled-services), which write the same settings with the same validation.

| Step | Purpose |
|---|---|
| `folders` | Create the persona directories with private permissions |
| `keys-file` | Create or secure the key store |
| `interfaces` | Ask the installed interfaces' setup questions, register each chosen interface's client with its token, and start its unit |
| `services` | Offer the optional YouTube metadata key and optional quick search |
| `subharness` | Install the chosen agent backends and run their logins |
| `selfimprovement` | Offer development: install `gh`, check the repository and set up the folder of the development checkout, as in [self-development](selfimprovement.md#configure) |
| `mechanics` | Switch heartbeat and reflection, switch and schedule the development wake |
| `watcher` | Switch the watcher, choose its schedule, backend and model |
| `units` | Make the clients `cli`, `owner` and `watcher` with their tokens, and `development` when `selfimprovement.checkout` names a checkout other than this one, then render service and timer files. The watcher, development and server units hide the other clients' tokens and the interfaces' `credentials.json` from their agents, for the clients and interfaces that exist at that moment |
| `linger` | Let user services continue without an interactive login |
| `core` | Enable and start the core service |

A failure stops later steps. Without a terminal, interactive questions are skipped and no chat opens. Inspect the report instead of assuming that a noninteractive setup configured your credentials.

The `interfaces` step on a clean install writes `interfaces.mode: units`, because the shipped `inprocess` default runs only the interface built into the core. A local config that names a mode, or already enables an interface, is left as it is. An `inprocess` deployment gets no client and no unit from this step. A repeat keeps a client and a token that hold a value, and replaces an empty token file. An interface missing a required value is neither registered nor started, and the report names an interface as running only after the service manager accepted it.

The `subharness` step takes none, one, several or `all`. A backend that can run already is left alone, so naming it again repeats no login, and reopening the step to add another keeps the accounts and the model choices of the first. No role moves.

## Chat readiness

`neptunia` with no arguments reads its readiness before it opens a chat. `gatherHealth` in `src/setup/readiness.ts` reads the files of the data folder, the unit folder and one `status.readiness` command of the core, which sends no model request, and waits 5 seconds for it. `evaluateReadiness` checks these requirements in order, and a failure carries the repair it prints:

| Requirement | Blocks when |
|---|---|
| `cli-identity` | `clients.json` has no `cli` client of kind `cli`, or its token file is empty |
| `local-config` | `config/config.json` of the data folder does not parse. A missing file blocks nothing |
| `services` | the core's unit is absent from the unit folder of the scope |
| `core-running` | nothing listens on the core's socket, or the core does not answer in time |
| `cli-link` | the core refuses the token or there is no token to offer it |
| `core-model` | the core role has no model, or the check recorded for that selection is missing, stale or failed. A core on a harness is served: its route in `models.harness.core` is all that is read, and neither a core key, a check of the API model nor the harness's own status command is asked. The harness was checked when it was installed and logged in and when the model was chosen on it |
| `memory` | the memory database is closed, or the last probe of the memory writer failed |

Search, media, mirrors and subharnesses never block. The check of the core model comes from `/model set core`, `/keys check core` and the first `/keys core add`, which `src/setup/model-check.ts` keeps in `setup/core-check.json` of the data folder. It answers for the selection it tested, so a changed model reads as stale and a key revoked since shows at the next `/keys check core`. A `/model set core` the provider refuses saves nothing and leaves the record of the selection in force. While her turns run through a [subscription](keys.md#her-core-on-a-subscription), the setup step of `core-model` asks for no first core key and names that route in its question, because the API model it saves moves her turns back to the API.

At a terminal a gap enters the setup flow of `src/setup/flow.ts` at the first incomplete requirement, runs only what is incomplete and opens the chat when nothing is left. It starts a stopped core and leaves the rest of the install untouched. Cancelling a step stops the flow, and answers given so far wait in `setup/answers.json` for the next launch. When a step says it finished while its gap stays open, the flow stops as failed, so a provider that keeps refusing costs one check. Broken config, a refused token and a failing memory end with their repair, since no step can mend them for the owner.

With `NEPTUNIA_PLAIN_CHAT=1` and no terminal, a gap prints `setup-required` with every repair and exits `1`. Without that variable a chat with no terminal explains itself and exits `2` before reading anything. Every other command stays reachable, and `neptunia doctor` reports the same result as its `readiness` check. `neptunia doctor live` leaves that check out.

`neptunia doctor` also checks for real what each part runs on now, in its `routes` check (`routeHealth` in `src/setup/route-health.ts`), which a chat launch never does. A role on the API (`core`, `memory`, `analyzer`, `vision`, `video`, `embedding`, `speech`, the simulation, and quick search on `openrouter`) gets one minimal request on its own key with its own model, and one model on one key is asked once. `drawing` is named and not asked, because one request bills a picture. A role or an agent on a harness gets the vendor's own status command. An extra key bound to nothing gets the free read of its record, and an installed harness that no role or agent uses gets its status command. A failure under the core, the memory writer or the analyzer fails the check, and any other failure warns. The lines name keys and models and never print a key value.

## The owner's person

Setup names no owner person. The owner's first line in the chat makes one. The core mints a person, and one write links the chat's account and the accounts `bot.owners` lists on the home interface to it. Then the core writes `bot.ownerPerson` to `config/config.json` of the data folder (`src/pipeline/observe.ts`). An install that already has `bot.ownerPerson` links the chat to that person. `/memory bind <iface> <account> owner` binds another account to that person later, as [Owner identity](memory.md#owner-identity) describes.

## Services

The default is user units under `~/.config/systemd/user` or the directory selected by `XDG_CONFIG_HOME`. Manage these with `systemctl --user`. `neptunia setup --system` installs system units through sudo, running them as the installing user. Manage those with `sudo systemctl`.

Every rendered service gets `CacheDirectory=neptunia-compile` and `Environment=NODE_COMPILE_CACHE=%C/neptunia-compile` (`src/setup/units.ts`), so Node keeps the compiled engine modules in `/var/cache/neptunia-compile` for system units or `~/.cache/neptunia-compile` for user units, a folder systemd keeps writable under the unit's sandbox. The `neptunia` command's entry, `bin/neptunia-launch.ts`, names `$XDG_CACHE_HOME/neptunia-compile`, else `~/.cache/neptunia-compile`, when `NODE_COMPILE_CACHE` is unset, before it loads the engine (`src/compile-cache.ts`). A warm cache takes a command that reaches no core from about 0.66 s to 0.24 s. An installed unit takes the cache when `neptunia setup` renders it again. Use `--node /absolute/path/to/node` to select the executable written into units. See [the unit templates](../deploy/README.md) for the processes and timers. Changing a stored setting does not rewrite an installed unit: rerun `neptunia setup` when changing a backend mode. `neptunia services watcher setup` renders the watcher's timer itself, and a `watcher.schedule` changed through `/config` reaches the timer at the next render.

Setup starts the core and the interfaces you chose. Enable the chosen timers explicitly, the watcher's with `neptunia services watcher enable`. `neptunia services`, `/logs` and a chat's readiness follow one scope (`unitScope` in `src/service/manager.ts`): `NEPTUNIA_UNIT_SCOPE` when it says `user` or `system`, else the user manager when the core's unit or the watcher's timer lies under `$XDG_CONFIG_HOME/systemd/user/`, otherwise the system manager. `/logs` adds `--user` to `journalctl` in the user scope, and a manager that refuses or cannot run exits `1` with the scope and the reason (`src/service/journal.ts`).

## Optional modules

An interface or skill declares questions in its `setup.json`. The common setup implementation stores ordinary values in its `config.json` and secrets in `credentials.json`, under `data/interfaces/<name>/` or `data/skills/<name>/`. Secret files use mode `0600`.

Use `/interfaces setup <name>` or `/skills setup <name>` to repeat these questions. The corresponding `set`, `clear`, `add` and `remove` commands change individual values. Disabling a module keeps its data. The declaration format is covered by [interfaces](interfaces.md) and [skills](skills.md).

The optional Google YouTube Data API key improves metadata retrieval. Obtain one through [Google's setup guide](https://developers.google.com/youtube/v3/getting-started), then use `/keys service set youtube`. It does not replace the model that watches video.

Quick search is optional and declined by default. The `services` step asks for one engine, `openrouter`, `brave` or `exa`, and then for what that engine needs, a model or a service key. An empty answer to either leaves `web.quickSearch.engine` unset and quick search off. `/search engine` sets it later, and [keys](keys.md#quick-search) covers the routing.

## Subharness backends

A subharness is the external CLI that runs an agent or memory session. Supported backends are Claude Code, Codex and OpenCode. Each has its own installation, login and sessions under `data/subharness/<backend>/`.

```bash
neptunia subharness claude login
neptunia subharness codex login
neptunia subharness opencode login --key <extra-key-name>
```

A backend is available when it is installed and its login works: `sourceState` in `src/subharness/sources.ts` reads both at each look and stores neither, so there is no separate switch to turn on. `login` offers to install an absent backend, and on a yes the same command goes on to the login. Declining changes nothing. With no terminal it exits `1` and says what is needed, installing nothing and starting no vendor login. The login runs under the persona's backend home. For Claude Code the command comes from what the installed binary lists first in its `--help`, `auth login` or `login`, and a help that lists neither fails the login with an explanation. Logging into your own separate CLI does not authenticate hers. OpenCode has no vendor login here: `--key` names the extra key it runs on, the name must be in `keys.json`, and the login writes it to `models.agents.opencodeKey` of `config/config.json`. `login` copies the executable from `errands.opencodePath`, and the `subharness` step of setup asks for its path.

`neptunia subharness <backend> status` asks the vendor's own status command, sends no model request and exits `1` when the backend is absent or not logged in. `neptunia subharness <backend> logout` removes that login and exits `1` with `busy` while an agent or the memory writer runs through the backend, in any process. All three run with no core, so they can repair a core that does not start. The same words work in the chat as `/subharness <backend> status`, and there a vendor's login answers the shell command to type.

Login and logout change availability alone. No role moves, no model is chosen, and a role whose source logged out stays on it, shown `unavailable` by `/subharness status`, with no fallback to another source. Model and source are chosen in the [`/model` selector](keys.md#the-model-selector) or with `/model set <role> <model> --via <route>` and execution permissions with `/agent mode <agent> [<mode>]`. Every such choice, and the watcher's backend and model from its setup step, is written to `config/config.json` of the data folder under `models.agents` and `models.harness`, and `keys.json` keeps the secrets alone. See [keys and models](keys.md#model-sources).

Versions are recorded in `version.json`, and a normal setup preserves the recorded choice. The installer preserves the backend home when replacing its binary. Keep that home in persona backups so native sessions remain available for later inspection. Pinning does not guarantee that a provider will continue accepting an old client.

Read the implementation in [setup steps](../src/setup/run.ts), [module settings](../src/setup/modules.ts) and [backend installation](../src/subharness/install.ts).
