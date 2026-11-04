# Skills

A skill is a procedure the persona can discover and follow. It can combine existing tools or run a script for a specific job. It is stored with the persona, so adding one does not require a new engine plugin.

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
description: Find a GIF for the current conversation.
tools: [skill.run]
---

Use this when a GIF would answer the request. Run search.ts with a query,
inspect its results and choose one that fits. If the service fails, report
that failure rather than inventing a result.
```

The folder and `name` must match. Front matter accepts `name`, `description`, `tools` and optional `task`. The body explains when to use the skill, its inputs, steps and failure handling. It is not a place to grant permissions.

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

Scripts run with the installing user's operating-system permissions. The working directory is not a sandbox. Do not open or modify the memory database from a script; core records go through its writer. Review code and dependencies before activation.

## Review and use

A new or edited package becomes a candidate version. A development agent files the complete package with `neptunia task skill-pending <name>`. Filing rejects an incomplete package and grants no activation right. The owner reviews it with `/skills review <name>` and activates it with `/skills activate <name>`. The active snapshot includes `SKILL.md`, `setup.json` and the script bytes, so editing the working files does not silently change the version that runs.

The prompt lists usable active skills by name and description. `skill.read` opens the procedure; `skill.run` executes a declared script. Required tools must already be registered and granted. Activation grants no additional tool access.

Runs have time and output limits. A timed-out script may already have acted, so its outcome can be unknown. Interrupted runs are not automatically replayed. Keep useful service results in the skill's state so a later question can reuse them.

Read the implementation in [format](../src/skills/format.ts), [version packages](../src/skills/package.ts), [runner](../src/skills/run.ts) and [tool entry point](../src/tools/impl/skill.ts).
