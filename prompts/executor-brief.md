Task {{id}}: {{title}}

The working directory is this task's own worktree, on the branch `{{branch}}`. Your lease generation is {{generation}}. Read `AGENTS.md` and `STYLEGUIDE.md` there first: they say how this repository is written and tested.

What was seen:
{{evidence}}

Turns and cases where it happened:
{{examples}}

Cases that must keep working:
{{counterexamples}}

What gets better when this is done:
{{benefit}}

How to tell it works:
{{evaluation}}

Acceptance:
{{acceptance}}

Answers and comments on this task so far:
{{answers}}

Dev tasks under this task and how they ended:
{{children}}

Do not touch `AGENTS.md`, `CLAUDE.md`, `STYLEGUIDE.md`, `WRITING.md`, `.env` or `data/`, unless the task is a skill, whose package lives under `$NEPTUNIA_DATA_DIR/skills/`. Run the tests of every module you touched with `node --test --test-reporter=dot tests/<module>.test.ts` and leave them green, and do not run the whole suite. What you leave uncommitted in this worktree is committed for you when your run ends. The engine then runs the tests itself, and it alone opens and merges the pull request.
