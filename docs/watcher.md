# The watcher

This document describes the daily watcher: an agent that looks over the persona, the project and the server once a day and leaves one report. The watcher is the deployment's observer and not part of her: it opens no turn of hers, writes no memory and reaches her only through its reports. It is for the owner who reads the reports and for whoever runs or changes the watcher.

The watcher never speaks in her channels, touches her memory or changes her prompts. Her selfimprovement wake carries its newest report, she can read any report with her tool `watcher.read`, and the owner reads them through her or with `/report`. A finding ends as a task on the board or a line for the owner.

## A run

`neptunia watcher run` (`bin/neptunia.ts`) calls `runWatcher` (`src/watcher/run.ts`) once, and `deploy/neptunia-watcher.timer` starts it daily at `watcher.at` (default `00:00`) UTC. The day is the UTC date of the clock. A day that already has a report asks no agent and files nothing, so a second start never files twice.

Otherwise a run goes through these steps, and the first one that fails ends it.

1. It reads `prompt.md` from the watcher folder. A missing or blank file is `no-prompt`.
2. It asks the agent once under the profile `watcher` with the brief. A run that fails or exits non-zero is `agent-failed`.
3. It refuses the answer if a key-looking string is anywhere in it, tasks block included (`secret`).
4. It cuts the tasks block out of the answer (`bad-tasks` for a block it refuses).
5. It checks the report (the codes below).
6. It files the tasks and puts one line per filed task into the report.
7. It writes `reports/<day>.md`.

The agent backend is the `runAgent` that `runWatcher` is given. The entry passes the subharness's `runAgent` (`src/subharness/run.ts`) with the agent `watcher`, so the watcher runs through `subharness.uses.watcher` of `keys.json`, else through the first connected backend, on `subharness.models.watcher` when it is set ([Errands](errands.md#the-subharness)).

A run that fails before step 6 files no task, writes no report and leaves `reports/<day>.failed` with the code and a detail that never quotes the answer. A good run removes that file. A board that refuses the filing in step 6 fails the run as `board-failed` and keeps the report, with the tasks filed before the refusal.

## The watcher folder

`watcher.dir` (default `.agents/watcher`, relative to the checkout or absolute) holds `prompt.md`, which a person writes, and `reports/`, which the watcher writes. The folder is private to the deployment and never tracked. `reports/` holds `<YYYY-MM-DD>.md` files and the `<YYYY-MM-DD>.failed` markers. Every reader ignores any other name.

## The brief

`buildBrief` (`src/watcher/brief.ts`) joins the text of `prompt.md`, the line `<day>YYYY-MM-DD</day>` and the last seven reports before that day, oldest first, each inside `<report day="YYYY-MM-DD">`. So the agent sees its own last week. The questions it asks and the form of its answer belong to `prompt.md`, which has to ask for the report and the tasks block described below.

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

Each heading holds at least one line. `nothing found` is a normal line, and a day of seven of them is a good day. `checkReport` (`src/watcher/report.ts`) refuses a report with a heading missing (`missing-heading`), another heading of any level or a repeated one (`extra-heading`), the headings out of order (`heading-order`), a heading with nothing under it (`empty-section`), text before the first heading (`preamble`) or a key-looking string (`secret`). A heading inside a code fence is not a heading. A key-looking string is `sk-` with sixteen or more key characters after it, a GitHub token, an `AKIA` key id, `Bearer` with a token, or a value after `NEPTUNIA_TASK_TOKEN=`.

## The tasks

The agent ends its answer with at most one block:

````
```tasks
[{ "kind": "fix", "title": "...", "evidence": "...", "done": "..." }]
```
````

`kind` is `fix` for a bug and `chore` for bloat or drift. The title, the evidence (a file and line, a count, a journal id) and the done-criterion are required. A second block, a block that is not a JSON array, another kind or a blank field refuses the whole answer as `bad-tasks`.

`fileTasks` (`src/watcher/tasks.ts`) files each draft with `task.add` as the principal `watcher`, in the `dev` lane. The evidence is the description and `metadata.evidence`, the done-criterion is the acceptance, and `metadata.kind` is the kind. It lists the watcher's own tasks first and skips a draft whose evidence, compared without case and extra spaces, belongs to a task that is not `done`, `failed` or `cancelled`, or that was created on the UTC day of the run or the day before. The same evidence twice in one answer is filed once. The watcher never triages, claims, runs or reviews a task.

The principal `watcher` is a client of `clients.json` with the board role `watcher`, made with `node scripts/client-token.ts add watcher --kind agent --roles watcher`. That role reads the board and calls `task.add`, and the board refuses it everything else (see [The task board](board.md#roles)). `neptunia watcher run` connects as the client named by `NEPTUNIA_TASK_CLIENT`, default `watcher`, with the token of `NEPTUNIA_TASK_TOKEN` or `<private>/clients/watcher.token`.

## Her selfimprovement wake

`watcherNews` (`src/watcher/news.ts`) gives her selfimprovement wake the newest report whose day is the UTC day of the wake or the day before: its date and the bodies of its `## For the owner` and `## Tasks filed` sections, trimmed. The wake shows them under `labels.wake.selfimprovement.watcher` ([Inner life](inner-life.md#the-selfimprovement-wake)). It gives nothing while `watcher.enabled` is not `true`, when no report of those two days exists, or when both sections are missing or empty, and an unreadable folder gives nothing too. The wake's default time, `selfimprovement.at` `03:00`, falls three hours after the watcher's default run.

## Reading a report

`watcher.read { day? }` (`src/tools/impl/watcher.ts`) answers the latest report, or the report of one day, as text. A day that is not a real `YYYY-MM-DD` date is `invalid`, a day with no report is `not-found`, and a core without the reader answers `failed`. Like `skill.read` it is closed until the owner runs `/tools grant watcher.read`.

`/report [<date>]` prints a report in the `neptunia` chat. `reportAnswer` (`bin/report.ts`) reads the file itself, so it runs with no core, and `renderMarkdown` (`bin/markdown.ts`) renders headings, lists, tables, code, bold and italic with ANSI codes on a terminal and plain text otherwise. Both readers use `src/watcher/read.ts`, which picks the report with the latest date and takes a day only as a date, so neither opens another file.

## The service

`deploy/neptunia-watcher.service` is a oneshot that runs `neptunia watcher run` as an agent user, never the core's, and `deploy/neptunia-watcher.timer` fires it daily. The template says `00:00 UTC`, and `neptunia setup` renders the timer's `OnCalendar=` with `watcher.at` (`src/setup/units.ts`). The watcher step of `neptunia setup` (`src/setup/watcher.ts`, [Setup](setup.md)) asks whether the watcher runs, its hour, its backend and its model. A start while a run goes on does nothing. The service never restarts itself after a failed run. Its header lists the installation steps.

## Settings and modules

| Setting | Default | What it does |
|---|---|---|
| `watcher.enabled` | `false` | Whether the deployment runs the watcher. Only `true` counts, and while it is off her selfimprovement wake carries no report |
| `watcher.at` | `00:00` | The time of the daily run, `HH:MM` UTC, rendered into the timer by `neptunia setup` |
| `watcher.dir` | `.agents/watcher` | The folder of `prompt.md` and `reports/` |

`settings.ts` reads the three settings, `read.ts` finds and reads the reports, `news.ts` gives her wake the newest report, `brief.ts` builds the brief, `report.ts` checks and writes a report, `tasks.ts` splits the answer and files the tasks, and `run.ts` joins them. `bin/markdown.ts` and `bin/report.ts` are the console's side.
