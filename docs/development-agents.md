# Development agents

The engine ships agent definitions under `agents/<name>/`. Each definition has a profile and a prompt. Personal overrides use the same names under `data/agents/<name>/`, so they travel with the persona.

The [development worker](selfimprovement.md) runs the thinker and dev on a filed task, each through its own route in `keys.json`. Scout and server handle errands. The watcher inspects the project and reports findings. Overriding an existing profile does not introduce a new agent kind.

## Customize an agent

Place a replacement prompt in `data/agents/<name>/prompt.md`. Personal profile fields belong in `data/agents/<name>/profile.json`. The loader validates profile fields and resolves the effective definition at use time. Read the shipped profile before overriding it, and keep permission changes separate from prose changes.

Backend and model selection is controlled through `/subharness`, and the thinker takes a backend, a model, an effort and a mode like the other agents (`write` until the owner sets another). `/subharness enable` asks for the models of scout, server, dev and watcher only; set the thinker's with `/subharness use` and `/subharness model`. The core hands each errand its route when it dispatches it, see [errands](errands.md#the-route-of-an-errand). Execution mode and rendered service restrictions are explained in [errands](errands.md#modes). Authentication belongs to the persona's backend home, not the development user's unrelated login.

A task can ask an agent to create a [skill](skills.md), including scripts and setup declarations, under `data/skills/`, which an agent reaches as `$NEPTUNIA_DATA_DIR/skills/` from its worktree. The package must be complete and reviewed before owner activation. Agent code that changes the engine follows [CONTRIBUTING.md](../CONTRIBUTING.md).

## What holds a development agent

The worker keeps the same worktree layout on every backend, `<checkout>/.worktrees/<task>` under `selfimprovement.checkout`, and each backend holds the agent in its own way. The thinker needs the core's socket for its board commands, and dev needs none. A commit in a linked worktree writes into the `.git` folder of the checkout, outside the worktree. Whatever an agent cannot commit, the worker commits when the run ends.

| Backend | In `write` mode | What a refusal needs |
|---|---|---|
| `claude` | No sandbox of its own. `deploy/neptunia-development.service` alone limits what it writes. | Nothing: the unit's write paths hold the whole checkout, `data/skills/` and the socket. |
| `codex` | `-s workspace-write` allows writes in the worktree and refuses writes outside it and the network. | The checkout's `.git` in `sandbox_workspace_write.writable_roots` of the backend's `config.toml` for its own commits, `data/skills/` there too for a skill task, and `sandbox_workspace_write.network_access = true` when a board command cannot reach the socket. `/subharness mode thinker full` lifts the sandbox altogether. |
| `opencode` | No sandbox flag. The unit alone limits what it writes. | Nothing: the same unit paths as `claude`. |

No agent gets a gh login. A backend child inherits only `PATH`, `HOME`, the locale and `TMPDIR`. `developmentEdges` in `src/development/edges.ts` takes `GH_TOKEN` and `GITHUB_TOKEN` out of what the worker hands it, and points `GH_CONFIG_DIR` at an empty temporary folder made for that run and removed when the run ends. The thinker's client holds `reviewer` and `worker`, which merge nothing on GitHub. Set the thinker's and dev's backend with `/subharness use`, and their model and effort with `/subharness model <agent> <model> --effort <level>`.

## Inspect past work

Keep the backend's native session files with `data/subharness/`. The board stores attempts and results, while the native session contains the available messages and tool activity. A short final report does not replace that session. An errand's records are not resumed after a restart. A development task is, from its branch and `metadata.development`, and an interrupted agent starts over in a fresh turn.

Read the implementation in [profile loading](../src/agent-runner/profiles.ts), [backend execution](../src/agent-runner/backend.ts) and [self-development](selfimprovement.md).
