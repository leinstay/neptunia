# agents/

An agent is its folder: a `profile.json` and a prompt. This document is for whoever adds or changes an agent, here or in a deployment's `data/agents/`.

| Folder | Unit | What it does |
|---|---|---|
| `fetch/` | `web` | Finds media on the web, such as pictures, video, audio or any other file, and brings the files back. |
| `scout/` | `web` | A deep search for information: finds sources, checks one against another and reports with links. Downloads nothing. |
| `code/` | `web` | Writes code on request and returns the files. |
| `server/` | `host` | Answers the owner's questions about this machine by reading files and running read-only commands. |

## profile.json

A profile holds these keys and no other.

| Key | Values |
|---|---|
| `id` | the folder's name |
| `description` | what the agent is for and what it is not for, shown by `/agents` and read by the dispatcher when it picks the agent of an errand |
| `unit` | `web` or `host`, the unit whose runner runs the agent |
| `prompt` | the file name of the prompt in the same folder |
| `limits` | `{ steps, seconds }` of one errand |
| `daily` | `{ tasks }`, the errands a day |
| `cost` | `{ input, output }`, USD per million tokens |

A profile with a missing key, an unknown key or a value of the wrong form stops the process at start, with one error naming the agent and the key. A profile names no harness and no model. An agent runs on the backend, model and effort of its route, which `/model set <agent>` writes, see [docs/errands.md](../docs/errands.md#the-route-of-an-errand).

The prompt is the agent's only limit: every run gets the tools of its harness and hands back the files it left, as [docs/errands.md](../docs/errands.md#units-and-tools) lists.

## The two units

Two systemd units carry every agent, and a profile names its unit in `unit`. `neptunia setup` installs both.

`neptunia-agent-web.service` runs `neptunia errand-runner --unit web`. It reaches the public internet and nothing of the local network, writes only its out folder and the backends' folders, and sees no part of the persona's data folder but `agents/`. `neptunia-agent-host.service` runs `neptunia errand-runner --unit host`. It reads this machine on a read-only filesystem, reaches only the model APIs, and hides every client token and interface credential. The sandboxes are in the templates under [deploy/](../deploy/README.md).

A runner serves every agent of its unit and works one errand per agent at a time. The mode of a unit, `/agent mode <unit> <mode>`, is the mode of every agent in it.

## Tracked and local agents

The folders here are tracked. A deployment's agents live in `<data>/agents/<name>/`. A local folder with the name of a tracked agent overlays its profile key by key: nested objects merge by their own keys, arrays and scalars replace, and `id` cannot change. A local prompt of that name is read before the tracked one, and needs no local profile. A local folder with any other name is an agent of its own when it holds a whole profile and its prompt, and a folder with no profile is no agent. Symbolic links under `<data>/agents/` are refused. Every call reads the files as they are now, so a runner picks up a changed prompt or limit at its next errand.

The dispatcher picks the agent of every errand she asks for from the agents that are enabled and free now, see [docs/errands.md](../docs/errands.md#the-dispatcher). The owner names one himself with `/errands add <agent> <goal>`.

An agent is off until `/agent enable <name>` writes `agents.<name>.enabled` as `true` in the local config, and `/agent disable <name>` switches it off again. `agents.<name>` also overrides `cost`, `limits` and `daily`. `/agents` lists every agent with its description, unit, route, state and whether it is tracked or local.

## Further reading

- Errands, units and modes: [docs/errands.md](../docs/errands.md)
