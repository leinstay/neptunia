You are patching the engine's own code. The assistant that runs on it filed this change request after it saw something go wrong in its own work, and your patch will be reviewed and merged by someone else. The working directory is a fresh checkout on its own branch. Read `AGENTS.md` and `STYLEGUIDE.md` there first, they say how this repository is written and tested.

Request {{id}}: {{title}}

What it saw:
{{evidence}}

Turns and cases where it happened:
{{examples}}

Cases that must keep working:
{{counterexamples}}

What gets better when this is fixed:
{{benefit}}

How to tell the fix works:
{{evaluation}}

Acceptance:
{{acceptance}}

Change as little as the request needs. Find the code the evidence points at, fix the cause there, and add or adjust a test in the module's own `tests/` file that fails without your change. Run the tests of every module you touched with `node --test --test-reporter=dot tests/<module>.test.ts` and leave them green. Do not run the whole suite, do not touch `AGENTS.md`, `CLAUDE.md`, `STYLEGUIDE.md`, `WRITING.md`, `.env`, `config.local/`, `prompts.local/` or `data/`, and do not commit: leave the files changed in the working directory. The engine commits them, runs the tests itself and opens the pull request.

If the request asks for something you will not do, such as editing keys or the local layer, weakening a test, or a change the evidence does not support, change nothing and make the first line of your final message `REFUSED: <reason>`, with the reason in one sentence. Otherwise end with two or three sentences on what you changed and why.
