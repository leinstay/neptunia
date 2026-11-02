# Setup

`neptunia setup` is the install of one user. It writes the private folders, an empty key store, the systemd units and starts the core, then opens the owner's chat on the first command. This document is for whoever installs the engine and for whoever changes the command. How a template becomes a unit is in [deploy/README.md](../deploy/README.md).

There is no install script. `npm install` fetches the dependencies, `neptunia setup` does the rest (`src/setup/run.ts`, `bin/neptunia.ts`), and the user who runs it is the user the engine runs as. That user is a full administrator of the machine in the owner's deployment, and nothing here edits a file by hand or needs root.

## The steps

`runSetup` runs five steps in this order. Each checks first whether its work is done, so a rerun after a failure resumes where it stopped. A step that fails stops the run, the later steps are `skipped` and no chat opens.

| Step | What it does | `already` when |
|---|---|---|
| `folders` | Creates the private folder with `config.local`, `prompts.local` and `clients`, and the data folder, all at mode 0700 whatever the umask. | all five exist at 0700 |
| `keys-file` | Writes an empty `keys.json` at mode 0600. A file that exists keeps its content and is set to 0600. | the file exists at 0600 |
| `units` | Renders the six unit files and writes those whose text differs, then reloads the manager. | every file has the rendered text |
| `linger` | Runs `loginctl enable-linger <user>`, so the user units run without a login. Skipped for `--system`. | `Linger=yes` |
| `core` | Runs `enable --now neptunia-core.service`, the one unit setup starts. | the unit is active |

`neptunia setup <step>` runs that step alone and leaves the others `skipped`. It runs no other command and opens no chat.

## Scopes

By default the units are user units under `systemctl --user`. `neptunia setup --system` writes them to `/etc/systemd/system` with `User=` set to the installing user, through `sudo install`, and runs every `systemctl` call through `sudo`. It writes nothing to the unit folder directly. A usage error, such as an unknown option or two steps, exits 2 before anything is touched.

## After the steps

Setup prints one line per step with its state, then the commands that come next, and opens the chat with `/keys core add` typed. The order after setup is `keys core add`, `interface token set discord`, `interface enable discord`, then `model set` for the optional roles, `subharness enable` and `simulation enable`. `/help` lists every command. `neptunia doctor` carries a `features` check that warns while the subharness or the simulation is off and names the command that turns it on.
