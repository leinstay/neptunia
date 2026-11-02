# Setup

`neptunia setup` is the install of one user. It writes the private folders, an empty key store and the systemd units, starts the core, asks for the repository of her self-development, then opens the owner's chat on the first command. This document is for whoever installs the engine and for whoever changes the command. How a template becomes a unit is in [deploy/README.md](../deploy/README.md).

There is no install script. `npm install` fetches the dependencies, `neptunia setup` does the rest (`src/setup/run.ts`, `bin/neptunia.ts`), and the user who runs it is the user the engine runs as. That user is a full administrator of the machine in the owner's deployment, and nothing here edits a file by hand or needs root.

## The steps

`runSetup` runs six steps in this order. Each checks first whether its work is done, so a rerun after a failure resumes where it stopped. A step that fails stops the run, the later steps are `skipped` and no chat opens. A `refused` step stops nothing.

| Step | What it does | `already` when |
|---|---|---|
| `folders` | Creates the private folder with `config.local`, `prompts.local` and `clients`, and the data folder, all at mode 0700 whatever the umask. | all five exist at 0700 |
| `keys-file` | Writes an empty `keys.json` at mode 0600. A file that exists keeps its content and is set to 0600. | the file exists at 0600 |
| `units` | Renders the six unit files, and the two selfdev units when `selfdev.checkout` names another checkout, writes those whose text differs, then reloads the manager. | every file has the rendered text |
| `linger` | Runs `loginctl enable-linger <user>`, so the user units run without a login. Skipped for `--system`. | `Linger=yes` |
| `core` | Runs `enable --now neptunia-core.service`, the one unit setup starts. | the unit is active |
| `selfdev` | Asks for `selfdev.repository` and stores it when her gh login can push there. Skipped while `selfdev.checkout` is unset or setup runs without a terminal. | the stored repository passes the check |

`neptunia setup <step>` runs that step alone and leaves the others `skipped`. It runs no other command and opens no chat.

The selfdev units, `neptunia-selfdev.service` and `neptunia-selfdev.timer`, run `neptunia selfdev run` in the dev checkout that `selfdev.checkout` names (default `null`). The `units` step reads the setting from the settings of the checkout setup runs in. While the setting is unset, relative or names that checkout itself, the step writes no selfdev unit and its line says why, so the beat never edits and pushes the code that is running. Setup does not start the timer.

The `selfdev` step (`selfdevStep` in `src/setup/selfdev.ts`) asks the owner for the repository her pull requests go to, as `owner/name`, and offers the `owner/name` of the dev checkout's `origin` as the default, which an empty answer takes. It checks the answer through her gh login with the push-right check of [Self-development](selfdev.md#the-repository) and writes `selfdev.repository` into `<private>/config.local/config.json`, keeping every other key, only when the check answers `ok`. Any other answer makes the step `refused` with the check's line, writes nothing, and leaves the run `ok`, so the chat still opens. A repository she cannot push to is refused with the line that says to fork it and name the fork. Without `gh` on `PATH`, or with gh not logged in under `<private>/subharness/gh`, the step is refused too.

## Scopes

By default the units are user units under `systemctl --user`. `neptunia setup --system` writes them to `/etc/systemd/system` with `User=` set to the installing user, through `sudo install`, and runs every `systemctl` call through `sudo`. It writes nothing to the unit folder directly.

The units start the node that `nodeOf` (`src/setup/run.ts`) finds: the absolute path given with `--node <path>`, else the path setup was started with, else the first `node` on `PATH`, else the resolved binary. A link on the way is kept, so a unit that names `/opt/node/bin/node` follows the link to the next node version. A usage error, such as an unknown option, two steps, or `--node` without an absolute path, exits 2 before anything is touched.

## After the steps

Setup prints one line per step with its state, then the commands that come next, and opens the chat with `/keys core add` typed. The order after setup is `keys core add`, `interface token set discord` (it asks the bot token without echo and writes `DISCORD_TOKEN` to `<private>/clients/discord.env` at mode 0600, the environment file of the interface unit), `interface enable discord`, then `model set` for the optional roles, `subharness enable` and `simulation enable`. `/help` lists every command. `neptunia doctor` carries a `features` check that warns while the subharness or the simulation is off and names the command that turns it on.
