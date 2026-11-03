# Development agents

Two agents work on the engine's code and text: `thinker` and `dev`. This document is for whoever runs them and whoever changes their definitions. The engine describes each with a profile and a generic prompt. It starts one of them itself, `dev`, in the selfimprovement beat ([Self-development](selfimprovement.md)), and it never starts `thinker`. Any other run of either agent belongs to a dispatcher or a coding assistant outside the engine.

| Agent | What it does |
|---|---|
| `thinker` | Picks up development tasks, writes the brief for each, hands it to `dev`, reviews what comes back (code and text), runs the tests and merges. Never deploys. |
| `dev` | Writes code and text (prompts, documentation, skills) within one development task. |

## The `agents/<name>/` folder

Each agent has a folder under `agents/` with two files.

- `profile.json` describes the agent. It never authorizes anything. Permissions and security stay in the code.
- `prompt.md` is a generic, public system prompt.

Both agents follow the [style guide](../STYLEGUIDE.md) when they write code. `listAgents` in `src/agent-runner/profiles.ts` validates every profile at load: a missing key, an unknown key, a tool outside the allowed list or an effort outside `low`, `medium`, `high` and `max` stops the load with one line naming the agent and the key.

### Personal overrides

A persona changes an agent under `data/agents/<name>/` (`NEPTUNIA_DATA_DIR`, default `data/`). A partial `profile.json` there is laid over the shared one: nested objects merge key by key, arrays and scalars replace the shared value, and `null` stays explicit. The shared definition is validated before the overlay, and the merged one after it. A personal profile cannot change `id`, `kind` or `role` or add an agent. A personal `prompt.md` replaces the shared prompt, and it needs no personal profile. `promptFilesOf` returns the personal file before the shared one, and `readPromptFile` (`src/agent-runner/opencode.ts`) reads the first one that exists. A personal file this user may not read (`EACCES`, `EPERM`) counts as absent with one warning, and an empty file is an error. Symbolic links in the personal tree are refused. Each call reads the files again, so an edit applies at the next run.

### Profile fields

| Key | What it holds |
|---|---|
| `id` | The folder name, for example `dev`. |
| `kind` | `development`. |
| `role` | The model role whose model sits under `models.development` (`thinker` or `dev`). |
| `prompt` | The prompt file inside the folder, `prompt.md`. |
| `override` | Migration metadata, `null` in the shipped development profiles. It contributes no runtime path. |
| `description` | One sentence saying what the agent does. |
| `tools` | The OpenCode tools the agent asks for, from a fixed list: `bash`, `read`, `grep`, `glob`, `list`, `edit`, `write`, `patch`, `webfetch`, `websearch`, `todowrite`, `skill`, `external_directory`. Never `task` (subagents) or `question` (a headless run cannot answer it). |
| `permission` | Rules that narrow `tools`: a tool mapped to `allow`, `ask` or `deny`, or to an object of command patterns and actions (OpenCode wildcards `*` and `?`, the last matching pattern wins). Only tools from `tools` may appear. |
| `effort` | The reasoning effort, OpenCode's `--variant`: `low`, `medium`, `high` or `max`. |
| `limits` | The default caps `{ steps, minutes }` per run. |
| `cost` | The price `{ input, output }` in USD per million tokens. |

The shipped profiles use `permission` on `bash` to refuse a whole-suite test run. `*node --test*`, `*npm test*` and `*npm run test*` are denied, `*node --test --test-reporter=dot* tests/*.test.*` is allowed, and only the thinker may also run the whole suite, with the prefix `FULL_SUITE=1`.

### Shipped profiles

| Agent | Effort | Default steps | Default minutes | Tools |
|---|---|---|---|---|
| `thinker` | `high` | 400 | 60 | `bash`, `read`, `grep`, `glob`, `list`, `edit`, `write`, `patch`, `webfetch`, `todowrite`, `skill`, `external_directory` |
| `dev` | `medium` | 300 | 60 | `bash`, `read`, `grep`, `glob`, `list`, `edit`, `write`, `patch`, `webfetch`, `todowrite`, `skill` |

A `skill` task, filed by her `board.propose` with `kind` `skill`, asks `dev` for a skill: a `SKILL.md`, and for an executable skill a `setup.json` and a `scripts/` folder ([Skills](skills.md)). The core reads skills from `data/skills/<name>/`. The file waits there as a pending version until the owner runs `/skills activate <name>`.

## Models

Each agent's model sits under `models.development.<name>` in the settings:

```json
"models": {
  "development": {
    "thinker": "openrouter/anthropic/claude-opus-5.5",
    "dev": "openrouter/anthropic/claude-sonnet-5.5"
  }
}
```

These are OpenCode model ids (`openrouter/<vendor>/<model>`), not the bare OpenRouter ids of the base roles. A deployment overrides them in `data/config/config.json`. The status card (`/status full`) shows them under `models.development` and the spend under `costs.development`. The spend comes from the task board's attempts and agent runs, not from the engine's own accounting. The engine makes no request on a development role itself.

The run of `dev` that the selfimprovement beat starts reads its own settings from `keys.json`: the backend `subharness.uses.dev`, else the first connected one, the model `subharness.models.dev`, the effort `subharness.efforts.dev` and the mode (`read`, `write`, `full` or `sudo`) that `subharness mode dev` stored. The owner sets them with the `/subharness` commands ([Errands](errands.md#the-subharness)). The profile's `tools`, `permission`, `effort` and `limits` and the `models.development` ids are not read by that run.

## Backends

A run goes through one of three backends, each installed in `data/subharness/<backend>/` with its own home and login: `codex` (`codex exec`), `claude` (`claude -p`) and `opencode`. `neptunia setup subharness <backend>` installs one. The installed version is pinned. A first install takes the version the engine ships (`PINNED_VERSIONS` in `src/subharness/install.ts`), and `version.json` beside the binary records what is installed with its integrity. A persona restored onto another machine reinstalls the version it recorded, whatever the engine ships. The backends' own updaters are switched off. Only the owner's command changes a version, and it leaves the backend's `home/` alone:

```text
neptunia setup subharness <backend> --version <version>
neptunia setup subharness <backend> --rollback
```

`--version` keeps the install it replaces in `previous/` for one `--rollback`, and a failed install puts the old one back.

## The two outside run paths

Running the development agents beyond the beat takes infrastructure the engine does not hold. Two paths use the same profile, model and prompt.

**An API agent runner.** A dispatcher outside the engine reads the agent folders through `listAgents`, builds an OpenCode config from the profile (the prompt, the step cap, the model of `models.development.<name>` and its cost) and runs one OpenCode session per task attempt. It adds the deployment's own rules to the prompt and sets the shell permissions by its own policy. `loadProfiles` (the worker reader) skips development agents.

**A local coding assistant.** The same agents run as subagents of a coding assistant such as Claude Code. The assistant builds its agent definition from the same folder: the prompt, the tools, the effort and the model. The deployment adds its own addendum and points the assistant at the model of `models.development.<name>`.

In both paths the profile's `tools` list names what the agent asks for, the dispatcher or assistant decides what to grant, and the profile authorizes nothing.

## The task board

The development agents' tasks, briefs, reviews, attempts and results live on the task board in `memory.db`, beside her errands. A dispatcher or an orchestrator outside the engine reaches it with `neptunia task` over the core's socket, under a client token whose `boardRoles` decide what it may do. The status card reads the thinker's runs and the dev attempts from the board, and without a board both agents show with no runs. See [The task board](board.md).

## Settings

The price and the limits of a development agent live in its profile. A deployment overrides them under `agents.<name>` in its settings. `agentSettings(name, config, paths)` in `src/agent-runner/profiles.ts` reads the shared and personal profiles and then applies the live settings, and a development profile accepts only `cost` and `limits`. `paths` supplies the engine and data roots. The selfimprovement runner reads its separate task brief from the hot prompt `selfimprovement` ([Prompt contract](prompt-contract.md)).

| Key | Default (thinker, dev) | What it does |
|---|---|---|
| `agents.<name>.cost` | `{ input: 4, output: 20 }`, `{ input: 2, output: 10 }` | USD per million tokens, for OpenCode's cost estimate. |
| `agents.<name>.limits.steps` | 400, 300 | Maximum model steps per run. |
| `agents.<name>.limits.minutes` | 60, 60 | Maximum wall-clock minutes per run. |
| `models.development.<name>` | `openrouter/anthropic/claude-opus-5.5`, `openrouter/anthropic/claude-sonnet-5.5` | The OpenCode model id the status card shows. |
