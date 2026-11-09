# Skills

A skill is a procedure the persona can find among her tools and follow. It can combine existing tools or run a script for a specific job. It is stored with the persona, so adding one does not require a new engine plugin.

## Write a skill

Use this layout:

```text
data/skills/gif-search/
  SKILL.md
  setup.json
  scripts/
    search.ts
```

The procedure belongs in `SKILL.md`:

```markdown
---
name: gif-search
description: Find a GIF for the current chat.
tools: [skill.run]
---

Use this when a GIF would answer the request. Run search.ts with a query,
inspect its results and choose one that fits. If the service fails, report
that failure rather than inventing a result.
```

The folder and `name` must match. Front matter accepts `name`, `description`, `tools` and optional `task`. The body explains when to use the skill, its inputs, steps and failure handling. It is not a place to grant permissions. A procedure that tells her where a tool acts names the tool's argument `place`, which every tool that acts somewhere takes on every interface ([prompt contract](prompt-contract.md#the-place-argument)).

## Scripts and setup

A script reads JSON arguments from stdin and writes one JSON result to stdout:

```ts
process.stdin.setEncoding('utf8');
let input = '';
for await (const chunk of process.stdin) input += chunk;
const args = JSON.parse(input);
process.stdout.write(JSON.stringify({ ok: true, text: args.query }));
```

Declare the script and its arguments in `setup.json`:

```json
{
  "settings": [],
  "scripts": {
    "search.ts": {
      "args": { "query": { "type": "string", "required": true } },
      "credentials": []
    }
  }
}
```

Settings use the [module setup contract](interfaces.md#setup-contract). A secret named in a script's `credentials` list is supplied as `SKILL_<UPPERCASE_NAME>`. Use `/skills setup gif-search` to configure declared values.

The working directory is the skill's `state/`. `SKILL_STATE_DIR` and `SKILL_OUT_DIR` name persistent state and the current run's output folder. A result can include `text`, `data`, `error` and `files`; attachment names are returned as `skill:` handles. TypeScript runs through Node, and `.sh` scripts run through `/bin/sh`. No general terminal tool is exposed to the persona.

Scripts run with the installing user's operating-system permissions. The working directory is not a sandbox. Do not open or modify the memory database from a script; core records go through its writer. Review the code and dependencies of a package you activate yourself, because the version her task produced activates with no review by a person.

## Review and use

A package lives under `<data>/skills/<name>/`, and a new or edited one becomes a candidate version. A development agent checks a complete package with `neptunia tasks skill-pending <name>`, which answers with what is wrong with it or that it is pending. The loader refuses a symbolic link as `SKILL.md`, `setup.json`, `scripts/` or anything under it with the problem `symlink`, and it ignores a skill folder that is itself a link. The active snapshot includes `SKILL.md`, `setup.json` and the script bytes, so editing the working files does not silently change the version that runs. Before `skill.run` reads the script manifest, `snapshotProblem` in [the package module](../src/skills/package.ts) hashes the snapshot again and compares it with the active version's `contentHash`. A snapshot that differs fails with `skill-tampered`, and a snapshot whose folder or called script is gone fails with `skill-missing`. Nothing runs in either case, and the core logs a warning with the skill name and version and no file content.

Her skill task activates what it produced. When the thinker stops on a task of kind `skill`, the development worker finds the one pending version whose `task` names the task and asks the core with `skill.pending { name, task }`. `bindPackage` in [task activation](../src/skills/task-activation.ts) validates the package and writes that version on the task as `metadata.package`, and a refusal fails the task with the reason. The refusal `version-not-on-disk` means the folder's bytes differ from the version that would be bound, as after a revert to an older version. The worker accepts her bound task at its next wake. Every `board.reapSeconds` (default `60`) the core's `skills.settle` beat runs `settleSkillTasks` over her done tasks of kind `skill`, and it activates exactly the bound version through the writer's `activate-version` operation, with the version and the actor `task:<id>` recorded. A crash before an activation recovers on the first beat after the start, because the beat reads the board.

Each settled task gets one comment, `skill-activation <code>`, which names the result on the task.

| Code | What it means |
|---|---|
| `activated` | The bound version is active, and the version it replaced stays for a rollback. |
| `already-active` | The bound version was active already, and nothing was written. |
| `superseded` | The bound version is no longer a candidate, because a later edit, a rejection or a rollback retired it. Nothing changes. |
| `invalid-package` | The folder has a problem now, named after the code, or is gone. The version stays inactive. |
| `invalid-name` | The binding's skill name is no skill name, so no folder was read. |
| `unknown-version` | The binding's version is not a version of that skill. |

Nothing else activates. Other pending versions stay pending, and so does the version of a failed or cancelled task, of a task the owner filed, and an edit made after the binding. A watcher's finding about a skill is evidence for the owner and changes no skill. The owner reviews a pending version with `/skills review <name>` and activates the newest one with `/skills activate <name>`. `/skills rollback <name>` returns to the previous version, and a later beat leaves that in place. `/skills disable <name>` keeps a skill out of her tools, and an activation does not lift the switch.

## A skill among her tools

A skill she can use is an entry of her tools array. `buildTools` in [the tools array](../src/tools/tools-json.ts) appends one function per active skill after the tools, sorted by name. The function's name is the skill's `name`, its description is the skill's `description` line followed by `labels.skills.procedure`, and it takes no parameter. A skill gets an entry when every tool in its `tools` is registered and granted to her, and only while she holds the grant of `skill.read`, because a call of the entry runs `skill.read` of that name. Activation grants no tool, and a procedure widens no permission: each step she takes is checked as any call of hers.

The array is the same for a reply, the command line and every wake, so all of them share one cached prefix. A wake checks each call by name against its own set when the call is made, and a skill is checked like any tool. A heartbeat answers a skill's call with `heartbeat-only` and reads nothing. `wakeRefusalCode` in [the wake rules](../src/tools/wake-tools.ts) decides it.

A call of a skill's entry returns the skill's whole text and is recorded in the journal as a read of `skill.read`. The turn keeps the first read in `draft.procedures` with the version its array offered, and a second call of the same skill in the turn answers the same text without reading the skill again (`src/turn/skill-calls.ts`). `skill.run` executes a script the skill declares, and `skill.disable` is her own switch.

The loader refuses a skill whose name is the name of a tool, dotted or as the tools array writes it, with the problem `tool-name`. The core logs `skills: refused at load` once per folder with the skill and the code.

Runs have time and output limits. A timed-out script may already have acted, so its outcome can be unknown. Interrupted runs are not automatically replayed. Keep useful service results in the skill's state so a later question can reuse them.

Read the implementation in [format](../src/skills/format.ts), [version packages](../src/skills/package.ts), [runner](../src/skills/run.ts) and [tool entry point](../src/tools/operations/skill.ts).
