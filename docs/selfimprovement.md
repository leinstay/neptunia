# Self-development

A task filed on the [board](board.md) starts development by itself. The thinker controls the task, each dev works from its plan, and a finished change waits as a pull request on GitHub. This guide is for an owner setting that up.

## The wake and the worker

The selfimprovement wake is a persona turn that decides: she files one task or skips, and the wake ends. [Inner life](inner-life.md#heartbeat-and-selfimprovement) describes what it accepts. Its request is the service list of the turn frame, nowhere, with `prompts/selfimprovement.md` as its task. `<inner>` adds `<work>`, her calls of the window it states by shape, failures by code, repeated chains and unused tools, each line with the ids of its turns, and `<board>`, her tasks and what came back on them. Both are worded by `src/behavior/selfimprovement-text.ts` from the facts `buildSelfimprovementFacts` in `src/behavior/selfimprovement-view.ts` reads out of her journal and the journal of every place she serves. Neither the wake nor the persona starts an agent. `neptunia worker development` does, in `src/development/worker.ts`, whenever the board has a task for it. It runs apart from the wake, so `neptunia services selfimprovement disable` leaves filed tasks going.

The worker stays up and waits for the board's events through the `task.wait` command, so a filed task starts at once and an idle worker sets no clock. While a pull request is watched it also looks at GitHub every `development.lookEveryMs` milliseconds (default `120000`), because a merge there raises no board event.

## How a task runs

An approved top-level task on the `dev` lane runs whoever filed it, and it stays attributed to its requester. Her proposals of kind `fix` and `skill` are approved by the worker at risk `low`, since nothing lands without a merge. A proposal with no kind stays `proposed` until the owner or a reviewer approves them.

The worker runs from the install and works on the dev checkout `selfimprovement.checkout` names, so no run edits the code that is running. It first checks that the checkout has `node_modules` and that the system's gh login may push to `selfimprovement.repository`. Either failure blocks the task with the check's line from `labels.selfimprovement.check`. It then fetches `selfimprovement.base` from that repository and makes a branch `self/<task>` in the worktree `<checkout>/.worktrees/<task>`. The worker's start adds `/.worktrees/` to `.git/info/exclude` of the checkout, so `git status` there lists no worktree and no tracked file changes. Before a worktree is used, `placeTree` gives it a `node_modules` folder with one link per package of the checkout's `node_modules`, `.bin` included, so the commit hooks find their tools. The `@neptunia` links stay relative and resolve to the worktree's own workspace folders. A worktree that already holds a `node_modules` keeps it, and a checkout without one closes the task `failed` with `modules-missing`. Each task keeps its own branch and worktree, recorded in `metadata.development` with its pull request and head.

The thinker runs on its own route in one-shot turns. A small thing it finishes itself. Larger work it files as dev tasks with `--parent`, and each dev runs on its own route, one at a time, in a branch and worktree of its own from the task's branch. When a dev run ends, code commits what it left, merges it into the task's branch and closes the dev task. The task keeps its lease meanwhile, and the thinker gets its next turn when the last dev task closed.

A turn that ends with nothing open means finished. Code then commits what is left, runs the tests of the touched modules and only then pushes and opens a draft pull request. Failing tests fail the task with `tests-failed`, and a branch with no change fails it with `no-change`. A task of kind `skill` works in a worktree like any other, packages strictly under `<data>/skills/<name>/` and opens no pull request. The worker binds the exact version of its package to the task and accepts her task at its next wake, and the core then activates that version, see [skills](skills.md). The owner's task of kind `skill` waits for the owner's review. Nothing else of development lands in the persona folder. Past `development.thinkerTurns` turns (default `12`) the task blocks with `thinker-turns`, and an unblock gives it new turns.

## Merging

Only this code merges, and only through the system's `gh`. The thinker has the worker's board client and no gh login. With every check green at the persisted head, the worker marks the draft ready. `selfimprovement.mode` `approve` (the default) stops there and the pull request waits for the owner. `auto` goes on to `gh pr merge --match-head-commit <sha>` when the task's risk allows it, so a commit CI never saw cannot land. The mode is read at each look. A merge by anyone closes the task and reaches her next selfimprovement wake once, and a merge by the owner has the worker delete the branch with `git push <url> --delete <branch>`, because the worker's own merge passes `--delete-branch`. A pull request closed unmerged cancels the task and leaves its branch, and a merge GitHub refuses leaves it waiting.

The owner's `neptunia tasks review <id> --changes --comment "..."` gives the thinker a new turn on the same branch with the comment in its brief. The next push moves the same pull request, so no second one opens, and the merge names the new head. A turn that leaves the refused head in place blocks the task with `changes-not-made`.

## Risk

Each look at a pull request reads `git diff --name-status --no-renames -z <base>...<sha>` at the literal head a merge would name, so a rename counts on both sides and a new push is read again. A path on `DANGER_PATHS` in `src/development/risk.ts` raises the task to `high`, with the category as the reason. The categories are `deploy`, `keys`, `subharness`, `board`, `memory-db`, `permissions`, `ci` and `dependencies`. `memory-db` is all of `src/memory/db/` except `recall.ts` and `readers/`. `permissions` holds the rights code, `agents/*/profile.json` and the gate's own files. `config/config.json` is not on the list.

The thinker's first turn records its own level with `neptunia tasks risk <id> <level> --reason "..."`. `auto` merges a task only at `low`, with a diff it could read and no listed path. Anything above `low` stays open and ready for the owner, and `approve` behaves the same at every level. The `low` the worker gives her proposal at intake is no assessment, so a task she requested with no `task.risk` record waits in `auto`. A diff that cannot be read merges nothing and journals `diff-unreadable`. The owner can lower a task through the same command, down to its highest dev task, and a dangerous diff raises it again at the next look.

When green checks in `auto` leave her task waiting, the worker sends her an outbox row of kind `risk` once, whatever the looks, restarts and deliveries that follow. Its `reason` is the category, or `assessed` when only the level or a missing assessment holds the task. Paths and the thinker's words stay out of it. An unreadable diff sends nothing, because the next look may read it.

## What comes back to her

A question addressed to `persona:self`, a proposal from the thinker, a block and a merged change reach her in `<board>` of her next selfimprovement wake, whoever filed the task. She answers with `task.answer`, and the thinker resumes on its branch with her answer in its brief. On a task she filed, `task.unblock` lets it go on and `task.cancel` stops it, along with its running agents and its dev tasks. The branch and the worktree stay for inspection.

## Grant her tools

The tracked `bot.access` is empty, so the persona holds no board tool until the deployment grants it. Without `task.propose` the wake can only skip, and without `task.answer` she reads a question she cannot answer. Grant them with `/tools grant`:

```text
/tools grant task.propose
/tools grant task.status
/tools grant task.cancel
/tools grant task.comment
/tools grant task.answer
/tools grant task.unblock
```

A grant lets her call the tool, and the wake still limits where each one runs. `task.cancel`, `task.comment`, `task.answer` and `task.unblock` run only in the selfimprovement wake.

## Configure

Only GitHub is supported, through `gh`. It is the system's tool with its existing login, so run `gh auth login` as the user that runs the unit. The engine sets no gh home of its own for the worker, and git authenticates github.com through `gh auth git-credential`. Git needs a commit identity for the user that runs the unit.

Development needs two inputs, a repository you can push to and a folder for the development checkout. `neptunia setup` asks for them at a terminal and does the rest in `developmentSetup` of `src/setup/development.ts`, asking for neither once `selfimprovement.repository` and `selfimprovement.checkout` hold them. With no checkout named it first asks whether to set development up at all. The steps run in this order, and a refused one writes no setting:

1. A missing `gh` is installed through GitHub's apt route when the process is root or has passwordless sudo. Otherwise setup says what to install and stops.
2. `gh auth status` and the push right on the repository must pass. An installation by someone else has no push right to the upstream repository, so it needs a fork, named there. Without the right every filed task blocks with the check's reason.
3. The folder must be an absolute path other than the folder the running engine was started from, compared by real path, so a link to it is refused too. The refusal proposes the sibling `<live>-dev`. The worker makes the same check when it builds its edges (`liveCheckoutProblem` in `src/development/edges.ts`), so a hand-edited setting cannot get past it.
4. An absent or empty folder gets `gh repo clone`, then `npm install` in the checkout and in each `interfaces/<name>/` with a `package.json`. A checkout of the same repository downloads and installs nothing, and setup names any package there with no `node_modules`. A folder holding anything else is refused and left as it is.

Connect a backend and choose the thinker's and dev's routes as in [development agents](development-agents.md#what-holds-a-development-agent), which also says what each backend's sandbox allows.

## Enabling the worker

Setup writes `neptunia-development.service` and never enables it. The `units` step also makes the client `development` with the roles `reviewer` and `worker` and its token `clients/development.token`, while `selfimprovement.checkout` names a dev checkout. A rerun keeps a client that has its token and writes a token that went missing. A worker started with no token file exits 1 and says to run `neptunia setup`. Enable the unit in the scope of your setup:

```bash
systemctl --user enable --now neptunia-development.service   # a user install
sudo systemctl enable --now neptunia-development.service     # neptunia setup --system
```

The first start writes `development.startedAt` into the local settings, and a restart keeps it. A task approved before that moment, or a proposal of hers filed before it, runs nothing and waits for you. List them and let one run, or cancel it:

```bash
neptunia worker development held
neptunia tasks update <id> --meta admitted=yes
neptunia tasks cancel <id> --reason "..."
```

## Recovery

A run holds its task under a short lease that it renews. The unit's default `KillMode` stops every agent with the worker, the lease lapses, the reaper returns the task to approved, and the next claim finds the branch, the worktree and the pull request in `metadata.development`. An interrupted thinker starts a fresh turn on the branch, an open pull request is watched again rather than opened twice, and a branch that is gone fails the task with `branch-gone`. A watched pull request survives a restart the same way. No process id is kept.

Worktrees stay under `<checkout>/.worktrees/` after a task ends. Read the journal with `journalctl -u neptunia-development` in the scope of your setup. The implementation is [the worker](../src/development/worker.ts), its [entry point](../bin/development.ts) and the [unit templates](../deploy/README.md).
