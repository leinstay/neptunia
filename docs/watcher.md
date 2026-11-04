# Watcher

The watcher is an agent that reads project and persona evidence, writes a report and can file diagnostic tasks. It does not implement its own fixes or deploy changes.

Its shared definition lives in `agents/watcher/`. Customize the prompt and supported profile fields under `data/agents/watcher/`, just like the [other agents](development-agents.md). Reports live under `data/agents/watcher/reports/`.

## Configure and run

Use `neptunia setup watcher` to choose whether it runs, its time, backend and model. Rerender units after changing the schedule and enable the watcher timer in the installation's systemd scope.

`neptunia watcher run` invokes the agent and can spend model allowance. `/report` reads a stored report. The persona's `watcher.read` tool uses stored reports rather than launching another inspection.

## Read the result

The runner checks the answer before writing a report or filing tasks. A failed check leaves a failure record. A day with a completed report is not automatically inspected again.

When evaluating a watcher, look for findings supported by file paths or recorded events, tasks that explain the problem, and repeated reports of an already tracked issue. A quiet report is useful only if the agent actually had access to the evidence it needed.

Read the implementation in [report validation](../src/watcher/report.ts), [run lifecycle](../src/watcher/run.ts) and [task filing](../src/watcher/tasks.ts).
