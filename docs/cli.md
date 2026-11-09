# CLI

Run `neptunia` at a terminal to open the owner's chat. Plain text becomes a chat with the persona. A slash command changes or inspects the installation without becoming a conversational memory.

```bash
neptunia
neptunia status
neptunia rules add "a rule with \"quotes\" and spaces"
neptunia -p "/status"
neptunia -p "what are you doing tonight?"
neptunia doctor live
```

## Access

The CLI authenticates through `data/clients.json` and `data/clients/cli.token`. This trusted owner connection can inspect stored memory across interfaces and private chats. Talking to the owner in a Discord group does not give that chat the CLI's memory access.

The owner's chat stays open while `dm.enabled` is false, because it is his console. `dmChatsOff` in `src/behavior/core-pause.ts` holds the rule, and every place that asks whether direct chats are open reads it: the private gate, the missed-answer recovery, a wake anchored on `cli:dm:owner` (`chatFor` in `src/behavior/inner/drain.ts`), and a post or an intention there (`postingRef` and `writablePlace` in `src/tools/operations/shared.ts`). A direct chat of any other interface closes.

The command line's account goes by `owner`, and the owner reaches her under the name of the person that account is linked to. `ownerConsoleName` in `src/memory/db/identity-links.ts` reads it: the first name of another verified account of his person, else the person's real name. `createCommandIntake` in `src/interface/neptunia-cli.ts` puts that name on each of his lines before the door, so memory keeps it as his name and `<people>` shows it. `withStoredHistory` in `src/chat/stored-history.ts` puts it on his lines in `<chat>` and on the chat's description. With no linked person or no stored name, his lines keep `owner`.

## Chat controls

| Key | Action |
|---|---|
| Enter | Send |
| Alt+Enter or Ctrl+J | Insert a newline |
| Up and Down | Select a command suggestion, move a row inside a multiline draft, or browse the input history |
| Left, Right, Home and End | Move the caret, by whole characters and across a chip in one step |
| Backspace and Delete | Delete a whole character or a whole chip |
| Tab | Complete the selected command |
| Esc | Cancel a question, leave a search, or close the command window with its panel, cancelling a panel still loading. With the window closed it removes a reply marker, else it clears the input, and on an empty input it asks the core to cancel her running turn |
| Ctrl+R | Search the history, and again for the next older match |
| Ctrl+F | Search the transcript, and again for the next older match |
| Alt+Up and Alt+Down | Jump to your line above or below |
| Ctrl+Z and Ctrl+Y | Undo and redo in the draft |
| Ctrl+S | Stash the draft, or bring back the stashed draft on an empty input |
| Ctrl+G | Edit the draft in `$VISUAL` or `$EDITOR` |
| Ctrl+O | Expand or fold the newest folded answer on the screen |
| Page Up and Page Down | Scroll the transcript |
| The mouse wheel | Scroll the chat or the command window, whichever is under the pointer |
| Ctrl+V | Attach an image from the clipboard of this machine |
| Ctrl+C | Copy the mouse selection when there is one, otherwise exit the CLI |
| Ctrl+D on an empty input | Exit the CLI |

The chat has no row of key hints. `/help` lists the commands. The Project Neptunia header has one line for each of the core, memory and the analyzer, in the form `Core: active · anthropic/claude-opus-4.6 · via claude-harness`, and a line that names the interfaces that work, with no state word, such as `Interfaces: CLI, Discord`. The command line is always on it, so a fresh install reads `Interfaces: CLI`, and an interface that is disabled or disconnected is left out. The model is the one the route runs: a role on a harness names the harness's model, and a role on the API names its configured model with the route `direct-api`. The analyzer runs on the API alone. `statusBrief` in `src/interface/commands/status-brief.ts` reads these facts from the pause, `memoryDb.session.mode`, the last memory probe, the key ring and the `subharness` records of `keys.json`, with no request. A line says `error` while what its role runs on failed its last real run or its latest probe ([probes](keys.md#probes-of-the-parts-she-needs)), and `active` again after the next run answers or the next probe passes. On a harness that failure is a lost login: a step of her core that ends `subscription-login`, or a memory writer run that Claude refuses for want of a login (`not-logged-in`), kept per role and backend by `src/subharness/login-state.ts`. On the API it is the role held down by `src/llm/role-health.ts`. Each line is cut to the width.

The role lines use the same four state words (`statusLine` in `interfaces/cli/state.ts`):

| Word | Core | Memory | Analyzer |
|---|---|---|---|
| `active` | running, with a key or a harness | session in `apply` or `shadow`, probe passed or not yet run | a model and a key |
| `paused` | paused, with the reason beside it | | |
| `disabled` | | `memoryDb.session.mode` is `off` | no model |
| `error` | no key on `direct-api` | no key on `direct-api`, or the probe failed | no key |

A lost core connection marks every line `error (connection lost)`, the lines read `…` until the first report, and a report older than a minute is marked outdated. The input stays at the bottom as the terminal resizes. `/status` opens the detailed view. `NEPTUNIA_REDUCED_MOTION=1` stops the galaxy animation, and `NEPTUNIA_LINEAR=1` draws the plain column described under [Rendering](#rendering).

## Pastes and history

`interfaces/cli/composer.ts` keeps the draft as ordered parts with their own ids: text, pastes and attachments. A bracketed paste reaches the owner of the keys through Ink's `usePaste`, and nothing is sent until an explicit Enter. A paste of more lines than `cli.paste.collapseLines` (default `10`) or more characters than `cli.paste.collapseChars` (default `2000`) draws as one chip such as `[pasted 40 lines]`. A paste at either limit stays text in the input. The turn gets the exact text of every paste in its place, with newlines, tabs and trailing spaces. Backspace after a chip removes that paste alone, and undo brings it back. A draft whose paste text is gone stays in the input with a message and is not sent until Backspace removes the chip.

`bin/cli-history.ts` keeps `data/cli/history` as one record per draft, so Up recalls a multiline draft whole, its text collapsed by the same limits. Up sets the unfinished draft aside, and Down past the newest row brings it back. A file in the older format, one draft per line, is read as it is and rewritten as records on the next send. Each write goes through a temporary file and a rename, and the file is private to the owner.

## Images and files

Ctrl+V reads the clipboard of the machine the chat runs on, with `wl-paste`, `xclip` or `pngpaste` as literal arguments (`interfaces/cli/clipboard.ts`). Over SSH that machine is the server, so the chat says the clipboard is out of reach, starts no process and keeps the draft. `/attach <file>` takes a file on this machine in every session, and its path never reaches the core as text. `neptunia -p "<text>" --attach <file>` does the same for one turn, and a refused file exits `1` with nothing sent. The flag repeats for several files.

A file is staged before it joins the draft, as a chip such as `[image chart.png]`. `stageAttachment` in `src/media/staging.ts` copies its bytes to `data/staging/images/`, private to the user. A PNG, JPEG, GIF or WebP takes its content type from the bytes and passes up to the vision reader's limit of 1,500,000 bytes. Any other file, such as a voice note, a video or a document, takes its type from its name and passes up to `FILE_MAX_BYTES`, 10 MiB. A clipboard read stages pictures only. Enter sends the caption and its images as one message with a `neptunia-staged:` reference, which the core's image fetcher opens like any address, so the file may be deleted afterwards. The core and the chat must run as the same user. Backspace on the chip frees the image at once. Any other staged image goes one week after it was staged, so a line waiting for `/resume` keeps its image. A draft recalled after that week still sends, and the describer logs a failed download for its image.

An image the persona sends is kept the same way, up to 10 MiB, and the transcript shows its name and text alternative under the marker `[image]`. Any other file of a line shows as a marker of its kind after the line's text, such as `[video]`, `[audio]`, `[voice]` or `[file]`. The marker is the kind memory stores for the item in the `media` table, and `session.page` sends the kinds with each stored line. The stored line's text holds no marker, and the `<chat>` of her request renders the items with labels of its own, such as `[voice message, 0:04]`. The plain chat and `-p` print one line `[file <name>] <path>` for every file she sends that the terminal cannot show.

`/attach open #N` shows the file of line `#N` in the command window, through the terminal itself and with no process started, so it works the same at the machine and over SSH. A line with several files lists them numbered from 1, and `/attach open #N 2` shows the second. `/attach open` with no number shows the newest image she sent. The chat asks the core's `session.line` for the files of that line (`src/interface/commands/chat-state.ts`), so the number reaches any stored line, also one the screen does not show. An unknown number answers `No line #N in this chat.`, and a file the core did not keep says so.

A picture is drawn in the window with the graphics protocol the terminal speaks, scaled to the window with its proportions kept, and its stored description stands above it (`interfaces/cli/file-view.ts`). The first picture of a session asks the terminal three things: kitty's graphics query, its cell size in pixels and DA1 (`interfaces/cli/terminal-replies.ts`). A kitty `OK` means the kitty protocol, which kitty, Ghostty and WezTerm speak. `TERM_PROGRAM` or `LC_TERMINAL` naming iTerm2 means its inline image protocol. A `4` in the DA1 reply means Sixel, which Windows Terminal 1.22 and later, WezTerm, foot and mlterm speak. The answer holds for the rest of the session, and a terminal that gives no DA1 reply within a second draws no picture. The replies come on stdin and are taken out before the input reads it. `decodeImage` in `interfaces/cli/terminal-graphics.ts` decodes a PNG, JPEG, BMP or the first frame of a GIF with Jimp's format packages and a WebP with the WebP decoder of jSquash, loaded with the first picture so the chat starts without them. These libraries are dependencies of the `@neptunia/cli` package alone. kitty and iTerm2 get the pixels encoded as PNG, and Sixel gets them mapped to a 6x6x6 colour cube. A file none of the decoders reads, such as a damaged picture, is a format the window cannot show, and so is a PNG or GIF whose header declares more than 40 million pixels. Ink writes the whole frame again on each change, so the chat draws the picture again after every frame, and the galaxy in the header holds still while a picture shows. Only the newest picture of the window is drawn, and only while all its rows are in view.

A text file, such as text, code, JSON, Markdown or CSV, shows its content in the window, which scrolls and copies with the mouse like any answer. The window reads at most 256 KiB of it and shows at most 2000 lines, with a note that says how many lines are left out. Anything else, and a picture the terminal cannot draw, shows its name, kind and size, then says that this file format cannot be shown here and that it can be opened or downloaded from the path of the stored file, which follows.

`/attach save #N [k] [dir]` copies the file into `dir`, the current folder by default, under its own name, and never over a file already there. `/attach save <file>` writes the newest image she sent to a file. Both write on the machine the chat runs on, which over SSH is the server. A failure says why, and the same command tries again.

## Kept files

Every file of the chat stays with its line in the persona's data folder, as a platform keeps an attachment. `keepLineFiles` in `src/chat/kept-media.ts` wraps the door a line of `cli:dm:owner` passes: each staged file is copied to `data/media/cli/<staged id>.<ext>` (`keepFile` in `src/media/kept-files.ts`), and the line names the copy by a `neptunia-media:` reference. Observation stores the line's items in the `media` table, each linked to its line through `media_links`, and an item whose address is such a reference stores the copy in `path` (`mediaItemsOf` in `src/memory/db/media-store.ts`). `withKeptSends` wraps the chat's adapter for her sends: each file is copied under a new id before the chat process gets it, the chat process gets the reference beside the bytes, and once the send is delivered her line comes back through the door as an echo carrying the files, as a platform echoes a message she posted. A send the chat process refuses keeps no file.

`createKeptFetch` answers a `neptunia-media:` reference, and a staged reference whose file was kept, from the copy with a type taken from its name, for the core's image, video and audio readers and the text previews of a turn. The describer describes these items as it does any interface's: a picture gets its caption, a voice note its transcript, a video its summary, a text file its opening words, and the description is stored once on the item's row.

## Replies

A message that starts with a marker `[#N]` replies to line N of the chat, the number the transcript draws before each line. `[#34] text` and `[#00034] text` name the same line, because the leading zeros are ignored, and a marker anywhere but the start is the message's own text. A click on the grey `[#N]` of a line of the owner or of hers puts the marker `[#N] ` at the start of the draft, in place of the one it had. `markReply` in `interfaces/cli/composer.ts` turns a typed or pasted marker into one chip once the blank after it is typed, as a collapsed paste is one chip: Backspace right after it removes the whole marker and the reply with it. Esc removes the marker and leaves the rest of the draft. While the draft starts with one, the status row reads `replying to #N`.

Enter asks the core's `session.line` for line N, which answers its message id beside its files (`src/interface/commands/chat-state.ts`), so the number reaches any stored line, also one the screen does not show. A number no stored line holds sends nothing: the status row says `No line #N in this chat.` and the draft stays. A found line sends the text without the marker, with that message id as the line's reply parent (`say` in `interfaces/cli/link.ts`). The stored line, her `<chat>` and memory hold the text alone, memory keeps the parent as the line's `reply_to`, and the transcript draws `↳ #N` after the line's number. The input history keeps the marker, so Up brings the reply back whole.

## Links

The chat sends the owner's line as he typed it, and the core reads its URLs before the line reaches the door (`src/interface/cli-line-links.ts`, called by `createCommandIntake` in `src/interface/neptunia-cli.ts`). The served interface's `links.parse` read decides which URL names a message: such a URL becomes a message reference, which the transcript shows as that line's `#n` when the message is in the window, and which the message tools resolve as they do a link pasted in Discord. Every other URL becomes a link item, up to 10 per line, in the shape the Discord interface gives a URL typed in a message. A URL on one of `media.video.sites` is watched like a video posted in Discord, and the first other URL of the line is read ahead of time by the web lookup (`src/pipeline/media-prefill.ts`). With no interface connected, or one that reads no message link, a message link stays a link item. The lines' links are read one after another, so a line never overtakes an earlier one, and a failed read lets the line go on as it was typed.

## Rendering

`runInteractive` in `interfaces/cli/index.ts` draws the chat on the terminal's alternate screen, with Ink's `alternateScreen` option, so no frame reaches the terminal's scrollback and the shell's screen comes back as it was. The root box is exactly the terminal's height with its overflow hidden, so a frame never scrolls the screen. Ctrl+C, Ctrl+D, a SIGINT and a SIGTERM unmount the app, which leaves the alternate screen and turns mouse tracking off. A crash ends the process before the app unmounts, and a handler on the process's `exit` event writes the same sequences then. The linear mode stays inline, so a screen reader finds the column in the terminal's history.

The galaxy is drawn in a box of 13 by 5 cells that never shrinks, and a status line wider than the terminal is cut beside it. Every frame of the animation has the same size, so the title stays in its column. The title and the galaxy are drawn in the owner's red (`THEME.title` and `THEME.mark`), and the role lines beside them keep the terminal's own colour.

`interfaces/cli/chat-controller.ts` gives the transcript what the other parts leave: the transcript budget is `max(0, R - F - C - O)` (`transcriptBudget` in `interfaces/cli/layout.ts`), with `R` the terminal's rows, `F` the header, the question rows and the status row, `C` the input with its borders, and `O` the slash menu with its blank row and rule, and the open command window. Everything is counted in cells by `interfaces/cli/layout.ts`: Backspace and the caret cross a whole grapheme, wrapping never splits a wide glyph, and the caret stands on the next row when its row is full. The input grows to at most 8 rows, then scrolls inside its box with the caret's row in view and a row counting what is hidden. Deleting rows gives them back to the transcript.

The status row is the one row under the input box, and it is drawn on every frame, blank when it has nothing to say, so no notice moves the input or the transcript (`statusRow` in `interfaces/cli/chat-controller.ts`, drawn by `interfaces/cli/app.ts`). It holds every short notice of the moment on one row, cut to the width and joined by ` · `: the notice of the last key, such as `copied 10 chars to clipboard`, a refused reply or an image that was not attached, in the warning style, then `replying to #N` while the draft starts with a reply marker, her running turn and the queue, and `↓ N rows below · Page Down` while the transcript is read further up. A notice goes with the next key.

The slash menu opens under one blank row and a white rule the width of the terminal (`Menu` in `interfaces/cli/chat-view.ts`, `THEME.rule`), so its first command never touches the last line of the chat or of the command window above it.

`interfaces/cli/transcript.ts` wraps each entry to the width and draws only the rows that fit, however long the session. Following the tail and reading further up are separate views. Page Up anchors the view to an entry and a row inside it, so a new answer or a resize leaves the reader in place, and reaching the end follows the tail again. An answer folds to at most 20 lines, fewer when the terminal has less room, so it starts on the screen. Ctrl+O changes one entry. An expanded last entry taller than the budget shows its newest rows, and Page Up reaches the rest. The full text stays in the entry.

A line of the owner or of hers opens with a muted lead, its number, then its text, as `[#3] text` (`numberLead` in `interfaces/cli/transcript.ts`). Every number is padded with zeros to one width, the digits of the whole stored history's count, which is the number of its newest line (`leadDigits`). The text keeps one column, and a page of older lines loads under the same width: `[#1]` to `[#9]` in a history of nine lines, `[#001]` to `[#120]` in one of 120. The number is the line's place among all the stored lines of `cli:dm:owner`, in the order the history reads them, `occurred_at` and then the row, so the first line ever is `#1` and a line keeps its number after Page Up and in a new chat. `chatLines` in `src/memory/db/chat-lines.ts` counts it, `session.page` sends it with each line, and the chat draws it. A line said since the chat opened takes the number after the line before it, and a file of hers that follows her words takes theirs. When her turn is committed, failed or cancelled, the chat reads the newest page again and gives each such line the number of its stored line, matched by who said it and its text. A line that replies to another draws `↳ #N` after its own number, the number of the line it answers (`replyLead` in `interfaces/cli/transcript.ts`). Her reply keeps the line it answers: `interfaces/cli/link.ts` hands the parent's message id to the screen and puts it on the line it keeps for the core's history reads. Memory stores it as the line's `reply_to`, `chatLines` sends it as `replyToId` with the parent's `replyNumber`, and her `<chat>` reads a stored line as a reply to that line again after a restart (`withStoredHistory` in `src/chat/stored-history.ts`). A live line takes its mark when the chat matches it to its stored line. The number and the date are for the owner alone: no request of hers and no memory carries them. Her requests carry a `#N` of their own that counts the lines of one request, and the core sends the client none of them. A `#N` she writes in a reply reaches the chat as the number the chat draws on that line ([interfaces](interfaces.md)). The later rows of a line start in the column of its text, as Hermes draws its message bodies (`ui-tui/src/components/messageLine.tsx`), and a copy leaves that indent out. One blank row stands after her line when the owner's line follows it, and nowhere else. The date and minute a line was sent, in brackets as `[2026-11-08 13:04]`, stand on a muted row of their own that starts at the left edge, as the numbers do, in two places: above the owner's first line, the one with no line of his or hers before it, and above each line of his that follows the blank row. No other line carries a time, hers never. The owner's lines are red (`THEME.owner` in `interfaces/cli/theme.ts`), and her text keeps the terminal's own colour. The numbers and the time rows stay muted on his lines as on hers. `shownEntries` in `interfaces/cli/chat-controller.ts` places the rows. Times are in `bot.timezone` (default `UTC`). A stored line keeps its stored time (`at` of `session.page`), and a new line takes the time it reached the chat.

A stored control character is drawn as one visible character (`displaySafe`), so a line from memory can neither run an escape sequence nor vanish unseen. No line carries a `>` mark: the owner's lines are purple and hers white, and a notice of the chat, such as a failed turn, starts with `· `. The selected row of the slash menu carries `›` beside its inverse video. Fenced code, quotes and headings get a style by their line, and their text stays as it arrived.

`interfaces/cli/theme.ts` holds the semantic tokens: `text`, `muted`, `title`, `mark`, `owner`, `her`, `activeBorder`, `inactiveBorder`, `selection`, `caret`, `code`, `quote`, `heading`, `success`, `warning` and `error`. A token asks for an ANSI style. The font family, its faces and the cell size belong to the terminal emulator.

`NEPTUNIA_LINEAR=1` draws one plain column in reading order for a screen reader, with no borders and no galaxy. It sets `ChatEnv.linear`.

### Measured geometry

These rows were read from frames the chat wrote into the fake terminal of `tests/fixtures/chat-rig.ts`, with one long reply and one command result, and are counted from row 0 at the top. They count cells and rows, say nothing about pixels, and were taken without an emulator, a font or a theme. No comparison with another program's layout was made.

| Element | 80 by 24 | 40 by 18 | 20 by 6 | Linear, 80 by 24 |
|---|---|---|---|---|
| Header | 5 rows and 1 blank | 5 rows and 1 blank | None | 1 row |
| Transcript budget | 14 rows | 8 rows | 2 rows | 21 rows |
| Input with one row of text | 3 rows, on rows 20 to 22 | 3 rows, on rows 14 to 16 | 3 rows, on rows 2 to 4 | 1 row, on row 22 |
| Status row | row 23 | row 17 | row 5 | row 23 |
| Text column of the input | 4 | 4 | 4 | 2 |
| Command window, open | 7 rows, 5 of them its rows | 4 rows, 2 of them its rows | 1 row, its rows alone | 10 rows, 8 of them its rows |

The galaxy needs at least 16 rows and 40 columns. Below that the header is one line, and under 8 rows it goes.

## The command window

Every slash command but `/clear`, `/attach <file>` and `/attach save` runs in the command window (`interfaces/cli/command-window.ts`), between the chat and the input. Sending one opens the window with the command line under the same lead of its time and its number among the session's commands, as `[2026-11-08 13:04] [#2] /status`, which is when it started, its answer in the column of its text, and under the answer the minute it finished, as `finished 2026-11-08 13:05`. A command still running shows no finish. Its numbers take a width of their own, the digits of the session's command count, so the tenth command turns `[#1]` into `[#01]`. The window takes half of the rows the header, the notices and the input leave, rounded down, and the chat keeps the rest: 7 and 8 rows at 80 by 24. A rule above its rows and the hint under them show while a row still fits between them. It keeps every result of the session in order, so the next command reopens it with the earlier results above. An answer that comes while the window is closed opens it at its tail, so a command left running in the background shows its result when it finishes (`answerResult` in `interfaces/cli/chat-controller.ts`). The `Cancelled.` that closing the window writes into a panel still loading opens nothing. An answer never folds there, and the window scrolls with the wheel apart from the chat. A drag inside it selects and copies its text as in the chat.

A command's answer reaches the window and never the chat: `ChatEnv.send` gives back the promise of a command's answer, and `panelOf` answers a command that has a panel. A panel of lines alone is shown as the command's text. An interactive panel, such as the `/model` selector, `/config`, `/setup`, `/help` or a picker, draws inside the window in place of its rows and holds the keys. The window's last row reads `Esc to close`, in the form of Claude Code's panel footers such as `Esc to cancel` under its `/help`, and a live panel shows its own keys there instead.

Esc closes the window and the panel in it, and a panel request still on its way opens nothing and leaves `Cancelled.` as its answer. The draft stays, and with the window closed Esc acts on the input as before. A panel's own Esc goes first: it leaves a value editor, or steps the model selector back, and closes the window from the selector's first step. A chat line asks for no panel, so a plain word such as `status` goes to her.

## Editing and keys

`buildKeymap` in `interfaces/cli/keymap.ts` is the one registry of these keys, read by dispatch and by help. A key resolves against the focus context first: `composer`, `attachment` (the caret right after a chip), `menu`, `secret` (any open question), `search` or `panel`. The `secret` context binds no history, stash, undo, editor or clipboard action, so what is typed there reaches no store. The setting `cli.bindings` (default `[]`) overrides a key with entries such as `{ "context": "composer", "key": "ctrl+t", "action": "history.search" }`. An override that collides with a bound key, names an unknown action or names one its context does not allow is not bound, and the chat says so when it opens.

`interfaces/cli/editor-actions.ts` works on the draft of `interfaces/cli/composer.ts` and the transcript's entries. A search shows its match in the input and sends and stores nothing. Enter on a history match loads it into the draft, and the next Enter sends it. Esc restores the draft and the view exactly. The letters of one word undo together, up to 100 steps, and a send starts over. Undo cannot bring back an image whose chip was removed, because its staged bytes went with it. Stashed drafts keep their parts and last until the chat ends.

Ctrl+G hands the terminal to the editor with the draft in a private temporary file under `$TMPDIR`, removed afterwards. The command is `$VISUAL` or `$EDITOR` split on spaces, with no shell. Images stay in the draft. A failing editor leaves the draft as it was and says so, and an emptied file cancels.

Raw mode clears `IXON` and `ISIG` (checked with `stty -a` under a pseudo-terminal), so Ctrl+S and Ctrl+Z reach the chat instead of the terminal's flow control and job control.

`cli.mouse` (default `true`) takes the terminal's SGR mouse reports for buttons, the wheel and motion while a button is held (modes `1000`, `1002` and `1006`). `parseMouse` and `mouseFilter` in `interfaces/cli/mouse.ts` take the reports out of the input before Ink sees them, and `ChatController.onMouse` in `interfaces/cli/chat-controller.ts` acts on them. The wheel scrolls the chat or the command window under the pointer three rows a notch, or moves the slash menu while it is open. A click in the input places the caret on a whole character, and a click on a line's grey number makes the next message a reply to that line ([replies](#replies)). `mouseAvailable` refuses tracking for `TERM=dumb` and the linear mode, and with it off Ink drops a stray report before it can reach the draft.

Tracking takes the terminal's own selection away, so the chat selects text itself. A drag over the transcript or the command window marks the cells it covers in inverse video, and releasing the button copies the text with an OSC 52 sequence (`osc52` in `interfaces/cli/clipboard.ts`) and says `copied N chars to clipboard` on the status row. The terminal does the copy, so it reaches the owner's own machine over SSH. A selection over several rows joins them with newlines, a click without a drag copies nothing, and Ctrl+C copies the selection again instead of leaving. The next key, click or wheel notch drops it. A terminal that ignores OSC 52 copies nothing, and tmux passes it on only with `set-clipboard on`. Shift with the mouse reaches the terminal's own selection in xterm, GNOME Terminal, Konsole, kitty, WezTerm and Windows Terminal, and Option does the same in iTerm2. Text is pasted with the terminal's own paste key, which arrives as a bracketed paste. Windows Terminal binds Ctrl+V to that paste, so Ctrl+V reaches the chat as an image attachment only in a terminal that leaves it unbound.

## Overlays and questions

One screen element holds the keys and a paste at a time. A question from the core goes first, then a panel open in the command window, then the input. `focusOwner` in `interfaces/cli/chat-controller.ts` decides, and a panel that loses the keys stays on the screen. The mouse still scrolls and selects while a panel holds the keys.

A question replaces the input and keeps the unfinished line it interrupted. The line comes back after the answer or Esc, and an answer never joins it. Enter does nothing for 700 ms after the question closes, counted again from each Enter it swallows, so a held key cannot send a draft its owner has not seen. A secret answer is drawn as stars and stays out of the input history. A question with choices opens the selector in `interfaces/cli/selector.ts`. Typing or pasting narrows the list, Enter answers with the choice exactly as the core sent it, and a filter that matches nothing answers nothing. The plain chat prints the choices beside the prompt.

Each slash command replaces the panel request before it. An answer of a request that was replaced or cancelled with Esc opens nothing and runs nothing. The same rule holds inside a selector, whose reducer compares the overlay id and the generation of every answer. Moving and filtering change no setting.

## Turns, the queue and cancelling

`createTurnControl` in `src/turn/control.ts` owns the state of every line the chat or `neptunia -p` sends: accepted, queued, running, and committed, cancelled or failed. Each event names its turn and carries a rising `seq`. The core sends them to a client that asked with `turn.replay`, as a `command.result` of status `turn` (`src/protocol/turn-control.ts`), and `interfaces/cli/turn-state.ts` builds the chat's picture from them and from nothing else. Her replies still arrive as messages, so the events carry the turn's state and the reply its words.

A line goes through the event door when it arrives, like a message of any other interface (`src/interface/chat-turns.ts`). Memory observes it at once, and the pipeline's own queue decides when its turn runs: one turn at a time, with at most `mention.maxPending` calls waiting for `mention.pendingMinutes`. The control adds no helper model and holds no line back: it tracks the order and states the client shows, one turn running at a time. The status row under the input shows what her running turn does now and how many lines wait: the names of the calls that began and have not returned, such as `using conversation.read`, or that her turn runs when no call does. A call's result never shows there, and the turn leaves the row when the core reports its end. The same request id sent twice is one line. A failed turn leaves a line in the transcript, and the next line goes on.

A line that waits is already said, so its text cannot be edited, and `/queue` offers no edit. Enter on a row of `/queue` cancels the turn over that line, and the line stays in memory, where she can read it. A cancel of a waiting line acknowledges at once, and when the pipeline reaches it the runner ends its turn before any request.

Esc on an empty input asks the core to cancel the running turn, once. The chat keeps showing the turn as running until the core acknowledges, and Esc with text in the input clears only the input. Leaving the chat cancels nothing, and an errand, a task or the watcher is never reached by a chat cancel. The signal of a running turn stops the wait in progress, aborts the provider request and takes effect between tool steps. A turn with a message already out ends committed, whatever the cancel asked. Lines of other interfaces do not pass through the control, so a turn over one has no signal.

Quick lines are answered together, as in any private chat. A line sent while her turn waits for the owner to stop writing is read by that turn ([the settle wait](core.md#the-settle-wait), `pace.settleMs`). When that turn ends with a reply or a silence, the line ends `committed` with the same response id and never runs. A failed turn leaves those lines to their own turns. The pipeline can also answer a line inside another line's turn or drop one it saw answered, so a line can have no turn of its own. A line the answering turn had in view, which the pipeline then counts as answered (`spokeAfterSeeing` of the turn runner), ends `committed` with that turn's response id when that turn ends. For any other such line, when a later line's turn begins, or after 30 seconds with no turn running anywhere, the line's wait ends with `no-own-turn`, and `neptunia -p` hears the same. A line taken during a pause ends with `paused`, while the core still holds it for `/resume`.

These states live in the core's process and do not survive a restart. A lost link leaves the state as the core last said it. The chat calls `reconnect()` of the `cli` interface every 2 seconds (`start` in `interfaces/cli/link.ts`), and `turn.replay` returns what it missed, or names another core instance, in which case the chat drops the turns it held and says how many it lost. The core's routes return completed output, so `running` carries `streaming: false` and the transcript shows no text until her reply. The reducer takes `text` events, and no route produces them.

## Delivery while no chat is open

Her posts in `cli:dm:owner` go to the chat client that sent the owner's last line while it is connected, and otherwise to the newest open chat (`chat` of `createCommandIntake` in `src/interface/neptunia-cli.ts`). An open chat is a client that asked for the turn events with `turn.replay`. The interactive chat asks when it starts and again after every reconnect, and the plain chat asks once when it starts. A heartbeat post, an intention's post, an errand's result and the later messages of a reply after `neptunia -p` exited all reach a chat that is open now, whichever client sent the last line. A client that only runs a command is no chat and takes no post.

With no chat open, the chat still exists, as a Discord direct chat exists while its partner is away. `createCliChat` in `src/interface/cli-chat.ts` describes the chat to a wake, an errand result and `message.create`, and answers a text post `ok` with a message id of its own and `deferred: true`. The turn stores the post as her line, as it stores every sent post, and the chat draws it with the other stored lines when it opens. A chat that lost its link shows her lines stored while it was away once it is back. The result of a kept `message.create` adds `tools.result.storedUntilOpen`, and a wake's delivery records `deferred` on its receipt. A post with a file cannot wait, because a stored line holds its text alone. It is refused with `chat-closed`, and nothing is sent.

## Sessions and checkpoints

A chat session is a named view over the lines memory already stores for the owner's chat, in the `sources` table under the place `cli:dm:owner`. Those records are the durable chat, so `src/chat/sessions.ts` copies none of them and keeps only ids and times, in `<private>/cli/sessions.json` (`src/chat/store.ts`). The file is not memory: nothing she recalls reads it. A session's name is the start of the owner's first line, with no model. The input history in `data/cli/history` and the transcript on the screen are separate from both.

`/sessions` lists them, and Enter on a row resumes one. `/sessions resume <id>` does the same by id. `/resume` is the command that ends a pause. `/branch` lists the lines of the current session with their exact stored text, and Enter on a line continues from there. `/branch <id>` cuts another session. Opening any of these panels only reads, and the same boundary of the same session is always the same branch.

Resuming or branching replaces the transcript on the screen and the lines the core's history reads answer from, so the next turn's context is the selected view. A line written while a branch is selected belongs to that branch, and the root shows every line no branch owns. Stored lines, facts she learned and their sources stay untouched, and memory stays continuous: a branch does not make her forget what she saw after its boundary, because her memory reads across every session. A new chat process starts on the root. These commands exist only in the interactive chat, because their effect is on its screen.

When the chat opens it draws the newest `context.channelMessages` stored lines of `cli:dm:owner` as the current session shows them, through the core's `session.page` command in `src/interface/commands/chat-state.ts`. Page Up at the top of the transcript asks for the page that ends before the oldest stored line shown and draws it above. A resumed or branched view shows its own lines whole. Each line carries the time the chat process stamped on it when it was sent (`interfaces/cli/link.ts`), on the machine the core runs on, and `<chat>` renders that time in `bot.timezone`. No command deletes these lines: `clear` clears the terminal, and `/branch` and `/resume` change only the view kept in `<private>/cli/sessions.json`.

Her turns read the same stored lines. `withStoredHistory` in `src/chat/stored-history.ts` answers the core's history read of a stored DM place, `cli:dm:owner`, from the lines the current session shows (`shown` in `src/chat/sessions.ts`) and adds the lines the chat process holds, one copy of each by message id. The partner on the stored lines is the native id of the place's `partner_account`, which core reads through `placeRefOf` in `src/memory/addresses.ts`. The chat process holds only the lines said since it started, so a turn after a restart of the core or of the chat, a `neptunia -p` run and a wake while no chat is connected read the stored chat as well. A turn keeps the newest `context.channelMessages` of these lines, as in every other chat. A stored line carries its text and its items as `mediaMessageParts` in `src/memory/db/media-store.ts` gives them, each with its stored description and a kept file by its reference, so a picture, a GIF, a video, a voice note or any file of the newest lines comes back with its line after any restart. The chat process keeps only her words, so its copy of her line takes the stored files it lacks.

`/checkpoints` previews and restores the files of a development task's worktree (`src/development/checkpoints.ts`). The board decides what counts: an open task whose `metadata.development.worktree` lies under `selfimprovement.checkout`'s `.worktrees` folder (`src/development/checkpoint-desk.ts`). With no such task the panel says why and offers no row. `/checkpoints take <task>` copies the worktree to `<private>/development/checkpoints/<task>/`. A row shows the affected paths, and Enter on it restores them. Every restore first takes a checkpoint of what it replaces, reported as its undo. A symlink leading out of the worktree refuses the restore, and a partial failure reports `failed` with the undo. `.git`, `.env`, `.secrets`, `data`, `config.local`, `prompts.local`, `node_modules`, `.claude` and `.worktrees` are neither captured nor restored. Nothing takes a checkpoint by itself. Rewinding a chat is `/branch`, and it changes no file.

## Approvals and capability menus

`/approvals` opens what waits on the task board: a triaged task is a plan gate, and a task in `needs_validation` a merge gate that shows the worker's handoff (`src/board/approval-view.ts`). Several gates list as rows, and `/approvals <task>` opens one. Approve and reject are two rows, and a reject takes the reason the board asks for. An answer is the board's `task.approve` under the `owner` client's name, naming the revision on the screen, so the board's rights and revision check decide and a stale answer changes nothing. `createApprovalRelay` in `src/tools/approvals.ts` forwards one answer per shown revision, so a double Enter is one approval, and a refused answer leaves the gate open. Esc answers nothing. The panel starts no executor and adds no merge policy, which remain `selfimprovement.mode` and the development worker's (`docs/development-agents.md`).

Tool calls have no such panel, because nothing asks. An agent's mode (`read`, `write`, `full` or `sudo`, `/agent mode`) is set in advance and becomes the sandbox of its run (`src/subharness/control.ts`), and a headless backend cannot stop to ask. Her own tools are decided by grants before the turn (`/tools grant`). So no command panel, scope or expiry exists to show, and no proposed command or file diff reaches a gate: a merge gate shows the artifacts the worker named, and the diff lives in its pull request.

`/tools`, `/skills`, `/interfaces` and `/agent` open a menu: the family's list operation as text, where it has one, and a row per subcommand of the command table that prefills the typed command. Opening a menu runs only that read, and every change goes through its typed command. `/tools list` names every tool and whether she holds it, and `/tools grants` runs `access.list`, every stored grant of hers, of a member, of a role or of everyone. `/status full` ends with the request limit (`llm.maxRequestTokens`), the core's route and its model through `interfaces/cli/context-line.ts`. The size of the last request is held by no read, so it shows as unknown. The chat offers no context compression, because the core has no such operation.

## Settings and setup panels

`/config` opens settings with readable names and descriptions, grouped into tabs. Search accepts both these names and the underlying configuration keys. Use Left and Right or Tab to change tabs, Up and Down to select a row, and Enter to toggle a boolean or edit a value. Typing filters settings across all tabs. In an editor, Enter saves through the normal command handler, Ctrl+U clears the input and Esc cancels.

`/setup` offers named keys, service credentials, interface setup, skill setup and search configuration. Opening it performs no installation or provider check. Selecting an action uses its existing command and any required secret dialog. Model and backend actions prepare the targeted command in the input for you to complete.

`/model` opens the nested model selector described in [Keys and models](keys.md#the-model-selector). `/model show`, `/model set`, `/model add` and `/model remove` stay commands. For an agent, `/model set <agent> <model> --via opencode-harness --provider <slug>` pins its OpenCode runs to one OpenRouter provider with no fallback, `/subharness status` shows the pin on the agent's row, and a `/model set` for the agent without `--provider` drops it. The details are in [errands](errands.md#the-provider-of-an-opencode-route). A model role runs on a chain of routes: `/model set <role> <route>`, `/model add <role> <route>` and `/model remove <role> <n>` change it, as [Keys and models](keys.md#setting-a-chain) describes. `/model set core harness:claude/<model>` puts her turns on a subscription CLI.

`/help` provides searchable command rows. Enter puts the selected command into the input. Command completion includes subcommands such as `/skills setup`.

## Commands

Start with `/help`. It is generated from the command table, so it includes the arguments supported by the installed revision. The slash menu provides completion.

| Task | Command family |
|---|---|
| Inspect health or pause responses | `/status`, `/doctor`, `/pause`, `/resume` |
| Inspect and change settings | `/config get`, `/config set`, `/config unset` |
| Choose credentials and models | `/keys`, `/model`, `/search` |
| Send outbound connections through one proxy | `/proxy`. See [Proxy](proxy.md) |
| Configure a chat platform | `/interfaces` |
| Prove the owner's account on an interface. See [Pairing the owner's account](interfaces.md#pairing-the-owners-account) | `/interfaces pair open <name>`, `/interfaces pair <phrase>` |
| Choose which providers serve a model | `/routes` |
| Bind an account to a meta-person, or merge two people | `/memory bind`, `/memory users merge` |
| Give her or a person a name the door and the classifier know | `/memory users names add person:self NAME`, `/memory users names remove person:self NAME` |
| Browse people, places, the graph and each memory family, and read every stored row | `/memory users`, `/memory places`, `/memory graph`, `/memory inspect`, `/memory claims` and the other families. See [The memory browser](#the-memory-browser) |
| Choose where the selfreflection is published | `/mirror` |
| Review and activate a skill | `/skills` |
| Show the sources of the agents and log them in or out | `/subharness status`, `/subharness <backend> login`, `/subharness <backend> status`, `/subharness <backend> logout` |
| Set what an agent may do | `/agent mode <agent> [<mode>]` |
| Schedule, switch and inspect the four scheduled mechanics | `/services` |
| Run or read a watcher report | `/doctor watcher run`, `/doctor watcher list`, `/doctor watcher read` |
| Cancel the turn over a waiting line, in the chat only | `/queue` |
| Resume or branch a chat, in the chat only | `/sessions`, `/sessions resume <id>`, `/branch` |
| Restore a development task's files, in the chat only | `/checkpoints` |
| Answer what waits on the task board, in the chat only | `/approvals` |

## The memory browser

The browser reads her memory for the owner and nobody else: only the `cli` principal reaches it, no operation of hers names it, and a development agent's command goes to the task board. `src/interface/commands/memory.ts` answers each read with the JSON of its reader in `src/memory/db/`, so a script and the chat select the same typed ids. A read asks no model, changes no setting and writes no row, `node_access` and `turn_reads` included, and what it answers never reaches her memory. A refusal has a status other than `ok` and a stable `code`, such as `PERSON_NOT_FOUND` or `INSPECTION_BAD_CURSOR`. In the chat, a bare `/memory users`, `/memory places`, `/memory entities`, `/memory graph` or `/memory inspect` opens a panel whose rows prefill the command that opens them.

A page holds at most `memoryDb.inspection.pageRows` rows, whatever `--limit` asks for, and says what it left out in `total`, `truncated` and `reason`. Its `next` is the `--cursor` of the next page. A cursor is bound to its read: another filter, table, context or snapshot refuses it.

| Command | What it reads |
|---|---|
| `/memory users list`, `show`, `accounts`, `names`, `relationship`, `private` | People, unlinked accounts and anonymous participants, by `--name`, `--interface` and `--authority`. A name is a search term and links nothing |
| `/memory users merge <from> <into> [--reason <text>]` | The owner's merge of one person into another, through the memory writer. Everything about `<from>` moves to `<into>` and keeps its audience. A person nobody stored answers `PERSON_NOT_FOUND` ([Merging people](memory.md#merging-people)) |
| `/memory users names add <user> <name>`, `remove <user> <name>` | The owner's confirmation of a member's alias |
| `/memory places list`, `tree`, `show`, `lore` | Places of any kind and depth, with `--roots`. `show --include-children` adds every descendant and its descriptions. An orphan is a root, and a cycle ends with an explicit reference |
| `/memory places lore add <place> <title> <keys> <text>`, `list <place>`, `show <place> <id>`, `remove <place> <id>` | The lore of a place |
| `/memory entities list`, `show <entity>`, `names <entity>`, `relations <entity>` | The semantic entities, by `--kind`, `--name` and `--recorded-before`. `show` opens the stored record with its names, its descriptions and `canonicalId`, the entity it is taken to be. `relations` takes `--predicates` and `--mode`, `active` by default or `historical` |
| `/memory graph kinds`, `nodes`, `edges`, `node`, `neighbors`, `walk`, `path` | The projection, every node and edge once, `--mode active` by default or `--mode historical`. `--valid-at` and `--recorded-before` are two questions. Node kinds and predicates with no typed table are listed as deferred |
| `/memory sources`, `claims`, `descriptions`, `episodes`, `selfreflection`, `media`, `publications`, `grants`, `sessions`, `requests`, `turns`, each `show <id>` and `list` | One record with every stored field and links to the exact records around it, retired and internal ones included |
| `/memory claims versions <id>`, `version <id>`, `/memory descriptions versions <id>`, `version <id>` | Every version in order, or one |
| `/memory inspect tables`, `schema`, `rows`, `row`, `value`, `export`, `close` | Every table the database holds, whether or not a menu names it |

`/memory graph walk` visits each node once whatever the number of paths. `--depth` and `--nodes` bound it, a node at the depth bound with an edge not yet followed is its `frontier`, and a walk from the frontier goes on. With no `--depth` it stops at 32. `/memory graph path` answers the shortest association and why there is none (`none`, `depth` or `work`). A path is read and never remembered.

`/memory entities` reads through `src/memory/db/entities-read.ts`. An entity is listed when a version recorded before the cutoff names it, and the cutoff is strict, as in the graph. `--name` matches a name or an alias in force in any case and spacing, and a shared name lists every entity it fits. `names` gives each name with the version that says it. `relations` opens each version whole: its predicate, polarity, truth state and how it is known, every argument, the roles the entity plays, its evidence and its premise versions. The `active` mode holds the newest version of each claim unless that version is retired, and `historical` holds every version in order of recording. An entity nobody stored answers `ENTITY_NOT_FOUND`.

On a semantic version, `/memory claims version` adds `semantic`, its rows of `semantic_assertion_versions`, `semantic_arguments` and `semantic_dependencies` as stored. Its links name each premise version with the role `premise` and each version resting on it with the role `dependent`. `/memory users show` and `/memory places show` list among their `records` every version that names the person or the place in a role, under the table `semantic_assertion_versions`.

`/memory inspect` reads through a snapshot, so its pages hold still while she goes on writing. A command without `--snapshot` opens a snapshot and names it in `snapshot`; `--snapshot <id>` reads on from that moment. A snapshot ends with `/memory inspect close`, after `memoryDb.inspection.snapshotIdleSeconds` without a read and after `memoryDb.inspection.snapshotMaxSeconds` in any case, and an ended one refuses with `INSPECTION_CLOSED` or `INSPECTION_EXPIRED`. At most `memoryDb.inspection.maxSnapshots` snapshots are open at once, and the open past that is refused with `INSPECTION_TOO_MANY`. `rows` takes `--filters`, one JSON word of `{ "column", "value" }` entries with typed values, and `row` and `value` take a page's `locator` as one JSON word. From a shell these words keep their spaces. A chat line splits on spaces, so there they are written without any.

A page shortens a cell over 4 KiB, and the cell's `excerpt` gives `totalBytes`, `remainingBytes` and `nextOffset`. `/memory inspect value <table> <locator> <column> --offset <n>` reads on in chunks of 1 MiB by byte offset in the stored value. A stored text that is not valid UTF-8 comes back from `value` as base64, with `encoding` saying so, and a page or an export names its stored bytes in the cell's `exactBytes`.

`/memory inspect export <file>` writes one new JSONL file, at an absolute path on the core's machine, at mode `0600`, and refuses a file that exists. It holds a `header` with the engine revision and both schema versions, the `catalog`, one `row` record per row with full values and a `manifest` of row counts it reconciled against the snapshot. It is complete or it does not exist. The write runs on a thread of its own over a snapshot that thread opens, so the core keeps answering while it works, and the event loop watch names it `memory.inspect.export`. FTS shadows are marked as derived storage.

## Backend usage

`/usage` prints the engine's own accounting, then what each backend's account says of itself under `backend accounts:`. `readAllUsage` in `src/subharness/usage.ts` reads the four sources, and no read starts a model run. One source that fails leaves the others readable, and it prints its code after `not read:`.

| Source | Read | What it shows |
|---|---|---|
| `codex` | `codex app-server` with `account/read`, `account/rateLimits/read` and `account/usage/read` under the persona's home | The email and plan, used percentage, reset time, window, lifetime and daily tokens |
| `claude` | `claude auth status` | Whether the account can be read by hand. Its `/usage` is an interactive screen, so the block is `unsupported` and names the command to open it |
| `opencode` | `opencode stats` under the persona's home | Sessions, messages, days, dollars and tokens, under the name of its key |
| `openrouter` | `GET /key` on the core role's key | Spend, limit and what remains, under the key's name |

Each block names its source, its account and its observation time. A value the source did not report prints `unknown`, never zero. Subscription tokens carry no price. A failed read of the same known account keeps the last numbers until the core restarts, each marked `(stale)` under its own observation time, and a logout or another account drops them. The blocks are never added together, because the `openrouter` spend of a key already holds what `opencode` spent on that key.

## Mirrors

`/mirror` manages the places her selfreflection is published to, in the chat and as `neptunia mirror <subcommand>`. A mirror is named by its id or its place id. A bad value answers `invalid` and changes nothing. [Selfreflection](selfreflection.md#mirrors) describes delivery and backfill.

| Command | What it does |
|---|---|
| `/mirror list` | Every mirror and whether it is enabled. This is the bare `/mirror`. |
| `/mirror status` | Each mirror with its interface, queue, failed, incomplete, uncertain and blocked entries, the copies delivered outside their audience, and its backfill. |
| `/mirror add <destination> [--backfill true\|false] [--every <duration>]` | Registers a known place. Adding it again reuses the mirror. |
| `/mirror configure <mirror> [--enabled true\|false] [--backfill true\|false] [--every <duration>]` | Changes a mirror. `--enabled false` stops sending and keeps the configuration. `--backfill true` needs an interval, given now or earlier. |
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

A command that asks a question with no terminal exits `1` with the question on stderr and sends no answer. A secret question also names `--secret-stdin`. That flag is accepted by `keys add`, `keys service set`, and the `setup` and `set` commands of `/interfaces` and `/skills`: it answers the first question, when that question is secret, from stdin less one trailing newline. Empty stdin exits `1`, and so does any other question the command asks.

```bash
printf '%s\n' "$TOKEN" | neptunia interfaces set discord token --secret-stdin
```

On every other command `--secret-stdin` is ordinary text. `keys add` and `keys service set` exit `2` for a word past their name, in the chat and in both shell forms, so a secret never reaches the process list, the core or the logs.

`neptunia subharness <backend> login`, `status` and `logout` run with no core. [Setup](setup.md#subharness-backends) describes them and their exit codes.

## Diagnostics

`/doctor` and `neptunia doctor` run the checks of the installation with the core up or down. The check `readiness` says whether a chat would open and names each repair, as in [setup](setup.md#chat-readiness), a core that is down included, so the doctor reports a stopped core once. The last check, `runtime`, is the core's own reading of the server, itself and the memory. It is left out while no core answers, and `skipped` when a core does not answer within 5 seconds. `/doctor server`, `/doctor core` and `/doctor memory` read one of the three from the core (`src/health/`), ask no model, write nothing and exit `1` with no core. `/doctor live` holds `providers` in place of `runtime`: the core sends one test request for each model role.

`/doctor watcher run` asks the core to start one [watcher](watcher.md#run-and-read) report in the background and answers its number and start time at once, or the number and state of the run already going. It exits `1` with no core. `/doctor watcher stop` stops the running report. `/doctor watcher list` lists every report, the newest first, with its number, start, finish and state. `/doctor watcher read` opens the newest report and `/doctor watcher <number>` report `number` of the list, each under its number and dates. These four read the files with no core. A number past the list or of a run with no report exits `1`, and a word that is no number exits `2`.

## Logs

`/logs` reads the journal of `neptunia-core.service` in the scope of the installation, and a journal it cannot read exits `1` with the scope and the reason. Its filters are `errors`, `follow` and `since <value>`, and `follow` works in the chat alone. `/logs watcher` exits `2` and names `/doctor watcher`.

## Scheduled services

`neptunia services list` prints the status of `heartbeat`, `selfreflection` and `selfimprovement`, with no process unit among them. `neptunia services <name> setup|enable|disable|status` controls one of the three. `/services <name> <action>` and `neptunia -p "/services ..."` reach the same handler, `src/service/commands.ts`. Selfreflection is the selfreflection wake and selfimprovement is the persona's development wake, which stays apart from the development worker. The handler works with no core, so a mechanic can be switched and read while the core is down. `/pause` and `/resume` hold and release every turn, and `/services <name> disable` stops one mechanic.

`setup --at 00:00,12:00` saves daily UTC times and `setup --every 6h` an interval in hours or minutes (`90m`). The two exclude each other. Both write the one setting `<name>.schedule` that `/config` reads, leave the flag as it is, and answer `timezone: UTC` and `next:` with the next times. `heartbeat setup --jitter 30m` sets `heartbeat.jitterMinutes`, which moves an interval either way and leaves daily times exact. `setup` with no flag asks at a terminal and exits `2` without one.

`enable` and `disable` move `<name>.enabled` and run nothing at once. A run already going finishes after `disable`.

`status` exits `0` whatever it finds, asks no model and writes nothing.

| Line | What it says |
|---|---|
| `service` | The mechanic |
| `enabled` | The saved flag |
| `running` | Whether a run is going, `unknown` for a wake with no core and for a selfreflection even with one |
| `readiness` | `ready`, or `not ready` and what is missing: the core, a role's subharness source or the repository |
| `schedule` | The schedule, with the heartbeat's jitter. `windows` for a selfreflection with no `selfreflection.schedule` |
| `next due` | The next time, `none` when disabled. For a selfreflection drawing from windows with no core it is the start of the next window that can post in `bot.timezone`, `none` when no window can |
| `last result` | The core's last wake, `unknown` with no core |

`neptunia services watcher evidence [--from <iso>] [--cursor <c>]` prints one page of the recorded requests and Claude transcripts of the observation window as JSON, with no core and no board. Its keys are `interval`, `runs`, `totalRuns`, `examinedRuns`, `unreviewedRuns`, `inFlightRuns`, `nextCursor` and `gaps`, and the first page, with no `--cursor`, adds `trash`, `mirrors`, `selfreflection`, `standards` and `audit`. A `--from` that is no date or a `--cursor` that is no `nextCursor` exits `2`. [The watcher](watcher.md#service-runs) describes the read.

`neptunia services watcher select --sql <statement>` prints the rows of one read-only statement over the memory database as JSON, `rows` and `truncated`, with no core and no board. A missing `--sql` exits `2`, and a write, a second statement or a missing database fails. [The watcher](watcher.md#service-runs) describes the read.

`neptunia setup` with `watcher`, `selfimprovement` or `mechanics` exits `2` and names the command that replaced it. A word order such as `services status watcher` exits `2` the same way.

## Other entry points

`neptunia setup` performs installation, as one flow with no step of its own to name. `neptunia worker development` is what `neptunia-development.service` starts, and `neptunia worker development held` lists the tasks older than its boundary, as in [self-development](selfimprovement.md#enabling-the-worker). `neptunia interface run <name>` starts a platform package and stays singular, because a unit starts it. `neptunia services start|stop|restart|status [unit]` runs `systemctl` for the named units or the core and the two errand runners, in the scope of the installation, with `sudo` in the system scope except for `status`. These verbs exist in the shell alone and never name a mechanic. `neptunia tasks` addresses the [task board](board.md) as the client `NEPTUNIA_TASK_CLIENT` names, by default `owner`, which `neptunia setup` makes with the board role `owner`. With no token for that client it exits `1` with `unavailable:`, the client's name and the repair.

`/status` needs a core connection. For service logs, use the systemd scope selected during [setup](setup.md#services).

Every command is declared once, in the command table `src/interface/commands/table.ts`, with its subcommands, its arguments and its help line. A leaf that maps onto one operation names it in its `op`, together with how the parsed arguments become the operation's, and the core's console in `src/interface/commands/console.ts` runs it through `operationOf` with the owner's rights. A leaf without `op` is answered by a module of its own, such as `src/interface/commands/memory.ts` for the memory browser.

Read the implementation in [command table](../src/interface/commands/table.ts), [CLI entry point](../bin/neptunia.ts), [request parsing](../bin/neptunia-request.ts) and [interactive renderer](../interfaces/cli/app.ts).
