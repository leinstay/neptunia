# Task board

The board stores work, its status, evidence, attempts and results in `memory.db`. It lets the persona and development agents refer to the same task without using a chat transcript as the work queue.

Use `neptunia task` for task commands. Clients authenticate through the core socket; their `boardRoles` determine which transitions they may perform. Roles include owner, reviewer, worker, scheduler, persona, watcher and errand runner. A valid client token alone does not grant every board operation. `task.add` with `unique_open_title` refuses a title the requester already has open, ignoring case and spacing, with the board error `duplicate`.

A claimed task has a lease and progress records. Results can include a pull request or another artifact. Approval and completion are explicit board transitions. A saved unfinished task is evidence for later work, not permission to repeat an interrupted external action.

The [watcher](watcher.md) can file diagnostic tasks, which stay `proposed` until the owner or a reviewer approves them. An approved top-level dev task starts the [development worker](selfimprovement.md) whoever filed it, and it stays attributed to its requester. The worker is the builtin principal `development`, with the roles `reviewer` and `worker`. A dev task filed with `--parent` closes through the machine's `child` rule, `in_progress` to `done` by its holder, because the parent is what gets reviewed. Neither path needs a second memory database.

Questions and blocks of development reach the persona. `task.block` on a dev task writes an outbox row of kind `blocked` to `persona:self` with its `reason`, whoever filed the task. `task.ask` addressed to `persona:self` writes a row of kind `needs_answer` to her whoever subscribed. The requester of a blocked task may unblock it, next to the owner and a reviewer.

The `task.wait` command answers the events after `from`: at once when there are some, otherwise when a write through the core's board port makes some, and with nothing after `wait_ms` when that is given. A read never ends a wait, and a reap ends one only when it returned a task. `createBoardPort` in `src/board/writer.ts` implements it, and a principal with no board role is refused.

`scripts/board-import.ts --dry-run` inspects legacy ledger material without applying it. Run imports against a stopped installation or isolated copy, with a verified backup. See the script's usage for its required source and destination arguments.

Read the implementation in [board commands and roles](../src/board/), [task CLI](../bin/neptunia-task.ts).
