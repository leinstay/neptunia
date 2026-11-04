# Errands

An errand is work the persona delegates through `errand.run`, such as researching a question with the scout. The persona receives the result and decides what to say or do next.

The core chooses the requested agent profile and submits the work to an errand runner. The result is associated with the original work and can wake the persona. Starting an errand is different from executing a quick in-turn tool.

## The subharness

### Backends

Claude Code, Codex and OpenCode are supported execution backends. Install and authenticate them under the persona's own [subharness directory](setup.md#subharness-backends). The scout and server profiles live in `agents/`; personal prompt and profile overrides live in `data/agents/`.

Each run has a time limit. Claude receives a model-turn limit and OpenCode receives an agent step limit. Codex execution is bounded by the timeout; its runner does not enforce an equivalent step count. Choose the backend with this distinction in mind.

## Modes

Execution modes govern the agent's access: `read`, `write`, `full` and `sudo`. Use `/subharness mode <agent> <mode>` to select one. Rerender units with `neptunia setup units` and restart the affected unit to apply systemd restrictions. A mode stored in the key store alone does not change an already running service.

Native backend sessions belong to `data/subharness/<backend>/`. A task's final answer is only part of its history; keep native sessions for later inspection of the work.

The scout's deep search and the core's [quick search](keys.md#quick-search) have separate configuration. Implementation starts in [src/agent-runner/backend.ts](../src/agent-runner/backend.ts) and [agent profiles](../agents/).
