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
| Description merge of `/memory bind` | [prompt](../prompts/description-merge.md) as `prompts['description-merge']`, built by `bindAccount` in [src/memory/db/person-bind.ts](../src/memory/db/person-bind.ts). See [Description merge](#description-merge) |
| Media pick | [prompt](../prompts/media-pick.md) as `prompts['media-pick']`, its request and answer in [src/behavior/media-pick.ts](../src/behavior/media-pick.ts), its lines from `labels.gifs` |
| Heartbeat wake | [heartbeat prompt](../prompts/heartbeat.md), why she is awake and `<feedback>` from [src/behavior/wake.ts](../src/behavior/wake.ts), its calls in [src/tools/wake-tools.ts](../src/tools/wake-tools.ts) |
| Selfimprovement wake | [wake prompt](../prompts/selfimprovement.md) as `prompts.selfimprovement`, `<work>` and `<board>` from [src/behavior/selfimprovement-text.ts](../src/behavior/selfimprovement-text.ts) with `labels.wake.selfimprovement`, its calls in [src/tools/wake-tools.ts](../src/tools/wake-tools.ts) |
| Development brief | [brief](../prompts/executor-brief.md) as `prompts['executor-brief']`, filled by `briefFrom` in [src/development/brief.ts](../src/development/brief.ts), after the agent's `agents/<name>/prompt.md` in [bin/development.ts](../bin/development.ts) |
| Agent instructions | [profile loader](../src/agent-runner/profiles.ts) |
| Query builder | [prompt](../prompts/query-builder.md) as `prompts['query-builder']`, filling `{{name}}`, `{{today}}` and `{{skills}}`, with `<transcript>` and `<candidate>` from `lookupClassifierInput` in [src/turn/lookup-input.ts](../src/turn/lookup-input.ts). It answers one JSON object with `web`, `history`, `who`, `when`, `when_role`, `recent` and `skills`, each a text or null. `when_role` is `scope` or `locator`, `recent` is `yes` or `no`, and every field null is none. `QUERY_PLAN_FORMAT` in [src/behavior/query-builder.ts](../src/behavior/query-builder.ts) sends its schema as the strict `response_format`, and `parseQueryPlan` in the same file reads each field as the line of its label was read. Any other answer, a missing field or a value outside its set included, plans nothing and is `unparsed`. A local `data/prompts/lookup.md` loads as `query-builder` |
| Summary builder | [recall-summary](../prompts/recall-summary.md) and [search-summary](../prompts/search-summary.md), parsed by `parseSummaryNote` in [src/behavior/summary-builder.ts](../src/behavior/summary-builder.ts): a first line `stretch: <n>` for chat evidence, then the note, or the single word `none` |
| Selfreflection planner | [prompt](../prompts/selfreflection-planner.md) as `prompts['selfreflection-planner']`, `{{name}}` filled, the `<task>` of a request of the kind `selfreflection_plan` on the frame (see [Selfreflection on the frame](#selfreflection-on-the-frame)), built by `plannerRequest` in [src/turn/phases/request/build.ts](../src/turn/phases/request/build.ts). It answers one JSON object with `kind`, `brief`, `search`, `picture` and `seed`, the 1-based number of the `<seeds>` combination the brief builds on or 0 for none. `selfreflectionPlanFormat` in [src/behavior/selfreflection.ts](../src/behavior/selfreflection.ts) sends its schema as the strict `response_format`, with `kind` an enum of the kinds the request offers, and `parsePlanAnswer`, `validatePlan` and `planSeed` in the same file read it. Any other answer, a missing field or a kind outside the offer included, is a broken plan. A local `data/prompts/diary-plan.md` loads as `selfreflection-planner` |
| Selfreflection writer | [prompt](../prompts/selfreflection.md) as `prompts.selfreflection`, the `<task>` of a turn of the mode `selfreflection`, a request of the kind `selfreflection` on the frame (see [Selfreflection on the frame](#selfreflection-on-the-frame) and [Selfreflection audience](#selfreflection-audience)). The seed list is [selfreflection-seeds](../prompts/selfreflection-seeds.md) as `prompts['selfreflection-seeds']`. A local `data/prompts/diary.md` loads as `selfreflection`, and `data/prompts/diary-seeds.md` as `selfreflection-seeds` |
| Selfreflection plan fill | [prompt](../prompts/selfreflection-plan-fill.md) as `prompts['selfreflection-plan-fill']`, with no placeholder, the system message of the owner's `backfill-plans` run on the `analyzer` role with the purpose `selfreflection-plan-fill`. The user message from [src/memory/db/selfreflection-plan-fill.ts](../src/memory/db/selfreflection-plan-fill.ts) holds `<kind>`, `<entry>`, `<scene>` and `<families>`, each left out when empty. `<families>` comes only with an entry asked for seed lines: a `# name` line per family of `prompts['selfreflection-seeds']`, then its lines. It answers the JSON object `{ "brief": ... }`, with one field per family, named after it, when `<families>` was sent. `planFillSchema` sends the schema as the strict `response_format`, each family field an enum of that family's lines, and `planFromAnswer` reads it. An answer with a field missing, a blank brief or a line outside its family is a failed request |
| Address classifier | [prompt](../prompts/address.md) as `prompts.address`, `{{name}}` filled, with `<aliases>`, the names the owner gave her person record (`ownerNamesOf` in [src/memory/db/people-read.ts](../src/memory/db/people-read.ts); the same names open the door's alias gate), `<transcript>`, `<author>` and `<candidate>` from [src/pipeline/classifier-request.ts](../src/pipeline/classifier-request.ts). It answers the JSON object `{ "answer": ... }` with `yes`, `overheard` or `no`, for a line with or without the interface's flags. `ADDRESS_FORMAT` in [src/pipeline/address-classifier.ts](../src/pipeline/address-classifier.ts) sends its schema as the strict `response_format` of the request, and `parseAddressAnswer` in [src/behavior/mention.ts](../src/behavior/mention.ts) reads it. Any other answer, a bare word included, is a failed call |
| Splitter | [prompt](../prompts/split.md) as `prompts.split`, `{{name}}` and `{{maxTasks}}` filled, with the transcript and `<candidate>` from `maybeSplit` in [src/turn/lookup.ts](../src/turn/lookup.ts). It answers the JSON object `{ "parts": [...] }`: an empty list or one part for one request, or 2 to `split.maxTasks` texts, each one part of the message. `SPLIT_FORMAT` in [src/turn/lookup.ts](../src/turn/lookup.ts) sends its schema as the strict `response_format` of the request, and `parseSplitAnswer` in [src/behavior/split.ts](../src/behavior/split.ts) reads it. Any other answer, a part that is not a text or is blank included, is one request logged as `unparsed` |
| Merge classifier | [prompt](../prompts/merge.md) as `prompts.merge`, `{{name}}` filled, with `<waiting>` and `<candidate>` from `classifyMerge` in [src/pipeline/merge.ts](../src/pipeline/merge.ts). It answers the JSON object `{ "item": ... }` with the 1-based number of a waiting item, or null for a new call. `MERGE_FORMAT` in [src/pipeline/merge.ts](../src/pipeline/merge.ts) sends its schema as the strict `response_format`, and `parseMergeAnswer` in [src/behavior/pending.ts](../src/behavior/pending.ts) reads it. A number outside the items, or any other answer, queues the call as new |
| Missed-answer check | [prompt](../prompts/missed.md) as `prompts.missed`, `{{name}}` filled, with the transcript and `<candidates>` from `buildCheckRequest` in [src/behavior/missed.ts](../src/behavior/missed.ts). It answers the JSON object `{ "verdicts": [...] }`, one entry `{ "n": ..., "verdict": ... }` per candidate with `owed`, `resolved`, `intentional-skip`, `stale` or `uncertain`. `MISSED_FORMAT` sends its schema as the strict `response_format`, and `parseMissedAnswer` in the same file reads it. A bad entry is skipped alone, and a candidate no entry names, or one named with two verdicts, is `uncertain`. An answer that is not the object leaves every candidate `uncertain` |

`prompts/system-prompt.md` and the turn prompts name no platform and no server: they speak of the places she is in and follows, and the interface's own text names its platform. The heartbeat and selfimprovement prompts are addressed to the persona and fill no placeholder. The development brief is addressed to a thinker or a dev and fills `{{id}}`, `{{title}}`, `{{branch}}`, `{{generation}}`, `{{evidence}}`, `{{examples}}`, `{{counterexamples}}`, `{{benefit}}`, `{{evaluation}}`, `{{acceptance}}`, `{{answers}}` and `{{children}}`. It carries no output tag: an agent acts on the task through the board. A local `data/prompts/selfdev.md` loads as `executor-brief`.

Read the actual template before editing it. A placeholder is an input supplied by its caller, not free prose. Preserve its spelling and inspect the caller when changing what it means. Model-facing phrases belong in the relevant prompt or label file rather than being embedded in runtime code.

## Request layout

Stable persona instructions and tool information precede changing conversational context. Relevant memory, people, place and recent messages are assembled within context budgets. Changing this order can affect prompt-cache reuse as well as behavior.

`<spatial_awareness>` sits in the tail of every turn's request, so a move between places leaves the cached parts as they were. It comes right before `<chat>` and holds her recent time away too. `spatialAwarenessText` in [src/turn/request/spatial.ts](../src/turn/request/spatial.ts) builds it from `labels.spatial`. In a place its first line is `place` with `{path}`, `{iface}` and `{when}`. `{path}` is the place and every place above it, the place first, joined with `within`. A one-to-one chat reads `kinds.dm` and a group chat `kinds.group_dm`, each with `{name}`. Every other place reads `kind` with `{noun}`, the interface's own word for its native kind (`hello.names.nouns`, `interfaceNamesOf` in `src/memory/db/frame-reads.ts`) or the native kind itself when the interface named none, and `{name}`. A place with no kind reads `kinds.place`, and a place with no stored name reads `unnamed`. The second line is `private` or `group`, and the third is `note` with `{note}`, the owner's note from `config.spatial.notes` on the nearest place of the chain that has one. The command line reads `cli` with `{when}`, then `private` and the note of its place `cli:dm:owner`, as a one-to-one chat on another interface does. A turn that is nowhere (a heartbeat, a selfimprovement wake, an intention or a feedback wake with no place) reads `server`, and a selfreflection post reads `world`, each with `{when}` alone. `{when}` is the present moment, so a request with the block keeps only her recent time away in `<now>`. An inner turn adds why she is awake: `awakeLines` in [src/behavior/wake.ts](../src/behavior/wake.ts) writes one `wake.kinds.<kind>` line per wake of the turn, with `{id}`, `{purpose}`, `{errand}`, `{due}`, `{place}`, `{lines}`, `{people}` and `{since}`, a recurring intention's last occurrence with `intentions.notes.last-occurrence` after it, and `wake.delayed` with `{minutes}` and `{code}` after a wake retried past a failed turn. A turn that is nowhere ends the block with `spatial.interfaces`, `{interfaces}` the names of the interfaces she runs on (`interfaceIdsOf` and `interfaceNamesOf` in `src/memory/db/frame-reads.ts`), an interface with no stored name by its id.

No block states a budget, a count of turns left or a reset: `labels.wake` holds no `budgets` or `budget` key, and the limits (`wakes.caps.perChain`) act without being told to her.

Each skill she can use is an entry of the tools array after the tools, under the skill's name, with no parameter. Its description is the skill's `description` line, then `labels.skills.procedure`. A call of the entry returns the skill's text as the result of `skill.read` (see [skills](skills.md)). Tool transport can be native or textual, and the corresponding request builder must agree with the parser. See [core](core.md) for the turn loop and [memory](memory.md) for audience selection.

### Chat, call marks and her day

`<chat>` holds its lines in time order, each with one clock in its brackets and no age. A day change reads `transcript.date` or `transcript.gapWithDate` with `{date}`, and the block ends with the tempo lines of `labels.tempo`. A call of hers is a line of its own at the call's time, with no number: `transcript.called` with `{skill}`, `{args}` and `{status}`. `{args}` joins, in this order, `calledFrom` with `{place}` the place she called from, `calledSearched` with `{place}` the place a lookup searched, and `calledArgs` with `{args}` the call's main arguments, each only when the call has it. `{status}` is the word of `transcript.callStatus`, or `callStatusReason` with `{status}` and `{reason}` when the call did not work.

`<inner>` holds `<my_day>`, then `<previous_think>`. On a request built on the frame it opens with `<errand_result>` when an errand's end opened the turn and holds `<my_day>`, `<intentions>`, `<errands>`, `<feedback>`, `<work>`, `<board>` and `<previous_think>` in that order, and on a selfreflection request the parts of [Selfreflection on the frame](#selfreflection-on-the-frame) after them. On the other kinds it sits in the tail before `<people_now>`. `<intentions>` of an intention turn opens with the intentions the wake is due for, each with its whole purpose. `<feedback>` is what she has not yet been told: on an inner turn `feedbackText` in [src/behavior/wake.ts](../src/behavior/wake.ts) writes a feedback wake's facts as `wake.feedbackItem` with `{fact}`, a due intention's place that could not be reached as `wake.feedback.wakePlaceGone` with `{why}` from `wake.feedback.codes` and `{code}`, then the kept facts under `wake.feedbackInTurn`. `<work>` and `<board>` come on a selfimprovement wake only. `<work>` opens with `wake.selfimprovement.header`, `{from}` the first moment of its window and `{days}` its length, and every line of a shape, a repeated chain or a failure ends with the ids of its turns. `<board>` holds her proposals, the board's news, the watcher's findings and `wake.landed`. `<my_day>` opens with `labels.myDay.header` and `{date}`, then lists what she did today, oldest first, one line per action: `line` with `{time}`, `{action}` and `{place}`, or `lineNoPlace` with `{time}` and `{action}` when the place has no name. `{action}` is `post`, `react`, `gif`, or `skill` with `{skill}`. `myDayOf` in `src/turn/request/my-day.ts` reads the journal under the turn's context, so a group turn lists nothing she did in a private chat, and a turn that is nowhere reads as herself and lists everything.

A `#n` in her words means a line of this request only. Her think in the journal, her posted line in the record, an intention's text and a skill action's arguments store it as the line's identity, `src:<iface>:<message id>:<revision>`, and a number that names no line is cut. `createHandles` in `src/turn/handles.ts` is the turn's one registry of numbers.

### Blocks per kind

`blocksOf` in [src/turn/request/frame.ts](../src/turn/request/frame.ts) is the one list of a turn's root tags, and `REQUIRED_BY_KIND` names those a kind may not omit: `persona`, `self`, `spatial_awareness` and `task` on every kind, and `chat` on a `reply`. Every kind is built on the frame: `readerRequest` in [src/turn/request/reader.ts](../src/turn/request/reader.ts) emits the tags of `frame.blocks` in their order, and a tag outside the list goes out empty with the reason `not_for_kind`. A routed or noticed call keeps the tags of `assembleUser` in `src/turn/request/tail.ts` in its order. A kind with no place reads her last `context.memory.serviceMessages` lines over the rooms of every group into `<meanwhile>`, with no direct chat, and seeds `<memory>` from them and from what her open intentions refer to (the lines an identity in a purpose names, their places and authors, and the places the intentions begin in), read as herself.

| Kind | Root tags |
|---|---|
| `reply` | `persona`, `self`, `surroundings`, `memory`, `recall`, `inner`, `meanwhile`, `spatial_awareness`, `chat`, `task` |
| `intention`, `feedback`, `errand_result` with a place | the same as `reply` |
| `intention`, `feedback`, `errand_result` with no place, `heartbeat`, `selfimprovement` | `persona`, `self`, `memory`, `recall`, `inner`, `meanwhile`, `spatial_awareness`, `task` |
| `selfreflection_plan`, `selfreflection` | `persona`, `self`, `memory`, `recall`, `inner`, `meanwhile`, `virtual_world`, `spatial_awareness`, `task` |

`buildRequest` builds every request on its turn frame and returns `blocks`, one record per tag that `readerRequest` lists, with `name`, `chars`, `segment` (`stable`, `surroundings` or `tail`), `source` (the producer) and `reason` (`empty`, `kept`, `cut` or `not_for_kind`). `archivedLlm` in `src/llm/archive.ts` stores them as the JSON column `blocks` of `model_requests` and never hands them to the client. A tool round's later requests have no `blocks`.

### The frame's blocks

The system message is `<persona>`. The stable segment holds `<self>`, the surroundings segment holds `<surroundings>`, and the tail `<memory>`, `<recall>`, `<inner>`, `<meanwhile>`, `<virtual_world>`, `<spatial_awareness>`, `<chat>` and `<task>`. No `<people_now>`, `<directory>`, `<channel_directory>`, `<server>`, `<lore>`, `<recent>`, `<participation>`, `<channel_view>`, `<retrieved>`, `<now>` or other old block goes out. Every stored text in these blocks is a value with `<` and `>` written as `&lt;` and `&gt;`, so a stored name or field cannot close a tag.

A request has three cached parts, in this order: the system message, the stable segment and the surroundings segment. `withCacheMarker` in `src/llm/openrouter.ts` puts a cache marker on each with the TTL of `llm.cache.ttl`, and a tool loop's tail gets the fourth, short-lived marker. The tools array goes before all three. `<self_facts>` is held for one TTL bucket per root place, and `<surroundings>` for one bucket per place while the place's path and the `current_version` ids of the descriptions it renders stay the same (`freezePerBucket` in `src/turn/request/emoji-gifs.ts`, called from `src/turn/request/framed.ts`). A memory batch then rewrites a cached part at most once per bucket, and a new description or a renamed place shows at once. `<senses>` is rendered at every request.

The stable `<self>` holds `<senses>` with both halves of `labels.senses`, the text transport's `<tools>` and `<self_facts>`. `<surroundings>` holds `<interface>`, `<root>` and `<place>`. `<interface>` is the interface's name, `surroundings.nouns` with `{nouns}` and the text the interface declares for its custom emoji. Each comes from the interface of the turn's place, and the emoji text is left out when that interface declares `customEmoji: false` or no `mediaPick` text ([Interfaces](interfaces.md)). `<root>` is the top place by its path with one `surroundings.field` line per stored field, `{field}` from `surroundings.fields` and `{value}`. `<place>` is the place she is in, in the same form. A one-to-one chat and the command line have no `<root>`. A path joins its names with `memory.pathJoin`.

Five subtags make up `<memory>`: `<people>`, `<places>`, `<lore>`, `<recent>` and `<found>`, each entry once. An entry opens with `memory.entry`, `{name}` and `{origin}`, the origin being `memory.origin.<evidence>` and `memory.candidate` after it for a name the reader is not sure of. The person she answers comes first with `memory.counterpart` as the origin, a stranger included. A person shown has their mention handle before the name, and a place other than a one-to-one chat its channel handle. A person with more than one account lists them after the heading at every detail, in `memory.accounts` with `{value}`: each account is `memory.account` with `{iface}` and `{id}`, its platform id, or `memory.accountNamed` with its display name in `{name}` as well, joined by semicolons. A person's lines are then `memory.relation`, then on a whole entry `realName`, `character`, `style` and one `claim` per claim, and `live` with what the interface says of them now. A place renders `memory.selfreflection` when her selfreflection is mirrored to it, then its purpose, tone and topics and `ownLines` with `{count}` and `{date}`. A lore claim is `lore` with `{subject}` and `{text}`, an episode `episode` with `{date}` and `{what}`, an excerpt `excerpt` with `{date}`, `{path}` and `{text}`, and a stored fact the prefetch found `fact` with `{state}` and `{text}`, after the excerpts in `<found>`. A subtag the budget or the reader cut ends with `leftOut` and `{count}`.

Her lookups open with `recall.header` in `<recall>`, then one each, oldest first: `recall.item` with `{time}`, `{from}` the place she called from, `{tool}`, `{searched}` (`recall.searched` with `{place}` when the arguments name one), `{query}` and `{status}`, and `recall.extract` with `{extract}`. `<meanwhile>` opens with `meanwhile.header`, then one window per place: `meanwhile.place` with `{path}` and `{date}` after the place's channel handle, and one `meanwhile.line` per line with `{time}`, `{author}` (`meanwhile.you` for hers) and `{text}`. `<spatial_awareness>` holds `labels.spatial` as above, then `spatial.answers` with `{name}` and `{n}`, the person she answers and the `#n` of their message, or `spatial.answersOutside` with `{name}` when the chat does not show it, then her recent time away from `labels.journal`.

A line's identity in a stored text renders through `refResolverOf` in `src/turn/request/refs.ts`: a line of `<chat>` as its `#n`, a line elsewhere as `refs.quote` with `{path}`, `{when}` and `{text}`, an edited line as `refs.edited`, and a deleted or unreadable line as `refs.unavailable`. `outgoingRefs` gives her posted words the interface's form in `renderPost` of `src/turn/sends.ts`, on every interface the command line included: a line of this place is the reply target, a line of another place the interface's link, and without a link form `refs.quote`.

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

The answer is the JSON object `{ "pick": ..., "name": ... }`, with `pick` one of `none`, `gif`, `emoji` and `replace`, and `name` the handle of the GIF or the name of the emoji, or null. `mediaPickFormat` builds its schema for each request, with `name` an enum of the handles and names that request offered, and sends it as the strict `response_format`. `parseMediaPick` reads anything else as `none`: a name the request did not list, a GIF named as an emoji or the reverse, an action the interface does not support, and text that is not the object. `none` is the normal answer. The persona's turn carries no block of this request, and `<skip/>` stays her word: no pick prompt uses it.

### Selfreflection on the frame

The selfreflection planner and writer run nowhere, with no conversation: `frameOf` gives the kinds `selfreflection_plan` and `selfreflection` no place and the scope `internal`, `<spatial_awareness>` reads `spatial.world`, and `<memory>` and `<meanwhile>` are those of a kind with no place. `selfreflectionFramedOf` in [src/turn/request/selfreflection.ts](../src/turn/request/selfreflection.ts) builds what both add. The world goes out as `<virtual_world>`, `prompts.world` with `{{name}}` filled, and is absent when the file is empty.

After its other parts, `<inner>` holds `<selfreflection>`: `selfreflection.intro`, then one `selfreflection.line` per past entry with `{date}`, `{kind}` (`selfreflection.kindUnknown` without one) and `{gist}`, and `selfreflection.picture` or `selfreflection.pictureSet` with `{scene}` and `{count}` after a picture entry. The entries are the newest `selfreflection.entries` of the `selfreflection` table the turn may read, oldest first, from `readSelfreflection` in `src/memory/db/selfreflection-past.ts`, and the budget cuts the oldest first.

The planner's `<inner>` then holds `<kinds>` (`selfreflection.kinds`, one `selfreflection.kindLine` per kind offered), `<seeds>` (`selfreflection.seeds` and one `- ` line per combination), `<topic>` (`selfreflection.topic` and the owner's subject) and `<stored_facts>`, each absent when empty. The writer's holds `<plan>`, `<seeds>` for a set kind and `<publication_places>`. Its `<plan>` is `selfreflection.plan`, then `selfreflection.planKind` and `selfreflection.planBrief` with `{value}`, `selfreflection.planPicture` or `selfreflection.planNoPicture`, `selfreflection.planTopic` with `{value}` when the owner gave a topic, and `selfreflection.found` with what the plan's search found. None of these parts is cut.

### Selfreflection audience

A selfreflection writer request carries `<publication_places>` in `<inner>` after `<plan>` and `<seeds>` when two or more mirrors are enabled. Its first line is `selfreflection.publicationPlaces` from `config/labels.json`, which states the output contract, followed by one `selfreflection.publicationPlace` line per mirror with `{place}` its `place:<place id>` token, `{name}` and `{iface}` its `interface:<iface>` token. With one mirror or none the block is absent.

The answer may add `<audience>unrestricted | interface:x | place:y</audience>`, one of the three, with the token alone. `takeAudience` in `src/llm/parse.ts` removes the tag from a selfreflection answer before the conversation parser runs and leaves a think block and code alone. `audienceChoice` in `src/tools/publication.ts` reads the bodies against the mirrors (`publicationPlaces` in `src/memory/db/selfreflection-audience.ts`) into `result.selfreflection.audience`, which is `{ ok: true, audience }` or `{ ok: false, code }` with `audience-unknown-place`, `audience-unknown-interface` or `audience-malformed`. No other mode reads the tag.

After a refusal the writer's `<feedback>` in `<inner>` holds one `selfreflection.audienceRefused` line per post she has not heard of. The line fills `{date}`, `{gist}` and `{reason}`, and `{reason}` is the code's entry in `selfreflection.audienceReasons`.

The contract lives in the label because a nonempty `data/prompts/selfreflection.md` replaces `prompts/selfreflection.md` whole. A deployment with its own `selfreflection.md` needs no change for the tag to work, and its `data/config/labels.json` may reword `selfreflection.publicationPlaces`. [The selfreflection](selfreflection.md#audience) describes what the stored audience does.

### Stored facts in a request

The retrieval service's facts reach a model in four places, and each is absent while it holds no fact, so a request on a memory with none keeps its bytes. `<found>` of a reply or an errand's result holds one `memory.fact` per fact. `<retrieved>` of any other turn holds `<excerpt>`s under `labels.prefetch.factExcerpt` (`{n}`, `{source}` from `labels.prefetch.sources.fact`, `{state}`), after the windows and inside `recall.prefetch.maxTokens`. A `memory.search` result ends with `labels.tools.tools.memory.facts`, one `.fact` (`{state}`, `{text}`) per fact and `.factsCut` when more exist. A selfreflection plan request holds `<stored_facts>` in `<inner>` after `<topic>`, under `labels.selfreflectionFacts.header` and `labels.selfreflectionFacts.fact`. `{state}` always comes from `labels.prefetch.factStates`: one word per state and `negative`, joined with a comma. Her text is shown as she wrote it.

`memory.search` takes `entity`, `predicate`, `as_of` and `historical` beside its other arguments, each described in `config/tools.json` and read by `toArgs` in `src/tools/definitions.ts`. It has no argument for authority or a destination. An `as_of` that is no date is `invalid` with `args.as_of`.

### The place argument

Every tool that acts somewhere names the place by its argument `place`: `draw.create`, `voice.say`, `memory.channel.read`, `message.create`, `message.edit`, `message.delete`, `message.react.add`, `message.react.remove`, `intention.set` (and its `attend`), `intention.update`, `memory.search` and `conversation.read`. `toArgs` in `src/tools/definitions.ts` hands it on as `placeId`. The tools array is the first part of the cached prefix, and no description or argument in `config/tools.json` names a platform. `placeSkillNames` in `src/tools/discovery.ts` leaves out a tool whose port operation (`interfaceCapability` in `src/tools/registry.ts`) the interface of the turn's place does not list in its `operations`. `message.create` needs `message.send`, `message.edit` and `message.delete` need their own operations, and the two reaction tools need `message.react.add` and `message.react.remove`. An interface that declares no operation, such as a link that has not said hello, keeps every tool. A turn on an interface that declares every operation keeps the whole array, and a command line turn has a shorter one with a cached prefix of its own. The interface's own nouns reach her in `<interface>` of `<surroundings>` only.

A `place` may be a handle, a place id of any interface, a native id, a mention or a name. `matchPlace` in `src/tools/place-names.ts` compares a name with the places of the turn's snapshot she may read, and with the learned stemmer it stems every word of both sides first. A comparison drops case, accents, emoji, punctuation and spaces. `readablePlaces` in `src/behavior/readable-places.ts` decides which places those are: the channels the pull rail lets the turn read, judged against the partner in a private chat and against the owner's account on the command line. A name the snapshot does not hold is read in the name index of the memory by `indexedPlace`, so a stored name or alias of a place on any interface resolves to its place id.

A name that fits more than one place is refused `target-ambiguous`, and one that fits none `invalid-args` with `args.place:unknown-channel`. Both refusals carry `choices`, and `src/turn/skill-calls.ts` puts their text in the result's `data.text` through `labels.tools.tools.place`. The lead is `several` or `none` (`{given}`, `{count}`), `line` repeats once per choice (`{name}` and `{ref}`, the token to write: `#handle` or the id), and `more` (`{count}`) closes a list cut at `PLACE_CHOICES_MAX`. Words that name no place are first ranked by the memory graph ([memory](memory.md#finding-a-place-or-a-person)). When it finds places, the refusal lists them best first under the lead `found` (`{given}`, `{count}`), which tells her to read the one that was meant and, when she cannot tell which, to ask which place by its name, never for an id or a link. A choice with a stored purpose takes `lineAbout` (`{name}`, `{ref}`, `{about}`). A place she may not read is never matched and never listed. An answer of `conversation.read` that holds lines of other people carries, after the lines and outside the result's character cap, a `<memory>` block with a `<people>` subtag of those people, rendered as the request's `<memory>` renders a person (`labels.memory`), each person once per turn ([memory](memory.md#how-a-turn-remembers)). The `person` argument of `conversation.read` reads a person's direct chat ([memory](memory.md#finding-a-place-or-a-person)). Words that name nobody refuse `unknown-member` with the people the graph ranks under `labels.tools.tools.person`, the lead `found` (`{given}`, `{count}`) and one `line` or `lineAbout` per person (`{name}`, `{ref}` the `@handle`, `{about}` their character).

### Errand result

`errandResultText` in `src/errands/blocks.ts` writes the finished errand she reads from `labels.errands.result`. When the runner counted failed web searches (`result.searchFailures`, OpenCode's `websearch` calls that ended in an error), it adds `searchFailed` with `{count}` after the reason line, on a done errand and on a failed one alike. A run with no failed search adds nothing.

### Mention handles

People, channels and messages in the request have handles supplied by the formatters. The model must reuse these handles rather than inventing native IDs. The interface resolves outgoing references for its platform.

A member's handle is `@u` and a channel's `#c` followed by base-36 digits of the id's SHA-256 (`handleOf` in `src/behavior/handles.ts`), so an id has the same handle in every request and only a collision lengthens it. A handle she carries from an earlier request, in an intention of `<inner>` or in her last think, therefore still names its member or channel when this request does not show it. `widenHandles` adds, behind the request's own handles, the handle of every member the turn's directory knows (`mentionDirectory` in `src/turn/mentions.ts`) and of every text channel of the turn's snapshot. `renderPost` in `src/turn/sends.ts` uses it for a post. For a tool argument `callViewOf` in `src/turn/calls.ts` widens the channel handles further, over every channel and thread the memory holds on any interface (`chatPlaceIdsOf` in `src/memory/db/frame-reads.ts`), and a handle of a place outside the turn's own channels resolves to its place id. A handle carried from a turn on one interface therefore names its channel on the command line, whose request shows no channel of that interface. A direct chat has no channel handle. Resolving a handle grants nothing, because the place still passes the rule of the tool, the turn's memory context for `conversation.read` and the place's interface for a write. A handle two known ids share is left out, and a handle no known id has stays as written, logged `turn: unknown handle`.

### Memory session answer

A memory session answers `<think>`, then one `<memory>` block holding a JSON object. `parseSessionAnswer` in `src/memory/db/session.ts` reads the block and `validateAnswer` checks its groups: `claims`, `episodes`, `affinity`, `descriptions`, `people`, `entities` and `assertions`, as `prompts/memory-session.md` spells them. Any other group counts one `unknown_group`, and a dropped op counts its reason in `counts.dropped`.

An author of a batch line carries a handle `aN` only while the account has no person. `buildSessionRequest` gives her own accounts no handle and leaves them out of `<people>`, and the account of the owner's command line holds his person from its first line, so `people` names neither. The prompt's "People" section says that both are known, and the writer refuses an add for either as `rejected:known_person` (`src/memory/db/session-write.ts`).

`validateSemanticAnswer` in `src/memory/db/semantic-answer.ts` takes the last two groups. An entity holds `handle`, `kind`, `name`, `language` and `sources`. An assertion holds `predicate` (`id` and `version`), `assertionKind`, `text`, `arguments`, `polarity`, `how`, `sources`, and optionally `state`, `validFrom`, `validTo` and `premises` (`handle` and `role`). A premise handle is a `vN` of `<retrieved>`, resolved through `maps.priorVersions`, and any other handle is `unknown_version`. An argument holds `role`, `position` and one of `ref` or `literal`. A field outside these is `unknown_field`, a line outside the batch is `unknown_source`, a `ref` that names no person, place or entity of this answer is `unknown_ref`, and the op goes whole. `text` is stored byte for byte.

The session request's `<place>` lists the batch's places with their handles, the descriptions they hold, and for each place of the batch one `memory.placeUnwritten` line (`{handle}`, `{fields}`) naming the fields among `purpose`, `tone` and `topics` it holds no description for. `prompts/memory-session.md` says, under "Descriptions", that such a field is flagged once the lines can say it.

A session request may carry `<retrieved>` before `<batch>`, when the retrieval service found structured facts for the batch under the scope's context, as of the batch's newest line. It lists stored entities (`[xN] name`), facts with their standing (`[vN] (state) text {xN}`) and the older lines they rest on, numbered on past the batch (`#n [time] text`). `buildSessionRequest` records each item in `reads` and in `maps.priorEntities`, `maps.priorVersions` and `maps.sources`, so an answer may name `xN` as a `ref` or a description's `subject`, `vN` as a premise and those `#n` as sources, and a claim shown here licenses no line this block does not show. With no fact the block is absent and the request is byte for byte what it was.

The writer refuses what only the database can judge, and each refusal is a `decisions` row `rejected:<code>` that leaves the other ops standing. `validateSemanticCandidate` in `src/memory/db/semantic-write.ts` answers `unknown_kind`, `bad_name`, `unknown_predicate`, `bad_assertion_kind`, `bad_role`, `bad_arity`, `bad_endpoint`, `bad_literal`, `bad_how`, `bad_polarity`, `bad_state`, `bad_interval`, `no_text`, `no_evidence`, `bad_evidence`, `unknown_source`, `unread_source`, `out_of_scope`, `unknown_ref`, `unknown_version`, `unread_version`, `bad_dependency`, `stale_base`, `premise_cycle` or `equivalence_loop`. The predicates and kinds the prompt lists are `INITIAL_PREDICATES` and `INITIAL_ENTITY_KINDS` in `src/memory/db/semantic-registry.ts`. A nonempty `data/prompts/memory-session.md` replaces the shipped file whole, so a deployment with its own copy offers these two groups only after adding them.

### Description merge

`/memory bind` asks the memory model to join two descriptions of one person when an account's own meta-person merges into the target and both hold a current description of one field in one audience (`bindAccount` in `src/memory/db/person-bind.ts`). The request goes out on the `memory` role with the purpose `description-merge` and the limit `memoryDb.session.descriptionMaxOutputTokens`. Its system message is the one her turns get with `prompts/description-merge.md` last, which takes `{{name}}`. The user message holds `<subject>` (the field and its display cap), `<kept>` (the target's current text) and `<merged>` (the text of the person who goes). The answer is `<think>`, `<description>` and `<reason>`, read by `parseDescriptionAnswer` in `src/memory/db/describe.ts`. A missing or empty `<description>` fails the bind as `bad_answer`, and nothing is written.

## Watcher answer

`agents/watcher/prompt.md` asks for one report in the exact template `checkTemplate` of [src/watcher/report.ts](../src/watcher/report.ts) enforces, and a text outside it fails the run with the code below.

The report opens with the title `# Watcher report <day>`, then the metadata rows, each `- <label>: <value>`, in this order: `Observation interval`, `Run id`, `Selected backend`, `Model`, `Effort`, `Effective account`, `Available sources`, `Risk`, `New findings`, `Open findings`. `Risk` is `none`, `critical`, `high`, `medium` or `low`, `New findings` reads `<n>, repeats: <n>`, and `Open findings` reads `critical <n>, high <n>, medium <n>, low <n>`. No other row may say `none`. The engine replaces the interval, run id, backend, model, effort, risk and counts with what it knows. It stamps `observation` and `backend` of the coverage block with the same facts.

The sections of `REPORT_HEADINGS` follow at level two, in order, each once: `Her day`, `Service runs`, `Memory`, `Money`, `Errors`, `Misunderstandings`, `Project`, `Modules and structure`, `Trash`, `The server`, `Wishes`, `Tasks filed`, `For the owner`. Each holds the subheadings of `REPORT_SUBHEADINGS` at level three, in order: `Observed defects`, `Suspicious evidence`, `Inspected without a finding`, `Unavailable checks`. `For the owner` alone takes `OWNER_SUBHEADINGS`, which opens with `Decisions needed`, and a line there is `- [critical|high|medium|low] <key>: <action>`. An empty subsection says exactly `none`. A line under `Observed defects` or `Suspicious evidence` is `- [critical|high|medium|low] <finding-key>: <text>`, except under `Tasks filed`, where the engine writes its filing lines. Every line of `Misunderstandings`, but under `Unavailable checks`, cites a turn id, `t-` and its hex digits. `findingsOf` and `applyRiskRules` of [src/watcher/risk.ts](../src/watcher/risk.ts) read these lines, and a repeat is saved as `- [low] <finding-key>: <text> (repeat <n>, first <day>)`.

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

The brief carries `<day>`, `<observation from="..." to="..." day-from="..."/>`, `<install>` with the JSON of `installFacts` from [src/watcher/install.ts](../src/watcher/install.ts), `<money>` with the JSON of `moneyFacts` from [src/watcher/money.ts](../src/watcher/money.ts) when the worker could read it, `<memory>` with one line per stored fact about failures when `watcherMemory` finds any, and `<report day="...">`, with `run="..."` on an earlier report of the same day. A second attempt holds the first brief whole, then `agents/watcher/retry.md`, then `<refusal code="...">` with the check's detail and `<previous-answer>` with the refused text, a string shaped like a key masked. The selfimprovement wake's labels `watcher`, `watcherFinding` and `watcherTask` take `{day}` and `{findings}`, `{title}`, `{state}` and `{task}`, and `{task}`, and nothing else of a report goes into them.

## Media text forms

A transcript and what she voiced are quoted speech as a whole. The transcript labels `voiceDescribed` and `audioDescribed` take `{duration}` and `{text}`, and `audioDescribed` also `{name}`. `fileUnreadable` and `stickerUnreadable` take `{name}` and state that no model can read the item. `senses.voiceHeard` replaces `senses.voice` while the `video` role is on. The prompt `describe-audio` takes `{{maxChars}}` and `{{today}}`. `describe-translate` takes `{{maxChars}}`, 500 for a description and 1500 for a video summary. It is the system message of the owner's `backfill-english` run on the `vision` or `video` role, with the purpose `describe-translate` and a stored description as the user message. Its answer is kept on one line and cut at `{{maxChars}}`. The memory session's `<batch>` shows a line's media with the same tags as the turn's chat, and numbers a line that holds only media.

## Labels

`config/labels.json` holds inserted wording and result explanations. Personal wording belongs in `data/config/labels.json`. Preserve every placeholder a label reader supplies. A result code and its label must remain aligned with the catalogue.

A label speaks of a place, a chat or a person, never of one platform, since the same file serves every interface and a service with none. Where a label must name what a platform calls a place, it takes a placeholder the code fills with the interface's noun, such as `spatial.kind` with `{noun}`. A few older labels carry a placeholder named `{channel}` that the code fills with a place's name, and `tests/labels-neutral.test.ts` keeps their list from growing.

The owner's pairing reads two labels of the `owner` section, read by `src/interface/owner-pairing.ts` and `src/interface/commands/interfaces-pair.ts`. `pairing.code` is the answer to a direct message while pairing is open, with `{phrase}`, the six words of the one-time phrase, in any number of places; her line that matches it with six words in each `{phrase}` is kept out of memory and out of every request, so the label holds `{phrase}` at least once. `pairing.ask` is the chat's question at the end of `/interfaces setup <name>`, with `{iface}`, the interface's name.

Her link tool `person.link` (definition in `src/tools/definitions.ts`, text in `config/tools.json`, run by `src/interface/person-link.ts`) takes one argument, `person`, a person id or a member handle. `owner.link.code` is the direct message to the other account, with `{phrase}` held at least once under the same rule as `pairing.code`, `{handle}` the handle of the account she talks with and `{iface}` its interface. Her answer is `tools.tools.link.sent` when the phrase went out and `tools.tools.link.already` when the two accounts are one person already, with no placeholder; a refusal is a reason code of the catalogue (`forbidden`, `cooldown`, `chat-closed`, `PERSON_NOT_FOUND`, `unknown-member`, `target-required`).

### Reason codes

The following table is generated from the code catalogue. Regenerate it with `node scripts/labels-catalogue.ts --write` and check it with `npm run check:codes`.

When a result's `values.reason` has wording in `tools.result.params.reason`, `reasonText` adds it after the code's wording and a colon. Quick search's `not-configured` and `provider` use this to say which cause holds.

`wake.feedback.pendingQuarantined` words the fact that pending memory writes failed when her memory reopened and wait for the owner's replay, with `{n}` the number of writes set aside and `{code}` the code the last one failed with. The owner's status line adds `status.memoryDb.quarantined` after `status.memoryDb.ok` or `status.memoryDb.unavailable` while writes wait in the quarantine, with `{n}` their count and `{code}` the code the newest one failed with.

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
| `dm-disabled` | denied | - | `tools.result.reasons.dm-disabled` |
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
| `memory-closed` | failed | - | `tools.result.reasons.memory-closed` |
| `write-failed` | failed | - | `tools.result.reasons.write-failed` |
| `skill-tampered` | failed | - | `tools.result.reasons.skill-tampered` |
| `skill-missing` | failed | - | `tools.result.reasons.skill-missing` |
| `file-unreadable` | failed | - | `tools.result.reasons.file-unreadable` |
| `attachment-too-large` | failed | - | `tools.result.reasons.attachment-too-large` |
| `gif-failed` | partial | - | `tools.result.reasons.gif-failed` |
| `no-result` | failed | - | `tools.result.reasons.no-result` |
| `send-failed` | failed | - | `tools.result.reasons.send-failed` |
| `selfreflection-mirror` | failed | - | `tools.result.reasons.selfreflection-mirror` |
| `link-closed` | unknown | - | `tools.result.reasons.link-closed` |
| `chat-closed` | failed | - | `tools.result.reasons.chat-closed` |
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
| `keys-exhausted` | failed | - | `wake.feedback.codes.keys-exhausted` |
| `proxy-down` | failed | - | `wake.feedback.codes.proxy-down` |
| `proxy-back` | ok | - | `wake.feedback.codes.proxy-back` |
| `memory-pending-quarantined` | failed | - | `wake.feedback.codes.memory-pending-quarantined` |
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
