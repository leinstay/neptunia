# The neptunia command

`neptunia` (`bin/neptunia.ts`, the `bin` of `package.json`) is the owner's chat with the persona in a terminal and the one entry the systemd units start. This document is for the owner who runs it and for whoever changes it. Every form reads `NEPTUNIA_PRIVATE_DIR` and `NEPTUNIA_DATA_DIR` as the core does (see [Configuration](configuration.md)), and a usage error exits 2.

| Command | What it does |
|---|---|
| `neptunia` | Opens the chat. |
| `neptunia -p "<command>"` | Runs one command and prints its answer alone. |
| `neptunia doctor [--live] [--json]` | Checks the installation, with the core up or down. |
| `neptunia errand-runner --profile <name>` | Runs the errand runner of one agent, as `deploy/neptunia-agent-<name>.service` does. |
| `neptunia interface run <name> [--interfaces-dir <dir>]` | Runs one interface, as `deploy/neptunia-interface@.service` does (see [Interfaces](interfaces.md#interfaces-as-units)). |
| `neptunia service install\|start\|stop\|restart\|status [<unit> ...]` | Installs the units with `deploy/install.sh`, or runs `systemctl` on the named units, by default `neptunia-core.service` and the two errand units. |
| `neptunia task <command> [options]` | The task board's command line, a client of the core (see [The task board](#the-task-board)). |

## The client

The chat and `-p` are the client `cli` of kind `cli`. Its token is `<private>/clients/cli.token`, which `tools/client-token.mjs add cli --kind cli` writes, and the file must be readable by the user who runs `neptunia`. The command connects to `<data>/run/core.sock` and says `hello` as `iface: 'cli'`, and only a `cli` principal may name that namespace. The core runs its commands with the owner's rights, whatever `bot.owners` says.

## The chat

`neptunia` with no argument opens the chat. It prints the picture in `<private>/cli/picture.txt` when that file exists, then the core's header: the instance (`bot.name`), the engine's version, the core model, today's spend, the interfaces connected, the next wake and the open errands.

Every line typed is a message to the persona. It goes to the core as a `message.received` event in the direct conversation `cli:dm:owner` of kind `dm`, between the owner and her, and she remembers it as any direct chat. The private-chat gate lets it through whatever `features.privateMessages` and `bot.owners` say. Her reply comes back as a send action and is printed once. A line typed before the link is up waits in the input until it is. The chat answers the core's reads of the conversation and of its history from the lines of the session, so a turn sees what was said since the chat opened.

A line that starts with `/` is a command. The chat parses it by the command table (`src/interface/commands/table.ts`) and prints the reason when the table refuses it. A parsed command goes to the core as a `command.requested` event, and its answer is printed for the owner alone: neither the command nor its answer reaches her memory or a request. `/clear`, `/doctor` and `/logs` run in the chat itself, and `/doctor live` asks the core only for the probes. In a terminal the command history is kept in `<private>/cli/history`. The end of the input (Ctrl-D) ends the chat with exit 0 once the answers of the commands still running have arrived.

## Commands

A line is the command, then its subcommand when it has one, then its arguments in order, split on spaces. The last argument takes the rest of the line, so `/rules add never answer before noon` adds one rule, and `/memory lore add Tower tower,spire The tower has seven floors` is the title `Tower`, the keys `tower,spire` and the text. A command with subcommands runs the first one listed below when the line names none, except `/memory`, which needs one. The table refuses an unknown command, an unknown subcommand, a missing argument, a `/health` part other than `server`, `core` or `memory`, and a `/usage` window other than `7d` or `30d`.

The core's console (`src/interface/commands/console.ts`) runs each command with the owner's rights, whatever `bot.owners` says. A command that maps onto an operation runs it through `runOp`. A refused answer starts with the command as it was typed, so it names the id, the tool or the setting it refused.

| Command | What it does |
|---|---|
| `/status` | The short summary: whether the core is paused, today's spend in total and for the core model, the interfaces up or down, each model role that is failing with its reason, the next wake, the open intentions, the errands and the wakes that slept since the start. |
| `/status full` | Every section of the status card as text, with the models of every role and today's costs per role from `usage.json`. It asks no model and reads nothing over the network. The key limits are in `/usage`, the probes in `/doctor live`. |
| `/doctor`, `/doctor live` | The checks of `neptunia doctor`, run by the chat, each with its status. `live` adds the check `providers`: the core probes the model of every role as the status card does. |
| `/health [server\|core\|memory]` | The health of one part, or of all three. See [Health](#health). |
| `/logs [errors] [since <value>] [follow]` | Runs `journalctl -u neptunia-core.service --no-pager` from `PATH` and prints its lines. `errors` adds `-p err`, `since` adds `--since <value>`, and `follow` follows the journal, in the chat only. |
| `/usage [7d\|30d]` | The requests, tokens and dollars of `usage.json` over the window, today without one: by model group (`base`, `errands`, `development`, `memory`) with each role by its name, then by interface, then each key's limit and spend. The key limits come from the status card's GETs. |
| `/errands`, `/errands show <id>`, `/errands cancel <id>` | The latest errands, one errand, or the cancel of an open one (`errand.list`, `errand.status`, `errand.cancel`). |
| `/intentions`, `/intentions show <id>`, `/intentions cancel <id>` | The open intentions, one of them, or its cancel (`intention.list`, `intention.cancel`). |
| `/wakes`, `/wakes stop`, `/wakes start` | The inner life's status: its queue, its next wake and its last turn (`inner.status`). `stop` is its kill switch: no wake runs and the queued ones are dropped until `start` (`inner.stop`, `inner.start`). |
| `/pause`, `/resume` | Stop admission and end the pause. See [Pause](#pause). |
| `/config`, `/config get <path>`, `/config set <path> <value>`, `/config unset <path>` | `config.local.json` as it is, the live value of one setting, or an override written or removed (`config.set`, `config.unset`). |
| `/model`, `/model set <role> <model>` | The model of every role, or the model of one role set in `config.local.json` (`model.show`, `model.set`). Setting `vision` or `video` also sets `media.recacheBefore`. |
| `/route`, `/route set <model> <providers> [role] [fallbacks] [byok]`, `/route remove <model> [role]` | Every route of `llm.providerByModel`, then each role's model and route (`route.list`). `set` routes a model prefix to the comma-separated providers only, for one role or `any`, and `true` for `fallbacks` or `byok` allows other providers or refuses an answer from OpenRouter's own capacity (`route.set`). `remove` drops a route (`route.remove`). |
| `/memory profile <user> [section]`, `affinity <user>`, `private <user>` | A member's profile, affinity and private memory. |
| `/memory conversation <id>`, `recent`, `server`, `journal [<day>]`, `archive [<kind>]` | A conversation's newest 30 stored lines from the memory database, the live recent lines, the server notes, the journal of a day and what left hot memory. |
| `/memory search <query>` | A search of her memory (`memory.search`). |
| `/memory backup` | A backup of the memory database into `memoryDb.backup.dir` (default `../backups/memory`, from the data folder) through `src/memory/db/backup.js`, then the list of the kept ones. A whole-database restore is `tools/memory-db.mjs restore` on a stopped core. |
| `/memory restore <id>` | An archived item back in memory (`memory.restore`). |
| `/memory lore add <title> <keys> <text>`, `lore list [<query>]`, `lore show <id>`, `lore remove <id>` | The lore entries. |
| `/memory aliases add <user> <name>`, `aliases list <user>`, `aliases remove <user> <name>` | A member's aliases. |
| `/memory lessons add <text>`, `lessons list`, `lessons remove <number>` | The lessons. The two lists are reads of the console and no operation, so neither is a tool of hers. |
| `/rules`, `/rules add <text>`, `/rules remove <number>` | The owner's live rules in `prompts.local/rules.md` (`rule.*`). The tracked `prompts/rules.md` is never written. |
| `/tools`, `/tools describe <tool>` | Every tool and whether she has it, or one tool or family in full (`tools.describe`). |
| `/tools grant <tool> [target]`, `/tools revoke <tool> [target]` | Her grant of a tool when no target is given, else the grant of `everyone`, `role <id>` or `user <id>` (`access.grant`, `access.revoke`). Her grant names her user id, so it fails and writes nothing until an interface has said who she is. |
| `/interface`, `/interface enable <name>`, `/interface disable <name>` | Every interface the core knows, enabled or disabled, connected or not, and the owner's switch of one. A disable gives the actions in flight `interfaces.drainMs` and ends the rest `unknown`. `/interface <name> <sub>` is the form of an interface's own subcommands, and no interface has any yet. |
| `/help` | One line per command. |
| `/clear` | Clears the screen. |

## Access

The chat runs every command as the owner. Everyone else reaches an operation through the persona: when a person asks her, she calls her tool under that person's right, and the gateway (`src/tools/gateway.ts`) checks both her grant and the person's. The rights live in `config.local.json` and are read at each call.

An owner (`bot.owners`) may run every operation. Anyone else needs a grant on the exact operation in `bot.access`. `/tools grant <tool> everyone`, `/tools grant <tool> role <id>` and `/tools grant <tool> user <id>` open one operation to everyone, to a role or to a user, and `/tools revoke` with the same target closes it. A group name, such as `memory`, or `*` stores the read operations that exist at that moment, one entry each. It never opens a write, and an operation added later stays closed until it is granted by name. A revoke of a group or of `*` removes the target from every operation stored under it.

No grant opens the owner-only operations, `*` included: `access.*`, `memory.private.read`, `memory.journal.read`, `memory.snapshot`, `memory.archive.read`, `memory.restore` and `inner.*`.

The member operations are open to every member without a grant while `features.memberCommands` is on: `pings.*`, `errand.run`, `errand.status`, `errand.cancel`, `errand.list`, `errand.read`, `errand.resolve`, `web.search`, `web.read`, `media.look`, `media.find`, `memory.search`, `conversation.read`, `places.list` and `tools.describe`. A member switches their own notifications by asking her, and she calls `pings.set` for that member only. Her call needs her own grant too, so the switch works once the owner has run `/tools grant pings.set`.

Each of her tools is closed until `/tools grant <tool>` with no target opens it to her. The same group and `*` rule applies. Her plain reply needs no grant: a message, a reaction or a drawing in the conversation she answers. No grant opens to her `memory.restore`, `rule.remove`, `config.set`, `config.unset`, `model.set`, `route.set`, `route.remove`, `access.grant`, `access.revoke`, `bot.pause`, `bot.resume`, `inner.stop` and `inner.start` (`NOT_GRANTABLE_TO_PERSONA` in `src/tools/access.ts`), and a group grant skips them. They run from the chat alone. The in-turn tools `web.search`, `web.read`, `media.look`, `memory.search` and `conversation.read` answer inside her turn while `features.coreTools` is on.

Each operation has a kind, `read` or `write`, and an effect (`src/tools/impl/effects.ts`). The kind decides what a group or `*` grant stores, and the effect decides the cooldowns and the cost labels.

## Health

`/health` reads three parts, each a function that the command and `neptunia -p "/health <part>"` call. Each part is `ok`, `warn` or `fail`, and a `fail` ends `-p` with exit 1.

The server part (`src/health/server.ts`) reports the free disk under the data folder, the load, the units `neptunia-core.service`, `neptunia-agent-scout.service`, `neptunia-agent-server.service` and every `neptunia-interface@*.service`, the newest memory backup and the firewall. A unit that is not active fails the part. Less than a tenth of the disk free, a fifteen-minute load above two per CPU, or an inactive `ufw` is a warning. A machine without `ufw`, or a `ufw status` that refuses to answer, reports no firewall.

The core part (`src/health/core.ts`) reads the memory database. It counts the stuck errands, which are board tasks of the lane `errand`, `approved` or `in_progress`, whose lease expired: the condition under which the board's reaper reclaims a task. It also counts the deliveries that `failed` and those still `queued`, the undelivered rows of `board_outbox`, the `ingest` rows past their principal's acknowledged sequence and the wakes claimed more than once. The reply latency is the median and the 95th percentile of the `reply` metric over the last day. A stuck errand or a failed send is a warning.

The memory part (`src/health/memory.ts`) looks back seven days. It names every person who spoke in that time (`people.last_seen_at`) about whom nothing was written in it: no claim about them created or seen, no version of such a claim recorded, no version of a description of them written. It names every claim with more than 10 versions recorded in the window, counts the members' lines past the furthest cursor of an applied memory session, and names the newest finished backup. A silent person or a churning claim is a warning.

## One command

`neptunia -p "/status"` sends one command the way the chat does and prints its answer on stdout with nothing else, so a script or an agent reads it. It exits 0 when the command ran and 1 otherwise: a line the table refuses, with the reason on stderr, an operation's `denied`, `invalid` or `failed`, a `/health` part that fails, a `/doctor` with a failed check, or no `journalctl` for `/logs`. When no core listens it exits 1 at once, except for `/doctor`, `/logs` and `/clear`, which need no core. A usage error of `neptunia` itself exits 2. The log lines of the chat and of `-p` go to stderr.

## Pause

`/pause` sets the pause in `state.json`, so a restart while paused stays paused. The turns that run finish, and a reply already on its way is sent. While paused, the core runs no turn, and every message that arrives is still taken: the door observes its line into the memory database and marks its `ingest` row as held, with the whole event, before it acknowledges it. The queued direct pings stay queued. Wakes that fall due during the pause sleep (see [Inner life](inner-life.md)).

`/resume` hands back each held message once, oldest first, through the path of the offline catch-up (`src/behavior/core-pause.ts`), and clears its hold. A held message that calls for an answer gets one turn and one reply when `features.offlineCatchUp` is on and it is younger than `offlineCatchUp.windowMinutes`, and is only observed otherwise. Then the queued direct pings are answered.

## doctor

`neptunia doctor` writes nothing and asks the core nothing unless `--live` is given. It opens the memory database read only and immutable, so it takes no lock and creates no file, and it never prints a key or a token. `--json` prints `{ checks: [{ name, status, detail }] }`, and the plain form prints one line per check. Each check is `ok`, `warn`, `fail` or `skipped`, and any `fail` exits 1. A skipped check could not run here and fails nothing.

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
| `providers` | With `--live` only: the core probes the model of every role, one minimal request each, as the status card does. A failed probe is `warn`. With the core down, or without the `cli` token, the check is `skipped`, because the command line holds no key. |

## The task board

`neptunia task <command>` (`bin/neptunia-task.ts`) is the command line of the task board for the development agents. It takes the commands and flags of the ledger's `task` command, sends each as the board's `task.*` command over the core's socket and prints the core's answer (see [The core](core.md#the-board-on-the-cores-socket)). `neptunia task help` prints them all. Beside the ledger's commands it has `next --lane <lane> --role <role>`, which claims the first ready task of a role and prints it. It also has `block`, `unblock`, `submit` with the handoff as JSON from `--handoff <file>` or `-` for stdin, `review --accept` or `review --changes --comment`, `orient`, and `--parent` on `add`. The holder's calls `heartbeat`, `release`, `result`, `ask`, `block` and `submit` take the lease's generation as `--generation <n>`, the number `next` and `claim` answer. The core refuses `heartbeat`, `release`, `block` and `submit` without it. `update`, `triage`, `move`, `cancel`, `fail` and `result` read the task first for its revision or status. `--json` prints the answer's JSON, `--key <key>` sends an idempotency key, and `--socket <path>` names another socket than `<data>/run/core.sock`.

The token is `NEPTUNIA_TASK_TOKEN` itself, or else the file `<private>/clients/<name>.token` of the client `NEPTUNIA_TASK_CLIENT` names. The command says `hello` as `iface: 'agent'`, so the token must stand for a client of kind `agent`, and that client's `boardRoles` decide what the board lets it do (see [Configuration](configuration.md#clients-and-their-tokens)). It exits 0 when the core answers `ok`. It exits 1 for any other answer, with `<status>: <text>` on stderr, and with `unavailable: ...` when no token is set or no core listens. A usage error (an unknown command, a missing id or a missing required flag) exits 2 before it connects. The commands answer while the core is paused.

## The errand runner

`neptunia errand-runner --profile <name>` is the process of one errand agent (see [Errands](errands.md)). It reads `config.json` and, when its user can read it, the private directory's `config.local.json`, and takes its socket and its output folder from `agents.<name>.socket` and `agents.<name>.out` (`agentSettings` in `src/agent-runner/profiles.js`). An unknown profile exits 1. It serves the agent's tasks on the socket (`src/agent-runner/server.js`), deletes old task folders hourly, and on `SIGTERM` ends the open tasks and exits 0. The scout's search command is `agents/scout/web-search.mjs`, which the wrapper `agents/scout/bin/web-search` runs.
