# The watcher

The watcher is an agent that looks over the persona, the project and the server once a day and leaves one report. This document is for the owner who reads the reports and for whoever runs or changes the watcher. It is the deployment's observer and no part of her. It opens no turn of hers, writes no memory, speaks in none of her channels and changes none of her prompts. Its reports reach her in two ways: her `selfimprovement` wake carries the newest one, and her tool `watcher.read` returns any of them. The owner reads them through her or with `/report`. A finding ends as a task on the board or as a line for the owner.

## A run

`neptunia watcher run` (`bin/neptunia.ts`) calls `runWatcher` (`src/watcher/run.ts`) once. `deploy/neptunia-watcher.timer` starts it daily at `watcher.at` (default `00:00`, UTC), and the service is a oneshot, so the timer starts no second run while one is going. The day of a run is the UTC date of the clock. A day that already has a report asks no agent and files nothing, so a second start never files twice.

Otherwise a run goes through these steps, and the first one that fails ends it.

1. It reads the prompt candidates through `readPromptFile`. A personal file that is absent, or that this user may not read (`EACCES`, `EPERM`), falls back to the shared candidate. No usable candidate, a blank selected prompt or any other read error ends the run as `no-prompt` before an agent is called.
2. It asks the agent once with the brief. A run that throws, fails or exits non-zero is `agent-failed`.
3. It refuses an answer with a key-looking string anywhere in it, the tasks block included (`secret`).
4. It cuts the tasks block out of the answer. A block it refuses is `bad-tasks`.
5. It checks the report against the codes below.
6. It files the tasks and puts one line per filed task into the report.
7. It writes `reports/<day>.md`.

The agent runs through `runAgent` of the subharness (`src/subharness/run.ts`) under the agent name `watcher`, in the checkout as its working directory, and a run that lasts an hour (`WATCHER_TIMEOUT_MS` in `bin/neptunia.ts`) is killed. The backend is the one `subharness.uses.watcher` names in `keys.json`, else the first connected one. The model is `subharness.models.watcher` and the effort `subharness.efforts.watcher`, when they are set, and the mode is the one `subharness mode watcher` stored ([Errands](errands.md#the-subharness)).

A run that fails before step 6 files no task, writes no report and leaves `reports/<day>.failed` with the code and a detail that never quotes the answer. A board that refuses the filing in step 6 fails the run as `board-failed`, but the report is still written, with the tasks filed before the refusal. Whenever the report is written, the `.failed` file of that day goes.

## The files

Reports sit in `data/agents/watcher/reports/` of the persona data directory (`NEPTUNIA_DATA_DIR`, default `data/`), a folder that is private to the deployment and never tracked. It holds `<YYYY-MM-DD>.md` reports and `<YYYY-MM-DD>.failed` markers, and every reader ignores any other name (`src/watcher/read.ts`).

The shared definition is `agents/watcher/profile.json` and the shared prompt `agents/watcher/prompt.md`. The profile has the kind `watcher`, no model role and no override. A persona's own prompt at `data/agents/watcher/prompt.md` is read before the shared one, and it needs no personal profile ([Development agents](development-agents.md#personal-overrides)). Every run reads the prompt files afresh, and a day that already has a report returns before any prompt is read.

## The brief

`buildBrief` (`src/watcher/brief.ts`) joins the prompt text, the line `<day>YYYY-MM-DD</day>` and the last seven reports before that day, oldest first, each inside `<report day="YYYY-MM-DD">`. So the agent sees its own last week.

## The report

A report has the seven headings below as `##` lines, in this order, each once.

| Heading | What it holds |
|---|---|
| `Her day` | Counts of turns, messages, wakes and proposals, and how she used her reflection and memory |
| `Misunderstandings` | The turns where she or the other did not understand |
| `Memory` | What moved and what stood still |
| `The project` | The counts against last week, the drift found, the CI failures |
| `The server` | The units, the disk, the backups, the credits and the errors by code |
| `Tasks filed` | The tasks filed today and the state of the earlier ones |
| `For the owner` | What needs his decision |

Each heading holds at least one line. `nothing found` is a normal line, and a day of seven of them is a good day. `checkReport` (`src/watcher/report.ts`) refuses a report with one of these codes.

| Code | When |
|---|---|
| `missing-heading` | a heading is absent |
| `extra-heading` | a heading of another name or level, or a repeated one |
| `heading-order` | the seven headings are out of order |
| `empty-section` | a heading has nothing under it |
| `preamble` | text stands before the first heading |
| `secret` | a key-looking string is in the text |

A heading inside a code fence is no heading. A key-looking string is `sk-` followed by sixteen or more key characters, a GitHub token, an `AKIA` key id, `Bearer` with a token, or a value after `NEPTUNIA_TASK_TOKEN=`. `writeReport` also refuses a day that is no date (`invalid-day`).

## The tasks

The agent ends its answer with at most one block:

````
```tasks
[{ "kind": "fix", "title": "...", "evidence": "...", "done": "..." }]
```
````

`kind` is `fix` for a bug and `chore` for bloat or drift. The title, the evidence (a file and line, a count or a journal id) and the done-criterion are required. A second block, a block that is not a JSON array, another kind or a blank field refuses the whole answer as `bad-tasks`.

`fileTasks` (`src/watcher/tasks.ts`) files each draft with `task.add` as the principal `watcher`, in the `dev` lane. The evidence is the description and `metadata.evidence`, the done-criterion is the acceptance, and `metadata.kind` is the kind. It lists the watcher's own tasks first and skips a draft whose evidence, compared without case and extra spaces, belongs to a task that is not `done`, `failed` or `cancelled`, or that was created on the UTC day of the run or the day before. The same evidence twice in one answer is filed once. Each filed task becomes a line `- <id> (<kind>): <title>` right under `Tasks filed`, and a section that said only `nothing found` gives that line up. The watcher never triages, claims, runs or reviews a task.

The principal `watcher` is a client of `clients.json` with the board role `watcher`, made with `node scripts/client-token.ts add watcher --kind agent --roles watcher`. The board lets that role read and call `task.add` and refuses it everything else ([The task board](board.md#roles)). `neptunia watcher run` connects as the client `NEPTUNIA_TASK_CLIENT` (default `watcher`) with the token of `NEPTUNIA_TASK_TOKEN`, else the file `data/clients/<client>.token`.

## Her selfimprovement wake

`watcherNews` (`src/watcher/news.ts`) gives her `selfimprovement` wake the newest report whose day is the UTC day of the wake or the day before: its date and the trimmed bodies of its `## For the owner` and `## Tasks filed` sections. The wake shows them under `labels.wake.selfimprovement.watcher` ([Inner life](inner-life.md#the-selfimprovement-wake)). It gives nothing while `watcher.enabled` is not `true`, when no report of those two days exists, or when both sections are missing or empty. An unreadable folder gives nothing too. The wake's default time, `selfimprovement.at` `03:00`, falls three hours after the watcher's default run.

## Reading a report

`watcher.read { day? }` (`src/tools/impl/watcher.ts`) returns the latest report, or the report of one day, as text. A day that is no real `YYYY-MM-DD` date is `invalid`, a day with no report is `not-found`, and a core without the reader answers `failed`. Like every tool, it is closed to her until the owner runs `/tools grant watcher.read`.

`/report [<date>]` prints a report in the `neptunia` chat. `reportAnswer` (`bin/report.ts`) reads the file itself, so it runs with no core, and `renderMarkdown` (`bin/markdown.ts`) renders headings, lists, tables, code, bold and italic with ANSI codes on a terminal and as plain text otherwise. Both readers go through `src/watcher/read.ts`, which picks the report with the latest date and takes a day only as a date, so neither opens another file.

## The service

`deploy/neptunia-watcher.service` runs `neptunia watcher run` as an agent user, never the core's, and `deploy/neptunia-watcher.timer` fires it daily. The template says `00:00 UTC`, and `neptunia setup` renders the timer's `OnCalendar=` from `watcher.at` (`src/setup/units.ts`). The service never restarts itself after a failed run, and its header lists the installation steps. The watcher step of `neptunia setup` (`watcherStep` in `src/setup/watcher.ts`, [Setup](setup.md)) asks whether the watcher runs, its hour, its backend and its model. It writes `watcher.enabled` and `watcher.at` to the local settings and the backend and model to `keys.json`. An answer of on with no connected backend, or with a backend that is not connected, is `refused` and stores `watcher.enabled` `false`.

## Settings and modules

| Setting | Default | What it does |
|---|---|---|
| `watcher.enabled` | `false` | Whether the deployment runs the watcher. Only `true` counts. `neptunia setup` asks for it, and while it is off her `selfimprovement` wake carries no report. `neptunia watcher run` does not read it |
| `watcher.at` | `00:00` | The time of the daily run, `HH:MM` UTC, rendered into the timer by `neptunia setup`. A value that is no `HH:MM` reads as the default |

`settings.ts` reads the two settings, `read.ts` finds and reads the reports, `news.ts` gives her wake the newest report, `brief.ts` builds the brief, `report.ts` checks and writes a report, `tasks.ts` splits the answer and files the tasks, and `run.ts` joins them. `bin/markdown.ts` and `bin/report.ts` are the chat's side.
