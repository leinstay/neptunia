# Skills

This document describes how her skills work: where the files live, how a version becomes active, what reaches her prompt, how use is counted and which commands change a skill. It is for someone who writes a skill or changes the engine around them. The format of a `SKILL.md` and how to write one is in [`skills/README.md`](../skills/README.md).

A skill is a written procedure over her tools. It adds no ability: an activated skill grants no tool, and a skill whose tools she lacks stays out of her prompt.

## Where skills live

A deployment's skills are `data/skills/<name>/SKILL.md`, whether the owner or an agent wrote them. The engine ships none. A plugin ships skills in the `skills/` folder of its own package ([Plugins](plugins.md#skills-a-plugin-ships)), read while the plugin is enabled. A plugin's skill replaces a tracked skill of the same name, and a local skill replaces both. `src/skills/load.ts` reads the folders at each call, never from a cache, so a file written a moment ago is seen at the next read. A file that does not parse, or whose `name` differs from its folder, is no skill and never stops the others. `/skills list` names its folder and the reason.

## Versions and activation

The registry is the tables `skills`, `skill_versions` and `skill_uses` of the memory database ([Memory](memory.md)), written through the memory writer (`src/memory/db/skills.ts`). The content hash of the file text and the manifest of its tools make a version, and the text itself is stored with the version. A read of the registry therefore returns the text that was activated even after the file on disk changed.

A sync turns each new text into a `candidate` version and retires an older candidate of the same skill. It never touches an active version. A skill whose file is gone becomes `stale` and keeps its active version, and it is `active` again when the file returns. Nothing activates by itself: an agent or the owner activates the newest candidate of a skill, the first version included, and the version it replaces is kept for a rollback. A rollback makes the previous active version active again and can be repeated back to the first. A rejected candidate is retired, and the same text does not come back as a candidate. Every activation records who made it (`agent:<name>`, `owner`) and when.

A switch is separate from the versions. `skill.disable` (hers) and `/skills disable` set it, `/skills enable` clears it, and a disabled skill keeps its active version.

## Executable skills

A skill may carry scripts: `data/skills/<name>/scripts/` beside its `SKILL.md`, and a `setup.json` whose `scripts` map declares each script's `args` (name, `type`, `required`) and the `credentials` it needs, and whose `settings` list is the module contract of `docs/setup.md`. The skill must name `skill.run` among its tools. The content hash covers the text, the contract and the script bytes, so an edited script is a new candidate version, and `snapshotPackage` in `src/skills/package.ts` keeps an immutable copy per hash under `.versions/`. `skill.run { name, script, args }` runs the activated version's copy, whoever wrote the skill. An undeclared script or argument is refused.

`runSkillScript` in `src/skills/run.ts` starts one process with the JSON arguments on stdin. It answers `{ ok, text, data, error, files }` on stdout. Its working directory is `data/skills/<name>/state/`, where it keeps its own state, and a later question can read that state without calling the outside service again. `SKILL_OUT_DIR` is its folder for files it returns, and each comes back as a handle `skill:<name>/<run>/<file>` that `message.create` takes in `file`: a script's result posts nothing by itself. Its environment holds the host's `PATH`, `HOME`, `TMPDIR` and locale plus `SKILL_<KEY>` for the credentials it declares, nothing of the engine. A directory is no sandbox: a script runs with the rights of the installing user, so only an activated version runs. `skills.run.timeoutMs` (default `60000`) ends the whole process group and reports the outcome as `unknown`, and `skills.run.maxOutputBytes` (default `1000000`) stops a flood. No run is stored as pending, so a restart repeats nothing, and each call is journalled like any tool call.

## What she sees

`skillsReads` in `src/skills/port.ts` lists the skills she can use now: active, not switched off, the file present, and every tool the skill names registered and granted to her. `skillIndexBlock` (`src/skills/index-block.ts`) turns them into the body of the `<skills>` block, `skills.index` and one `skills.line` each with the skill's own description, and the request builder puts it in the stable part after `<tools>` ([Prompt contract](prompt-contract.md)). The block is sent only while `skill.read` is granted to her. With no usable skill the request is the same as one built without skills.

`skill.read` answers the whole stored text of the active version. `skill.disable` is her own switch, which the owner undoes with `/skills enable`. Both are closed until the owner runs `/tools grant`. A tool a skill names is granted the same way, and `/skills list` shows the missing tool with its reason, `not-registered` or `not-granted`.

## How use is counted

After each turn `skillUsesOfTurn` (`src/skills/uses.ts`) turns the skills her request indexed and her tool calls into rows of `skill_uses`, one row per skill and kind at most. `discovered`: the index showed the skill. `read`: she called `skill.read` on it. `tried`: she called one of its tools after the read. `succeeded`: every such call ended ok. `corrected`: one failed and the same tool was called again. `declined`: she read it and called none of its tools. The rows are append-only. `skills.reviewDays` (default 30) days with no `read` after an activation mark the skill for review in `/skills list`. Nothing is deleted.

## The owner's commands

| Command | What it does |
|---|---|
| `/skills`, `/skills list` | Every skill with its state, who activated its version and when, the version a rollback restores, the pending count, a mark when it is due for review, and the skill folders the loader refused |
| `/skills show <name>` | The active text and tools |
| `/skills review <name>` | The active version beside the pending ones, with their texts, tools, origin task and use counts |
| `/skills pending` | Every version waiting for an activation |
| `/skills activate <name>` | Activates the newest pending version, as `owner` |
| `/skills rollback <name>` | Makes the previous active version active again |
| `/skills reject <name>` | Retires every pending version of the skill |
| `/skills enable <name>`, `/skills disable <name>` | Her list of skills, on or off |

`src/interface/commands/skills.ts` answers them. Without a skills port every `/skills` command answers `failed`.

## The agents' commands

An agent that built a skill lists the waiting versions and activates one on the core's socket: `neptunia task skill-pending` and `neptunia task skill-activate <name>` (`src/skills/agent-commands.ts`). The activation is recorded as `agent:<client name>`. An agent can do nothing else with a skill: it does not roll back, reject or switch.

## How a skill is made

Her `selfimprovement` wake ([Inner life](inner-life.md#the-selfimprovement-wake)) shows her chains that repeat. She may answer with `board.propose` of `kind` `skill`, with the turns that show it, the cases that must not count, the benefit and an evaluation case ([The task board](board.md)). A development agent builds the task as a pull request that adds `skills/<name>/SKILL.md`, or, for a private skill, a commit that adds `skills.local/<name>/SKILL.md` in the private git. She never writes a skill herself.

## Settings and modules

| Setting | Default | What it does |
|---|---|---|
| `skills.reviewDays` | 30 | Days without a read before `/skills` marks an active skill for review |

`src/skills/format.ts` parses a file, `load.ts` reads the folders, `index-block.ts` builds the index, `uses.ts` derives the use rows, `port.ts` is the registry over a connection, `client.ts` is the same calls over the memory writer, `wiring.ts` joins them to the core and `agent-commands.ts` answers the agents.
