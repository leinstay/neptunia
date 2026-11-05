# Prompt contract

This guide is for people and agents changing model-facing text. Prompt files, labels, tool definitions and parsers form one contract. Keep placeholders and output structures compatible with the code that consumes them.

## Layers

Engine defaults live in `prompts/`. A nonempty file at the same relative path under `data/prompts/` replaces the default. Personal settings, labels and tool texts live under `data/config/` and merge over the corresponding engine files.

Agent prompts use `agents/<name>/` and `data/agents/<name>/`. They are not loaded from the persona conversation prompt directory. See [development agents](development-agents.md).

## Files and readers

| Text | Contract to inspect |
|---|---|
| Character card and rules | [prompt assembly](../src/behavior/prompt.ts) |
| Conversation output format | [format prompt](../prompts/format.md), [parser](../src/llm/parse.ts) |
| Tool descriptions and arguments | [tool texts](../config/tools.json), [tool registry](../src/tools/) |
| Memory-session instructions | [memory implementation](../src/memory/), [session writes](../src/memory/db/session-write.ts) |
| Turn context blocks | [request builders](../src/turn/request/) |
| Heartbeat wake | [heartbeat prompt](../prompts/heartbeat.md), `<wake>` from [src/behavior/wake.ts](../src/behavior/wake.ts), its calls in [src/tools/wake-tools.ts](../src/tools/wake-tools.ts) |
| Selfimprovement wake | [wake prompt](../prompts/selfimprovement.md) as `prompts.selfimprovement`, `<wake>` from [src/behavior/selfimprovement-text.ts](../src/behavior/selfimprovement-text.ts) with `labels.wake.selfimprovement`, its calls in [src/tools/wake-tools.ts](../src/tools/wake-tools.ts) |
| Development brief | [brief](../prompts/executor-brief.md) as `prompts['executor-brief']`, filled by `briefFrom` in [src/development/brief.ts](../src/development/brief.ts), after the agent's `agents/<name>/prompt.md` in [bin/development.ts](../bin/development.ts) |
| Agent instructions | [profile loader](../src/agent-runner/profiles.ts) |

The heartbeat and selfimprovement prompts are addressed to the persona and fill no placeholder. The development brief is addressed to a thinker or a dev and fills `{{id}}`, `{{title}}`, `{{branch}}`, `{{generation}}`, `{{evidence}}`, `{{examples}}`, `{{counterexamples}}`, `{{benefit}}`, `{{evaluation}}`, `{{acceptance}}`, `{{answers}}` and `{{children}}`. It carries no output tag: an agent acts on the task through the board. A local `data/prompts/selfdev.md` loads as `executor-brief`.

Read the actual template before editing it. A placeholder is an input supplied by its caller, not free prose. Preserve its spelling and inspect the caller when changing what it means. Model-facing phrases belong in the relevant prompt or label file rather than being embedded in runtime code.

## Request layout

Stable persona instructions and tool information precede changing conversational context. Relevant memory, people, place and recent messages are assembled within context budgets. Changing this order can affect prompt-cache reuse as well as behavior.

The active skill index contains descriptions; `skill.read` retrieves the procedure when needed. Tool transport can be native or textual, and the corresponding request builder must agree with the parser. See [core](core.md) for the turn loop and [memory](memory.md) for audience selection.

## Output

The conversation parser recognizes `<think>`, `<msg>`, `<react>`, `<gif>` and `<skip/>`. A message can name a reply target, and a reaction names its target message. Native tool calls arrive separately; textual tool calls are extracted before the conversation parser runs.

`parseOutput` in `src/llm/parse.ts` reads the `<msg>` tags outside inline code and fences, so a tag example in code stays literal text. An opening `<msg>` while a message is open ends that message there. A last `<msg>` that is never closed ends at the first `<react>`, `<gif>` or `<skip/>` after it, or with the output. Its words go out when the answer stopped on its own. The caller passes `cutOff` for an answer cut at the output cap, as `src/turn/phases/response.ts` does for the finish reason `length`, and that last message is dropped. A `</msg>` with no open message is never sent.

An output with such a breach yields one `{ kind: 'msgMalformed', nested, unclosed, stray }` diagnostic, placed before any `messagesMerged`. It holds counts and no contents, and a message dropped by `cutOff` is not counted. The persona reads it through `labels.tools.diagnostics.msgMalformed`, whose `{count}` is the sum of the three counts.

Think text is private planning, not a public chat message. An unfinished think block produces silence rather than publishing its contents. The request archive retains available response text and parsed think text for later inspection.

### Diary audience

A diary writer request carries `<publication_places>` after `<plan>` and `<seeds>`, and the block is never cut. Its first line is `diary.publicationPlaces` from `config/labels.json`, which states the output contract, followed by one `interface:<iface>` line per interface and one `place:<place id> <name>` line per group place, indented under its parent. The block is absent when memory knows no place.

The answer may add `<audience>unrestricted | interface:x | place:y</audience>`, one of the three, with the token alone. `takeAudience` in `src/llm/parse.ts` removes the tag from a diary answer before the conversation parser runs and leaves a think block and code alone. `audienceChoice` in `src/tools/publication.ts` reads the bodies into `result.diary.audience`, which is `{ ok: true, audience }` or `{ ok: false, code }` with `audience-unknown-place`, `audience-unknown-interface` or `audience-malformed`. No other mode reads the tag.

A diary writer request after a refusal also carries `<audience_refused>`, right after `<publication_places>` and never cut, with one `diary.audienceRefused` line per post she has not heard of. The line fills `{date}`, `{gist}` and `{reason}`, and `{reason}` is the code's entry in `diary.audienceReasons`.

The contract lives in the label because a nonempty `data/prompts/diary.md` replaces `prompts/diary.md` whole. A deployment with its own `diary.md` needs no change for the tag to work, and its `data/config/labels.json` may reword `diary.publicationPlaces`. [The diary](diary.md#audience) describes what the stored audience does.

### Mention handles

People, channels and messages in the request have handles supplied by the formatters. The model must reuse these handles rather than inventing native IDs. The interface resolves outgoing references for its platform.

## Watcher answer

`agents/watcher/prompt.md` asks for one report in the exact template `checkTemplate` of [src/watcher/report.ts](../src/watcher/report.ts) enforces, and a text outside it fails the run with the code below.

The report opens with the title `# Watcher report <day>`, then the metadata rows, each `- <label>: <value>`, in this order: `Observation interval`, `Run id`, `Selected backend`, `Model`, `Effort`, `Effective account`, `Available sources`, `Risk`, `New findings`, `Open findings`. `Risk` is `none`, `critical`, `high`, `medium` or `low`, `New findings` reads `<n>, repeats: <n>`, and `Open findings` reads `critical <n>, high <n>, medium <n>, low <n>`. No other row may say `none`. The engine replaces the interval, run id, backend, model, effort, risk and counts with what it knows. It stamps `observation` and `backend` of the coverage block with the same facts.

The sections of `REPORT_HEADINGS` follow at level two, in order, each once: `Her day`, `Service runs`, `Memory`, `Errors`, `Misunderstandings`, `Project`, `Modules and structure`, `Trash`, `The server`, `Wishes`, `Tasks filed`, `For the owner`. Each holds the subheadings of `REPORT_SUBHEADINGS` at level three, in order: `Observed defects`, `Suspicious evidence`, `Inspected without a finding`, `Unavailable checks`. `For the owner` alone takes `OWNER_SUBHEADINGS`, which opens with `Decisions needed`, and a line there is `- [critical|high|medium|low] <key>: <action>`. An empty subsection says exactly `none`. A line under `Observed defects` or `Suspicious evidence` is `- [critical|high|medium|low] <finding-key>: <text>`, except under `Tasks filed`, where the engine writes its filing lines. Every line of `Misunderstandings`, but under `Unavailable checks`, cites a turn id, `t-` and its hex digits. `findingsOf` and `applyRiskRules` of [src/watcher/risk.ts](../src/watcher/risk.ts) read these lines, and a repeat is saved as `- [low] <finding-key>: <text> (repeat <n>, first <day>)`.

The last thing in the report is one fenced `coverage` block, a JSON object that `checkCoverage` reads: `observation` with `from` and `to`, `backend`, `account`, `sources`, which is not empty, and the lists `defects`, `suspicious`, `inspected` and `unavailable`, which share no item.

| Code | What the text did |
|---|---|
| `secret` | Holds a string shaped like a key |
| `preamble` | Has text before the title |
| `bad-title` | Has no title with a real date |
| `bad-metadata` | Has a row missing, out of order, blank or with a value its row does not take |
| `stray-text` | Has text after the metadata or before a section's first subheading |
| `extra-heading` | Has a heading outside the template, or one twice |
| `missing-heading` | Lacks a section or a subheading |
| `heading-order` | Has its headings out of order |
| `heading-level` | Has a heading at the wrong level, or below level three |
| `empty-subsection` | Has nothing under a subheading |
| `empty-word` | Says nothing in a word other than `none`, or writes `none` beside a finding |
| `coverage-missing` | Has no coverage block |
| `coverage-misplaced` | Has the block inside a section, or a second block |
| `coverage-invalid` | Has a block that does not parse, or lacks a field, or names one item in two lists |
| `trailing-content` | Has something after the block |
| `bad-risk` | Has a finding or decision line with no level and key, or a level on a line that takes none |
| `missing-turn-ref` | Has a line of `Misunderstandings` with no turn id |

One optional fenced `tasks` block may follow the report and is cut from it before the check. The block is a JSON array of objects with the keys `kind`, `title`, `evidence`, `done` and `finding`. `kind` is `fix` or `chore`, and `title`, `evidence` and `done` are nonblank strings. `finding` is the stable key [src/watcher/filing.ts](../src/watcher/filing.ts) compares across runs. A draft files only when its `finding` names a finding line at `medium` or above, and any other draft, one with no `finding` too, gets the receipt state `unmatched-draft`. `splitAnswer` in [src/watcher/tasks.ts](../src/watcher/tasks.ts) parses the block and fails the run with `bad-tasks` on anything else.

The brief carries `<day>`, `<observation from="..." to="..." day-from="..."/>`, `<install>` with the JSON of `installFacts` from [src/watcher/install.ts](../src/watcher/install.ts), and `<report day="...">`, with `run="..."` on an earlier report of the same day. The selfimprovement wake's labels `watcher`, `watcherFinding` and `watcherTask` take `{day}` and `{findings}`, `{title}`, `{state}` and `{task}`, and `{task}`, and nothing else of a report goes into them.

## Labels

`config/labels.json` holds inserted wording and result explanations. Personal wording belongs in `data/config/labels.json`. Preserve every placeholder a label reader supplies. A result code and its label must remain aligned with the catalogue.

### Reason codes

The following table is generated from the code catalogue. Regenerate it with `node scripts/labels-catalogue.ts --write` and check it with `npm run check:codes`.

<!-- codes:begin (generated by scripts/labels-catalogue.ts --write; do not edit by hand) -->
| Code | Status | Values | Wording |
|---|---|---|---|
| `ok` | ok | - | none (success) |
| `shadow` | ok | - | none (internal) |
| `staged` | ok | - | none (internal) |
| `held` | ok | - | none (internal) |
| `skills-off` | denied | - | `tools.result.reasons.skills-off` |
| `feature-off` | denied | - | `tools.result.reasons.feature-off` |
| `safe-mode` | denied | - | `tools.result.reasons.safe-mode` |
| `not-allowed` | denied | - | `tools.result.reasons.not-allowed` |
| `not-grantable` | denied | - | `tools.result.reasons.not-grantable` |
| `not-granted` | denied | - | `tools.result.reasons.not-granted` |
| `owner-only` | denied | - | `tools.result.reasons.owner-only` |
| `unknown-principal` | denied | - | `tools.result.reasons.unknown-principal` |
| `no-requester` | denied | - | `tools.result.reasons.no-requester` |
| `mixed-requesters` | denied | - | `tools.result.reasons.mixed-requesters` |
| `requester-denied` | denied | - | `tools.result.reasons.requester-denied` |
| `self-grant` | denied | - | `tools.result.reasons.self-grant` |
| `not-self-owned` | denied | - | `tools.result.reasons.not-self-owned` |
| `not-requester` | denied | - | `tools.result.reasons.not-requester` |
| `forbidden` | denied | - | `tools.result.reasons.forbidden` |
| `inner-stopped` | denied | - | `tools.result.reasons.inner-stopped` |
| `cooldown` | denied | - | `tools.result.reasons.cooldown` |
| `no-budget` | denied | - | `tools.result.reasons.no-budget` |
| `daily-cap` | denied | - | `tools.result.reasons.daily-cap` |
| `channel-no-permission` | denied | - | `tools.result.reasons.channel-no-permission` |
| `channel-not-visible` | denied | - | `tools.result.reasons.channel-not-visible` |
| `cap-open` | denied | - | `tools.result.reasons.cap-open` |
| `cap-tasks` | denied | - | `tools.result.reasons.cap-tasks` |
| `heartbeat-only` | denied | - | `tools.result.reasons.heartbeat-only` |
| `heartbeat-cap` | denied | - | `tools.result.reasons.heartbeat-cap` |
| `heartbeat-recurring-cap` | denied | - | `tools.result.reasons.heartbeat-recurring-cap` |
| `selfimprovement-only` | denied | - | `tools.result.reasons.selfimprovement-only` |
| `duplicate-task` | denied | - | `tools.result.reasons.duplicate-task` |
| `paused` | denied | - | `tools.result.reasons.paused` |
| `diary-draw-only` | denied | - | `tools.result.reasons.diary-draw-only` |
| `invalid-args` | invalid | - | `tools.result.reasons.invalid-args` |
| `unknown-skill` | invalid | - | `tools.result.reasons.unknown-skill` |
| `unknown-command` | invalid | - | `tools.result.reasons.unknown-command` |
| `unknown-op` | invalid | - | `tools.result.reasons.unknown-op` |
| `unknown-member` | invalid | - | `tools.result.reasons.unknown-member` |
| `unknown-message` | invalid | - | `tools.result.reasons.unknown-message` |
| `message-deleted` | invalid | - | `tools.result.reasons.message-deleted` |
| `held-message` | invalid | - | `tools.result.reasons.held-message` |
| `unknown-file` | invalid | - | `tools.result.reasons.unknown-file` |
| `unknown-gif` | invalid | - | `tools.result.reasons.unknown-gif` |
| `unknown-agent` | invalid | - | `tools.result.reasons.unknown-agent` |
| `unknown-conversation` | invalid | - | `tools.result.reasons.unknown-conversation` |
| `file-expired` | invalid | - | `tools.result.reasons.file-expired` |
| `file-elsewhere` | invalid | - | `tools.result.reasons.file-elsewhere` |
| `target-ambiguous` | invalid | - | `tools.result.reasons.target-ambiguous` |
| `agent-required` | invalid | - | `tools.result.reasons.agent-required` |
| `not-own-message` | invalid | - | `tools.result.reasons.not-own-message` |
| `no-own-message` | invalid | - | `tools.result.reasons.no-own-message` |
| `target-required` | invalid | - | `tools.result.reasons.target-required` |
| `destination-required` | invalid | - | `tools.result.reasons.destination-required` |
| `not-found` | invalid | - | `tools.result.reasons.not-found` |
| `not-open` | invalid | - | `tools.result.reasons.not-open` |
| `bad-goal` | invalid | - | `tools.result.reasons.bad-goal` |
| `bad-sort` | invalid | - | `tools.result.reasons.bad-sort` |
| `bad-page` | invalid | - | `tools.result.reasons.bad-page` |
| `bad-time` | invalid | - | `tools.result.reasons.bad-time` |
| `bad-every` | invalid | - | `tools.result.reasons.bad-every` |
| `bad-attend` | invalid | - | `tools.result.reasons.bad-attend` |
| `bad-deadline` | invalid | - | `tools.result.reasons.bad-deadline` |
| `bad-due` | invalid | - | `tools.result.reasons.bad-due` |
| `bad-expiry` | invalid | - | `tools.result.reasons.bad-expiry` |
| `bad-move` | invalid | - | `tools.result.reasons.bad-move` |
| `bad-provenance` | invalid | - | `tools.result.reasons.bad-provenance` |
| `attend-with-due` | invalid | - | `tools.result.reasons.attend-with-due` |
| `attend-with-every` | invalid | - | `tools.result.reasons.attend-with-every` |
| `every-without-due` | invalid | - | `tools.result.reasons.every-without-due` |
| `due-after-expiry` | invalid | - | `tools.result.reasons.due-after-expiry` |
| `not-attend` | invalid | - | `tools.result.reasons.not-attend` |
| `not-recurring` | invalid | - | `tools.result.reasons.not-recurring` |
| `no-next` | invalid | - | `tools.result.reasons.no-next` |
| `no-purpose` | invalid | - | `tools.result.reasons.no-purpose` |
| `reason-required` | invalid | - | `tools.result.reasons.reason-required` |
| `no-errand` | invalid | - | `tools.result.reasons.no-errand` |
| `errand-ended` | invalid | - | `tools.result.reasons.errand-ended` |
| `wait-without-errand` | invalid | - | `tools.result.reasons.wait-without-errand` |
| `terminal` | invalid | - | `tools.result.reasons.terminal` |
| `slept` | invalid | - | `tools.result.reasons.slept` |
| `duplicate-id` | invalid | - | `tools.result.reasons.duplicate-id` |
| `candidate-external` | denied | - | `tools.result.reasons.candidate-external` |
| `candidate-same-turn` | denied | - | `tools.result.reasons.candidate-same-turn` |
| `candidate-same-chain` | denied | - | `tools.result.reasons.candidate-same-chain` |
| `empty-query` | invalid | - | `tools.result.reasons.empty-query` |
| `no-query` | invalid | - | `tools.result.reasons.no-query` |
| `no-link` | invalid | - | `tools.result.reasons.no-link` |
| `no-media` | invalid | - | `tools.result.reasons.no-media` |
| `not-video-site` | invalid | - | `tools.result.reasons.not-video-site` |
| `invalid-action` | invalid | - | `tools.result.reasons.invalid-action` |
| `invalid-emoji` | invalid | - | `tools.result.reasons.invalid-emoji` |
| `scheme` | invalid | - | `tools.result.reasons.scheme` |
| `loop-cap` | invalid | - | `tools.result.reasons.loop-cap` |
| `malformed-call` | invalid | - | `tools.result.reasons.malformed-call` |
| `truncated-call` | invalid | - | `tools.result.reasons.truncated-call` |
| `not-configured` | not_configured | {feature} | `tools.result.reasons.not-configured` |
| `unsupported` | not_configured | - | `tools.result.reasons.unsupported` |
| `no-guild` | not_configured | - | `tools.result.reasons.no-guild` |
| `error` | failed | - | `tools.result.reasons.error` |
| `timeout` | unknown | {what} | `tools.result.reasons.timeout` |
| `cap` | failed | {what} | `tools.result.reasons.cap` |
| `provider` | failed | {status} | `tools.result.reasons.provider` |
| `http` | failed | {status} | `tools.result.reasons.http` |
| `network` | failed | - | `tools.result.reasons.network` |
| `private` | failed | - | `tools.result.reasons.private` |
| `type` | failed | - | `tools.result.reasons.type` |
| `size` | failed | - | `tools.result.reasons.size` |
| `redirects` | failed | - | `tools.result.reasons.redirects` |
| `turn-cap` | failed | - | `tools.result.reasons.turn-cap` |
| `runner-down` | failed | - | `tools.result.reasons.runner-down` |
| `board-unavailable` | failed | - | `tools.result.reasons.board-unavailable` |
| `write-failed` | failed | - | `tools.result.reasons.write-failed` |
| `file-unreadable` | failed | - | `tools.result.reasons.file-unreadable` |
| `attachment-too-large` | failed | - | `tools.result.reasons.attachment-too-large` |
| `gif-failed` | partial | - | `tools.result.reasons.gif-failed` |
| `no-result` | failed | - | `tools.result.reasons.no-result` |
| `send-failed` | failed | - | `tools.result.reasons.send-failed` |
| `diary-mirror` | failed | - | `tools.result.reasons.diary-mirror` |
| `link-closed` | unknown | - | `tools.result.reasons.link-closed` |
| `link-busy` | failed | - | `tools.result.reasons.link-busy` |
| `adapter-threw` | unknown | - | `tools.result.reasons.adapter-threw` |
| `refused` | failed | - | `tools.result.reasons.refused` |
| `image-cap` | failed | - | `tools.result.reasons.image-cap` |
| `image-moderation` | failed | - | `tools.result.reasons.image-moderation` |
| `image-timeout` | failed | - | `tools.result.reasons.image-timeout` |
| `image-error` | failed | - | `tools.result.reasons.image-error` |
| `image-empty` | failed | - | `tools.result.reasons.image-empty` |
| `unsupported-model` | failed | - | `tools.result.reasons.unsupported-model` |
| `ability-unavailable` | failed | {ability} {why} | `tools.result.reasons.ability-unavailable` |
| `speech-prepare-failed` | failed | - | `tools.result.reasons.speech-prepare-failed` |
| `speech-synth-failed` | failed | - | `tools.result.reasons.speech-synth-failed` |
| `speech-convert-failed` | failed | - | `tools.result.reasons.speech-convert-failed` |
| `speech-not-configured` | not_configured | - | `tools.result.reasons.speech-not-configured` |
| `done` | ok | - | `wake.feedback.codes.done` |
| `cancelled` | failed | - | `wake.feedback.codes.cancelled` |
| `expired` | failed | - | `wake.feedback.codes.expired` |
| `forgotten` | failed | - | `wake.feedback.codes.forgotten` |
| `dm-off` | failed | - | `wake.feedback.codes.dm-off` |
| `not-writable` | failed | - | `wake.feedback.codes.not-writable` |
| `unavailable` | failed | - | `wake.feedback.codes.unavailable` |
| `no-review-channel` | failed | - | `wake.feedback.codes.no-review-channel` |
| `keys-exhausted` | failed | - | `wake.feedback.codes.keys-exhausted` |
| `pending-full` | failed | - | none (internal) |
| `pending-expired` | failed | - | none (internal) |
| `pending-outranked` | failed | - | none (internal) |
| `wait` | ok | - | none (internal) |
| `rewait` | ok | - | none (internal) |
| `recurred` | ok | - | none (internal) |
| `done-occurrence` | ok | - | none (internal) |
| `dropped` | ok | - | none (internal) |
| `errand-missing` | failed | - | none (internal) |
| `wait-deadline` | failed | - | none (internal) |
| `disconnected` | failed | - | none (internal) |
| `closed` | failed | - | none (internal) |
| `bad-line` | failed | - | none (internal) |
| `moved` | ok | - | none (internal) |
<!-- codes:end -->
