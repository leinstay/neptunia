# agents/

Each agent has its own folder here with a `profile.json` and, for workers and development agents, a `prompt.md`.

| Folder | Kind | What it does |
|---|---|---|
| `scout/` | worker | Internet errands: web searches, reading pages, downloading files through a proxy. |
| `server/` | worker | Read-only questions about this machine: reads files and runs read-only shell commands, with no network but the model API. |
| `thinker/` | development | Picks up development tasks, writes briefs, reviews the work (text included), runs the tests and merges. Never deploys. |
| `dev/` | development | Writes code and text (prompts, documentation) within one development task. |

## Kinds

There are three kinds. A **worker** runs as its own systemd service and takes tasks on a Unix socket. A **development** agent works on the code: the engine only describes it, and a dispatcher or coding assistant outside the engine runs it. A **consultation** has no process: tools call its model role directly (none ships today).

The agent runner (`src/agent-runner/profiles.js`) loads only workers. It skips consultations and development agents.

## profile.json

Every profile carries `id`, `kind`, `role`, `prompt`, `override` and `description`. The extra keys depend on the kind:

- **Worker:** `tools`, `shell`, `enabled`, `cost` (`{ input, output }`, USD per million tokens), `limits` (`{ steps, seconds }`), `daily` (`{ tasks }`), `searchProvider`, `socket`, `out`, `env`.
- **Development:** `tools`, `permission`, `effort`, `limits` (`{ steps, minutes }`), `cost` (`{ input, output }`).

A deployment overrides `enabled`, `cost`, `socket`, `out`, `limits`, `daily` and `searchProvider` of a worker, and `cost` and `limits` of a development agent, under `agents.<name>` in `config.local/config.json`. `agentSettings(name, config)` in `src/agent-runner/profiles.js` lays that override over the profile, and every reader of these settings goes through it. A development profile refuses `enabled`.

A profile only describes a request. It never authorizes anything: shell classes, permission ceilings and all deny rules are defined in code (`src/agent-runner/profiles.js`, `src/agent-runner/policy.js`). A profile can only narrow what the code allows.

A profile with a missing key, an unknown key, a tool its shell class does not allow, or a shell class the runner does not know stops the process at start.

## Prompt overrides

A deployment can replace a worker's prompt with its own file under `prompts.local/` (the name in the profile's `override` field, e.g. `prompts.local/agent-scout.md`). The private file wins when it exists. Development agents have no override: their deployment adds its rules where it runs the agents.

## Further reading

- Workers: [docs/errands.md](../docs/errands.md)
- Development agents: [docs/development-agents.md](../docs/development-agents.md)
