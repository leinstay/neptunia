# Setup

`neptunia setup` configures the installation belonging to the current user. Run it at a terminal to answer questions. A full run starts the core; when restoring a persona, restore its files before that step. Follow [getting started](getting-started.md#first-run) for the client tokens and interface startup that setup does not create for you.

Interactive setup uses a keyboard selector for `on` or `off` and `yes` or `no` questions. Other answers use a text field with the offered default. Secret fields are masked, and Esc cancels setup. Run it again to continue. The owner chat also provides a `/setup` panel for later configuration.

## Individual steps

Run `neptunia setup <step>` to repeat one part without starting the rest. The `selfimprovement`, `mechanics` and `watcher` steps run in a full setup alone, and `neptunia setup` with one of those words exits `2`. To repeat them, use `neptunia service <name> setup`, `enable` and `disable` from [the CLI](cli.md#scheduled-services), which write the same settings with the same validation. The repository check runs again in a full setup.

| Step | Purpose |
|---|---|
| `folders` | Create the persona directories with private permissions |
| `keys-file` | Create or secure the key store |
| `interfaces` | Ask the installed interfaces' setup questions |
| `services` | Offer the optional YouTube metadata key |
| `subharness` | Install and connect agent backends |
| `selfimprovement` | Select and check the development repository |
| `mechanics` | Switch heartbeat and reflection, switch and schedule the development wake |
| `watcher` | Switch the watcher, choose its schedule, backend and model |
| `units` | Render service and timer files |
| `linger` | Let user services continue without an interactive login |
| `core` | Enable and start the core service |

A failure stops later steps. Without a terminal, interactive questions are skipped. Inspect the report instead of assuming that a noninteractive setup configured your credentials.

## Services

The default is user units under `~/.config/systemd/user` or the directory selected by `XDG_CONFIG_HOME`. Manage these with `systemctl --user`. `neptunia setup --system` installs system units through sudo, running them as the installing user. Manage those with `sudo systemctl`.

Use `--node /absolute/path/to/node` to select the executable written into units. See [the unit templates](../deploy/README.md) for the processes and timers. Changing a stored setting does not rewrite an installed unit: rerun `neptunia setup units` when changing a backend mode. `neptunia service watcher setup` renders the watcher's timer itself, and a `watcher.schedule` changed through `/config` reaches the timer at the next render.

Setup starts the core only. Enable the interface and chosen timers explicitly, the watcher's with `neptunia service watcher enable`. `neptunia service` follows the scope: `NEPTUNIA_UNIT_SCOPE` when it says `user` or `system`, else the user manager when the watcher's timer lies under `$XDG_CONFIG_HOME/systemd/user/`, otherwise the system manager. `/logs` addresses the system journal, so use `journalctl --user` for a user installation.

## Optional modules

An interface or skill declares questions in its `setup.json`. The common setup implementation stores ordinary values in its `config.json` and secrets in `credentials.json`, under `data/interfaces/<name>/` or `data/skills/<name>/`. Secret files use mode `0600`.

Use `/interface setup <name>` or `/skills setup <name>` to repeat these questions. The corresponding `set`, `clear`, `add` and `remove` commands change individual values. Disabling a module keeps its data. The declaration format is covered by [interfaces](interfaces.md) and [skills](skills.md).

The optional Google YouTube Data API key improves metadata retrieval. Obtain one through [Google's setup guide](https://developers.google.com/youtube/v3/getting-started), then use `/keys service set youtube`. It does not replace the model that watches video.

## Subharness backends

A subharness is the external CLI that runs an agent or memory session. Supported backends are Claude Code, Codex and OpenCode. Each has its own installation, login and sessions under `data/subharness/<backend>/`.

```bash
neptunia setup subharness claude
neptunia setup subharness codex
neptunia setup subharness opencode --from /absolute/path/to/opencode
```

Follow the printed login command, which selects the persona's backend home. For Claude Code the command comes from the commands the installed binary lists in its `--help`, `login` or else `auth login`. `neptunia setup subharness claude` exits `1` naming `claude --help` when that help lists neither, and the setup step asks you to read the backend's own login help when it cannot read one. Logging into your own separate CLI does not authenticate hers. Then connect it with `/subharness enable <backend>`; OpenCode also takes `--key <extra-key-name>`.

Versions are recorded in `version.json`. A normal setup preserves the recorded choice. Updating is explicit:

```bash
neptunia setup subharness codex --version VERSION
neptunia setup subharness codex --rollback
```

The installer preserves the backend home when replacing or rolling back its binary. Keep that home in persona backups so native sessions remain available for later inspection. Pinning does not guarantee that a provider will continue accepting an old client.

Read the implementation in [setup steps](../src/setup/run.ts), [module settings](../src/setup/modules.ts) and [backend installation](../src/subharness/install.ts).
