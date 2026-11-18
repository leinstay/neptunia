# Errands

An errand is work the persona hands to one of her three agents, such as researching a question. The persona receives the result and decides what to say or do next.

She picks the agent by the tool she calls. `errand.server` files an errand for `server`, which searches, checks and reads the machine the engine is installed on. `errand.scout` files one for `scout`, which searches the web in depth and downloads pages and files. `errand.code` files one for `code`, which writes code and returns it in files. Each tool takes one argument, `goal`, and answers `queued` with the errand's id and its agent. The owner reaches the same tools with `/errands add <agent> <goal>`. An errand always has its agent: the errand store refuses one whose agent is no agent on disk with `unknown-agent`. The core submits the work to the agent's runner. The result is associated with the original work and can wake the persona. Starting an errand is different from executing a quick in-turn tool.

In a conversation her call answers at once, and the result comes in a turn of its own. In a heartbeat or a diary turn the call waits for the errand's end and answers with the result as a result turn shows it, a failure with the errand's own code, or `errand-wait-ended` when the turn's time ran out first. A waited end is marked seen and read before the core hears of it, so it opens no result turn. With `core` on a harness route, a turn that waits keeps its session held for its whole time budget in place of `llm.subscription.holdMs`.

`errands.maxOpen` counts an errand from the moment it is queued, an agent's `daily.tasks` caps its errands a day, and an agent that already runs an errand takes the next one after it. An errand still open when the core stops is failed `restarted` at the next start.

## What a run is told

The core sends the agent the goal as she wrote it and a context. The context holds `today`, the UTC date of the engine's clock when the errand is sent, as `YYYY-MM-DD`, and `engine`, the folder of the engine's checkout. It also holds the scope, the channel and the asker of the errand, the channel's latest lines for a group errand, and the stored facts that bear on the goal. `errandRecentLines` in `src/memory/db/chat-lines.ts` gives those lines oldest first, each with its author and its text, her own under `bot.name`. A line's media follow its words as the memory session writes them, each with its kind's `transcript` label and its text form. A custom emoji or a sticker stands under its stable name, and the legend `<media>` of those names heads the oldest line's text. Each agent's prompt says how to read the date and the folder.

## The board

The errand store in `src/errands/store.ts` keeps every errand as one row of `board_tasks` in `memory.db`. `saveErrand` in `src/board/errands.ts` is the board's only writer, and it runs inside a write of the kind `errand` of the memory writer. A row holds the errand's id, its goal as `title`, its agent as `role`, its status, its error as `close_reason`, the times it was filed and last changed, and every other field of the errand with its place as JSON in `metadata`. `src/board/archive.ts` maps an errand to its row and back.

A task stands in one of five statuses. A queued errand is `approved`, a running one `in_progress`, and the ends are `done`, `failed` and `cancelled`. A task at an end never moves again, and an errand that started and ended between two writes still passes through `in_progress`.

Three tables refer to the task by its id. `board_events` takes one row of type `status` for each change of status, with `core` as the actor and the old and new status. `board_outbox` takes one row to `persona` for each move to an end, in the same transaction as the move and the closing journal line. That row stays undelivered until the door takes the errand's `errand.done`, and `pendingEnds` lists the ends still waiting, so a core that starts after a crash delivers them. `board_results` holds the errand's result once, as a `handoff` with its text, its sources and the names of its files.

`board_schema_version` holds the board's version, `3`, which the memory handle reports. `/doctor core` counts the outbox rows not yet delivered. No graph projection, recall or export reads the board.

## The subharness

### Backends

Claude Code, Codex and OpenCode are supported execution backends. Install and authenticate them under the persona's own [subharness directory](setup.md#subharness-backends). The agents are the folders of `agents/` and `data/agents/`, described in [agents/README.md](../agents/README.md). An agent is off until `/agent enable <name>` sets `agents.<name>.enabled` to `true`, and `/agents` lists every agent with its unit, route, state and origin.

### Units and tools

Each agent has a unit of its name: `neptunia-agent-server.service`, `neptunia-agent-scout.service` and `neptunia-agent-code.service` run `neptunia errand-runner --unit <agent>`. A runner serves its one agent and works one errand at a time. Its socket is `/run/neptunia-agent-<unit>/sock` and its out folder `/var/lib/neptunia-agent-<unit>/out`, or the same names under the user's runtime and state folders in a user unit. The core keeps one connection per unit and a health flag per unit, logged as `errands: runner up` or `errands: runner down`.

An agent's prompt is its only limit, and the runner checks nothing per agent. Every run gets the tools of its harness. Codex runs with live web search. Claude Code gets `Read`, `Grep`, `Glob`, `Bash`, `WebFetch` and `WebSearch`, and adds `Edit` and `Write` in the modes `write`, `full` and `sudo`. OpenCode has its whole tool set, with the permissions of the mode, and searches Exa unless the task names another search provider. Every run hands back the files the agent left in its folder. Only the sandbox of the mode and the unit holds a tool back.

Each run has a time limit. Claude receives a model-turn limit. OpenCode and Codex get no step cap and only the timeout bounds them: at the cap OpenCode appends an assistant turn that Gemini and Anthropic refuse, so a capped run died with exit 1 instead of ending. Choose the backend with this distinction in mind.

### The route of an errand

`/subharness status` names a route by its harness: `claude-harness`, `codex-harness` or `opencode-harness`, see [keys](keys.md#model-sources). `keys.json` stores the backend word.

The core decides an errand's path when it dispatches the errand. `src/subharness/control.ts` reads `models.agents` of `config.json` at that moment and puts the backend, model, effort and mode of the agent into the task as `route`, and its `provider` when the owner pinned one. The model of the route is the agent's one model, which `/model set <agent>` writes: the `run` line carries no model of its own, and a route with no model runs on the backend's own default. The runner takes everything from the route and never opens `keys.json`, because the scout and code units hide the persona folder. A route that is malformed fails the task with `bad-route`, and so does a `provider` on a Claude Code or Codex route, on a route with no model, or one that is not a slug of lower case letters, digits and hyphens (64 characters at most). While no backend is connected for the agent the core sends no route, and the runner fails the task with `subharness-off`.

Claude Code and Codex bring their own login, so no key travels with them, and an errand agent searches with its harness's own tools. An OpenCode route spends the named key of `keys.json` that `models.agents.opencodeKey` names in `config.json`. The core puts its value in the task's `secrets.openrouterKey`, and the runner uses it for that run alone. When that key is missing, the errand fails with `route-no-key`. When the core cannot read `config.json` or `keys.json` at dispatch, the errand fails with `keys-unreadable` and nothing is sent.

### The provider of an OpenCode route

`/model set <agent> <model> --via opencode-harness --provider <slug>` pins the agent's OpenCode runs to one OpenRouter provider, for example `amazon-bedrock` or `anthropic`. The slug is stored in `config.json` under `models.agents.provider`, by agent. For a pinned run [src/agent-runner/backend.ts](../src/agent-runner/backend.ts) writes `provider.openrouter.models.<model id>.options.provider` into the run's `OPENCODE_CONFIG` file, with `order` holding that provider alone and `allow_fallbacks` set to `false`. OpenRouter then serves the model at that provider or fails the request, and never moves it to another. The block belongs to the run's model and to no other model, and a run with no pin gets no `provider` block.

OpenCode's own `websearch` tool searches Exa. [src/subharness/run.ts](../src/subharness/run.ts) sets `OPENCODE_ENABLE_EXA=1` in the child's environment for an OpenCode run that searches Exa. When `keys.json` holds an `exa` service key (`/keys service set exa`, see [keys](keys.md)), the core reads it at dispatch for an errand on an OpenCode route and sends it as `secrets.searchKey`, and the runner hands it to that child alone as `EXA_API_KEY`, never on its command line. With no stored key the child gets no `EXA_API_KEY` and searches Exa's free endpoint, which is rate limited. Claude and Codex runs get neither variable.

The one reply that checks the selection goes out through the same provider, so a provider that does not serve the model is refused with `model-rejected` and nothing is saved. A `/model set` for the agent without `--provider` drops the stored pin, because no reply checked it on the new model, and so does a move to Claude Code or Codex. A provider asked of those two backends is refused with `provider-unsupported`, and a slug that is malformed with `bad-provider`. A run that reaches a Claude Code or Codex backend with a provider fails `provider-unsupported` and starts nothing. `/subharness status` shows `provider <slug>` on the row of a pinned agent and nothing on the others.

### The preamble and the system instructions

A run's system instructions are the deployment's preamble first and the agent's prompt after it, joined by a blank line. The prompt text of the run is the task alone, its goal and context. [src/errands/preambles.ts](../src/errands/preambles.ts) builds the preamble from the files of `data/prompts/preambles/` that match the run, `all.md`, `<agent>.md`, `@<model>.md` and `<agent>@<model>.md` in that order. `<model>` is the last path segment of the model of the run's route, lower cased and otherwise taken as it is, so `openrouter/anthropic/claude-sonnet-4.6` and `google/claude-sonnet-4.6` both read `@claude-sonnet-4.6.md` and `scout@claude-sonnet-4.6.md`, and `claude-sonnet-4-6` reads neither. A run whose route names no model reads only `all.md` and `<agent>.md`. Every matching file goes in whole, an empty file is skipped, and the preamble has no length cap. The preamble files load like every prompt file, under the keys `preambles/<name>`, so a preamble is removed by deleting its file. A file emptied while the core runs keeps its last text until the next start. The `errands: sent` log line names the model, the files and the length, never a text.

The system instructions replace the backend's own. Claude Code reads them from the file `--system-prompt-file` names, Codex from `-c model_instructions_file=<path>`, and OpenCode as the `build` agent's `prompt` in the config file `OPENCODE_CONFIG` names (the file that also holds a provider pin). [src/agent-runner/backend.ts](../src/agent-runner/backend.ts) writes each file mode `600` into a folder of the run's own and removes it when the run ends, whether the child succeeded, failed or never started.

### The proxy of an errand

While the [engine proxy](proxy.md) is in force, the core puts it into every errand's `secrets.proxy` in its http form, whatever the agent and its backend. The runner hands it to the child as `HTTPS_PROXY`, `HTTP_PROXY` and their lower case spellings. The value is the one in force when the errand is sent: after a switch to the direct path an errand carries no proxy, and its child gets no proxy variable at all. Secrets that hold the proxy alone are valid, since a Claude Code or Codex route carries no key.

## Modes

Execution modes govern the agents' access: `read`, `write`, `full` and `sudo`. A mode belongs to a unit, and so to its agent: `read` for `server` and `write` for `scout` and `code` until the owner sets another (`models.agents.mode`, by unit). The mode in the route sets the backend's sandbox. The child gets the host's `PATH` in every mode. The unit stops `sudo` in the modes `read`, `write` and `full`, and the mode `sudo` lifts it. The table shows what each mode gives each harness.

| Mode | Claude Code | Codex | OpenCode |
|---|---|---|---|
| `read` | `Read`, `Grep`, `Glob`, `Bash`, `WebFetch` and `WebSearch`, approved with `--allowedTools` | `-s read-only` | `permission` of `"*": "allow"` and `"edit": "deny"` |
| `write` | the same plus `Edit` and `Write` | `-s workspace-write` | `permission` of `"*": "allow"` |
| `full`, `sudo` | the same tools with `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `permission` of `"*": "allow"` |

OpenCode reads its `permission` block from the run's `OPENCODE_CONFIG` file. `"*"` covers every permission, `external_directory` among them, so a path outside the run's folder is read in every mode and written outside `read`. No permission is left on `ask`, because a headless run has nobody to answer and OpenCode ends the session on a refused call. Use `/agent mode <unit> <mode>` to select one. Rerender units with `neptunia setup` and restart the affected unit to apply systemd restrictions. A mode stored in the key store alone does not change an already running service.

The server unit hides every client's token and every interface's `credentials.json` with `InaccessiblePaths=-<path>`, because it runs as the core's user and reads the host. It connects as no client, so it keeps no token. The modes `full` and `sudo` drop these entries with the rest of the mount sandbox. `keys.json` stays readable to it, and a client made after the unit was rendered stays visible until `neptunia setup` renders the unit again. The scout and code units hide the whole persona folder instead.

The agent units bind the folder of every backend a role names or that is installed under `data/subharness/`, writable, so a claude child keeps its config directory there (`CLAUDE_CONFIG_DIR`). The server unit's network also reaches Anthropic's ranges, `160.79.104.0/23` and `2607:6bc0::/48`, next to Cloudflare's.

Native backend sessions belong to `data/subharness/<backend>/`. A task's final answer is only part of its history; keep native sessions for later inspection of the work.

One finished errand opens one result turn. [src/errands/turns.ts](../src/errands/turns.ts) runs one attempt at a time and arms one retry at a time for an errand, whichever of the service's restart, the door's replay of `errand.done` and the retry timer reaches it, and each attempt reads `readAt` from the store first.

An attempt asks the interface of the errand's place for the chat. The owner's command line chat `cli:dm:owner` is asked of the command line, which describes it while no chat is open, so the result turn runs and her answer is kept for the chat ([delivery while no chat is open](cli.md#delivery-while-no-chat-is-open)). A chat the interface cannot describe now is tried again every `errands.resultRetrySeconds` (default `30`), like a turn the attention held back, and after 20 attempts the result is left to her `<errands>` block with the turn marked as never run.

A result text over `errands.resultMaxChars` (default `3000`) goes once to the summarizer, one `analyzer` request with the purpose `summarize`, and `<errand_result>` shows the retelling under `labels.errands.result.retold`. A retelling still over the bound stands whole, and a failed request leaves the result whole. A waited result shown as a retelling is not marked read by the turn.

The result turn is the ordinary turn in the place the errand was asked in, built on the turn frame with the kind `errand_result`. It answers the asking message when that message still exists, and with the message gone it answers nobody and takes `prompts/errand-result.md` as its task. `<inner>` opens with `<errand_result>`, the result, its sources and its files, and `<intentions>` shows an intention that waited for the errand with its outcome. An errand asked with no place, such as one a heartbeat waited for past its budget, one a restart failed during that wait or one the owner started from his console, opens its result turn with no chat: the turn runs nowhere, takes `prompts/errand-result.md`, and holds the chat lane of her attention like every result turn, since she may post from it. At start the core opens again the result turn of every end she has not seen, with a place or without.

The wake of an intention that waited for an errand carries the errand's result as well: when the errand ended and she has not read it, the intention's turn opens `<inner>` with the same `<errand_result>`, and once she answers a request that showed the result whole, the errand is read.

A personal `profile.json` or `prompt.md` under `data/agents/<id>/` is opened without following a link in the same call that reads it, so a link placed after the check fails the run with `no-prompt` or the profile's error.

## Step and output limits

`backendLimits` in [src/agent-runner/backend.ts](../src/agent-runner/backend.ts) says which caps a backend enforces and through what. These are the controls that reach the child process.

| Backend | Steps | Output tokens |
|---|---|---|
| `claude` | `--max-turns` | `CLAUDE_CODE_MAX_OUTPUT_TOKENS` |
| `opencode` | none, the timeout bounds it | `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` |
| `codex` | none, the timeout bounds it | none, the timeout bounds it |

A run that asks a backend for a cap it has no control for carries the gap `step-limit-not-enforced` or `output-limit-not-enforced` and writes one log line. The profile's seconds and the global request caps in `llm.*` apply on every backend, and no dollar budget exists.

A `claude` run prints `--output-format stream-json` with `--verbose`, one message per line, and the engine keeps the last 256 KiB of it. The answer is the text of the assistant messages after the last tool result, joined in order, because a message cut at `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is resumed by `claude` in a new message and the closing `result` line holds only the last one. The run's real usage comes from that `result` line, and a result with `is_error` fails the errand with `backend-error` whatever the exit code. A failed run's `detail` never quotes a stream line.

An `opencode` run prints `--format json`, one event per line. The answer is the text of its `text` events, one per line, and a run whose output holds no event keeps its printed text as the answer. Each `tool_use` event of the `websearch` tool whose `part.state.status` is `error`, such as Exa's rate limit, counts as one failed web search. The backend logs the count as `searchFailures` on the `agent-runner: backend run` line, without the query or the error text, and puts it on the task's `result.searchFailures`. The errand store keeps it, and the result she reads gains the line `labels.errands.result.searchFailed` with `{count}`, on a done errand and a failed one alike. A run with no failed search carries no count and no line.

Each model step of an `opencode` run ends with a `step_finish` event that holds the step's tokens and its `cost` in US dollars, as the provider reported it. The run's usage is the sum over those events. Its input counts the fresh, cache-written and cache-read tokens, its output counts the output and reasoning tokens, its steps count the events, and its dollars are the sum of `cost`. A run with no `step_finish` event has no usage. A `claude` run takes its tokens and steps from its `result` line, a `codex` run gives only the number after `tokens used` as its output, and neither reports dollars, so their errands keep `usd` at 0. The errand store keeps the usage, and the agents' spend adds it up.

## Search from an errand

The scout's search and the core's [quick search](keys.md#quick-search) have separate configuration. Implementation starts in [src/agent-runner/backend.ts](../src/agent-runner/backend.ts) and [agent profiles](../agents/).
