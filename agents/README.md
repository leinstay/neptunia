# agents/

An agent is its folder: a `profile.json` and a prompt. This document is for whoever changes an agent, here or in a deployment's `data/agents/`.

There are three agents, and the persona reaches each with a tool of its own.

| Folder | Tool | What it does |
|---|---|---|
| `server/` | `errand.server` | Searches, checks and reads everything on the machine the engine is installed on, and changes nothing. |
| `scout/` | `errand.scout` | Surfs the web in depth, downloads pages and any files, and searches for any information. |
| `code/` | `errand.code` | Writes code of any kind and returns it in files. |

## profile.json

A profile holds these keys and no other.

| Key | Values |
|---|---|
| `id` | the folder's name |
| `description` | what the agent is for and what it is not for, shown by `/agents` |
| `prompt` | the file name of the prompt in the same folder |
| `limits` | `{ steps, seconds }` of one errand |
| `daily` | `{ tasks }`, the errands a day |
| `cost` | `{ input, output }`, USD per million tokens |

A profile with a missing key, an unknown key or a value of the wrong form stops the process at start, with one error naming the agent and the key. A profile names no harness and no model. An agent runs on the backend, model and effort of its route, which `/model set <agent>` writes, see [docs/errands.md](../docs/errands.md#the-route-of-an-errand).

The prompt is the agent's only limit: every run gets the tools of its harness and hands back the files it left, as [docs/errands.md](../docs/errands.md#units-and-tools) lists.

## The units

Each agent runs in the systemd unit of its name, and `neptunia setup` installs the three.

`neptunia-agent-server.service` runs `neptunia errand-runner --unit server`. It reads this machine on a read-only filesystem, reaches only the model APIs, and hides every client token and interface credential. `neptunia-agent-scout.service` and `neptunia-agent-code.service` run the runners of `scout` and `code`. They reach the public internet and nothing of the local network, write only their out folder and the backends' folders, and see no part of the persona's data folder but `agents/`. The sandboxes are in the templates under [deploy/](../deploy/README.md).

A runner works one errand at a time. `/agent mode <agent> <mode>` sets the mode of an agent's unit.

## Tracked and local agents

The folders here are tracked. A deployment's agents live in `<data>/agents/<name>/`. A local folder with the name of a tracked agent overlays its profile key by key: nested objects merge by their own keys, arrays and scalars replace, and `id` cannot change. A local prompt of that name is read before the tracked one, and needs no local profile. A local folder with any other name is no agent. Symbolic links under `<data>/agents/` are refused. Every call reads the files as they are now, so a runner picks up a changed prompt or limit at its next errand.

The owner hands an agent an errand himself with `/errands add <agent> <goal>`.

An agent is off until `/agent enable <name>` writes `agents.<name>.enabled` as `true` in the local config, and `/agent disable <name>` switches it off again. `agents.<name>` also overrides `cost`, `limits` and `daily`. `/agents` lists every agent with its description, unit, route, state and whether a local folder overlays it (`local`) or not (`tracked`).

## Further reading

- Errands, units and modes: [docs/errands.md](../docs/errands.md)
