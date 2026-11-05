# CLI

Run `neptunia` at a terminal to open the owner's chat. Plain text becomes a conversation with the persona. A slash command changes or inspects the installation without becoming a conversational memory.

```bash
neptunia
neptunia status
neptunia rules add "a rule with \"quotes\" and spaces"
neptunia -p "/status"
neptunia -p "what are you doing tonight?"
neptunia doctor live
```

## Access

The CLI authenticates through `data/clients.json` and `data/clients/cli.token`. This trusted owner connection can inspect stored memory across interfaces and private conversations. Talking to the owner in a Discord group does not give that conversation the CLI's memory access.

## Chat controls

| Key | Action |
|---|---|
| Enter | Send |
| Alt+Enter or Ctrl+J | Insert a newline |
| Up and Down | Browse command suggestions or input history |
| Tab | Complete the selected command |
| Esc | Close a panel or cancel input |
| Ctrl+O | Expand folded answers |
| Ctrl+C | Exit the CLI |

The Project Neptunia header shows separate lines for the core, memory and enabled interfaces. Missing reports show a check in progress, and old reports are marked outdated. A lost core connection leaves memory and interface states unknown. The input stays at the bottom as the terminal resizes. `/status` opens the detailed view. `NEPTUNIA_REDUCED_MOTION=1` stops the galaxy animation.

## Settings and setup panels

`/config` opens settings with readable names and descriptions, grouped into tabs. Search accepts both these names and the underlying configuration keys. Use Left and Right or Tab to change tabs, Up and Down to select a row, and Enter to toggle a boolean or edit a value. Typing filters settings across all tabs. In an editor, Enter saves through the normal command handler, Ctrl+U clears the input and Esc cancels.

`/setup` offers core and extra keys, service credentials, interface setup, skill setup and search configuration. Opening it performs no installation or provider check. Selecting an action uses its existing command and any required secret dialog. Model and backend actions prepare the targeted command in the input for you to complete.

`/help` provides searchable command rows. Enter puts the selected command into the input. Command completion includes subcommands such as `/skills setup`.

## Commands

Start with `/help`. It is generated from the command table, so it includes the arguments supported by the installed revision. The slash menu provides completion.

| Task | Command family |
|---|---|
| Inspect health or pause responses | `/status`, `/doctor`, `/pause`, `/resume` |
| Inspect and change settings | `/config get`, `/config set`, `/config unset` |
| Choose credentials and models | `/keys`, `/model`, `/search` |
| Configure a chat platform | `/interfaces` |
| Choose which providers serve a model | `/routes` |
| Link a person's accounts | `/memory bind`, `/memory accounts`, `/memory unbind` |
| Choose where the diary is published | `/mirror` |
| Review and activate a skill | `/skills` |
| Show the sources of the agents and log them in or out | `/subharness status`, `/subharness <backend> login`, `/subharness <backend> status`, `/subharness <backend> logout` |
| Set what an agent may do | `/agent mode <agent> [<mode>]` |
| Schedule, switch and inspect the four scheduled mechanics | `/services` |
| Read a watcher report | `/logs watcher` |

A secret question hides its answer and excludes it from input history. History lives in `data/cli/`.

## Mirrors

`/mirror` manages the places her diary is published to, in the chat and as `neptunia mirror <subcommand>`. A mirror is named by its id or its place id. A bad value answers `invalid` and changes nothing. [Diary](diary.md#mirrors) describes delivery and backfill.

| Command | What it does |
|---|---|
| `/mirror list` | Every mirror and whether it is enabled. This is the bare `/mirror`. |
| `/mirror status` | Each mirror with its interface, queue, failed, incomplete, uncertain and blocked entries, the copies delivered outside their audience, and its backfill. |
| `/mirror add <destination> [--backfill true\|false] [--every <duration>]` | Registers a known place. Adding it again reuses the mirror. |
| `/mirror configure <mirror> [--enabled true\|false] [--backfill true\|false] [--every <duration>]` | Changes a mirror. `--backfill true` needs an interval, given now or earlier. |
| `/mirror disable <mirror>` | Stops sending and keeps the configuration. |
| `/mirror remove <mirror>` | Takes the mirror off the list and keeps its delivery history. |
| `/mirror reconcile <mirror> --through <entry>` | Records every entry up to that one as already published, with the requester's name, and sends nothing. |
| `/mirror reconcile <mirror> --entries <id,id>` | Records the named entries alone. A real receipt stays as it is, and an unknown id refuses the whole command. |
| `/mirror reconcile <mirror> --absent --entries <id,id>` | Says uncertain sends never arrived and queues them again. An entry with no uncertain send refuses the whole command. |

A duration is a whole number with `s`, `m`, `h` or `d`, such as `30m` or `4h`.

## One command from a shell

`neptunia <command> [args]` runs one command of the chat's table through the same parser and handlers as the chat. Each shell word stays one word: only the last positional argument takes loose words, joined with one space, and a value holding quotes, backticks or dollar syntax arrives unchanged. A word the table does not know exits `2` with a usage naming every command, and connects to no core. `doctor`, `logs`, `services` and `clear` run in the command line itself, and `doctor live` equals `doctor --live`.

`neptunia -p "/<command> [args]"` runs the same command as a typed line. `neptunia -p "<text>"` is one turn with the persona: it prints her reply when the turn ends, prints nothing when she stays silent, and ends with its input left open. Text with no leading `/` never runs a command, and blank text exits `2`. A paused core keeps the line for `/resume` and the call exits `1`. The call gives up with exit `1` after 15 minutes without the end of a turn.

| Exit code | Meaning | Output |
|---|---|---|
| `0` | The command ran or the turn ended | The answer on stdout, stderr empty |
| `1` | Any other answer, or no core listening | The reason on stderr, stdout empty |
| `2` | A line the table refuses, an unknown first word, or a request that needs a terminal | The reason on stderr, stdout empty |

`/doctor` through `-p` prints its checks on stdout whatever they found, as `neptunia doctor` does, and exits `1` when a check failed.

The chat with no arguments, `-p /setup`, `-p /clear` and `clear` need a terminal. Without one they exit `2` at once, naming the commands that run without it, and send nothing. `NEPTUNIA_PLAIN_CHAT=1` runs the plain chat over pipes instead of that explanation.

A command that asks a question with no terminal exits `1` with the question on stderr and sends no answer. A secret question also names `--secret-stdin`. That flag is accepted by `keys core add`, `keys extra add`, `keys service set`, `interfaces token set`, and the `setup` and `set` commands of `/interfaces` and `/skills`: it answers the first question, when that question is secret, from stdin less one trailing newline. Empty stdin exits `1`, and so does any other question the command asks.

```bash
printf '%s\n' "$TOKEN" | neptunia interfaces token set discord --secret-stdin
```

On every other command `--secret-stdin` is ordinary text. `keys core add`, `keys extra add`, `keys service set` and `interfaces token set` exit `2` for a word past their name, in the chat and in both shell forms, so a secret never reaches the process list, the core or the logs.

`neptunia subharness <backend> login`, `status` and `logout` run with no core. [Setup](setup.md#subharness-backends) describes them and their exit codes. `/subharness use`, `model`, `mode`, `enable` and `disable` are refused with exit `2`, and the refusal names the command that replaced each: `/model set` for the first two, `/agent mode` for `mode`, and `/subharness <backend> login` and `logout` for the last two.

## Diagnostics

`/doctor` and `neptunia doctor` run the checks of the installation with the core up or down. The check `readiness` says whether a chat would open and names each repair, as in [setup](setup.md#chat-readiness). The last check, `runtime`, is the core's own reading of the server, itself and the memory. It is `skipped` when no core answers within 5 seconds. `/doctor server`, `/doctor core` and `/doctor memory` read one of the three from the core (`src/health/`), ask no model, write nothing and exit `1` with no core. `/doctor live` holds `providers` in place of `runtime`: the core sends one test request for each model role.

## Logs

`/logs` reads the journal of `neptunia-core.service` in the scope of the installation, and a journal it cannot read exits `1` with the scope and the reason. Its filters are `errors`, `follow` and `since <value>`, and `follow` works in the chat alone. `/logs watcher [date or run]` reads the watcher's saved report, the newest with no selector, with no core and without opening the journal. A report names its run and the other runs of its day. A selector that matches no report exits `1`, and `/logs watcher errors`, `follow` or `since` exit `2`, since those words belong to the journal.

## Scheduled services

`neptunia services list` prints the status of `heartbeat`, `selfreflection`, `selfimprovement` and `watcher`, with no process unit among them. `neptunia services <name> setup|enable|disable|status` controls one of the four. `/services <name> <action>` and `neptunia -p "/services ..."` reach the same handler, `src/service/commands.ts`. Selfreflection is the diary wake and selfimprovement is the persona's development wake, which stays apart from the development worker. The handler works with no core, so a mechanic can be switched and read while the core is down. `/pause` and `/resume` hold and release every turn, and `/services <name> disable` stops one mechanic.

`setup --at 00:00,12:00` saves daily UTC times and `setup --every 6h` an interval in hours or minutes (`90m`). The two exclude each other. Both write the one setting `<name>.schedule` that `/config` reads, leave the flag as it is, and answer `timezone: UTC` and `next:` with the next times. `heartbeat setup --jitter 30m` sets `heartbeat.jitterMinutes`, which moves an interval either way and leaves daily times exact. `setup` with no flag asks at a terminal and exits `2` without one. `watcher setup` also renders `neptunia-watcher.timer` and reloads the manager, and starts nothing.

`enable` and `disable` move `<name>.enabled` and run nothing at once. A run already going finishes after `disable`. For the watcher they also run `enable --now` or `disable --now` on the timer and leave `neptunia-watcher.service` alone. A manager call that fails prints `desired:` and `applied:`, exits `1` and keeps the flag, and the same command applies it again.

`status` exits `0` whatever it finds, asks no model and writes nothing.

| Line | What it says |
|---|---|
| `service` | The mechanic |
| `enabled` | The saved flag |
| `running` | Whether a run is going, as the manager says for the watcher. `unknown` for a wake with no core, and for the watcher with no `systemctl` |
| `readiness` | `ready`, or `not ready` and what is missing: the core, a role's subharness source or the repository |
| `schedule` | The schedule, with the heartbeat's jitter. `windows` for a diary with no `selfreflection.schedule` |
| `next due` | The next time, `none` when disabled, `unknown` for a diary drawing from windows with no core |
| `last result` | The newest report of the watcher, the core's last wake of the others, `unknown` with no core |
| `current run` | The watcher's run in progress with its state and source, `none` with no run |
| `last success` | The watcher's newest succeeded run and when it ended |
| `last failure` | The watcher's newest failed run, its code and when it ended |
| `attempts` | The answers the watcher's newest run asked for, `2` when its first was refused, `none` with no run |
| `filing` | The receipts of the last success by state, such as `filed 2, deferred 1`, `none` with no drafts |
| `source` | The watcher's backend, model and effort from `keys.json`, `default` where the backend picks, `unknown` with no backend. Reading it asks no model |
| `run timeout` | How long the watcher's agent may run |
| `timer` | The watcher's timer as the manager reads it |

`neptunia services watcher trigger` starts one inspection without waiting for it and answers `run:` and `state:`. During a run it answers that run and starts nothing. It refuses a disabled watcher, names `services watcher enable` and exits `1`, and a start the manager refuses fails that run and exits `1`. `neptunia services watcher cancel` asks the run in progress to stop and answers `run:` and `state:`, `none` with nothing to stop, and exits `0` however often it is repeated. It changes no flag and no timer. [The watcher](watcher.md#one-run) describes both.

`neptunia services watcher evidence [--from <iso>] [--cursor <c>]` prints one page of the recorded requests and Claude transcripts of the observation window as JSON, with no core and no board. Its keys are `interval`, `runs`, `totalRuns`, `examinedRuns`, `unreviewedRuns`, `inFlightRuns`, `nextCursor` and `gaps`, and the first page, with no `--cursor`, adds `trash`. A `--from` that is no date or a `--cursor` that is no `nextCursor` exits `2`. [The watcher](watcher.md#service-runs) describes the read.

`neptunia setup` with `watcher`, `selfimprovement` or `mechanics` exits `2` and names the command of this family. A word order such as `services status watcher` exits `2` the same way.

## Retired names

Each of these exits `2`, names its replacement and runs nothing, in the chat and in both shell forms.

| Retired | Replacement |
|---|---|
| `service` | `services` |
| `service watcher report`, `report` | `logs watcher` |
| `health` | `doctor` |
| `wakes` | `services list`, and `pause`, `resume` or `services <name> disable` for a stop |
| `route` | `routes` |
| `interface` | `interfaces` |
| `task` | `tasks` |
| `watcher`, `heartbeat`, `selfreflection`, `selfimprovement` | `services <name>` |

## Other entry points

`neptunia setup` performs installation, as one flow with no step of its own to name. `neptunia worker development` is what `neptunia-development.service` starts, and `neptunia worker development held` lists the tasks older than its boundary, as in [self-development](selfimprovement.md#enabling-the-worker). `neptunia interface run <name>` starts a platform package and stays singular, because a unit starts it. `neptunia services start|stop|restart|status [unit]` runs `systemctl` for the named units or the core and the two errand runners, in the scope of the installation, with `sudo` in the system scope except for `status`. These verbs exist in the shell alone and never name a mechanic. `neptunia tasks` addresses the [task board](board.md).

`/status` needs a core connection. For service logs, use the systemd scope selected during [setup](setup.md#services).

Read the implementation in [command table](../src/interface/commands/table.ts), [CLI entry point](../bin/neptunia.ts), [request parsing](../bin/neptunia-request.ts) and [interactive renderer](../cli/app.ts).
