# Errands

An errand is work the persona delegates through `errand.run`, such as researching a question with the scout. The persona receives the result and decides what to say or do next.

The core chooses the requested agent profile and submits the work to an errand runner. The result is associated with the original work and can wake the persona. Starting an errand is different from executing a quick in-turn tool.

## The subharness

### Backends

Claude Code, Codex and OpenCode are supported execution backends. Install and authenticate them under the persona's own [subharness directory](setup.md#subharness-backends). The scout and server profiles live in `agents/`; personal prompt and profile overrides live in `data/agents/`.

Each run has a time limit. Claude receives a model-turn limit and OpenCode receives an agent step limit. Codex execution is bounded by the timeout; its runner does not enforce an equivalent step count. Choose the backend with this distinction in mind.

### The route of an errand

The core decides an errand's path when it dispatches the errand. `routeOfAgent` in `src/subharness/control.ts` reads `keys.json` at that moment and puts the backend, model, effort and mode of the agent into the task as `route`. The runner takes everything from the route and never opens `keys.json`, because the scout unit hides the persona folder. A route that is malformed fails the task with `bad-route`. While no backend is connected for the agent the core sends no route, and the runner fails the task with `subharness-off`.

Claude Code and Codex bring their own login, so no key travels with them, and an errand agent searches with its harness's own tools. An OpenCode route spends the extra key that `subharness.key` names in `keys.json`. The core puts its value in the task's `secrets.openrouterKey`, and the runner uses it for that run alone. When that key is missing, the errand fails with `route-no-key`. When the core cannot read `keys.json` at dispatch, the errand fails with `keys-unreadable` and nothing is sent.

## Modes

Execution modes govern the agent's access: `read`, `write`, `full` and `sudo`. The mode in the route sets the backend's sandbox and decides whether `sudo` is refused inside the run. Use `/agent mode <agent> <mode>` to select one. Rerender units with `neptunia setup` and restart the affected unit to apply systemd restrictions. A mode stored in the key store alone does not change an already running service.

The server unit hides every client's token and every interface's `credentials.json` with `InaccessiblePaths=-<path>`, because it runs as the core's user and reads the host. It connects as no client, so it keeps no token. The modes `full` and `sudo` drop these entries with the rest of the mount sandbox. `keys.json` stays readable to it, and a client made after the unit was rendered stays visible until `neptunia setup` renders the unit again. The scout hides the whole persona folder instead.

The scout and server units bind the folder of every backend a role names or that is installed under `data/subharness/`, writable, so a claude child keeps its config directory there (`CLAUDE_CONFIG_DIR`). The server unit's network also reaches Anthropic's ranges, `160.79.104.0/23` and `2607:6bc0::/48`, next to Cloudflare's.

Native backend sessions belong to `data/subharness/<backend>/`. A task's final answer is only part of its history; keep native sessions for later inspection of the work.

One finished errand opens one result turn. [src/errands/turns.ts](../src/errands/turns.ts) runs one attempt at a time and arms one retry at a time for an errand, whichever of the service's restart, the door's replay of `errand.done` and the retry timer reaches it, and each attempt reads `readAt` from the store first.

A personal `profile.json` or `prompt.md` under `data/agents/<id>/` is opened without following a link in the same call that reads it, so a link placed after the check fails the run with `no-prompt` or the profile's error.

## Step and output limits

`backendLimits` in [src/agent-runner/backend.ts](../src/agent-runner/backend.ts) says which caps a backend enforces and through what. These are the controls that reach the child process.

| Backend | Steps | Output tokens |
|---|---|---|
| `claude` | `--max-turns` | `CLAUDE_CODE_MAX_OUTPUT_TOKENS` |
| `opencode` | `OPENCODE_CONFIG_CONTENT` | `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` |
| `codex` | none, the timeout bounds it | none, the timeout bounds it |

A run that asks a backend for a cap it has no control for carries the gap `step-limit-not-enforced` or `output-limit-not-enforced` and writes one log line. The profile's seconds and the global request caps in `llm.*` apply on every backend, and no dollar budget exists.

A `claude` run prints `--output-format json`. The engine takes the answer and the run's real usage from it, and a result with `is_error` fails the errand with `backend-error` whatever the exit code.

## Search from an errand

The scout's deep search and the core's [quick search](keys.md#quick-search) have separate configuration. Implementation starts in [src/agent-runner/backend.ts](../src/agent-runner/backend.ts) and [agent profiles](../agents/).
