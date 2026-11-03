# Setup

`neptunia setup` is the install of one user. It writes the private folders and an empty key store, then asks which subharness backends to install, the repository of her self-development, her three ticking mechanics and the watcher. It writes the systemd units, starts the core and opens the owner's chat on the first command. This document is for whoever installs the engine and for whoever changes the command. How a template becomes a unit is in [deploy/README.md](../deploy/README.md).

There is no install script. `npm install` fetches the dependencies, `neptunia setup` does the rest (`src/setup/run.ts`, `bin/neptunia.ts`), and the user who runs it is the user the engine runs as. That user is a full administrator of the machine in the owner's deployment, and nothing here edits a file by hand or needs root.

## The setup contract of a module

An interface package or an executable skill declares its settings in `setup.json`: a `settings` list whose rows have `key`, `question`, `kind` (`text`, `list` or `secret`) and `required`. `src/setup/modules.ts` validates the declaration and stores the values under the module's own folder: `data/interfaces/<name>/` or `data/skills/<name>/`, plain values in `config.json` and secrets in `credentials.json` at mode `0600`. The `interfaces` step, `/interface setup <name>`, `/skills setup <name>` and the targeted commands `settings`, `set`, `clear`, `add` and `remove` of the same two groups all write through that file, so a value has one home. `settings` shows a secret as set with its last four characters, and `set` refuses a secret typed on the command line and asks for it without echo. Removing a module's code leaves its values in place.

The Discord package declares `token` and `servers`, a list of any number of server ids.

## The steps

`runSetup` runs ten steps in this order. Each checks first whether its work is done, so a rerun after a failure resumes where it stopped. A step that fails stops the run, the later steps are `skipped` and no chat opens. A `refused` step stops nothing. The four steps that ask questions come before `units`, so the units bind the backends just connected and the watcher's timer takes the hour just given. Without a terminal they are `skipped` and the install goes on.

| Step | What it does | `already` when |
|---|---|---|
| `folders` | Creates the private folder with `config.local`, `prompts.local` and `clients`, and the data folder, all at mode 0700 whatever the umask. | all five exist at 0700 |
| `keys-file` | Writes an empty `keys.json` at mode 0600. A file that exists keeps its content and is set to 0600. | the file exists at 0600 |
| `interfaces` | Offers every interface package with a `setup.json`, asks its own questions, a secret without echo, and enables it once every required value is stored. | no answer changes a value |
| `subharness` | Asks which backends to install, then installs and connects each. | every chosen backend is installed and connected |
| `selfimprovement` | Asks for `selfimprovement.repository` and stores it when her gh login can push there. Skipped while `selfimprovement.checkout` is unset. | the stored repository passes the check |
| `mechanics` | Asks `heartbeat`, `selfreflection` and `selfimprovement` on or off, and `selfimprovement.at`. Refused for `selfimprovement` without what it needs. | no answer changes a value |
| `watcher` | Asks whether the watcher runs, `watcher.at`, its backend and its model. | no answer changes a value |
| `units` | Renders the six unit files, and the two selfimprovement units when `selfimprovement.checkout` names another checkout, writes those whose text differs, then reloads the manager. | every file has the rendered text |
| `linger` | Runs `loginctl enable-linger <user>`, so the user units run without a login. Skipped for `--system`. | `Linger=yes` |
| `core` | Runs `enable --now neptunia-core.service`, the one unit setup starts. | the unit is active |

`neptunia setup <step>` runs that step alone and leaves the others `skipped`. It runs no other command and opens no chat.

The selfimprovement units, `neptunia-selfimprovement.service` and `neptunia-selfimprovement.timer`, run `neptunia selfimprovement run` in the dev checkout that `selfimprovement.checkout` names (default `null`). The `units` step reads the setting from the settings of the checkout setup runs in. While the setting is unset, relative or names that checkout itself, the step writes no selfimprovement unit and its line says why, so the beat never edits and pushes the code that is running. Setup does not start the timer.

The `selfimprovement` step (`selfimprovementStep` in `src/setup/selfimprovement.ts`) asks the owner for the repository her pull requests go to, as `owner/name`, and offers the `owner/name` of the dev checkout's `origin` as the default, which an empty answer takes. It checks the answer through her gh login with the push-right check of [Self-development](selfimprovement.md#the-repository) and writes `selfimprovement.repository` into `<private>/config.local/config.json`, keeping every other key, only when the check answers `ok`. Any other answer makes the step `refused` with the check's line, writes nothing, and leaves the run `ok`, so the chat still opens. A repository she cannot push to is refused with the line that says to fork it and name the fork. Without `gh` on `PATH`, or with gh not logged in under `<private>/subharness/gh`, the step is refused too.

The `subharness` step (`subharnessStep` in `src/setup/subharness.ts`) asks for the backends by name, separated by spaces or commas, and offers the ones connected already. `none` chooses none and changes nothing. Each chosen backend is installed into `<private>/subharness/<backend>/` as `neptunia setup subharness` does (below), in the order named. For `codex` and `claude` not yet connected, the step shows the login line of her own binary and waits until the owner has run it at the terminal and pressed Enter. Setup never runs the login. One reply check then connects the backend. For `opencode` the step asks for the path of the executable to copy when it is not installed yet, then for the name of the extra key it runs on, and connects it once that key answers `/auth/key`. A failed install or check makes the step `failed`, which stops the run before the units, and stores nothing for that backend, while the ones connected before it stay. No line of the step holds a key value. `neptunia setup subharness` with no backend named runs this step alone. What a connected backend is lives in [Errands](errands.md#the-subharness).

The `mechanics` step (`mechanicsStep` in `src/setup/mechanics.ts`) asks for her three ticking mechanics, `heartbeat`, `selfreflection` and `selfimprovement`, each `on` or `off`, the value in force offered. With `selfimprovement` on it asks the time of its daily wake, `selfimprovement.at`, as `HH:MM` UTC (default `03:00`). `selfimprovement` on is refused when no subharness backend is connected, when `selfimprovement.repository` is unset, or when the push-right check through her gh login fails. The step is then `refused` with one line naming what is missing and stores `selfimprovement.enabled` `false` beside the other two answers. The answers go into `<private>/config.local/config.json`, every other key kept, and nothing is written when no answer changes a value.

The `watcher` step (`watcherStep` in `src/setup/watcher.ts`) asks whether the deployment's watcher runs ([The watcher](watcher.md)) and the time of its daily run, `watcher.at` (default `00:00` UTC). It then asks for the connected backend the watcher runs through, offered `subharness.uses.watcher` or the first connected one, and for its model, offered `subharness.models.watcher`. An empty model with none offered stores none, so the backend runs on its default. `watcher.enabled` and `watcher.at` go into the local settings, and the backend and the model into `keys.json`. On with no connected backend, or with a backend that is not connected, is `refused` and stores `watcher.enabled` `false`.

An answer that is no valid value asks the same question again: an `on` or `off` question takes `on` or `off` in any case, and an hour takes `HH:MM` from `00:00` to `23:59`. After three such answers the value in force is kept.

## Scopes

By default the units are user units under `systemctl --user`. `neptunia setup --system` writes them to `/etc/systemd/system` with `User=` set to the installing user, through `sudo install`, and runs every `systemctl` call through `sudo`. It writes nothing to the unit folder directly.

The units start the node that `nodeOf` (`src/setup/run.ts`) finds: the absolute path given with `--node <path>`, else the path setup was started with, else the first `node` on `PATH`, else the resolved binary. A link on the way is kept, so a unit that names `/opt/node/bin/node` follows the link to the next node version. A usage error, such as an unknown option, two steps, or `--node` without an absolute path, exits 2 before anything is touched.

## After the steps

Setup prints one line per step with its state, then the commands that come next, and opens the chat with `/keys core add` typed. The order after setup is `keys core add`, `interface token set discord` (it asks the bot token without echo and writes `token` to `data/interfaces/discord/credentials.json` at mode `0600`, which interface startup reads), `interface enable discord`, then `model set` for the optional roles, `subharness enable` and `simulation enable`. `/help` lists every command. `neptunia doctor` carries a `features` check that warns while the subharness or the simulation is off and names the command that turns it on.

## Subharness backends

`neptunia setup subharness codex`, `claude` or `opencode` installs one subharness backend into `<private>/subharness/<backend>/` and runs none of the steps. `codex` and `claude` come from `npm install --prefix`, and `opencode` is a copy of the executable that `--from <path>` names, else of `errands.opencodePath`. The command prints `done`, `already` or `failed` with one line, and exits 1 for `failed`. After `codex` or `claude` it prints the login line to type at the terminal, which sets the backend's home before the binary, then the chat command `subharness enable <backend>`. Where each backend keeps its home and its login is in [Errands](errands.md#the-subharness).
