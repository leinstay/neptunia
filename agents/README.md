# agents/

Each agent has its own folder here with a `profile.json` and, for workers and development agents, a `prompt.md`.

| Folder | Kind | What it does |
|---|---|---|
| `scout/` | worker | Internet errands: web searches, reading pages, downloading files through a proxy. |
| `server/` | worker | Read-only questions about this machine: reads files and runs read-only shell commands, with no network but the model API. |
| `thinker/` | development | Picks up development tasks, writes briefs, reviews the work (text included), runs the tests and merges. Never deploys. |
| `dev/` | development | Writes code and text (prompts, documentation) within one development task. |

## Kinds

There are four kinds. A **worker** runs as its own systemd service and takes tasks on a Unix socket. A **development** agent works on the code: the engine only describes it, and a dispatcher or coding assistant outside the engine runs it. A **consultation** has no process: tools call its model role directly (none ships today). A **watcher** describes a report agent under subharness policy, without a worker model role or permissions.

The agent runner (`src/agent-runner/profiles.ts`) loads only workers. It skips consultations, development agents and watchers.

## profile.json

Worker, development and consultation profiles carry `id`, `kind`, `role`, `prompt`, `override` and `description`. A watcher omits `role`. The extra keys depend on the kind:

- **Worker:** `tools`, `shell`, `enabled`, `cost` (`{ input, output }`, USD per million tokens), `limits` (`{ steps, seconds }`), `daily` (`{ tasks }`), `searchProvider`, `socket`, `out`, `env`.
- **Development:** `tools`, `permission`, `effort`, `limits` (`{ steps, minutes }`), `cost` (`{ input, output }`).

A worker may also carry `search` (`true` enables live web search) and `sandbox` (`read-only` or `workspace-write`, the default). Profiles reject `backend` and `model`. Backend, model and effort selections remain under the subharness contract in [docs/errands.md](../docs/errands.md#backends).

A deployment overrides `enabled`, `cost`, `socket`, `out`, `limits`, `daily` and `searchProvider` of a worker, and `cost` and `limits` of a development agent, under `agents.<name>` in `config.local/config.json`. `agentSettings(name, config)` in `src/agent-runner/profiles.ts` lays that override over the profile, and every reader of these settings goes through it. A development profile refuses `enabled`.

A profile only describes a request. It never authorizes anything: shell classes, permission ceilings and all deny rules are defined in code (`src/agent-runner/profiles.ts`, `src/agent-runner/policy.ts`). A profile can only narrow what the code allows.

A profile with a missing key, an unknown key, a tool its shell class does not allow, or a shell class the runner does not know stops the process at start.

## Persona overrides

`listAgents`, `loadProfiles`, `profileOf` and `agentSettings` in `src/agent-runner/profiles.ts` accept `AgentPaths` with `rootDir`, `dataDir` and `env`. Shared definitions live under `<rootDir>/agents/<name>/profile.json`. A partial personal profile under `<dataDir>/agents/<name>/profile.json` overlays that definition. Nested objects merge by own keys, arrays and scalar values replace their defaults, and null remains explicit. The loader validates the shared definition before applying the overlay, then validates and freezes the merged definition. A personal profile cannot change `id`, `kind` or `role` or introduce a new agent.

Each public call reads current files. `agentSettings` applies live `config.agents.<name>` after the file overlay and retains user-unit socket and output defaults. `PROFILES`, `SCOUT` and `SERVER` are shared snapshots for compatibility. Consumers of personal settings use the path-aware functions.

`promptFilesOf` returns `<dataDir>/agents/<name>/<prompt>` before `<rootDir>/agents/<name>/<prompt>`, with `prompt.md` as the default filename. A personal prompt needs no personal profile. The profile's `override` field remains validated migration metadata and contributes no runtime path. Explicit `dataDir` wins over `NEPTUNIA_DATA_DIR`; relative data paths resolve against `rootDir`. The private directory does not select the agent tree. Personal directories, profile files and selected prompts reject symbolic links.

The loader also validates watcher definitions with exactly `id`, `kind`, `prompt`, `override` and `description`. Their id is `watcher`, their override is null, and they have no model role or worker permissions. Worker selection excludes watcher, development and consultation definitions. Watcher execution uses the subharness policy.

## Further reading

- Workers: [docs/errands.md](../docs/errands.md)
- Development agents: [docs/development-agents.md](../docs/development-agents.md)
