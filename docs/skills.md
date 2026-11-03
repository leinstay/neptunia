# Skills

This document describes how her skills work: where the files live, what a `SKILL.md` holds, how a version becomes active, how a skill runs a script, what reaches her prompt, how use is counted and which commands change a skill. It is for someone who writes a skill or changes the engine around them.

A skill is a written procedure over her tools. It adds no ability. An activated skill grants no tool, and a skill whose tools she lacks stays out of her prompt. An executable skill also carries scripts that she runs through the tool `skill.run`.

## Where skills live

A deployment's skills are `data/skills/<name>/` under the persona data directory (`NEPTUNIA_DATA_DIR`, default `data/`), whether the owner or an agent wrote them. The engine ships none. `loadSkills` (`src/skills/load.ts`) reads the folders at each call and never from a cache, so a file written a moment ago is seen at the next read. A folder without a `SKILL.md`, and any loose file, is ignored. A file that does not parse, or whose `name` differs from its folder, is no skill and never stops the others. `/skills list` names its folder and the reason.

| Path under `data/skills/<name>/` | What it is |
|---|---|
| `SKILL.md` | The skill's text |
| `setup.json` | The module contract: the settings the owner gives it and the scripts it declares |
| `scripts/` | The scripts of an executable skill |
| `credentials.json` | The skill's secrets, mode `0600`, written by the setup commands |
| `config.json` | The skill's other settings, written by the setup commands |
| `state/` | The working directory of its scripts, where they keep their own state |
| `out/<run>/` | The files one script run returned |
| `.versions/<hash>/` | The immutable copy of each version of the package |

## The SKILL.md format

A `SKILL.md` starts with a block of front matter between two `---` lines and then holds the procedure in prose (`parseSkillFile`, `src/skills/format.ts`). The front matter has one `key: value` per line and no other YAML.

| Key | What it holds |
|---|---|
| `name` | The skill's name in kebab-case, the same as its folder |
| `description` | One line in her words, which her index shows |
| `tools` | The tools the skill uses, as a flow list `[web.search, message.create]` or a block list of `- a.b` lines. An empty list is allowed. Each name has the form `group.name` |
| `task` | Optional. The board task the skill came from |

Any other key is refused. A file with no front matter, a bad block, no name, a name that is not kebab-case, no description, no `tools` key, a tool name of another form or an empty body is a problem named by its code: `no-front-matter`, `bad-front-matter`, `no-name`, `bad-name`, `no-description`, `no-tools`, `bad-tools` or `empty-body`.

## Versions and activation

The registry is the tables `skills`, `skill_versions` and `skill_uses` of the memory database ([Memory](memory.md)), written through the memory writer (`src/memory/db/skills.ts`). The content hash of the package and the manifest of its tools make a version, and the text itself is stored with the version. A read of the registry therefore returns the text that was activated even after the file on disk changed.

A sync turns each new text into a `candidate` version and retires an older candidate of the same skill. It never touches an active version. A skill whose file is gone becomes `stale` and keeps its active version, and it is `active` again when the file returns. Nothing activates by itself. The owner activates the newest candidate of a skill, the first version included, and the version it replaces is kept for a rollback. A rollback makes the previous active version active again and can be repeated back to the first. A rejected candidate is retired, and the same text does not come back as a candidate. Every activation records who made it (`owner` or `agent:<name>`) and when.

A switch is separate from the versions. `skill.disable` (hers) and `/skills disable` set it, `/skills enable` clears it, and a disabled skill keeps its active version.

## Executable skills

A skill that names `skill.run` among its `tools` may carry scripts in `scripts/` beside its `SKILL.md`. Its `setup.json` holds two things. The `settings` list is the module contract of [Setup](setup.md#the-setup-contract-of-a-module): rows with a `key`, a `question`, a `kind` of `text`, `list` or `secret`, and `required`. The `scripts` map declares each script by file name:

```json
{
  "settings": [{ "key": "apiKey", "question": "API key of the weather service", "kind": "secret", "required": true }],
  "scripts": {
    "forecast.ts": {
      "args": { "city": { "type": "string", "required": true }, "days": { "type": "number", "required": false } },
      "credentials": ["apiKey"]
    }
  }
}
```

A script file name is letters, digits, `_` and `-` with the extension `.ts`, `.js`, `.cjs`, `.mjs` or `.sh`. A `.sh` script runs under `/bin/sh` and any other under the node of the core. An argument has a `type` of `string`, `number`, `boolean` or `object` and a `required` flag. `credentials` names the keys of the skill's `credentials.json` that the script may read.

The content hash covers the text, `setup.json` and the script bytes, so an edited script is a new candidate version. `snapshotPackage` (`src/skills/package.ts`) keeps an immutable copy per hash under `.versions/`, and a run uses the copy of the activated version. An edit on disk therefore changes nothing that runs until someone activates it.

`skill.run { name, script, args }` (`src/tools/impl/skill.ts`) takes the script name and `args` as one JSON object. It fails with `not-found` for a skill that is not active, is switched off or does not name `skill.run`, whoever wrote it. It refuses a script `setup.json` does not declare, an argument it does not name, a required argument that is absent and an argument of the wrong type, each as `invalid` with the code `invalid-args`. When a declared credential is not stored, the call fails with `not-configured` and names the keys. The owner stores them with `/skills setup <name>` or `/skills set <name> <key>`, which write through `src/setup/modules.ts`.

`runSkillScript` (`src/skills/run.ts`) starts one process per call with the arguments as JSON on its stdin, and it answers on stdout with one JSON object:

| Field | Meaning |
|---|---|
| `ok` | `true` for success. Anything else is a failure whose code is the string in `error`, else `script-failed` |
| `text` | What the tool result shows her |
| `data` | Any JSON the result carries |
| `error` | A short code for a failure |
| `files` | Names of files the script wrote to `SKILL_OUT_DIR` |

The working directory of the process is `data/skills/<name>/state/`. Its environment holds the host's `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL` and `LC_CTYPE`, the two folders as `SKILL_STATE_DIR` and `SKILL_OUT_DIR`, and `SKILL_<KEY>` for each credential its declaration names, with the key in capitals. Nothing else of the engine reaches it: no key store, no path of the memory database. A script keeps state in `state/`, so a later question can use it without calling the outside service again.

Each file named in `files` comes back as a handle `skill:<name>/<run>/<file>` in the result's `data.outputs`, which `message.create` takes in its `file` argument. A script's result posts nothing by itself. A directory is no sandbox. A script runs with the rights of the installing user, and only an activated version runs.

The result is `ok`, `failed` or `unknown`, with these codes for a run that did not succeed:

| Code | Status | When |
|---|---|---|
| `no-script` | `failed` | the script file is not in the snapshot |
| `cannot-start` | `failed` | the process did not start |
| `exit-<n>` | `failed` | the process exited non-zero |
| `bad-output` | `failed` | stdout is no JSON object |
| `output-too-large` | `failed` | stdout passed `skills.run.maxOutputBytes` |
| `timeout` | `unknown` | the run passed `skills.run.timeoutMs`, so the script may have acted |

At a timeout or a flood the whole process group is killed. No run is stored as pending, so a restart repeats nothing, and each call is journalled like any tool call.

## What she sees

`skillsReads` in `src/skills/port.ts` lists the skills she can use now: active, not switched off, the file present, and every tool the skill names registered and granted to her. `skillIndexBlock` (`src/skills/index-block.ts`) turns them into the body of the `<skills>` block, the label `skills.index` and one `skills.line` each with the skill's own description, and the request builder puts it in the stable part after `<tools>` ([Prompt contract](prompt-contract.md)). The block is sent only while `skill.read` is granted to her. With no usable skill the request is the same as one built without skills.

`skill.read` returns the whole stored text of the active version. `skill.disable` is her own switch, which the owner undoes with `/skills enable`. Like every tool, `skill.read`, `skill.run` and `skill.disable` are closed to her until the owner runs `/tools grant`, and so is each tool a skill names. `/skills list` shows a missing tool with its reason, `not-registered` or `not-granted`.

## How use is counted

After each turn `skillUsesOfTurn` (`src/skills/uses.ts`) turns the skills her request indexed and her tool calls into rows of `skill_uses`, at most one row per skill and kind. `discovered` means the index showed the skill. `read` means she called `skill.read` on it. `tried` means she called one of its tools after the read. `succeeded` means every such call ended ok. `corrected` means one failed and the same tool was called again. `declined` means she read it and called none of its tools. The rows are append-only. When an active skill has gone `skills.reviewDays` days (default `30`) with no `read` since its activation, `/skills list` marks it for review. Nothing is deleted.

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
| `/skills setup <name>`, `settings`, `set`, `clear`, `add`, `remove` | The settings of one skill through its `setup.json`. A secret is asked for without echo and shown as set with its last four characters |

`src/interface/commands/skills.ts` answers the first group, and without a skills port every one of them answers `failed`.

## The agents' commands

The desk of the core answers two commands of an `agent` principal (`src/skills/agent-commands.ts`): `skill.pending` lists the waiting versions, and `skill.activate <name>` activates the newest one as `agent:<client name>`. `neptunia task skill-pending` and `neptunia task skill-activate <name>` send them. An agent can do nothing else with a skill, not even roll back, reject or switch one. The link admits only commands named `task.*` from an agent principal ([Interfaces](interfaces.md#clients-and-principals)), so it answers both skill commands `invalid` with `body.name:not-allowed` before they reach the desk.

## How a skill is made

Her `selfimprovement` wake ([Inner life](inner-life.md#the-selfimprovement-wake)) shows her chains that repeat. She may answer with `board.propose` of `kind` `skill`, with the turns that show it, the cases that must not count, the benefit and an evaluation case ([The task board](board.md)). A development agent builds the task as a skill folder in `data/skills/<name>/` ([Development agents](development-agents.md)). She never writes a skill herself.

## Settings and modules

| Setting | Default | What it does |
|---|---|---|
| `skills.reviewDays` | `30` | Days without a read before `/skills` marks an active skill for review |
| `skills.run.timeoutMs` | `60000` | How long one `skill.run` script may run before its process group is killed |
| `skills.run.maxOutputBytes` | `1000000` | How much a script may write to stdout before it is stopped |

`src/skills/format.ts` parses a file, `load.ts` reads the folders, `package.ts` hashes and snapshots a package and checks a script's arguments, `run.ts` runs a script, `index-block.ts` builds the index, `uses.ts` derives the use rows, `port.ts` is the registry over a connection, `client.ts` is the same calls over the memory writer, `wiring.ts` joins them to the core, `settings.ts` reads the settings and `agent-commands.ts` answers the agents.
