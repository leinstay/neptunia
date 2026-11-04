# The neptunia command

`neptunia` (`bin/neptunia.ts`, the `bin` of `package.json`) is the owner's chat with the persona in a terminal and the one entry that most systemd units start. This document is for the owner who runs it and for whoever changes it. Every form reads `NEPTUNIA_DATA_DIR` as the core does, and a usage error exits 2. `NEPTUNIA_PRIVATE_DIR` is a legacy alias that must name the same folder (see [Getting started](getting-started.md#the-persona-folder)).

| Command | What it does |
|---|---|
| `neptunia` | Opens the chat. |
| `neptunia -p "<command>"` | Runs one command and prints its answer alone. |
| `neptunia doctor [--live] [--json]` | Checks the installation, with the core up or down. |
| `neptunia errand-runner --profile <name>` | Runs the errand runner of one agent (`scout` or `server`), as `deploy/neptunia-agent-<name>.service` does. |
| `neptunia interface run <name> [--interfaces-dir <dir>]` | Runs one interface, as `deploy/neptunia-interface@.service` does (see [Interfaces](interfaces.md)). |
| `neptunia service start\|stop\|restart\|status [<unit> ...]` | Runs `systemctl <verb>` without `--user` on the named units, by default `neptunia-core.service` and the two agent units. |
| `neptunia setup [--system] [--node <path>] [<step>]` | Installs for one user: folders, key store, interfaces, services, subharness backends, her self-development repository, her mechanics, the watcher, units, linger and the core, then opens the chat on `/keys core add`. See [Setup](setup.md). |
| `neptunia setup subharness <backend> [--from <path>] [--version <version>] [--rollback]` | Installs one subharness backend into the persona folder, or changes its pinned version, and prints its login line. See [Setup](setup.md#subharness-backends). |
| `neptunia task <command> [options]` | The task board's command line, a client of the core (see [The task board](#the-task-board)). |
| `neptunia selfimprovement run` | One beat of her self-development as the client `selfimprovement`: takes her fix proposals, works the approved ones into pull requests and looks at the open ones (see [Self-development](selfimprovement.md)). |
| `neptunia watcher run` | One run of the daily watcher, as `deploy/neptunia-watcher.service` does (see [The watcher](watcher.md)). |

## The client

A client of the core is of kind `interface`, `cli` or `agent`. The chat and `-p` are the client `cli` of kind `cli`. Its token is `data/clients/cli.token`, written by `node scripts/client-token.ts add cli --kind cli`, and the user who runs `neptunia` must be able to read it. The command connects to `data/run/core.sock` and says `hello` as `iface: 'cli'`, a namespace that only a `cli` principal may name. The core runs the chat's commands with the owner's rights, whatever `bot.owners` says.

A line typed in the chat is read with an internal memory context that `src/behavior/core-message-producers.ts` issues for an authenticated `cli` sender. Her automatic prefetch and `memory.search`, anchor windows included, read every stored audience, and the reply stays in `cli:dm:owner`. Ordinary group and DM turns keep their audience filters, and no event field or tool argument can ask for this authority. A line that waits behind another turn keeps its context in the pending queue and never merges with another message. A restart discards it.

## The chat

`neptunia` with no argument opens the chat. Every line typed is a message to the persona. It goes to the core as a `message.received` event in the direct conversation `cli:dm:owner` of kind `dm`, between the owner and her, and she remembers it as any direct chat. The private-chat gate lets it through whatever `private.enabled` and `bot.owners` say. Her reply comes back as a send action and is printed once. A line typed before the link is up waits in the input until it is. The chat answers the core's reads of the conversation and of its history from the lines of the session, so a turn sees what was said since the chat opened.

A line that starts with `/` is a command. The chat parses it by the command table (`src/interface/commands/table.ts`) and prints the reason when the table refuses it. A parsed command goes to the core as a `command.requested` event, and its answer is shown for the owner alone: neither the command nor its answer reaches her memory or a request. `/clear`, `/doctor`, `/logs` and `/report` run in the chat itself, and `/doctor live` asks the core only for the probes.

### The interactive screen

In a terminal, when stdin and stdout are both terminals and `NEPTUNIA_PLAIN_CHAT` is not `1`, the chat is drawn by `cli/` (`runInkChat` in `bin/neptunia.ts`, `ChatApp` in `cli/app.ts`, built with Ink and written with `React.createElement`). It shows:

- a header with a rotating galaxy, the title `neptunia` and a status line
- the conversation, with the owner's lines after `> `, her replies and the command answers dimmed
- the input line with its slash menu
- a panel with a search for `/help`, `/status`, `/status full` and `/config`

Every 15 seconds the status line asks `/status brief`, and the core answers from what it already knows without calling a provider. The line shows the link to the core, the core's state with the reason of a pause, the memory writer's path, model and last probe, and each enabled interface as up or down. A poll older than a minute adds `stale`, and a closed link reads `link: lost`. `NEPTUNIA_REDUCED_MOTION=1`, `TERM=dumb` or a set `NO_COLOR` stills the galaxy.

| Key | Effect |
|---|---|
| Enter | Sends the line. |
| Alt+Enter or Ctrl+J | Adds a line break. |
| Up and Down | Walk the history, or the menu while it is open. |
| Tab | Completes the highlighted command. |
| Esc | Clears the line, answers an open question with an empty line, and closes a panel. |
| Ctrl+O | Shows or folds the answers longer than 20 lines. |
| Ctrl+C, or Ctrl+D on an empty line | Leaves. |

While the line starts with `/` and holds no space, the menu lists the commands whose name starts with the typed text, then those whose help line holds it, ten at most. A question a command asks replaces the input, and a secret answer is drawn as `*` and kept out of the history. The history is written to `data/cli/history` at mode `0600`, up to 1000 lines. `/clear` clears the display and nothing else, and leaving ends only this process: the core goes on. The screen shows neither the core's header nor `picture.txt`, and `/logs follow` is refused in it.

### The plain chat

With `NEPTUNIA_PLAIN_CHAT=1`, with no terminal on stdin or stdout, and when `neptunia setup` opens it, the chat is line by line. It prints the picture in `data/cli/picture.txt` when that file exists, then the core's header. The header names the instance (the value of `bot.name`, or `neptunia` while that key is unset), the engine's version, the core model, today's spend, the interfaces connected, the next wake and the open errands. In a terminal it prompts with `> ` and keeps the command history in `data/cli/history`. `/logs follow` follows the journal here, and `/clear` clears the screen. The end of the input (Ctrl-D) ends the chat with exit 0 once the answers of the commands still running have arrived.

## Commands

A line is the command, then its subcommand when it has one, then its arguments in order, split on spaces. The last argument takes the rest of the line, so `/rules add never answer before noon` adds one rule, and `/memory lore add Tower tower,spire The tower has seven floors` is the title `Tower`, the keys `tower,spire` and the text.

A command with a default subcommand runs it when the line names none, and `/memory` and `/keys` refuse a bare line. The table refuses an unknown command or subcommand, a missing argument, an argument outside its choices and a `/report` date that is not a real date written `YYYY-MM-DD`. A choice is, for example, the part of `/health` (`server`, `core` or `memory`) or the window of `/usage` (`7d` or `30d`).

The core's console (`src/interface/commands/console.ts`) runs each command with the owner's rights. A command that maps onto an operation runs it through `runOp`. A refused answer starts with the command as it was typed, so it names the id, the tool or the setting it refused.

| Command | What it does |
|---|---|
| `/status` | The short summary: whether the core is paused (since when and why), today's spend in total and for the core model, the interfaces up or down, each model role that is failing with its reason, the next wake, the open intentions, the errands and the wakes that slept since the start. |
| `/status brief` | What the interactive status line reads, as JSON: `core` (`state`, `reason`), `memory` (`path`, `model`, `probe`, `checkedAt`) and `interfaces` (`name`, `enabled`, `connected`). It asks no model. |
| `/status full` | Every section of the status card as text, with the models of every role and today's costs per role. It reads nothing over the network. The key limits are in `/usage`, the probes in `/doctor live`. |
| `/doctor`, `/doctor live` | The checks of `neptunia doctor`, run by the chat. `live` adds the check `providers`: the core probes the model of every role as the status card does. |
| `/health [server\|core\|memory]` | The health of one part, or of all three. See [Health](#health). |
| `/logs [errors] [since <value>] [follow]` | Runs `journalctl -u neptunia-core.service --no-pager` from `PATH` and prints its lines. `errors` adds `-p err`, `since` adds `--since <value>`, and `follow` adds `-f` in the plain chat only. |
| `/report [<date>]` | The watcher's latest report, or the report of a date written `YYYY-MM-DD`, read from `data/agents/watcher/reports` and rendered for the terminal. A day with no report answers one line. See [The watcher](watcher.md). |
| `/usage [7d\|30d]` | The requests, tokens and dollars over the window (today without one), by model group (`base`, `errands`, `development`, `memory`) with each role by its name, then by interface, then each key's limit and spend. |
| `/errands`, `/errands show <id>`, `/errands cancel <id>` | The latest errands, one errand, or the cancel of an open one. |
| `/intentions`, `/intentions show <id>`, `/intentions cancel <id>` | The open intentions, one of them, or its cancel. |
| `/wakes`, `/wakes stop`, `/wakes start` | The inner life's queue, next wake and last turn. `stop` is its kill switch: no wake runs and the queued ones are dropped until `start`. |
| `/pause`, `/resume` | Stop admission and end the pause. See [Pause](#pause). |
| `/config`, `/config get <path>`, `/config set <path> <value>`, `/config unset <path>` | `data/config/config.json` as it is, the live value of one setting, or an override written or removed. |
| `/config check` | Each key of `data/config/config.json` that the settings schema does not know and each key whose value has the wrong type, one line each. The answer fails when there is one and reads `every key is known and of its type` otherwise. |
| `/model`, `/model set <role> [<model>] [--provider <slug>] [--effort <level>] [--via <backend>]` | The model of every role, or the model of one role set in `data/config/config.json` after a check. See [Keys](keys.md#the-commands). Setting `vision` or `video` also sets `media.recacheBefore`. `scout`, `server`, `dev` and `watcher` go to their subharness, and `--via` moves the memory writer to a backend. |
| `/route`, `/route set <model> <providers> [role] [fallbacks] [byok]`, `/route remove <model> [role]` | Every route of `llm.providerByModel`, then each role's model and route. `set` routes a model prefix to the comma-separated providers only, for one role or `any`, and `true` for `fallbacks` or `byok` allows other providers or refuses an answer from OpenRouter's own capacity. `remove` drops a route. |
| `/memory profile <user> [section]`, `affinity <user>`, `private <user>` | A member's profile, affinity and private memory. |
| `/memory conversation <id>`, `recent`, `server`, `journal [<day>]`, `archive [<kind>]` | A conversation's newest 30 stored lines, the live recent lines, the server notes, the journal of a day and what left hot memory. |
| `/memory search <query>` | A search of her memory. |
| `/memory backup` | A backup of the memory database into `memoryDb.backup.dir` (default `../backups/memory`, from the persona folder) through `src/memory/db/backup.ts`, then the list of the kept ones. A whole-database restore is `scripts/memory-db.ts restore` on a stopped core. |
| `/memory restore <id>` | An archived item back in memory. |
| `/memory lore add <title> <keys> <text>`, `lore list [<query>]`, `lore show <id>`, `lore remove <id>` | The lore entries. |
| `/memory bind <iface> <account> <iface> <account>`, `bind <iface> <account> self`, `bind <iface> <account> owner`, `unbind <iface> <account>`, `accounts <iface> <account>` | One person with several accounts: bind two accounts so they share a person (the second form binds an account of the persona, the third makes the account's person the owner person), undo a bind, or list the accounts of the person an account belongs to. Only this command links accounts, and an account she has not met is refused. |
| `/memory aliases add <user> <name>`, `aliases list <user>`, `aliases remove <user> <name>` | A member's aliases. |
| `/memory lessons add <text>`, `lessons list`, `lessons remove <number>` | The lessons. |
| `/rules`, `/rules add <text>`, `/rules remove <number>` | The owner's live rules in `data/prompts/rules.md`. The tracked `prompts/rules.md` is never written. |
| `/tools`, `/tools describe <tool>` | Every tool and whether she has it, or one tool or family in full. |
| `/tools grant <tool> [target]`, `/tools revoke <tool> [target]` | Her grant of a tool when no target is given, else the grant of `everyone`, `role <id>` or `user <id>`. Her grant names her user id, so it fails and writes nothing until an interface has said who she is. |
| `/skills`, `/skills show <name>`, `review <name>`, `pending`, `activate <name>`, `rollback <name>`, `reject <name>`, `enable <name>`, `disable <name>` | Her skills with their state, one skill's active text, a skill's versions side by side, the versions waiting, and the owner's changes to them. See [Skills](skills.md). |
| `/skills setup <name>`, `settings <name>`, `set <name> <key> [<value>]`, `clear <name> <key>`, `add <name> <key> <value>`, `remove <name> <key> <value>` | The settings of an executable skill, through its `setup.json` (see [Setup](setup.md#the-setup-contract-of-a-module)). |
| `/interface`, `/interface enable <name>`, `/interface disable <name>` | Every interface the core knows, enabled or disabled, connected or not, and the owner's switch of one. A disable gives the actions in flight `interfaces.drainMs` and ends the rest `unknown`. |
| `/interface token set <name>`, `setup <name>`, `settings <name>`, `set\|clear\|add\|remove <name> <key> ...` | The platform token of an interface, written to `data/interfaces/<name>/credentials.json` after the chat asks for it without echo, and the settings of an interface through its `setup.json`. `/interface <name> <sub>` is answered with `has no commands of its own`. |
| `/search`, `/search enable`, `/search disable`, `/search engine <openrouter\|brave\|exa>`, `/search model <id>` | Quick search: on or off, its engine and its model, written to `web.search.enabled`, `web.search.engine` and `web.search.model`. The status line reads the personal settings file only, so it says `unset` for an engine that file does not hold, although the shipped default is `brave`. Its key is bound with `/keys bind search <name>`. |
| `/keys core add\|remove\|list\|grant ...`, `extra add\|remove\|list <name>`, `service list\|set\|clear <name>`, `bind <role> <name>`, `unbind <role>`, `check <role>` | The model keys and service keys of the deployment. An add asks the value in the chat without echo. See [Keys](keys.md). |
| `/subharness`, `/subharness status` | Every connected backend, opencode's key by name, who enforces `read` and `write` under each backend, the mode, backend, model and effort of every agent, and the memory writer's path. |
| `/subharness enable <codex\|claude\|opencode> [--key <name>]` | Connects one more backend after a check, the ones connected before kept: the binary and one reply for `codex` and `claude`, the named extra key answering `/auth/key` for `opencode`, which needs `--key`. It then asks which model each agent runs on, one question at a time, and checks each answer with one reply. A failed check changes nothing. |
| `/subharness use <agent> <backend>` | Names the connected backend one agent runs through. |
| `/subharness model <agent> <model> [--effort <level>]` | Sets one agent's model, and its effort when given, after the same one-reply check at that effort. |
| `/subharness disable <backend>` | Disconnects one backend. With none left every agent task is refused with `subharness-off` until one is connected again, and the modes are kept. |
| `/subharness mode <agent> [<mode>]` | Shows the mode of `scout`, `server`, `dev` or `watcher`, or sets it to `read`, `write`, `full` or `sudo` in `keys.json`. The agent's unit takes the mode when `neptunia setup units` runs in a shell, because the core runs under `NoNewPrivileges` and cannot use `sudo`. Only this chat sets a mode. |
| `/simulation`, `/simulation status` | Whether the paid scripts may run, and the name of the key they spend. |
| `/simulation enable --key <name>`, `/simulation disable` | Names an extra key for the scripts, or switches the simulation off so they refuse to run. |
| `/help` | One line per command. |
| `/clear` | Clears the screen. |

The agents named under `/subharness` and what each mode allows are in [Errands](errands.md).

## Access

The chat runs every command as the owner. Everyone else reaches an operation through the persona: when a person asks her, she calls her tool under that person's right, and the gateway (`src/tools/gateway.ts`) checks both her grant and the person's. The grants live in `bot.access` of `data/config/config.json` and are read at each call.

An owner may run every operation. The owner is every account bound to the person in `bot.ownerPerson`, and until that is set the ids in `bot.owners` on the home interface (see [One person, several accounts](memory.md#one-person-several-accounts)). Anyone else needs a grant on the exact operation. `/tools grant <tool> everyone`, `/tools grant <tool> role <id>` and `/tools grant <tool> user <id>` open one operation to everyone, to a role or to a user, and `/tools revoke` with the same target closes it. A group name, such as `memory`, or `*` stores the read operations that exist at that moment, one entry each. It never opens a write, and an operation added later stays closed until it is granted by name. A revoke of a group or of `*` removes the target from every operation stored under it.

No grant opens the owner-only operations, `*` included: `access.grant`, `access.revoke`, `access.list`, `inner.stop`, `inner.start`, `inner.status`, `memory.private.read`, `memory.journal.read`, `memory.snapshot`, `memory.archive.read` and `memory.restore`.

The member operations are open to every member without a grant: `pings.get`, `pings.set`, `errand.run`, `errand.status`, `errand.cancel`, `errand.list`, `errand.read`, `errand.resolve`, `web.search`, `web.read`, `media.look`, `media.find`, `memory.search`, `conversation.read`, `tools.describe`, `board.propose` and `board.status`. A member switches their own notifications by asking her, and she calls `pings.set` for that member only.

Each of her tools is closed to her until `/tools grant <tool>` with no target opens it. The same group and `*` rule applies. Her plain reply needs no grant: a message, a reaction or a drawing in the conversation she answers. No grant opens to her `memory.restore`, `rule.remove`, `config.set`, `config.unset`, `model.set`, `route.set`, `route.remove`, `access.grant`, `access.revoke`, `bot.pause`, `bot.resume`, `inner.stop` and `inner.start` (`NOT_GRANTABLE_TO_PERSONA` in `src/tools/access.ts`), and a group grant skips them. They run from the chat alone.

Each operation has a kind, `read` or `write`, and an effect (`src/tools/impl/effects.ts`). The kind decides what a group or `*` grant stores, and the effect decides the cooldowns and the cost labels.

## Health

`/health` reads three parts, each a function that the command and `neptunia -p "/health <part>"` call. Each part is `ok`, `warn` or `fail`, and a `fail` ends `-p` with exit 1.

The server part (`src/health/server.ts`) reports the free disk under the persona folder, the load, the units `neptunia-core.service`, `neptunia-agent-scout.service`, `neptunia-agent-server.service` and every `neptunia-interface@*.service`, the newest memory backup and the firewall. A unit that is not active fails the part. Less than a tenth of the disk free, a fifteen-minute load above two per CPU, or an inactive `ufw` is a warning. A machine without `ufw`, or a `ufw status` that refuses to answer, reports no firewall. The unit probes call `systemctl` without `--user`.

The core part (`src/health/core.ts`) reads the memory database. It counts the stuck errands, which are board tasks of the lane `errand`, `approved` or `in_progress`, whose lease expired: the condition under which the board's reaper reclaims a task. It also counts the deliveries that `failed` and those still `queued`, the undelivered rows of `board_outbox`, the `ingest` rows past their principal's acknowledged sequence and the wakes claimed more than once. The reply latency is the median and the 95th percentile of the `reply` metric over the last day. A stuck errand or a failed send is a warning.

The memory part (`src/health/memory.ts`) looks back seven days. It names every person who spoke in that time (`people.last_seen_at`) about whom nothing was written in it: no claim about them created or seen, no version of such a claim recorded, no version of a description of them written. It names every claim with more than 10 versions recorded in the window, counts the members' lines past the furthest cursor of an applied memory session, and names the newest finished backup. A silent person or a churning claim is a warning.

## One command

`neptunia -p "/status"` sends one command the way the chat does and prints its answer on `stdout` with nothing else, so a script or an agent reads it.

It exits 0 when the command ran and 1 otherwise. Exit 1 covers a line the table refuses (the reason goes to stderr), an operation's `denied`, `invalid` or `failed`, a failing `/health` part, a `/doctor` with a failed check, no `journalctl` for `/logs` and no report for `/report`. When no core listens it exits 1 at once, except for `/doctor`, `/logs`, `/report` and `/clear`, which need no core. More than one argument, or a usage error of `neptunia` itself, exits 2. The log lines of the chat and of `-p` go to stderr.

A command that asks a question, such as a key value, reads the answer from the terminal when stdin is one. Without a terminal it answers `invalid`.

## Pause

`/pause` sets the pause in the core's state, so a restart while paused stays paused. The turns that run finish, and a reply already on its way is sent. While paused, the core runs no turn, and every message that arrives is still taken: the door observes its line into the memory database and marks its `ingest` row as held, with the whole event, before it acknowledges it. The owner's own chat is observed too. Wakes that fall due during the pause sleep (see [Inner life](inner-life.md)).

`/resume` hands back each held message once, oldest first, through `resumeHeld` (`src/behavior/core-pause.ts`) and clears its hold. A held message from a community goes through the catch-up path as history and starts no turn. Then the queued direct messages are drained. A pause can also carry a reason that `/status` shows: `no-core-key` after the last core key was removed, and `memory-down` after a failed memory probe. A pause the owner sets over one of those becomes the owner's.

## doctor

`neptunia doctor` writes nothing and asks the core nothing unless `--live` is given. It opens the memory database read only and immutable, so it takes no lock and creates no file, and it never prints a key or a token. `--json` prints `{ checks: [{ name, status, detail }] }`, and the plain form prints one line per check. Each check is `ok`, `warn`, `fail` or `skipped`, and any `fail` exits 1. A skipped check could not run here and fails nothing.

| Check | What it looks at |
|---|---|
| `node` | The major version of Node: 26, as `package.json` `engines` says. |
| `binaries` | `ffmpeg`, which voice messages need. Missing is `warn`. |
| `config` | `config/config.json` and the persona's `config/config.json` parse, and the persona's file holds only keys the settings schema knows, each of a type the key takes (`src/config/check.ts`). A file that is no JSON, a missing tracked file and a legacy layout in the persona folder are `fail`. No persona file, an unknown key and a key of the wrong type are `warn`. |
| `local-layer` | The persona folder exists (`fail` without it). |
| `env-keys` | The key store: `fail` without `keys.json`, `warn` while it holds no core key, `ok` with the number of core keys. Counts only. |
| `roles` | A base model role set to `false` in `models.base.<role>`, or, with no `keys.json`, a role whose key never falls back (`memory`). Either is `warn`. |
| `tokens` | Every client of `clients.json` has a token file that is not empty and that only its owner can read (`fail` otherwise). No `clients.json` is `warn`: only an in-process interface connects. |
| `features` | The subharness and the simulation. Either one off is `warn`, with the command that turns it on. |
| `database` | `PRAGMA quick_check` of the memory database. A missing database is `warn`. |
| `socket` | `data/run/core.sock` exists and the core answers on it (`fail` otherwise). |
| `providers` | With `--live` only: the core probes the model of every role, one minimal request each, as the status card does. A failed probe is `warn`. With the core down, or without the `cli` token, the check is `skipped`, because the command line holds no key. |

## The task board

`neptunia task <command>` (`bin/neptunia-task.ts`) is the command line of the task board for the development agents. It sends each command as the board's `task.*` command over the core's socket and prints the core's answer (see [The core](core.md) and [The task board](board.md)). `neptunia task help` prints every command and flag. `next --lane <lane> --role <role>` claims the first ready task of a role and prints it. `submit` takes the handoff as JSON from `--handoff <file>` or `-` for stdin, and `review` takes `--accept` or `--changes --comment`. The holder's calls `heartbeat`, `release`, `block` and `submit` take the lease's generation as `--generation <n>`, the number `next` and `claim` answer, and the core refuses them without it. `skill-pending` and `skill-activate <name>` list and activate the `SKILL.md` versions (see [Skills](skills.md)). `--json` prints the answer's JSON, `--key <key>` sends an idempotency key, and `--socket <path>` names another socket than `data/run/core.sock`.

The token is `NEPTUNIA_TASK_TOKEN` itself, or else the file `data/clients/<name>.token` of the client `NEPTUNIA_TASK_CLIENT` names. The command says `hello` as `iface: 'agent'`, so the token must stand for a client of kind `agent`, and that client's `boardRoles` decide what the board lets it do (`scripts/client-token.ts add <name> --kind agent --roles <role>`). It exits 0 when the core answers `ok`. It exits 1 for any other answer, with `<status>: <text>` on stderr, and with `unavailable: ...` when no token is set or no core listens. A usage error (an unknown command, a missing id or a missing required flag) exits 2 before it connects. The commands answer while the core is paused.

## The errand runner

`neptunia errand-runner --profile <name>` is the process of one errand agent (see [Errands](errands.md)). It reads `config/config.json` and, when its user can read it, the persona's `config/config.json`, and takes its socket and its output folder from `agents.<name>.socket` and `agents.<name>.out` (`agentSettings` in `src/agent-runner/profiles.ts`). In a user unit, which has `NEPTUNIA_UNIT_SCOPE=user`, those default to the unit's runtime and state folders. An unknown profile exits 1. The runner serves the agent's tasks on the socket (`src/agent-runner/server.ts`), deletes task folders older than `errands.keepFilesHours` (default 24) hourly, and on `SIGTERM` ends the open tasks and exits 0. The scout's search command is `agents/scout/web-search.ts`, which the wrapper `agents/scout/bin/web-search` runs.

## Interfaces as units

`neptunia interface run <name>` loads `<dir>/<name>/index.ts` or `index.js` and calls its `start(host)`. `<dir>` is `data/interfaces` when the persona folder holds an authored package with an entry point, else `interfaces/` of the checkout, or the folder `--interfaces-dir` names. The runner reads the client token from `data/clients/<name>.token`. It gives the interface `data/interfaces/<name>` as its `dataDir` and the platform token from `data/interfaces/<name>/credentials.json` in `env`, under the variable `<NAME>_TOKEN` (`DISCORD_TOKEN` for `discord`).

The interface's settings are `config/config.json`, then the persona's `config/config.json`, then the package's own `config.json`, then `data/interfaces/<name>/config.json`, read again whenever one of the files changes. A link that drops is opened again with backoff, from a quarter second doubling to 30 seconds, and the backoff starts over once a link stayed up for 30 seconds. An interface that cannot reconnect (no `reconnect()`) ends the process with exit code 1, and its unit restarts it. `SIGTERM` and `SIGINT` stop the interface and exit 0.
