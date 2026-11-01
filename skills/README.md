# Skills

A skill is a written procedure over her tools: when it applies, what she needs first, the steps, where the steps branch, how to recover and when to leave it alone. She sees one line of each active skill in her prompt and opens the whole text with `skill.read` when a line fits the moment. A skill never changes what she is allowed to do. The tools it names stay closed until the owner opens them with `/tools grant`.

Every skill is one folder with one file. A tracked skill lives in `skills/<name>/SKILL.md`, a private one in `skills.local/<name>/SKILL.md` in the deployment's private layer. A local skill replaces the tracked skill of the same name whole.

## The file

The file opens with a block of front matter between two lines of `---`, then the text of the skill. The folder name and `name` are the same.

```markdown
---
name: check-before-answering
description: I look a fact up on the web before I state it
tools: [web.read, web.search]
task: T-4f7k2m
---
When this applies: someone asks for a fact that changes over time or that I only half remember.

Before I start: web.search and web.read are both open to me. If either is closed, I say so and answer from memory with that said.

Steps:
1. Search once with the question in plain words.
2. Read the best hit, not the first one.
3. Answer in my own words and name where it came from.

If the read fails: search again with other words, once. After a second failure I tell the person I could not check.

Not for: opinions, jokes, or anything the chat itself already settled.
```

| Key | Required | What it holds |
|---|---|---|
| `name` | yes | The skill's name in kebab-case: lowercase letters and digits, words joined by single hyphens, starting with a letter. |
| `description` | yes | One line in her words, the line she sees in `<skills>`. It says when the skill is for. |
| `tools` | yes | The tools the steps call, as `family.verb` names. A flow list `[a.b, c.d]` (`[]` for a skill of prose alone) or a block list of `- a.b` lines under `tools:`. |
| `task` | no | The board task the skill came from. |

The front matter takes no other key and no other YAML. A file with a missing block, an unreadable line, a bad name, no description, no `tools` or no text after the block is refused with the reason, and `/skills list` names its folder under the skills it lists. So is a folder whose `name` differs from the folder's name.

## What to write in the text

Write for her, in the first person where the steps are hers. Say when the skill applies and, as plainly, when it does not. Name what has to be true before the first step, such as a tool that must be open. Give the steps in order, say where they branch and what she does when a step fails. Keep it as short as the procedure allows: she reads it in the middle of a turn.

A skill describes behaviour and never quotes a line to say. A sample sentence in a skill becomes a phrase she repeats. Nothing in a tracked skill names a character, a server, a person or a deployment.

## How a skill goes live

The engine reads both folders at the moment of use. A new or changed `SKILL.md` becomes a pending version. It is in nobody's prompt until an agent or the owner activates it: an agent with `neptunia task skill-activate <name>` (`neptunia task skill-pending` lists what waits), the owner with `/skills activate <name>`. An edit never replaces the active text by itself, so she keeps reading the version that was activated until another is.

A skill whose tools are not all open to her is listed as unavailable with the missing tool and the reason, and its line stays out of her prompt. The owner rolls an activation back with `/skills rollback <name>`, rejects a pending version with `/skills reject <name>` and switches a skill off or on with `/skills disable <name>` and `/skills enable <name>`. She may switch a skill off herself with `skill.disable`. A skill she has not read for `skills.reviewDays` days (default 30) is marked for review in `/skills`, and nothing is deleted.

More on the registry and the commands is in [docs/skills.md](../docs/skills.md).
