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
| Up and Down | Select a command suggestion, move a row inside a multiline draft, or browse the input history |
| Left, Right, Home and End | Move the caret, by whole characters and across a chip in one step |
| Backspace and Delete | Delete a whole character or a whole chip |
| Tab | Complete the selected command |
| Esc | Close a panel, cancel a panel still loading, cancel a question, leave a search or clear the input. On an empty input it asks the core to cancel her running turn |
| Ctrl+R | Search the history, and again for the next older match |
| Ctrl+F | Search the transcript, and again for the next older match |
| Alt+Up and Alt+Down | Jump to your line above or below |
| Ctrl+Z and Ctrl+Y | Undo and redo in the draft |
| Ctrl+S | Stash the draft, or bring back the stashed draft on an empty input |
| Ctrl+G | Edit the draft in `$VISUAL` or `$EDITOR` |
| Ctrl+O | Expand or fold the newest folded answer on the screen, or show the text behind the chip before the caret |
| Page Up and Page Down | Scroll the transcript |
| Ctrl+V | Attach an image from the clipboard of this machine |
| Ctrl+C, or Ctrl+D on an empty input | Exit the CLI |

The Project Neptunia header shows separate lines for the core, memory and enabled interfaces. Missing reports show a check in progress, and old reports are marked outdated. A lost core connection leaves memory and interface states unknown. The input stays at the bottom as the terminal resizes. `/status` opens the detailed view. `NEPTUNIA_REDUCED_MOTION=1` stops the galaxy animation, and `NEPTUNIA_LINEAR=1` draws the plain column described under [Rendering](#rendering).

## Pastes and history

`cli/composer.ts` keeps the draft as ordered parts with their own ids: text, pastes and attachments. A bracketed paste reaches the owner of the keys through Ink's `usePaste`, and nothing is sent until an explicit Enter. A paste of more lines than `cli.paste.collapseLines` (default `10`) or more characters than `cli.paste.collapseChars` (default `2000`) draws as one chip such as `[pasted 40 lines]`. A paste at either limit stays text in the input. The turn gets the exact text of every paste in its place, with newlines, tabs and trailing spaces. Backspace after a chip removes that paste alone, and Ctrl+O shows its text. A draft whose paste text is gone stays in the input with a message and is not sent until Backspace removes the chip.

`bin/cli-history.ts` keeps `data/cli/history` as one record per draft, so Up recalls a multiline draft whole, its text collapsed by the same limits. Up sets the unfinished draft aside, and Down past the newest row brings it back. A file in the older format, one draft per line, is read as it is and rewritten as records on the next send. Each write goes through a temporary file and a rename, and the file is private to the owner.

## Images

Ctrl+V reads the clipboard of the machine the chat runs on, with `wl-paste`, `xclip` or `pngpaste` as literal arguments (`cli/clipboard.ts`). Over SSH that machine is the server, so the chat says the clipboard is out of reach, starts no process and keeps the draft. `/attach <file>` takes a file on this machine in every session, and its path never reaches the core as text. `neptunia -p "<text>" --attach <file>` does the same for one turn, and a refused file exits `1` with nothing sent. The flag repeats for several images.

An image is staged before it joins the draft, as a chip such as `[image chart.png]`. `src/media/staging.ts` copies its bytes to `data/staging/images/`, private to the user, and takes the content type from the bytes. Only PNG, JPEG, GIF and WebP up to the vision reader's limit of 1,500,000 bytes pass. Enter sends the caption and its images as one message with a `neptunia-staged:` reference, which the core's image fetcher opens like any address, so the file may be deleted afterwards. The core and the chat must run as the same user. Backspace on the chip frees the image at once. Any other staged image goes one week after it was staged, so a line waiting for `/resume` keeps its image. A draft recalled after that week still sends, and the describer logs a failed download for its image.

An image the persona sends is kept the same way, up to 10 MiB, and the transcript shows its name and text alternative. `/attach open` opens the newest one with `xdg-open` or `open`, and `/attach save <file>` writes it to a file. A failure says why, and the same command tries again. The plain chat and `-p` print `[image <name>]` and the path of the kept file.

## Rendering

`cli/app.ts` gives the transcript what the other parts leave: the transcript budget is `max(0, R - F - C - O)` (`transcriptBudget` in `cli/layout.ts`), with `R` the terminal's rows, `F` the header, footer, notice and question rows, `C` the input with its borders, and `O` the slash menu or a panel. Everything is counted in cells by `cli/layout.ts`: Backspace and the caret cross a whole grapheme, wrapping never splits a wide glyph, and the caret stands on the next row when its row is full. The input grows to at most 8 rows, then scrolls inside its box with the caret's row in view and a row counting what is hidden. Deleting rows gives them back to the transcript.

`cli/transcript.ts` wraps each entry to the width and draws only the rows that fit, however long the session. Following the tail and reading further up are separate views. Page Up anchors the view to an entry and a row inside it, so a new answer or a resize leaves the reader in place, and reaching the end follows the tail again. An answer folds to at most 20 lines, fewer when the terminal has less room, so it starts on the screen. Ctrl+O changes one entry, and an expanded last entry may go past the budget. The full text stays in the entry.

A stored control character is drawn as one visible character (`displaySafe`), so a line from memory can neither run an escape sequence nor vanish unseen. The owner's line starts with `> `, a command's answer with `· ` and her reply with no mark, so the kinds differ without colour. The selected row of the slash menu carries `›` beside its inverse video. Fenced code, quotes and headings get a style by their line, and their text stays as it arrived.

`cli/theme.ts` holds the semantic tokens: `text`, `muted`, `title`, `mark`, `userMarker`, `activeBorder`, `inactiveBorder`, `selection`, `caret`, `code`, `quote`, `heading`, `success`, `warning` and `error`. A token asks for an ANSI style. The font family, its faces and the cell size belong to the terminal emulator.

`NEPTUNIA_LINEAR=1` draws one plain column in reading order for a screen reader, with no borders and no galaxy. It sets `ChatEnv.linear`.

### Measured geometry

These rows were read from frames the chat wrote into the fake terminal of `tests/fixtures/chat-rig.ts`, with one owner line, one reply and one command result. They count cells and rows, say nothing about pixels, and were taken without an emulator, a font or a theme. No comparison with another program's layout was made.

| Element | 80 by 24 | 40 by 18 | 20 by 6 | Linear, 80 by 24 |
|---|---|---|---|---|
| Header | 5 rows and 1 blank | 5 rows and 1 blank | None | 1 row |
| Transcript budget | 14 rows | 8 rows | 2 rows | 21 rows |
| Input with one row of text | 3 rows, on rows 20 to 22 | 3 rows, on rows 14 to 16 | 3 rows, on rows 2 to 4 | 1 row |
| Text column of the input | 4 | 4 | 4 | 2 |
| Footer | 1 row, cut with `…` | 1 row, cut with `…` | 1 row, cut with `…` | 1 row |
| Blank rows above an owner line | 1 | 1 | 1 | 1 |
| Blank rows between a reply and a command result | 0 | 0 | 0 | 0 |

The galaxy needs at least 16 rows and 40 columns. Below that the header is one line, and under 8 rows it goes.

## Editing and keys

`buildKeymap` in `cli/keymap.ts` is the one registry of these keys, read by dispatch and by the footer. A key resolves against the focus context first: `composer`, `attachment` (the caret right after a chip), `menu`, `secret` (any open question), `search` or `panel`. The `secret` context binds no history, stash, undo, editor or clipboard action, so what is typed there reaches no store. The setting `cli.bindings` (default `[]`) overrides a key with entries such as `{ "context": "composer", "key": "ctrl+t", "action": "history.search" }`. An override that collides with a bound key, names an unknown action or names one its context does not allow is not bound, and the chat says so when it opens.

`cli/editor-actions.ts` works on the draft of `cli/composer.ts` and the transcript's entries. A search shows its match in the input and sends and stores nothing. Enter on a history match loads it into the draft, and the next Enter sends it. Esc restores the draft and the view exactly. The letters of one word undo together, up to 100 steps, and a send starts over. Undo cannot bring back an image whose chip was removed, because its staged bytes went with it. Stashed drafts keep their parts and last until the chat ends.

Ctrl+G hands the terminal to the editor with the draft in a private temporary file under `$TMPDIR`, removed afterwards. The command is `$VISUAL` or `$EDITOR` split on spaces, with no shell. Images stay in the draft. A failing editor leaves the draft as it was and says so, and an emptied file cancels.

Raw mode clears `IXON` and `ISIG` (checked with `stty -a` under a pseudo-terminal), so Ctrl+S and Ctrl+Z reach the chat instead of the terminal's flow control and job control.

`cli.mouse` (default `false`) takes the terminal's SGR mouse reports for the wheel, which scrolls the transcript or the slash menu, and for a click in the input, which places the caret on a whole character. Tracking takes native text selection away, so it stays off until asked for, and `mouseAvailable` refuses it for `TERM=dumb` and the linear mode. With it off, Ink drops a stray report before it can reach the draft. Every mouse action has its key.

## Overlays and questions

One screen element holds the keys and a paste at a time. A question from the core goes first, then an open panel, then the input. `focusOwner` in `cli/app.ts` decides, and a panel that loses the keys stays on the screen.

A question replaces the input and keeps the unfinished line it interrupted. The line comes back after the answer or Esc, and an answer never joins it. Enter does nothing for 700 ms after the question closes, counted again from each Enter it swallows, so a held key cannot send a draft its owner has not seen. A secret answer is drawn as stars and stays out of the input history. A question with choices opens the selector in `cli/selector.ts`. Typing or pasting narrows the list, Enter answers with the choice exactly as the core sent it, and a filter that matches nothing answers nothing. The plain chat prints the choices beside the prompt.

Each slash command replaces the panel request before it. An answer of a request that was replaced or cancelled with Esc opens nothing and runs nothing. The same rule holds inside a selector, whose reducer compares the overlay id and the generation of every answer. Moving and filtering change no setting.

## Turns, the queue and cancelling

`createTurnControl` in `src/turn/control.ts` owns the state of every line the chat or `neptunia -p` sends: accepted, queued, running, and committed, cancelled or failed. Each event names its turn and carries a rising `seq`. The core sends them to a client that asked with `turn.replay`, as a `command.result` of status `turn` (`src/protocol/turn-control.ts`), and `cli/turn-state.ts` builds the chat's picture from them and from nothing else. Her replies still arrive as messages, so the events carry the turn's state and the reply its words.

A line goes through the event door when it arrives, like a message of any other interface (`src/interface/chat-turns.ts`). Memory observes it at once, and the pipeline's own queue decides when its turn runs, under `mention.pendingSameChannel`, `mention.oneAtATime` and the pipeline's own bound. The control adds no helper model and holds no line back: it tracks the order and states the client shows, one turn running at a time. The row above the input shows the running turn, its newest tool step and how many lines wait. The same request id sent twice is one line. A failed turn leaves a line in the transcript, and the next line goes on.

A line that waits is already said, so its text cannot be edited, and `/queue` offers no edit. Enter on a row of `/queue` cancels the turn over that line, and the line stays in memory, where she can read it. A cancel of a waiting line acknowledges at once, and when the pipeline reaches it the runner ends its turn before any request.

Esc on an empty input asks the core to cancel the running turn, once. The chat keeps showing the turn as running until the core acknowledges, and Esc with text in the input clears only the input. Leaving the chat cancels nothing, and an errand, a task or the watcher is never reached by a chat cancel. The signal of a running turn stops the wait in progress, aborts the provider request and takes effect between tool steps. A turn with a message already out ends committed, whatever the cancel asked. Lines of other interfaces do not pass through the control, so a turn over one has no signal.

The pipeline can answer a line inside another line's turn or drop one it saw answered, so a line can have no turn of its own. When a later line's turn begins, or after 30 seconds with no turn running anywhere, the line's wait ends with `no-own-turn`, and `neptunia -p` hears the same. A line taken during a pause ends with `paused`, while the core still holds it for `/resume`.

These states live in the core's process and do not survive a restart. A lost link leaves the state as the core last said it. The chat tries again every 2 seconds, and `turn.replay` returns what it missed, or names another core instance, in which case the chat drops the turns it held and says how many it lost. The core's routes return completed output, so `running` carries `streaming: false` and the transcript shows no text until her reply. The reducer takes `text` events, and no route produces them.

## Sessions and checkpoints

A conversation session is a named view over the lines memory already stores for the owner's chat, in the `sources` table under the place `cli:dm:owner`. Those records are the durable conversation, so `src/conversation/sessions.ts` copies none of them and keeps only ids and times, in `<private>/cli/sessions.json` (`src/conversation/store.ts`). The file is not memory: nothing she recalls reads it. A session's name is the start of the owner's first line, with no model. The input history in `data/cli/history` and the transcript on the screen are separate from both.

`/sessions` lists them, and Enter on a row resumes one. `/resume <id>` does the same by id. Bare `/resume` stays the command that ends a pause. `/branch` lists the lines of the current session with their exact stored text, and Enter on a line continues from there. `/branch <id>` cuts another session. Opening any of these panels only reads, and the same boundary of the same session is always the same branch.

Resuming or branching replaces the transcript on the screen and the lines the core's history reads answer from, so the next turn's context is the selected view. A line written while a branch is selected belongs to that branch, and the root shows every line no branch owns. Stored lines, facts she learned and their sources stay untouched, and memory stays continuous: a branch does not make her forget what she saw after its boundary, because her memory reads across every session. A new chat process starts on the root. These commands exist only in the interactive chat, because their effect is on its screen.

`/checkpoints` previews and restores the files of a development task's worktree (`src/development/checkpoints.ts`). The board decides what counts: an open task whose `metadata.development.worktree` lies under `selfimprovement.checkout`'s `.worktrees` folder (`src/development/checkpoint-desk.ts`). With no such task the panel says why and offers no row. `/checkpoints take <task>` copies the worktree to `<private>/development/checkpoints/<task>/`. A row shows the affected paths, and Enter on it restores them. Every restore first takes a checkpoint of what it replaces, reported as its undo. A symlink leading out of the worktree refuses the restore, and a partial failure reports `failed` with the undo. `.git`, `.env`, `.secrets`, `data`, `config.local`, `prompts.local`, `node_modules`, `.agents`, `.claude` and `.worktrees` are neither captured nor restored. Nothing takes a checkpoint by itself. Rewinding a conversation is `/branch`, and it changes no file.

## Approvals and capability menus

`/approvals` opens what waits on the task board: a triaged task is a plan gate, and a task in `needs_validation` a merge gate that shows the worker's handoff (`src/board/approval-view.ts`). Several gates list as rows, and `/approvals <task>` opens one. Approve and reject are two rows, and a reject takes the reason the board asks for. An answer is the board's `task.approve` under the `owner` client's name, naming the revision on the screen, so the board's rights and revision check decide and a stale answer changes nothing. `createApprovalRelay` in `src/tools/approvals.ts` forwards one answer per shown revision, so a double Enter is one approval, and a refused answer leaves the gate open. Esc answers nothing. The panel starts no executor and adds no merge policy, which remain `selfimprovement.mode` and the development worker's (`docs/development-agents.md`).

Tool calls have no such panel, because nothing asks. An agent's mode (`read`, `write`, `full` or `sudo`, `/agent mode`) is set in advance and becomes the sandbox of its run (`src/subharness/control.ts`), and a headless backend cannot stop to ask. Her own tools are decided by grants before the turn (`/tools grant`). So no command panel, scope or expiry exists to show, and no proposed command or file diff reaches a gate: a merge gate shows the artifacts the worker named, and the diff lives in its pull request.

`/tools`, `/skills`, `/interfaces` and `/agents` open a menu: the family's list operation as text, where it has one, and a row per subcommand of the command table that prefills the typed command. Opening a menu runs only that read, and every change goes through its typed command. `/plugins` says that no operation installs a plugin. `/context` shows the request limit (`llm.maxRequestTokens`), the core's route and its model through `cli/context-line.ts`. The size of the last request is held by no read, so it shows as unknown. The chat offers no context compression, because the core has no such operation.

## Settings and setup panels

`/config` opens settings with readable names and descriptions, grouped into tabs. Search accepts both these names and the underlying configuration keys. Use Left and Right or Tab to change tabs, Up and Down to select a row, and Enter to toggle a boolean or edit a value. Typing filters settings across all tabs. In an editor, Enter saves through the normal command handler, Ctrl+U clears the input and Esc cancels.

`/setup` offers core and extra keys, service credentials, interface setup, skill setup and search configuration. Opening it performs no installation or provider check. Selecting an action uses its existing command and any required secret dialog. Model and backend actions prepare the targeted command in the input for you to complete.

`/model` opens the nested model selector described in [Keys and models](keys.md#the-model-selector). `/model show` and `/model set` stay commands.

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
| Cancel the turn over a waiting line, in the chat only | `/queue` |
| Resume or branch a conversation, in the chat only | `/sessions`, `/resume <id>`, `/branch` |
| Restore a development task's files, in the chat only | `/checkpoints` |
| Answer what waits on the task board, in the chat only | `/approvals` |
| See the request limit, route and model, in the chat only | `/context` |

## Backend usage

`/usage` prints the engine's own accounting, then what each backend's account says of itself under `backend accounts:`. `readAllUsage` in `src/subharness/usage.ts` reads the four sources, and no read starts a model run. One source that fails leaves the others readable, and it prints its code after `not read:`.

| Source | Read | What it shows |
|---|---|---|
| `codex` | `codex app-server` with `account/read`, `account/rateLimits/read` and `account/usage/read` under the persona's home | The email and plan, used percentage, reset time, window, lifetime and daily tokens |
| `claude` | `claude auth status` | Whether the account can be read by hand. Its `/usage` is an interactive screen, so the block is `unsupported` and names the command to open it |
| `opencode` | `opencode stats` under the persona's home | Sessions, messages, days, dollars and tokens, under the name of its extra key |
| `openrouter` | `GET /key` on the core role's key | Spend, limit and what remains, under the key's name |

Each block names its source, its account and its observation time. A value the source did not report prints `unknown`, never zero. Subscription tokens carry no price. A failed read of the same known account keeps the last numbers until the core restarts, each marked `(stale)` under its own observation time, and a logout or another account drops them. The blocks are never added together, because the `openrouter` spend of a key already holds what `opencode` spent on that key.

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

`neptunia setup` performs installation, as one flow with no step of its own to name. `neptunia worker development` is what `neptunia-development.service` starts, and `neptunia worker development held` lists the tasks older than its boundary, as in [self-development](selfimprovement.md#enabling-the-worker). `neptunia interface run <name>` starts a platform package and stays singular, because a unit starts it. `neptunia services start|stop|restart|status [unit]` runs `systemctl` for the named units or the core and the two errand runners, in the scope of the installation, with `sudo` in the system scope except for `status`. These verbs exist in the shell alone and never name a mechanic. `neptunia tasks` addresses the [task board](board.md) as the client `NEPTUNIA_TASK_CLIENT` names, by default `owner`, which `neptunia setup` makes with the board role `owner`. With no token for that client it exits `1` with `unavailable:`, the client's name and the repair.

`/status` needs a core connection. For service logs, use the systemd scope selected during [setup](setup.md#services).

Read the implementation in [command table](../src/interface/commands/table.ts), [CLI entry point](../bin/neptunia.ts), [request parsing](../bin/neptunia-request.ts) and [interactive renderer](../cli/app.ts).
