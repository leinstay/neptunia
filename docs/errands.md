# Errands

An errand is work the persona delegates through `errand.run`, such as researching a question with the scout. The persona receives the result and decides what to say or do next.

The core chooses the requested agent profile and submits the work to an errand runner. The result is associated with the original work and can wake the persona. Starting an errand is different from executing a quick in-turn tool.

## The subharness

### Backends

Claude Code, Codex and OpenCode are supported execution backends. Install and authenticate them under the persona's own [subharness directory](setup.md#subharness-backends). The scout and server profiles live in `agents/`; personal prompt and profile overrides live in `data/agents/`.

Each run has a time limit. Claude receives a model-turn limit. OpenCode and Codex get no step cap and only the timeout bounds them: at the cap OpenCode appends an assistant turn that Gemini and Anthropic refuse, so a capped run died with exit 1 instead of ending. Choose the backend with this distinction in mind.

### The route of an errand

`/subharness status` names a route by its harness: `claude-harness`, `codex-harness` or `opencode-harness`, see [keys](keys.md#model-sources). `keys.json` stores the backend word.

The core decides an errand's path when it dispatches the errand. `routeOfAgent` in `src/subharness/control.ts` reads `keys.json` at that moment and puts the backend, model, effort and mode of the agent into the task as `route`, and its `provider` when the owner pinned one. The runner takes everything from the route and never opens `keys.json`, because the scout unit hides the persona folder. A route that is malformed fails the task with `bad-route`, and so does a `provider` on a Claude Code or Codex route, on a route with no model, or one that is not a slug of lower case letters, digits and hyphens (64 characters at most). While no backend is connected for the agent the core sends no route, and the runner fails the task with `subharness-off`.

Claude Code and Codex bring their own login, so no key travels with them, and an errand agent searches with its harness's own tools. An OpenCode route spends the extra key that `subharness.key` names in `keys.json`. The core puts its value in the task's `secrets.openrouterKey`, and the runner uses it for that run alone. When that key is missing, the errand fails with `route-no-key`. When the core cannot read `keys.json` at dispatch, the errand fails with `keys-unreadable` and nothing is sent.

### The provider of an OpenCode route

`/model set <agent> <model> --via opencode-harness --provider <slug>` pins the agent's OpenCode runs to one OpenRouter provider, for example `amazon-bedrock` or `anthropic`. The slug is stored in `keys.json` under `subharness.providers`, by agent. For a pinned run [src/agent-runner/backend.ts](../src/agent-runner/backend.ts) writes `provider.openrouter.models.<model id>.options.provider` into the run's `OPENCODE_CONFIG` file, with `order` holding that provider alone and `allow_fallbacks` set to `false`. OpenRouter then serves the model at that provider or fails the request, and never moves it to another. The block belongs to the run's model and to no other model, and a run with no pin gets no `provider` block.

OpenCode's own `websearch` tool searches Exa. [src/subharness/run.ts](../src/subharness/run.ts) sets `OPENCODE_ENABLE_EXA=1` in the child's environment for an OpenCode run whose search provider is `exa`. The provider is the task's `searchProvider` when it has one, else the profile's `defaultSearchProvider`. When `keys.json` holds an `exa` service key (`/keys service set exa`, see [keys](keys.md)), the core reads it at dispatch for an agent whose `searchProvider` setting is `exa` on an OpenCode route and sends it as `secrets.searchKey`, and the runner hands it to that child alone as `EXA_API_KEY`, never on its command line. With no stored key the child gets no `EXA_API_KEY` and searches Exa's free endpoint, which is rate limited. Claude and Codex runs get neither variable.

The one reply that checks the selection goes out through the same provider, so a provider that does not serve the model is refused with `model-rejected` and nothing is saved. A `/model set` for the agent without `--provider` drops the stored pin, because no reply checked it on the new model, and so does a move to Claude Code or Codex. A provider asked of those two backends is refused with `provider-unsupported`, and a slug that is malformed with `bad-provider`. A run that reaches a Claude Code or Codex backend with a provider fails `provider-unsupported` and starts nothing. `/subharness status` shows `provider <slug>` on the row of a pinned agent and nothing on the others.

### The preamble and the system instructions

A run's system instructions are the deployment's preamble first and the agent's prompt after it, joined by a blank line. The prompt text of the run is the task alone, its goal and context. `composePreamble` in [src/errands/preambles.ts](../src/errands/preambles.ts) builds the preamble from the files of `data/prompts/preambles/` that match the run, `all.md`, `<agent>.md`, `@<model>.md` and `<agent>@<model>.md` in that order. Every matching file goes in whole, and the preamble has no length cap.

The system instructions replace the backend's own. Claude Code reads them from the file `--system-prompt-file` names, Codex from `-c model_instructions_file=<path>`, and OpenCode as the `build` agent's `prompt` in the config file `OPENCODE_CONFIG` names (the file that also holds a provider pin). [src/agent-runner/backend.ts](../src/agent-runner/backend.ts) writes each file mode `600` into a folder of the run's own and removes it when the run ends, whether the child succeeded, failed or never started.

### The proxy of an errand

While the [engine proxy](proxy.md) is in force, the core puts it into every errand's `secrets.proxy` in its http form, whatever the agent and its backend. The runner hands it to the child as `HTTPS_PROXY`, `HTTP_PROXY` and their lower case spellings. The value is the one in force when the errand is sent: after a switch to the direct path an errand carries no proxy, and its child gets no proxy variable at all. Secrets that hold the proxy alone are valid, since a Claude Code or Codex route carries no key.

## Modes

Execution modes govern the agent's access: `read`, `write`, `full` and `sudo`. The mode in the route sets the backend's sandbox and decides whether `sudo` is refused inside the run. Use `/agent mode <agent> <mode>` to select one. Rerender units with `neptunia setup` and restart the affected unit to apply systemd restrictions. A mode stored in the key store alone does not change an already running service.

The server unit hides every client's token and every interface's `credentials.json` with `InaccessiblePaths=-<path>`, because it runs as the core's user and reads the host. It connects as no client, so it keeps no token. The modes `full` and `sudo` drop these entries with the rest of the mount sandbox. `keys.json` stays readable to it, and a client made after the unit was rendered stays visible until `neptunia setup` renders the unit again. The scout hides the whole persona folder instead.

The scout and server units bind the folder of every backend a role names or that is installed under `data/subharness/`, writable, so a claude child keeps its config directory there (`CLAUDE_CONFIG_DIR`). The server unit's network also reaches Anthropic's ranges, `160.79.104.0/23` and `2607:6bc0::/48`, next to Cloudflare's.

Native backend sessions belong to `data/subharness/<backend>/`. A task's final answer is only part of its history; keep native sessions for later inspection of the work.

One finished errand opens one result turn. [src/errands/turns.ts](../src/errands/turns.ts) runs one attempt at a time and arms one retry at a time for an errand, whichever of the service's restart, the door's replay of `errand.done` and the retry timer reaches it, and each attempt reads `readAt` from the store first.

An attempt asks the interface of the errand's place for the chat. The owner's command line chat `cli:dm:owner` is asked of the command line, which describes it while no chat is open, so the result turn runs and her answer is kept for the chat ([delivery while no chat is open](cli.md#delivery-while-no-chat-is-open)). A chat the interface cannot describe now is tried again every `errands.resultRetrySeconds` (default `30`), like a turn the attention held back, and after 20 attempts the result is left to her `<errands>` block with the turn marked as never run.

The result turn is the ordinary turn in the place the errand was asked in, built on the turn frame with the kind `errand_result`. It answers the asking message when that message still exists, and with the message gone it answers nobody and takes `prompts/errand-result.md` as its task. `<inner>` opens with `<errand_result>`, the result, its sources and its files, and `<intentions>` shows an intention that waited for the errand with its outcome.

A personal `profile.json` or `prompt.md` under `data/agents/<id>/` is opened without following a link in the same call that reads it, so a link placed after the check fails the run with `no-prompt` or the profile's error.

## Step and output limits

`backendLimits` in [src/agent-runner/backend.ts](../src/agent-runner/backend.ts) says which caps a backend enforces and through what. These are the controls that reach the child process.

| Backend | Steps | Output tokens |
|---|---|---|
| `claude` | `--max-turns` | `CLAUDE_CODE_MAX_OUTPUT_TOKENS` |
| `opencode` | none, the timeout bounds it | `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` |
| `codex` | none, the timeout bounds it | none, the timeout bounds it |

A run that asks a backend for a cap it has no control for carries the gap `step-limit-not-enforced` or `output-limit-not-enforced` and writes one log line. The profile's seconds and the global request caps in `llm.*` apply on every backend, and no dollar budget exists.

A `claude` run prints `--output-format json`. The engine takes the answer and the run's real usage from it, and a result with `is_error` fails the errand with `backend-error` whatever the exit code.

An `opencode` run prints `--format json`, one event per line. The answer is the text of its `text` events, one per line, and a run whose output holds no event keeps its printed text as the answer. Each `tool_use` event of the `websearch` tool whose `part.state.status` is `error`, such as Exa's rate limit, counts as one failed web search. The backend logs the count as `searchFailures` on the `agent-runner: backend run` line, without the query or the error text, and puts it on the task's `result.searchFailures`. The errand store keeps it, and the result she reads gains the line `labels.errands.result.searchFailed` with `{count}`, on a done errand and a failed one alike. A run with no failed search carries no count and no line.

## Search from an errand

The scout's deep search and the core's [quick search](keys.md#quick-search) have separate configuration. Implementation starts in [src/agent-runner/backend.ts](../src/agent-runner/backend.ts) and [agent profiles](../agents/).
