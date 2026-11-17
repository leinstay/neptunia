# agents/

Each agent has its own folder here with a `profile.json` and a prompt when its kind uses one.

| Folder | Kind | What it does |
|---|---|---|
| `scout/` | worker | Internet errands: web searches, reading pages, downloading files through a proxy. |
| `server/` | worker | Read-only questions about this machine: reads files and runs read-only shell commands, with no network but the model API. |

## Kinds

There are two kinds. A **worker** runs as its own systemd service and takes tasks on a Unix socket. A **consultation** has no process: tools call its model role directly (none ships today).

The agent runner (`src/agent-runner/profiles.ts`) loads only workers. It skips consultations.

## profile.json

Worker and consultation profiles carry `id`, `kind`, `role`, `prompt`, `override` and `description`. A worker also carries `tools`, `shell`, `enabled`, `cost` (`{ input, output }`, USD per million tokens), `limits` (`{ steps, seconds }`), `daily` (`{ tasks }`), `searchProvider`, `socket`, `out` and `env`.

A worker may also carry `search` (`true` enables live web search) and `sandbox` (`read-only` or `workspace-write`, the default). Profiles reject `backend` and `model`. An agent runs on the backend, model and effort of its route, which `/model set <agent>` writes, see [docs/errands.md](../docs/errands.md#the-route-of-an-errand). `role` is a slug of lower case letters, digits and dashes that a personal profile may restate and never change, and no code reads its value.

A deployment overrides `enabled`, `cost`, `socket`, `out`, `limits`, `daily` and `searchProvider` of a worker under `agents.<name>` in `config.local/config.json`. `agentSettings(name, config)` in `src/agent-runner/profiles.ts` lays that override over the profile, and every reader of these settings goes through it.

A profile only describes a request. It never authorizes anything: shell classes, permission ceilings and all deny rules are defined in code (`src/agent-runner/profiles.ts`, `src/agent-runner/policy.ts`). A profile can only narrow what the code allows.

A profile with a missing key, an unknown key, a tool its shell class does not allow, or a shell class the runner does not know stops the process at start.

## Persona overrides

`listAgents`, `loadProfiles`, `profileOf` and `agentSettings` in `src/agent-runner/profiles.ts` accept `AgentPaths` with `rootDir`, `dataDir` and `env`. Shared definitions live under `<rootDir>/agents/<name>/profile.json`. A partial personal profile under `<dataDir>/agents/<name>/profile.json` overlays that definition. Nested objects merge by own keys, arrays and scalar values replace their defaults, and null remains explicit. The loader validates the shared definition before applying the overlay, then validates and freezes the merged definition. A personal profile cannot change `id`, `kind` or `role` or introduce a new agent. A folder under `<dataDir>/agents/` that names no shared agent is refused alone: the loaders skip it, `refusedAgents` lists it with the code `no-shared-definition`, `errands.start` logs one `error` line with the folder and the code, and `neptunia doctor` warns in its `agents` check. A symbolic link there still fails the load.

Each public call reads current files. `agentSettings` applies live `config.agents.<name>` after the file overlay and retains user-unit socket and output defaults. `PROFILES`, `SCOUT` and `SERVER` are shared snapshots for compatibility. Errand consumers use the path-aware functions with the core or command entry roots. The runner refreshes its definition, prompt and default limits for each task.

`promptFilesOf` returns `<dataDir>/agents/<name>/<prompt>` before `<rootDir>/agents/<name>/<prompt>`, with `prompt.md` as the default filename. A personal prompt needs no personal profile. The profile's `override` field remains validated migration metadata and contributes no runtime path. Explicit `dataDir` wins over `NEPTUNIA_DATA_DIR`; relative data paths resolve against `rootDir`. The private directory does not select the agent tree. Personal directories, profile files and selected prompts reject symbolic links.

## Further reading

- Workers: [docs/errands.md](../docs/errands.md)
