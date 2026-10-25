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
| `effort` | The reasoning effort, OpenCode's `--variant` (`low`, `medium`, `high`, `max`). |
| `limits` | Default per-run caps `{ steps, minutes }`, overridden by `agents.<id>.limits` in config. |

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

The `/nep status` card shows development models in `models.development` and their spend in `costs.development`. The spend comes from the ledger (see below), not from the engine's own accounting.

## The two run paths

The engine only describes the development agents. Running them takes external infrastructure. Two run paths use the same profile, model and prompt:

### API agent runner

A dispatcher outside the engine reads the agent folders through `listAgents` (`src/agent-runner/profiles.js`), builds an OpenCode config from the profile (the prompt, the step cap, the model of `models.development.<name>` and its cost), and runs one OpenCode session per task attempt. The dispatcher adds the deployment's own rules to the prompt and sets the shell permissions by its own policy. `loadProfiles` (the worker reader) skips development agents.

### Local coding assistant

The same agents can run as subagents of a local coding assistant (Claude Code, for example). The assistant builds its agent definition from the same folder: the prompt, the tools, the effort and the model. The deployment adds its own addendum and points the assistant to the model of `models.development.<name>`.

In both paths, the profile's `tools` list names what the agent asks for. The dispatcher or assistant decides what to grant. The profile never authorizes anything.

## The task ledger

The engine does not ship a task ledger or dispatcher. When one is running outside the engine, the development agents' tasks, briefs, reviews, attempts and results live there. The engine mirrors its own errands into the ledger (`agents.ledger.socket`) so both kinds of tasks are visible in one place. While `agents.ledger.socket` is `null` (the default), nothing connects and no development task tracking happens.

The `/nep status` card reads the development agents' spend from the ledger. Without a ledger, those agents show with no runs.

## Config

Development agent settings live under `agents.<name>` in `config.json`:

| Key | Default (thinker / dev) | What it does |
|---|---|---|
| `agents.<name>.cost` | `{ input: 4, output: 20 }` / `{ input: 2, output: 10 }` | USD per million tokens, for OpenCode's cost estimate. |
| `agents.<name>.limits.steps` | 400 / 300 | Maximum model steps per run. |
| `agents.<name>.limits.minutes` | 60 / 60 | Maximum wall-clock minutes per run. |
| `agents.<name>.contextLimit` | 350000 (thinker only) | Soft context-window limit in tokens. Read by the external dispatcher, not by the engine. |
| `agents.<name>.contextHard` | 400000 (thinker only) | Hard context-window limit. Read by the external dispatcher, not by the engine. |
