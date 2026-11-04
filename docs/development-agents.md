# Development agents

The engine ships agent definitions under `agents/<name>/`. Each definition has a profile and a prompt. Personal overrides use the same names under `data/agents/<name>/`, so they travel with the persona.

The dev and thinker agents work on development tasks. Scout and server handle errands. The watcher inspects the project and reports findings. Overriding an existing profile does not introduce a new agent kind.

## Customize an agent

Place a replacement prompt in `data/agents/<name>/prompt.md`. Personal profile fields belong in `data/agents/<name>/profile.json`. The loader validates profile fields and resolves the effective definition at use time. Read the shipped profile before overriding it, and keep permission changes separate from prose changes.

Backend and model selection is controlled through `/subharness`, and the thinker takes a backend, a model, an effort and a mode like the other agents (`write` until the owner sets another). `/subharness enable` asks for the models of scout, server, dev and watcher only; set the thinker's with `/subharness use` and `/subharness model`. The core hands each errand its route when it dispatches it, see [errands](errands.md#the-route-of-an-errand). Execution mode and rendered service restrictions are explained in [errands](errands.md#modes). Authentication belongs to the persona's backend home, not the development user's unrelated login.

A task can ask an agent to create a [skill](skills.md), including scripts and setup declarations, under `data/skills/`. The package must be complete and reviewed before owner activation. Agent code that changes the engine follows [CONTRIBUTING.md](../CONTRIBUTING.md).

## Inspect past work

Keep the backend's native session files with `data/subharness/`. The board stores attempts and results, while the native session contains the available messages and tool activity. A short final report does not replace that session. Historical records are not automatically resumed after a restart.

Read the implementation in [profile loading](../src/agent-runner/profiles.ts), [backend execution](../src/agent-runner/backend.ts) and [self-development](selfimprovement.md).
