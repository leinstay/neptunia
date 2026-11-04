# Task board

The board stores work, its status, evidence, attempts and results in `memory.db`. It lets the persona and development agents refer to the same task without using a chat transcript as the work queue.

Use `neptunia task` for task commands. Clients authenticate through the core socket; their `boardRoles` determine which transitions they may perform. Roles include owner, reviewer, worker, scheduler, persona, watcher and errand runner. A valid client token alone does not grant every board operation. `task.add` with `unique_open_title` refuses a title the requester already has open, ignoring case and spacing, with the board error `duplicate`.

A claimed task has a lease and progress records. Results can include a pull request or another artifact. Approval and completion are explicit board transitions. A saved unfinished task is evidence for later work, not permission to repeat an interrupted external action.

The [watcher](watcher.md) can file diagnostic tasks. The [self-development executor](selfimprovement.md) processes eligible work in a separate checkout. Neither path needs a second memory database.

`scripts/board-import.ts --dry-run` inspects legacy ledger material without applying it. Run imports against a stopped installation or isolated copy, with a verified backup. See the script's usage for its required source and destination arguments.

Read the implementation in [board commands and roles](../src/board/), [task CLI](../bin/neptunia-task.ts).
