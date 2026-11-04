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
| Inspect health or pause responses | `/status`, `/pause`, `/resume` |
| Inspect and change settings | `/config get`, `/config set`, `/config unset` |
| Choose credentials and models | `/keys`, `/model`, `/search` |
| Configure a chat platform | `/interface` |
| Link a person's accounts | `/memory bind`, `/memory accounts`, `/memory unbind` |
| Choose where the diary is published | `/mirror` |
| Review and activate a skill | `/skills` |
| Configure agent execution | `/subharness` |
| Schedule, switch and inspect the four scheduled mechanics | `/service` |
| Read a watcher report | `/service watcher report` |

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

`neptunia <command> [args]` runs one command of the chat's table through the same parser and handlers as the chat. Each shell word stays one word: only the last positional argument takes loose words, joined with one space, and a value holding quotes, backticks or dollar syntax arrives unchanged. A word the table does not know exits `2` with a usage naming every command, and connects to no core. `doctor`, `logs`, `service` and `clear` run in the command line itself, and `doctor live` equals `doctor --live`.

`neptunia -p "/<command> [args]"` runs the same command as a typed line. `neptunia -p "<text>"` is one turn with the persona: it prints her reply when the turn ends, prints nothing when she stays silent, and ends with its input left open. Text with no leading `/` never runs a command, and blank text exits `2`. A paused core keeps the line for `/resume` and the call exits `1`. The call gives up with exit `1` after 15 minutes without the end of a turn.

| Exit code | Meaning | Output |
|---|---|---|
| `0` | The command ran or the turn ended | The answer on stdout, stderr empty |
| `1` | Any other answer, or no core listening | The reason on stderr, stdout empty |
| `2` | A line the table refuses, an unknown first word, or a request that needs a terminal | The reason on stderr, stdout empty |

`/doctor` through `-p` prints its checks on stdout whatever they found, as `neptunia doctor` does, and exits `1` when a check failed.

The chat with no arguments, `-p /setup`, `-p /clear` and `clear` need a terminal. Without one they exit `2` at once, naming the commands that run without it, and send nothing. `NEPTUNIA_PLAIN_CHAT=1` runs the plain chat over pipes instead of that explanation.

A command that asks a question with no terminal exits `1` with the question on stderr and sends no answer. A secret question also names `--secret-stdin`. That flag is accepted by `keys core add`, `keys extra add`, `keys service set`, `interface token set`, and the `setup` and `set` commands of `/interface` and `/skills`: it answers the first question, when that question is secret, from stdin less one trailing newline. Empty stdin exits `1`, and so does any other question the command asks.

```bash
printf '%s\n' "$TOKEN" | neptunia interface token set discord --secret-stdin
```

On every other command `--secret-stdin` is ordinary text. `keys core add`, `keys extra add`, `keys service set` and `interface token set` exit `2` for a word past their name, in the chat and in both shell forms, so a secret never reaches the process list, the core or the logs.

## Scheduled services

`neptunia service <name> setup|enable|disable|status` controls `heartbeat`, `selfreflection`, `selfimprovement` and `watcher`. `/service <name> <action>` and `neptunia -p "/service ..."` reach the same handler, `src/service/commands.ts`. Selfreflection is the diary wake and selfimprovement is the persona's development wake, which stays apart from the development executor. The handler works with no core, so a mechanic can be switched and read while the core is down. `/wakes stop` and `/wakes start` stay separate: they pause the whole inner life.

`setup --at 00:00,12:00` saves daily UTC times and `setup --every 6h` an interval in hours or minutes (`90m`). The two exclude each other. Both write the one setting `<name>.schedule` that `/config` reads, leave the flag as it is, and answer `timezone: UTC` and `next:` with the next times. `heartbeat setup --jitter 30m` sets `heartbeat.jitterMinutes`, which moves an interval either way and leaves daily times exact. `setup` with no flag asks at a terminal and exits `2` without one. `watcher setup` also renders `neptunia-watcher.timer` and reloads the manager, and starts nothing.

`enable` and `disable` move `<name>.enabled` and run nothing at once. A run already going finishes after `disable`. For the watcher they also run `enable --now` or `disable --now` on the timer and leave `neptunia-watcher.service` alone. A manager call that fails prints `desired:` and `applied:`, exits `1` and keeps the flag, and the same command applies it again.

`status` exits `0` whatever it finds, asks no model and writes nothing.

| Line | What it says |
|---|---|
| `service` | The mechanic |
| `enabled` | The saved flag |
| `running` | Whether a run is going, as the manager says for the watcher. `unknown` for a wake with no core, and for the watcher with no `systemctl` |
| `readiness` | `ready`, or `not ready` and what is missing: the core, a subharness backend or the repository |
| `schedule` | The schedule, with the heartbeat's jitter. `windows` for a diary with no `selfreflection.schedule` |
| `next due` | The next time, `none` when disabled, `unknown` for a diary drawing from windows with no core |
| `last result` | The newest report of the watcher, the core's last wake of the others, `unknown` with no core |
| `current run` | The watcher's run in progress with its state and source, `none` with no run |
| `last success` | The watcher's newest succeeded run and when it ended |
| `last failure` | The watcher's newest failed run, its code and when it ended |
| `filing` | The receipts of the last success by state, such as `filed 2, deferred 1`, `none` with no drafts |
| `source` | The watcher's backend, model and effort from `keys.json`, `default` where the backend picks, `unknown` with no backend. Reading it asks no model |
| `run timeout` | How long the watcher's agent may run |
| `timer` | The watcher's timer as the manager reads it |

`neptunia service watcher report [day or run]` prints the newest report, the report of a date or the report of a run, with no core. A report names its run and the other runs of its day.

`neptunia service watcher trigger` starts one inspection without waiting for it and answers `run:` and `state:`. During a run it answers that run and starts nothing. It refuses a disabled watcher, names `service watcher enable` and exits `1`, and a start the manager refuses fails that run and exits `1`. `neptunia service watcher cancel` asks the run in progress to stop and answers `run:` and `state:`, `none` with nothing to stop, and exits `0` however often it is repeated. It changes no flag and no timer. [The watcher](watcher.md#one-run) describes both.

`/report`, `neptunia watcher`, `neptunia selfimprovement` and `neptunia setup` with `watcher`, `selfimprovement` or `mechanics` exit `2`, name the command of this family and run nothing. A word order such as `service status watcher` exits `2` the same way.

## Other entry points

`neptunia setup` performs installation. `neptunia interface run <name>` starts a platform package, and every other `neptunia interface` form is the table's `/interface` family. `neptunia service start|stop|restart|status [unit]` runs `systemctl` for the named units or the core and the two errand runners, in the scope of the installation, with `sudo` in the system scope except for `status`. These verbs exist in the shell alone. `neptunia task` addresses the [task board](board.md).

`neptunia doctor` inspects local paths and configuration even when the core is unavailable. `/status` needs a core connection. For service logs, use the systemd scope selected during [setup](setup.md#services).

Read the implementation in [command table](../src/interface/commands/table.ts), [CLI entry point](../bin/neptunia.ts), [request parsing](../bin/neptunia-request.ts) and [interactive renderer](../cli/app.ts).
