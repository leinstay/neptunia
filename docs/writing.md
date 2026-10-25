# Writing guide

How prose is written in this repository, for every text an agent writes here. The defaults are in `AGENTS.md` and this guide interprets them. Meaning and correctness come before rhythm and punctuation, and repeating a technical term is right, because a synonym makes the reader wonder whether a second thing exists.

## Before writing

- Decide who reads the text and what they will do with it: change code, run a command, merge a pull request, make a decision.
- Decide the one thing the text must leave them with, and say it first.

## The habits of model prose, and what to do instead

Each habit is a default choice that fits any reader and any subject. Replace it with the specific claim.

- **Staging instead of stating.** A contrast ("not X but Y", "this is not about X"), a one-line closer, a run-up before the point and an objection nobody raised all signal importance without adding a fact. State the claim. Keep a contrast only when the reader really holds the belief it corrects.

```text
Avoid
This is not just a cache. It is the reason a turn stays cheap. That matters.

Use
The prompt cache keeps the stable blocks of a request identical between turns, so a turn pays only for what changed.
```

- **Sayings that sound deep.** "At its core", "the real question", "the heart of the matter" dress an ordinary point as a hidden truth. Write the point.
- **Forced triads.** Three items because three sounds finished. Count the distinct ideas and write that many.

```text
Avoid
The door validates, deduplicates, and safeguards every event.

Use
The door rejects a malformed event and drops a duplicate.
```

- **Repeated sentence openers.** Three sentences in a row that start with the same word. Merge them, change the subject or start with the action.
- **Dashes as the universal connector.** Decide how the clauses relate and write a period, a comma, a colon or parentheses.
- **Stacked qualifiers.** "Could potentially", "may in some cases". Keep one qualifier when the evidence is partial, and say what is missing.
- **Hyphenated pairs after the noun.** "A well-documented module" is fine, "the module is well-documented" is not. Write "well documented".
- **Inflated significance.** "Pivotal", "crucial", "enduring", "plays a key role", "robust", "seamless", "leverage". Say what the thing does and keep the fact.
- **Vague connection.** "Associated with", "linked to", "in connection with". Name the relationship: calls, reads, writes, replaces, depends on.
- **Shallow "-ing" riders.** "Ensuring reliability", "highlighting the importance of". Delete the rider or turn it into a sentence with a fact.
- **Sales language and borrowed authority.** "Powerful", "rich", "experts agree", "widely used". Cite the file, the number or the command instead.
- **Avoiding "is" and "has".** "Serves as", "boasts", "features", "offers". Write "is" and "has".
- **Formatting by rule.** Bold as decoration, headings written for effect, a "Label: explanation" row outside a table. Use bold only for a term the reader must find again, name the content in the heading, and write the row as a sentence.
- **Leftovers of the draft.** The chat that produced the text ("as discussed"), "now", "was", "no longer", a TODO with no plan behind it, "Great question", an offer of more help. Write the file as it stands for a reader who never saw the draft.

## Documentation

Applies to `docs/`, the README and the root files.

- One topic per file. A reader should know from the title which file to open.
- Write in the present tense about the code as it is. History belongs to the git log.
- Headings are plain phrases that name their content.
- Weave names into sentences, and say what the engine does, not what the reader "can" do.
- Name the module that implements a behaviour and the setting that changes it, with its default.
- Use a table for a reference and prose for behaviour. A table generated from the code says so in its first line.
- Links are relative. A document changes in the same pull request as its code.

```text
Avoid
The turn runner was changed so that you can now rely on one turn per event. Earlier, a repeated event started a second turn.

Use
`runTurn` opens a turn when an event passes the door. The door drops a duplicate event, so one event starts at most one turn.
```

## Prompts and labels

Applies to `prompts/` and `prompts/labels.json`.

- `docs/prompt-contract.md` binds to the letter: file names, placeholders, keys, tags and schemas stay exactly as written, and a change to one side changes the other in the same pull request.
- A model mirrors the tone of its prompt, so write in a living voice, concrete and specific, as to a colleague who has to act on it.
- Every sentence carries an instruction. A sentence that only describes the mood goes.
- A behaviour rule describes the behaviour and gives no sample line, because the model copies a sample until it becomes a tic.
- Each fact has one home: the system prompt holds the craft, a task file the situation, the format file the protocol, `labels.json` the wording of what code inserts.
- Tracked prompts are English and character-neutral.

## Commit messages and pull requests

- The subject is imperative, under 72 characters, and says what changes: "Drop the retired agent filter", not "Updates".
- The body says why. The diff already shows what.
- A pull request says what changed and why, how it was tested, and whether it adds a setting, a prompt file or a contract change.
- Write the result, not the work: no "I then tried", no tour of the dead ends.

## Replies to the owner and reports

- The answer comes first. The reasoning follows, only as much as would change whether the reader agrees.
- A work report gives the outcome, what changed, how it was checked and what is open.
- A diagnosis opens with the likely cause and the evidence for it.
- A question states what you need to know and the real options, with your recommendation.
- Keep to the length budgets in `AGENTS.md`.
- Skip praise for the question, the apology ritual and the preview of what you are about to say.

## Accepted examples

The owner's corrections of 2026-10-25. Each pair shows a habit and its fix.

```text
Avoid
This file says how code and documentation in this repository are written.

Use
Conventions for the engine's code, kept short so people and agents actually read them.
```

The opening names the subject and its purpose. It stops describing itself.

```text
Avoid
- English only
- No Cyrillic in any tracked file
- Test data is English, Greek or accented Latin, never Cyrillic

Use
Write English in code, comments, documentation, commit messages and test data; non-Latin test data is Greek or accented Latin.
```

Three bullets that said one thing became one line.

```text
Avoid
Name no real person, server or character in the public documentation. This is the one place where that rule belongs.

Use
Name no real person, server or character in the public documentation.
```

The second sentence defended the rule against nobody.

```text
Avoid
These words are not used: op, operation, helper, organ...

Use
An identifier, a comment, a label or a config key uses these words and no synonym.
```

A banned list nobody asked for became one sentence after the terminology table, where the reader needs it.

```text
Avoid
Neptunia is a persona engine: one process plays one character through a language model...

Use
For the coding agents that work on this repository: where things are, how to run and test the code, how to write, what never to do.
```

A public file opens with what its reader does with it, and a product pitch can wait for the README.

## Review

- Read the changed prose once against the habits above and the section for its kind.
- Fix the text in place and hand back the corrected text, not a list of findings.
- Keep every exact string of a contract, every quoted sample and every code block as it is.
- When a rule would make the text worse, break the rule and say so in the report.
