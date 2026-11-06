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
| Media pick | [prompt](../prompts/media-pick.md) as `prompts['media-pick']`, its request and answer in [src/behavior/media-pick.ts](../src/behavior/media-pick.ts), its lines from `labels.gifs` |
| Heartbeat wake | [heartbeat prompt](../prompts/heartbeat.md), `<wake>` from [src/behavior/wake.ts](../src/behavior/wake.ts), its calls in [src/tools/wake-tools.ts](../src/tools/wake-tools.ts) |
| Selfimprovement wake | [wake prompt](../prompts/selfimprovement.md) as `prompts.selfimprovement`, `<wake>` from [src/behavior/selfimprovement-text.ts](../src/behavior/selfimprovement-text.ts) with `labels.wake.selfimprovement`, its calls in [src/tools/wake-tools.ts](../src/tools/wake-tools.ts) |
| Development brief | [brief](../prompts/executor-brief.md) as `prompts['executor-brief']`, filled by `briefFrom` in [src/development/brief.ts](../src/development/brief.ts), after the agent's `agents/<name>/prompt.md` in [bin/development.ts](../bin/development.ts) |
| Agent instructions | [profile loader](../src/agent-runner/profiles.ts) |
| Query builder | [prompt](../prompts/query-builder.md) as `prompts['query-builder']`, filling `{{name}}`, `{{today}}` and `{{skills}}`, with `<transcript>` and `<candidate>` from `lookupClassifierInput` in [src/turn/lookup-input.ts](../src/turn/lookup-input.ts). It answers `none` or the labelled lines `web:`, `history:`, `who:`, `when:`, `when-role:`, `recent:` and `skills:`, parsed by `parseQueryPlan` in [src/behavior/query-builder.ts](../src/behavior/query-builder.ts). A local `data/prompts/lookup.md` loads as `query-builder` |
| Summary builder | [recall-summary](../prompts/recall-summary.md) and [search-summary](../prompts/search-summary.md), parsed by `parseSummaryNote` in [src/behavior/summary-builder.ts](../src/behavior/summary-builder.ts): a first line `stretch: <n>` for chat evidence, then the note, or the single word `none` |
| Elsewhere pick | [prompt](../prompts/elsewhere-pick.md) as `prompts['elsewhere-pick']`, `{{name}}` filled, with `<places>` and `<episodes>` (each left out with no line), `<episode_ages>`, `<transcript>` and `<candidate>` from `buildElsewhereRequest` in [src/behavior/elsewhere-pick.ts](../src/behavior/elsewhere-pick.ts). It answers `place: <n>[ earlier] \| none` and `episodes: <n>, <n> \| none`, parsed by `parseElsewhereAnswer`. The turn prompt `prompts/elsewhere.md` is the persona's own turn in a read-only place and a different thing |
| Selfreflection planner | [prompt](../prompts/selfreflection-planner.md) as `prompts['selfreflection-planner']`, `{{name}}` filled, with `<now>`, `<places>`, `<about_chat>`, `<recent>`, `<lore>`, `<world>`, `<diary>`, `<kinds>`, `<seeds>` and `<topic>`, each left out when empty, from `buildSelfreflectionPlanRequest` in [src/behavior/prompt.ts](../src/behavior/prompt.ts). It answers one JSON object with `kind`, `brief`, `search` and `picture`, read by `validatePlan` in [src/behavior/selfreflection.ts](../src/behavior/selfreflection.ts). A local `data/prompts/diary-plan.md` loads as `selfreflection-planner` |
| Selfreflection writer | [prompt](../prompts/selfreflection.md) as `prompts.selfreflection`, the task of a turn of the mode `selfreflection`, with `<world>`, `<diary>`, `<plan>`, `<seeds>`, `<found>` and the blocks of [Selfreflection audience](#selfreflection-audience). The seed list is [selfreflection-seeds](../prompts/selfreflection-seeds.md) as `prompts['selfreflection-seeds']`. A local `data/prompts/diary.md` loads as `selfreflection`, and `data/prompts/diary-seeds.md` as `selfreflection-seeds` |
| Address classifier | [prompt](../prompts/address.md) as `prompts.address`, `{{name}}` filled, with `<aliases>`, the names the owner gave her person record (`ownerNamesOf` in [src/memory/db/people-read.ts](../src/memory/db/people-read.ts); the same names open the door's alias gate), `<transcript>`, `<author>` and `<candidate>` from [src/pipeline/classifier-request.ts](../src/pipeline/classifier-request.ts). It answers `yes`, `overheard` or `no` for a line with or without the interface's flags, parsed by `parseAddressAnswer` in [src/behavior/mention.ts](../src/behavior/mention.ts) |

`prompts/system-prompt.md` and the turn prompts name no platform and no server: they speak of the places she is in and follows, and the interface's own text names its platform. The heartbeat and selfimprovement prompts are addressed to the persona and fill no placeholder. The development brief is addressed to a thinker or a dev and fills `{{id}}`, `{{title}}`, `{{branch}}`, `{{generation}}`, `{{evidence}}`, `{{examples}}`, `{{counterexamples}}`, `{{benefit}}`, `{{evaluation}}`, `{{acceptance}}`, `{{answers}}` and `{{children}}`. It carries no output tag: an agent acts on the task through the board. A local `data/prompts/selfdev.md` loads as `executor-brief`.

Read the actual template before editing it. A placeholder is an input supplied by its caller, not free prose. Preserve its spelling and inspect the caller when changing what it means. Model-facing phrases belong in the relevant prompt or label file rather than being embedded in runtime code.

## Request layout

Stable persona instructions and tool information precede changing conversational context. Relevant memory, people, place and recent messages are assembled within context budgets. Changing this order can affect prompt-cache reuse as well as behavior.

`<spatial_awareness>` sits in the tail of every turn's request, after `<chat>` and before `<now>`, so a move between places leaves the cached parts as they were. `spatialAwarenessText` in [src/turn/request/spatial.ts](../src/turn/request/spatial.ts) builds it from `labels.spatial`. In a place its first line is `place` with `{path}`, `{iface}` and `{when}`. `{path}` is the place and every place above it, the place first, each through `kinds.<kind>` with `{name}` and joined with `within`. A kind with no label reads `kinds.place`, and a place with no stored name reads `unnamed`. The second line is `private` or `group`, and the third is `note` with `{note}`, the owner's note from `config.spatial.notes` on the nearest place of the chain that has one. The command line reads `cli`, a wake with no conversation place (a review, a heartbeat or a selfimprovement wake) reads `server`, and a selfreflection post reads `world`, each with `{when}` alone. `{when}` is the present moment, so a request with the block keeps only her recent time away in `<now>`.

No `<wake>` and no other block states a budget, a count of turns left or a reset: `labels.wake` holds no `budgets` or `budget` key, and the limits (`wakes.caps.perChain`) act without being told to her.

The active skill index contains descriptions; `skill.read` retrieves the procedure when needed. Tool transport can be native or textual, and the corresponding request builder must agree with the parser. See [core](core.md) for the turn loop and [memory](memory.md) for audience selection.

## Output

The conversation parser recognizes `<think>`, `<msg>`, `<react>` and `<skip/>`. The tracked `format.md` tells her of a unicode emoji in `<react>`. A custom one as `:name:` still resolves through the emoji index, and the interface's capability text says so where an interface offers them. A message can name a reply target, and a reaction names its target message. Native tool calls arrive separately; textual tool calls are extracted before the conversation parser runs. On Claude's subscription route the model sees each tool as `mcp__nep__<name>`, and `bareToolName` in `src/tools/gateway.ts` strips the prefix before anything reads the call.

`parseOutput` in `src/llm/parse.ts` reads the `<msg>` tags outside inline code and fences, so a tag example in code stays literal text. An opening `<msg>` while a message is open ends that message there. A last `<msg>` that is never closed ends at the first `<react>` or `<skip/>` after it, or with the output. Its words go out when the answer stopped on its own. The caller passes `cutOff` for an answer cut at the output cap, as `src/turn/phases/response.ts` and the sandbox in `src/behavior/sandbox.ts` do for the finish reason `length`, and that last message is dropped. A `</msg>` with no open message is never sent.

`parseOutput` reads the `<react>` tags outside inline code and fences too. A reaction's emoji is the text up to its `</react>`, or up to an earlier `<msg>`, `</msg>`, `<react>` or `<skip/>`, which ends the reaction there. A message inside a reaction stays a message, and the reaction keeps the emoji alone. A reaction inside a closed message acts, and the message goes out with its words and without the reaction. A reaction that nothing ends is dropped.

An output with such a breach yields one `{ kind: 'msgMalformed', nested, unclosed, stray }` diagnostic, placed before any `messagesMerged`. It holds counts and no contents, and a message dropped by `cutOff` is not counted. The persona reads it through `labels.tools.diagnostics.msgMalformed`, whose `{count}` is the sum of the three counts.

Think text is private planning, not a public chat message. The request archive keeps each response as it came in `response_text`, and its parsed think in `think`.

## Standards of output and stored text

These are rules of the project, held in the tracked prompts and in code, and no local layer sets them. No model checks them.

Every reply of a turn carries one whole `<think>`, written in English, and it never reaches a sent message. Her replies are in any language. Every stored media text form is in English, with speech, captions and on-screen text quoted in their original language.

`thinkMissing` in `src/behavior/tool-step.ts` counts a reply that does not open with its think. `shapedThink` in `src/llm/parse.ts` puts an empty `<think></think>` in front of a reply with text and no think tag, and the next request of the turn hands that shape on. A reply request's archive row holds `''` in `think`. Her words stay as they are.

`parseOutput` names a broken think in `thinkLeak`: `unopened` for a closing tag with no opening, with the diagnostic `thinkUnopened`, and `unclosed` for an opening never closed, with `thinkOpen` and the diagnostic `thinkUnclosed`. A think tag in any other spelling, inside a message or a code span included, counts as broken. In code a whole `<think></think>` is broken too: it takes the shape of the first tag there, and nothing of the code moves into `think`. Such an answer has no action at all, and the parser never repairs it.

`askUnleaked` in `src/turn/calls.ts` drops such an answer whole, its calls included, and sends the same request once more. A second one ends the turn with the outcome `skip` and the reason `think-leaked`, with nothing further sent and the fact `labels.tools.diagnostics.thinkLeaked` for her next request. What earlier steps of the turn posted stands. An unclosed think with the finish reason `length` is no leak and ends on the `cut-off` path with no second request.

A `message.create` call whose text holds a think tag is refused with the code `think-in-text` and sends nothing.

`isOffScript` in `src/memory/text-standard.ts` tells whether more than half of a text's letters are outside the Latin script, with closed pairs of quotes left out. A think that is off script is counted and acted on all the same. A description, a GIF watch or a video summary that is off script is described again once. The second answer stands with `redescribed` on the entry, and `offScript` too when it fails the standard again. A first answer whose second request failed stands with `offScript`.

A turn's journal record counts these in `format`: `thinkMissing`, `thinkLeaked`, `leakEnded`, `tagInOutgoing` and `thinkOffScript`. `standardFacts` in `src/watcher/requests.ts` sums them with the marks on the descriptions for [the watcher](watcher.md#service-runs).

A `<gif>` is a retired tag, like a call tag and a draw tag: `parseOutput` cuts it out and tells it as a `retiredTag` diagnostic, and an answer that holds nothing else is silence.

### Media pick

`createMediaPick` in `src/behavior/media-pick.ts` sends one request on the `analyzer` role with the purpose `media-pick` after a reply, on an interface that declares `mediaPick`. The system message is `prompts/media-pick.md` with `{{name}}`. The user message holds `<gifs>`, one line per candidate through `labels.gifs.entry` with its handle and caption, `<gifs_recent>` when she posted one of them in this place in the last 24 hours, with its handle and `labels.gifs.ownMark`, `<emoji>` on an interface with the emoji form, one line per candidate through `labels.emoji.entry` or `labels.emoji.entryNoText`, then `<context>` and `<reply>`. An empty block is left out.

The answer is one line, `none`, `gif <handle>`, `emoji <name>` or `replace <name>`, in any case and spacing. `parseMediaPick` reads anything else as `none`: a name the request did not list, an action the interface does not support, and two forms in one line. `none` is the normal answer. The persona's turn carries no block of this request, and `<skip/>` stays her word: no pick prompt uses it.

### Selfreflection audience

A selfreflection writer request carries `<publication_places>` after `<plan>` and `<seeds>`, and the block is never cut. Its first line is `selfreflection.publicationPlaces` from `config/labels.json`, which states the output contract, followed by one `interface:<iface>` line per interface and one `place:<place id> <name>` line per group place, indented under its parent. The block is absent when memory knows no place.

The answer may add `<audience>unrestricted | interface:x | place:y</audience>`, one of the three, with the token alone. `takeAudience` in `src/llm/parse.ts` removes the tag from a selfreflection answer before the conversation parser runs and leaves a think block and code alone. `audienceChoice` in `src/tools/publication.ts` reads the bodies into `result.selfreflection.audience`, which is `{ ok: true, audience }` or `{ ok: false, code }` with `audience-unknown-place`, `audience-unknown-interface` or `audience-malformed`. No other mode reads the tag.

A selfreflection writer request after a refusal also carries `<audience_refused>`, right after `<publication_places>` and never cut, with one `selfreflection.audienceRefused` line per post she has not heard of. The line fills `{date}`, `{gist}` and `{reason}`, and `{reason}` is the code's entry in `selfreflection.audienceReasons`.

The contract lives in the label because a nonempty `data/prompts/selfreflection.md` replaces `prompts/selfreflection.md` whole. A deployment with its own `selfreflection.md` needs no change for the tag to work, and its `data/config/labels.json` may reword `selfreflection.publicationPlaces`. [The selfreflection](selfreflection.md#audience) describes what the stored audience does.

### Stored facts in a request

The retrieval service's facts reach a model in four places, and each is absent while it holds no fact, so a request on a memory with none keeps its bytes. `<retrieved>` of a turn holds `<excerpt>`s under `labels.prefetch.factExcerpt` (`{n}`, `{source}` from `labels.prefetch.sources.fact`, `{state}`), after the windows and inside `recall.prefetch.maxTokens`. A `memory.search` result ends with `labels.tools.tools.memory.facts`, one `.fact` (`{state}`, `{text}`) per fact and `.factsCut` when more exist. `<wake>` ends with `labels.wake.memory.header` and one `labels.wake.memory.fact` per fact. A selfreflection plan request holds `<stored_facts>` after `<topic>`, under `labels.selfreflectionFacts.header` and `labels.selfreflectionFacts.fact`. `{state}` always comes from `labels.prefetch.factStates`: one word per state and `negative`, joined with a comma. Her text is shown as she wrote it.

`memory.search` takes `entity`, `predicate`, `as_of` and `historical` beside its other arguments, each described in `config/tools.json` and read by `toArgs` in `src/tools/definitions.ts`. It has no argument for authority or a destination. An `as_of` that is no date is `invalid` with `args.as_of`.

### Place names in a read

`memory.search` and `conversation.read` take a `channel` that may be a handle, a native id, a mention or a name. `matchPlace` in `src/tools/place-names.ts` compares a name with the places she may read, and with the learned stemmer it stems every word of both sides first. A comparison drops case, accents, emoji, punctuation and spaces. `readablePlaces` in `src/behavior/readable-places.ts` decides which places those are: the channels the pull rail lets the turn read, judged against the partner in a private chat and against the owner's account on the command line.

A name that fits more than one place is refused `target-ambiguous`, and one that fits none `invalid-args` with `args.channel:unknown-channel`. Both refusals carry `choices`, and `src/turn/skill-calls.ts` puts their text in the result's `data.text` through `labels.tools.tools.place`. The lead is `several` or `none` (`{given}`, `{count}`), `line` repeats once per choice (`{name}` and `{ref}`, the token to write: `#handle` or the id), and `more` (`{count}`) closes a list cut at `PLACE_CHOICES_MAX`. A place she may not read is never matched and never listed.

### Errand result

`errandResultText` in `src/errands/blocks.ts` writes the finished errand she reads from `labels.errands.result`. When the runner counted failed web searches (`result.searchFailures`, OpenCode's `websearch` calls that ended in an error), it adds `searchFailed` with `{count}` after the reason line, on a done errand and on a failed one alike. A run with no failed search adds nothing.

### Mention handles

People, channels and messages in the request have handles supplied by the formatters. The model must reuse these handles rather than inventing native IDs. The interface resolves outgoing references for its platform.

### Memory session answer

A memory session answers `<think>`, then one `<memory>` block holding a JSON object. `parseSessionAnswer` in `src/memory/db/session.ts` reads the block and `validateAnswer` checks its groups: `claims`, `episodes`, `affinity`, `descriptions`, `people`, `entities` and `assertions`, as `prompts/memory-session.md` spells them. Any other group counts one `unknown_group`, and a dropped op counts its reason in `counts.dropped`.

An author of a batch line carries a handle `aN` only while the account has no person. `buildSessionRequest` gives her own accounts no handle and leaves them out of `<people>`, and the account of the owner's command line holds his person from its first line, so `people` names neither. The prompt's "People" section says that both are known, and the writer refuses an add for either as `rejected:known_person` (`src/memory/db/session-write.ts`).

`validateSemanticAnswer` in `src/memory/db/semantic-answer.ts` takes the last two groups. An entity holds `handle`, `kind`, `name`, `language` and `sources`. An assertion holds `predicate` (`id` and `version`), `assertionKind`, `text`, `arguments`, `polarity`, `how`, `sources`, and optionally `state`, `validFrom`, `validTo` and `premises` (`handle` and `role`). A premise handle is a `vN` of `<retrieved>`, resolved through `maps.priorVersions`, and any other handle is `unknown_version`. An argument holds `role`, `position` and one of `ref` or `literal`. A field outside these is `unknown_field`, a line outside the batch is `unknown_source`, a `ref` that names no person, place or entity of this answer is `unknown_ref`, and the op goes whole. `text` is stored byte for byte.

A session request may carry `<retrieved>` before `<batch>`, when the retrieval service found structured facts for the batch under the scope's context, as of the batch's newest line. It lists stored entities (`[xN] name`), facts with their standing (`[vN] (state) text {xN}`) and the older lines they rest on, numbered on past the batch (`#n [time] text`). `buildSessionRequest` records each item in `reads` and in `maps.priorEntities`, `maps.priorVersions` and `maps.sources`, so an answer may name `xN` as a `ref` or a description's `subject`, `vN` as a premise and those `#n` as sources, and a claim shown here licenses no line this block does not show. With no fact the block is absent and the request is byte for byte what it was.

The writer refuses what only the database can judge, and each refusal is a `decisions` row `rejected:<code>` that leaves the other ops standing. `validateSemanticCandidate` in `src/memory/db/semantic-write.ts` answers `unknown_kind`, `bad_name`, `unknown_predicate`, `bad_assertion_kind`, `bad_role`, `bad_arity`, `bad_endpoint`, `bad_literal`, `bad_how`, `bad_polarity`, `bad_state`, `bad_interval`, `no_text`, `no_evidence`, `bad_evidence`, `unknown_source`, `unread_source`, `out_of_scope`, `unknown_ref`, `unknown_version`, `unread_version`, `bad_dependency`, `stale_base`, `premise_cycle` or `equivalence_loop`. The predicates and kinds the prompt lists are `INITIAL_PREDICATES` and `INITIAL_ENTITY_KINDS` in `src/memory/db/semantic-registry.ts`. A nonempty `data/prompts/memory-session.md` replaces the shipped file whole, so a deployment with its own copy offers these two groups only after adding them.

## Watcher answer

`agents/watcher/prompt.md` asks for one report in the exact template `checkTemplate` of [src/watcher/report.ts](../src/watcher/report.ts) enforces, and a text outside it fails the run with the code below.

The report opens with the title `# Watcher report <day>`, then the metadata rows, each `- <label>: <value>`, in this order: `Observation interval`, `Run id`, `Selected backend`, `Model`, `Effort`, `Effective account`, `Available sources`, `Risk`, `New findings`, `Open findings`. `Risk` is `none`, `critical`, `high`, `medium` or `low`, `New findings` reads `<n>, repeats: <n>`, and `Open findings` reads `critical <n>, high <n>, medium <n>, low <n>`. No other row may say `none`. The engine replaces the interval, run id, backend, model, effort, risk and counts with what it knows. It stamps `observation` and `backend` of the coverage block with the same facts.

The sections of `REPORT_HEADINGS` follow at level two, in order, each once: `Her day`, `Service runs`, `Memory`, `Errors`, `Misunderstandings`, `Project`, `Modules and structure`, `Trash`, `The server`, `Development`, `Wishes`, `Tasks filed`, `For the owner`. `Development` belongs to the template only in development mode (`developmentMode` of [src/watcher/development.ts](../src/watcher/development.ts)), and `checkTemplate` with the mode off refuses the heading as `extra-heading`. An answer that holds it with the mode off loses it before the check. Each holds the subheadings of `REPORT_SUBHEADINGS` at level three, in order: `Observed defects`, `Suspicious evidence`, `Inspected without a finding`, `Unavailable checks`. `For the owner` alone takes `OWNER_SUBHEADINGS`, which opens with `Decisions needed`, and a line there is `- [critical|high|medium|low] <key>: <action>`. An empty subsection says exactly `none`. A line under `Observed defects` or `Suspicious evidence` is `- [critical|high|medium|low] <finding-key>: <text>`, except under `Tasks filed`, where the engine writes its filing lines. Every line of `Misunderstandings`, but under `Unavailable checks`, cites a turn id, `t-` and its hex digits. `findingsOf` and `applyRiskRules` of [src/watcher/risk.ts](../src/watcher/risk.ts) read these lines, and a repeat is saved as `- [low] <finding-key>: <text> (repeat <n>, first <day>)`.

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

One optional fenced `tasks` block may follow the report and is cut from it before the check. The block is a JSON array of objects with the keys `kind`, `title`, `evidence`, `done` and `finding`, and `command` in development mode. `kind` is `fix` or `chore`, and `title`, `evidence` and `done` are nonblank strings. `command` is a string, a blank one counts as none, and `reproducingCommand` of [src/watcher/development.ts](../src/watcher/development.ts) judges it. In development mode a draft left to file with no command that passes gets the receipt state `hypothesis` and files nothing. `finding` is the stable key [src/watcher/filing.ts](../src/watcher/filing.ts) compares across runs. A draft files only when its `finding` names a finding line at `medium` or above, and any other draft, one with no `finding` too, gets the receipt state `unmatched-draft`. `splitAnswer` in [src/watcher/tasks.ts](../src/watcher/tasks.ts) parses the block and fails the run with `bad-tasks` on anything else.

The brief carries `<day>`, `<observation from="..." to="..." day-from="..."/>`, `<install>` with the JSON of `installFacts` from [src/watcher/install.ts](../src/watcher/install.ts), `<memory>` with one line per stored fact about failures when `watcherMemory` finds any, in development mode `<development>` with the JSON of `developmentBrief` (`folder`, `repository`, `base`, `scratch`, `testForm`, `facts`, the facts holding the CI summary of `main` as `ci`) and `<audit-topic>` with one topic of `watcher.auditTopics` when the list has any, and `<report day="...">`, with `run="..."` on an earlier report of the same day. A second attempt holds the first brief whole, then `agents/watcher/retry.md`, then `<refusal code="...">` with the check's detail and `<previous-answer>` with the refused text, a string shaped like a key masked. The selfimprovement wake's labels `watcher`, `watcherFinding` and `watcherTask` take `{day}` and `{findings}`, `{title}`, `{state}` and `{task}`, and `{task}`, and nothing else of a report goes into them.

## Media text forms

A transcript and what she voiced are quoted speech as a whole. The transcript labels `voiceDescribed` and `audioDescribed` take `{duration}` and `{text}`, and `audioDescribed` also `{name}`. `fileUnreadable` and `stickerUnreadable` take `{name}` and state that no model can read the item. `senses.voiceHeard` replaces `senses.voice` while the `video` role is on. The prompt `describe-audio` takes `{{maxChars}}` and `{{today}}`. `describe-translate` takes `{{maxChars}}`, 500 for a description and 1500 for a video summary. It is the system message of the owner's `backfill-english` run on the `vision` or `video` role, with the purpose `describe-translate` and a stored description as the user message. Its answer is kept on one line and cut at `{{maxChars}}`. The memory session's `<batch>` shows a line's media with the same tags as the turn's chat, and numbers a line that holds only media.

## Labels

`config/labels.json` holds inserted wording and result explanations. Personal wording belongs in `data/config/labels.json`. Preserve every placeholder a label reader supplies. A result code and its label must remain aligned with the catalogue.

### Reason codes

The following table is generated from the code catalogue. Regenerate it with `node scripts/labels-catalogue.ts --write` and check it with `npm run check:codes`.

When a result's `values.reason` has wording in `tools.result.params.reason`, `reasonText` adds it after the code's wording and a colon. Quick search's `not-configured` and `provider` use this to say which cause holds.

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
| `selfreflection-draw-only` | denied | - | `tools.result.reasons.selfreflection-draw-only` |
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
| `think-in-text` | invalid | - | `tools.result.reasons.think-in-text` |
| `not-configured` | not_configured | {feature} | `tools.result.reasons.not-configured` |
| `unsupported` | not_configured | - | `tools.result.reasons.unsupported` |
| `no-place` | not_configured | - | `tools.result.reasons.no-place` |
| `PLACE_REQUIRED` | not_configured | - | `tools.result.reasons.PLACE_REQUIRED` |
| `PERSON_NOT_FOUND` | invalid | - | `tools.result.reasons.PERSON_NOT_FOUND` |
| `PLACE_NOT_FOUND` | invalid | - | `tools.result.reasons.PLACE_NOT_FOUND` |
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
| `selfreflection-mirror` | failed | - | `tools.result.reasons.selfreflection-mirror` |
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
| `proxy-down` | failed | - | `wake.feedback.codes.proxy-down` |
| `proxy-back` | ok | - | `wake.feedback.codes.proxy-back` |
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
