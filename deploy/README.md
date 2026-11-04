# Deployment

The systemd unit templates of the engine. `neptunia setup` renders them for the installing user and puts them in place, and this document says how a template becomes a unit and what each unit runs. The steps of `setup` itself, their order and their options are in [docs/setup.md](../docs/setup.md).

| Template | What it runs | Rendered by setup |
|---|---|---|
| `neptunia-core.service` | The core with no interface of its own (`interfaces.mode: units`). The one unit setup starts. | yes |
| `neptunia-interface@.service` | One interface, `neptunia interface run %i`. | yes |
| `neptunia-agent-scout.service`, `neptunia-agent-server.service` | The errand agents, `neptunia errand-runner --profile <name>`. See [Errands](../docs/errands.md#the-subharness). | yes |
| `neptunia-watcher.service`, `neptunia-watcher.timer` | The watcher, `neptunia worker watcher`, started by the timer on `watcher.schedule` (default `at 00:00`, UTC), which setup and `neptunia service watcher setup` render into it. See [The watcher](../docs/watcher.md). | yes |
| `neptunia-selfimprovement.service`, `neptunia-selfimprovement.timer` | One beat of her self-development, `neptunia worker selfimprovement`, in the dev checkout `selfimprovement.checkout` names, started by the timer every six hours UTC. See [Self-development](../docs/selfimprovement.md). | when `selfimprovement.checkout` names another checkout |
| `neptunia-bot.service` | The core with the Discord interface in its process (`interfaces.mode: inprocess`). It conflicts with the core unit. | no |

## How a template becomes a unit

The templates keep the paths of the first deployment (`/opt/neptunia/app`, `/opt/neptunia/etc`, `/opt/neptunia/data`, `/opt/node/bin/node`, `/home/neptunia`). `renderUnit` in `src/setup/units.ts` maps them onto the checkout, the private folder, the data folder, the node binary and the home of the installing user. The selfimprovement units map `/opt/neptunia/app` onto the dev checkout of `selfimprovement.checkout` instead. The render is pure, so a rerun renders the same text and writes only the units whose text changed.

The node binary is the one `neptunia setup` was started with, as it was typed or found on `PATH` and never resolved through a link, so a unit names `/opt/node/bin/node` when `/opt/node` is a link to a versioned folder. `neptunia setup --node <path>` names another one.

A subharness backend lives in `<private>/subharness/<backend>/` with its binary and its home (`src/subharness/place.ts`), and a run starts that binary by its path. An agent unit in `read` or `write` binds the folder of every backend in `subharness.backends` of `keys.json` writable, one `BindPaths=` entry each after `ProtectHome=tmpfs`. Each entry has a leading `-`, so the unit starts before the backend is installed. They cover those folders alone, and `keys.json` stays read-only for the agent. The core writes the folder through the private directory in its `ReadWritePaths=`, and the watcher unit keeps `<private>/subharness/` and its own folder writable under `ProtectSystem=strict`. The units keep `<home>/.local/bin` and the folder of the node binary on `PATH`.

A user unit goes to `$XDG_CONFIG_HOME/systemd/user` (`~/.config/systemd/user` when the variable is unset). It has no `User=` or `Group=`, installs into `default.target`, and the interface unit loses its `InaccessiblePaths`, since the one user owns the core's files too. The `Conflicts=` line against the bot unit is dropped.

A system unit, written with `neptunia setup --system`, goes to `/etc/systemd/system` through `sudo install -m 0644`. It runs as the installing user and keeps the template's hardening, and its agent units bind the backend's folder in the private directory as a user unit does.

## The sandbox of an agent unit

The unit of an agent follows the agent's mode (`subharness mode <agent> <mode>`, see [Errands](../docs/errands.md#modes)). In `read` and `write` the unit keeps every directive of the template. In `full` it drops the mount sandbox: `ProtectSystem`, `ProtectHome` and the write and bind paths. In `sudo` it also drops `NoNewPrivileges` and `CapabilityBoundingSet`, which would stop `sudo`. `subharness mode` in the chat stores the mode in `keys.json` and renders nothing, because the core runs under `NoNewPrivileges` and cannot use `sudo`. Its answer names `neptunia setup units`, which renders the unit again with the stored mode and reloads the manager, and the unit runs in the mode from its next start.

The scout unit replaces the persona folder with an empty `TemporaryFileSystem=` that shows only `agents/` read-only and the backend's folder, so it reads neither her memory nor `keys.json`. The modes `full` and `sudo` drop it with the rest of the mount sandbox.

A unit with `ProtectHome=tmpfs` still sees the checkout and the node binary when they lie under the home, because the renderer binds them read-only.

In a user unit the agents' socket and out folder need no setting. `neptunia setup` adds `NEPTUNIA_UNIT_SCOPE=user` to every user unit, and `agentSettings` then puts the socket in the unit's `RuntimeDirectory` (`$XDG_RUNTIME_DIR/neptunia-agent-<name>/sock`) and the out folder in its `StateDirectory` (`$XDG_STATE_HOME/neptunia-agent-<name>/out`, by default under `~/.local/state`). The core runs from a user unit too, so it reads the same paths. A path named in `agents.<name>.socket` or `agents.<name>.out` still wins.
