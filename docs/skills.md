# Skills

A skill is a procedure the persona can find among their tools and follow. It can combine existing tools or run a script for a specific job. It is stored with the persona, so adding one does not require a new engine plugin.

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

The folder and `name` must match. Front matter accepts `name`, `description` and `tools`, and the loader refuses any other key. The body explains when to use the skill, its inputs, steps and failure handling. It is not a place to grant permissions. A procedure that tells the persona where a tool acts names the tool's argument `place`, which every tool that acts somewhere takes on every interface ([prompt contract](prompt-contract.md#the-place-argument)).

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

Scripts run with the installing user's operating-system permissions. The working directory is not a sandbox. Do not open or modify the memory database from a script; core records go through its writer. Review the code and dependencies of a package before you activate it.

## Review and use

A person writes a package under `<data>/skills/<name>/`, and a new or edited one becomes a candidate version. The loader refuses a symbolic link as `SKILL.md`, `setup.json`, `scripts/` or anything under it with the problem `symlink`, and it ignores a skill folder that is itself a link. The active snapshot includes `SKILL.md`, `setup.json` and the script bytes, so editing the working files does not silently change the version that runs. Before `skill.run` reads the script manifest, `snapshotProblem` in [the package module](../src/skills/package.ts) hashes the snapshot again and compares it with the active version's `contentHash`. A snapshot that differs fails with `skill-tampered`, and a snapshot whose folder or called script is gone fails with `skill-missing`. Nothing runs in either case, and the core logs a warning with the skill name and version and no file content.

Only the owner activates a version. `/skills pending` lists the candidate versions of every skill, and `/skills review <name>` shows the active version and the candidates of one. `/skills activate <name>` activates the newest candidate, the first version of a new skill included, and `/skills reject <name>` retires the pending version instead. The version an activation replaced stays, and `/skills rollback <name>` returns to it. `/skills disable <name>` keeps a skill out of the persona's tools, and an activation does not lift the switch.

## A skill among the persona's tools

A skill the persona can use is an entry of their tools array. `buildTools` in [the tools array](../src/tools/tools-json.ts) appends one function per active skill after the tools, sorted by name. The function's name is the skill's `name`, its description is the skill's `description` line followed by `labels.skills.procedure`, and it takes no parameter. A skill gets an entry when every tool in its `tools` is registered and granted to them, and only while they hold the grant of `skill.read`, because a call of the entry runs `skill.read` of that name. Activation grants no tool, and a procedure widens no permission: each step they take is checked as any call of theirs.

The array is the same for a reply, the command line and every wake, so all of them share one cached prefix. A wake checks each call by name against its own set when the call is made, and a skill is checked like any tool. A heartbeat answers a skill's call with `heartbeat-only` and reads nothing. `wakeRefusalCode` in [the wake rules](../src/tools/wake-tools.ts) decides it.

A call of a skill's entry returns the skill's whole text and is recorded in the journal as a read of `skill.read`. The turn keeps the first read in `draft.procedures` with the version its array offered, and a second call of the same skill in the turn answers the same text without reading the skill again (`src/turn/skill-calls.ts`). `skill.run` executes a script the skill declares, and `skill.disable` is the persona's own switch.

The loader refuses a skill whose name is the name of a tool, dotted or as the tools array writes it, with the problem `tool-name`. The core logs `skills: refused at load` once per folder with the skill and the code.

Runs have time and output limits. A timed-out script may already have acted, so its outcome can be unknown. Interrupted runs are not automatically replayed. Keep useful service results in the skill's state so a later question can reuse them.

Read the implementation in [format](../src/skills/format.ts), [version packages](../src/skills/package.ts), [runner](../src/skills/run.ts) and [tool entry point](../src/tools/operations/skill.ts).
