# The neptunia command

`neptunia` (`bin/neptunia.ts`, the `bin` of `package.json`) is the owner's chat with the persona in a terminal and the one entry the systemd units start. This document is for the owner who runs it and for whoever changes it. Every form reads `NEPTUNIA_PRIVATE_DIR` and `NEPTUNIA_DATA_DIR` as the core does (see [Configuration](configuration.md)), and a usage error exits 2.

| Command | What it does |
|---|---|
| `neptunia` | Opens the chat. |
| `neptunia -p "<command>"` | Runs one command and prints its answer alone. |
| `neptunia doctor [--json]` | Checks the installation, with the core up or down. |
| `neptunia errand-runner --profile <name>` | Runs the errand runner of one agent, as `deploy/neptunia-agent-<name>.service` does. |
| `neptunia interface run <name> [--interfaces-dir <dir>]` | Runs one interface, as `deploy/neptunia-interface@.service` does (see [Interfaces](interfaces.md#interfaces-as-units)). |
| `neptunia service install\|start\|stop\|restart\|status [<unit> ...]` | Installs the units with `deploy/install.sh`, or runs `systemctl` on the named units, by default `neptunia-core.service` and the two errand units. |
| `neptunia task <command> [options]` | The task board's command line, a client of the core (see [The task board](#the-task-board)). |

## The client

The chat and `-p` are the client `cli` of kind `cli`. Its token is `<private>/clients/cli.token`, which `tools/client-token.mjs add cli --kind cli` writes, and the file must be readable by the user who runs `neptunia`. The command connects to `<data>/run/core.sock` and says `hello` as `iface: 'cli'`, and only a `cli` principal may name that namespace. The core runs its commands with the owner's rights, whatever `bot.owners` says.

## The chat

`neptunia` with no argument opens the chat. It prints the picture in `<private>/cli/picture.txt` when that file exists, then the core's header: the instance (`bot.name`), the engine's version, the core model, today's spend, the interfaces connected, the next wake and the open errands.

Every line typed is a message to the persona. It goes to the core as a `message.received` event in the direct conversation `cli:dm:owner` of kind `dm`, between the owner and her, and she remembers it as any direct chat. The private-chat gate lets it through whatever `features.privateMessages` and `bot.owners` say. Her reply comes back as a send action and is printed once. A line typed before the link is up waits in the input until it is. The chat answers the core's reads of the conversation and of its history from the lines of the session, so a turn sees what was said since the chat opened.

A line that starts with `/` is a command. It goes to the core as a `command.requested` event, and its answer is printed for the owner alone: neither the command nor its answer reaches her memory or a request. `/clear` clears the screen and asks the core nothing. In a terminal the command history is kept in `<private>/cli/history`. The end of the input (Ctrl-D) ends the chat with exit 0 once the answers of the commands still running have arrived.

| Command | What it does |
|---|---|
| `/status` | The short summary: whether the core is paused, today's spend in total and for the core model, the interfaces up or down, each model role that is failing with its reason, the next wake, the open intentions, the errands and the wakes that slept since the start. It reads what the core holds and asks no model. |
| `/pause` | Stops admission: the turns that run finish, and nothing new starts. See [Pause](#pause). |
| `/resume` | Ends the pause and hands back what it kept. |
| `/wakes` | The inner life's status: its queue, its next wake and its last turn (`/nep task inner status`). |
| `/errands` | The latest errands (`/nep task list`). |
| `/intentions` | The open intentions (`/nep task intent list`). |
| `/interface list` | Every interface the core knows, enabled or disabled, connected or not. |
| `/interface enable <name>`, `/interface disable <name>` | The owner's switch of one interface. A disable gives the actions in flight `interfaces.drainMs` and ends the rest `unknown`. |
| `/help` | The commands. |
| `/clear` | Clears the screen. |

The core's side of these commands is `src/interface/neptunia-cli.ts` (see [Commands over the link](interfaces.md#commands-over-the-link)).

## One command

`neptunia -p "/status"` sends one command the way the chat does and prints its answer on stdout with nothing else, so a script or an agent reads it. It exits 0 when the core answers `ok` and 1 for any other answer. When no core listens it exits 1 at once. The log lines of the chat and of `-p` go to stderr.

## Pause

`/pause` (and `/nep pause`) sets the pause in `state.json`, so a restart while paused stays paused. The turns that run finish, and a reply already on its way is sent. While paused, the core runs no turn, and every message that arrives is still taken: the door observes its line into the memory database and marks its `ingest` row as held, with the whole event, before it acknowledges it. The queued direct pings stay queued. Wakes that fall due during the pause sleep (see [Inner life](inner-life.md)).

`/resume` hands back each held message once, oldest first, through the path of the offline catch-up (`src/behavior/core-pause.ts`), and clears its hold. A held message that calls for an answer gets one turn and one reply when `features.offlineCatchUp` is on and it is younger than `offlineCatchUp.windowMinutes`, and is only observed otherwise. Then the queued direct pings are answered.

## doctor

`neptunia doctor` asks the core nothing and writes nothing. It opens the memory database read only and immutable, so it takes no lock and creates no file, and it never prints a key or a token. `--json` prints `{ checks: [{ name, status, detail }] }`, and the plain form prints one line per check. Each check is `ok`, `warn` or `fail`, and any `fail` exits 1.

| Check | What it looks at |
|---|---|
| `node` | The major version of Node: 26, as `package.json` `engines` says. |
| `binaries` | `ffmpeg`, which voice messages need. Missing is `warn`. |
| `config` | `config.json` and `config.local.json` parse, and each key of `config.local.json` has the type `config.json` gives it. A key of another type is `warn`, except a model role set to `false`. |
| `local-layer` | The private directory exists, and whether `prompts.local/` is there. |
| `env-keys` | `.env` in the private directory sets `OPENROUTER_CORE_KEY` (`fail` without it) and every key `llm.keyByRole` names (`warn` for a missing one). Names only. |
| `roles` | A model role switched off with `models.base.<role>: false`, or a role whose key never falls back (`memory`) without its `llm.keyByRole` variable. Either is `warn`. |
| `tokens` | Every client of `clients.json` has a token file that is not empty and that only its owner can read. |
| `database` | `PRAGMA quick_check` of the memory database. A missing database is `warn`. |
| `socket` | `<data>/run/core.sock` exists and the core answers on it. |

## The task board

`neptunia task <command>` (`bin/neptunia-task.ts`) is the command line of the task board for the development agents. It takes the commands and flags of the ledger's `task` command, sends each as the board's `task.*` command over the core's socket and prints the core's answer (see [The core](core.md#the-board-on-the-cores-socket)). `neptunia task help` prints them all. Beside the ledger's commands it has `next --lane <lane> --role <role>`, which claims the first ready task of a role and prints it. It also has `block`, `unblock`, `submit` with the handoff as JSON from `--handoff <file>` or `-` for stdin, `review --accept` or `review --changes --comment`, `orient`, and `--parent` on `add`. The holder's calls `heartbeat`, `release`, `result`, `ask`, `block` and `submit` take the lease's generation as `--generation <n>`, the number `next` and `claim` answer. The core refuses `heartbeat`, `release`, `block` and `submit` without it. `update`, `triage`, `move`, `cancel`, `fail` and `result` read the task first for its revision or status. `--json` prints the answer's JSON, `--key <key>` sends an idempotency key, and `--socket <path>` names another socket than `<data>/run/core.sock`.

The token is `NEPTUNIA_TASK_TOKEN` itself, or else the file `<private>/clients/<name>.token` of the client `NEPTUNIA_TASK_CLIENT` names. The command says `hello` as `iface: 'agent'`, so the token must stand for a client of kind `agent`, and that client's `boardRoles` decide what the board lets it do (see [Configuration](configuration.md#clients-and-their-tokens)). It exits 0 when the core answers `ok`. It exits 1 for any other answer, with `<status>: <text>` on stderr, and with `unavailable: ...` when no token is set or no core listens. A usage error (an unknown command, a missing id or a missing required flag) exits 2 before it connects. The commands answer while the core is paused.

## The errand runner

`neptunia errand-runner --profile <name>` is the process of one errand agent (see [Errands](errands.md)). It reads `config.json` and, when its user can read it, the private directory's `config.local.json`, and takes its socket and its output folder from `agents.<name>.socket` and `agents.<name>.out` (`agentSettings` in `src/agent-runner/profiles.js`). An unknown profile exits 1. It serves the agent's tasks on the socket (`src/agent-runner/server.js`), deletes old task folders hourly, and on `SIGTERM` ends the open tasks and exits 0. The scout's search command is `agents/scout/web-search.mjs`, which the wrapper `agents/scout/bin/web-search` runs.
