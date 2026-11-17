# Humanizer

This document is for an operator who wants the persona's longer texts checked before they are posted. The humanizer reads her speech of one step as one text, asks a linter whether it reads as composed, and when the linter says yes, asks a writer to write it again with the same content. It is off unless a deployment turns it on.

## When it runs

The humanizer runs while `humanizer.enabled` is `true` (default `false`). It reads her speech of each step before it is posted: the messages of an addressed turn, the entry of a diary post and the messages of an inner turn. A turn split into parts runs one whole turn per part, so each part's speech is read by itself. A `message.create` call she writes herself is read as one message before the call is made, one call at a time, so text never moves from one place to another.

A text under 40 words goes out as she wrote it, with no model request. The 40 words count every message of the step together. An addressed turn shows her typing while the two requests run.

## The two requests

The linter gets the text as her messages in `<msg>` tags, each with the line it answers, and the system text of `prompts/humanizer-linter.md`. It answers in strict JSON whether the text is written again and with which findings, at most five, each with a kind, the passage, the problem and the fix. When it answers no, her messages go out unchanged after this one request.

The writer gets `prompts/humanizer-writer.md` as its system text and one user text with the same messages and the findings. It sees no chat and not her think. It answers with a `<plan>` block of its own and then the messages in `<msg>` tags, and only the messages are read. The block has that name because a provider's safeguards stop an answer in which a model writes a `<think>` block. Its messages are posted in place of hers only when the answer holds as many messages as hers, no message is empty and each message answers the line her message at the same position answers. Only the texts change: the count, the order and the reply targets stay hers.

The tracked prompts are character-neutral. A deployment overrides them with its own files of the same names in `prompts/` of its data folder.

## Roles and routes

The linter runs on the role `humanizer.linter` and the writer on `humanizer.writer`. Neither role has a built-in model, and a role with no route makes the humanizer skip every text with no request. `humanizer.linter` runs on a key. `humanizer.writer` runs on a key or on a harness, where the memory writer's client runs it as one request with a system text and no tools and counts its usage under `humanizer.writer`. The requests carry the purposes `humanizer-linter` and `humanizer-writer`.

```
/model set humanizer.linter <key>/<model>:low
/model set humanizer.writer harness:claude/<model>
```

## Commands

The `humanizer` group of [src/interface/commands/humanizer.ts](../src/interface/commands/humanizer.ts) switches the humanizer for the whole deployment. `neptunia setup` asks the same switch in its `mechanics` step.

| Command | What it does |
|---|---|
| `/humanizer enable` | Writes `humanizer.enabled: true` |
| `/humanizer disable` | Writes `humanizer.enabled: false` |
| `/humanizer status` | Says whether the humanizer is on and the first route of each role, or the `/model set` command of a role with no route. A bare `/humanizer` runs it |

## When a request fails

A failed or timed-out request of either role, a linter answer that is not the JSON object, and a writer answer that fails its checks all post her own messages unchanged. The log line `humanizer: failed` names the stage, `linter` or `writer`, and the reason. A text that reached the linter logs `humanizer: checked` with the place, the words, whether a rewrite was asked, the number of findings and the milliseconds. A rewrite logs `humanizer: rewritten` with the number of messages and the milliseconds. No line carries her words.

## What it leaves alone

Reactions, pictures, GIFs and every call other than `message.create` go out as she made them. The writer's text is not checked a second time. `format.stripDashes` holds for the writer's text as it holds for hers. The diary's link removal runs on her answer before the humanizer reads it.
