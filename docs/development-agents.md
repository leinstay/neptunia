# Development agents

Two agents work on the engine's code and text. They are not part of the persona: the engine describes them (a profile and a generic prompt each), but it never starts them.

| Agent | What it does |
|---|---|
| `thinker` | Picks up development tasks, writes the brief for each, hands it to `dev`, reviews what comes back (code and text), runs the tests and merges. Never deploys. |
| `dev` | Writes code and text (prompts, documentation) within one development task. |

## The `agents/<name>/` folder

Each agent has its own folder under `agents/` with two files:

- **`profile.json`** describes the agent. It never authorizes anything; permissions and security stay in the code.
- **`prompt.md`** is a generic, public system prompt. A deployment adds its own rules where it runs the agents (see [Run paths](#the-two-run-paths) below).

Both agents follow the [style guide](../STYLEGUIDE.md) when they write code.

### Profile fields (development kind)

| Key | What it holds |
|---|---|
| `id` | The folder name (e.g. `dev`). |
| `kind` | Always `development`. |
| `role` | The model role whose model sits under `models.development` (`thinker`, `dev`). |
| `prompt` | The prompt file inside the folder (`prompt.md`). |
| `override` | `null` for development agents: the deployment's rules come from its dispatcher, not from `prompts.local/`. |
| `description` | One sentence saying what the agent does. |
| `tools` | The OpenCode tools the agent asks for, from a fixed list: `bash`, `read`, `grep`, `glob`, `list`, `edit`, `write`, `patch`, `webfetch`, `websearch`, `todowrite`, `skill`, `external_directory`. Never `task` (subagents) or `question` (a headless run cannot answer it). |
| `permission` | Rules that narrow the tools above: a tool mapped to `allow`, `ask` or `deny`, or to an object of command patterns and actions (OpenCode wildcards `*` and `?`, the last matching pattern wins). Only tools from `tools` may appear. The shipped profiles use it on `bash` to refuse a whole-suite test run: `node --test` without a test file and `npm test` are denied, `node --test --test-reporter=dot tests/<module>.test.js` is allowed, and the thinker alone may run the whole suite with the prefix `FULL_SUITE=1`. |
| `effort` | The reasoning effort, OpenCode's `--variant` (`low`, `medium`, `high`, `max`). |
| `limits` | Default per-run caps `{ steps, minutes }`, overridden by `agents.<id>.limits` in config. |
| `cost` | Price `{ input, output }` in USD per million tokens, overridden by `agents.<id>.cost` in config. |

### Shipped profiles

| Agent | Effort | Default steps | Default minutes | Tools |
|---|---|---|---|---|
| `thinker` | `high` | 400 | 60 | `bash`, `read`, `grep`, `glob`, `list`, `edit`, `write`, `patch`, `webfetch`, `todowrite`, `skill`, `external_directory` |
| `dev` | `medium` | 300 | 60 | `bash`, `read`, `grep`, `glob`, `list`, `edit`, `write`, `patch`, `webfetch`, `todowrite`, `skill` |

## Models

Each agent's model sits under `models.development.<name>` in config:

```json
"models": {
  "development": {
    "thinker": "openrouter/anthropic/claude-opus-5.5",
    "dev": "openrouter/anthropic/claude-sonnet-5.5"
  }
}
```

These are OpenCode model ids (`openrouter/<vendor>/<model>`), not the bare OpenRouter ids the bot's own roles use. A deployment overrides them in `config.local.json` (or with `/nep model set`). The engine never makes a request on a development role itself.

The `/nep status` card shows development models in `models.development` and their spend in `costs.development`. The spend comes from the task board's attempts and agent runs (see below), not from the engine's own accounting.

## The two run paths

The engine only describes the development agents. Running them takes external infrastructure. Two run paths use the same profile, model and prompt:

### API agent runner

A dispatcher outside the engine reads the agent folders through `listAgents` (`src/agent-runner/profiles.js`), builds an OpenCode config from the profile (the prompt, the step cap, the model of `models.development.<name>` and its cost), and runs one OpenCode session per task attempt. The dispatcher adds the deployment's own rules to the prompt and sets the shell permissions by its own policy. `loadProfiles` (the worker reader) skips development agents.

### Local coding assistant

The same agents can run as subagents of a local coding assistant (Claude Code, for example). The assistant builds its agent definition from the same folder: the prompt, the tools, the effort and the model. The deployment adds its own addendum and points the assistant to the model of `models.development.<name>`.

In both paths, the profile's `tools` list names what the agent asks for. The dispatcher or assistant decides what to grant. The profile never authorizes anything.

## The task board

The development agents' tasks, briefs, reviews, attempts and results live on the task board in `memory.db`, beside her errands. A dispatcher or an orchestrator outside the engine reaches it with `neptunia task` over the core's socket, under a client token whose `boardRoles` decide what it may do. The `/nep status` card reads the thinker's runs and the dev attempts from the board, and without a board both agents show with no runs. See [The task board](board.md).

## Config

The price and the limits of a development agent live in its profile, and a deployment overrides them under `agents.<name>` in `config.local.json`. `agentSettings(name, config)` in `src/agent-runner/profiles.js` lays the override over the profile.

| Key | Default (thinker / dev) | What it does |
|---|---|---|
| `cost` | `{ input: 4, output: 20 }` / `{ input: 2, output: 10 }` | USD per million tokens, for OpenCode's cost estimate. |
| `limits.steps` | 400 / 300 | Maximum model steps per run. |
| `limits.minutes` | 60 / 60 | Maximum wall-clock minutes per run. |
