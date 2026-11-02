# Deployment

The systemd unit templates of the engine. `neptunia setup` renders them for the installing user and puts them in place, and this document says how a template becomes a unit and what each unit runs. The steps of `setup` itself, their order and their options are in [docs/setup.md](../docs/setup.md).

| Template | What it runs | Rendered by setup |
|---|---|---|
| `neptunia-core.service` | The core with no interface of its own (`interfaces.mode: units`). The one unit setup starts. | yes |
| `neptunia-interface@.service` | One interface, `neptunia interface run %i`. | yes |
| `neptunia-agent-scout.service`, `neptunia-agent-server.service` | The errand agents, `neptunia errand-runner --profile <name>`. See [Errands](../docs/errands.md#the-subharness). | yes |
| `neptunia-watcher.service`, `neptunia-watcher.timer` | The daily watcher, `neptunia watcher run`, started by the timer at 00:00 UTC. See [The watcher](../docs/watcher.md). | yes |
| `neptunia-bot.service` | The core with the Discord interface in its process (`interfaces.mode: inprocess`). It conflicts with the core unit. | no |
| `neptunia-plugin@.service` | One plugin, `neptunia plugin run %i`. See [Plugins](../docs/plugins.md). | no |

## How a template becomes a unit

The templates keep the paths of the first deployment (`/opt/neptunia/app`, `/opt/neptunia/etc`, `/opt/neptunia/data`, `/opt/node/bin/node`, `/home/neptunia`). `renderUnit` in `src/setup/units.ts` maps them onto the checkout, the private folder, the data folder, the node binary and the home of the installing user. It is pure, so a rerun renders the same text and writes only the units whose text changed.

A user unit goes to `$XDG_CONFIG_HOME/systemd/user` (`~/.config/systemd/user` when the variable is unset). It has no `User=` or `Group=`, installs into `default.target`, and the interface unit loses its `InaccessiblePaths`, since the one user owns the core's files too. The `Conflicts=` line against the bot unit is dropped.

A system unit, written with `neptunia setup --system`, goes to `/etc/systemd/system` through `sudo install -m 0644`. It runs as the installing user and keeps the template's hardening. The agent units bind `<home>/.codex`, and their `PATH` holds `<home>/.local/bin` and the folder of the node binary.

## The sandbox of an agent unit

The unit of an agent follows the agent's mode (`subharness mode <agent> <mode>`, see [Errands](../docs/errands.md#modes)). In `read` and `write` the unit keeps every directive of the template. In `full` it drops the mount sandbox: `ProtectSystem`, `ProtectHome` and the write and bind paths. In `sudo` it also drops `NoNewPrivileges` and `CapabilityBoundingSet`, which would stop `sudo`. `subharness mode` renders that one unit again, reloads the manager and restarts the unit if it runs. A unit that is not installed is left alone, and the mode holds from the agent's next run.

A unit with `ProtectHome=tmpfs` still sees the checkout and the node binary when they lie under the home, because the renderer binds them read-only.

In a user unit the agents' socket and out folder need no setting. `neptunia setup` adds `NEPTUNIA_UNIT_SCOPE=user` to every user unit, and `agentSettings` then puts the socket in the unit's `RuntimeDirectory` (`$XDG_RUNTIME_DIR/neptunia-agent-<name>/sock`) and the out folder in its `StateDirectory` (`$XDG_STATE_HOME/neptunia-agent-<name>/out`, by default under `~/.local/state`). The core runs from a user unit too, so it reads the same paths. A path named in `agents.<name>.socket` or `agents.<name>.out` still wins.
