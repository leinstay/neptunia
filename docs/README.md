# Documentation

Neptunia is a persona engine. One instance plays one persona through a language model on a chat platform, with its own memory, inner life and tools. The engine is character-neutral: who the persona is lives in the persona folder `data/`, which no pull request carries. This index says how the parts fit and lists the documents of `docs/`, one topic each.

## How the parts fit

The core is one process, `src/index.ts`, which calls `startCore` (`src/core.ts`). It owns the memory database `data/memory.db`, the model client, the turns, the inner life and the task board, and it listens on the Unix socket `data/run/core.sock`. Everything else is a client of that socket and shows a token from `data/clients.json`.

| Client | Kind | What it does |
|---|---|---|
| An interface, run as `neptunia interface run <name>` or loaded inside the core (`interfaces.mode`) | `interface` | Translates a chat platform into the engine's protocol of events and actions and back. Discord is the shipped one. |
| The `neptunia` chat and `neptunia -p` | `cli` | The owner's conversation and commands, run with the owner's rights. |
| `neptunia task`, the watcher and the selfimprovement beat | `agent` | The task board's commands. |

A message arrives from an interface as an event. The event door (`src/interface/door.ts`) validates it and drops a repeated id. The pipeline (`src/pipeline/`) decides whether she answers and gathers the context. A turn (`src/turn/`) builds one request from the prompt files, the memory and the transcript and calls the model. It runs the tools the model calls and acts on its output tags, and the actions travel back over the link to the interface.

The inner life (`src/behavior/inner.ts`) sends wake events through the same door on a timer, so a wake runs the same turn without an incoming message. An errand she hands off with `errand.run` runs in an agent process (`neptunia errand-runner --profile <name>`), and its result comes back as a turn of hers. The watcher and the selfimprovement beat run from timers as `neptunia watcher run` and `neptunia selfimprovement run`.

The engine's own files are tracked: `config/` holds the default settings, labels and tool texts, `prompts/` the prompt files, and `agents/` the profile and prompt of each agent. The persona folder holds what makes one deployment: its settings and prompts over those defaults, its keys, memory, skills, interface settings and agent backends. `neptunia setup` writes the units that run the processes.

## Documents

| Document | What it covers |
|---|---|
| [Getting started](getting-started.md) | Requirements, install, the persona folder, settings and prompts, the order of a first run, daily use, tests and the fault run |
| [Setup](setup.md) | `neptunia setup`: the setup contract of a module, the eleven steps, the user and system scopes, the units' environment files, pinned subharness backends |
| [The neptunia command](cli.md) | Every form of `neptunia`, the interactive and the plain chat, the commands of the chat, access, health, pause, `doctor` and the task board's command line |
| [Keys](keys.md) | `keys.json`, core and extra keys, service keys, the failover ring, the `/keys` and `/model set` commands and the import of old keys |
| [Persona file migration](persona-migration.md) | The offline conversion of a legacy private layer into `data/`, with its conflict checks and held material |
| [The core](core.md) | The composition root, the event door, a turn step by step, the tool loop, prompt assembly and cache layout, model roles and safety rails |
| [Memory](memory.md) | Concepts, data model, write and read paths, the memory session, recall, scopes and configuration |
| [Inner life](inner-life.md) | Heartbeat, daily review, the selfimprovement wake, intentions, inner turns, caps, the kill switch and the virtual-week harness |
| [Errands](errands.md) | `errand.run`, the errand agents, the runner, the subharness and results returning as a turn |
| [The task board](board.md) | What the board holds, its roles, how the agents reach it, its costs, the restore and the ledger import |
| [Diary](diary.md) | The diary feature: schedule, entries and mirrors |
| [Media](media.md) | Pictures, video, drawing, voice messages, GIFs, custom emoji, web and server search |
| [Interfaces](interfaces.md) | The interface port and protocol, the Discord adapter and how to add an interface |
| [Skills](skills.md) | The `SKILL.md` skills: where they live, versions and activation, the index in her prompt, use counts and the commands |
| [Prompt contract](prompt-contract.md) | The contract between prompt files and code: files, placeholders, labels and output tags |
| [Development agents](development-agents.md) | The dev and thinker agents, their profiles and the two run paths |
| [Self-development](selfimprovement.md) | How her fix proposals become pull requests: the steps, the worktree, the tests, `selfimprovement.mode` and how a merge reaches her wake |
| [The watcher](watcher.md) | The daily watcher: a run, the folder, the report and its checks, the tasks it files, `watcher.read` and `/report` |
| [Configuration](configuration.md) | Every key of `config/config.json`, generated from the settings schema |
| [Repository structure](structure.md) | The generated table of every folder and file pattern of the tracked tree: purpose, layer, what it may import and whether its modules need a test |

## Beside the documents

| File | What it covers |
|---|---|
| [`../README.md`](../README.md) | The project for people who find the repository |
| [`../AGENTS.md`](../AGENTS.md) | Where things are and what never to do, for the coding agents |
| [`../STYLEGUIDE.md`](../STYLEGUIDE.md) | How code is written |
| [`../WRITING.md`](../WRITING.md) | How prose is written: the habits of model text, the rules per kind of text and the accepted examples |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | The workflow of a change and a pull request |
| [`../deploy/README.md`](../deploy/README.md) | How a unit template becomes a unit and what each unit runs |
| [`../scripts/README.md`](../scripts/README.md) | The scripts for development and measurement |
| [`../interfaces/README.md`](../interfaces/README.md) | The shape of an interface package |
| [`../data/README.md`](../data/README.md) | What the folders of the persona root hold |
| [`../cli/README.md`](../cli/README.md) | The interactive chat's screen |
