# Prompt contract

Where the prompt files and the code (`src/behavior/prompt.js`, `src/llm/parse.js`, `src/discord/format.js`,
`src/memory/update.js`, `src/memory/channels.js`, `src/memory/warmup.js`) meet. Change one side only with the
other. See `CONTRIBUTING.md` for the workflow around changes.

## Layers

| Directory | Tracked | Content |
|---|---|---|
| `prompts/` | yes | English engine defaults + a neutral example character. Works out of the box |
| `prompts.local/` | no | A deployment's overrides: a file replaces the default of the same name; `labels.json` is deep-merged |

Both hot-reloaded. `/nep rule add` writes to `prompts.local/rules.md` (seeded from the default), never to `prompts/`.
All instructions are English in both layers; a character's speech samples may be in the language it speaks.

## Files

| File | Required | Role | Placeholders |
|---|---|---|---|
| `system-prompt.md` | yes | Character-agnostic rules for acting like a chat member: length, anti-AI rules, use of context, attitude toward people, boundaries. Says the card wins on voice | `{{name}}` |
| `character-card.md` | yes | The personality: who, character, voice and language, meta layer, **what earns and loses their good opinion** (read by the analyzer), reference lines. The one file a deployer rewrites | `{{name}}` |
| `rules.md` | no | Owner's live corrections, override the two above. **Must end with the bullet list under its last `## ` heading.** Code appends `- …` lines | `{{name}}` |
| `format.md` | yes | The output protocol | none |
| `reply.md` | yes | Task: somebody called the persona | `{{name}}` `{{author}}` `{{trigger}}` `{{target}}` |
| `follow-up.md` | no | Task: a line that carries on an exchange with the persona. The persona first decides whether it calls for another turn; `<skip/>` is the default for a line that asks nothing of them. Replaces `reply.md` as the task text when the trigger kind is `followUp` (the address classifier's `yes`) or `reply` without an explicit @mention of the persona (Discord's reply ping does not count). A mention, a tagged reply and a name call keep `reply.md`. A missing or blank file falls back to `reply.md` | `{{name}}` `{{author}}` `{{trigger}}` `{{target}}` |
| `interject.md` / `initiate.md` | yes | Tasks: cut into a live conversation / start a topic in a silent chat. Code rolls `spontaneous.initiateChance` after `deadAfterMinutes` of silence, so the initiate prompt speaks by default and `<skip/>` is for a channel where a new topic is plainly out of place. An initiate turn may also follow the persona's own last line once the channel is dead | `{{name}}` |
| `forced.md` | no | Appended after the mode prompt on a forced turn (`/nep interject`, `/nep initiate`). Overrides the `<skip/>` default | `{{name}}` |
| `memory.md` | yes | Out-of-character prompt of the stream analyzer (single-stage mode and private batches): targeted edits to memory from live batches | `{{name}}` `{{fieldChars}}` `{{guildFieldChars}}` `{{maxDetails}}` `{{maxInjokes}}` `{{maxSelfFacts}}` `{{maxNewEpisodes}}` `{{maxEpisodes}}` `{{maxDeltaPerUpdate}}` `{{maxInterests}}` `{{interestTopicChars}}` `{{interestNoteChars}}` `{{loreTextChars}}` `{{maxLearned}}` `{{learnedChars}}` `{{relationshipChars}}` |
| `memory-decide.md` | no | Stage A of the two-stage analyzer (`features.memoryTwoStage`): neutral decisions on what changed, with briefs for the voice model. Same input blocks as `memory.md`. Returns JSON. Required when `features.memoryTwoStage` is on; a missing file falls back to single-stage mode | `{{name}}` `{{fieldChars}}` `{{guildFieldChars}}` `{{maxDetails}}` `{{maxInjokes}}` `{{maxSelfFacts}}` `{{maxNewEpisodes}}` `{{maxEpisodes}}` `{{maxDeltaPerUpdate}}` `{{maxInterests}}` `{{interestTopicChars}}` `{{interestNoteChars}}` `{{loreTextChars}}` `{{maxLearned}}` `{{learnedChars}}` `{{relationshipChars}}` |
| `memory-voice.md` | no | Stage B of the two-stage analyzer: the persona words queued items in their own voice. Returns JSON. Required when `features.memoryTwoStage` is on. An optional `<over_limit>` block on a retry lists the items whose previous answer exceeded their limit | `{{name}}` `{{fieldChars}}` `{{guildFieldChars}}` `{{relationshipChars}}` `{{learnedChars}}` |
| `portrait.md` | no | Stage A of the two-stage portrait refresh: reads the stored portrait and a message sample, returns a merged `style` text and structured `character` edits. The character edits are queued as a voice item for stage B. An optional `<over_limit>` block on a retry lists the fields whose previous answer exceeded their limit | `{{name}}` `{{fieldChars}}` |
| `profile.md` | yes | Warmup / portrait refresh: one member's profile from a message sample. An optional `<over_limit>` block on a retry lists the fields whose previous answer exceeded their limit | `{{name}}` `{{fieldChars}}` `{{maxInterests}}` `{{maxDetails}}` `{{interestTopicChars}}` `{{interestNoteChars}}` `{{maxNewEpisodes}}` |
| `channel.md` | yes | Warmup and notes refresh: channel notes from a message sample. On a refresh, an optional `<existing_notes>` block carries the stored notes as claims to evaluate, not as evidence. An optional `<over_limit>` block on a retry lists the fields whose previous answer exceeded their limit | `{{fieldChars}}` |
| `server.md` | yes | Warmup and notes refresh: server-level notes from channel notes and member summaries. On a refresh, an optional `<existing_notes>` block carries the stored notes as claims to evaluate. An optional `<over_limit>` block on a retry lists the fields whose previous answer exceeded their limit | `{{fieldChars}}` `{{maxInjokes}}` `{{loreTextChars}}` |
| `describe.md` | yes | Out-of-character prompt of the media describer (`features.mediaDescriptions`): one picture in, one plain line out: what is visibly there, with actions and identities only on clear evidence. Legible text quoted in its original script. Indistinct regions described as such, ambiguous shapes not turned into an identity. Always English. No commentary, no moralising, no markdown | `{{today}}` `{{maxChars}}` (optional) |
| `describe-video.md` | yes | Out-of-character prompt of the video describer (`features.videoDescriptions`): one video clip in (with sound), a full ordered account out: who appears, what is said (key phrases quoted), text on screen, what happens visually, music/sound when relevant. Configurable length. Always English; speech, captions and on-screen text quoted in their original language. No character card | `{{today}}` `{{maxChars}}` |
| `describe-gif.md` | no | Out-of-character prompt for the GIF describer (`media.gif.watch`): a short silent clip in, three labelled lines out: `reaction` (the reply function, a few words or `none`), `action` (what visibly happens, capped at `{{maxChars}}`), `text` (on-screen text verbatim or `none`). Always English. No character card. Falls back to `describe-video.md` when absent | `{{today}}` `{{maxChars}}` `{{seconds}}` |
| `rewatch.md` | yes | Classifier: does this message need the persona to re-watch a video, retry one that did not load, or look at a picture again (`features.videoRewatch`, `features.imageRelook`). Receives a numbered list of recent media (videos, watched GIFs listed as videos, and pictures) with their kind, status and the new message. Output is ONE line: `<number> \| <question>`, `<number> \| retry` or `none` | `{{name}}` |
| `rewatch-answer.md` | yes | Out-of-character prompt for the second-look answer: the vision or video model looks at the item again and answers one question in the language of the question. The question arrives as the user message next to the picture or video. Kind-neutral (serves both videos and pictures). No character card | `{{today}}` `{{maxChars}}` |
| `address.md` | yes | Classifier: is this untagged message addressed to the persona, about them, or neither. Output is one word: `yes`, `overheard` or `no` | `{{name}}` |
| `overheard.md` | no | Task: the message talks about the persona, not to them. Used INSTEAD of the mode prompt when the trigger kind is `overheard` and the file is present and non-blank; missing or blank falls back to the mode prompt (degraded) | `{{name}}` `{{author}}` `{{trigger}}` `{{target}}` |
| `lookup.md` | no | Classifier: does the persona need to look something up (`features.webLookup`, `features.recall`). Receives a short transcript and a `<candidate>` block. Output is `none`, or up to four labelled lines: `web:` a web query, `server:` word forms to search in the server's messages, `who:` name forms to find a person, `when:` a date range. A single unlabelled line is still read as a web query | `{{name}}` `{{today}}` |
| `recall-summary.md` | no | Out-of-character prompt for the recall summary (`features.recall`): reads the stretches of old chat found by the server search and answers the question, optionally naming one stretch the persona gets verbatim. No character card | `{{name}}` `{{answerChars}}` |
| `room.md` | no | Classifier: is this message put to everyone in the room, or aimed at one person (`spontaneous.roomQuestionChance`). Receives a short transcript, the author's aliases and a `<candidate>` block. Output is ONE word: `yes` or `no` | `{{name}}` |
| `route-channel.md` | no | Classifier: does answering this message need the persona to see another channel (`features.channelRoute`). Receives a short transcript, a `<channels>` list and a `<candidate>` block. Output is ONE line: a number from the list or `none` | `{{name}}` |
| `participation-pick.md` | no | Classifier: which of the persona's stored exchanges on other channels the new message refers to (`features.participation`). Receives a short `<transcript>` (own lines marked with `labels.self`), a `<candidate>` block and a numbered `<episodes>` list. Output is ONE line: up to 4 numbers from the list, comma-separated, most relevant first, or `none`. No character card. Without this file the newest episodes are shown | `{{name}}` |
| `elsewhere.md` | no | Task: the persona read a channel where they cannot write and may comment on it in the main channel (`features.elsewhere`). Used as the task text for a noticed turn. `<skip/>` is the normal outcome | `{{name}}` `{{channel}}` `{{destination}}` |
| `read-link.md` | no | Out-of-character prompt for the link reader (`features.webLookup`, `web.links.enabled`): condense a fetched page into one paragraph. Receives the page title and body. No character card | `{{today}}` `{{maxChars}}` |
| `search-summary.md` | no | Out-of-character prompt for the search condenser (`features.webLookup`, `web.search.enabled`): condense numbered search results into one note with inline sources. No character card | `{{today}}` `{{query}}` `{{maxChars}}` |
| `private.md` | no | Appended after the mode prompt (`reply.md`), before `forced.md`, only in a DM (`features.privateMessages`). This is a private conversation: what is said here stays here; the persona keeps their public knowledge. A missing file adds nothing | `{{name}}` `{{author}}` |
| `diary.md` | yes | Task: write a diary post. The persona's own channel, nobody asked. The plan's kind and brief, past posts, the optional world and search result are in the user message blocks. Output: `<msg>` (1 to `diary.maxMessages`), `<draw>`, or `<skip/>`; `<react>` and `<gif>` are dropped. No reply attributes, no links | `{{name}}` |
| `diary-plan.md` | yes | The planner: pick the kind, a brief and whether to search and draw. Runs on `classifier.text`, no character card. Receives `<now>`, `<server>`, `<about_chat>`, `<recent>`, `<lore>`, `<world>`, `<diary>`, `<kinds>`, `<seeds>`, and `<topic>` when the owner gave one. Answers one JSON object | `{{name}}` |
| `world.md` | no | The persona's virtual world: the places and routines it lives in outside the chat. Rendered as a `<world>` block only in the diary plan and compose requests, and only when `diary.world === true`. Never in an ordinary turn. A missing file or switch adds no block | `{{name}}` |
| `diary-seeds.md` | no | Random seed families for the diary planner. `# name` headers start a family (place, setting, detail, activity, subject, twist); code draws one line per family and composes `diary.seedSets` combinations as a `<seeds>` block. Omitted when missing or `seedSets` is 0 | none |
| `draw.md` | yes | Out-of-character prompt of the drawing sub-process (`features.imageGeneration`): produces one picture from a scene description. Receives only the appearance and the request — never the character card | `{{name}}` `{{appearance}}` `{{request}}` `{{when}}` |
| `appearance.md` | no | The persona's visual look, inserted into `draw.md` when `self="yes"`. One paragraph, no personality, no backstory | `{{name}}` |
| `mentor-situations.md` | no | Mentor: invent test chat situations for a case (`features.mentor`). Returns JSON only | `{{name}}` `{{count}}` `{{minLines}}` `{{maxLines}}` |
| `mentor-score.md` | no | Mentor: score the persona's answers to a situation (`features.mentor`). Receives the character card. Returns JSON only | `{{name}}` |
| `mentor-signs.md` | no | Mentor: known habits of model-written text, sent as the `<signs>` block in every mentor request (`features.mentor`). Omitted when missing or empty | `{{name}}` |
| `mentor-diagnose.md` | no | Mentor: explain weak answers after scoring by pointing at specific text in the persona's context (`features.mentor`). The result is an unverified opinion stored as `diagnosis` on the run. Omitted when `mentor.diagnose` is false or the file is missing | `{{name}}` |
| `gif-pick.md` | no | Classifier: pick a GIF from the library to replace a short text reply (`features.gifPicker`). Receives the last `gifs.pick.contextMessages` chat lines with the answered message named, the persona's reply and the whole captioned library. The length gate is `gifs.pick.maxChars` (default 160); with several outgoing messages only the first is replaced. Output is one handle from the library or `none`. No character card | `{{name}}` |
| `split.md` | no | Classifier: does a direct call hold several separate requests (`features.splitTasks`). Receives a short `<transcript>` and the new message as `<candidate>`. Output is the word `one`, or 2 to `{{maxTasks}}` lines each starting with `- ` and holding one part in the author's own words. No character card. Without this file the splitter is off | `{{name}}` `{{maxTasks}}` |
| `merge.md` | no | Classifier: does a new message from an author with waiting items belong to one of them. Receives a numbered `<waiting>` list and the new message as `<candidate>`. Output is one line: a number from the list or the word `new`. No character card. Without this file a new call is always queued as its own item | `{{name}}` |
| `labels.json` | yes | Every string the CODE inserts into a prompt. Keys fixed below, values are the writer's | see below |

`{{name}}` bot's display name · `{{author}}` caller's display name · `{{trigger}}` one of `labels.triggers.*` ·
`{{target}}` index of the calling message (`#87`).
`{{today}}` in `lookup.md` is the date in `bot.timezone`; in the describers (`describe.md`, `describe-video.md`, `describe-gif.md`) and `search-summary.md` it is the UTC date.
System message = `system-prompt` + `character-card` + `rules` + `format`. For the analyzer: `memory.md` alone.
On a forced turn (`/nep interject`, `/nep initiate`), `forced.md` is appended after the mode prompt if the file exists.
On an `overheard` turn, `overheard.md` REPLACES the mode prompt (it is the task text, not an append). When `overheard.md` is missing or blank, the mode prompt is used instead (degraded: the mode prompt frames the line as said to the persona, which is not what happened).
In a private chat, `private.md` is appended after the mode prompt (before `forced.md`) with the same `{{name}}` and `{{author}}` placeholders.
The analyzer and the warmup's `profile.md` and `server.md` receive the character card and `rules.md` as a
`<character>` block in the user message. `channel.md`, `describe.md`, `describe-video.md`, `describe-gif.md`, `draw.md`, `rewatch.md`, `rewatch-answer.md`, `address.md`, `lookup.md`, `read-link.md`, `search-summary.md`, `recall-summary.md`, `room.md`, `route-channel.md`, `participation-pick.md` and `elsewhere.md` do not receive the card.

`{{guildFieldChars}}` is `fieldChars * 2`, the limit code clamps guild-level patterns and starters to.
`{{maxEpisodes}}` is the total episodes kept per person. Both are filled from config but not used by the default
prompts; a custom `memory.md` may reference them.

## Blocks

The blocks of the user message. Empty ones are omitted; the order below is the order in the reply request: the stable part (`<self_facts>`, `<about_chat>`, `<gifs>`), the profiles (`<people>`), then the tail from `<server>` to `<chat>`, with `<now>`, `<senses>`, `<tempo>` and `<task>` last. `<kinds>`, `<seeds>` and `<topic>` belong to the diary's plan request, which keeps its own order (see [Diary](#diary)).

| Block | Content |
|---|---|
| `<self_facts>` | What the persona has claimed about themselves |
| `<about_chat>` | How people talk here, how they start and cut into conversations, in-jokes, things people taught the persona |
| `<gifs>` | GIFs the persona can post (`features.gifs`): at most `gifs.max` (default 40) entries from the library, ranked by recency-weighted use. Each carries the handle (`g1`, `g2`, …) and three fields from the describer when cached: a reaction label (capped at `gifs.reactionChars`, default 40), a visible action (capped at `gifs.actionChars`, default 70) and on-screen text. An entry with fields renders through `labels.gifs.entryFields` (`{id}`, `{reaction}`, `{action}`, `{text}`; code drops empty fields and their separators); an entry without fields uses `labels.gifs.entry` (`{id}`, `{text}`) with the caption cut at a word boundary. Each entry also stores when and how often the persona posted it (`ownLast`, `ownUses`); one posted within `gifs.ownMarkHours` (default 24; `0` = off) carries `gifs.ownMarkRecent`, with no time in it (no mark without that label), so the block changes only when such a post enters or leaves the window. Entries with the mark render after all the others, each group in rank order; the budget still trims the list by rank. The GIF picker's list keeps `gifs.ownMark` with the relative time |
| `<people>` | Member profiles; the caller first, marked with `labels.profile.interlocutorMark` (omitted on an `overheard` turn: the author talked about the persona, not to them); each with the persona's attitude, followed by up to `relationships.shownMoves` of the moves that built it (strongest by absolute delta first, oldest first in the block, both positive and negative kept when both exist, the current attitude reason not repeated), and for the caller the **episodes**: moments the persona remembers about the two of them, with dates and short quotes |
| `<server>` | The CURRENT channel in full (Discord category and topic, purpose, what people write, tone, activity, last message, top writers; marked with `labels.server.currentMark`) plus only the neighbour channels that fed `<other_channels>` this turn; no other channel |
| `<emoji>` | Custom emoji the persona can use (`features.customEmoji`): at most `context.customEmoji.max` entries, ranked by member usage. Each carries `:name:` and the helper's caption when one is cached. When `labels.emoji.seenInChat` exists, described custom emoji that appeared in the transcript, pulled channels or neighbours but are not in the top list are listed under that sub-heading; transcript lines keep a bare `:name:` for every custom emoji. Without the label (or without the block) the inline `transcript.emojiDescribed` tag stays |
| `<lore>` | Server lore entries whose keys occur in the recent messages (plus entries marked always): events, recurring characters, long-running stories. Like a lorebook: hundreds may exist, only the relevant few are shown |
| `<recent>` | What happened on the server in the last `memory.recentHours` (default 72) hours: recent notes (short events the analyzer writes) and in-window episodes of members, shown by reference. A note appears only from the turn's own channel or from a channel everyone here can also read; in a private chat, only from channels every server member can read, with no episodes. Items about the people this turn addresses rank first; episodes already rendered in `<people>` are left out, at most 2 per member. Oldest first. A header with no item renders nothing. Switch `features.recent` (missing = on); cap `context.caps.recent` (default 1200) |
| `<participation>` | The persona's own exchanges on other channels over the last `participation.hours` (default 72): `labels.participation.header` (`{hours}`), then per channel `labels.participation.channel` (`{channel}` `{purpose}`, the stored channel note's purpose) or `labels.participation.channelNoPurpose`, then per episode `labels.participation.episode` (`{when}`: how long ago the persona's newest line in it was) and its lines in the `<chat>` form without the `#n` index or a reply quote (clock time, aged lines with `transcript.timeAged`, the author, the text, a saved picture caption as `transcript.imageDescribed`); a run of cut lines is one `labels.participation.skipped` (`{count}`). At most `participation.shown` (default 4) episodes, `participation.perChannel` (default 2) per channel, never from the current channel, only from channels everyone here can also read. See [Participation episodes](#participation-episodes). Switch `features.participation` (missing = on); cap `context.caps.participation` (default 6000). Never in a private chat |
| `<attitudes>` | The top `context.attitudes` (default 6, `0` = off) members the persona feels most strongly about, ranked by the size of the attitude score, warm and cool mixed. Skips the interlocutor and anyone already in `<people>`. One line per member (`labels.attitudes.line`): name and attitude band. Header: `labels.attitudes.header`. Cap `context.caps.attitudes` (default 400). Present in server turns and private chats |
| `<other_channels>` | Up to `context.neighborMessages` messages per neighbouring channel, not older than `context.neighborMaxAgeMinutes`. When `features.mediaDescriptions` is on, a picture in a neighbour's line carries its cached caption when the describer cache already holds one; no new describe request is ever made for neighbours. A channel whose block is shown in `<channel_view>` is left out of `<other_channels>`; if the budget dropped the pulled block, the channel reappears here as an ordinary neighbour |
| `<channel_view>` | Another channel pulled into this turn (`features.channelPull`). Contains one item per pulled channel: a header line (`labels.pull.header`), a read-only mark when applicable (`labels.server.readOnly`), an "older not shown" line when the window was cut, a "pictures not seen" count, earlier calls to the persona (with answered/unanswered/skipped marks), then the window lines. Lines use the same transcript format as `<chat>` but are numbered on after the chat (the chat has `#1`..`#N`, the pulled block starts at `#N+1`), so every `#n` is unique across blocks. Pictures appear as captions or blind tags only, never as attached images. Without `labels.pull.header` the block is empty |
| `<world>` | The persona's virtual world (`prompts/world.md` with `{{name}}` filled). Present only in a diary post (`mode === 'diary'`) when `diary.world === true`. Dropped whole under budget pressure. A missing file or switch off adds nothing |
| `<diary>` | Past diary posts, oldest first, `labels.diary.intro` then one `labels.diary.line` per post. Shown in both the plan and compose requests. Under budget pressure the oldest lines are cut first |
| `<plan>` | The plan for this diary post: `labels.diary.plan`, then one JSON line `{"kind","brief","picture"}`, plus `"topic"` when the owner gave one with `/nep diary post`. Never cut |
| `<found>` | What the diary's search turned up: `labels.diary.found`, then the search result text. Present only when the plan asked for a search and it returned something. Ranked right after `<lookup>` in the budget |
| `<kinds>` | Post kinds with weights and usage counts: `labels.diary.kinds`, then one `labels.diary.kindLine` per kind with a positive weight; when the post cannot carry a picture, kinds in `diary.pictureKinds` are omitted. Never cut |
| `<seeds>` | Random seed combinations: `labels.diary.seeds`, then one `- a; b; c` line per set. Present only in the plan request. Omitted when the file is missing or `diary.seedSets` is 0. Never cut |
| `<topic>` | The owner's topic for a forced post (`/nep diary post [kind] [topic]`): `labels.diary.topic`, then the topic as one line, at most 300 characters. Present only in the plan request, right after `<seeds>`, and only when a topic was given. Never cut |
| `<lookup>` | What the persona looked up this turn. A web search (`features.webLookup`) carries `labels.lookup.webHeader`, the condensed answer, `labels.lookup.sources` and, when nothing was found, `labels.lookup.none`. A server search (`features.recall`) carries `labels.lookup.serverHeader`, the summary note and, when the summary names a stretch, the verbatim lines of that stretch. When both ran, `labels.lookup.bothNote` sits between them. A `labels.lookup.stretch` line introduces a verbatim stretch (`{date}` `{channel}`). Appears only when a search classifier fired and at least one search completed |
| `<chat>` | Up to `context.channelMessages` latest messages of the current channel. A line at least `context.ageAfterMinutes` (default 60) minutes old also shows how long ago it was posted (`transcript.timeAged`). When `context.fetchReplyParents` is on, the trigger message and the last `context.replyParentsFor` window lines that are replies to older messages have their parents fetched and placed before the window as ordinary transcript lines; the trigger's parent can also bring its own parent. At most `context.replyParentsMax` parents per turn. A gap marker and date header cover the time jump; the reply line quotes the parent through `transcript.replyTo`; media in a parent is handled like any other line, and a cached description is served for free. A deleted or inaccessible parent is skipped and logged as `collect: parent missing` |
| `<now>` | Date, weekday, time in `config.bot.timezone`, formatted with `labels.locale` |
| `<senses>` | What the persona can and cannot perceive RIGHT NOW, generated from the live config: which pictures they see themselves, which come as a helper's description, what they are blind and deaf to. So the persona never pretends to have watched a video and can joke about it in their own voice |
| `<tempo>` | Counts for 10 min / hour / day, distinct people, silence, a verdict (live / slow / dead) |
| `<task>` | `reply` / `follow-up` (when `follow-up.md` exists, for `followUp` and an untagged `reply`) / `interject` / `initiate` / `overheard` (when `overheard.md` exists) / `elsewhere` (when `elsewhere.md` exists, for a noticed comment) / `diary` (when `diary.md` exists, for a diary post), placeholders filled. After the mode prompt, up to three `task.*` labels are appended when their conditions hold (each separated by a blank line): `task.part` when the turn answers one part of a split message, or `task.queued` when the trigger author has other calls waiting; then `task.queuedOthers` when other members have calls waiting in the channel; then `task.added` when later messages were folded into this call. See `labels.task.*` below |

Budget priority (sections are trimmed from the bottom of this list first): system + task + clock + tempo + senses
(never cut) -> caller's profile with episodes -> lookup (kept or dropped whole; may hold a web part, a server part or both) -> about_chat -> self_facts -> lore -> server -> chat (newest first) ->
pulled (`<channel_view>`, capped at `context.caps.pulled`; on a turn that answers a call from a read-only channel the pulled block sits before the chat instead of after it) ->
recent (capped at `context.caps.recent`) ->
participation (whole episodes, the picked ones first; capped at `context.caps.participation`) ->
other profiles -> attitudes (capped at `context.caps.attitudes`) ->
diary mode only: `<found>` (right after `<lookup>`), `<world>` (one piece, right after attitudes), `<diary>` (oldest lines cut first), `<plan>` + `<kinds>` + `<seeds>` + `<topic>` (never cut) ->
other channels -> emoji (entries from the bottom, then the whole block; `context.caps.emoji`) -> gifs (same trimming; `context.caps.gifs`).

Cache segments. The reply's user message is sent as text parts in three segments: the stable part, the profiles and the tail (the pictures follow as image parts). Each part but the last ends with the blank line between blocks, so the parts read as one text. The builder tags the stable part and the profiles with a neutral `cacheSegment` field; the client turns it into the provider's cache marker (`llm.cache.ttl` on the stable part, `llm.cache.profilesTtl` on the profiles) under `features.promptCache`, `llm.cache.roles` and `llm.cache.models`, and never sends the field. With the system message that makes three of the provider's four markers. A segment with no block is left out. Nothing in the stable part or the profiles reads the clock finer than a day: a GIF the persona posted carries the ageless `gifs.ownMarkRecent` and renders after the unmarked ones, and a profile's message count is rounded (`profile.messageCount`). Display order and trimming are independent: the budget priority above is unchanged.

GIF picker (`features.gifPicker`, default on). After the persona writes a short reply (at most `gifs.pick.maxChars` characters, default 160) and chose no GIF herself, a classifier (`classifier.text`, purpose `gif-pick`, `gifs.pick.maxOutputTokens` 60, prompt `prompts/gif-pick.md`) receives the last `gifs.pick.contextMessages` (default 4) chat lines with the answered message named in the context, the persona's first message and the whole captioned library (every entry with its caption, each carrying the own-mark when recently posted by the persona). The classifier answers one handle or `none`. On a handle the GIF replaces the first outgoing message and replies where it would have; the remaining messages follow in order. When the GIF fails to send, every message goes as written. The classifier runs during the first message's typing simulation; the daily GIF rail `gifs.maxPerDay` applies. Logged as `gifs: picked` (handle true/false, library size) or `gifs: pick failed`.

Media in a transcript line, most informative form available: a picture attached to THIS request →
`transcript.imageAttached`, or `transcript.imageAttachedDescribed` when `features.attachedDescriptions` is on and
the helper captioned it (numbered in the order the pictures follow the text); a described one →
`imageDescribed` / `gifDescribed` / `videoDescribed`; otherwise the blind forms `image` / `gif` / `video`.
When video vision is on (`features.mediaDescriptions` AND `features.videoDescriptions`), a video or video-site link
gains a state: `videoWatched` (first-hand, seen and heard), `videoNotWatchedFrame` (not watched but a still frame was
described), or `videoNotWatched` (not watched, no frame). The reason code (`length` / `size` / `daily` / `error` / `pending`) is
swapped for the human phrase from `transcript.videoReason.*` before it reaches the transcript. Links keep their base
tag (`link` / `linkText`) and add a video extra: `linkWatched`, `linkNotWatchedFrame` or `linkNotWatched`. When a still
frame is attached as a picture, `frameAttached` is added as well. Links use `link` / `linkText` built from Discord's
embed (site, title, snippet); when `features.webLookup` is on and the link was read, `linkRead` is appended after the
link's other extras (video, thumbnail). Text files show their beginning via `filePreview`; a forwarded message is
wrapped in `forwarded`. When `features.seeReactions` is on (the default), a reactions tag is appended at the very
end of a line, after media tags and forwarded wrappers. It lists at most `context.reactionsPerMessage` reactions per
message, most frequent first; each item uses `transcript.reactionItem` or `transcript.reactionMine` (when the persona
is among the reactors), joined with ", " and wrapped in `transcript.reactions`. A labels file without
`transcript.reactions` renders nothing.

Video results are cached per attachment or per link in `data/guilds/<id>/media.json` under the key
`video:<itemId>` (the attachment id, or a stable hash of the link URL). Cache entries:

- Watched: `{ text, ts, watched: true }`: permanent, the summary text.
- Limit miss (length or size): `{ miss: true, ts, reason: "length"|"size" }`: permanent, the file will not change.
- Error miss: `{ miss: true, ts, reason: "error" }`: retried after `media.video.errorRetryMinutes` (default 60) minutes, or at once on a forced retry from the re-watch classifier.
- Daily limit: not cached; returned as `{ state: "limit", reason: "daily" }` for that turn only.

A re-watch answer is cached under the key `video:<itemId>:q:<hash>` (the first 16 hex digits of SHA-1 of the lower-cased, whitespace-collapsed question): `{ answer, question, ts }`. A watched GIF's re-watch answer uses `gif:<itemId>:q:<hash>` the same way (`<itemId>` is the GIF's own id, `<message>#e<n>` for an embed). Expires after one hour; code deletes expired entries on read.

A picture's still-frame entry keeps its own `<itemId>` key as before. Both can coexist for the same item.

A watched GIF is cached under the GIF's own `<itemId>` key (not `video:` prefixed): `{ text, reaction, action, screen, ts, watched: true, gif: true }`; `text` is the one-line action (or the reaction or on-screen text when there is no action line). All four are stored whole, bounded only by `media.descriptionChars`. Cuts apply where the fields are shown, in the `<gifs>` list and in a library GIF's transcript line (`transcript.gifKnownFields`) alike: `gifs.reactionChars` cuts `reaction` and `screen`, `gifs.actionChars` cuts `action` and an old one-line caption; `0` = no cut. A one-frame caption keeps `{ text, ts, gif: true }` (plus `watchFailed` when a watch was attempted). Both sit alongside picture entries in the same cache.

Web lookup results are cached in the same `data/guilds/<id>/media.json` alongside video and picture entries:

- Read link: `read:<link.id>` holds `{ text, ts }` (the condensed excerpt, permanent) or `{ miss, ts, reason }` (a miss skipped for 6 hours; reasons: `scheme`, `private`, `redirects`, `type`, `size`, `timeout`, `http`, `network`, `empty`, `unreadable`, `llm`). A `TokenLimitError` or `DailyCapError` is never cached.
- Search: `search:<sha1 prefix of the normalised query, 16 hex>` holds `{ query, text, sources, ts }`, served while younger than `web.search.cacheHours` (default 24). An empty `text` means no results (renders `labels.lookup.none`). Failures are never cached.

Transcript line: `#87 [14:32] nick: text <replyTo> <media…> <sticker> <reactions>`; own lines use `labels.self`; between
lines `labels.transcript.gap` / `gapWithDate` / `date`; the block opens with `labels.transcript.header`. Neighbour
channels: same lines without `#n`, under `# channel-name`. A line at least `context.ageAfterMinutes` (default 60)
minutes old by the request's clock (the same moment as `<now>`) renders its time through `labels.transcript.timeAged`:
`#87 [14:32 · 2 h 58 min ago] nick: text …`. Ages appear only in `<chat>`, `<channel_view>` and `<other_channels>` and
are computed for each request and never stored; every other transcript (classifiers, the verbatim stretches of a server
search, the analyzer, the warmup) keeps the plain time.

## Labels

The keys of `labels.json`; `{x}` is filled by code.

```
locale                                   BCP-47 tag for dates
ping.prompt                              the whole user message of `/nep ping`; must make any model answer one short word
self                                     {name}
units.lessThanMinute | minute | hour | day
transcript.gap                           {duration}: the time between two consecutive lines at least `context.gapMarkerMinutes` apart, worded so it cannot pass for an age
transcript.gapWithDate                   {duration} {date}: the same across a day change; date is the date of the line below
transcript.date | header                 {date}
transcript.timeAged                      {clock} {age}: replaces the whole bracketed time of a line at least `context.ageAfterMinutes` old; age is a duration in `labels.units`; younger lines keep `[{clock}]`; a missing or empty key shows no ages
transcript.empty | replyToOld | image
transcript.replyTo                       {index} {author} {quote}: the parent message's number, its author (the self label when the parent is the persona's own) and a quote of the parent's text, cut at a word boundary to `context.replyQuoteChars` (default 80; `0` = whole); a parent with only media quotes its media labels
transcript.file | sticker                {name}
transcript.stickerDescribed              {name} {text}
transcript.emojiDescribed                {name} {text}: inline tag for a described custom emoji, appended to the chat line. Used only when the `<emoji>` block is absent or `labels.emoji.seenInChat` is not set; with `seenInChat` the line keeps a bare `:name:` and the description moves to the block
transcript.imageAttached                 {n}: this picture is attached to the request, the persona sees it
transcript.imageAttachedDescribed        {n} {text}: attached to the request and captioned by the helper (features.attachedDescriptions)
transcript.imageDescribed                {text}
transcript.gif                           {name}
transcript.gifDescribed                  {text}
transcript.gifKnown                      {id} {text}: a GIF that is in the library; id is its handle, text is the caption
transcript.gifKnownFields                {id} {reaction} {action} {screen}: a library GIF whose cache has a reaction or on-screen text, used in place of gifKnown; fields cut by gifs.reactionChars / gifs.actionChars as in gifs.entryFields; code drops empty fields and their separators; blanked: falls back to gifKnown
transcript.gifKnownNoText                {id} {name}: a library GIF without a caption; id is the handle, name is the file or link name
transcript.video                         {name} {duration}
transcript.videoDescribed                {name} {duration} {text}: text describes ONE frame
transcript.videoWatched                  {name} {duration} {text}: first-hand, the persona saw and heard the clip
transcript.videoNotWatched               {name} {duration} {reason}: reason is the human phrase from videoReason.*
transcript.videoNotWatchedFrame          {name} {duration} {reason} {text}: not watched but a still frame was described
transcript.videoAnswered                {question} {text}: extra tag after a watched video tag or a GIF's tag; the persona re-watched the clip for this question
transcript.imageAnswered                {question} {text}: extra tag under the picture's line; the persona looked at the picture again for this question
transcript.videoReason.length | size | daily | error | pending    human phrases for the five reason codes; pending = the clip was still loading when the request went out
transcript.linkWatched                   {text}: extra tag after a link tag, first-hand video summary
transcript.linkNotWatched                {reason}: extra tag after a link tag, not watched with reason
transcript.linkNotWatchedFrame           {reason} {text}: extra tag after a link tag, not watched but preview described
transcript.voice                         {duration}
transcript.audio                         {name} {duration}
transcript.link                          {site} {title}
transcript.linkText                      {site} {title} {text}
transcript.linkRead                      {text}: extra tag after a link tag; the page was fetched and condensed, first-hand
transcript.thumbnailDescribed            {text}: follows a link tag; describes the link's preview picture
transcript.filePreview                   {name} {text}
transcript.forwarded                     {text}
transcript.forwardedFrom                 {channel} {text}: used when the source channel is known; falls back to `forwarded`
transcript.frameAttached                 {n}: follows a video/gif item whose still frame is attached picture n
transcript.reactions                     OPTIONAL {list}: appended at the end of a line after all media and forwarded tags; list is items joined with ", ". A labels file without this key renders nothing
transcript.reactionItem                  {emoji} {count}: one reaction; emoji is unicode or :name: for custom
transcript.reactionMine                  {emoji} {count}: used instead of reactionItem when the persona is among the reactors; reads correctly whether count is 1 or more
transcript.unknownDuration               shown in place of {duration} when Discord gave none
senses.imageSee | imageDescribed | imageBlind        one line each; code picks the ones true under the live config. imageSee also covers the helper's note when features.attachedDescriptions is on
senses.gifWatched | gifDescribed | gifBlind   gifWatched replaces gifDescribed when media.gif.watch is on (needs video vision on and a describe-gif or describe-video prompt); a labels file without gifWatched falls back to gifDescribed. Both say GIF descriptions come from a helper (second-hand); without a description the persona does not infer the content
senses.videoDescribed | videoBlind
senses.videoWatch                        replaces videoDescribed when features.videoDescriptions is on (needs mediaDescriptions too); covers watched, still frame and not-watched states
senses.videoRewatch                      shown alongside videoWatch when features.videoRewatch is on; tells the persona that a second look at a watched video may appear, marked as first-hand
senses.stickerSee | stickerDescribed | stickerBlind
senses.lottie
senses.customEmoji                       shown when features.customEmoji is on and the server has at least one custom emoji; tells the persona they can use server custom emoji by writing :name:
senses.gifs                              shown when features.gifs is on and the library is not empty; tells the persona they can post one GIF per turn by handle from the list or transcript; entries give the reaction, visible action and on-screen text; recent-use marks show own posts; only listed or transcript handles; unknown handle posts nothing
senses.voice | links | files
senses.linksWatch                        replaces links when features.videoDescriptions is on; adds that a linked video may come watched or not watched with the reason
senses.linksRead                         shown after the links line when features.webLookup is on and web.links.enabled is not false; tells the persona that a link may come with a read excerpt, first-hand
senses.search                            shown when features.webLookup is on, web.search.enabled is not false AND a Brave Search key is configured; tells the persona that a `<lookup>` block may appear with web results and that no search can happen during the reply itself
senses.recall                            shown right after the search line when the server-history search is available: on every server turn, and in a private chat when `features.privateLikeServer` is on (the default). Tells the persona that a search of the server's old messages either ran before the reply or did not, that its part of `<lookup>` is what the history holds (a helper's summary or a verbatim stretch), and that without it nothing was looked up there. An older labels file without the key renders nothing
senses.diary                             {channel}: shown when `diary.channelId` is set and `features.diary` is not false; tells the persona they keep a diary in that channel
senses.draw                              shown when features.imageGeneration is on and an image client is wired; tells the persona they can draw
senses.drawSpent                         replaces draw when the daily picture quota is spent
senses.drawSpentUser                     replaces draw when this member's daily quota is spent
senses.privateChat                       shown in a DM turn: this is a one-on-one conversation, what is said here stays between the two of them
senses.privateAware                      shown on a server turn when features.privateMessages is on: the persona knows they have private chats and never repeats or hints at anything from them
lookup.header                            {query}: heading of the `<lookup>` block (web search)
lookup.sources                           {list}: site names, comma-separated by code
lookup.none                              shown in `<lookup>` when the search found nothing useful
lookup.webHeader                         heading of the web part inside `<lookup>` when both web and server searches ran
lookup.serverHeader                      heading of the server part inside `<lookup>` when both web and server searches ran
lookup.bothNote                          shown between the web and server parts when both ran
lookup.stretch                           {date} {channel}: introduces a verbatim stretch of old chat inside the server part
tempo.counts                             {last10min} {lastHour} {lastDay}
tempo.authors                            {authors}: a head count
tempo.silenceBeforeTrigger | lastMessageAgo | sinceOwn          {duration}
tempo.emptyChannel | ownUnanswered
tempo.verdict                            {verdict} = tempo.verdictLive | verdictSlow | verdictDead
profile.interlocutorMark                 appended to the caller's heading (starts with a space)
profile.formerNames                      {names}
profile.character | interests | style | details | relationship  {text}
profile.aliases                          {text}: what people in chat call this member (comma-separated by code)
profile.interestItem                     {topic} {note}: one interest with a note
profile.interestItemNoNote               {topic}
profile.unsureMark                       appended to an unconfirmed interest or detail (starts with a space, self-explanatory)
profile.staleMark                        appended to an interest not seen for memory.interestStaleDays (starts with a space)
profile.unknown
profile.messageCount                     {count}: rounded down to a multiple of 10 below 100 and of 100 from 100 up, so the cached profile does not change with every message; no line below 10
profile.affinity                         {score} {band} {reason}
profile.affinityMove                     {delta} {date} {reason}: one attitude move from the history; up to `relationships.shownMoves` follow the attitude line, strongest first by size of the move, oldest first in the block, both signs kept when both exist, the current reason not repeated
profile.episodes                         heading line above the caller's episodes
profile.episode                          {date} {what} {quote} {feeling}: one remembered moment
profile.episodeNoQuote                   {date} {what} {feeling}: the same without a quote
lore.entry                               {title} {text}
emoji.header                             introduces the custom emoji list
emoji.entry                              {name} {text}: one emoji with a caption
emoji.entryNoText                        {name}: one emoji without a caption
emoji.seenInChat                         sub-heading before the described custom emoji that appeared in the transcript but are not in the top list; without it the inline `transcript.emojiDescribed` tag stays
gifs.header                              introduces the GIF library list: per entry, the reply it expresses, visible action, on-screen text
gifs.entry                               {id} {text}: one GIF with a single-line caption (entries without three-field descriptions)
gifs.entryFields                         {id} {reaction} {action} {text}: one GIF with three-field caption; code drops empty fields and their separators
gifs.entryNoText                         {id}: one GIF without a caption
gifs.ownMark                             {ago}: appended to an entry the persona posted within gifs.ownMarkHours, in the GIF picker's list
gifs.ownMarkRecent                       appended to an entry the persona posted within gifs.ownMarkHours, in the reply's <gifs> block; no time, so the cached stable part does not age; missing: no mark there
affinity.bands.hostile | dislike | cool | neutral | warm | fond | devoted
                                         thresholds in code: ≤-60 · ≤-25 · ≤-8 · <8 · <25 · <60 · ≥60
affinity.ownerSet                        reason shown when the owner set a score by hand without giving one
aboutChat.patterns | starters | injokes  {text}
aboutChat.learned                        {text}: things people taught the persona, joined by `; ` by code
aboutChat.learnedItem                    {text} {who}: one lesson with a teacher
aboutChat.learnedItemNoFrom              {text}: one lesson with no known teacher
aboutChat.unsureMark                     appended to an unconfirmed learned item (starts with a space)
server.currentMark                       appended to the current channel's heading (starts with a space)
server.category | topic | purpose | topics | tone               {text}
server.activity                          {activity} = server.activityLive | activitySlow | activityDead
server.lastMessage                       {when}: humanised age of the channel's newest message
server.topWriters                        {names}: current names of the members who write there most
server.diary                             shown on the diary channel in the `<server>` map. The persona's diary
server.readOnly                          shown on a channel the bot can read and react in but not write in; never shown on the current channel. Appears in the `<server>` map entry and as a line after a pulled channel's header
senses.time                              shown in every `<senses>` block right after the files line, private chats included: message times are in the timezone of `<now>`, older lines carry their age, a gap marker is only the silence between two adjacent lines, and how long ago something happened comes from its own lines, never from a gap marker or `<tempo>`. No placeholders; a missing or empty key renders nothing
senses.channels                          shown on every server turn: which channels this request shows (the chat, `<other_channels>`, `<channel_view>`); never claim to have looked at a channel not shown
senses.elsewhere                         {destination}: shown when `features.elsewhere` is on and `memory.mainChannelIds` has a usable channel; says a call from a read-only channel is answered in {destination} with a link
senses.participation                     shown right after `senses.channels` while the request carries a `<participation>` block (never in a private chat): what the block holds and how to use it. A missing key renders nothing
pull.header                              REQUIRED {channel} {from} {to} {ago}: first line of a pulled channel. Without it no `<channel_view>` renders. {from}/{{to}} are formatted dates, {ago} is a duration phrase from labels.units
pull.olderNotShown                       shown when older messages exist in the pulled channel that are not included
pull.picturesNotSeen                     {count}: shown when pictures in the pulled channel were not looked at
pull.earlierPings                        {date}: heading before earlier calls to the persona in that channel, older than the window
pull.pingAnswered                        appended to a pulled line that called the persona and was answered
pull.pingUnanswered                      appended to a pulled line that called the persona and has not been answered yet
pull.pingSkipped                         OPTIONAL appended to a pulled line the persona saw and chose to let pass; without it no mark is shown for skipped calls
elsewhere.called                         {channel} {destination}: appended to the reply task text on a turn answering a call from a read-only channel
elsewhere.link                           {text} {link}: joins the jump link to the persona's posted message; members read it, the model never sees it
triggers.mention | reply | name | followUp | overheard   followUp = an untagged message the address classifier judged to be for the persona; overheard = talk about the persona, not to them. Both post plain, never as a Discord reply. overheard falls back to followUp, then reply
triggers.private                         the trigger for a private (DM) message
triggers.drawFailed                      {reason}: the drawing sub-process failed; reason is the human phrase from draw.reasons.*
draw.when                                {when}: the local date and time shown to the image model so the light and season match. Filled for every picture (diary or not) when the time is known; empty otherwise
draw.reasons.moderation | daily | userDaily | timeout | error    human phrases for the five failure reasons; daily and userDaily are reserved but no longer reached by triggers.drawFailed — an image cap now posts limits.notice instead of a follow-up turn
diary.intro                              first line of the `<diary>` block
diary.line                               {date} {kind} {gist}: one past post
diary.picture                            {scene}: appended to a diary line when the post had a picture
diary.pictureUnknown                     placeholder scene when a backfilled post had a picture but the scene was not recorded
diary.kindUnknown                        placeholder kind for a backfilled post with no recorded kind
diary.kinds                              first line of the `<kinds>` block
diary.kindLine                           {key} {weight} {count} {window}: one kind with its weight and use count
diary.plan                               first line of the `<plan>` block
diary.found                              first line of the `<found>` block
diary.seeds                              first line of the `<seeds>` block
diary.topic                              first line of the `<topic>` block (the owner's topic for a forced post)
memory.privateNote                       the <private> block content in a private analyzer batch: marks the batch as a private conversation, constrains output to users for the partner's id only
memory.privateChannel                    heading used in place of a channel name for the <new_messages> section in a private batch
limits.notice                            {limit} {used} {cap}: posted as a plain reply when a rail refuses a triggered action; limit is the config key, used/cap are the numbers
limits.paused                            posted as a plain reply when the persona is called while paused (`features.pauseNotice`). No placeholders. At most once per channel per `mention.pauseNoticeMinutes`
warmup.ownMark                           prefixed to a member's own lines in the profile.md transcript
warmup.contextMark                       prefixed to context lines in the profile.md transcript
mentor.intended                          array of short strings: engine behaviours that must not cost points in the mentor's scoring
mentor.examples                          first line inside the `<examples>` block in a situations request: introduces the real moments
mentor.original                          first line inside the `<original>` block in a score request: introduces the persona's rejected answer
room.focus                               {target} {author}: appended to the reply task when a room question triggers the turn
address.author                           {name} {aliases}: the candidate author's display name and known aliases, shown to the address classifier when the member has aliases
recent.header                            REQUIRED {hours}: the block's first line. A missing header or a missing `recent.line` means no `<recent>` block
recent.line                              REQUIRED {date} {time} {text}: one note from the turn's own channel or an unnamed channel
recent.lineIn                            OPTIONAL {date} {time} {channel} {text}: a note from another named channel; {channel} arrives without '#'. Without it `recent.line` is used
recent.episode                           OPTIONAL {date} {name} {what}: a moment the persona remembers with {name} on {date}; no quote, no feeling. Without it the block shows notes only
attitudes.header                         the block's first line: who these members are and how to use the list
attitudes.line                           {name} {band}: one member and their attitude band
participation.header                     REQUIRED {hours}: the `<participation>` block's first line. A missing header or a missing `participation.episode` means no block
participation.channel                    {channel} {purpose}: one channel's line, once before its episodes; {channel} arrives without '#'; {purpose} is the stored channel note's purpose
participation.channelNoPurpose           {channel}: the channel's line when its note has no purpose
participation.episode                    REQUIRED {when}: one episode's first line; {when} is a duration in `labels.units` (how long ago the persona's newest line in it was)
participation.skipped                    {count}: one run of lines cut from a long episode. Without it the cut is not marked
task.part                                {index} {total} {part} {others}: this turn answers one part of a split message. {index} is 1-based, {part} is the text of this part, {others} lists the remaining parts and any queued calls as numbered items joined by `; `. Without this key the splitter is off even when the prompt file exists
task.queued                              {others}: the trigger author has other calls waiting, listed as numbered items joined by `; `. Shown only when there is no `task.part` for this turn. Without this key the waiting calls are not named and the seen-in-history drop rule applies to them
task.queuedOthers                        {others}: other members have calls waiting in this channel, listed as `<n>. <author>: <text>` items joined by `; `. Without this key those calls are not named
task.added                               {added}: later messages from the author were folded into this call while it waited, joined by `; `. Without this key the folded messages are not named
```

## Output

Only these tags are acted on:

- `<think>…</think>` optional, first, 1–4 lines of hidden planning; an unclosed one means silence.
- `<msg>text</msg>` one chat message, up to 3 in a row; `reply="#87"` makes it a Discord reply.
- `<react to="#87">💀</react>` one unicode emoji or one server custom emoji as `:name:`; alone or with `<msg>`.
- `<gif reply="#87">g12</gif>` posts a GIF from the library by handle (body = the handle from the `<gifs>` list or from the transcript, never a URL). One per turn; `reply` optional as on `<msg>`. May stand alone or alongside `<msg>`, `<react>`, `<draw>`. Unknown handle = nothing posted.
- `<draw self="yes" reply="#87">scene</draw>` a picture for the drawing sub-process. One per turn, first non-empty wins, clamped to 800 chars. `self="yes"` adds the persona's appearance; `reply="#87"` works like on `<msg>`. May appear alongside `<msg>` and `<react>`.
- `<skip/>` stay silent.
- `@nick` exactly as in the transcript becomes a real mention.
- `#channel-name` of a server channel in `<msg>` text becomes a real channel link (`<#id>`) when `features.channelLinks` is on (default true, missing = on). Names are matched longest first; an existing link is left alone.
- `:name:` of a known server custom emoji becomes the real emoji in `<msg>` and `<react>`; an unknown name stays as plain text.

`features.reactions: false` drops `<react>`, `features.multiMessage: false` keeps the first `<msg>`;
`features.gifs: false` or an empty library drops `<gif>`; `features.imageGeneration: false` or no image client drops `<draw>`; on a `drawFailed` turn `<draw>` is dropped too. Prompts need not know.

With `format.stripDashes` on (default true; missing = on; only `false` turns it off), every em dash and en dash is removed from `<msg>` texts before posting: the dash and the spaces around it become one space, and every guillemet (`«`, `»`) becomes a plain `"`. A message left empty after stripping is not sent. Hyphens stay. `<draw>`, `<react>`, `<gif>` and reply ids are not touched. Logged as `turn: dashes stripped` with `channel` and `count`, never the text.

A `<react to="#n">` targeting a `<channel_view>` line places the reaction in that line's channel when the bot has Add Reactions and Read Message History there; otherwise the reaction is dropped. A `reply="#n"` targeting a pulled line posts plain in the turn's channel (never as a Discord reply to a message in another channel); each pulled line is linked at most once per turn. On a turn answering a call from a read-only channel, the first message carries one jump link: to the pulled line it answers, or to the routed call, or to the newest line of the source shown. `@name` resolves over the authors of pulled lines too.

## Analyzer

One call (`memory.md`) updates everything the persona remembers. It judges people **through the persona's eyes**, so it receives
the character card. Whether a channel is alive is NOT its call; code counts that. The warmup feeds old history
through the warmup prompts (`profile.md`, `channel.md`, `server.md`), not through the analyzer.

The numeric limits in the prompt are placeholders filled at runtime from `config.memory.*` and `relationships.maxDeltaPerUpdate`.

Input: `<character>` · `<existing_profiles>` (JSON by user id; each profile is either whole or compact. A whole profile carries prose fields, attitude, and the ranked top of interests, details, aliases and episodes: interests capped at `memory.maxInterests`, details at `memory.maxDetails`, aliases at `memory.maxAliases`, episodes at `memory.analyzerEpisodes` (default 8). A compact profile carries only `names`, `affinity` and `"compact": true`. When the batch is too large to fit every profile whole, authors with the most shown lines keep theirs whole and the rest arrive compact. Log fields `profilesWhole`, `profilesCompact`, `profilesTokens` on `memory: update applied`) · `<existing_lore>` ·
`<existing_guild>` (JSON: patterns, starters, in-jokes, learned items; may carry `"stale": { "days": n }` when the server notes are due for review) · `<existing_channels>` (JSON by channel id: `name`, Discord `category`, `topic`, stored `purpose`,
`topics`, `tone`; an entry may carry `"stale": { "days": n }` when its notes are due for review) · `<known_members>` (guild batches only, absent from private batches; may be partial or absent entirely: stored members who did NOT write in this batch, each with their display names and aliases, so the analyzer can record an alias for one of them; at most `memory.aliasRosterSize` entries, most recently seen first, `0` = off; ranked before the transcript in the budget so a heavy batch cannot starve it, not required so it never makes the request fail) · `<new_messages>` grouped under `## #channel-name (id:123)`, lines `[14:32] nick (id:123): text`,
a line addressed to the persona starts with `→ `, own lines use `labels.self`.

Section order in the user message (budget trims from the bottom first): compact profiles of every author, the roster (`<known_members>`), the transcript (`<new_messages>`), whole profiles (offered only for authors with a shown line, most lines first), recent notes (`<recent_notes>`). The guild, channel and lore blocks sit before the compact profiles. A profile that does not fit whole is sent compact; the request never fails because of a profile.

Output: a bare JSON object. Profiles are updated INCREMENTALLY: the analyzer returns changes, never a re-summary
of what is already stored, so facts are not degraded by being rewritten batch after batch:

```
{
  "users": { "<userId>": {
      "portrait": "",                                                // OPTIONAL: one-line cue that the stored character/style misses something
      "relationship": "",                                            // OPTIONAL: present when first written or when it must change, then the whole new text
      "aliases": { "add": [""], "remove": [""] },
      "interests": { "add": [ { "topic": "", "note": "", "sure": false } ], "update": [ { "topic": "", "note": "" } ],
                     "seen": [ "topic" ], "remove": [ "topic" ] },
      "details":   { "add": [ { "text": "", "sure": false } ], "seen": [ 3 ], "remove": [ 3 ] },   // numbers = stored detail ids
                                                                                 // "sure" is OPTIONAL everywhere, default true
      "affinity":  { "delta": 0, "reason": "" },
      "episodes":  [ { "date": "YYYY-MM-DD", "what": "", "quote": "", "feeling": "", "weight": 3 } ] } },
  "guild": { "patterns": "", "starters": "", "injokes": [""],
             "learned": { "add": [{ "text": "", "from": "<@id>" }], "seen": [3], "remove": [3] } },
  "channels": { "<channelId>": { "purpose": "", "topics": "", "tone": "" } },
  "lore": [ { "title": "", "keys": [""], "text": "" } ],
  "self": [""],
  "note_reviews": [{ "target": "", "status": "" }]
}
```

- **Interests are atomic items**, not prose: `topic` (≤ `{{interestTopicChars}}`, the identity, compared
  case-insensitively) and `note` (≤ `{{interestNoteChars}}`, what exactly about it; may be empty). Both placeholders
  are filled from `memory.interestTopicChars` / `memory.interestNoteChars` like the other limits. Stored per person up to `memory.maxInterestsStored`, each with a
  weight that grows when the analyzer adds or updates it again; the lowest rank is evicted first. The input shows the
  stored items so the analyzer adds only new ones, updates a note only when it learned something, removes only what
  the person has clearly dropped.
- **Details are atomic items too**: `{ id, text, weight, firstSeen, lastSeen }`. The input shows each stored detail
  with its numeric `id`; `seen` and `remove` refer to details by that id (code also accepts the exact stored text).
  `add` takes `{ text, sure? }` (a bare string is accepted). Over `memory.maxDetailsStored` the lowest rank is
  evicted.
- **Learned items are atomic items at the guild level**: `{ id, text, from, weight, firstSeen, lastSeen }`. `from`
  stores the member who taught it (`<@id>`, or empty). The same `add` / `seen` / `remove` ops, the same confirmation
  mechanics, the same rank and eviction as details. `memory.maxLearned` shown, `memory.maxLearnedStored` kept,
  `memory.learnedChars` per item. The chat model sees them in `<about_chat>` after the in-jokes line, ranked,
  unconfirmed ones marked with `labels.aboutChat.unsureMark`.
- **Confirmation (the "(?)" mechanism), same for interests, details and learned items.** `weight` counts the separate OCCASIONS a
  thing was observed. A new item starts at weight 1, or 0 when the analyzer marks it `"sure": false` (unclear whose it
  is, unclear whether it was meant seriously, or a name the analyzer does not recognise). `seen` (nothing new to say,
  but it came up again), `add` of an existing item and `update` each count as one sighting; a sighting raises the
  weight by 1 only when the person's messages in this batch are at least `memory.confirmGapHours` away from the
  item's `lastSeen` (so one long conversation split across batches counts once). An op with `"sure": false` on an
  existing item changes nothing. An item is CONFIRMED when weight ≥ `memory.confirmAfter`; until then the chat model
  sees it with `labels.profile.unsureMark`.
- **More is stored than shown, and rank decays with age.** Code keeps up to `memory.maxInterestsStored` /
  `memory.maxDetailsStored` items per person; the persona AND the analyzer see only the top `memory.maxInterests` /
  `memory.maxDetails` by rank. Rank = `log2(weight + 0.5) + lastSeen / halfLife` (half-lives
  `memory.interestHalfLifeDays`, `memory.detailHalfLifeDays`), i.e. weight halves with every half-life of silence, so
  what is frequent AND recent is on top, and a newcomer can gather weight in the unseen tail instead of being evicted
  the moment it arrives. Eviction drops the lowest rank. If the analyzer `add`s something that is stored but not
  shown, code counts a sighting; the prompt therefore tells it to add whatever is new to IT and never to hold back
  because a list looks full.
- **Dates come from the messages**, not from the clock: `firstSeen` / `lastSeen` are the time of the person's
  newest message in the batch that produced the sighting (min / max, so history fed out of order still works). An
  interest whose `lastSeen` is older than `memory.interestStaleDays` is rendered for the chat model with
  `labels.profile.staleMark` and sorted after the fresh ones. Details never go stale.
- The input view of a stored item: interests `{ topic, note, seen, last }`, details `{ id, text, seen, last }`
  (`seen` = weight, `last` = `YYYY-MM-DD`, omitted when unknown).
- **Attribution, for every profile field.** Something is recorded about a person only from that person's OWN
  messages: they bring it up, return to it, or speak about it with substance. Being present in, or replying once to,
  someone else's topic is not theirs. A note may only contain what was said about THAT topic; when it is unclear
  which topic or which person a remark belongs to, it is dropped or marked `"sure": false`. Things everybody on the
  server does belong to `guild.patterns` or `lore`, not to every profile.
- **What each prose field is.** `character`: how the person acts with others, as a handful (4–7) of concrete
  RECURRING habits told in the persona's voice ("habits beat labels": never a row of adjectives or an assessment);
  skills, knowledge, jobs, hobbies and one-off actions are not character. Stored adjective/assessment text is
  rewritten from the batch, not patched. `character`, `relationship`, the affinity `reason` and an episode's `feeling`
  are written in the persona's voice from the card (first person allowed, no clinical vocabulary). `style`:
  HOW the person writes (length, rhythm, vocabulary, emoji habits), not what they do or talk about. `relationship`:
  how the persona and this person stand with each other, not news and not the person's relations with others; written
  first when the stored text is empty and a batch shows them dealing with each other (or affinity/episodes already
  exist), afterwards only when it must change. When the profile carries `relationshipStale`, the text is due for a
  rewrite: `writtenAt` is the band the text was written at (or `none` when unwritten), `now` is the current band
  (`affinity.band`), `cause` is one of `first` (empty text with a non-zero score, a reason or episodes), `band`
  (the band changed, past `relationships.bandHysteresis`), `drift` (the score moved `relationships.rewriteOnDrift`
  points since the text was written, within the same band), or `moves` (at least `relationships.rewriteAfterMoves`
  attitude history entries since the text was written). Code stamps `relationshipScore` and
  `relationshipWrittenAt` each time `relationship` is written and compares bands and drift to detect staleness.
  Switches: `relationships.rewriteOnBandChange` (default true, missing = on), `rewriteOnDrift` (default 8, `0` = off),
  `rewriteAfterMoves` (default 6, `0` = off).
  Relationship text ≤ `relationships.textChars` (default 600, placeholder `{{relationshipChars}}`); other prose fields
  ≤ `memory.fieldChars`; an absent field leaves the stored text untouched.
  `character` and `style` are written ONLY by `profile.md` (the warmup and a portrait refresh), never edited by the
  stream analyzer directly. The analyzer returns `portrait` (a one-line cue about what the stored text misses) when
  a batch warrants it, and code queues a refresh.
- **Members are referred to by id, never by nickname.** Nicknames change daily, so in every free-text field the
  analyzer writes (profile prose, interest notes, detail text, episode `what`/`feeling`, affinity reason, `guild`
  fields, channel notes, lore `text`, `self`) a member is written as the token `<@id>` (the id from the transcript's
  `nick (id:123)`, from `<existing_profiles>` or from `<known_members>`). Only when the analyzer is sure who is meant; otherwise the name stays
  as written; an id is never invented. Verbatim `quote`s and lore `keys`/`title` are left alone. Code resolves tokens
  at the moment of use: for the chat model `<@id>` becomes the member's current name (the same string the transcript
  shows, so `@name` still works), for the analyzer it becomes `name (id:123)`; on the way in, code turns a
  `name (id:123)` the model wrote back into the token and leaves unknown ids untouched.
- **Aliases** are what people in chat actually call a member (a stable nickname like a shortened or translated name),
  NOT Discord display names. `users.<id>.aliases: { "add": ["…"], "remove": ["…"] }`; stored as ranked items like
  interests (`memory.maxAliases` shown, `memory.maxAliasesStored` kept, `memory.aliasHalfLifeDays`), an `add` of a
  known alias is a sighting. The input view shows them as a plain list; the chat model sees them through
  `labels.profile.aliases` `{text}`. A member whose current name OR alias occurs in the recent transcript is pulled
  into `<people>` even if they have not spoken; members referred to in the trigger or the last five messages (by mention, current name or alias, prefix match for names of 4+ characters) come right after the interlocutor in full (`context.askedAboutProfiles` at most), the other recent participants after them in compact form (name, aliases, character, attitude, top 5 topics); the budget trims the compact ones first.
  For a member listed in `<known_members>` (a roster member), only `aliases` is applied; every other key in the answer is dropped and counted. A profile is never created for a roster member: it must already exist. Guards on a proposed alias (all members, authors and roster alike): dropped when it holds a `<@` token or an `(id:` marker, dropped when it equals one of the member's stored display names (case-insensitive, punctuation ignored). A bare array under `aliases` (instead of `{ add, remove }`) is read as an add of the names not already stored (it never bumps a stored alias). The `firstSeen`/`lastSeen` date for a roster member's alias comes from the newest message in the batch, since the roster member wrote no message themselves.
- **Main channels are the source of the portrait.** `memory.mainChannelIds` (default `[]`) lists the channels where
  people talk to each other; in `<existing_channels>` such a channel carries `"main": true` (key omitted otherwise).
  `character` and `style` are judged from how the person talks with others in a main channel; diaries and topical
  channels feed interests and details, not the manner of speech. While a person has no main-channel messages the
  portrait is provisional and short. In a batch with the person's main-channel messages the portrait refresh REFINES both
  fields: returns the whole new text (≤ `memory.fieldChars`), carrying forward what still holds, adding what the batch
  showed, letting newer evidence outweigh older and dropping what no longer shows, so the portrait follows the person
  over the years. When no channel is marked main, every channel counts as main.
- **Server-level notes are about the server.** What one person does in their own channel is not a `guild` pattern,
  starter or in-joke, and not `lore`; an in-joke is something several people use.
- **Limits are enforced without cutting.** A prose field returned over its stated character limit is not stored: the previous text stays. Code never shortens a model's rewrite. The prompt tells the model the limit; the code holds it to the exact number (code points). Only the FIRST write of an empty field is cut to the limit with `memory.clampTolerance` (default 1.25), because there is nothing to lose yet; that cut lands on a sentence or word boundary, never inside a `<@id>` token. The stream analyzer does not retry: the overflowing field is left out of the batch's write and counted. The voice model, the portrait refresh and the notes refresh retry once (when `memory.overLimitRetries` is above 0): the model's own answer comes back as an assistant turn, followed by a user turn with an `<over_limit>` block listing each overflowing field's character count and limit. A second overflow keeps the previous text. A stored note or text that visibly breaks off mid-word (cut by an older version) is rewritten whole the next time its subject comes up.
- **Output economy.** `"sure"` is written only when false; `affinity` is omitted when nothing changed.
- **One home per fact.** An event goes to `episodes` or `lore`, a fact to `details`, a pastime to `interests`, a
  lesson addressed to the persona to `learned`; the same thing is never written into several fields.
- **Sanity check against what the model knows.** Before attaching one named thing to another (a region, mode,
  character or item to a game; a person to a franchise), the analyzer checks that they belong together. When the
  chat's wording conflicts with its knowledge, or it does not recognise the thing, it does not glue: it records the
  thing on its own with `"sure": false`. It never "corrects" the chat.
- **The note says what the person does with the topic** (plays, watches videos about, only mentioned), and something
  the person did long ago and dropped is not an interest (at most a detail). What cannot be understood without the
  conversation around it is not recorded.
- Deliberately absent: any rule about irony or sarcasm. Uncertainty of every kind goes through `"sure": false`.
- The analyzer prompt stays short; every added rule is paid for by tightening existing text.
- Only users and channels with something new. A returned channel / `guild` / `self` is the WHOLE merged value and
  replaces the stored one; empty `guild` / `self` = nothing new. A returned blank string for a channel field (purpose, topics or tone) is ignored; the stored text stays.
- **Stale-note review.** A channel or guild entry carrying `"stale": { "days": n }` needs exactly one item in the top-level `note_reviews` array: `{ "target": "<channelId>" | "guild", "status": "updated" | "confirmed" | "insufficient_evidence" }`. `updated` means the batch justified a content change, returned through the normal `channels` or `guild` output. `confirmed` means the analyzer examined the stored notes against relevant evidence in this batch and found no change warranted (a batch-level review, not a certificate for the full period). `insufficient_evidence` means the batch has too little relevant material to judge. Code stamps `notesCheckedAt` only for `confirmed` and for `updated` whose stored text really changed (in two-stage mode, a queued voice brief for `patterns`/`starters` counts as the change). `insufficient_evidence`, a missing item, and `updated` with identical text do not stamp; the target is flagged again after `memory.notesRetryHours`. Every flag stamps `notesFlaggedAt`.
- `affinity` is a CHANGE: integer `delta` (usually ±1…5, up to ±`relationships.maxDeltaPerUpdate` for something
  striking), one-line `reason` naming an observed event. Code clamps it to ±`relationships.maxDeltaPerUpdate`, accumulates into −100…100, keeps a short
  history. The model never sets the absolute score. Scores drift toward zero daily when `relationships.decayPerDay`
  is set: per day the score loses `decayPerDay * |score| * (|score| / 100) ^ decayPower`, faster the further from
  zero; negative scores rise the same way. Applied at startup and hourly from a per-profile stamp
  (`affinity.decayedAt`), whole days only, so downtime is caught up. Never runs while paused or during the warmup.
  No history entry is written.
- `episodes` are APPENDED, never rewritten: return only NEW moments worth remembering for months: an insult, a
  kindness, a promise, a bet, a fight, a shared joke, something the person asked the persona to do or never do. `what`
  one line; `quote` the person's own words verbatim, short (≤ 120 chars), or empty; `feeling` how the persona took it,
  judged through the character card; `weight` 1–5 (5 = never forget). At most `memory.maxNewEpisodes` per user per
  batch; most batches add none. The input shows the episodes already stored so nothing is recorded twice. Code keeps
  `memory.maxEpisodes` per person, evicting the lightest, then the oldest; the `memory.keepNewestEpisodes` (default 5)
  most recently added episodes are exempt from eviction, so a light new moment of an active member is not pushed out
  on arrival.
- `lore` is the server's lorebook: things that outlive a conversation: events ("the day X left"), recurring
  characters and pets, long-running stories, feuds, traditions. `title` is the identity (an entry with the same title
  is an UPDATE and carries the whole merged text), `keys` 2–6 words or short phrases that people actually type when
  the thing comes up (names, nicknames, the meme's wording, in the chat's language, lowercase), `text` ≤ `lore.textChars` (`{{loreTextChars}}`).
  Input `<existing_lore>` lists stored titles with their keys, and the full text of entries the batch touches.
  Entries added by the owner (`/nep lore add`) are never changed by the analyzer.
- String fields ≤ `memory.fieldChars`; details ≤ `memory.maxDetails`, injokes ≤ `memory.maxInjokes`, self ≤ `memory.maxSelfFacts`. Notes in the language the chat speaks.
  Observed facts only; nothing sensitive (addresses, phones, documents, health, finances, real full names).
- **Counters on `memory: update applied`** (logged after each batch): `roster` (members sent in `<known_members>`), `rosterCandidates` (roster entries offered to the budget), `rosterTokens` (estimated tokens the sent roster took), `aliasesChanged` (members, authors and roster, whose stored alias list really changed), `aliasOnly` (roster members among them), `droppedUsers` (entries for an id that is neither an author nor a roster member with a stored profile), `droppedFields` (non-alias keys dropped from roster members' entries), `portraitDropped` (authors' non-blank `character`/`style` dropped), `notesFlagged` (channel or guild entries that carried a stale flag in this batch), `overLimit` (prose fields refused because the model's text exceeded the limit), `overLimitFields` (array of `kind.field` names, e.g. `['channels.topics', 'guild.patterns', 'lore.text', 'users.relationship']`; no member ids). When flags were sent, also: `notesUpdated`, `notesConfirmed`, `notesInsufficient` (the three review statuses), `notesMissing` (flagged targets the model did not return), `notesIdentical` (`updated` whose text matched storage), `notesUnflagged` (a review returned for a target that was not flagged).

### Two-stage mode

When `features.memoryTwoStage` is exactly `true` and both `prompts/memory-decide.md` and `prompts/memory-voice.md`
are present, guild batches are split into two stages. A switch on with a prompt missing falls back to single-stage
mode. Private batches always use single-stage mode (`memory.md` on `llm.model`).

**Stage A** runs `memory-decide.md` on `memory.model` (role `analyzer`). It returns the same JSON structure with
neutral decisions: interests, details, aliases, in-jokes, channel notes, lore, `style` and the episode line and
quote are stored at once. Voice fields (relationship, affinity reason, episode feeling, lessons, self-facts, server
patterns, starters, character) are returned as neutral briefs and queued for stage B. The attitude delta is applied
at once with the stored reason kept; episodes are stored at once with an empty feeling. `character`, `style` and
`portrait` keys from stage A are dropped and counted. Known-members roster rules apply to stage A: aliases for
roster members are stored by stage A alone.

The stage A answer shape for voice fields:

- `relationship`: a brief (only when `relationshipStale` or the standing changed).
- `affinity.delta`: an integer; `affinity.event`: a neutral one-line reason (the key is `event`, not `reason`).
- `episodes[].tone`: how it landed, neutral (becomes the feeling's brief for stage B).
- `guild.learned.add[].brief`: the lesson as a neutral claim (the key is `brief`, not `text`).
- `self`: an object `{ "add": [...], "remove": [...] }` (a bare list is ignored).
- `guild.patterns` and `guild.starters`: briefs, only when the note must change.

**Stage B** runs `memory-voice.md` on `llm.model` (role `voice`). It takes the
queued items and returns `{ "items": { "<id>": "<text>" } }`. Each item carries its kind, the stored old text (when
applicable), the neutral brief from stage A, and a character limit. Applied items leave the queue; items left out of
the answer are retried with increasing back-off. Items that expire (older than `memory.voice.queueHours`, or left
out `memory.voice.maxAttempts` times) take the degraded path: a feeling falls back to the stage A tone, lessons and
self-facts are stored from the brief, and the rest (relationship, reason, patterns, starters) are dropped (the delta
already landed, and the stale markers bring the notes back). Character items never expire, overflow or take the
degraded path.

The voice queue is persisted in `data/guilds/<id>/voice.json`. It survives restarts. `/nep memory forget` removes
the member's queued items and the lessons they taught. `/nep memory wipe` deletes the queue file. One voice request
runs after each successful stage A batch and on every tick that finds due items, at most `memory.voice.maxPerDay`
(default 100) per UTC day. Each request carries up to `memory.voice.maxItems` (default 24) items, fitted under the
50k token rail.

Counters on `memory: voice applied`: `overLimit` (items refused after the retry, whose stored text stayed), `overLimitRetried` (items sent again with the `<over_limit>` block). When the retry request itself failed (bad JSON, timeout, provider error), `retryFailed` carries the reason string.

### Portrait and notes refresh overflow

When a portrait refresh produces a `style` or `character` text over the limit, the same retry runs: the model's answer comes back as an assistant turn, a user turn with `<over_limit>` follows. A second overflow ends with outcome `over-limit` on `warmup: portrait refresh failed` with `fields` (the field names that overflowed). The attempt stamp is set and the day's slot is used (the request was sent), but nothing is written.

When a notes refresh (`channel.md` or `server.md` in refresh mode) produces a field over the limit, the same retry runs. A second overflow ends with `warmup: notes refresh failed`, reason `over-limit`, `fields` listing the field names. Nothing is written for that channel or server. The next attempt fires after `memory.notesRetryHours`. The notes scheduler moves on to the next target.

### Version history

When `features.versions` is on (the default), every replacement of a prose field's text is recorded before the new text is stored. The previous text goes into `data/guilds/<guildId>/versions/<kind>/<id>.json`, where `kind` is `users`, `channels`, `guild` (id `guild`) or `lore` (id is a slug of the entry title plus a short hash). Each file holds one JSON object keyed by field name, each value an array of records (newest last):

```
{ "<field>": [ { "at": "ISO", "by": "analyzer"|"voice"|"portrait"|"refresh"|"warmup"|"unknown", "chars": n, "before": n, "after": n, "kept": n, "removed": n, "added": n, "text": "<previous text>" } ] }
```

`before` and `after` are sentence counts of the old and new texts. `kept` is how many sentences appear in both. `removed` = `before - kept`, `added` = `after - kept`. A rewrite that keeps 0 sentences of 8 means the model replaced the entire text. At most `memory.versionsKept` (default 20) records per field; the oldest entry is dropped when the cap is exceeded. A first write (the field was empty) records nothing. An identical rewrite records nothing. Private-chat relationship texts are not versioned.

`/nep memory forget` deletes the member's version file. `/nep memory wipe` deletes the entire `versions/` folder for the server.

Each record logs `store: version recorded` with `kind`, `field`, `by`, `chars`, `kept`, `removed`, `added` (a channel id for channel versions, never a member id).

## Channel map

The `<server>` block is assembled from stored channel notes and code-maintained facts, filtered to only the channels
that matter for this turn. The current channel appears first, marked with `labels.server.currentMark`; then a pulled
channel's stored note (when a pull happened), then the neighbour channels that contributed messages to
`<other_channels>` this turn, each in full. Every other stored channel is left out. On a large server most of them
are irrelevant and waste budget. A channel the bot can read but not write in carries `labels.server.readOnly` (never
shown on the current channel). The dry-run mirror channel (`bot.dryRunChannelId`) is never read as a neighbour, a
spontaneous candidate, by the warmup or by the emoji backfill.

A channel entry (`renderChannel` in `src/memory/channels.js`) carries:

- **Discord facts:** name (the `# heading`), category, topic. Present from the moment the channel is first seen.
- **Analyzer notes:** purpose, topics, tone. Written by `channel.md` during the warmup and updated by the stream
  analyzer (`memory.md`) from live batches. All three are free-text, token-resolved (`<@id>` → current name) at render
  time.
- **Code-maintained counters:** message count, the timestamp of the first and last message, a 30-day activity
  histogram (messages per UTC day, trimmed to the 30 most recent days), and the top 5 writers (by message count,
  excluding bots and the persona). The warmup fills these from the channel's fetched history via
  `store.setChannelFacts`; live traffic keeps them current via `store.touchChannel`.
- **Activity verdict:** `live`, `slow` or `dead`, computed by `channelActivity` from the counters, never the model's
  call. `live` when the sum of today's and yesterday's (UTC) messages reaches
  `context.channelActivity.liveMessagesPerDay` (default 20). `dead` when the channel has never seen a message or the
  last one is older than `context.channelActivity.deadAfterDays` (default 7). `slow` is everything in between.
  Rendered via `labels.server.activity` / `activityLive` / `activitySlow` / `activityDead`.
- **Last message age:** humanised via `labels.server.lastMessage` when the label exists and the data is available.
- **Top writers:** rendered via `labels.server.topWriters`, resolving stored author ids to current names; an id with
  no profile is skipped.

When the current channel has no stored note yet (the analyzer has not touched it), a fallback entry is synthesised from
the Discord facts of the messages in the transcript, so the persona still knows where they are.

## Warmup

Each warmup request handles one unit of work (one channel, one person or the server), so attribution stays clean.
`channel.md` produces channel notes (purpose, topics, tone). `profile.md` produces a member's character, style,
interests, details, episodes and aliases. `server.md` produces server-wide patterns, conversation starters, in-jokes and
lore. For the run order, sampling, progress, rails and subcommands see [Warmup](warmup.md).

### Data model

`character` and `style` STAY PROSE and are written ONLY by `profile.md`: by the warmup and by a PORTRAIT REFRESH.
The stream analyzer never edits them directly. A stream batch can no longer overwrite `character` or `style`; any
non-blank value from a stream batch is dropped and counted as `portraitDropped`. For a member whose batch shows a
recurring habit or a change in how they write that the stored portrait misses or contradicts, the analyzer returns
`users.<id>.portrait: "one line: what the portrait misses"`, and code queues a refresh.

Portraits are also refreshed by code on a periodic schedule (`features.portraitRefresh`). A member is due by one of two paths. The counter path: at least `memory.portraitRefreshMessages` (default 300) own messages since their last portrait AND at least `memory.portraitRefreshDays` (default 3) have passed. The age path: the portrait is at least `memory.portraitMaxAgeDays` (default 21) days old AND at least `memory.portraitMinMessages` (default 60) own messages have accumulated since. A failed attempt
backs off for `memory.portraitRetryHours` (default 24). The scheduler checks every `memory.portraitCheckMinutes`
(default 60) and refreshes up to `memory.portraitRefreshPerDay` (default 3) members per day. Queue order: the member waiting longest first (`portraitDueAt`, stamped when a member first becomes due, cleared on a finished portrait), then the oldest portrait, then the most own messages since the last portrait.
A member with no portrait stamp counts all their messages, so several qualify at once on first deploy; the daily
cap spreads them over a few days. Code-triggered refreshes, analyzer cue refreshes and `/nep memory refresh` share
this cap. Each refresh is fitted under the 50k token rail (`llm.maxRequestTokens`), shrinking the sample if needed. A provider error after the request was sent (HTTP 408/429/5xx or a timeout) gives the day's slot back and restores the previous attempt stamp, so the member stays due; the scheduler ends its cycle for this tick.

`profile.md` is called with `<draft>` = the stored character + style, `<hint>` = the analyzer's line (when present),
and the answer's `character` and `style` replace the stored ones. The draft is a MERGE base: every point still
compatible with the sample stays (condensed to make room), points the sample contradicts are revised, new recurring
habits are added, and a point the sample merely does not show is NOT dropped. Interests, details, episodes and
aliases of the refresh answer are IGNORED; they keep flowing through the stream ops.

In two-stage mode (`features.memoryTwoStage`), the portrait refresh uses `prompts/portrait.md` on `memory.model`
(stage A), which returns a merged `style` text stored at once and structured `character` edits queued as a voice
item. The next voice run (stage B) words the character text. Details of this flow are in a later documentation pass.

Attitude and `relationship` are NOT warmed up; they grow from live conversation only.

`profile.md` output: `{ "character": "", "style": "", "interests": [{ topic, note, times }], "details": [{ text, times }],
"episodes": [...], "aliases": [""] }`; blocks `<character>` `<member>` `<draft>` (optional) `<hint>` (optional, portrait
refresh only) `<snippets>`. Own lines in the snippets start with `labels.warmup.ownMark`; context lines start with
`labels.warmup.contextMark`. Aliases come from OTHER people's lines (how they address the member), so the
own-lines attribution rule does not apply to them. One explicit naming statement is enough evidence for an alias; a teasing name thrown once in passing is not.

## Address classifier

After the persona answers someone, a conversation window opens in that channel (`mention.followUpMinutes`, extended
by every further answer). A message inside the window that carries no trigger (no mention, no reply to the persona,
no name) is not answered blindly: code sends the last `mention.followUpContext` (default 15) lines of the channel, the
persona's own lines marked with `labels.self`, plus the new message marked as `<candidate>`, to `address.md` on
the `classifier.text` model (default `anthropic/claude-sonnet-4.6`). The transcript carries cached media captions
(pictures, stickers, GIFs, custom emoji, watched videos) in the same label forms as the persona's transcript. Code
makes no new describer requests for the history lines; it describes only the candidate's own media before running the
classifier. Output is ONE word: `yes` when the candidate
addresses the persona or continues the exchange with them, `overheard` when people talk ABOUT the persona to someone else or to the room, `no` when the conversation has nothing to do with the persona.
An empty or blank answer is a failed call (`reason: empty`), not a silent `no`.
An explicit @mention of another member is always `no` before the model is asked; the implicit ping Discord adds for the
replied-to author does not count as such a mention. When `mention.followUpClassifyReplies` is on (default `true`,
missing key = on), a reply to another member's message goes to the classifier like plain text. With the switch off,
any reply to another member is an automatic `no`. With `mention.classifyWhileBusy` on (default `true`, missing key = on), a follow-up candidate that arrives while a turn is running is still sent to the classifier through the same window, no-streak and pre-filter checks; at most one classifier call per channel at a time, and a newer held line replaces an older. The candidate is not classified when the switch is off or when its own channel is busy and `mention.pendingSameChannel` is off (the `yes` would be dropped anyway). Each such call is one `classifier.text` request under `llm.maxRequestsPerDay`. A `yes` that meets a busy turn waits in the pending queue (logged `follow-up: deferred`). The queue holds one deferred follow-up per channel; a newer one replaces the older (logged `follow-up: dropped`, reason `newer`). When the attention frees it is picked up (`follow-up: picked up`) through the same checks as a mention (expiry, switches, paused, can send, message still exists) plus two of its own: the follow-up window for that channel and author must still be open (`mention.followUpMinutes` and the no-streak), otherwise dropped `closed`; and the line must not have appeared in the history of a turn that already spoke in that channel, otherwise dropped `answered`. After these checks, the deferred follow-up is counted as a call and rolled against `mention.followUpIgnoreChance`, like a live one. With `mention.pendingOverheard` on (default `true`, missing key = on), an `overheard` that meets a busy turn waits in the pending queue; the reaction runs after the current turn. A waiting follow-up is never pushed out by a later overheard line; a waiting overheard line is pushed out by a later follow-up, a later overheard line, or a direct mention, reply or name call. A waiting overheard line is not counted toward the spam limit and is not reported to other turns as a call waiting in the channel. With the switch off, the overheard is dropped (`busy`).

`yes` goes through an ignore roll first and, unless it is ignored, runs a reply-mode turn with trigger kind `followUp`: its task text is `prompts/follow-up.md` when present (falling back to `reply.md`), so a `yes` does not promise an answer. The follow-up counts as a call by its author, like a mention, and the roll starts from `mention.followUpIgnoreChance` (default `0`) in place of `mention.ignoreChance`; the repeat penalty, the spam threshold and the affinity adjustment apply as for any call. An ignored follow-up is logged as `mention: decided` with reason `ignored:follow-up` (`ignored:repeat` or `ignored:spam` when the author's recent calls count as repeats or spam) and leaves the window and its no-streak as they are. `overheard` runs a reply-mode turn with trigger kind `overheard`: its task text is `prompts/overheard.md` when present (falling back to the mode prompt), no interlocutor mark on the author's profile heading, plain posting, not counted for the repeat penalty, no ignore roll, no limit notice when a rail refuses the turn, no search or re-watch classifier, drawing treated as unasked (no image-cap notice, no per-user image accounting, no `drawFailed` follow-up). With `mention.followUpOverheard` off, an `overheard` answer starts a plain follow-up turn instead (the log still records `answer: 'overheard'`). When a newer message was held during the classifier call and the verdict is `overheard`, the held message is classified first: a `yes` starts the follow-up turn for it, an `overheard` starts the overheard turn for the held message, a `no` starts the overheard turn for the original candidate.

Three `no` in a row (`mention.followUpNoStreak`, default 3) close the window; `overheard` counts as `yes` for the streak. Switch `features.followUp` (default on). Logged as counts, verdicts and `answer` on `follow-up: verdict`.
The window state survives a restart: active windows are saved in `data/state.json` under `followUpWindows` and restored at startup, with expired ones dropped.

## Re-watch classifier

When the persona is directly addressed (a reply turn, not an overheard or spontaneous turn) and a video or picture sits in the last `media.video.rewatch.recentMessages`
(default 60) messages of the channel, a classifier decides whether the message asks about one of those items, asserts a concrete detail about a picture, or asks
to retry a video that did not load. Candidates: watched videos, error-state videos, watched GIFs (an attached GIF or a GIF embed whose cached description came from watching its clip, see `describe-gif.md`), and described pictures (attached pictures, including the persona's own uploads; pasted image links are excluded). Pictures are offered only when `features.vision` is on; watched GIFs only while GIFs are watched (`media.gif.watch`, video vision on). At most `media.video.rewatch.maxCandidates` (default 6) items are
offered to the classifier, videos first, then watched GIFs, then pictures, newest-message first within each group. Code sends `rewatch.md` as the system prompt on the
`classifier.text` model role (default `anthropic/claude-sonnet-4.6`) with a user message
containing three blocks: a short `<transcript>` of the last few channel messages with the persona's own lines marked
with `labels.self` (so the classifier sees what the candidate replies to), then the media list and the candidate:

```
<transcript>
...
</transcript>
<media>
<number> | <kind> | <name> | <status> | <beginning of the caption or account>
...
</media>
<candidate>
<author name>: <trigger text>
</candidate>
```

Each `<media>` line carries five pipe-separated columns: a sequential number (1 = newest item in its kind group), kind (`video` or `picture`), the item name,
a status (`watched` or `not loaded` for videos, `described` for pictures), and the first 200 characters of the summary or caption (empty for not-loaded videos).
A watched GIF is listed as a video: kind `video`, status `watched`, its name (the attached file's name, or the embed's title or site, e.g. `Tenor`) and the beginning of its watched description.
Names and summaries are whitespace-collapsed to one line. The trigger text is cut at `context.maxMessageChars`.
Output is ONE line:

- `<number> | <question>`: the message asks about a watched video or a described picture (including a claimed detail that needs checking) and needs a detail the account does not cover. The number is copied from the list.
- `<number> | retry`: the message is about a not-loaded video and asks to try again or asks about its content. The number is copied from the list. Retry applies to videos only.
- `none`: no second look or retry needed.

On a question hit for a video, the video model watches the clip again with `rewatch-answer.md` (`{{question}}` and `{{maxChars}}`
= `rewatch.answerChars`, default 1200) and the answer is appended to the transcript as `transcript.videoAnswered`
(`{question}`, `{text}`) after the watched tag.

On a question hit for a watched GIF, its clip is fetched again exactly as for the first watch (the first `media.gif.maxSeconds` seconds) and the video model answers with `rewatch-answer.md` the same way; the transcript carries `transcript.videoAnswered` (`{question}`, `{text}`) after the GIF's tag. The answer is cached for one hour apart from the GIF's description. Retry never applies to a GIF.

On a question hit for a picture, the vision model (`classifier.media`, `purpose: relook`, prompt `rewatch-answer.md`, which is kind-neutral) looks at the picture again with that question. The answer is not stored as the caption (cached one hour) and the transcript carries `transcript.imageAnswered` (`{question}`, `{text}`) under the picture's line.

The `<senses>` block includes `senses.videoRewatch` when the feature is on.

On a retry hit, the video model watches the clip with `force` (ignoring the error cache), using the same
`describeVideo` path as a first watch. If the retry succeeds, the video's state changes from error to watched and the
transcript shows the summary as first-hand. A retry counts as a new video attempt against `media.video.maxPerTurn` and
`media.video.maxPerDay`.

Rails: at most one re-watch or retry per turn; the classifier and the second look each count against
`llm.maxRequestsPerDay`; a video's second look also counts against `media.video.maxPerDay`, a GIF's against `media.gif.maxPerDay` (never the video counter);
`media.video.rewatch.maxPerDay` (default 20) caps video re-watches, GIF re-watches and picture relooks (shared counter). Answers are cached for one hour per
question (see the video cache section above). Switch `features.videoRewatch` (missing = on, needs
`videoDescriptions` on). Switch `features.imageRelook` (missing = on, needs `vision` on).

## Search and recall classifier

When the persona is directly addressed (a reply turn, not an overheard or spontaneous turn) and the `lookup.md` prompt exists, the classifier decides whether the trigger needs a web search, a server-history search, or both. Code sends `lookup.md` as the system prompt on the `classifier.text` model with a user message containing a short `<transcript>` (the same as the re-watch classifier, with the persona's own lines marked by `labels.self`) and a `<candidate>` block:

```
<transcript>
...
</transcript>
<candidate>
<author name>: <trigger text>
</candidate>
```

The transcript carries descriptions, video summaries and link reads when available. The trigger text is cut at `context.maxMessageChars`. Output is `none`, or up to four labelled lines in any order:

- `web: <search query>` (plain words, no quotes, no operators, at most 12 words): the message needs facts from outside the chat, or explicitly asks to search the web. This line fires only when `features.webLookup` is on, `web.search.enabled` is not false, `web.search.maxPerTurn` is at least 1, and a `BRAVE_SEARCH_API_KEY` is configured.
- `server: <form>, <form>, ...`: the message asks about something said or done on this server that is not in the transcript. Each form is one word or a short phrase as people would type it, listing inflected forms for the search. Fires only when `features.recall` is on.
- `who: <name form>, <name form>, ...`: the question is about a person not obviously in the transcript. The forms help find them by nickname, username or tag.
- `when: <from> .. <to>`: the question points at a time (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM` on each side of `..`; one date alone means that whole day).

A single unlabelled line (the old format) is still read as a web query. An empty or blank answer is a failed call (`reason: empty`), not a silent `none`.

On a `web:` hit, Brave Search runs the query (`web.search.results` results, default 5), the numbered results are condensed by `classifier.text` through `search-summary.md` (`{{today}}`, `{{query}}`, `{{maxChars}}` = `web.search.summaryChars`, default 900), and the web part is rendered in the `<lookup>` block: `labels.lookup.header` with the query, the condensed text, and `labels.lookup.sources` with the distinct site names. When the search returned nothing or the condenser found nothing useful, `labels.lookup.none` appears instead.

On a `server:` hit (with optional `who:` and `when:` lines), the engine searches the server's message history through Discord's search API. The forms become an ordered list of search queries (content forms round-robin, then author names), or date-range samples when only `when:` is given. Hits are filtered (other bots and channels the audience rule refuses are excluded), grouped into clusters by channel and time (`recall.clusterGapMinutes`), ranked by topic score (each distinct `server:` form with hits in the cluster adds 2 when its total server hits are at most `recall.rareHits`, 1 otherwise), then by all distinct queries, then newest first, and the top `recall.maxClusters` are kept. A cluster with only name or author hits ranks below any cluster with a topic hit. `recall.keepOldest` reserves slots for the oldest with a topic score of at least 2. A window of `recall.windowMessages` messages is fetched around each kept cluster. The classifier's word forms and name forms are also matched against stored memory (never the private layer): members' episodes, lore entries, taught lessons and recent lines. Each matching item becomes one line in a `<memory>` block: `kind | date | name | text`, with kinds `episode`, `lore`, `learned`, `recent`. A `when:` date range drops undated kinds (lore, learned). At most `recall.memoryItems` (default 6) items, ranked by the number of forms they match and by weight. The `<memory>` block sits after `<people>` and before `<found>`; its items cannot be named as a `stretch`. A run with memory matches and no chat hits still asks the summary. Logged as `stats.memory` on the `recall: searched` line.

The summary helper (`recall-summary.md` on `classifier.text`, blocks `<people>`, `<memory>`, `<found>`, `<question>`) reads the windows, the stored memory and the question, and writes a note. The summary may name one stretch that best answers the question (`stretch: <n>`); if it does, the verbatim lines of that stretch (capped at `recall.stretchChars`) appear alongside the note. When the summary says `nothing`, the `<lookup>` block carries no server part. A summary that fails or runs out of time falls back to the verbatim stretch of the top-ranked window with no note.

When both web and server searches ran, the `<lookup>` block carries `labels.lookup.webHeader` above the web part, `labels.lookup.serverHeader` above the server part, and `labels.lookup.bothNote` between them.

The `<lookup>` block follows the same audience rule as `<other_channels>` (`context.pull.sameAudience`): a server-search window is refused when the channel it came from is not readable by everyone who can read the destination.

Rails: at most one web search and one server search per turn. The classifier, the web condenser and the recall summary each count against `llm.maxRequestsPerDay`; the web search counts against `web.maxPerDay` (shared with link reads); the recall run counts against `recall.maxPerDay` (stored in `state.json` as `recallDay` / `recallCount`). Web results are cached for `web.search.cacheHours` (default 24) hours per normalised query. The classifier fires when either `features.webLookup` or `features.recall` is on. Switches: `features.webLookup` (missing = off), `features.recall` (missing = on).

## Task splitter

A direct call (mention, reply, name, follow-up, private message) that is long and structured enough (`split.minChars` characters with links and Discord tokens excluded, at least two runs of separators) is given to a classifier (`prompts/split.md` on `classifier.text`, purpose `split`) alongside the turn's preparation. The classifier reads a short `<transcript>` of the last `split.contextMessages` messages with the persona's own lines marked by `labels.self`, then the new message as `<candidate>` (`<author name>: <text>`). Its answer is the word `one`, or 2 to `split.maxTasks` (default 4) lines each starting with `- ` and holding one part in the author's own words. After parsing, a part shorter than `split.minPartChars` (default 20) characters (links and Discord tokens excluded, like `minChars`) is folded into the next part (the last into the previous); when fewer than two parts remain the message is one request (`folded`). An empty, unparsable or late answer (the turn's preparation finished first) is treated as one request and logged `split: failed`. Switch `features.splitTasks` (missing = on).

Parts become a chain of ordinary turns on the same message (`turn: part`). Each part's helpers (the search classifier, recall, the route hook, the re-watch) judge that part's text, and the request names the part and the others (`labels.task.part` with `{index}`, `{total}`, `{part}`, `{others}`). The first part reuses the history the whole message's turn fetched and replies to the message; the later ones fetch history afresh and post plain. Each part has its own deadline and drop bar; a part that fails or is refused does not stop the next. The ignore roll, the private daily cap and the ring stamp count once per message. A pause or a warmup ends the chain before its next part (`turn: chain stopped`). While the chain runs, its unstarted parts are the author's waiting items (`waitingParts` on the turn runner); a later message of the author folded into one of them (`addToPart`) reaches that part's request as `tasks.added`. The attention stays with the chain from the first turn to the end; idle notifications fire once, at the end.

Without `prompts/split.md` the splitter is off (`split: skipped`, `no-prompt`). Without `labels.task.part` the splitter is also off: a parsed answer is discarded. Settings: `split.minChars` (default 80), `split.minPartChars` (default 20), `split.maxTasks` (default 4), `split.contextMessages` (default 6), `split.maxOutputTokens` (default 300).

## Merge classifier

When a call arrives from an author who already has items waiting in that channel (parts of a split message the chain has not reached, or queued calls in the pending list), a classifier (`prompts/merge.md` on `classifier.text`, purpose `merge`) decides whether the new message belongs to one of them. The classifier reads a `<waiting>` block of numbered items (`1. <text>`, one per waiting item) and the new message as `<candidate>` (`<author name>: <text>`). Its answer is one line: a number from the waiting list or the word `new`. A folded message never gets a turn of its own; it appears in the turn of its item through `labels.task.added` (`{added}`). Routed calls are never folded into. Without the prompt file, every call is queued as its own item (`merge: failed`, `no-prompt`). Logged as `merge: verdict` or `merge: failed`. No config settings of its own; the output cap is `mention.followUpMaxOutputTokens`.

## Participation episodes

The persona's own exchanges on other channels, kept so a turn in one channel can recall what it said in another hours ago (`src/memory/participation.js`, `data/guilds/<id>/participation.json`). Switch `features.participation` (missing = on); `features.memory` off turns it off too.

Recording. Code records, no model decides. Every text message the persona sends for real in a server channel (follow-up parts and answers to routed calls included; not a private chat, not the diary channel, not a dry run) is saved with the last `participation.linesBefore` lines of the turn's history before it and the message it replied to when that one is older (the reply parents the turn already fetched; nothing is fetched for it). A message joins the channel's last episode when that episode's last line is at most `participation.mergeGapMinutes` old, else it starts a new one; past `participation.maxMessages` an episode continues in a new one. A line by another member within `participation.followMinutes` after the persona's newest line is added, up to `participation.linesAfter` lines (nothing is fetched and no profile read for it). Texts are cut to `participation.maxTextChars`. An episode lives `participation.hours` after the persona's newest line in it; `participation.maxStored` caps the file. A forget removes the member's lines; an episode left without a line of the persona goes.

The classifier. On a server turn that builds a reply request (a reply of any trigger kind, an interject, an initiate, a noticed comment; never a diary post or the second turn after a failed picture), when at least one episode is on offer, `prompts/participation-pick.md` runs on `classifier.text` (purpose `participation-pick`, output cap `participation.maxOutputTokens`, the helper timeout and hedge) beside the turn's preparation, under its deadline. System: the prompt with `{{name}}`. User: `<transcript>` (the last `participation.contextMessages` lines before the message, the persona's lines marked with `labels.self`), `<candidate>` (`<author>: <text>`), `<episodes>` with one line per episode, newest first: `n | #channel | when | <member name>: <first line of another member> | <persona name>: <first line of the persona>` (`when` is a duration in `labels.units`; the member part is empty when the episode has none; a line is cut to 120 characters). The answer is one line: numbers from the list, comma- or space-separated, or `none`. Unknown numbers are dropped; `none`, an empty answer or anything that is not a list of numbers picks nothing. Without the prompt file, late, or failed: nothing is picked.

Selection, cutting, dedup. The request shows at most `participation.shown` episodes, `participation.perChannel` per channel: the picked ones in the classifier's order, then the newest. Only channels that pass the audience rule of `<other_channels>` and `<channel_view>` are offered (`context.pull.sameAudience`: everyone who can read the current channel can read that one); never the current channel. A line already shown in `<chat>`, `<other_channels>` or `<channel_view>` is left out; an episode left without a line of the persona is dropped. An episode longer than `participation.episodeChars` characters keeps, in order, the persona's lines with the lines they answer, the lines that share a word of 4+ letters with the new message (and one neighbour on each side), the first and last two lines, then the rest while it fits; a run of cut lines is marked with `labels.participation.skipped`. The budget section `participation` drops whole episodes, the picked ones last. The block sits right after `<recent>`.

Logs (counts and codes only): `participation: recorded` (`channel`, `episodes`; `following: true` for a line after the persona's), `participation: classified` (`channel`, `kind`, `offered`, `picked`, `parse`, `ms`), `participation: skipped` (`no-prompt`, `no-candidate`), `participation: failed` (`reason`: a rail code, `error`, `record-error`, `following-error`). The reply's `turn: model answered` carries `budget.participation` (`used`, `kept`, `dropped`, `offered`, `shown`, `cut`, `deduped`).

## Drawing

The persona can produce pictures through a drawing sub-process (`features.imageGeneration`, on by default). When the
model emits a `<draw>` tag, `src/behavior/turn.js` assembles the image prompt from `draw.md` and generates one picture
through OpenRouter's Images API (`src/llm/images.js`). The picture is posted as its own message after the persona's
text messages, never inlined.

### Prompt assembly

`buildDrawPrompt` (`src/behavior/prompt.js`) fills `draw.md` with four placeholders:

- `{{name}}` — the bot's display name.
- `{{appearance}}` — `appearance.md` with `{{name}}` filled, included only when `self="yes"`. Empty otherwise.
- `{{request}}` — the scene text from the `<draw>` tag, clamped to `image.maxPromptChars` (default 800).
- `{{when}}` — the local date and time through `labels.draw.when`, so the image model draws the right light and season. Empty when the time is unknown.

The drawing sub-process never receives the character card, `rules.md` or the system prompt. It follows its own style
section inside `draw.md`.

### Reference

When the persona is in the picture (`self="yes"`) and `image.reference` is `'avatar'` (the default), the bot's
Discord avatar is downloaded and sent as an `input_references` entry so the image model can see what the persona looks
like. If the avatar cannot be fetched, the generation proceeds without a reference.

### Senses

The `<senses>` block includes one drawing line when an image client is wired and `features.imageGeneration` is not
false:

- `senses.draw` — the persona can draw.
- `senses.drawSpent` — the daily quota (`image.maxPerDay`) is spent.
- `senses.drawSpentUser` — this member's daily quota (`image.maxPerUserPerDay`) is spent.

An older `labels.json` without `senses.draw` shows nothing.

### Failure turn

When a generation fails on a turn someone asked for (a mention, reply, name trigger or follow-up, not an overheard or spontaneous turn), a second turn fires automatically:

- `triggerKind: 'drawFailed'`, with the failure reason rendered through `labels.draw.reasons.*` into
  `labels.triggers.drawFailed`'s `{reason}` placeholder.
- Mode is `reply`, same trigger message, replies allowed.
- The second turn's own `<draw>` is dropped, so the model cannot retry the generation.
- The channel's idle notification is held until the second turn finishes, so a pending ping is drained only after
  the follow-up.

On a spontaneous or overheard turn (nobody asked), a failed generation is only logged and no follow-up runs.

An image cap (`ImageCapError`, reason `daily` or `userDaily`) does NOT fire the failure turn. Instead, the turn posts a
limit notice (`labels.limits.notice`) as a plain reply. The senses line already told the persona the quota was spent;
the notice tells the requester which limit and the numbers. `draw.reasons.daily` and `draw.reasons.userDaily` are
reserved in `labels.json` but no longer reached by `triggers.drawFailed`.

### Rails

- One `<draw>` per turn; first non-empty wins, clamped to `image.maxPromptChars` (default 800).
- `image.maxPerDay` (default 50) and `image.maxPerUserPerDay` (default 50) are checked and counted before the
  request; a cap error throws `ImageCapError` with reason `daily` or `userDaily`.
- An unsupported model family (not `openai/*` or `google/*`) is refused with `UnsupportedImageModelError`.
- Generation failures throw `ImageGenError` with reason `moderation`, `timeout`, `error` or `empty`.
- Transient HTTP errors (408, 429, 5xx) and network failures are retried up to `image.retries` (default 1).
- Moderation refusals (HTTP 400/403 with a moderation marker) are not retried.
- Logs carry the model, counts, cost and failure reasons — never the prompt, because it may quote members.
- In dry-run, the full image prompt (prompt files + the persona's request) is logged and mirrored, but nothing is
  generated.

## Diary

`features.diary` (on by default, but no `diary.channelId` means nothing runs). The persona posts in one owner-chosen
channel on its own, at times drawn from configurable windows in `bot.timezone`. Each post is two model requests: a
plan step and a compose step. A third request is added when the plan asks for a web search.

### The two requests

**Plan** (`prompts/diary-plan.md` on `classifier.text`, usage purpose `diary-plan`, `diary.planMaxOutputTokens` 300,
`diary.planTimeoutMs` 20000). No character card. User message blocks: `<now>`, `<server>`, `<about_chat>`, `<recent>`,
`<lore>`, `<world>` (under `diary.world`), `<diary>`, `<kinds>`, `<seeds>`, and `<topic>` when the owner gave one
with `/nep diary post`. The answer is one JSON object:

```
{"kind": "<key>", "brief": "<one line>", "search": "<query or empty>", "picture": true|false}
```

`kind` must be a key of `diary.kinds` with a positive weight (a picture kind counts only when the post can carry a picture). `search` is kept only for a kind in `diary.searchKinds`.
`picture` is true only when the answer says `true` and the picture caps allow it.

**Validation and fallback.** `validatePlan` (in `src/behavior/diary.js`) normalises the answer. When the kind is missing,
unknown or has weight 0, the whole answer is replaced by a weighted random kind with an empty brief and search
(`fallback: true`). `brief` is clamped to 300 characters. When the kind is in `diary.pictureKinds`, `picture` is forced true if the day's picture caps allow it, whatever the planner answered. For other kinds, `picture` is kept as the planner set it. `picture` is forced false when
`diary.maxPicturesPerDay` or `image.maxPerDay` is spent. When the post cannot carry a picture (those caps spent, drawing off, no image model, or no Attach Files), the picture kinds are dropped before the plan request, so the random fallback cannot pick one. A forced picture kind is refused before any request (`reason: 'pictures'`).

**Search.** When the plan names a search query and `lookup.search` is available, the query runs through the existing
Brave path (cached, `web.maxPerDay`). The result text becomes a `<found>` block in the compose request. A failed or
capped search turns the post into the same kind without the find.

**Compose** (`prompts/diary.md` as the task, the main model with the character card and all memory blocks). The compose request receives `<world>` (under `diary.world`), `<diary>`, `<plan>`, and `<found>`
(when the search produced one). The `<diary>` block is fitted by `fitSections`: the oldest lines are cut first, then
the whole block. `<plan>` and `<kinds>` are never cut.

### Output rules

Only `<msg>` tags are acted on. Reply attributes are dropped. URLs in the message text are removed mechanically. At most `diary.maxMessages` (3) messages; excess messages are trimmed. `<react>` and `<gif>` are dropped in this mode. `<skip/>` means no post. A post may be a picture alone.

A failed drawing on a diary post is logged; no `drawFailed` follow-up turn fires (nobody asked for the post).

### The drawing prompt and `{{when}}`

Every drawing request (diary or not) now carries a local time: `draw.md`'s `{{when}}` placeholder is filled with
`labels.draw.when` when the time is known, or left empty. The image model uses it to match the light and the season.

### Recording

After posting, the post is recorded in `diary.json` (`store.appendDiaryPost`, newest `diary.historyPosts` kept): `{ at, kind, gist, picture, messageIds, search }`. `gist` is the post's text collapsed to one line and cut at `diary.gistChars`. `picture` is the scene text (cut the same way) or null. The day's diary post count is bumped; the picture count is bumped only when a picture was posted.

In dry-run the post is logged and mirrored. Nothing is recorded and no daily counter is bumped.

### Data file

`data/guilds/<id>/diary.json`: `{ posts: [...], updatedAt }`. Posts are newest last, capped at `diary.historyPosts` (150). Each post: `{ at, kind, gist, picture, messageIds, search }`. The file is never deleted by code; `/nep diary off` keeps it.

### Backfill

When `diary.json` has no posts, the first tick with a channel and `/nep diary set` both read up to `diary.historyPosts` of the persona's own messages from the channel (REST, oldest first) and store them with `kind: null`, a one-line gist, and `labels.diary.pictureUnknown` as the scene of a message that carried a picture.

### The diary in the server map

The persona's own messages in the diary channel count toward the channel's `days` and `writers` (one exception to the rule that the persona's lines are not counted). `renderChannel` marks the channel with `labels.server.diary`.

### Logs

`diary: plan` (day, slots count, quiet, carried, hunger, quietStreak), `diary: planned` (kind, brief, search, picture, fallback, pictureAllowed),
`diary: due` (slot), `diary: post` (kind, messages, picture, search, outcome, forced),
`diary: skip` (reason: `no-channel`, `off`, `paused`, `warmup`, `not-writable`, `cap`, `grace`, `busy`),
`diary: backfill` (count), `diary: plan failed` (reason, status), `diary: search failed` (reason),
`diary: backfill failed` (error).

## Private chat

`features.privateMessages` (off by default) lets members of the served guild talk to the persona in Discord direct
messages. The persona is the same character with the same public memory; what is said in a DM stays in a per-member
private layer that no other conversation ever sees.

### Gate

A DM is answered when ALL of the following hold, checked locally with zero tokens:

1. `features.privateMessages` is `true`.
2. The author is a member of the served guild.
3. The persona has a stored public profile for the author.
4. The author's public `affinity.score >= private.minAffinity` (default 5). Bot owners bypass this check.
5. Today's reply count for this person is under the cap (`private.maxPerOwnerPerDay` for owners,
   `private.maxPerUserPerDay` otherwise).

Anything that fails is dropped silently, except step 5: when the daily cap is reached, the bot posts a limit notice
(`labels.limits.notice` with the config key) once per person per day.

### What a DM turn contains and omits

- The `<server>` block (channel map) and `<other_channels>` are omitted.
- When `features.privateLikeServer` is on (default `true`, missing key = on), the channel route classifier, channel pull and server search (recall) run in a DM. A pulled channel enters the DM only when the DM partner has View Channel permission on it (`context.pull.sameAudience` does not relax this). The recall search applies the same partner rule per channel. Members named in the DM show their episodes (`context.askedAboutEpisodes`). Nothing a DM pulls is marked seen or answered on the server. With the switch off, no route, no pull, no recall, no asked-about episodes.
- `prompts.private` (when present) is appended after the mode prompt (`reply.md`), before `forced.md`, with
  `{{name}}` and `{{author}}` filled.
- `{{trigger}}` comes from `labels.triggers.private`.
- `<senses>` carries `senses.privateChat`.
- On a server turn, when `features.privateMessages` is on, `<senses>` carries `senses.privateAware` instead (the
  rule about never repeating anything from private).
- The interlocutor's profile is `mergeProfiles(publicProfile, privateProfile)` from `src/behavior/private.js`.
  Other profiles (`askedAbout`, participants) stay public-only.
- No ignore chance, no follow-up window, no eavesdrop, no address classifier.
- One attention applies: a DM that arrives while the persona is busy elsewhere is held as a pending ping.

### The private layer

`data/guilds/<guildId>/private/<userId>.json` stores what the persona learned from one member in DMs. It holds its own
`relationship`, `interests`, `details`, `episodes` and `affinity` (score starting at 0). It is never shown to any
other conversation, never written by a server batch, and never mixed into the public profile on disk.

In a DM, the persona sees the public and private data merged (a view, never stored): interests are unioned by topic
(the private note wins on a shared topic), details are concatenated, episodes are sorted by date, `relationship` is
the public text followed by the private text as a second paragraph.

### Affinity in a DM

The public score changes only from server batches. The private layer has its own score starting at 0, changed only by
DM batches. In the DM the persona feels `clamp(public + private, -100, 100)`; on the server only the public score.
The gate uses the public score alone.

### Analyzer in private mode

`analyzePrivate` builds a `memory.md` request with the same format and a `<private>` block
(`labels.memory.privateNote`). `<existing_profiles>` contains ONLY the partner, rendered as the private profile
(private details with ids, private interests, private episodes, the effective affinity view). `<public_profile>`
shows the partner's public profile (read-only, via `renderProfile`). `<existing_guild>`, `<existing_lore>` appear as
usual (read-only context). `<new_messages>` is headed by `labels.memory.privateChannel`.

From the answer, only `users[<partnerId>]` is applied through the private store methods. `portrait` and `aliases`
are ignored. `guild`, `channels`, `lore`, `self` and any other user ids are dropped and logged as counts.

## Mentor

A manual sub-process (`features.mentor`) with its own model (`mentor.model`). The owner adds a case (a behaviour he wants from the persona), and the mentor invents chat situations, runs the persona through them in a sandbox, and scores the answers. When a run fails or scores poorly, the mentor names likely causes in the persona's context and proposes changes as advice for the owner to review. One run at a time. All work stays in `data/`; when `bot.dryRunChannelId` is set, a finished run is posted there as well. Without an admin channel the owner follows a run with `/nep mentor status` and reads the report with `/nep mentor show <id>`.

### Privacy

The mentor model reads the rendered sandbox request, so it reads what the persona remembers about real people. Direct messages and the private memory layer are never part of a sandbox request.

The sandbox carries the same custom-emoji and GIF blocks as a live turn, so the persona can react with emoji, post a GIF or draw a picture in their sandbox answers. A GIF or drawing counts as an action the same way `<msg>` does. The sandbox also carries the `<senses>` lines for the elsewhere destination and the search sense, so the persona's awareness of those features is tested.

### Post ledger

`state.json` `postLedger` records each message the persona posts in a server channel: the message id, channel, mode, trigger kind, trigger id, the newest history line id and the source channel id. It is written only while `features.mentor` is on (or the mentor's anchor-related path is used). The ledger is capped at `mentor.anchor.ledgerSize` (default 300) entries; the mentor uses it to find which turn a posted message belonged to when resolving a real moment. Requests from the mentor itself carry `origin: mentor` in the usage log.

### How a run ends

A run ends normally with a verdict and a report. It can also end early:

- **Stopped** (`budget`): the daily token budget is exhausted. The switches and the budget are checked before every situation and before every mentor request.
- **Stopped** (`owner`): the owner ran `/nep mentor stop` or `/nep pause`.
- **Stopped** (`disabled`): `features.mentor` or `mentor.model` was turned off during the run.
- **Error** (`the reference is empty`): no message of people could be read from the reference channels in the reference window. This ends the run before any model request.

A stopped run keeps the scores it already has and reports them.

### Real moments (anchors)

A case may carry real moments from the chat. Each moment is one message of the persona that the owner rejected. Resolving: the bot fetches the message, finds the trigger (the message it replies to, or the last message before it that is not the persona's), collects up to `mentor.anchor.contextMessages` (default 30) messages of that channel ending at the trigger, and stores the persona's whole burst (consecutive messages starting at the linked one) as the original answer. The stored history is normalized the same way the regular transcript is (media labels, reactions) but nothing is downloaded or described. Resolving stores what the persona saw of the media: for each message, the describer's captions (pictures, gifs, video frames, link thumbnails, stickers, custom emoji) and watched video summaries from `media.json` entries written no later than the persona's message become `mediaSeen: { captions?: { <itemId>: text }, watched?: { <itemId>: text } }`. Not-watched states (limit or error), second-look answers (`videoAnswered`), web lookup reads (`linkRead`) and attached-picture markers are not kept. Names and reactions stay as they were at fetch time. Once stored, a moment is replayed from its stored messages even after the channel moves on or a message is deleted.

A case stores its moments as `anchors`:

```json
[{ "id": 1, "channelId": "...", "messageId": "...", "triggerId": "...",
   "addedAt": "...",
   "history": [
     { "...normalized message fields...",
       "mediaSeen": { "captions": { "<itemId>": "text" }, "watched": { "<itemId>": "text" } } }
   ],
   "original": ["text", "..."] }]
```

In a run, each usable anchor becomes a situation of its own, numbered before the invented ones. The situation record carries `anchor: <id>` (absent on invented situations). The replay uses the stored history at the time of the persona's original message, in the anchor's own channel.

At replay, stored `mediaSeen` renders with the live transcript labels (`imageDescribed`, `gifDescribed`, `videoDescribed`, `videoWatched`, `thumbnailDescribed`, `linkWatched`, `stickerDescribed`, `emojiDescribed`) in the persona's request, in `<examples>`, in the score `<situation>` and in `<worst>`. For an item with nothing stored, the cache is read at replay time with the same time bound (the persona's answer). If the cache has nothing either, the item renders with its plain label.

When `mentor.anchor.hideLaterMemory` is not `false` (the default is `true`), a replayed moment is answered with the memory as it stood before its trigger. Items dated at or after the trigger's timestamp are hidden: episodes (by `addedAt`, falling back to `date` by UTC day), affinity history entries and the affinity reason (the score stays at its current value), details (by `firstSeen`), interests (by `firstSeen`), aliases (by `firstSeen`), learned items (by `firstSeen`) and lore entries (by `createdAt`). Items with no parseable date pass through. Undated fields (profile prose, guild patterns, starters, in-jokes, self-facts, channel entries) stay visible with their current values. The judge's `<learned>` block for a real moment is filtered the same way. Setting the switch to `false` replays the moment with all of today's memory.

In the situations request, the case's anchors are shown to the mentor model as `<examples>` (the last block). Each `<example>` holds a `<situation>` with the stored transcript and an `<original>` with the persona's messages. The oldest messages of each example may be trimmed so the block fits the request budget; the trigger is never dropped. The mentor invents situations of the same kind: matching message lengths, turn count and pressure.

In the score request for a real moment, `<original>` appears between `<situation>` and `<answers>`, carrying the persona's rejected answer as a known-bad reference.

The validator's cap on a single line of an invented situation is 2000 characters (not the former 500), so the mentor can match the length of messages in the examples.

### Prompts

The mentor uses four prompt files: a situations/score pair, the signs file and the diagnosis file:

- `mentor-situations.md` (invent situations) and `mentor-score.md` (score answers).
- `mentor-diagnose.md` (explain weak answers after scoring).

Each prompt file is the system message of one mentor request. The blocks arrive in the user message.

Placeholders filled by code: `{{name}}` in all four; `{{count}}`, `{{minLines}}`, `{{maxLines}}` in the situations prompt.

### Blocks

| Block | Content | In which request |
|---|---|---|
| `<case>` | The owner's case text, verbatim | all |
| `<members>` | One line per stored profile: `name (id:123)` | situations |
| `<reference>` | Style profile as JSON: punctuation rates, lengths, reply frequency, characters never used | situations, score |
| `<samples>` | Random lines from the chat, one per line | situations, score |
| `<signs>` | `mentor-signs.md` with `{{name}}` filled: known habits of model-written text. Omitted when the file is missing or empty | all |
| `<intended>` | `labels.mentor.intended`, one line per item | score |
| `<feedback>` | JSON array of the owner's corrections: `[{ "case": "...", "reason": "..." }]`, newest first; omitted when empty | all |
| `<examples>` | Real moments from the chat: `labels.mentor.examples` as the first line, then one `<example>` per moment. Each `<example>` holds a `<situation>` (the stored transcript, oldest messages trimmed to the request budget) and an `<original>` (the persona's messages). Omitted when the case has no moments | situations |
| `<original>` | The persona's answer at the time (in a score request for a real moment). `labels.mentor.original` as the first line, then the persona's messages. A known-bad reference, never an answer to score. Omitted for invented situations | score (real moments only) |
| `<character>` | The character card with `{{name}}` filled | score |
| `<rules>` | The rules prompt | score |
| `<learned>` | Instruction-like learned items as the persona sees them. For a real moment with `mentor.anchor.hideLaterMemory` on, items written at or after the trigger are hidden | score |
| `<situation>` | The situation rendered as a chat transcript, the way the persona saw it. For a real moment, the oldest messages may be trimmed to fit the request budget; the trigger is never dropped | score |
| `<answers>` | JSON array: `[{ "id": "s1a1", "messages": ["..."], "reactions": ["..."], "silent": false }]` | score |
| `<facts>` | JSON object keyed by answer id with deterministic measurements (unused marks, rare marks, comma count, comma density, length), plus `"repeated"` with phrases found in two or more different situations. Per answer: `commas` is a count; `commaPer1000` is a number only when the measured text has at least 150 characters, `null` for a shorter one (too short to measure; the mentor judges the count, never infers a density). `repeated` lists phrases that recurred across different situations, and `count` is the number of situations | score |
| `<verdict>` | JSON: `{ passed, medians, situations, reasons }` with the pass/fail result, medians of each axis, per-situation medians and the reasons the case was brought to diagnosis. Reasons include `situation <n>: <axis> <v> is under the floor <f>` for invented situations and `real moment <n>: <axis> <v> is under the pass score <s>` or `real moment <n>: <axis> <v> is under the anchor score <s>` for real moments | diagnosis |
| `<worst>` | JSON: the situation with the lowest median `overall` of any kind (ties: the lower median `goal`, then a real moment before an invented situation, then the lower `n`): `{ n, title, transcript, answers }` where each answer carries its id, messages/reactions/silent, `facts` and `score`. The transcript may be trimmed to the request budget | diagnosis |
| `<seen>` | The full request the persona was given for that situation, as two sub-blocks: `<system>` (the system prompt with the character card, rules and format) and `<user>` (the transcript, memory blocks and task) | diagnosis |

### Answer ids

`s<situation>a<sample>`, both counting from 1. Example: `s2a3` is the third sample of the second situation.

### Situations schema

```json
{
  "situations": [
    {
      "title": "short label",
      "lines": [
        {
          "authorId": "123456789 or self",
          "authorName": "display name",
          "text": "the message",
          "replyTo": null,
          "minutesBefore": 5
        }
      ]
    }
  ]
}
```

`authorId` is a member id from `<members>` or `self` for the persona's own earlier line. `replyTo` is a 0-based index into the same situation's `lines` array, or `null`. The last line is never by `self` and addresses the persona.

A situation record from a real moment has `anchor: <id>` instead of `lines`. Its transcript is rendered from the stored history; its record also carries `original` (the persona's messages) and `at` (the time the persona answered).

### Scores schema

```json
{
  "answers": [
    {
      "id": "s1a1",
      "human": 7,
      "character": 8,
      "rules": 9,
      "goal": 6,
      "overall": 7,
      "comment": "One or two sentences."
    }
  ]
}
```

Each score is an integer 0–10 or `null`. `overall` and `goal` are always numbers.

### Axes

All integers 0–10, 10 ideal, `null` when there is nothing to judge (never 5 as a stand-in for unknown).

| Axis | What it measures | 0 | 5 | 10 |
|---|---|---|---|---|
| `human` | How little it reads as AI | Far from how the people of this chat write | Could be either | Matches how people in the reference write |
| `character` | Fit to the character card | Completely out of character | Recognizable with slips | Exactly the card's voice |
| `rules` | Compliance with rules and learned items | Breaks every applicable rule | Follows some, breaks others | Follows every applicable rule |
| `goal` | Does what `<case>` asks | Does the opposite | Partly achieves, partly misses | Handles the behaviour exactly |
| `overall` | The mentor's verdict | Fails across the board | Acceptable with clear weaknesses | Excellent on every front |

### Pass rule

A case passes when the median of `overall` >= `mentor.pass.score` (default 7) AND the median of `goal` >= `mentor.pass.score` AND no axis has a median below `mentor.pass.floor` (default 5). Invented situations are held to the floor: the case fails when the median `overall` or the median `goal` of any one invented situation is under `mentor.pass.floor`, whatever the medians over all answers. A real moment is held to the pass score instead: the case fails when its median `overall` or `goal` is under `mentor.pass.anchorScore` (when set to a number) or under `mentor.pass.score` (when `anchorScore` is `null`). The reason string is `real moment <n>: <axis> <v> is under the pass score <s>` when `anchorScore` is not set, or `real moment <n>: <axis> <v> is under the anchor score <s>` when it is. The report shows the median `overall` and `goal` of every situation. An axis where every score is `null` has median `null` and is not checked.

### Evidence order for scoring

1. The owner's corrections in `<feedback>`, which overrule the mentor's taste.
2. The measured reference (`<reference>`, `<samples>`) and the deterministic facts (`<facts>`).
3. The known signs of model writing (`<signs>`). A sign never outranks a measurement or the reference.
4. The mentor's own taste, which proposes but never overrules the first three.

### Sources

The list of known signs in `mentor-signs.md` was informed by Wikipedia's "Signs of AI writing" and the humanizer skill (MIT).

### Diagnosis

After scoring, when the run did not end early and the case failed or any situation's median `overall` is under `mentor.pass.score`, the mentor makes one more request to explain what in the persona's context caused the weak answers. Switch `mentor.diagnose` (default `true`). A run started with `/nep mentor check` never asks for a diagnosis. A failure of this step never fails the run: the run is saved with `diagnosis: null` and the error noted.

The result is stored on the run as `diagnosis` and printed in the report. These are hypotheses for the owner to review; the mentor does not edit anything.

Layers a cause may name: `rules` (a rule in the rules block), `prompt` (the engine's system prompt, format or task), `card` (the character card), `self` (a note the persona keeps about themselves), `learned` (something people taught the persona), `guild` (a server habit or in-joke), `profile` (what the persona remembers about a person), `labels` (a string from `labels.json`), `lore` (a lorebook entry), `channel` (a channel note), `recent` (a line in the `<recent>` block), `missing` (an instruction that should be there is absent).

#### Diagnosis schema

```json
{
  "summary": "one paragraph",
  "causes": [
    {
      "layer": "rules|prompt|card|self|learned|guild|profile|missing",
      "excerpt": "verbatim from <seen>, at most 300 chars; empty for missing",
      "why": "one or two sentences"
    }
  ],
  "changes": [
    {
      "layer": "rules|prompt|card|self|learned|guild|profile",
      "target": "which file, rule or item",
      "from": "verbatim text to replace; empty for an addition",
      "to": "the new text",
      "why": "one sentence"
    }
  ]
}
```

At most 5 causes and 5 changes. `summary` clipped to 1500 characters; `excerpt` to 300; `from`/`to` to 1000; `target` to 200; `why` to 500. An item with an unknown `layer` or without `why` is dropped. `summary` and `why` are in the language of the chat; `to` is in the language of the layer it targets.

## Limit notices

When a rail refuses a directly requested action (a mention, reply, name trigger, follow-up or private message, not an overheard or spontaneous turn), the
bot posts one plain line from `labels.limits.notice` with `{limit}` (the config key), `{used}` and `{cap}` filled.
Spontaneous turns that hit a rail stay silent. In dry-run the notice is logged and mirrored, not sent.

The config keys that can appear as `{limit}`: `llm.maxRequestsPerDay`, `llm.maxRequestTokens`, `image.maxPerDay`,
`image.maxPerUserPerDay`, `private.maxPerUserPerDay`, `private.maxPerOwnerPerDay`.

Private DM caps post the notice once per person per day (tracked by `replies.noticedDay` in the private file).
Image caps post the notice instead of the `drawFailed` follow-up turn (the senses line already told the persona;
the notice is the technical marker for the requester). Video and web daily caps do not block a reply and keep their
in-transcript states; no notice.
