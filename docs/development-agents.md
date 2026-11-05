# Development agents

The engine ships agent definitions under `agents/<name>/`. Each definition has a profile and a prompt. Personal overrides use the same names under `data/agents/<name>/`, so they travel with the persona.

The [development worker](selfimprovement.md) runs the thinker and dev on a filed task, each through its own route in `keys.json`. Scout and server handle errands. The watcher inspects the project and reports findings. Overriding an existing profile does not introduce a new agent kind.

The watcher and development units hide the other clients' tokens and the interfaces' `credentials.json` from their agents with `InaccessiblePaths=` (see [what the watcher enforces](watcher.md#what-the-system-enforces)). Each keeps its own token, since the worker needs it to reach the board, and `keys.json`, since the worker reads each agent's route from it. The development client carries the board roles `reviewer` and `worker`, and both approve only at risk `low`. A client made after a unit was rendered stays visible to it until `neptunia setup` renders the unit again.

## Customize an agent

Place a replacement prompt in `data/agents/<name>/prompt.md`. Personal profile fields belong in `data/agents/<name>/profile.json`. The loader validates profile fields and resolves the effective definition at use time. Read the shipped profile before overriding it, and keep permission changes separate from prose changes.

Source and model selection is `/model set <agent> <model> --via <backend>`, and the thinker takes a source, a model, an effort and a mode like the other agents (`write` until the owner sets another). The core hands each errand its route when it dispatches it, see [errands](errands.md#the-route-of-an-errand). Execution mode and rendered service restrictions are explained in [errands](errands.md#modes). Authentication belongs to the persona's backend home, not the development user's unrelated login.

A task can ask an agent to create a [skill](skills.md), including scripts and setup declarations, under `data/skills/`, which an agent reaches as `$NEPTUNIA_DATA_DIR/skills/` from its worktree. The package must be complete. The version her task produced activates when the task is done, and any other pending version waits for the owner. Agent code that changes the engine follows [CONTRIBUTING.md](../CONTRIBUTING.md).

## What holds a development agent

The worker keeps the same worktree layout on every backend, `<checkout>/.worktrees/<task>` under `selfimprovement.checkout`, and each backend holds the agent in its own way. The thinker needs the core's socket for its board commands, and dev needs none. A commit in a linked worktree writes into the `.git` folder of the checkout, outside the worktree. Whatever an agent cannot commit, the worker commits when the run ends.

| Backend | In `write` mode | What a refusal needs |
|---|---|---|
| `claude` | No sandbox of its own. `deploy/neptunia-development.service` alone limits what it writes. | Nothing: the unit's write paths hold the whole checkout, `data/skills/` and the socket. |
| `codex` | `-s workspace-write` allows writes in the worktree and refuses writes outside it and the network. | The checkout's `.git` in `sandbox_workspace_write.writable_roots` of the backend's `config.toml` for its own commits, `data/skills/` there too for a skill task, and `sandbox_workspace_write.network_access = true` when a board command cannot reach the socket. `/agent mode thinker full` lifts the sandbox altogether. |
| `opencode` | No sandbox flag. The unit alone limits what it writes. | Nothing: the same unit paths as `claude`. |

On `claude` the worker passes each agent's `profile.json` tools, so `--tools` and `--allowedTools` name Read, Grep, Glob and Bash, plus Edit and Write in `write` mode, and `--dangerously-skip-permissions` replaces the approval list in `full` and `sudo`.

No agent gets a gh login. A backend child inherits only `PATH`, `HOME`, the locale and `TMPDIR`. `developmentEdges` in `src/development/edges.ts` takes `GH_TOKEN` and `GITHUB_TOKEN` out of what the worker hands it, and points `GH_CONFIG_DIR` at an empty temporary folder made for that run and removed when the run ends. The thinker's client holds `reviewer` and `worker`, which merge nothing on GitHub. Set the thinker's and dev's backend with `/subharness use`, and their model and effort with `/subharness model <agent> <model> --effort <level>`.

## Mutation testing

`.github/workflows/mutation.yml` runs `npm run mutation` once a week and on demand, apart from the pull request jobs, with a limit of 30 minutes. It mutates the lines that changed on `main` since the last commit older than a week. [scripts/mutation-diff.ts](../scripts/mutation-diff.ts) takes at most 270 changed lines, largest files first, and prints the files and line counts it left out. A score under `thresholds.break` in `scripts/config/stryker.config.json` or a run past the limit turns the workflow red. Read a red run for the survivors and the left-out list, and start it again by hand with an older `base` for what a week could not hold.

## Inspect past work

Keep the backend's native session files with `data/subharness/`. The board stores attempts and results, while the native session contains the available messages and tool activity. A short final report does not replace that session. An errand's records are not resumed after a restart. A development task is, from its branch and `metadata.development`, and an interrupted agent starts over in a fresh turn.

Read the implementation in [profile loading](../src/agent-runner/profiles.ts), [backend execution](../src/agent-runner/backend.ts) and [self-development](selfimprovement.md).
