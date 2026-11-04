# CLI

Run `neptunia` to open the owner's chat. Plain text becomes a conversation with the persona. A slash command changes or inspects the installation without becoming a conversational memory.

```bash
neptunia
neptunia -p "/status"
neptunia doctor
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

The header shows connection, core and memory state. A missing or old health report is shown as unknown or stale, rather than as a successful connection. `/status` opens the detailed view. `NEPTUNIA_REDUCED_MOTION=1` stops the galaxy animation.

## Settings and setup panels

`/config` opens settings grouped into tabs. Use Left and Right or Tab to change tabs, Up and Down to select a row, and Enter to toggle a boolean or edit a value. Typing filters settings across all tabs. In an editor, Enter saves through the normal command handler, Ctrl+U clears the input and Esc cancels.

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

A secret question hides its answer and excludes it from input history. Use these dialogs instead of putting a key in a shell command. History lives in `data/cli/`.

## Other entry points

`neptunia setup` performs installation. `neptunia interface run <name>` starts a platform package. `neptunia task` addresses the [task board](board.md). The watcher and self-development executor have their own run commands, described in their guides.

`neptunia doctor` inspects local paths and configuration even when the core is unavailable. `/status` needs a core connection. For service logs, use the systemd scope selected during [setup](setup.md#services).

Read the implementation in [command table](../src/interface/commands/table.ts), [CLI entry point](../bin/neptunia.ts) and [interactive renderer](../cli/app.ts).
