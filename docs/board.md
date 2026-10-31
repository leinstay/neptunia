# The task board

This document is for whoever runs a deployment's development agents or changes the board's code. It covers what the task board holds, who may do what on it, how the agents reach it, how the status card reads its costs, how it is restored from a backup, and how a ledger's history is imported onto it. The state machine and the socket protocol are described in [The core](core.md#the-task-board), and the tables in [Memory](memory.md#the-task-boards-tables).

## What the board holds

The board (`src/board/`) is a set of `board_*` tables in `memory.db`, beside her memory and apart from it. Every task is one row of `board_tasks` in one of two lanes. The `dev` lane holds the development work: a task filed by the lead, the thinker or her `board.propose`, its brief, its attempts, its questions, its reviews, its results and its handoff. The `errand` lane holds her errands, written by the errand store as the builtin principal `core` (see [Errands](errands.md#where-errands-are-kept)). Each change of a task writes a row of `board_events` with a rising `seq`, and a move into `done`, `failed`, `cancelled` or `needs_answer` writes a row of `board_outbox` to the task's subscriber.

The core is the only process that opens the board for writing. Every board write is a write of the memory writer, so the board is up exactly while the core runs.

## Roles

A principal's roles come from its `boardRoles` in the private directory's `clients.json`, read at every call. The core adds two builtin principals of its own, `persona` and `core`, whatever `clients.json` says of those names.

| Role | What it may do |
|---|---|
| `owner` | Every right of `reviewer`, approves a plan at any risk, merges, claims, answers, releases a lease |
| `reviewer` | Triages, briefs, rejects, approves a plan at low risk, reviews a submitted task and merges it once CI is green, retries a failed task, records its own runs. Never claims |
| `worker` | Claims an approved task and works it as its holder: heartbeat, results, questions, block, submit, release |
| `scheduler` | Triages, claims and fails a task, edits its fields |
| `watcher` | Reads only |
| `persona` | Files a proposal and reads the tasks filed for her. The builtin `persona` holds this role alone |
| `errand-runner` | Runs the errand lane and sees only its errand tasks. The builtin `core` holds it with `scheduler` |

A deployment's development clients are the lead with `owner`, the thinker with `reviewer` and the dispatcher's worker with `worker`, each of kind `agent` with a token of its own:

```bash
node tools/client-token.mjs add lead --kind agent --roles owner
node tools/client-token.mjs add thinker --kind agent --roles reviewer
node tools/client-token.mjs add dispatcher --kind agent --roles worker
```

## How the agents reach it

A development agent runs `neptunia task <command>` with its token in `NEPTUNIA_TASK_TOKEN` (see [The neptunia command](cli.md#the-task-board)). The command connects to the core's socket, `<data>/run/core.sock`, and the board's own rights decide each call. A worker takes its next task with `neptunia task next --lane dev --role <role>`, which holds back a task that waits for its brief, and every holder call after it carries the generation `next` answered. A call with an older generation is refused `stale-lease` and writes nothing, so a worker whose lease the reaper took back cannot write over the next holder's work. The orchestrator follows the board with `neptunia task events --from <seq>`.

Her tools `board.propose` and `board.status` call the board as `persona`. They are closed until the owner grants them to her by name, `/nep access grant` with her as the target, like every tool of hers.

No dollar cap stops a task or an attempt. `budget_usd` is stored on a task and an attempt reports its cost with `task.attempt.end`, and nothing compares the two. The money bound of an agent is the OpenRouter limit of the key it spends.

## Costs on the status card

The owner's `/nep status` field `costs.development` (`src/tools/impl/status.ts`) shows the thinker and dev over today, the last 7 and the last 30 UTC days. It asks the board's `costs.agents` with `by: 'role'` as the principal `thinker` (`src/board/costs.ts`). The thinker's figures are its runs in `board_agent_runs`, and its last wave adds the context line. Dev's figures are the dev-lane attempts whose role is `dev`, `implementer` or `writer`, whoever ran them. A run or an attempt counts on the day it started and its tokens and dollars on the day it ended. Without `by`, `costs.agents` keys the attempts by the principal that ran them, and `neptunia task costs` prints that answer. A board that is down or refuses shows both agents with no runs.

## Backup and restore

The board is part of `memory.db`, so the memory database's backup holds it (`memoryDb.backup`, `tools/memory-db.mjs backup`). `tools/memory-db.mjs restore-tables --part board --from <backup dir> --db <memory.db>` brings back every `board_*` table and the board's sequence counters from a backup and leaves her memory as it is, on a stopped core. It is refused, with nothing changed, when the board's schema version differs between the two files. `tools/memory-db.mjs board list` and `board show <id>` read the board with the core up or down.

## Importing a ledger

`tools/board-import.mjs` brings the development history of a task ledger service's `ledger.db` onto the board, on a stopped core:

```bash
node tools/board-import.mjs --from <ledger.db> --db <memory.db> --dry-run
node tools/board-import.mjs --from <ledger.db> --db <memory.db>
```

It reads a ledger at schema version 3 and refuses any other version with `unknown-version`. Every `dev`-lane task comes with its id and every ledger column, at `lease_generation` 0, with its dependencies, attempts, questions, results and comments under their ids, and its approvals as `board_reviews` with their ids, decisions and scopes. Every row of `agent_runs` comes with its id. The `errand` lane stays behind with every row that hangs off it, because it only mirrored her errands, which the board holds under their own ids, and the report counts its tasks as `skipped.errandTasks`. No idempotency key comes over.

The board numbers its own events, so the imported events and outbox rows are appended after the board's last `seq`, in the ledger's order, with their actor, type, values, `created_at` and `delivered_at`. A reader of `task.events` that kept a cursor into the ledger starts again from the board's last `seq` before the import. The `trigger_seqs` of an imported agent run still name the ledger's numbers.

A task or an agent run the board already holds with the same id and the same columns counts as `present` and brings nothing, so a second run imports zero rows and leaves every board table as it was. A board row that holds a ledger id with other content refuses the whole import with `conflict`. The writes are one `BEGIN IMMEDIATE` transaction under the database's writer lock, which a running core holds, so the import is refused with `board-unavailable` while the core is up. `board-unavailable` also answers a missing database or a board that is not at the engine's version, and `not-a-ledger` a file without the ledger's tables.

`--dry-run` opens the memory database read-only and prints the counts it would import. The tool prints `imported`, `present` and `skipped` table by table, one line each, and exits 0. A refusal exits 1 with `<code>: <message>` first on stderr, and a usage error exits 2 before it opens anything.
