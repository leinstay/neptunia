# Deployment

The systemd unit templates of the engine. `neptunia setup` renders them for the installing user and puts them in place, and this document says how a template becomes a unit and what each unit runs. The steps of `setup` itself, their order and their options are in [docs/setup.md](../docs/setup.md).

| Template | What it runs | Rendered by setup |
|---|---|---|
| `neptunia-core.service` | The core with no interface of its own. The one unit setup starts. | yes |
| `neptunia-interface@.service` | One interface, `neptunia interface run %i`. | yes |
| `neptunia-agent-server.service`, `neptunia-agent-scout.service`, `neptunia-agent-code.service` | The runner of each errand agent, `neptunia errand-runner --unit <agent>`. See [Errands](../docs/errands.md#units-and-tools). | yes |

`neptunia setup` stops, disables and removes `neptunia-agent-web.service` and `neptunia-agent-host.service` when it finds them in the unit folder, and leaves their state folders in place.

## How a template becomes a unit

The templates keep the paths of the first deployment (`/opt/neptunia/app`, `/opt/neptunia/etc`, `/opt/neptunia/data`, `/opt/node/bin/node`, `/home/neptunia`). `renderUnit` in `src/setup/units.ts` maps them onto the checkout, the private folder, the data folder, the node binary and the home of the installing user. The render is pure, so a rerun renders the same text and writes only the units whose text changed.

The node binary is the one `neptunia setup` was started with, as it was typed or found on `PATH` and never resolved through a link, so a unit names `/opt/node/bin/node` when `/opt/node` is a link to a versioned folder. `neptunia setup --node <path>` names another one.

A subharness backend lives in `<private>/subharness/<backend>/` with its binary and its home (`src/subharness/place.ts`), and a run starts that binary by its path. An agent unit in `read` or `write` binds the folder of every backend a role names in `keys.json` or that is installed writable, one `BindPaths=` entry each after `ProtectHome=tmpfs`. Each entry has a leading `-`, so the unit starts before the backend is installed. They cover those folders alone, and `keys.json` stays read-only for the agent. The core writes the folder through the private directory in its `ReadWritePaths=`. The units keep `<home>/.local/bin` and the folder of the node binary on `PATH`.

A user unit goes to `$XDG_CONFIG_HOME/systemd/user` (`~/.config/systemd/user` when the variable is unset). It has no `User=` or `Group=`, installs into `default.target`, and the interface unit loses its `InaccessiblePaths`, since the one user owns the core's files too.

A system unit, written with `neptunia setup --system`, goes to `/etc/systemd/system` through `sudo install -m 0644`. It runs as the installing user and keeps the template's hardening, and its agent units bind the backend's folder in the private directory as a user unit does.

## The sandbox of an agent unit

An agent unit follows the mode of its unit (`agent mode <unit> <mode>`, see [Errands](../docs/errands.md#modes)). In `read` and `write` the unit keeps every directive of the template. In `full` it drops the mount sandbox: `ProtectSystem`, `ProtectHome` and the write and bind paths. In `sudo` it also drops `NoNewPrivileges` and `CapabilityBoundingSet`, which would stop `sudo`. `agent mode` in the chat stores the mode in `config.json` and renders nothing, because the core runs under `NoNewPrivileges` and cannot use `sudo`. Its answer names `neptunia setup`, which renders the unit again with the stored mode and reloads the manager, and the unit runs in the mode from its next start.

The scout and code units replace the persona folder with an empty `TemporaryFileSystem=` that shows only `agents/` read-only and the backend's folder, so they read neither her memory nor `keys.json`. The modes `full` and `sudo` drop it with the rest of the mount sandbox.

A unit with `ProtectHome=tmpfs` still sees the checkout and the node binary when they lie under the home, because the renderer binds them read-only.

The socket and out folder of a unit derive from its name and need no setting: `/run/neptunia-agent-<unit>/sock` and `/var/lib/neptunia-agent-<unit>/out` for a system unit. `neptunia setup` adds `NEPTUNIA_UNIT_SCOPE=user` to every user unit, which then keeps the socket in its `RuntimeDirectory` (`$XDG_RUNTIME_DIR/neptunia-agent-<unit>/sock`) and the out folder in its `StateDirectory` (`$XDG_STATE_HOME/neptunia-agent-<unit>/out`, by default under `~/.local/state`). The core runs from a user unit too, so it reads the same paths.
