# Setup

`neptunia setup` installs the engine for the user who runs it. It writes the persona folder and an empty key store, asks which interfaces, subharness backends, mechanics and watcher the deployment uses, writes the systemd units, starts the core and opens the owner's chat. This document is for whoever installs the engine and for whoever changes the command. The order in which a first run goes is in [Getting started](getting-started.md#first-run), and how a template becomes a unit is in [deploy/README.md](../deploy/README.md).

There is no install script. `npm install` fetches the dependencies and `neptunia setup` does the rest (`src/setup/run.ts`, `bin/neptunia.ts`). The user who runs it is the user the units run as, with no `sudo` unless `--system` is given. The persona folder is the one `resolvePaths` selects (`NEPTUNIA_DATA_DIR`, default `data/`), and setup refuses to run when `NEPTUNIA_PRIVATE_DIR` names another folder or when the folder or the checkout holds a legacy layer (`config.local`, `prompts.local`, `skills.local`, `config.local.json`).

## The setup contract of a module

An interface package or an executable skill declares its settings in `setup.json`, an object with a `settings` list. Each row has a `key` (letters, digits and underscores), a `question`, a `kind` (`text`, `list` or `secret`) and `required`. `src/setup/modules.ts` validates the declaration and stores the values in the module's folder under the persona folder: `interfaces/<name>/` or `skills/<name>/`. Plain values go to `config.json` at mode `0640` and secrets to `credentials.json` at mode `0600`, so a value has one home.

Setup and the chat write through that file. The `interfaces` step and the chat's `/interface setup <name>` and `/skills setup <name>` ask every setting in turn, and an empty answer keeps what is stored. The commands `settings`, `set`, `clear`, `add` and `remove` of `/interface` and `/skills` change one setting. `settings` shows a secret as `set, ends in` and its last four characters. `set` refuses a secret typed on the line and asks for it without echo. A `list` setting takes words separated by spaces or commas, and `add` and `remove` change one item of it. Removing a module's code leaves its values in place.

A shipped interface keeps its `setup.json` in the checkout, and an authored one in `data/interfaces/<name>/`. The Discord package declares `token`, a required secret, and `servers`, a list of any number of server ids. `/interface token set <name>` writes the `token` of an interface's `credentials.json` and keeps its other fields.

## The steps

`runSetup` runs eleven steps in this order. Each checks first whether its work is done, so a rerun after a failure resumes where it stopped. A step that fails stops the run, the later steps are `skipped` and no chat opens. A `refused` step stops nothing. The six steps that ask questions come before `units`, so the units bind the backends just connected and the watcher's timer takes the hour just given. Without a terminal on standard input those six steps are `skipped` and the install goes on.

| Step | What it does | `already` when |
|---|---|---|
| `folders` | Creates the persona folder with `config/`, `prompts/` and `clients/`, and sets mode `0700` on each, whatever the umask. | all four exist at `0700` |
| `keys-file` | Writes an empty `keys.json` at mode `0600`. A file that exists keeps its content and is set to `0600`. | the file exists at `0600` |
| `interfaces` | Offers each interface package that has a `setup.json`, asks its questions (a secret without echo) and sets `interfaces.<name>.enabled` once every required value is stored. | no answer changes a value |
| `services` | Offers the optional YouTube Data API key. An empty answer skips it, and `/keys service set youtube` adds it later. | the key is set or the answer is empty |
| `subharness` | Asks which backends to install, then installs and connects each. | every chosen backend is installed and connected |
| `selfimprovement` | Asks for `selfimprovement.repository` and stores it when her gh login can push there. Skipped while `selfimprovement.checkout` is unset. | the stored repository passes the check |
| `mechanics` | Asks `heartbeat`, `selfreflection` and `selfimprovement` on or off, and `selfimprovement.at`. | no answer changes a value |
| `watcher` | Asks whether the watcher runs, `watcher.at`, its backend and its model. | no answer changes a value |
| `units` | Renders the six unit files, and the two selfimprovement units when `selfimprovement.checkout` names another checkout, writes those whose text differs, then reloads the manager. | every file has the rendered text |
| `linger` | Runs `loginctl enable-linger <user>`, so the user units run without a login. Skipped for `--system`. | `Linger=yes` |
| `core` | Runs `enable --now neptunia-core.service`, the one unit setup starts. | the unit is active |

`neptunia setup <step>` runs that step alone, leaves the others `skipped` with `not asked for`, and opens no chat. Each of the eleven names is accepted, though the usage line lists nine.

For each package the `interfaces` step asks `Set up the <name> interface? (yes or no)`, default no, and the Discord package then asks for its token and its servers. The `services` step offers the YouTube key, which helps read video metadata when other methods fail. The Brave and Exa search keys and the video proxy are set later with `/keys service set` (see [Keys](keys.md)).

The `selfimprovement` step (`src/setup/selfimprovement.ts`) asks for the repository her pull requests go to, as `owner/name`, and offers the `origin` of the dev checkout as the default. It checks the answer through her gh login with the push-right check of [Self-development](selfimprovement.md) and writes `selfimprovement.repository` to `data/config/config.json` only when the check answers `ok`. Any other answer makes the step `refused` with the check's line, writes nothing and leaves the run `ok`. Without `gh` on `PATH`, or with gh not logged in under `data/subharness/gh`, the step is refused too.

The `subharness` step (`src/setup/subharness.ts`) asks for the backends by name, separated by spaces or commas, and offers the ones connected already. `none` chooses none. Each chosen backend is installed into `data/subharness/<backend>/` as `neptunia setup subharness` does (below), in the order named. For `codex` and `claude` that are not connected yet, the step shows the login line of her own binary and waits until the owner has run it at the terminal and pressed Enter. Setup never runs the login. One reply check then connects the backend. For `opencode` the step asks for the path of the executable to copy when it is not installed, then for the name of the extra key it runs on, and connects it once that key answers `/auth/key`. A failed install or check makes the step `failed`, stores nothing for that backend and keeps the backends connected before it. No line of the step holds a key value. What a connected backend is lives in [Errands](errands.md).

The `mechanics` step (`src/setup/mechanics.ts`) asks for her three ticking mechanics, each `on` or `off`, with the value in force offered. With `selfimprovement` on it asks for the time of its daily wake, `selfimprovement.at`, as `HH:MM` UTC (default `03:00`). Turning `selfimprovement` on is refused when no backend is connected, when `selfimprovement.repository` is unset or when the push-right check fails. The step is then `refused` with one line naming what is missing, and it stores `selfimprovement.enabled` `false` beside the other two answers. The answers go into `data/config/config.json` with every other key kept, and nothing is written when no answer changes a value.

The `watcher` step (`src/setup/watcher.ts`) asks whether the watcher runs ([The watcher](watcher.md), default off) and the time of its daily run, `watcher.at` (default `00:00` UTC). It then asks for the connected backend the watcher runs through, offering `subharness.uses.watcher` or the first connected one, and for its model. An empty model with none offered stores none, so the backend runs on its default. `watcher.enabled` and `watcher.at` go into the settings, and the backend and the model into `keys.json` (`subharness.uses.watcher`, `subharness.models.watcher`). Turning it on with no connected backend, or with one that is not connected, is `refused` and stores `watcher.enabled` `false`.

A question that wants `on` or `off` takes either in any case, and an hour takes `HH:MM` from `00:00` to `23:59`. After three answers that are no valid value, the value in force is kept.

The `units` step renders the selfimprovement units, `neptunia-selfimprovement.service` and its timer, only when `selfimprovement.checkout` (default `null`) names a checkout other than the one setup runs in. In every other case it writes no selfimprovement unit and its line says why, so the beat never edits and pushes the code that is running. Setup does not start the timer.

## Scopes

By default the units are user units under `systemctl --user`, written to `$XDG_CONFIG_HOME/systemd/user` (`~/.config/systemd/user` when the variable is unset). `neptunia setup --system` writes them to `/etc/systemd/system` through `sudo install -m 0644`, with `User=` set to the installing user, and runs every `systemctl` call through `sudo`. Without a terminal `sudo` runs with `-n`. Setup writes nothing to `/etc/systemd/system` directly.

The units start the node that `nodeOf` (`src/setup/run.ts`) finds: the absolute path given with `--node <path>`, else the path setup was started with, else the first `node` on `PATH`, else the resolved binary. A link on the way is kept, so a unit that names `/opt/node/bin/node` follows the link to the next node version. A usage error (an unknown option, two steps, `--node` without an absolute path) exits 2 before anything is touched.

## Environment files of the units

Three unit templates name an optional environment file, with a leading `-` so that a missing file is no error. The file is written by hand and systemd reads it when the unit starts.

| Unit | File under the persona folder | Variables that matter |
|---|---|---|
| `neptunia-agent-scout.service` | `agent-scout.env` | `OPENROUTER_ERRAND_KEY`, `OPENCODE_WEBSEARCH_KEY`, `PROXY_URL` |
| `neptunia-agent-server.service` | `clients/agent-server.env` | `OPENROUTER_ERRAND_KEY` |
| `neptunia-interface@.service` | `clients/<name>.env` | none the engine reads |

The agent variables are the names each agent's `profile.json` lists under `env`. Only the opencode backend reads them, and only when a task brings none, because the core sends the keys with each task. An interface reads its platform token from `interfaces/<name>/credentials.json` (`interface token set`), not from the environment file.

## After the steps

Setup prints one line per step with its state and detail, then `next, in the chat:` and the commands that come next: `keys core add`, `interface token set discord`, `interface enable discord`, `model set`, `subharness enable` and `simulation enable`. A full run that succeeded opens the chat with `/keys core add` typed. The chat needs the core's socket and the `cli` token, and without them it prints why and exits 1, so `neptunia` opens it later. The exit code of setup is 0 when no step failed and 1 otherwise.

Setup writes no `clients.json`, no client token, no `interfaces.mode` and no `bot.guildId`, and it starts no interface unit. [Getting started](getting-started.md#first-run) gives those steps. `neptunia doctor` carries a `features` check that warns while the subharness or the simulation is off and names the command that turns it on.

## Subharness backends

`neptunia setup subharness codex`, `claude` or `opencode` installs one backend into `data/subharness/<backend>/` and runs none of the steps. `codex` and `claude` come from `npm install --prefix` at a pinned version. `opencode` is a copy of the executable that `--from <path>` names, else of `errands.opencodePath`. npm gets only `PATH`, `HOME`, `TMPDIR` and the locale variables of the host, so no install script sees a key.

Versions are pinned in `src/subharness/install.ts`: `claude` `2.1.317` and `codex` `0.164.0`. `version.json` beside the binary records the installed version and its integrity, and a persona restored to another machine reinstalls the version it recorded, whatever this engine ships. Only the owner's command changes a version, and both forms leave the backend's `home/`, with its login and sessions, alone:

```bash
neptunia setup subharness codex --version 0.164.0
neptunia setup subharness codex --rollback
```

`--version` moves the install in force to `previous/` and installs the named version, and puts the old one back when that fails. `--rollback` restores `previous/`. Each backend runs with its own home in the environment (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, or `XDG_CONFIG_HOME` and `XDG_DATA_HOME` for opencode) and with its automatic update turned off.

The command prints `done`, `already` or `failed` with one line and exits 1 for `failed`. After `codex` or `claude` it prints `log in at this terminal:` and the login line, which sets the backend's home before the binary, then `then, in the chat: subharness enable <backend>`. After `opencode` it prints `next, in the chat: subharness enable opencode --key <name>`. [Errands](errands.md) says where each backend keeps its home and its login.
