# Setup

`neptunia setup` configures the installation belonging to the current user. Run it at a terminal to answer questions. A full run starts the core; when restoring a persona, restore its files before that step. Follow [getting started](getting-started.md#first-run) for the client tokens and interface startup that setup does not create for you.

Interactive setup uses a keyboard selector for `on` or `off` and `yes` or `no` questions. Other answers use a text field with the offered default. Secret fields are masked, and Esc cancels setup. Run it again to continue. The owner chat also provides a `/setup` panel for later configuration.

## Individual steps

Run `neptunia setup <step>` to repeat one part without starting the rest. The `selfimprovement`, `mechanics` and `watcher` steps run in a full setup alone, and `neptunia setup` with one of those words exits `2`. To repeat them, use `neptunia services <name> setup`, `enable` and `disable` from [the CLI](cli.md#scheduled-services), which write the same settings with the same validation. The repository check runs again in a full setup.

| Step | Purpose |
|---|---|
| `folders` | Create the persona directories with private permissions |
| `keys-file` | Create or secure the key store |
| `interfaces` | Ask the installed interfaces' setup questions |
| `services` | Offer the optional YouTube metadata key and optional quick search |
| `subharness` | Install agent backends and wait for their logins |
| `selfimprovement` | Select and check the development repository |
| `mechanics` | Switch heartbeat and reflection, switch and schedule the development wake |
| `watcher` | Switch the watcher, choose its schedule, backend and model |
| `units` | Render service and timer files, and make the clients `watcher` and `development` with their tokens |
| `linger` | Let user services continue without an interactive login |
| `core` | Enable and start the core service |

A failure stops later steps. Without a terminal, interactive questions are skipped. Inspect the report instead of assuming that a noninteractive setup configured your credentials.

## Services

The default is user units under `~/.config/systemd/user` or the directory selected by `XDG_CONFIG_HOME`. Manage these with `systemctl --user`. `neptunia setup --system` installs system units through sudo, running them as the installing user. Manage those with `sudo systemctl`.

Use `--node /absolute/path/to/node` to select the executable written into units. See [the unit templates](../deploy/README.md) for the processes and timers. Changing a stored setting does not rewrite an installed unit: rerun `neptunia setup units` when changing a backend mode. `neptunia services watcher setup` renders the watcher's timer itself, and a `watcher.schedule` changed through `/config` reaches the timer at the next render.

Setup starts the core only. Enable the interface and chosen timers explicitly, the watcher's with `neptunia services watcher enable`. `neptunia services` follows the scope: `NEPTUNIA_UNIT_SCOPE` when it says `user` or `system`, else the user manager when the watcher's timer lies under `$XDG_CONFIG_HOME/systemd/user/`, otherwise the system manager. `/logs` addresses the system journal, so use `journalctl --user` for a user installation.

## Optional modules

An interface or skill declares questions in its `setup.json`. The common setup implementation stores ordinary values in its `config.json` and secrets in `credentials.json`, under `data/interfaces/<name>/` or `data/skills/<name>/`. Secret files use mode `0600`.

Use `/interfaces setup <name>` or `/skills setup <name>` to repeat these questions. The corresponding `set`, `clear`, `add` and `remove` commands change individual values. Disabling a module keeps its data. The declaration format is covered by [interfaces](interfaces.md) and [skills](skills.md).

The optional Google YouTube Data API key improves metadata retrieval. Obtain one through [Google's setup guide](https://developers.google.com/youtube/v3/getting-started), then use `/keys service set youtube`. It does not replace the model that watches video.

Quick search is optional and declined by default. The `services` step asks for one engine, `openrouter`, `brave` or `exa`, and then for what that engine needs, a model or a service key. An empty answer to either leaves `web.search.engine` unset and quick search off. `/search engine` sets it later, and [keys](keys.md#quick-search) covers the routing.

## Subharness backends

A subharness is the external CLI that runs an agent or memory session. Supported backends are Claude Code, Codex and OpenCode. Each has its own installation, login and sessions under `data/subharness/<backend>/`.

```bash
neptunia subharness claude login
neptunia subharness codex login
neptunia subharness opencode login --key <extra-key-name>
```

A backend is available when it is installed and its login works: `sourceState` in `src/subharness/sources.ts` reads both at each look and stores neither, so there is no separate switch to turn on. `login` offers to install an absent backend, and on a yes the same command goes on to the login. Declining changes nothing. With no terminal it exits `1` and says what is needed, installing nothing and starting no vendor login. The login runs under the persona's backend home. For Claude Code the command comes from what the installed binary lists first in its `--help`, `auth login` or `login`, and a help that lists neither fails the login with an explanation. Logging into your own separate CLI does not authenticate hers. OpenCode has no vendor login here: `--key` names the extra key it runs on, and the name must be in the store. `neptunia setup subharness opencode --from /absolute/path/to/opencode` copies the executable in, or `login` copies it from `errands.opencodePath`.

`neptunia subharness <backend> status` asks the vendor's own status command, sends no model request and exits `1` when the backend is absent or not logged in. `neptunia subharness <backend> logout` removes that login and exits `1` with `busy` while an agent or the memory writer runs through the backend, in any process. All three run with no core, so they can repair a core that does not start. The same words work in the chat as `/subharness <backend> status`, and there a vendor's login answers the shell command to type.

Login and logout change availability alone. No role moves, no model is chosen, and a role whose source logged out stays on it, shown `unavailable` by `/subharness status`, with no fallback to another source. Model and source are chosen with `/model set <role> <model> --via <backend>` and execution permissions with `/agent mode <agent> [<mode>]`. See [keys and models](keys.md#model-sources).

Versions are recorded in `version.json`. A normal setup preserves the recorded choice. Updating is explicit:

```bash
neptunia setup subharness codex --version VERSION
neptunia setup subharness codex --rollback
```

The installer preserves the backend home when replacing or rolling back its binary. Keep that home in persona backups so native sessions remain available for later inspection. Pinning does not guarantee that a provider will continue accepting an old client.

Read the implementation in [setup steps](../src/setup/run.ts), [module settings](../src/setup/modules.ts) and [backend installation](../src/subharness/install.ts).
