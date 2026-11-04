# Errands

An errand is work the persona delegates through `errand.run`, such as researching a question with the scout. The persona receives the result and decides what to say or do next.

The core chooses the requested agent profile and submits the work to an errand runner. The result is associated with the original work and can wake the persona. Starting an errand is different from executing a quick in-turn tool.

## The subharness

### Backends

Claude Code, Codex and OpenCode are supported execution backends. Install and authenticate them under the persona's own [subharness directory](setup.md#subharness-backends). The scout and server profiles live in `agents/`; personal prompt and profile overrides live in `data/agents/`.

Each run has a time limit. Claude receives a model-turn limit and OpenCode receives an agent step limit. Codex execution is bounded by the timeout; its runner does not enforce an equivalent step count. Choose the backend with this distinction in mind.

### The route of an errand

The core decides an errand's path when it dispatches the errand. `routeOfAgent` in `src/subharness/control.ts` reads `keys.json` at that moment and puts the backend, model, effort and mode of the agent into the task as `route`. The runner takes everything from the route and never opens `keys.json`, because the scout unit hides the persona folder. A route that is malformed fails the task with `bad-route`. While no backend is connected for the agent the core sends no route, and the runner fails the task with `subharness-off`.

Claude Code and Codex bring their own login, so no key travels with them. An OpenCode route spends the extra key that `subharness.key` names in `keys.json`. The core puts its value in the task's `secrets.openrouterKey`, and the runner uses it for that run alone. When that key is missing, the errand fails with `route-no-key`. When the core cannot read `keys.json` at dispatch, the errand fails with `keys-unreadable` and nothing is sent.

## Modes

Execution modes govern the agent's access: `read`, `write`, `full` and `sudo`. The mode in the route sets the backend's sandbox and decides whether `sudo` is refused inside the run. Use `/subharness mode <agent> <mode>` to select one. Rerender units with `neptunia setup units` and restart the affected unit to apply systemd restrictions. A mode stored in the key store alone does not change an already running service.

The scout and server units bind the folder of every backend that is connected or installed under `data/subharness/`, writable, so a claude child keeps its config directory there (`CLAUDE_CONFIG_DIR`). The server unit's network also reaches Anthropic's ranges, `160.79.104.0/23` and `2607:6bc0::/48`, next to Cloudflare's.

Native backend sessions belong to `data/subharness/<backend>/`. A task's final answer is only part of its history; keep native sessions for later inspection of the work.

The scout's deep search and the core's [quick search](keys.md#quick-search) have separate configuration. Implementation starts in [src/agent-runner/backend.ts](../src/agent-runner/backend.ts) and [agent profiles](../agents/).
