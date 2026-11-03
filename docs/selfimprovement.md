# Self-development

This document is for whoever runs a deployment and for whoever changes `src/selfimprovement/`. It covers how a fix she files about her own code becomes a pull request, who merges it, and how the merge reaches her next wake.

## The flow

She files a change request with `board.propose` of kind `fix` ([Skills](skills.md#how-a-skill-is-made) describes the same tool for a skill). It lands on the task board as a `dev` task in `proposed`, with her evidence as its description and her cases in its metadata. `neptunia selfimprovement run` (`bin/selfimprovement.ts`) runs one `beat` of `createSelfimprovement` (`src/selfimprovement/service.ts`). The beat calls the board as the builtin principal `selfimprovement` ([The task board](board.md#roles)), connecting as the client `NEPTUNIA_TASK_CLIENT` (default `selfimprovement`) with the token of `NEPTUNIA_TASK_TOKEN`, else the file `data/clients/selfimprovement.token`. It first checks that her gh login can push to `selfimprovement.repository` ([The repository](#the-repository)), then runs three steps once each.

`intake` takes her `fix` proposals in `proposed` (a `skill` proposal and any task not filed by her stay as they are), triages them to the role, budget, steps and estimate of `board.autoTriage` at risk `low`, and approves the plan. Approval at low risk is safe because nothing lands without a merge.

`work` takes every approved `fix` task of hers, one after the other. It claims the task for 90 minutes and renews the lease every 20. It makes a worktree from the base branch with `git worktree add -b self/<task id> <worktree> <base>` in a folder of its own under `data/selfimprovement/`, so nothing runs in the checkout. One dev run works there on the brief of `prompts/selfimprovement.md` ([Prompt contract](prompt-contract.md)). The run goes through `runAgent` of the subharness under the agent name `dev`, in the mode of `dev`, and an hour past its start it is killed ([Errands](errands.md#the-subharness)). The task closes `failed` with a reason when the work stops early:

| Reason | When |
|---|---|
| `worktree-failed: <line>` | `git worktree add` failed |
| `run-failed: <error>` | the dev run did not finish |
| `refused: <reason>` | the first line of the run's final message is `REFUSED: <reason>`, and `refused: no reason given` when the reason is blank |
| `no-change` | the run left nothing that differs from the base |
| `tests-failed: <command>` | the engine's own test run failed |
| `push-failed: <line>` | `git push` failed |
| `gh-failed: <line>` | `gh pr create` failed or printed no address |
| `error: <code>` | a step threw |

A close writes a row to the outbox of the task's subscriber, her, so she hears of it in her next `selfimprovement` wake.

After the run the engine commits what it left, lists the changed paths against the base and runs the tests itself. A changed test file runs as it is. For a changed module `a/b/c.ts` it runs every existing `tests/a-b-c.test.ts`, `tests/b-c.test.ts` and `tests/c.test.ts`, in one `node --test --test-reporter=tap` call in the worktree with a minimal environment (`PATH`, `HOME`, `TMPDIR` and the locale). The counts come from the `# pass` and `# fail` lines, and the run is green only with exit code 0, no failure and at least one pass. What the agent says about its tests never counts. A failing run pushes nothing. When no test file covers the change, no test runs and the handoff's `open_issues` names the paths no test covers.

With green tests the engine pushes the branch with `git push -u https://github.com/<owner>/<name>.git self/<task id>`, the URL of `selfimprovement.repository` and never the checkout's `origin`, and opens the pull request as a draft with `gh pr create --repo <owner>/<name> --draft`. The body holds her evidence, the changed paths, the test command with its counts and the task id. The task gets `metadata.pr`, a result of kind `pr` and a handoff, and moves to `needs_validation`.

`observe` looks, through `gh pr view`, at every task in `needs_validation` whose `metadata.pr` names a branch `self/<task id>`. A look that `gh` cannot answer leaves the task as it is, and the next look tries again.

## Who merges

`selfimprovement.mode` decides, read at each look.

In `approve` (the default) every pull request waits for the owner. Once every check is green, and at least one exists, the engine marks the draft ready with `gh pr ready`, once, so the owner is asked only about a request that CI has passed. The owner merges on the host. The next look finds the pull request merged, records it and moves the task to `done`.

In `auto` the engine runs `gh pr merge <number> --squash --delete-branch` when every check is green and at least one exists. A check that is pending, failed or absent leaves the pull request waiting. The engine records `metadata.autoMerge` before the merge, so a look after a crash still knows the engine decided, and it clears the mark when the merge fails.

A pull request closed without a merge cancels the task with `pull request closed unmerged`. The branch is deleted right after its pull request ended: by `--delete-branch` in `auto`, and by `git push https://github.com/<owner>/<name>.git --delete self/<task id>` from the checkout when the owner merged or the request was closed.

A merged task carries `metadata.landed` (the title, the changed paths as `files`, the pull request number and `decidedBy`, `owner` or `auto`) and `metadata.merged`, and the engine accepts the review, which moves the task to `done` ([The task board](board.md)). The journal line `selfimprovement merged` names the task, the pull request, who decided and the number of files.

## The repository

`selfimprovement.repository` names the repository her pull requests open against, as `owner/name`. Every `gh pr create`, `gh pr view`, `gh pr ready` and `gh pr merge` carries `--repo <owner>/<name>`, and branches are pushed to and deleted from `https://github.com/<owner>/<name>.git`. A deployment of someone else's engine names its own fork here, so nothing it does proposes a change upstream. A value that is not two segments of letters, digits, `.`, `_` and `-` joined by one `/` reads as unset.

gh runs under her own config home, `data/subharness/gh`, passed as `GH_CONFIG_DIR` to the beat's gh calls and to the check (`ghEnv` in `src/selfimprovement/repository.ts`). Her pull requests are therefore never the installing user's. The owner logs her in once with `GH_CONFIG_DIR=<data directory>/subharness/gh gh auth login`.

`checkRepository` is the push-right check. It runs `gh auth status`, then `gh api repos/<owner>/<name>`, and answers `ok` when the answer grants `permissions.push`. Otherwise it answers one of these codes with the line of `labels.selfimprovement.check.<code>` from the `owner` section of `config/labels.json` ([Prompt contract](prompt-contract.md)):

| Code | When |
|---|---|
| `repository-unset` | `selfimprovement.repository` is unset or not `owner/name`. gh never runs |
| `gh-missing` | there is no `gh` on `PATH` |
| `gh-logged-out` | `gh auth status` fails under her gh home |
| `no-push` | her login can read the repository but not push to it. The line says to fork it and name the fork |
| `failed` | `gh api` failed, its answer was not JSON, or the check threw |

The line never carries any text gh printed. The beat runs the check once before anything else. On any code but `ok` it takes nothing, runs no git or gh, writes the journal line `selfimprovement paused` with the code, and `neptunia selfimprovement run` prints the line and exits 0. Her approved fixes wait on the board until a beat finds the push right again.

## What reaches her wake

The outbox row of a merged task, addressed to `persona:self`, is read as `landedFor` (`src/selfimprovement/landed.ts`) in two wakes, the `selfimprovement` wake and the heartbeat. Each shows the pull request's title and its paths through `labels.wake.landed` ([Prompt contract](prompt-contract.md)), never the diff, and marks the row delivered with `ackLanded` once its turn committed. Whichever wake comes first tells her, and a wake that did not commit tells her again.

The `selfimprovement` wake falls due once a day at `selfimprovement.at` (default `03:00`, UTC), after the watcher's daily run, and carries the watcher's newest report when the watcher is on ([The watcher](watcher.md#her-selfimprovement-wake), [Inner life](inner-life.md#the-selfimprovement-wake)). The beat runs on its own timer every six hours and works the fixes already approved without waiting for the wake.

## The beat as a unit

`neptunia setup` turns `selfimprovement.enabled` on only when a subharness backend is connected and the push-right check passes ([Setup](setup.md#the-steps)). It renders `deploy/neptunia-selfimprovement.service` and `deploy/neptunia-selfimprovement.timer` when `selfimprovement.checkout` holds the absolute path of a checkout other than the deployed one. The service runs one beat with that checkout as its working directory and the deployment's data folder. The timer starts it at `00:00`, `06:00`, `12:00` and `18:00` UTC, whatever `selfimprovement.at` says, and a beat missed during downtime is skipped. Setup does not start the timer. The owner enables it with `systemctl enable --now neptunia-selfimprovement.timer` (`--user` for a user unit). A deployment without the setting has no selfimprovement unit.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `selfimprovement.enabled` | `true` | `false` turns her self-improvement off: `neptunia selfimprovement run` prints that it is off and does nothing, and the `selfimprovement` wake never falls due |
| `selfimprovement.mode` | `approve` | `approve` or `auto`, as above |
| `selfimprovement.base` | `main` | The branch worktrees start from and pull requests target |
| `selfimprovement.checkout` | `null` | The dev checkout `neptunia setup` renders the selfimprovement units over. Unset, no units |
| `selfimprovement.repository` | `null` | The repository as `owner/name` her branches and pull requests go to. Unset, every beat pauses |
| `selfimprovement.at` | `03:00` | The time of the daily `selfimprovement` wake, `HH:MM` of the UTC day, asked by `neptunia setup` |
| `selfimprovement.failuresPerShape` | `3` | How many chains of one shape must fail in a UTC day to wake her early (`src/behavior/inner/settings.ts`) |
| `selfimprovement.tools` | `"*"` | The tools the wake may call, every granted one or a list (`src/tools/access.ts`) |
| `selfimprovement.maxActs`, `selfimprovement.maxTasks`, `selfimprovement.inputTokens` | `null` | The wake's caps on actions, errands and input tokens. `null` sets no cap, and for the tokens the loop budget applies |

The full list is in [Configuration](configuration.md#selfimprovement).

## Limits

The worktree of a task stays under `data/selfimprovement/<task id>` until someone runs `git worktree remove`. A `gh pr view` answer lists at most 100 files, which the engine records as the landed paths. A git, gh or test command that runs longer than 30 minutes is killed.
