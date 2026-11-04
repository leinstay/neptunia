# Watcher

The watcher is an agent that reads project and persona evidence, writes a report and can file diagnostic tasks. It does not implement its own fixes or deploy changes. This guide is for an owner who runs it or changes how it runs.

Its shared definition lives in `agents/watcher/`. Customize the prompt and supported profile fields under `data/agents/watcher/`, just like the [other agents](development-agents.md). Reports live under `data/agents/watcher/reports/`.

## Configure and run

`neptunia service watcher setup --at 00:00,12:00` or `--every 6h` sets `watcher.schedule` and renders `neptunia-watcher.timer`. `neptunia service watcher enable` and `disable` move `watcher.enabled` and the timer. The full `neptunia setup` asks for the same schedule, and for the backend and the model. See [the service commands](cli.md#scheduled-services).

The timer starts `neptunia worker watcher` from `bin/neptunia-watcher.ts`, which invokes the agent and can spend model allowance, and exits at once while `watcher.enabled` is false. Enabling starts no worker. The timer keeps `Persistent=true`, so a machine that was off gets one catch-up inspection at its next start, however many slots passed.

## One run

`src/watcher/lifecycle.ts` keeps every inspection as one record under `data/agents/watcher/runs/`, with an identity and one of the states `running`, `stopping`, `succeeded`, `failed` and `cancelled`. Manual and timer starts take the same claim under one lock, so a start during a run answers that run and spawns nothing. A claim records the pid and the start identity of its process. A claim whose process is gone, or whose pid now belongs to another process, reads as finished. Recovery signals nothing, and it ends as `succeeded` when the run had already committed its report and otherwise as `failed` with the code `holder-gone`.

`neptunia service watcher trigger` refuses a disabled watcher. On an enabled one it claims a run with no owner, starts the worker with `systemctl start --no-block` and answers `run:` and `state:`. The worker adopts that claim and keeps its identity. A start the manager refuses fails the run at once, and a worker that never comes leaves the claim stale after `WATCHER_RUN_TIMEOUT_MS`.

`neptunia service watcher cancel` writes `stopping` into the record, and `src/watcher/inspection.ts` reads it once a second. The abort signal reaches the backend, which kills the agent's process group. The run checks again between its phases, so a cancel stops the validation, stops filing before the next task and stops the commit. Once the report is committed the run ends as `succeeded`, whatever a late cancel said. Output of an interrupted agent is kept nowhere. A trigger cancelled before its worker starts leaves the claim in `stopping`: the worker that comes ends it as `cancelled` without asking the agent, and if none comes the claim goes stale after the same timeout. A worker that finds the watcher disabled ends a waiting claim as `cancelled` with the code `disabled`. `disable` stops future runs and leaves a run in progress alone, and `cancel` leaves the flag and the timer alone.

`WATCHER_RUN_TIMEOUT_MS` is 60 minutes and bounds the agent. A run past it fails with the code `timeout`. `TimeoutStartSec=70min` in `deploy/neptunia-watcher.service` leaves ten minutes for filing and the commit, and the manager ends a worker that hangs past them.

The worker exits `0` for a committed report, with its filing deferred too, and for a cancelled run. It exits `1` for a failed run and when the board refused a task. `neptunia service watcher status` shows the deferred filing in its `filing` line.

## Reports and versions

The runner checks the answer before it saves or files anything. A failed check fails the run with a code and a detail that never quotes the agent, and the answer is kept nowhere.

Each successful run commits an immutable file `reports/runs/<day>_<commit ms>_<run id>.md`, and `reports/<day>.md` is a link swapped atomically to the newest of its day, so a failed or interrupted attempt replaces nothing. A plain `<day>.md` from an older installation reads as before, with no run identity, and stays readable as the run `legacy-<day>` once a run commits over it. The day of a report is the UTC day of its claim.

`neptunia service watcher report` reads the newest report, a day or a run identity, and a day's report names the other runs of that day. The persona's `watcher.read` tool takes `day` or `run` and uses stored reports rather than launching another inspection. The brief in `src/watcher/brief.ts` carries the last seven reports: the newest of each earlier day as `<report day="...">`, then every kept report of the run's own day as `<report day="..." run="...">`.

## Filing tasks

`src/watcher/filing.ts` saves the validated drafts of a run in `data/agents/watcher/filings/<run id>.json` before it asks the board, and each draft keeps a receipt with one of the states `pending`, `filed`, `duplicate`, `deferred`, `failed` and `cancelled`. A task carries `origin`, `runId` and `finding` in its metadata.

An unreachable board leaves a report with those drafts `deferred`, and the next inspection files them. The report keeps the words it was committed with, and the receipt holds the outcome. A refusal of the board is `failed` and is not retried. Before any new add, a draft whose answer was lost is looked for on the board by its run and finding, so it becomes one task however long the machine was down. With nothing to file, a run never opens the board.

Duplicates are found by the draft's `finding` key, so a reworded repeat files nothing. A draft or a task with no key compares by its evidence. A task counts while it is open, or when it was created on the UTC day of the run or the day before, so a problem that returns after its fix is filed again. Only the watcher's own tasks count, so a task of the persona's on the same problem never silences it.

## What the persona hears

`src/watcher/news.ts` gives her selfimprovement wake the titles of what the newest report of the past day filed, each with its receipt's state and task id. No section of a report reaches her, because a report may hold server evidence meant for the owner. A report with no receipts gives her nothing, and so does a report from before run identities. A duplicate is left out, since she heard it when it was filed.

## What the system enforces

`deploy/neptunia-watcher.service` states these limits to the kernel, as `src/setup/units.ts` renders them while the watcher's mode is `read` or `write`.

| Setting | What it does |
|---|---|
| `ProtectSystem=strict` | The whole file system is read-only, the checkout and `data/memory.db` included |
| `ReadWritePaths=` | `data/agents/watcher` and `data/subharness` stay writable, each only if it exists. `service watcher enable` makes the first |
| `NoNewPrivileges=yes` | No child gains privileges through a setuid binary |
| `PrivateTmp=yes` | The unit has its own `/tmp` |

The mode `full` drops the first two and `sudo` also drops the third, as for the [agent units](errands.md#modes).

Other limits are promises of a program, and the kernel does not hold them:

- The unit runs as the installing user, the same user as the core. It can read everything that user reads, `keys.json`, `clients/` and the memory database among them.
- The network is open. The unit has no address rules.
- The agent can write inside the two writable folders: earlier reports, run records, a local `prompt.md` and the backends' binaries and logins. "Immutable" for a report means no code path changes it.
- The right to only add tasks is the board's, checked by the core for the client `watcher`.
- The backend's read-only mode and the prompt's ban on edits are the backend's and the model's.

In a user unit `ProtectSystem=` needs unprivileged user namespaces from the kernel. The core's socket stays reachable on a read-only mount. Reading `memory.db` from there depends on the core holding its `-wal` and `-shm` files open, so a read may fail while the core is down.

## Judging a report

When evaluating a watcher, look for findings supported by file paths or recorded events, tasks that explain the problem, and repeated reports of an already tracked issue. A quiet report is useful only if the agent actually had access to the evidence it needed.

Read the implementation in [report validation](../src/watcher/report.ts), [the run](../src/watcher/lifecycle.ts), [the inspection](../src/watcher/inspection.ts) and [task filing](../src/watcher/filing.ts).
