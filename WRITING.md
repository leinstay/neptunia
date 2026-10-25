# Writing

How prose is written in this repository: documentation, prompts, commit messages, pull requests, reports and replies. `AGENTS.md` carries the short defaults; this file is the full set, with the reasons and the examples. Read it before writing any text longer than a line, and read the changed text against it before handing it in. Meaning and correctness come before rhythm and punctuation. Repeating a technical term is right: a synonym makes the reader wonder whether a second thing exists.

## 1. Before writing

- Decide who reads the text and what they will do with it: change code, run a command, merge a pull request, make a decision, answer a question.
- Decide the one thing the text must leave them with, and put it first. In a reply the reader already has the context, so the decision comes before the reasoning, not after it.
- Do not assume the reader shares your tacit knowledge. A name the reader has not seen gets one phrase of meaning the first time it appears; a mechanism gets one sentence of what it does before its parts are named.
- Choose the form from the content, not from habit: prose for behaviour and reasoning, a table for a reference the reader will scan, a list only for items that are a genuine list.

## 2. Sentences

- One thought per sentence. Break a sentence when the reader has to hold more than one open clause; keep a long one when its parts belong together. Vary the length; a text of equal sentences reads like a machine.
- Active voice when the actor matters. "The door drops a duplicate event", not "duplicate events are dropped". Passive is fine when the actor is unknown or irrelevant.
- Positive form. "The variance was small", not "the variance was not large". "She waits for the errand", not "she does not act before the errand ends".
- Concrete words where a concrete word exists. "The turn runner", not "the relevant component"; "the 2,000-character limit", not "platform constraints".
- No needless words. "It is important to note that", "in order to", "the fact that", "serves to", "as a means of" go.
- Coordinate ideas in the same form: "the pipeline cleans the data, extracts the features and trains the model", not "cleaning, feature extraction, and then it trains".
- Keep related words together: the subject next to its verb, the modifier next to what it modifies.
- The new or important information goes at the end of the sentence, where the stress falls: "The outage came from a cron job that fired every minute instead of every hour."
- Say each point once. If a sentence restates an earlier one in other words, delete it.

## 3. Claims and evidence

- Every factual claim carries what supports it: a file and line, a number you measured, a command you ran and its output, the owner's words with their date. "Significantly faster" is not a claim; "the median request fell from 35k to 24k tokens on the 41-question set" is.
- Say what you did not check. "Not run live" is a fact the reader needs; silence about it is a lie by omission.
- State a claim at the certainty the evidence supports, with one qualifier at most. "May affect outcomes", not "could potentially possibly affect outcomes". Keep scope statements and real corrections; drop hedges that repair an earlier overstatement.
- Never invent a number, a citation, a source, a quote or a date. If a detail is missing, ask or write the simpler sentence without it.
- A recommendation is marked as one, and the reasons for it are the facts, not adjectives.

## 4. The habits of model prose

A language model writes what is most likely next, so by default it makes the choice that fits any reader and any subject. A person writes for one reader and one subject, so the choices are uneven and specific. Each habit below is one form of the default choice. The first group justifies an edit on one sighting; a habit marked weak alone needs company in the same passage.

### Staging instead of stating

- **Not X but Y.** "Not just a cache, but the reason a turn stays cheap"; "this is not about X, it is about Y"; the same contrast split over two sentences; a clipped negative tail ("..., no guessing"). The negative half names something nobody claimed so the positive half sounds larger. State the claim. Keep a contrast only when the reader really holds the belief it corrects.

  ```text
  Avoid
  This is not just a cache. It is the reason a turn stays cheap.

  Use
  The prompt cache keeps the stable blocks of a request identical between turns, so a turn pays only for what changed.
  ```

- **The one-line closer.** A one-sentence paragraph that restates the one before it: "That is the real win." "That matters." "Read that again." A sentence after an example that names what the example showed. A row of fragments ("No timer. No helper model. No guessing."). Cut the closer that repeats; keep a short sentence when it adds a fact or a consequence; merge fragments into a sentence with a claim.
- **Sayings that sound deep.** "At its core", "the real question is", "the heart of the matter", "X is the Y of Z", "X becomes a trap". An ordinary point dressed as a hidden truth. Write the point.
- **The run-up before the point.** "Let's dive in", "here is what you need to know", "the thing is", "honestly?", "let's be honest". The writer announces the point instead of making it. Delete the run-up, not only its tone.
- **Arguing with nobody.** "To be clear", "I'm not saying", "one might be tempted to", "an obvious approach would be ... but". The text answers an objection that appears nowhere, usually a leftover of an earlier draft. Remove the defence; if it holds a claim, state the claim. Keep an objection the reader would actually raise.

### Rhythm by rule

- **Forced triads.** Three items because three sounds finished: "validates, deduplicates, and safeguards". Count the distinct ideas and write that many. The tell also appears as three parallel examples or three short facts followed by a lesson.

  ```text
  Avoid
  The door validates, deduplicates, and safeguards every event.

  Use
  The door rejects a malformed event and drops a duplicate.
  ```

- **Repeated sentence openers.** Three sentences in a row starting with the same word. Merge them, change the subject or start with the action. A repetition chosen for rhythm is allowed once.
- **Dashes as the universal connector.** An em dash lets the writer skip the choice of how two clauses relate, so the model reaches for it everywhere. Write a period, a comma, a colon or parentheses. No em or en dashes in prose, no ` -- `; dashes inside code, paths and commands stay.
- **Transition openers.** "Additionally", "Furthermore", "Moreover", "Notably" at the head of a sentence. The connection is usually plain from the content; where it is not, "but", "so", "because" say it.
- **Stacked qualifiers.** "It could potentially be argued that it might in some cases". One qualifier when the evidence is partial, and say what is missing. Weak alone.
- **Hyphenated pairs after the noun.** "A well-documented module" keeps the hyphen; "the module is well-documented" does not. Weak alone.
- **Passive voice with no actor.** "No configuration file needed. Results are preserved." Name who does what when it clarifies. Weak alone.

### Inflation and borrowed authority

- **Stock model words.** Crucial, pivotal, robust (figurative), seamless, leverage, delve, deep dive, enhance, showcase, underscore, highlight (verb), landscape (abstract), tapestry, testament, vibrant, meticulous, intricate, enduring, key (adjective), interplay, bolster, garner, align with. Each is a tell wherever it appears; a formal word outside this list is not.
- **Inflated significance.** "Marks a pivotal moment", "plays a key role", "setting the stage for", "the future looks bright", a "challenges and outlook" section, a send-off paragraph. Keep the fact, drop the significance, end on the last concrete fact.
- **Vague connection.** "Associated with", "linked to", "in connection with". Name the relationship the facts give: calls, reads, writes, replaces, depends on, was part of.
- **Shallow "-ing" riders.** "..., ensuring reliability", "..., highlighting the importance of". A rider bolted to a fact to make it deeper. Delete it or make it a sentence with its own fact.
- **Sales language.** Powerful, rich (figurative), groundbreaking, renowned, diverse array, must-have, stunning. Say what the thing is.
- **Borrowed authority.** "Experts agree", "observers note", "widely used", a list of outlets. Cite the file, the number, the command or the named source and what it said; otherwise cut the claim.
- **Avoiding is and has.** "Serves as", "functions as", "boasts", "features", "offers", "represents". Write "is" and "has".

### Formatting by rule

- **Bold as decoration.** Words bolded for emphasis; a list where every item opens with a bold label and a colon. Bold only a term the reader must find again. A labelled list whose labels carry no information becomes prose.

  ```text
  Avoid
  - **Performance:** load times are faster through optimized algorithms.
  - **Security:** security has been strengthened with encryption.

  Use
  The update speeds up load times and adds end-to-end encryption.
  ```

- **Decorative headings.** Title Case Everywhere, emoji, arrows, a horizontal rule between every section, a heading written for effect ("The decision, on one screen"). Sentence case; a heading names what the section holds ("How the six options compare").
- **A heading repeated in the first sentence.** "## Performance / Speed matters." Delete the restatement.
- **"Label: explanation" rows outside a table.** "Cache: keeps requests cheap." Write the sentence: "The cache keeps requests cheap."
- **Slash lists.** "and/or", "docs/comments/commits". Write "and" or "or"; a path keeps its slashes.
- **Curly quotes** where the file uses straight ones. Weak alone.

### Leftovers of the draft and the chat

- **Chat residue.** "Great question", "Certainly!", "I hope this helps", "let me know if", "want me to...?". Remove the wrapper, keep the content.
- **Writing about the document instead of its subject.** "This section is organized by owner", "the table below compares", "this file says how", "generated from the sources". Describe the subject; the reader can see the layout. A document says what it is for in one line and then is it.
- **History in a document.** "Now", "was", "no longer", "moved from", "previously", "was added to replace". The git log holds history; a document describes the present. Change logs and migration notes are the exception, because change is their subject.
- **The owner's chat in a file.** "As discussed", "as you said", the diagnosis the reader already has. A file is read by someone who never saw the conversation.
- **A TODO with no plan.** A `TODO` names the plan it belongs to or does not exist.
- **Knowledge-limit disclaimers and guesses.** "As of my last update", "while details are limited, it appears that". State what the sources do not show, or cut the sentence; never fill a gap with a plausible guess.

### Writing for the wrong reader

- **Re-explaining what the reader knows.** A reply that restates the problem, walks through the diagnosis and lays out the evidence before it reaches the decision in the last line. Lead with the decision; keep only the reasoning that would change whether the reader agrees, usually one fact they lack. The proof belongs in the document that follows, not in the reply.

### When a habit is not a tell

A watched phrase inside a quotation, a title, a proper name or a passage that discusses the phrase stays. A person can make any of these choices on purpose: keep a specific odd detail, a mixed feeling, an aside, a first-person choice the writer can explain, and a deliberate repetition for rhythm. Several tells together are the signal; one is a hint.

## 5. Documentation

Applies to `docs/`, the README and the root files.

- One topic per file, named in kebab-case, listed in `docs/README.md` with one line. The first paragraph says what the document covers and for whom.
- Present tense, about the code as it is. No history, no roadmap: a plan is not documentation.
- Headings are plain phrases that name their content, in sentence case. A title may join two things ("Memory and the diary").
- Names woven into sentences: "`runTurn` opens a turn when an event passes the door", not "runTurn: opens a turn".
- What the engine does, not what the reader "can" or "gets": "the door drops a duplicate event", not "you can rely on deduplication".
- A document that describes behaviour names the module that implements it and the setting that changes it, with its default.
- Tables for references (settings, commands, labels, codes), prose for behaviour. A table generated from the code says so in its first line.
- Every path, key, command and value in backticks. Links relative and to files that exist; an external link only to published documentation.
- No emoji. No "Label: explanation" rows outside a table.
- A change to the code changes its document in the same pull request.

```text
Avoid
The turn runner was changed so that you can now rely on one turn per event. Earlier, a repeated event started a second turn.

Use
`runTurn` opens a turn when an event passes the door. The door drops a duplicate event, so one event starts at most one turn.
```

## 6. Prompts and labels

Applies to `prompts/` and `prompts/labels.json`.

- `docs/prompt-contract.md` binds to the letter: file names, placeholders, keys, tags and schemas stay exactly as written, and a change on one side changes the other in the same pull request.
- A model mirrors the tone of its prompt. Write in a living voice, concrete and specific, as to a colleague who has to act on it; no officialese.
- Every sentence carries an instruction or a fact the model needs. A sentence that only sets a mood goes.
- A behaviour rule describes the behaviour and gives no sample line: the model repeats a sample until it becomes a tic.
- Each fact has one home: the system prompt holds the craft, the character card who the persona is and how it talks, a task file the situation, the format file the protocol, the rules file the owner's corrections, `labels.json` the wording of what code inserts.
- Tracked prompts are English and character-neutral; a character's own material lives in the local layer and keeps its language.

## 7. Commit messages and pull requests

- The subject is imperative, under 72 characters, and says what changes: "Drop the retired agent filter", not "Updates" or "Fixed stuff".
- The body says why, when the subject is not enough. The diff already shows what.
- The message ends with a `Co-Authored-By:` trailer naming the model that did the work.
- A pull request says what changed and why, how it was tested (the command and the counts), and whether it adds a setting, a prompt file or a contract change.
- The result, not the work: no "I then tried", no tour of the dead ends, no apology for the size.

## 8. Reports and replies

- The answer first. Then only the reasons that would change whether the reader agrees.
- A work report: the outcome, what changed, how it was checked, what is open or unverified. "Tests pass" with the command and the counts; "not run" said plainly.
- A diagnosis: the likely cause first, then the evidence for it, then the fix.
- A plan: the proposal and why, then the steps.
- A question: what you need to know, the real options, your recommendation, in a place the reader cannot miss.
- Length: about 100 words for a direct answer, 250 for an explanation or a work report, 500 for a plan or a review; longer when the reader asked for it.
- No praise for the question, no apology ritual, no preview of what you are about to say, no summary of what you just said, no offer of more help at the end.
- In a chat with a person, their language; on disk, English.

## 9. Accepted examples

Corrections the owner made on 2026-10-25 to this repository's own files. Each pair shows a habit and its fix.

```text
Avoid
This file says how code and documentation in this repository are written.

Use
Conventions for the engine's code, kept short so people and agents actually read them.
```

The opening names the subject and its purpose instead of describing itself.

```text
Avoid
- English only.
- No Cyrillic in any tracked file.
- Test data is English, Greek or accented Latin, never Cyrillic.

Use
Write English in code, comments, documentation, commit messages and test data. Test data that has to be non-Latin is Greek or accented Latin.
```

Three bullets that said one thing became one statement.

```text
Avoid
Name no real person, server or character in the public documentation. This is the one place where that rule belongs.

Use
Name no real person, server or character in the public documentation.
```

The second sentence defended the rule against nobody.

```text
Avoid
These words are not used: op, operation, helper, organ, task (for an errand), intent, place, guild ...

Use
An identifier, a comment, a label or a config key uses these words and no synonym.
```

A banned list nobody asked for became one sentence after the terminology table, where the reader needs it.

```text
Avoid
Neptunia is a persona engine: one process plays one character through a language model in a chat platform, with its own memory, inner life and tools. This file is for the coding agents that work on it.

Use
For the coding agents that work on this repository: where things are, how to run and test the code, how to write, what never to do. The README is for people.
```

A file for agents opens with what its reader does with it; the product description belongs to the README.

```text
Avoid
Read `STYLEGUIDE.md` before writing code or prose.

Use
Read `STYLEGUIDE.md` before writing code.
```

A pointer promises only what the target holds.

## 10. Review

- Read the changed prose once against section 4 and the section for its kind. Look at paragraph shape as well as sentences: a contrast split over two sentences, three parallel examples, the same closer after every section are the same tells at a larger scale.
- Fix the text in place and hand back the corrected text, not a list of findings. Keep every supported claim; add no fact, name, number or date the source does not give.
- Keep every exact string of a contract, every quoted sample, every code block, path and command as it is.
- Read it once more for what was added or lost: a claim, a number, a qualifier the evidence needed.
- When a rule would make the text worse, break the rule and say so in the report.

## Sources

The habits of model prose follow Wikipedia's "Signs of AI writing" (WikiProject AI Cleanup) and the Elements of Agent Style (Zhao, 2026, after Strunk and White, Orwell, Pinker, and Gopen and Swan); the documentation rules follow a style note for agents by mate-h; the reply structure follows the Elements of Style for Agents (sdi2200262). This file wins where they differ.
