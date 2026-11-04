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
| Review and activate a skill | `/skills` |
| Configure agent execution | `/subharness` |
| Read a watcher report | `/report` |

A secret question hides its answer and excludes it from input history. History lives in `data/cli/`.

## One command from a shell

`neptunia <command> [args]` runs one command of the chat's table through the same parser and handlers as the chat. Each shell word stays one word: only the last positional argument takes loose words, joined with one space, and a value holding quotes, backticks or dollar syntax arrives unchanged. A word the table does not know exits `2` with a usage naming every command, and connects to no core. `doctor`, `logs`, `report` and `clear` run in the command line itself, and `doctor live` equals `doctor --live`.

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

## Other entry points

`neptunia setup` performs installation. `neptunia interface run <name>` starts a platform package, and every other `neptunia interface` form is the table's `/interface` family. `neptunia service start|stop|restart|status [unit]` runs `systemctl`. `neptunia task` addresses the [task board](board.md). The watcher and self-development executor have their own run commands, described in their guides.

`neptunia doctor` inspects local paths and configuration even when the core is unavailable. `/status` needs a core connection. For service logs, use the systemd scope selected during [setup](setup.md#services).

Read the implementation in [command table](../src/interface/commands/table.ts), [CLI entry point](../bin/neptunia.ts), [request parsing](../bin/neptunia-request.ts) and [interactive renderer](../cli/app.ts).
