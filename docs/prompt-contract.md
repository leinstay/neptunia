# Prompt contract

Where the prompt files and the code (`src/behavior/prompt.js`, `src/llm/parse.js`, `src/format.js`,
`src/memory/channels.js`) meet. Change one side only with the
other. See `CONTRIBUTING.md` for the workflow around changes.

## Layers

| Directory | Tracked | Content |
|---|---|---|
| `prompts/` | yes | English engine defaults + a neutral example character. Works out of the box |
| `prompts.local/` | no | A deployment's overrides: a file replaces the default of the same name; `labels.json` is deep-merged. The tool texts have their own local folder, `config.local/` (see `tools.json` below) |

Both hot-reloaded. `/nep rule add` writes to `prompts.local/rules.md` (seeded from the default), never to `prompts/`.
All instructions are English in both layers; a character's speech samples may be in the language it speaks.

## Files

| File | Required | Role | Placeholders |
|---|---|---|---|
| `system-prompt.md` | yes | Character-agnostic rules for acting like a chat member: length, anti-AI rules, use of context, attitude toward people, boundaries. Says the card wins on voice | `{{name}}` |
| `character-card.md` | yes | The personality: who, character, voice and language, meta layer, **what earns and loses their good opinion** (read by the analyzer), reference lines. The one file a deployer rewrites | `{{name}}` |
| `rules.md` | no | Owner's live corrections, override the two above. **Must end with the bullet list under its last `## ` heading.** Code appends `- …` lines | `{{name}}` |
| `format.md` | yes | The output protocol | `{{drawChars}}` (live `image.maxPromptChars`) |
| `reply.md` | yes | Task: somebody called the persona | `{{name}}` `{{author}}` `{{trigger}}` `{{target}}` |
| `follow-up.md` | no | Task: a line that carries on an exchange with the persona. The persona first decides whether another outward line is warranted (silence by default when the line asks nothing) and assesses any call separately; `<skip/>` only when neither is warranted. Replaces `reply.md` as the task text when the trigger kind is `followUp` (the address classifier's `yes`) or `reply` without an explicit @mention of the persona (Discord's reply ping does not count). A mention, a tagged reply and a name call keep `reply.md`. A missing or blank file falls back to `reply.md` | `{{name}}` `{{author}}` `{{trigger}}` `{{target}}` |
| `interject.md` / `initiate.md` | yes | Tasks: cut into a live conversation / start a topic in a silent chat. Code rolls `spontaneous.initiateChance` after `deadAfterMinutes` of silence, so the initiate prompt speaks by default and `<skip/>` is for a channel where a new topic is plainly out of place. An initiate turn may also follow the persona's own last line once the channel is dead | `{{name}}` |
| `forced.md` | no | Appended after the mode prompt on a forced turn (`/nep talk interject`, `/nep talk initiate`). Overrides the `<skip/>` default | `{{name}}` |
| `describe.md` | yes | Out-of-character prompt of the media describer (`features.mediaDescriptions`): one picture in, one plain line out: what is visibly there, with actions and identities only on clear evidence. Legible text quoted in its original script. Indistinct regions described as such, ambiguous shapes not turned into an identity. Always English. No commentary, no moralising, no markdown | `{{today}}` `{{maxChars}}` (optional) |
| `describe-video.md` | yes | Out-of-character prompt of the video describer (`features.videoDescriptions`): one video clip in (with sound), a full ordered account out: who appears, what is said (key phrases quoted), text on screen, what happens visually. Audio-first: the model decides from the audio alone whether anything is audible, opens with a plain statement of what it hears (or silence), and never infers sound from the picture, captions or genre. Configurable length. Always English; speech, captions and on-screen text quoted in their original language. No character card | `{{today}}` `{{maxChars}}` |
| `describe-gif.md` | no | Out-of-character prompt for the GIF describer (`media.gif.watch`): a short silent clip in, three labelled lines out: `reaction` (the reply function, a few words or `none`), `action` (what visibly happens, capped at `{{maxChars}}`), `text` (on-screen text verbatim or `none`). Always English. No character card. Falls back to `describe-video.md` when absent | `{{today}}` `{{maxChars}}` `{{seconds}}` |
| `avatar.md` | no | Out-of-character prompt of the avatar describer (`features.avatars`): one member's avatar picture in (a static PNG; an animated avatar's first frame), one plain line out of what is visibly there. Role `vision`, purpose `avatar`; the output's first line is kept, cut to `avatars.descriptionChars`. Always English. No character card. Without it the feature does nothing. See [Avatars](#avatars) | `{{maxChars}}` |
| `rewatch.md` | yes | Classifier: does this message need the persona to re-watch a video, retry one that did not load, or look at a picture again (`features.videoRewatch`, `features.imageRelook`). Receives a numbered list of recent media (videos, watched GIFs listed as videos, and pictures) with their kind, status and the new message. Output is ONE line: `<number> \| <question>`, `<number> \| retry` or `none`. Never asked with `features.coreTools` on (the persona's own `media.look` instead) | `{{name}}` |
| `rewatch-answer.md` | yes | Out-of-character prompt for the second-look answer: the vision or video model looks at the item again and answers one question in the language of the question. The question arrives as the user message next to the picture or video. Kind-neutral (serves both videos and pictures). For a video: sound only when present in the audio, silence stated plainly, track identification treated as guesswork unless the clip names it. No character card | `{{today}}` `{{maxChars}}` |
| `address.md` | yes | Classifier: is this untagged message addressed to the persona, about them, or neither. Output is one word: `yes`, `overheard` or `no` | `{{name}}` |
| `overheard.md` | no | Task: the message talks about the persona, not to them. Used INSTEAD of the mode prompt when the trigger kind is `overheard` and the file is present and non-blank; missing or blank falls back to the mode prompt (degraded) | `{{name}}` `{{author}}` `{{trigger}}` `{{target}}` |
| `errand-result.md` | no | Task: a finished errand of the persona opened this turn and there is no origin message. Used INSTEAD of the mode prompt (`interject.md`) when the trigger kind is `errand` with no trigger and the file is present and non-blank; missing or blank falls back to `interject.md` (degraded) | `{{name}}` |
| `lookup.md` | no | Classifier: does the persona need to look something up (`features.webLookup`, `features.recall`). Receives a short transcript and a `<candidate>` block. Output is `none`, or up to six labelled lines: `web:` a web query, `server:` word forms to search in the server's messages, `who:` name forms to find a person, `when:` a date range, `when-role:` `scope` or `locator` (whether the date is the question or only helps find the event; it only qualifies `when:`), `recent:` `yes` or `no` (a vague "recently"; it only qualifies the other lines). An optional `skills:` line names skills relevant to the message or requests the full list. A single unlabelled line is still read as a web query. The classifier never creates or suggests an errand (only the persona's own `errand.run` call does): an `agent:` line is ignored | `{{name}}` `{{today}}` `{{skills}}` |
| `recall-summary.md` | no | Out-of-character prompt for the recall summary (`features.recall`): reads the stretches of old chat found by the server search and answers the question, optionally naming one stretch the persona gets verbatim. No character card | `{{name}}` `{{answerChars}}` |
| `room.md` | no | Classifier: is this message put to everyone in the room, or aimed at one person (`spontaneous.roomQuestionChance`). Receives a short transcript, the author's aliases and a `<candidate>` block. Output is ONE word: `yes` or `no` | `{{name}}` |
| `route-channel.md` | no | Classifier: does answering this message need the persona to see another channel (`features.channelRoute`). Receives a short transcript, a `<channels>` list and a `<candidate>` block. Output is ONE line: a number from the list, `<n> earlier` (the page before the last view of that channel) or `none`. With no previous view within `context.pull.seenTtlMinutes` the earlier form shows the newest page | `{{name}}` |
| `participation-pick.md` | no | Classifier: which of the persona's stored exchanges on other channels the new message refers to (`features.participation`). Receives a numbered `<episodes>` list first (the cache-stable part: oldest first, no ages, so a new episode appends a line), then `<episode_ages>` (`n | duration`, per call), a short `<transcript>` (own lines marked with `labels.self`) and a `<candidate>` block. Output is ONE line: up to 4 numbers from the list, comma-separated, most relevant first, or `none`. No character card. Without this file the newest episodes are shown | `{{name}}` |
| `planner.md` | no | The turn planner (`features.turnPlanner`): one pre-reply analyzer call that replaces the channel router, the episode pick, the search classifier and the re-watch classifier. Receives `<channels>`, `<episodes>` (oldest first, no ages; with `<channels>` the cache-stable part), `<episode_ages>`, `<media>`, a short transcript (`web.search.contextMessages` lines) and a `<candidate>` block. Output is four labelled blocks (`channel`, `episodes`, `rewatch`, `lookup`) plus an optional `skills` line. Role `analyzer`, purpose `planner`; output cap `web.search.classifierMaxOutputTokens`. No character card | `{{name}}` `{{today}}` `{{skills}}` |
| `elsewhere.md` | no | Task: the persona read a channel where they cannot write and may comment on it in the main channel (`features.elsewhere`). Used as the task text for a noticed turn. `<skip/>` is the normal outcome | `{{name}}` `{{channel}}` `{{destination}}` |
| `read-link.md` | no | Out-of-character prompt for the link reader (`features.webLookup`, `web.links.enabled`): condense a fetched page into one paragraph. Receives the page title and body. Not used with `features.coreTools` on (a posted link shows the opening of the page's text instead). No character card | `{{today}}` `{{maxChars}}` |
| `search-summary.md` | no | Out-of-character prompt for the search condenser (`features.webLookup`, `web.search.enabled`): condense numbered search results into one note with inline sources. Only for the search classifier's lookup (`features.coreTools` off) and the diary; never for her own `web.search`, which returns the results raw. No character card | `{{today}}` `{{query}}` `{{maxChars}}` |
| `private.md` | no | Appended after the mode prompt (`reply.md`), before `forced.md`, only in a DM (`features.privateMessages`). This is a private conversation: what is said here stays here; the persona keeps their public knowledge. A missing file adds nothing | `{{name}}` `{{author}}` |
| `inner.md` | no | Task of an inner turn (`features.innerLife`, mode `inner`; [Inner life](inner-life.md)): nobody wrote to the persona, she is awake for the reason in `<wake>`, the current channel comes from the cause of the wake (none on a review, a heartbeat or a wake with no place); her `<msg>`, `<gif>` and `<react>` and a `draw.create` call act in the current channel through the same gate as any turn, `<react>` needs its target, `message.create` is the way to post elsewhere or when there is none; the posting tools are among her tools; silence (`<skip/>`) is a valid answer. Missing or blank: the inner turn has no task text |
| `heartbeat.md` | no | Task of an inner turn whose anchor wake is `heartbeat`, used INSTEAD of `inner.md` (every other inner turn keeps `inner.md`): A decision prompt for `<think>`: first recall a person or shared exchange through a memory read, then consider the result and choose a concrete desire without a mandatory category checklist. Further reads resume the same decision. The technical anchor transcript, its neighbouring conversation and tempo are omitted on a heartbeat; other turn kinds keep them. Small social acts can be intentions. Memory inspection is allowed inside the wake; external activities remain in the intention's turn. Missing or blank falls back to `inner.md` (degraded) | none | none |
| `diary.md` | yes | Task: write a diary post. The persona's own channel, nobody asked. The plan's kind and brief, past posts, the optional world and search result are in the user message blocks. Output: `<msg>` (1 to `diary.maxMessages`), `draw.create` calls (several in one answer for a set kind, `diary.setKinds`), or `<skip/>`; `<react>` and `<gif>` are dropped. No reply attributes, no links | `{{name}}` |
| `diary-plan.md` | yes | The planner: pick the kind, a brief and whether to search and draw. Runs on the `analyzer` role, no character card. Receives `<now>`, `<server>`, `<about_chat>`, `<recent>`, `<lore>`, `<world>`, `<diary>`, `<kinds>`, `<seeds>`, and `<topic>` when the owner gave one. Answers one JSON object | `{{name}}` |
| `world.md` | no | The persona's virtual world: the places and routines it lives in outside the chat. Rendered as a `<world>` block only in the diary plan and compose requests, and only when `diary.world === true`. Never in an ordinary turn. A missing file or switch adds no block | `{{name}}` |
| `diary-seeds.md` | no | Random seed families for the diary planner. `# name` headers start a family (place, setting, detail, activity, subject, twist); code draws one line per family and composes `diary.seedSets` combinations as a `<seeds>` block (and `diary.set.seedSets` for the compose request of a set post). Omitted when missing or the count is 0 | none |
| `draw.md` | yes | Out-of-character prompt of the drawing sub-process (`features.imageGeneration`): produces one picture from a scene description. Receives only the appearance and the request — never the character card | `{{name}}` `{{appearance}}` `{{request}}` `{{when}}` |
| `appearance.md` | no | The persona's visual look, inserted into `draw.md` when `self` is true. One paragraph, no personality, no backstory | `{{name}}` |
| `gif-pick.md` | no | Classifier: pick a GIF from the library to replace a short text reply (`features.gifPicker`). Receives the last `gifs.pick.contextMessages` chat lines with the answered message named, the persona's reply, the whole captioned library and, when present, `<gifs_recent>`. The length gate is `gifs.pick.maxChars` (default 160); with several outgoing messages only the first is replaced. Output is one handle from the library or `none`. No character card | `{{name}}` |
| `speech-prepare.md` | no | Preparation pass of a voice message (`features.speech`, role `analyzer`, purpose `speech`, temperature 0): receives the text she wants to say and returns it with dropped letters restored, a stress mark (U+0301) on ambiguous words and every bracketed direction as a short English audio tag. The engine accepts the answer only when it is equal to her text once marks are stripped and each bracket is read as one token (`sameWords`, src/speech/prepare.js); otherwise her text is synthesized as written. No character card. Without this file the pass is skipped | none |
| `split.md` | no | Classifier: does a direct call hold several separate requests (`features.splitTasks`). Receives a short `<transcript>` and the new message as `<candidate>`. Output is the word `one`, or 2 to `{{maxTasks}}` lines each starting with `- ` and holding one part in the author's own words. No character card. Without this file the splitter is off | `{{name}}` `{{maxTasks}}` |
| `merge.md` | no | Classifier: does a new message from an author with waiting items belong to one of them. Receives a numbered `<waiting>` list and the new message as `<candidate>`. Output is one line: a number from the list or the word `new`. No character card. Without this file a new call is always queued as its own item | `{{name}}` |
| `missed.md` | no | Classifier: do earlier messages to the persona still need an answer (`features.missedAnswers`). Role `analyzer`, purpose `missed`. Receives a short transcript (`missed.contextMessages` lines, the persona's own lines marked with `labels.self`, trigger markers when on) and a `<candidates>` block of numbered messages with their transcript line and the reason they were flagged. Output is one `n: verdict` line per candidate: `owed`, `resolved`, `intentional-skip`, `stale` or `uncertain`. A failed call gives every candidate `unchecked`, never `owed`. No character card | `{{name}}` |
| `labels.json` | yes | Every string the CODE inserts into a prompt. Keys fixed below, values are the text author's (the dev agent) | see below |
| `config/tools.json` | yes | The persona's tool texts, keyed by tool name (`hot.prompts.tools`). It sits in `config/`, and a deployment's own texts in `config.local/tools.json`, deep-merged like `labels.json`: the local file adds or overrides individual keys. A `prompts.local/skills.json` left over from an earlier layout stops the start with one line naming `tools/tools-file-move.mjs`, which moves it and renames the `skills` section of `prompts.local/labels.json` to `tools`. Each key holds `title`, `whenToUse`, an optional `whenNotToUse` and `args` (one description per parameter, sent with the tool schema). Code joins them with the structural definition from `src/tools/registry.ts` at the moment of use (`describeSkill`) | none |

`{{name}}` bot's display name · `{{author}}` caller's display name · `{{trigger}}` one of `labels.triggers.*` ·
`{{target}}` index of the calling message (`#87`).
`{{today}}` in `lookup.md` is the date in `bot.timezone`; in the describers (`describe.md`, `describe-video.md`, `describe-gif.md`) and `search-summary.md` it is the UTC date.
System message = `system-prompt` + `character-card` + `rules` + `format`.
On a forced turn (`/nep talk interject`, `/nep talk initiate`), `forced.md` is appended after the mode prompt if the file exists.
On an `overheard` turn, `overheard.md` REPLACES the mode prompt (it is the task text, not an append). When `overheard.md` is missing or blank, the mode prompt is used instead (degraded: the mode prompt frames the line as said to the persona, which is not what happened).
On the turn a finished errand opens without an origin message (trigger kind `errand`, no trigger), `errand-result.md` REPLACES the mode prompt (`interject.md`). When `errand-result.md` is missing or blank, `interject.md` is used (degraded: it tells the persona that skipping is the normal outcome). With an origin message the reply task text is used as before.
In a private chat, `private.md` is appended after the mode prompt (before `forced.md`) with the same `{{name}}` and `{{author}}` placeholders.
`describe.md`, `describe-video.md`, `describe-gif.md`, `avatar.md`, `draw.md`, `rewatch.md`, `rewatch-answer.md`, `address.md`, `lookup.md`, `read-link.md`, `search-summary.md`, `recall-summary.md`, `room.md`, `route-channel.md`, `participation-pick.md`, `planner.md` and `elsewhere.md` do not receive the card.

## Blocks

The blocks of the user message. Empty ones are omitted; the order in the reply request is: the stable part (`<senses>` with its stable lines, `<tools>` (the text transport only), `<self_facts>`, `<about_chat>`, `<gifs>`, `<channel_directory>`, `<directory>`), the profiles (`<people>` with the interlocutor alone), then the tail from a second `<people>` (every other member the request describes) and `<server>` to `<chat>` (`<people_now>` right before `<chat>`, after `<skills>`, `<errands>`, `<errand_result>`, `<intentions>`, `<wake>`, `<places>` and `<previous_think>` when they are there), with `<now>`, `<senses>` with its per-turn lines, `<tempo>` and `<task>` last. `<senses>` is split between the stable part and the tail under one tag, so the cached part holds nothing that changes from turn to turn: the per-turn lines are `senses.recall`, the drawing line, `senses.participation` and `senses.privateChat`; every other line is stable. Each half keeps the relative order its lines had in the one block and is omitted when empty. `<emoji>` stays whole in the tail, right after `<server>`: its ranking moves with use several times a day; `<gifs_recent>` follows it. `<people>` is split the same way: the cached profiles hold only the interlocutor's profile, which stays the same while the same member talks to the persona; the members asked about and the compact participants, who come and go from turn to turn, open the tail in a second `<people>` block, in the order they had after the interlocutor. Each profile renders exactly as in the one block; an empty half is omitted. What changes from turn to turn about a person (the live snapshot, the attitude and its moves, the message count, whether they are the one talking to the persona) is never in `<people>`: it is their entry in `<people_now>`, in the tail. `<kinds>`, `<seeds>` and `<topic>` belong to the diary's plan request, which keeps its own order (see [Diary](#diary)); a set post's compose request also carries `<seeds>`, right after `<plan>`.

| Block | Content |
|---|---|
| `<self_facts>` | What the persona has claimed about themselves. With `features.promptCache` on, held per cache bucket (one `llm.cache.ttl`, an hour by default, buckets aligned to the clock): the block shows the facts as the bucket's first reply request found them, so a memory batch changes the cached stable part at most once per bucket and a new fact shows at the next bucket edge |
| `<about_chat>` | How people talk here, how they start and cut into conversations, in-jokes, things people taught the persona |
| `<gifs>` | GIFs the persona can post (`features.gifs`): at most `gifs.max` (default 40) entries from the library, ranked by recency-weighted use. Each carries the handle (`g1`, `g2`, …) and three fields from the describer when cached: a reaction label (capped at `gifs.reactionChars`, default 40), a visible action (capped at `gifs.actionChars`, default 70) and on-screen text. An entry with fields renders through `labels.gifs.entryFields` (`{id}`, `{reaction}`, `{action}`, `{text}`; code drops empty fields and their separators); an entry without fields uses `labels.gifs.entry` (`{id}`, `{text}`) with the caption cut at a word boundary. Each entry also stores when and how often the persona posted it (`ownLast`, `ownUses`); the list itself never marks it: which listed GIFs the persona posted lately is `<gifs_recent>`, in the tail. With `features.promptCache` on, the list (its order and its text) is held per cache bucket like `<self_facts>`: a use that reranks it or a new caption shows at the next bucket edge. The GIF picker's list is held the same way and is never marked either: its own `<gifs_recent>` follows it in its per-call tail |
| `<gifs_recent>` | In the tail, right after `<emoji>`: the GIFs of the `<gifs>` list the persona posted within `gifs.ownMarkHours` (default 24; `0` = off), newest post first, one per line: the handle, a space and `labels.gifs.ownMark` (`{ago}` through `labels.units`). Paid from what the request has left; left out when it does not fit, without `gifs.ownMark` or with no such post |
| `<tools>` | Her tools described in text, the text transport only (`tools.transport` `text`): `labels.tools.toolsText.lead`, one JSON line per tool (`{ name, description, parameters }`, the dotted name, keys in a fixed order, sorted by name), then `labels.tools.toolsText.protocol`. On the native transport (the default) the same tools travel as the request's `tools` field instead and no block is sent. The tools are the skills granted to the persona (`bot.access` entries naming her user id) and the carried-over ones (`message.create`, `message.react.add`, `draw.create`), minus those whose feature switch is off (`draw.create` only while `features.imageGeneration` is not false); safe mode leaves the carried-over ones, `features.tools` off none. The same list on every turn kind, byte-identical until a grant or a skill text changes. Fixed, never cut. In the stable part, right after `<senses>` |
| `<channel_directory>` | The channel directory (`features.mentionHandles`, missing = on): every text channel of the served guild the persona can read (not a thread, not the dry-run mirror; interfaces/discord/collect.js#channelDirectoryOf), with its channel handle (see [Mention handles](#mention-handles)). `labels.channelDirectory.lead` (when set), then one line per channel: `labels.channelDirectory.lineCategory` (`{handle}` `{name}` `{category}`) for a channel inside a category when that label is set, else `labels.channelDirectory.line` (`{handle}` `{name}`). `{handle}` is the exact token to write, `#` included; `{name}` the channel's name and `{category}` its category's name, each one-line, as a JSON string. Channels sorted by id. No activity, counts, topics or times, so it is byte-identical between turns whoever asks and wherever, until a channel is added, removed or renamed. Never cut. Without `labels.channelDirectory.line` or with no channel (a private chat) it is omitted. In the stable part after `<gifs>`, before `<directory>` |
| `<directory>` | The people directory (`features.mentionHandles`, missing = on): every member of the served guild with a stored profile (never the persona herself; bots get no profile) that has a stored name or an open alias. `labels.directory.lead` (when set), then one line per member: `labels.directory.lineAliases` (`{handle}` `{names}` `{aliases}`) for a member with aliases when that label is set, else `labels.directory.line` (`{handle}` `{names}`). `{handle}` is the exact token to write, `@` included (see [Mention handles](#mention-handles)); `{names}` the stored names Discord gave them, `{aliases}` their open stored aliases as stored (one equal to a name left out), each list one-line, each name once, as JSON strings in code point order joined by ", ". Members sorted by their first name (else first alias), then id. No notes, games, weights or real names. Built from the stored profiles alone, so it is byte-identical between turns whoever asks and wherever, until a member's names or aliases change. Never cut. Without `labels.directory.line` or with no member to list it is omitted. Last in the stable part, after `<channel_directory>` |
| `<people>` | What the persona durably remembers about members, in two blocks (see the order above): the caller's alone in the cached profiles, everyone else's at the head of the tail. A profile holds names, former names, aliases, the names people use and the real name, character, interests, style, details, the shared history, and for the caller the **episodes**: moments the persona remembers about the two of them, with dates and short quotes. Each profile's heading is `## ` + the name + ` (@handle)`: the member's mention handle, the same token `<directory>` lists and their `<people_now>` entry's heading starts with, so the three join by it (no handle with `features.mentionHandles` off). A member of `<directory>` keeps that handle while the directory's members stay the same, whoever else is in view, so the caller's cached heading does not move with the chat. Nothing in a profile changes within a day unless memory itself changes: no tag for the caller, no attitude, no message count, no live line (all of that is the person's `<people_now>` entry); interests, details and aliases are ordered by their stored weight and absolute `lastSeen` (src/memory/ranking.js#rank, no age relative to now); the stale mark, a replaced claim riding on its successor and the order of the names people use read the clock by the UTC day. With `features.avatars` on, a profile carries one line about the member's current avatar right after the name lines, in the full and the compact form: `labels.profile.avatar` (`{text}`, the stored description) or `labels.profile.avatarDefault` (Discord's default avatar); nothing while no avatar is stored. It changes only when the avatar does (see [Avatars](#avatars)), and it is not something learned about the person. The caller with nothing durable learned gets `labels.profile.unknown`; anyone else with nothing durable learned is shown by the heading alone when they carry an attitude (their row says it), else not at all |
| `<server>` | The CURRENT channel in full (Discord category and topic, purpose, what people write, tone, activity, last message, top writers; marked with `labels.server.currentMark`) plus only the neighbour channels that fed `<other_channels>` this turn; no other channel |
| `<emoji>` | Custom emoji the persona can use (`features.customEmoji`): at most `context.customEmoji.max` entries, ranked by member usage. Each carries `:name:` and the `vision` caption when one is cached. When `labels.emoji.seenInChat` exists, described custom emoji that appeared in the transcript, pulled channels or neighbours but are not in the top list are listed under that sub-heading; transcript lines keep a bare `:name:` for every custom emoji. Without the label (or without the block) the inline `transcript.emojiDescribed` tag stays |
| `<lore>` | Server lore entries whose keys occur in the recent messages (plus entries marked always): events, recurring characters, long-running stories. Like a lorebook: hundreds may exist, only the relevant few are shown |
| `<recent>` | What happened on the server in the last `memory.recentHours` (default 72) hours: recent notes (short events the analyzer writes) and in-window episodes of members, shown by reference. A note appears only from the turn's own channel or from a channel everyone here can also read; in a private chat, only from channels every server member can read, with no episodes. Items about the people this turn addresses rank first; episodes already rendered in `<people>` are left out, at most 2 per member. Oldest first. A header with no item renders nothing. Switch `features.recent` (missing = on); cap `context.caps.recent` (default 1200) |
| `<participation>` | The persona's own exchanges on other channels over the last `participation.hours` (default 72): `labels.participation.header` (`{hours}`), then per channel `labels.participation.channel` (`{channel}` `{purpose}`, the stored channel note's purpose) or `labels.participation.channelNoPurpose`, then per episode `labels.participation.episode` (`{when}`: how long ago the persona's newest line in it was) and its lines in the `<chat>` form without the `#n` index or a reply quote (clock time, aged lines with `transcript.timeAged`, the author, the text, a saved picture caption as `transcript.imageDescribed`); a run of cut lines is one `labels.participation.skipped` (`{count}`). At most `participation.shown` (default 4) episodes, `participation.perChannel` (default 2) per channel, never from the current channel, only from channels everyone here can also read. See [Participation episodes](#participation-episodes). Switch `features.participation` (missing = on); cap `context.caps.participation` (default 6000). Never in a private chat |
| `<earlier>` | The anchored chat window (`features.anchoredWindow`, exactly `true`; off, there is no block and the request is the count-based one): lines of the current channel older than `<chat>`'s window that still matter, kept as anchors. Two kinds. A **reply parent**: a message the trigger or a window line replies to that is older than the window (fetched for every window line, at most `context.replyParentsMax`); it leaves `<chat>` and shows here as its transcript line with its `<chat>` number (`#n`), so a reply marker or a message link in the chat still reads as that number. **Her saved stretch**: the participation episodes of this channel cut to their lines older than the window's first line and younger than `participation.earlierHours` (default 3; `0` = none), the newest `participation.earlierShown` (default 3), each in the `<participation>` line form (a run of cut lines is one `labels.participation.skipped`); a line that is also a reply parent carries its `#n` and is not repeated. A line addressed to the persona that she has not answered (an **open request**: a reply parent that mentions her or replies to a line of hers, a saved line that replies to a line of hers with no line of hers after it in its episode, and in both cases no line of hers in the chat or the stretch replying to it or posted by the turn it started) ends with `labels.participation.earlierOpen`. `labels.participation.earlierHeader`, then the anchors oldest first, `labels.participation.earlierGap` between two. Every line carries the bare clock, never an age. In the tail right after `<participation>`. Cap `context.caps.earlier` (default 2500); when it bites, kept in this order: the trigger's parent, anchors holding an open request, the other parents, the stretches, each newest first. Never in a private chat, nothing without `labels.participation.earlierHeader` (the parents then stay in `<chat>`). Kinds not kept as anchors: the last moves of a game, a correction, the object of a joke (nothing in the engine marks them yet); an errand she accepted is in `<errands>` already |
| `<attitudes>` | The top `context.attitudes` (default 6, `0` = off) members the persona feels most strongly about, ranked by the size of the attitude score, warm and cool mixed. Skips the interlocutor and anyone already in `<people>`. One line per member (`labels.attitudes.line`): name and attitude band. Header: `labels.attitudes.header`. Cap `context.caps.attitudes` (default 400). Present in server turns and private chats |
| `<other_channels>` | Up to `context.neighborMessages` messages per neighbouring channel, not older than `context.neighborMaxAgeMinutes`. When `features.mediaDescriptions` is on, a picture in a neighbour's line carries its cached caption when the describer cache already holds one; no new describe request is ever made for neighbours. A channel whose block is shown in `<channel_view>` is left out of `<other_channels>`; if the budget dropped the pulled block, the channel reappears here as an ordinary neighbour |
| `<channel_view>` | Another channel pulled into this turn (`features.channelPull`). Contains one item per pulled channel: a header line (`labels.pull.header`), a line saying what is new since the persona was last shown this channel in this destination (`labels.pull.seenBefore` or `labels.pull.seenSame`, `features.pullSeenMarker`), a read-only mark when applicable (`labels.server.readOnly`), an "older not shown" line when the window was cut, a "pictures not seen" count, earlier calls to the persona (with answered/unanswered/skipped marks), then the window lines. Lines use the same transcript format as `<chat>` but are numbered on after the chat (the chat has `#1`..`#N`, the pulled block starts at `#N+1`), so every `#n` is unique across blocks. Pictures appear as captions or blind tags only, never as attached images. Without `labels.pull.header` the block is empty |
| `<world>` | The persona's virtual world (`prompts/world.md` with `{{name}}` filled). Present only in a diary post (`mode === 'diary'`) when `diary.world === true`. Dropped whole under budget pressure. A missing file or switch off adds nothing |
| `<diary>` | Past diary posts, oldest first, `labels.diary.intro` then one `labels.diary.line` per post. Shown in both the plan and compose requests. Under budget pressure the oldest lines are cut first |
| `<plan>` | The plan for this diary post: `labels.diary.plan`, then one JSON line `{"kind","brief","picture"}`, plus `"topic"` when a forced run gave one (`tools/replay.mjs --topic`). Never cut |
| `<found>` | What the diary's search turned up: `labels.diary.found`, then the search result text. Present only when the plan asked for a search and it returned something. Ranked right after `<lookup>` in the budget |
| `<kinds>` | Post kinds with weights and usage counts: `labels.diary.kinds`, then one `labels.diary.kindLine` per kind with a positive weight; when the post cannot carry a picture, kinds in `diary.pictureKinds` are omitted. Never cut |
| `<seeds>` | Random seed combinations: `labels.diary.seeds`, then one `- a; b; c` line per set. In the plan request, `diary.seedSets` of them. In the compose request only for a set post (the planned kind in `diary.setKinds`), `diary.set.seedSets` of them, right after `<plan>`. Omitted when the file is missing or the count is 0. Never cut |
| `<topic>` | A topic for a forced post (`tools/replay.mjs --diary --topic`): `labels.diary.topic`, then the topic as one line, at most 1000 characters. Present only in the plan request, right after `<seeds>`, and only when a topic was given. Never cut |
| `<lookup>` | What the persona looked up this turn. A web search (`features.webLookup`) carries `labels.lookup.webHeader`, the condensed answer, `labels.lookup.sources` and, when nothing was found, `labels.lookup.none`. A server search (`features.recall`) carries `labels.lookup.serverHeader`, the summary note and, when the summary names a stretch, the verbatim lines of that stretch. When both ran, `labels.lookup.bothNote` sits between them. A `labels.lookup.stretch` line introduces a verbatim stretch (`{date}` `{channel}`). Appears only when a search classifier fired and at least one search completed; never with `features.coreTools` on (no classifier runs: she calls `web.search` and `memory.search` herself, their results come in `<result>`) |
| `<retrieved>` | The automatic memory prefetch of this turn (`features.coreTools` exactly true and `features.memoryPrefetch` not false; see "The automatic memory prefetch"): `labels.prefetch.header`, `labels.prefetch.basis` (`{basis}`: the lanes searched, `labels.prefetch.lanes.message` / `.reply` / `.recent`, comma-separated), then with excerpts `labels.prefetch.caution` and one `<excerpt>` per excerpt, best first: a stretch of the server's history opens with `labels.prefetch.excerpt` (`{n}`, `{source}` = `labels.prefetch.sources.history`, `{date}` its first line's local day, `{channel}`, `{id}` the message id of its best hit) and holds its lines without `#n` indices (time and author on each; a line the search found relevant starts with `>> `); a stored-memory item opens with `labels.prefetch.memoryExcerpt` (`{n}`, `{source}` = `labels.prefetch.sources.memory`, `{date}`, `{who}`, `{id}`) and holds its text. Without an excerpt the block holds the header, the basis and one status line: `labels.prefetch.status.none` (searched, nothing relevant), `.timeout` (the deadline passed first) or `.unavailable` (the search could not run). In the tail right after `<lookup>`, before `<skills>`; never in a cached part. One budget piece ranked right after `<lookup>`, kept or dropped whole, already bounded by `recall.prefetch.maxTokens`. The same block stands in every request of the turn's tool loop (it is not searched again). Absent when no prefetch ran (the switches, a trivial trigger, a turn no person's new message opened) or without `labels.prefetch.header` |
| `<skills>` | The full skill list, one `labels.tools.line` per skill, grouped by family (the part of the name before the first dot: `message.*` together, `memory.*` together, etc.). Each line carries the skill's arguments through `labels.tools.args` (`{args}`): the argument names of its command in the command's order (the names of the tool's parameters), each marked when required, with its allowed values (at most 8, then "…") or its numeric bounds. The order is the registry's and the command's, so the same grants give the same text. Present on an inventory request (the classifier or planner answered `skills: inventory`) or when the classifier proposed skills for the message. On an inventory, every skill is listed with its access state. On a proposal, only the allowed skills get their `tools.line`; any proposed skill that is not allowed is named once through `labels.tools.proposedOff` (`{names}`, comma-separated), except one the persona has but the person asking has no right to, named once through `labels.tools.proposedDenied` on the line after. Shown in the tail before `<chat>`. Switch `features.toolsDiscovery` (on by default; off when `features.tools` is off) |
| `<errands>` | The persona's errands ([Errand agents](errands.md)): `labels.errands.header`, then one `labels.errands.line` per task (`{id}` `{agent}` `{state}` through `labels.errands.states`, `{age}` in whole minutes, `{goal}` on one line cut to 120 characters) -- the open ones, then the finished ones whose result she has not read or closed, oldest first (at most `errands.unreadShown`, the rest counted by `labels.errands.unreadMore`; each ends with `labels.errands.unread`, `{error}` in the line is the code of a failed one); a private chat's only in that chat; the task of a `<errand_result>` turn is not listed again. In the tail right after `<skills>`, before `<people_now>`, never cut. Absent with no task or without its labels |
| `<errand_result>` | On the turn a task's end opened (trigger kind `errand`, `labels.triggers.errand`): `labels.errands.result.header` (`{id}` `{agent}` `{state}` `{goal}`), then `result.text` and the result text cut to `errands.resultMaxChars` (default 3000), or `result.empty`; `result.error` (`{error}`: the code) when it did not end `done`; `result.sources` and the sources as `1. <url>` lines; `result.files` and one `result.file` per file (`{handle}`: `file:<task id>/<name>`, the value of `message.create`'s `file` argument; `{contentType}` `{bytes}`). Right after `<errands>`, never cut. Such a turn runs no search of the engine's own (no search classifier, no planner lookup block, so no `<lookup>` block beside the result); a recall the persona calls herself still runs |
| `<intentions>` | `features.intentions` exactly true ([Intentions](inner-life.md)): `labels.intentions.header`, then one `labels.intentions.line` (`{id}` `{state}` through `labels.intentions.states`, `{purpose}` on one line cut to 200 characters) per open intention of hers -- `pending` (by due time, then age), then `waiting` -- each followed, joined by ` · `, by `due` (`{when}`: the next occurrence of a recurring one) or, for a `pending` one with no due time and no attention, `noDue` (`{expires}`: its expiry; nothing will wake her for it), `every` (`{period}`: the repeat period, `day`, `week`, `12h`, `3d`), `waiting` (`{errand}` the awaited errand, `{deadline}`) or, after a wait, `outcome` (`{errand}` `{state}`) or the `notes.<code>` of how the wait ended (`wait-deadline`, `errand-missing`; `{errand}`), `destination` (`{channel}`: the channel's name, else its id), and last `expiresSoon` (`{when}`: its expiry) when that is within `intentions.expiryNoticeDays` (default 2) of now and the line has no `noDue` part; then `labels.intentions.candidates` and one `labels.intentions.candidate` (`{id}` `{purpose}` `{span}`: the words of her line it came from, cut to 160 characters; `{marker}`: `labels.intentions.externalMarker` for an `external` candidate, which only an ordinary turn of hers may accept, empty for her own) per proposed candidate, newest first. Times are the date and clock in `bot.timezone`. Cut to `context.caps.intentions` tokens (default 600) by whole lines, the candidates' lead only with one candidate under it; a private chat's own only in that chat. Right after `<errand_result>` in the tail, never cut again. Absent with the switch off, on a diary post, with nothing open, or without its header and line labels |
| `<wake>` | An inner turn only (mode `inner`, `features.innerLife`; [Inner life](inner-life.md)): `labels.wake.header`, then one line per wake of the turn through `labels.wake.kinds.<kind>` (`intention_due`, `errand_deadline`, `review`, `attend`, `feedback`, `heartbeat`; `{id}` the intention, `{purpose}` its purpose cut to 200 characters, `{errand}` the errand a wait was for, `{due}` its due time; an `attend` line also `{place}` the place's name, `{lines}` the new lines since her last look, `{people}` who wrote them (names, else ids, joined by ", "), `{since}` when she last looked; one line per intention concerned, the review's line once; a recurring intention's last occurrence before its expiry gets ` · ` and `labels.intentions.notes.last-occurrence` after its line; a wake retried after a failed inner turn ([Inner life](inner-life.md#when-a-provider-call-fails)) gets one `labels.wake.delayed` line after its kind line (`{minutes}` since it was originally due, `{code}`: `provider-limit`, `provider-error` or `timeout`; without it the line is left out); a `feedback` line (no intention, every placeholder empty) is followed by one `labels.wake.feedbackItem` (`{fact}`) per fact of her previous turn ([Inner life](inner-life.md#feedback-on-her-own-turn)), the fact through `labels.wake.feedback.<kind>`: `callFailed` (`{skill}`, `{status}`, `{code}`, `{text}`), `doneWithoutDelivery` (`{id}`, `{purpose}` cut to 200 characters), `loopCut` (`{cut}`: `steps` or `time`, `{dropped}`, `{steps}`), `wakeDropped` (`{kind}`, `{code}`, `{why}`, `{id}`, `{purpose}`), `wakeDroppedKind` (`{kind}`, `{code}`, `{why}`), `wakeHeld` (`{kind}`, `{code}`, `{id}`, `{purpose}`, `{until}`), `turnFailed` (`{code}`, `{kind}`), `sendFailed` (`{code}`, `{n}`, `{total}`); a fact without its label is left out; the facts kept for her and not told yet follow the wake lines under `labels.wake.feedbackInTurn`, and an addressed turn carries them as its whole `<wake>` (the `feedbackInTurn` block in the tail before the task text)), then `labels.wake.here` (`{channel}`: the current channel as `#name`, `{why}`: one of `destination`, `asked`, `attend`, `errand`, `feedback`) or `labels.wake.hereNone` when there is no current channel (a review or a wake with no place), on a review `labels.wake.expired` and one `labels.wake.expiredItem` (`{id}`, `{purpose}` cut to 200 characters, `{when}`: when it expired) per intention of hers that expired untouched and was not told yet (never a candidate; the newest first, at most `innerLife.review.expiredMax`, default 5), then `labels.wake.expiredMore` (`{more}`) when more follow (the lead only with an item under it and both labels; each listed one is marked shown once the review turn ran, so a held or failed review lists them again), `labels.wake.now` (`{now}`: the date and clock with `bot.timezone`, `{timezone}`), `labels.wake.channels` (`{channels}`: `#name` of the channels she was last active in, a review only), the places page when `innerLife.attention.placesInWake` is above 0 (`labels.wake.places` with `{total}`, one `labels.wake.place` per place: `{name}`, `{lines}`, `{people}` since her last look there, `{flags}` (`labels.wake.placeReadOnly` when she cannot write there and `labels.wake.placeAttended` when she attends it, joined), then `labels.wake.placesMore` with `{more}` when more follow), then, on a heartbeat, the facts of `labels.wake.heartbeat` ([Inner life](inner-life.md#the-heartbeat); a part or line without its label is left out, an empty list says nothing): `people` and one `person` per member (`{name}`, `{parts}` joined by `partsJoin`: `contact` (`{when}`, `{place}`) or `contactNoPlace` (`{when}`), `lastWrote` (`{when}`, `{place}`, `{handle}`: the `#N` of their newest line, `{text}` cut to 120 characters, `{media}`: `media` (`{kinds}`) or `mediaTitled` (`{kinds}`, `{title}`) when the line has a link, video, picture or GIF), `interests` (`{interests}`), `activeIn` (`{places}`)), then, in place of the places page and before the people, `activity` with one `activityPlace` per place where others wrote in the last `innerLife.heartbeat.placesHours` (`{name}`, `{lines}`, `{people}`; at most `placesShown`, the busiest first) and under it `activityLine` per quoted line (`{handle}`, `{who}`, `{when}`, `{text}` cut to 140 characters, `{media}`; the newest `placeLines`), `life` with its `action` (`{when}`, `{skill}`, `{where}`: `where` `{place}`), `post` (`{when}`, `{place}`, `{text}` cut to 80 characters, `{media}`), `errand` (`{when}`, `{agent}`, `{state}`, `{goal}` cut to 80 characters) and `diary` (`{when}`, `{gist}` cut to 80 characters) rows, `open` with `openItem` (`{id}`, `{purpose}`, `{due}`: `due` `{when}`, `{origin}`: `openOrigin` for an intention a heartbeat created), `intentionsOnly` (one line before `skills`, only while `innerLife.heartbeat.intentionsOnly` is on), `attending` with `attendingItem` (`{id}`, `{purpose}`, `{place}`), `closed` with `closedItem` (`{id}`, `{state}`, `{purpose}`, `{why}`: the reason or outcome, `{when}`; at most `innerLife.heartbeat.closedShown`), `skills` with `skill` (`{family}`, `{names}`) and `agentsLine` (`{agents}`), then `since` (`{from}`), `done` (`{posts}`, `{errands}`, `{intentions}`; only when one is above 0), `notDone` with `expired`, `missed`, `lateErrand` (`{id}`, `{purpose}`, `{when}`), `failedErrand` (`{id}`, `{agent}`, `{code}`, `{when}`), `unknownSend` (`{skill}`, `{place}`, `{when}`), `failedTurn` (`{code}`, `{when}`), `told` (`{count}`), `filtered` with `filteredAddress` (`{when}`, `{place}`) and `filteredMissed` (`{when}`, `{place}`, `{verdict}`), or when the record still holds the line `filteredAddressLine` / `filteredMissedLine` (the same and `{who}`, `{handle}`, `{text}` cut to 100 characters, `{media}`); the `#N` handles of the activity, last-wrote and filtered lines are numbered past the request's own lines and resolve like a memory.search quote's; the whole heartbeat block is capped at `innerLife.heartbeat.maxTokens` (its lists shed their last items: filtered, life, places beyond 3, people beyond 5); a list over its cap ends with `more` (`{more}`), then `labels.wake.budgets` and one `labels.wake.budget.<key>` line per budget (`chain`; `{left}`, `{cap}`, `{reset}`: when it resets, the date and clock in `bot.timezone`, empty for a chain). Facts, never rules. Right after `<intentions>` in the tail, paid for with the fixed part, never cut. An addressed reply turn with facts kept for it has a `<wake>` of those facts alone (the `feedbackInTurn` block). Absent otherwise and without `labels.wake.header` |
| `<places>` | An addressed server turn with `context.places` exactly true (never an inner turn, a private chat or a diary post): the places page alone, the same lines `<wake>` carries (`labels.wake.places`, `place`, `placeReadOnly`, `placeAttended`, `placesMore`; the first `innerLife.attention.placesInWake` places by recent activity, `0` leaves the block out). Right after `<wake>`'s place in the tail, paid for with the fixed part, never cut. Absent without `labels.wake.places` |
| `<previous_think>` | Her reasoning from the request just before this one (`features.previousThink`, a missing key counts as on), at most one per request, chosen once when the request is built: `labels.previousThink.note` (what it is: kept as context, possibly out of date or wrong, current messages and results win, not to be quoted or retold), one line of engine metadata outside the text (`labels.previousThink.same`: a tool-loop step carries the think of the immediately preceding step of the same turn, none when that step had none; `labels.previousThink.earlier` with `{ago}`: a new turn carries the think of the latest finished turn tied to the same place), then the think whole (no cap), as inert text: `<` and `>` become `&lt;` and `&gt;`, so nothing in it can close the block or read as a tag or a call. A place is interface + server (or a private chat) + channel; a turn is tied to the place it ran in and to each place where a message of hers was actually delivered. A new turn takes the latest finished turn by completion order that ended within `context.previousThink.minutes` (default 30); a valid skip with a think counts; a failed or refused turn carries nothing and lets no older think through; a turn still running is never a source. An inner turn (heartbeat, intention, review) imports nothing across turns but exports its final think to the places it posted into. A think of a private chat is never carried into a group place. Kept in process, the latest entry per place (a restart forgets it). Logged per request as `turn: previous think` with the source (`source` the turn id, `relation` `same` or `earlier`, `ageSeconds`) or `none` (`none-in-window`, `failed`, `private`, `no-think`). In the tail right after `<places>`, paid for with the fixed part, never cut and never in a cached part. Absent without a think or without `labels.previousThink.note` and the metadata label |
| `<people_now>` | What is current about each person the request is about, in the tail right after `<skills>` and before `<chat>`, never in a cached part. `labels.peopleNow.lead` opens it, then the block's notices (only with a live part): `labels.peopleNow.stale` when the gateway dropped since the last update, `labels.peopleNow.unavailable` when `discord.intents.presences` is off. Then one entry per person, separated by a blank line: the caller first, then the members of the tail `<people>` in their order, then the people sitting in a voice channel the request has no profile for, by name. An entry (src/behavior/around.js#personRow) is a heading line, `labels.peopleNow.heading` (`{who}`) or, for the caller, `labels.peopleNow.headingMarked` (`{who}` `{mark}`) with `labels.peopleNow.marks.interlocutor` (`marks.overheard` on an `overheard` turn): a tag about the person in this request, in parentheses, never before a colon. `{who}` is the person's mention handle (`@` + handle, the same token `<directory>` and the `<people>` heading carry: the join key) and their name. Under it one field per line, `labels.peopleNow.field` (`{field}` `{value}`) with `{field}` from `labels.peopleNow.fields`. **Live fields** (`features.around`, missing = on; src/behavior/around.js#liveFields), always the same two (the Discord status is never shown): `voice`, `labels.peopleNow.voiceYes` (`{channel}` `{joined}` `{muted}` `{deafened}` `{streaming}` `{camera}`, each flag `values.yes` or `values.no`) when they sit in a voice channel the audience may see, else `values.no` (an offline member in voice shows the seat: invisible); `{joined}` is `labels.peopleNow.joinedAgo` (`{ago}` through `labels.units`) when this process saw the member join or move into that channel (a flag change keeps the time; a seat from the startup seed has none, and nothing is said about time); `activity`, every activity Discord shows, each through `labels.peopleNow.activity` by type (`playing`, `streaming`, `listening`, `watching`, `competing`, else `other`; `{name}`), with its details and state through `labels.peopleNow.activityDetails` (`{activity}` `{details}`, joined by ` / `, at most 40 characters) or, for a listening activity named Spotify with a track and an artist, `labels.peopleNow.activityTrack` (`{activity}` `{track}` `{artist}`), several joined by `; `, else `values.none` (also for an offline member, whose activities are not kept). Negatives are written only where the data can tell: Discord sends presences only for members who are not offline, so with the intent on and a fresh snapshot a member with no presence record is offline; with the intent off the activity is `values.unavailable` (the voice seat still shows: voice states need no privileged intent); with a stale snapshot voice and activity are `values.stale`, and no one without a profile is listed from it; a status Discord does not define makes the activity unavailable. Custom statuses are never kept or shown. **Fields of memory** (profiled people only, src/behavior/prompt.js#profileStateFields): with `features.relationships` on, `attitude`, `labels.peopleNow.attitude` (`{score}` `{band}` `{reason}`) or `values.none`; with an attitude and `relationships.shownMoves` above 0, `moves`, up to that many moves through `labels.peopleNow.move` (strongest by absolute delta first, oldest first, both signs kept when both exist, the current reason not repeated; at most one for a compact participant) joined by `; `, or `values.none`; then, except for a compact participant, `messages`, the message count rounded down to tens from 10 and to hundreds from 100 (as it is below 10), or `values.none`. A person with no field and no tag has no entry; a caller with no profile has one only for live fields. Member text (names, activity names and details, channel names) is one line, angle brackets removed, at most 80 characters. A live snapshot of the gateway's voice-state and presence events in process memory: never stored, journaled, recorded, logged or backed up. A voice channel is named only when a member with no role may see it. No live fields in a private chat or a diary post (the fields of memory stay where profiles are shown). Budget: the caller's entry is never cut; a tail member's entry is one budget item with their profile, kept or dropped with it; the people in voice without a profile are the lowest priority, capped by `context.around.maxTokens` (default 400; `0` = none) |
| `<result>` | Gone. A call's result is the tool message that answers it in the next request of the turn (see "The steps of a turn"); there is no result block in the user message. |
| `<chat>` | Up to `context.channelMessages` latest messages of the current channel. A line at least `context.ageAfterMinutes` (default 60) minutes old also shows how long ago it was posted (`transcript.timeAged`). When `context.fetchReplyParents` is on, the trigger message and the last `context.replyParentsFor` window lines that are replies to older messages have their parents fetched and placed before the window as ordinary transcript lines; the trigger's parent can also bring its own parent. At most `context.replyParentsMax` parents per turn. With `features.anchoredWindow` on, every window line has its parent asked and the parents show in `<earlier>` instead, keeping their numbers. A gap marker and date header cover the time jump; the reply line quotes the parent through `transcript.replyTo`; media in a parent is handled like any other line, and a cached description is served for free. A deleted or inaccessible parent is skipped and logged as `collect: parent missing` |
| `<now>` | Date, weekday, time in `config.bot.timezone`, formatted with `labels.locale`. When `features.offPeriods` is on, followed by `labels.journal.offLead` and up to 3 recent downtime periods (newest first, from the journal's system records over the last `journal.offWindowHours`): each uses `labels.journal.offPaused` or `labels.journal.offStopped` |
| `<senses>` | What the persona can and cannot perceive RIGHT NOW, generated from the live config: which pictures come as a `vision` description (never as the persona's own sight: no picture goes into the request), what they are blind and deaf to. So the persona never pretends to have watched a video and can joke about it in their own voice |
| `<tempo>` | Counts for 10 min / hour / day, distinct people, silence, a verdict (live / slow / dead) |
| `<task>` | `reply` / `follow-up` (when `follow-up.md` exists, for `followUp` and an untagged `reply`) / `missed` (a recovery turn, `features.missedRecovery`) / `interject` / `initiate` / `overheard` (when `overheard.md` exists) / `elsewhere` (when `elsewhere.md` exists, for a noticed comment) / `diary` (when `diary.md` exists, for a diary post), placeholders filled. After the mode prompt, up to four `task.*` labels are appended when their conditions hold (each separated by a blank line): `task.missed` when the turn is a recovery for earlier unanswered messages; then `task.part` when the turn answers one part of a split message, or `task.queued` when the trigger author has other calls waiting; then `task.queuedOthers` when other members have calls waiting in the channel; then `task.added` when later messages were folded into this call; then one `task.failedEarlier` line per addressed turn in this channel that ended `error` with nothing posted (kept up to `context.failedTurnsKept` per channel, 24 h, process memory only; cleared once shown). See `labels.task.*` below. A later request of the turn carries no task: its note is the `task.step.*` lines (see "The steps of a turn") |

Budget priority (sections are trimmed from the bottom of this list first): system + task + clock + tempo + senses + channel directory + directory
+ the caller's `<people_now>` entry (never cut) -> caller's profile with episodes -> lookup (kept or dropped whole; may hold a web part, a server part or both) -> retrieved (`<retrieved>`, the automatic memory prefetch, kept or dropped whole) -> about_chat -> self_facts -> lore -> server -> chat (newest first) ->
pulled (`<channel_view>`, capped at `context.caps.pulled`; on a turn that answers a call from a read-only channel the pulled block sits before the chat instead of after it) ->
earlier (whole anchors: the trigger's reply parent, the open requests, the other parents, the persona's saved stretches, each newest first; capped at `context.caps.earlier`) ->
recent (capped at `context.caps.recent`) ->
participation (whole episodes, the picked ones first; capped at `context.caps.participation`) ->
other profiles, each with its `<people_now>` entry (one item) -> attitudes (capped at `context.caps.attitudes`) ->
diary mode only: `<found>` (right after `<lookup>`), `<world>` (one piece, right after attitudes), `<diary>` (oldest lines cut first), `<plan>` + `<kinds>` + `<seeds>` + `<topic>` (never cut) ->
other channels -> emoji (entries from the bottom, then the whole block; `context.caps.emoji`) -> gifs (same trimming; `context.caps.gifs`) ->
the `<people_now>` entries of the people in voice without a profile (by name, the last first; `context.around.maxTokens`).
The `<people_now>` lead and notices are paid for with the fixed part when there is a caller's entry or a live part, else after the fit from what is left, on a budget line of their own (`peopleNow`; no room: no entries).

Cache segments. The reply's user message is sent as text parts in three segments: the stable part, the profiles and the tail; it never carries an image part. Each part but the last ends with the blank line between blocks, so the parts read as one text. The profiles part holds the interlocutor's `<people>` profile alone; the other members' profiles sit in the tail's own `<people>` block, so a member joining, leaving or being asked about changes only the tail. What changes by the minute or by the batch about the caller (voice, activity, the attitude with its moves, the message count, the tag saying they are the caller) is their `<people_now>` entry in the tail, never the cached profile, which stays byte-identical while the same member talks to the persona and memory about them does not change. The builder tags the stable part and the profiles with a neutral `cacheSegment` field; the client turns it into the provider's cache marker (`llm.cache.ttl` on the stable part, `llm.cache.profilesTtl` on the profiles) under `features.promptCache`, `llm.cache.roles` and `llm.cache.models`, and never sends the field. With the system message that makes three of the provider's four markers. A segment with no block is left out. Three `analyzer` requests use the same tag on a smaller scale: their user message is two text parts, the repeating bulk first (tagged `stable`, ending with the separator between blocks) and the per-turn text after it (untagged): the GIF picker (`<gifs>`, unmarked and, with `features.promptCache` on, held per cache bucket like the reply's list; then `<gifs_recent>`, `<context>` and `<reply>`), the route classifier (`<channels>`, then the transcript and `<candidate>`) and the participation pick (`<episodes>`, oldest first and without ages, then `<episode_ages>`, the transcript and `<candidate>`; the episodes block now leads the request). The parts' texts joined with nothing are the whole user text. Nothing in the stable part or the profiles reads the clock finer than a day: a GIF the persona posted is named in the tail's `<gifs_recent>`, never marked in `<gifs>`, and a profile reads the clock by the UTC day only (its stale and replaced-claim marks and the order of the names people use), ranks its items by stored values (src/memory/ranking.js#rank uses absolute dates) and shows no relative age. Nothing in the stable part depends on the turn either (`<skills_granted>` changes only with a grant to the persona, `<channel_directory>` only when a channel is added, removed or renamed, `<directory>` only when a member's stored names or aliases change; it comes last in the stable part, so a change there costs only its own text): the senses lines that do (the server search's availability, the drawing quotas, the participation line, the private chat) sit in the tail, and so does `<emoji>`, whose ranking moves with use several times a day. The stable part puts what changes least first. Display order and trimming are independent: the budget priority above is unchanged (both `<senses>` halves are one never-cut item).

GIF picker (`features.gifPicker`, default on). After the persona writes a short reply (at most `gifs.pick.maxChars` characters, default 160) and chose no GIF herself, a classifier (`analyzer` role, purpose `gif-pick`, `gifs.pick.maxOutputTokens` 60, prompt `prompts/gif-pick.md`) receives the last `gifs.pick.contextMessages` (default 4) chat lines with the answered message named in the context, the persona's first message and the whole captioned library (every entry with its caption, never marked; with `features.promptCache` on the list is held per cache bucket like the reply's `<gifs>`), followed by `<gifs_recent>`: the listed GIFs the persona posted within `gifs.ownMarkHours`, newest first, each as its handle and `labels.gifs.ownMark`, as in the reply's tail. The classifier answers one handle or `none`. On a handle the GIF replaces the first outgoing message and replies where it would have; the remaining messages follow in order. When the GIF fails to send, every message goes as written. The classifier runs during the first message's typing simulation and gets at most `gifs.pick.graceMs` (default 0) past its end; an answer later than that is ignored for the turn and the text goes as written. The daily GIF rail `gifs.maxPerDay` applies. Logged as `gifs: picked` (handle true/false, library size), `gifs: pick late` or `gifs: pick failed`.

Media in a transcript line, most informative form available: a described one (the `vision` caption, the only
way a picture reaches the persona; no picture is ever attached to the request) →
`imageDescribed` / `gifDescribed` / `videoDescribed`; otherwise the blind forms `image` / `gif` / `video`.
When video vision is on (`features.mediaDescriptions` AND `features.videoDescriptions`), a video or video-site link
gains a state: `videoWatched` (first-hand, seen and heard), `videoWatchedPart` (first-hand but only the start of a longer clip, with
the watched length, the total length and the reason from `transcript.videoPartReason.*`), `videoNotWatchedFrame` (not watched but a still frame was
described), or `videoNotWatched` (not watched, no frame). `videoWatchedPart` is for attached videos and downloaded clips;
`linkWatchedPart` is the equivalent for video links whose total length is known. The reason code (`length` / `size` / `daily` / `error` / `pending`) is
swapped for the human phrase from `transcript.videoReason.*` before it reaches the transcript. When code measures that the clip has
no audible sound or is mostly silent, `videoAudio.none` or `videoAudio.map` is appended to the video model's system prompt;
pinned direct URLs (YouTube sent by URL to the provider) and GIFs never get an audio note. Links keep their base
tag (`link` / `linkText`) and add a video extra: `linkWatched`, `linkWatchedPart`, `linkNotWatchedFrame` or `linkNotWatched`. Links use `link` / `linkText` built from Discord's
embed (site, title, snippet); the URL of a posted link stays in the message text where it was written (cut to
`context.maxUrlChars`, default 200), while the URLs of attachments, Discord CDN files, GIFs, stickers and custom emoji never
appear; when `features.webLookup` is on and the link was read, `linkRead` is appended after the
link's other extras (video, thumbnail). Text files show their beginning via `filePreview`; a forwarded message is
wrapped in `forwarded`. When `features.seeReactions` is on (the default), a reactions tag is appended at the very
end of a line, after media tags and forwarded wrappers. It lists at most `context.reactionsPerMessage` reactions per
message, most frequent first; each item uses `transcript.reactionItem` or `transcript.reactionMine` (when the persona
is among the reactors), joined with `transcript.reactionSeparator` (" · "; ", " for a labels file without the key) and
wrapped in `transcript.reactions`, as in `[reactions: 😂 x2 · 👍 x1]`. A labels file without
`transcript.reactions` renders nothing. With `features.reactionNames` on (the default) a reaction on one of the
persona's own lines in `<chat>` whose reactors are known names them instead of counting them:
`transcript.reactionNames` with `{names}`, the first
`context.reactions.maxNames` (default 5) reactors, each written exactly as the transcript writes an author (the
display name, with the handle through `transcript.author` when the member has one), joined with ", ", followed by
`transcript.reactionMore` with `{n}` when more members reacted than are named (more than the cap, or not known). When
the persona reacted too, she is named after the others (before the "+N") exactly as her own lines name her (`labels.self`),
as in `😂 Ana, Bé, Mira (you)`; a count item keeps `transcript.reactionMine`. She never counts toward the cap; other
bots are named like anyone, with their bare name. A reactor named on her line is in view
and gets a mention handle like an author. A reaction whose reactors are not known, every reaction on other members'
lines, pulled and neighbour channels and analyzer transcripts keep the counts. Who reacted is kept in process memory
only (`context.reactions.maxMessages` of her messages, default 500), fed by the gateway's reaction events; the
reactors a line of hers lacks are fetched once per message and emoji (at most `context.reactions.fetchUsers`, default
10) while the history is read, the turn waiting at most `context.reactions.fetchTimeoutMs` (default 2000). `<chat>`
is in the tail: none of this enters a cached part.

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
- Link preview (`features.coreTools` on): `preview:<link.id>` holds `{ text, ts }`, the opening of the page's own extracted text cut at `web.links.previewChars` (default 700), no model request; misses as for `read:`. It renders through `transcript.linkRead` like a condensed excerpt.
- Her raw search (`web.search`): `results:<sha1 prefix of the normalised query, 16 hex>` holds `{ query, results: [{ title, url, site, snippet, age? }], ts }`, served while younger than `web.search.cacheHours`. Failures are never cached.
- Her page read (`web.read`): `page:<sha1 prefix of the url as given, 16 hex>` holds `{ url, title, text, cut, ts }` (the url after redirects, the text cut at `web.links.readChars`), served while younger than `web.links.readCacheHours` (default 6). Failures are never cached.

Transcript line: `#87 [14:32] nick: text <replyTo> <media…> <sticker> <reactions>`; own lines use `labels.self`; between
lines `labels.transcript.gap` / `gapWithDate` / `date`; the block opens with `labels.transcript.header`. Neighbour
channels: same lines without `#n`, under `# channel-name`. A line at least `context.ageAfterMinutes` (default 60)
minutes old by the request's clock (the same moment as `<now>`) renders its time through `labels.transcript.timeAged`:
`#87 [14:32 · 2 h 58 min ago] nick: text …`. Ages appear only in `<chat>`, `<channel_view>` and `<other_channels>` and
are computed for each request and never stored; every other transcript (classifiers, the verbatim stretches of a server
search, the analyzer) keeps the plain time.

A message whose `editedAt` field is set (the interface's edit stamp; Discord `editedTimestamp`) carries `labels.transcript.edited` at the end of its text, before any media tags: `#87 [14:32] nick: text (edited) <media…>`. No old text is shown.

A message that was deleted since the window starts but would have been in view becomes a placeholder line at the message's own place, numbered like any line: `#88 [14:33] nick: message deleted`. The placeholder shows the author and the time (from the record's `seen` line of that id, or the deletion time when none) and `labels.transcript.deleted` with `{author}` filled, with no text of the message. A deleted message of the persona's uses `labels.self` for the author. Placeholders come from the channel record's `deleted` lines dated from the oldest fetched message on, one channel, the span of the window only. At most `context.deletedLinesMax` (default 10, `0` = no placeholders) newest per window; when a deleted message's `#N`, message id or link names a message the record holds as deleted and the history does not hold, a skill call on it is refused `message-deleted` (a reason of `unknown-message`; `labels.transcript.callReasons.message-deleted` / `labels.tools.result.reasons.message-deleted`). The classifier context and other channels' views do not carry placeholders.

With `features.triggerMarkers` on (a missing key counts as on), a line the persona posted in a turn that a message
started names that message after her name: `#100 [12:01] nick (you) (turn triggered by #98): text`
(`labels.transcript.triggeredBy`, `{n}` the trigger's number in the same block), or `labels.transcript.triggeredByOlder`
when the trigger is not among the block's lines (never a guessed number). It states where the turn came from, not that
the message is answered. A line that is a Discord reply to its own trigger shows only its reply marker; a reply to
another message shows both. Every line one turn posted names the same trigger; a spontaneous turn, a diary post or the
analyzer's transcript shows none. The link is kept by Discord message id (in process at each post, rebuilt at start
from the journal's `turn.start` and `turn` records of yesterday and today) and numbered when the transcript is
rendered. It appears in `<chat>`, `<channel_view>` and every analyzer transcript built from the turn's history; the
neighbours' lines show no `#n` and carry none.

With `features.callMarkers` on (a missing key counts as on), every skill call the persona made shows in the channel of
the turn that made it, on her last line that turn posted there, at the end of the line:
`#100 [12:01] nick (you): text [you called message.edit on #97: done]` (`labels.transcript.called`). `{skill}` is the
skill's name; `{target}` is `calledTargetMessage` with the target message's `#n` in the same block, else
`calledTargetLink` with that message's Discord link, else `calledTargetChannel` with the target channel's name (the
call's own channel when it named none), else empty; `{status}` is the call's result status (`ok`, `denied`, `invalid`,
`not_configured`, `unknown`, `partial`, `failed`) through `labels.transcript.callStatus`, the status code itself when
that map lacks it. A call that did not work says why: `{status}` is then `transcript.callStatusReason` with `{status}`
(that word) and `{reason}`: `transcript.callReasons[<kind>]` for the kind the code and its machine reason give
(`missing-arg`, `unknown-arg`, `wrong-arg`, `too-long`, `too-short`, `arg-twice`, `unknown-channel`, `unknown-role` with
`{arg}` the argument's name; `unknown-message` and `not-own-message` with `{arg}` the option that named the
message; `message-elsewhere`; `member-ambiguous`; `agent-required` -- an errand without its agent -- worded by `tools.refusals.agentRequired` ahead of everything else, with `{arg}` (`agent`) and `{agents}` the agents it may pick, comma-separated; `unknown-arg` of a skill that takes arguments worded by `tools.refusals.unknownArg` ahead of `callReasons`, with `{arg}` and `{args}` the arguments the skill takes, comma-separated; any other kind is the code itself, `channel-no-permission` with
`{channel}` the target channel's name), else the operation's own message as it said it (it names what exactly went
wrong; on one line, cut to `tools.markTextMaxChars`, default 200, with an ellipsis; kept in process only, so a mark
rebuilt from the journal after a restart has none), else the generic `tools.result.reasons[<code>]`, else
`tools.result.reasons.other` -- a phrase whose `{arg}` or `{channel}` cannot be filled is passed over; with no phrase, or `callStatusReason` blank, the
status word alone: `[you called message.delete in #general: did not run (wrong arguments): message was not given]`;
`{args}` is `calledArgs` (` ({args})`) with the call's main arguments, rendered from the recorded call and not from her wording (`src/tools/call-args.ts`: per skill the arguments worth showing, e.g. `query`, `url`, `channel`, `last`; one line, each string value quoted and cut at 60 characters with `…`, the whole at 160, brackets and angle brackets turned into spaces, never a field named like a secret), else empty (in process only: a mark rebuilt from the journal after a restart has none); a `called` label without `{args}` shows none; `{posted}` is `calledPosted` with the Discord link of the message the call posted (`message.create`,
`draw.create`), else empty, so she can name that message in a later call. A turn that posted no line in that channel
shows the call as a line of hers of its own, right after the last line at or before the call's time, with that time
and no `#n`: `[12:02] nick (you): [you called lore.list in #general: done]`. A call older than every line of the block
shows nothing. A line she posted through a call made from another channel's turn names that channel after her name,
before the trigger marker: `#7 [12:01] nick (you) (posted from #general): text` (`labels.transcript.postedFrom`); the
call itself shows only where it was made. Kept in process at each call and rebuilt at start from the journal's skill
operations of yesterday and today (their `failed` lines carry the result's `status`, `code` and machine `reason`). It
appears in `<chat>`, `<channel_view>`, every analyzer transcript built from the turn's history and the stretches of a
server search (where, without numbers, a target in view is named by its link). Blanking `transcript.called` drops the
call marks; blanking `transcript.postedFrom` drops the origin marker.

### The steps of a turn

Every chat turn (a reply, a follow-up, a mention, a name, a private chat, a part of a split message, a finished errand,
an interjection, an initiative, an overheard line, an inner turn, a heartbeat) runs the same engine
(`src/behavior/turn.js#runSteps`). The reply request carries her tools (`<tools>` on the text transport, the request's
`tools` field on the native one; a diary post carries the same tools, and only `draw.create` runs there). Her answer is a speech
part (`<think>` first, `<msg>`, `<react>`, `<gif>`, `<skip/>`) and tool calls: native tool calls, or on the text
transport `<tool_call>{"name": "draw.create", "arguments": {...}}</tool_call>` blocks (parsed by
`src/llm/tool-text.js`). A leftover `<call>` or `<draw>` tag in her text is a retired tag: cut out, never run, told once
(`tools.diagnostics.retiredTag`).

Her calls are planned in her order (each one journaled `proposed` with its `toolCallId`; a name no skill has, arguments
that could not be read or were cut off by the output cap, a call past `tools.loop.maxCallsPerStep` and every call of the
final request are refused with a result: `unknown-skill`, `malformed-call`, `truncated-call`, `loop-cap`; arguments
that name a boolean or a number as text are read as the schema says, `"true"` as true, `"5"` as 5, and the result tells
so under `tools.result.coerced`) and made in segments: a run of consecutive reads together, every other call alone.
Every call gets exactly one result, refused and capped ones included. The gateway is asked again right before each call.

Her speech goes out after the calls, and only when every call worked and none returned something to read (an `effect`
or an accepted errand, `job`, in `src/tools/definitions.ts`'s `result`; a `data` result never covers speech). Otherwise
the speech is held: not posted, never posted later, and the next request says so (`task.step.held`). A step that left
something to read (a `data` result, a call that did not work, an inner turn's open intention) is followed by one more
request, append-only: the previous messages, her answer (`tool_calls` on the native transport, her raw text on the
text one), one result for each call (a `tool` message, or a `<tool_result id name status>` block), and a note when there
is something to say -- in this order the held notice, the lines that came in meanwhile under `task.step.delta`
(numbered past the request's own lines and any `memory.search` handles; her own lines left out), the lines
whose video or captions the first request showed as not ready and are ready now, once, under `task.step.late` (re-rendered
with their original `#N`), one
`task.step.delivery` line per speech message that did not go out, `task.step.last` (`task.step.lastInner` on an inner
turn), an inner turn's open-intentions line and the parser's diagnostics under `task.diagnostics`. The first user
message is never rebuilt; a fourth cache marker (5 minutes) sits on the last part of the appended prefix.

`tools.loop.maxSteps` (an inner turn's `innerLife.loop`, the diary's `diary.loop`) counts those requests and the last of
them is always the final one, which cannot call: its calls get a `loop-cap` result that only the journal keeps and its
speech is held (an inner turn's one terminal call -- the first `message.create`, `intention.set`, `intention.update` or
`intention.cancel` -- still runs, and when it went through her speech goes out). A request is made the last when the steps
or the time (`tools.loop.timeBudgetMs`, from the first call) are spent, or when the request would not fit
`llm.maxRequestTokens` less `llm.maxOutputTokens` with its tools: the results are then cut to fit (400 characters each
at least), and if that is not enough the turn ends. Calls that no request followed are kept as a `loopCut` fact for her
next turn; failed calls she never read are `callFailed` facts. A heartbeat turn ends with its one intention change. Under
the full stop (`features.tools` off) a refused call brings no request.

An inner turn's `<msg>`, `<gif>` and `<react>` act in the current channel as calls lowered by
`src/behavior/inner-output.js` (a picture is the `draw.create` tool, refused `destination-required` when the turn has no
current channel), planned and made after the step's tool calls, only when the speech may go out. They have no tool call
id: a failure is a `delivery` line of the next note, or a fact. The turn record carries `format` (`thinkMissing`,
`coerced`, `malformed`, `truncated`, `capped`, `held`) and `steps`. Each later request logs `skills: follow-up answered`;
the loop logs `skills: loop` (`steps`, `calls`, `ms`); a dry run logs each call `dry-run: would call` and makes none.


With the switch on no search classifier (nor the turn planner's lookup or skills block) runs before her reply: nothing
is searched for her, there is no `<lookup>` block and no `<skills>` from a classifier's `skills:` line (logged
`lookup: skipped` with `reason: 'core-tools'`); her tools are described to her as tools instead (`<tools>` on the text transport, the request's `tools` field on the native one), and
`senses.searchTool` / `senses.recallTool` stand in for `senses.search` / `senses.recall`, and `senses.readTool`
follows the links lines when `web.read` is granted. No re-watch classifier runs either (nor the planner's rewatch
block; logged `rewatch: skipped` with `reason: 'core-tools'`): `senses.videoRewatch` is not shown, and
`senses.lookTool` stands in its place when `media.look` is granted and the image second look (`features.imageRelook`) or video vision is on. Her in-turn
tools are `web.search`, `web.read`, `media.look` and `memory.search` (reads, granted by name like any skill;
`media.look` exists for her only while the switch is on). Inside the loop
they run in the turn itself, never through another model role: `web.search` takes `query` and optionally `goal`,
and sends the query as she wrote it to the web search engines (`web.search.engine` and its fallbacks, the cache and
the daily `web.maxPerDay`), with no summary request; its result data is `tools.tools.web.source` (`{query}`),
`tools.tools.web.goal` when she gave one, then each result as the engine gave it, numbered: `N. title`, its link
(fragment and tracking parameters dropped, an over-long link without its query string, then cut), `site · date`
(the date only when the engine gave one), its snippet cut at `web.search.snippetChars` (default 400); a page listed
twice once; results stop once the text would pass `web.search.resultsChars` (default 3000; the first always shows);
`tools.tools.web.none` when nothing came back. On the `openrouter` engine the results are the web plugin's
`url_citation` annotations (their `content` is the snippet; no date) of one `analyzer` request (purpose
`web-search`) whose only message is her query, its answer capped at `web.search.rawOutputTokens` and never read.
`web.read` takes `url` (the body), or `message` (a `#N` she sees: its first embedded link, else the first link written
in its text; `no-link` when it has none), fetches the page through the SSRF-guarded fetcher (one daily
`web.maxPerDay` slot, no model request) and returns `tools.tools.read.source` (`{url}`: where the page ended after
redirects, `{maxChars}`: `web.links.readChars`, default 4000), `tools.tools.read.title` (`{title}`) when the page
has one, the page's extracted main text as it is (`src/web/readable.js`: the article or main element, without menus,
headers, footers or scripts), and `tools.tools.read.cut` (`{maxChars}`) when it was cut; a page with no text gives
`tools.tools.read.none`; a refused or failed fetch is a `failed` result with its code (`private`, `type`, `size`,
`http`, `timeout`, `redirects`, `network`; `scheme` is `invalid`). With the switch on, a link posted in the chat is
shown through `transcript.linkRead` with the opening of its page's text (`web.links.previewChars`), not an analyzer's
summary. `media.look` takes `message` (a `#N` she sees) or `url` (a video link, exactly one of the two), `question` (the body) and optionally `item` (for a message: which picture
or video of that message, 1 = the first, in the order the message shows them: attachments, then embeds, a forwarded
part after; a video link of a `media.video.sites` site counts once, as a video; stickers are not counted). A `url` must belong to a `media.video.sites` site (the engine fetches no other host); it is looked at as a video link in the chat is, the link itself as `{name}`, and it counts against the same rails and the same per-turn count as a message look. Her question
goes as she wrote it to the describer's second look, the same one the re-watch classifier triggers with the switch
off: a picture through the `vision` role (purpose `relook`), a GIF or a video through the video model, each with
`rewatch-answer.md` (`{{question}}`, `{{maxChars}}` = `media.video.rewatch.answerChars`), cached an hour per question.
Its data is `tools.tools.look.image` (a picture) or `tools.tools.look.video` (a video or a GIF), both with `{name}`
(the item's name) and `{question}` (what was asked), then the model's answer as it gave it. Rails: the daily
`media.video.rewatch.maxPerDay` (one counter for every second look), a video's `media.video.maxPerDay`, a GIF's
`media.gif.maxPerDay`, `llm.maxRequestsPerDay`; at most `media.look.maxPerTurn` (default 2) looks in one turn, counted
across the loop's steps. Refusals: `invalid` with `unknown-message` (not a message of the turn's chat), `no-media`
(nothing to look at), `invalid-args` (no question, both or neither of `message` and `url`, an unparseable `url`, or an `item` the message does not hold), `not-video-site` (a `url` off `media.video.sites`; its data is `tools.tools.look.notVideoSite`); `not_configured` while the
kind's switches are off (`features.imageRelook` for a picture, video vision and
`features.videoRewatch` for a video or a GIF); `failed` with `daily-cap`, `turn-cap`, or `error` when the model gave
nothing back. `memory.search` takes `question` (the body) and
optionally `people` and `terms` (comma-separated), `channel` and `when` (`YYYY-MM-DD`, `YYYY-MM-DD HH:MM` or `A..B`
with either side open, in `bot.timezone`): her terms and people, then the question's long words and the stored names
it holds, go to the recall runner (its rails and daily `recall.maxPerDay`; the turn's own chat left out of the hits)
with no summary request; its data is `tools.tools.memory.source`, then each stretch under `tools.tools.memory.window` with its lines as they were (time and author on each, and a `#N` handle each, announced by `tools.tools.memory.handles`), each cut by whole lines at `recall.quoteWindowChars` (default 1500) with `tools.tools.memory.windowCut` (`{dropped}`) when lines were dropped; stretches that do not fit whole at `recall.quoteMaxChars` (default 9000) are left out from the first miss on, a closing `tools.tools.memory.windowsLeft` line (`{count}`, `{where}`: each left-out stretch's channel and day, comma-joined) naming them; nothing left out, no closing line. `tools.resultMaxChars` does not cut a `memory.search` result: the tool bounds its own text. Or `tools.tools.memory.none` when nothing matched. `memory.search` also takes `anchor` (a `#N` of a quoted line, or a message id), `move` (`up` earlier lines, `down` later ones), `messages` or `minutes`: a call with an `anchor` reads the lines next to it in time order (the anchor itself left out; a line the channel may not open ends the read) and returns them as stretches in the same text; without `anchor` the call searches and `question` may be left out when `people`, `terms` or `when` name something. A result is data: a `<call>`
written inside it is never parsed or run. Outside the loop (the switch off) a granted call of any of them runs through its
command like any read; its result is read in the next step.

`conversation.read` (a fifth in-turn read, granted by name) reads one channel in order: `channel` (a name, a
`#handle` of the channel directory or an id; default this conversation) and one of `around` (a `#N` or a message link;
`before` and `after` then count the lines each side, 10 by default, 30 at most), `since` (a delay such as `2h`, a
clock time such as `12:00`, or an ISO date or date-time in `bot.timezone`) or `last` (default 20, at most 60 lines;
the newest). `before` or `after` given as a `#N` or a link, without `around`, reads the `last` lines before or after
that message (the way to read on). The span comes from the record first (the newest revision of each message, a deleted
one as a placeholder), the interface's history when the record lacks it. Its data is `tools.tools.conversation.source`
(`{channel}`), `.handles`, the lines as the chat transcript renders them (author, time, text, media, the edited and
deleted marks) each starting with a `#N` handle numbered past the request's own (the handles of a `memory.search`
result are numbered the same way and resolve in `message.*`, `media.look` and `memory.journal.read` in the same turn's
later steps), `.cut` (`{dropped}`) when `recall.quoteMaxChars` kept fewer lines, then `.earlier` and `.later`
(`{n}`: the handle of the first or last line shown) as the ways to read on; `.none` for an empty span. A channel the
audience rule or her rights hide is `denied` with `channel-not-visible`; an anchor that is not in the channel is
`invalid` with `unknown-message`.

Each step's request carries `<previous_think>` with the think of the step just before it (the same turn, `labels.previousThink.same`), when that step wrote one and `features.previousThink` is on; the first request of a new turn carries the earlier turn's instead (see the block's row above). Nothing older than the preceding step is carried.

### The automatic memory prefetch (`features.coreTools`)

With `features.coreTools` exactly true and `features.memoryPrefetch` not false (a missing key counts as on), a turn
that a person's new message opened -- not her own line, not an errand's result (`errand`), not the turn after a failed
drawing, not a diary post -- searches the server's history and her stored memory once for that message before she
answers, with no model choosing the query or reading the results first (`src/behavior/prefetch.js`, the recall
runner's `prefetch`). A trivial trigger is not searched (logged `recall: prefetch skipped` with `reason: 'trivial'`):
empty once Discord's tokens are left out, a command (`/` or `!` first), only punctuation, emoji or her names, or one
of the folded phrases of `recall.prefetch.trivial` (bare greetings and acknowledgements); a short line that is not
on that list, a catchphrase, is searched. The query lanes, each searched on its own: `message` (the trigger
verbatim), `reply` (when it replies to a line the turn has: that line, then the trigger, each as `Name: text`) and,
only for a trigger of at most `recall.prefetch.shortWords` words or with a word of `recall.prefetch.deictic`,
`recent` (up to `recall.prefetch.contextLines` lines just before it, at most `recall.prefetch.contextTokens`
tokens, then the trigger). Each lane goes through the local searches: by words, an in-memory index of the whole
record gives the lane's distinctive terms (its words held by at most `recall.prefetch.maxTermShare` of the record's
messages, word endings folded by endings learned from the record, the rarest `recall.maxForms`, a stored member's
other names and aliases as alternates, her own names left out) and phrases (two or three adjacent words the record
holds together, rarely and as a set phrase: `recall.prefetch.maxPhraseDf`, `recall.prefetch.minPhraseShare`; and
its quoted phrases), searched in the whole record and, as forms, in the stored memory and archive; by meaning
(`features.meaningSearch` exactly true), one embedding request for all lanes (purpose `recall-query`) and the vector
index, `recall.prefetch.candidates` rows per lane. A hit counts only when it is relevant. A history line found by
words: a phrase matched; or two terms or more (with the meaning search on, its own cosine at least
`recall.prefetch.minMeaningScore`); or one rare term (held by at most `recall.prefetch.rareTermDf` messages) with a
cosine of at least `recall.prefetch.singleTermScore`. A line found by meaning: a cosine of at least
`recall.prefetch.minMeaningScore`, three words or more, and either a cosine of at least
`recall.prefetch.strongMeaningScore` or a term or phrase of the lane on it or within two lines of it. A stored item:
a phrase, or at least `recall.prefetch.minFormsMatched` of the lane's terms (fewer when the lane has fewer; a name
alone never counts); found by meaning, a cosine of at least `recall.prefetch.strongMeaningScore` or a term or
phrase of the lane in its text. The lanes' ranked lists are fused by reciprocal rank
(k = 60; stored items at half weight, so the chat's own stretches come first), windows sharing a line merged into
one, and at most `recall.prefetch.maxExcerpts` excerpts kept within `recall.prefetch.maxTokens`, each cut to
`recall.prefetch.excerptChars` around its best line (and the relevant lines within six lines of it) with its
neighbours and reply chain. Zero excerpts is a
valid answer. The scope rules of a recall run apply before anything is kept: a channel the pull rail refuses toward
this one, another member's private lines, and the turn's own chat never reach the block; a private chat searches on
its partner's behalf only. The whole search is bounded by `recall.prefetch.deadlineMs`; what is still out then is
abandoned and the request is built without waiting for it (`labels.prefetch.status.timeout` when nothing relevant
had settled). A failure never fails the turn. It sends no Discord request and counts no `recall.maxPerDay` run;
the embedding counts as a request like any other. Logged `recall: prefetched` (`status`, `lanes`, `excerpts`,
`candidates`, `searches`, `failed`, `meaning`, `partial`, `ms`; never a query or a message) and journaled
as the preparation step `memory-prefetch` (`input.lanes`; `status`, `excerpts`, `ms`). Once per trigger and
text: a later attempt of the same turn reuses it. The result is rendered as `<retrieved>` in the tail; she can
still search deeper with `memory.search`.

## Labels

The keys of `labels.json`; `{x}` is filled by code.

```
locale                                   BCP-47 tag for dates
status.inner.attentionLine               {open} {listed} {run} {spoken} {skipped} {waiting}: her attention today on the owner's `inner` field (attentions open; attend wakes listed, run, spoken, skipped, waiting on a cap); read by the owner, never sent to a model
status.inner.tokensLine                  {prompt} {cached} {completion}: the core role's tokens of the day on the owner's `inner` field; left out without a usage row
status.probe                             the user message of the model probe on the owner's `/nep status` card; must make any model answer one short word. The embedding role is probed with a one-input embedding request of this text instead of a chat completion; when no embedding client is wired the embed line says it was not checked
status.costs.*                           the costs fields of the owner's `/nep status` card, `keys.base` (src/tools/impl/usage.ts#keyCostsLines), `costs.base` (#roleCostsLines), and `costs.errands` and `costs.development` (#agentCostsLines); read by the owner, never sent to a model. A missing key leaves its line out. The costs are OpenRouter's reported ones (the upstream cost when the answer carries it): a BYOK request is billed by the provider and shows at OpenRouter's list price
status.costs.keyLead | simKeyLead        the {lead} of the main key's and of the simulator key's (OPENROUTER_SIM_KEY) lines; each key's limit line is followed by its own usage line
status.costs.simKeyNotSet                the one line for the simulator key when it is not set (no usage line under it)
status.costs.keyLimit                    {lead} {spent} {limit} {notes}: the key's limit with what it spent in USD; notes are the reset and the BYOK note joined by `noteSeparator`; `keyLimitPlain` ({lead} {spent} {limit}) when there is no note; spent is `-` when the key reports none
status.costs.keyNone | keyNonePlain      {lead} {used} (keyNone only): the key has no limit, with its total usage when reported
status.costs.keyUnavailable              {lead} {reason}: the key read failed
status.costs.resets | resetsAt           {interval} ({at}: `YYYY-MM-DD HH:MM UTC`): the limit's reset; interval through `intervals.daily | weekly | monthly`, an unknown one as its code
status.costs.neverResets                 a limit with a null reset
status.costs.byokCounted | byokNotCounted   whether BYOK requests count against the limit; nothing when the key does not say
status.costs.noteSeparator | partSeparator  the joiners of the key line's notes and of the usage line's parts
status.costs.usage                       {parts}: a key's usage, parts from `usageToday` ({usd}, as the key reports it) and `last7` | `last30` ({usd} {since}: rolling sums of the roles on that key from the usage accumulator); `since` ({day}) when the accumulator holds fewer days than the window. With OPENROUTER_MANAGEMENT_KEY set and the key's activity read, `last7` | `last30` are today plus the completed UTC days of the window from that activity (no `since`), for every key the simulator one included
status.costs.usageWeekCal | usageMonthCal   {usd}: the simulator key's usage parts after `usageToday` without its activity: the calendar week and month as the key reports them (the usage accumulator never sees the tools' spend), each only when reported
status.costs.roleKeyLead | roleSeparator   {roles}: the lead word of an extra key's lines (`llm.keyByRole`), its roles joined by `roleSeparator`
status.costs.roleNames                     role -> the name an extra key's lead shows for it (each name once): the errand agents' roles (`scout`, `server`) show as `errands`, the development agents' (`thinker`, `dev`) as `development`; a role it lacks shows as itself
status.costs.reasons.timeout | network | noClient | badAnswer | http   the {reason} words; http has {status}
status.costs.byRoleEmpty                 the `costs.base` field alone when no request was made today (UTC day)
status.costs.role                        {role} {requests} {in} {cached} {out} {cost} {avg}: one role's requests today, tokens compact (`9.3k`, `974k`, `1.23M`), cost in USD; a role with no tokens (`drawing`: generated pictures, counted with their cost) shows them as `-`; the roles by cost, no header and no total; {avg} is `avg` ({usd}: cost per request, 3 decimals), empty with no requests
status.costs.agentLine                   {agent} {parts}: one agent's line of `costs.errands` (scout, server) or `costs.development` (thinker, dev), in that order; parts are one `agentWindow` per window joined by `partSeparator`
status.costs.agentWindow                 {window} {runs} {in} {out} {usd}: one window of an agent's spend from the errand records (src/errands/costs.ts): runs queued in it, input and output tokens compact and USD of the tasks that ended in it; {window} through `agentWindows.today | last7 | last30` (today, the last 7 and 30 UTC days with today), a missing one as its code
status.costs.agentNoRuns                 {agent}: the line of an agent with no run in the last 30 days; thinker and dev also get it when the ledger does not answer (no `agents.ledger.socket`, a refusal, an error or no answer within 3 s)
status.costs.agentContext                {agent} {wave} {turns} {mean} {peak} {usd}: the line right after the thinker's line (any agent whose ledger figures carry a last wave), its latest wave from the ledger: the wave, its turns, the context mean (weighted by steps) and peak in compact tokens (`-` for a missing one) and its USD; left out before the first wave or when the wave has no context figure
status.costs.agentEstimate               the last line of `costs.errands` and of `costs.development`: its USD are OpenCode's estimate at each agent's price (`agents.<agent>.cost`), not an OpenRouter key's figure
status.inner.*                           the owner's `inner` status field (src/tools/impl/status.ts#innerLines); read by the owner, never sent to a model. A missing label leaves its line out
status.inner.modeLine                    {mode} {state}: the inner life's mode (shadow or live) and its switch; state is `running` or `stopped` ({at}: `YYYY-MM-DD HH:MM UTC`)
status.inner.turnsLine                   {used} {chains}: inner turns used today, and the distinct causal chains
status.inner.usdLine                     {spent}: real USD spent today, `toFixed(2)`
status.inner.nextLine | nextNone         {at} {kind}: when the next wake fires and what it is; kind through `nextKinds` (queue, intention, review); `nextNone` when nothing is scheduled
status.inner.lastLine | lastNone         {outcome} {at}: the last inner turn's outcome code and time; `outcomeUnknown` when the turn recorded none; `lastNone` when no inner turn has run
status.inner.intentionsLine              {pending} {waiting} {proposed}: open intentions counted by status
status.inner.heartbeatLine               {at}: when the next heartbeat fires; read by the owner, never sent to a model
status.inner.heartbeatOff                shown in place of `heartbeatLine` when the heartbeat is off
self                                     {name}
units.lessThanMinute | minute | hour | day
transcript.gap                           {duration}: the time between two consecutive lines at least `context.gapMarkerMinutes` apart, worded so it cannot pass for an age
transcript.gapWithDate                   {duration} {date}: the same across a day change; date is the date of the line below
transcript.date | header                 {date}
transcript.timeAged                      {clock} {age}: replaces the whole bracketed time of a line at least `context.ageAfterMinutes` old; age is a duration in `labels.units`; younger lines keep `[{clock}]`; a missing or empty key shows no ages
transcript.empty | replyToOld | image
transcript.edited                        appended to a line whose message carries an edit stamp (`editedAt`); no old text is shown
transcript.deleted                       {author}: the whole body of a placeholder line for a message deleted since; the line already starts with `#N [time] Author:`; no text of the message is ever shown. At most `context.deletedLinesMax` (default 10, `0` = none) per window
transcript.untagged                      {names}: appended (after `edited`) to a line of the persona's whose text holds a whole `@name` (any case, not inside a URL) of a member of `<directory>` or an author in view who has a handle in this request, when that member is not among the line's real mentions; {names} the `@name`s as she wrote them, joined by ", ". Only with features.mentionHandles on; shown for as long as the line is shown. Missing or blank: no mark
transcript.channel                       {name} {handle}: a channel a `<chat>`, `<channel_view>` or `<other_channels>` line mentions (its `<#id>` mention, which the text reads as `#name`) with features.mentionHandles on and the channel in `<channel_directory>`; {name} is `#` + the channel's name, {handle} the exact channel token, `#` included. Missing or blank: the text as it came
transcript.author                        {name} {handle}: the author of a `<chat>`, `<channel_view>` or `<other_channels>` line (not the persona, not a bot) with features.mentionHandles on; {handle} is the exact mention token, `@` included. Missing or blank: the bare name
transcript.triggeredBy                   {n}: after the persona's name on her line, the number of the message that started the turn which posted it (features.triggerMarkers); blanked: no marker
transcript.triggeredByOlder              the same when that message is not in the block; blanked: no marker
transcript.called                        {skill} {target} {args} {status} {posted}: a skill call of the persona's on her line, or as a line of its own (features.callMarkers); blanked: no call marks
transcript.calledTargetMessage           {n}: the {target} of a call whose target message is in the block
transcript.calledTargetLink              {link}: the {target} of a call whose target message is not in the block (its Discord link)
transcript.calledTargetChannel           {channel}: the {target} of a call without a known message: the target channel's name
transcript.calledPosted                  {link}: the {posted} of a call that posted a message (its Discord link); empty otherwise
transcript.callStatus.ok | denied | invalid | not_configured | unknown | partial | failed   the {status} words; a failed or unknown call never reads as done
transcript.callStatusReason              OPTIONAL {status} {reason}: the {status} of a call that did not work, with why; blanked: the status word alone
transcript.callReasons.missing-arg | unknown-arg | wrong-arg | too-long | too-short | arg-twice | unknown-channel | unknown-role   {arg}: why a call's arguments were not right, naming the argument
transcript.callReasons.message-elsewhere | member-ambiguous   why a call was not right: the message is in another channel than the one named; several members go by the name
transcript.callReasons.unknown-message | not-own-message   {arg}: the message the option named is not in view; is not hers
transcript.callReasons.message-deleted   the message was deleted by its author or a moderator, not missing from the window
transcript.callReasons.channel-no-permission      {channel}: the channel the bot has no permission in for this call
transcript.callReasons.file-elsewhere              {channel}: the file from an errand tried to post in a channel the requester did not name
transcript.callReasons.unknown-gif       the handle is not in the GIF library; nothing is posted, she may call again without `gif=`
transcript.callReasons.gif-cap           the daily GIF limit is spent; nothing is posted, she may call again without `gif=`. Any kind without its phrase here falls back to tools.result.reasons[code], then .other
transcript.postedFrom                    {channel}: after the persona's name on a line a call from another channel's turn posted; blanked: no marker
transcript.replyTo                       {index} {author} {quote}: the parent message's number, its author (the self label when the parent is the persona's own) and a quote of the parent's text, cut at a word boundary to `context.replyQuoteChars` (default 80; `0` = whole); a parent with only media quotes its media labels
transcript.replyToMemory                 {author} {quote}: appended to a line in a memory batch transcript; names the parent's author (the self label when the parent is the persona's own) and quotes its text. No `{index}`. A parent outside the batch renders `replyToOld`
transcript.file | sticker                {name}
transcript.stickerDescribed              {name} {text}
transcript.emojiDescribed                {name} {text}: inline tag for a described custom emoji, appended to the chat line. Used only when the `<emoji>` block is absent or `labels.emoji.seenInChat` is not set; with `seenInChat` the line keeps a bare `:name:` and the description moves to the block
transcript.imageDescribed                {text}
transcript.gif                           {name}
transcript.gifDescribed                  {text}
transcript.gifKnown                      {id} {text}: a GIF that is in the library; id is its handle, text is the caption
transcript.gifKnownFields                {id} {reaction} {action} {screen}: a library GIF whose cache has a reaction or on-screen text, used in place of gifKnown; fields cut by gifs.reactionChars / gifs.actionChars as in gifs.entryFields; code drops empty fields and their separators; blanked: falls back to gifKnown
transcript.gifKnownNoText                {id} {name}: a library GIF without a caption; id is the handle, name is the file or link name
transcript.video                         {name} {duration}
transcript.videoDescribed                {name} {duration} {text}: text describes ONE frame
transcript.videoWatched                  {name} {duration} {text}: first-hand, the persona saw and heard the clip
transcript.videoWatchedPart              {name} {duration} {watched} {reason} {text}: first-hand but only the start of a longer clip; {watched} is the watched length (e.g. 5:00), {duration} the total; {reason} is the human phrase from videoPartReason.*
transcript.videoNotWatched               {name} {duration} {reason}: reason is the human phrase from videoReason.*
transcript.videoNotWatchedFrame          {name} {duration} {reason} {text}: not watched but a still frame was described
transcript.videoAnswered                {question} {text}: extra tag after a watched video tag or a GIF's tag; the persona looked more closely at the clip for this question
transcript.imageAnswered                {question} {text}: extra tag under the picture's line; the persona looked more closely at the picture for this question
transcript.videoReason.length | size | daily | error | pending    human phrases for the five reason codes; pending = the clip was still loading when the request went out
transcript.videoPartReason.clip          human phrase for the clip length limit reason (only the start of a longer video was watched)
transcript.linkWatched                   {text}: extra tag after a link tag, first-hand video summary
transcript.linkWatchedPart               {duration} {watched} {reason} {text}: extra tag after a link tag, first-hand but only the start of a longer video; {duration} is the total length, {watched} the watched length, {reason} the human phrase from videoPartReason.*
transcript.linkNotWatched                {reason}: extra tag after a link tag, not watched with reason
transcript.linkNotWatchedFrame           {reason} {text}: extra tag after a link tag, not watched but preview described
transcript.voice                         {duration}
transcript.audio                         {name} {duration}
transcript.link                          {site} {title}
transcript.linkText                      {site} {title} {text}
transcript.linkRead                      {text}: extra tag after a link tag; the opening of the page's own text (with `features.coreTools`) or the analyzer's condensed excerpt (without), first-hand
transcript.thumbnailDescribed            {text}: follows a link tag; describes the link's preview picture
transcript.filePreview                   {name} {text}
transcript.forwarded                     {text}
transcript.forwardedFrom                 {channel} {text}: used when the source channel is known; falls back to `forwarded`
transcript.reactions                     OPTIONAL {list}: appended at the end of a line after all media and forwarded tags; list is items joined with reactionSeparator. A labels file without this key renders nothing
transcript.reactionItem                  {emoji} {count}: one reaction; emoji is unicode or :name: for custom
transcript.reactionMine                  {emoji} {count}: used instead of reactionItem when the persona is among the reactors; reads correctly whether count is 1 or more
transcript.reactionNames                 OPTIONAL {emoji} {names} {count}: one reaction on the persona's own line with its known reactors named (features.reactionNames); names are author-form names joined with ", ", the persona last in her labels.self form when she reacted too, plus reactionMore. Without it: counts
transcript.reactionSeparator             OPTIONAL: placed between two reactions of one line, counts and names alike (" · "); names inside one reaction stay joined with ", ". Missing: ", "
transcript.reactionMore                  OPTIONAL {n}: after the names, the members who reacted and are not named (past context.reactions.maxNames, or not known). Blank: nothing
transcript.unknownDuration               shown in place of {duration} when Discord gave none
senses.imageDescribed | imageBlind       one line; code picks the one true under the live config (features.mediaDescriptions). No first-hand line exists: the persona never sees a picture herself
senses.gifWatched | gifDescribed | gifBlind   gifWatched replaces gifDescribed when media.gif.watch is on (needs video vision on and a describe-gif or describe-video prompt); a labels file without gifWatched falls back to gifDescribed. Both say GIF descriptions come from a model role (second-hand); without a description the persona does not infer the content
senses.videoDescribed | videoBlind
senses.videoWatch                        replaces videoDescribed when features.videoDescriptions is on (needs mediaDescriptions too); covers watched, still frame and not-watched states
senses.videoRewatch                      shown alongside videoWatch when features.videoRewatch is on; tells the persona that a second look at a watched video may appear, marked as first-hand
senses.stickerDescribed | stickerBlind
senses.lottie
senses.customEmoji                       shown when features.customEmoji is on and the server has at least one custom emoji; tells the persona they can use server custom emoji by writing :name:
senses.gifs                              shown when features.gifs is on and the library is not empty; tells the persona they can post one GIF per turn by handle from the list or transcript; entries give the reaction, visible action and on-screen text; recent-use marks show own posts; only listed or transcript handles; unknown handle posts nothing
senses.voice | links | files
senses.linksWatch                        replaces links when features.videoDescriptions is on; adds that a linked video may come watched or not watched with the reason
senses.linksTool                         with `features.coreTools` and `features.webLookup` on and `web.read` granted to her, in place of `senses.links`: the same line, but a link may show the opening of the page as a preview and she can read the whole page with `web.read` (no "cannot open the page" sentence). Without the label `senses.links` shows
senses.linksWatchTool                    the same for `senses.linksWatch` (`features.videoDescriptions` on)
senses.linksRead                         shown after the links line when features.webLookup is on and web.links.enabled is not false; tells the persona that a link's preview is the opening of the page's own text, first-hand, not the whole page
senses.search                            shown when features.webLookup is on, web.search.enabled is not false AND a Brave Search key is configured; tells the persona that a `<lookup>` block may appear with web results and that no search can happen during the reply itself
senses.recall                            shown right after the search line when the server-history search is available: on every server turn, and in a private chat when `features.privateLikeServer` is on (the default). Tells the persona that a search of the server's old messages either ran before the reply or did not, that its part of `<lookup>` is what the history holds (the analyzer's summary or a verbatim stretch), and that without it nothing was looked up there. An older labels file without the key renders nothing
senses.searchTool                        with `features.coreTools` on, in place of `senses.search` (same conditions) and only when `web.search` is granted to her: nothing is searched before her reply; she calls `web.search` herself and its result comes back as raw search results (title, link, snippet, site), the pages not opened. Without the label nothing is shown
senses.readTool                          with `features.coreTools` on, features.webLookup on and `web.read` granted to her, after the links lines: she can open a page herself with `web.read` (its link, or a message `#N` holding one); the page's own text comes back in its tool result, cut, not a summary. Without the label nothing is shown
senses.lookTool                          with `features.coreTools` on and `media.look` granted to her, while the image second look (`features.imageRelook`) or video vision is on, in place of `senses.videoRewatch`: she can look more closely at a picture, GIF or video of a message `#N` with `media.look` and her question; the closer look comes back in its tool result. Without the label nothing is shown
senses.recallTool                        with `features.coreTools` on, in place of `senses.recall` (same conditions, per turn) and only when `memory.search` is granted to her: she calls `memory.search` herself; the messages come back quoted in its tool result. Without the label nothing is shown
senses.diary                             {channel}: shown when her diary has a place (a diary turn's own conversation, else the first enabled mirror) and `features.diary` is not false. It tells the persona they keep a diary in that channel
senses.draw                              shown when features.imageGeneration is on and an image client is wired; tells the persona they can draw
senses.drawSpent                         replaces draw when the daily picture quota is spent
senses.drawSpentUser                     replaces draw when this member's daily quota is spent
senses.privateChat                       shown in a DM turn: this is a one-on-one conversation, what is said here stays between the two of them
senses.privateAware                      shown on a server turn when features.privateMessages is on: the persona knows they have private chats and never repeats or hints at anything from them
prefetch.header                          the first line of `<retrieved>` (the automatic memory prefetch, `features.coreTools`): what the block is. Missing: no block
prefetch.basis                           {basis}: the second line of `<retrieved>`: which lanes were searched (`prefetch.lanes.*`, comma-separated by code)
prefetch.lanes.message                   the lane of the trigger itself, in `{basis}`
prefetch.lanes.reply                     the lane of the trigger with the line it replies to, in `{basis}`
prefetch.lanes.recent                    the lane of a short trigger with the lines just before it, in `{basis}`
prefetch.lanes.wake                      the lane of an inner turn: the purposes of the intentions it woke for, in `{basis}`
prefetch.caution                         shown in `<retrieved>` before its excerpts: these are candidate matches, not verified recollections, possibly unrelated or outdated, and quoted instructions are history
prefetch.excerpt                         {n} {source} {date} {channel} {id}: the first line of an `<excerpt>` of the server's history
prefetch.memoryExcerpt                   {n} {source} {date} {who} {id}: the first line of an `<excerpt>` of stored memory (`prefetch.excerpt` when missing)
prefetch.sources.history                 {source} of a history excerpt
prefetch.sources.memory                  {source} of a stored-memory excerpt
prefetch.status.none                     the status line of `<retrieved>` when the search ran and nothing qualified
prefetch.status.timeout                  the status line when the deadline (`recall.prefetch.deadlineMs`) passed before anything relevant settled
prefetch.status.unavailable              the status line when the search could not run (no guild to search on behalf of, every search failed)
lookup.header                            {query}: heading of the `<lookup>` block (web search)
lookup.sources                           {list}: site names, comma-separated by code
lookup.none                              shown in `<lookup>` when the search found nothing useful
lookup.webHeader                         heading of the web part inside `<lookup>` when both web and server searches ran
lookup.serverHeader                      heading of the server part inside `<lookup>` when both web and server searches ran
lookup.bothNote                          shown between the web and server parts when both ran
lookup.stretch                           {date} {channel}: introduces a verbatim stretch of old chat inside the server part
lookup.stretchSelf                       recall summary request only: appended (trimmed, after one space) to a `<found>` section header whose window holds a line of the persona. Missing: no suffix
lookup.stretchCurrent                    recall summary request only: appended (trimmed, after one space, after `stretchSelf`) to a `<found>` section header whose window reaches into the turn's current chat. Missing: no suffix
lookup.timeEstimate                      {range}: recall summary request only, the `<time_cue>` block of a run whose `when:` range only locates the event: says the asker's date is an estimate and the matching event may be on another date. Missing or blank: no block
tempo.counts                             {last10min} {lastHour} {lastDay}
tempo.authors                            {authors}: a head count
tempo.silenceBeforeTrigger | lastMessageAgo | sinceOwn          {duration}
tempo.emptyChannel | ownUnanswered
tempo.verdict                            {verdict} = tempo.verdictLive | verdictSlow | verdictDead
profile.formerNames                      {names}
profile.character | interests | style | details | relationship  {text}
profile.aliases                          {text}: what people in chat call this member (comma-separated by code)
profile.addressed                        {text}: names people use for this member, most used first, counted by code (comma-separated)
profile.realName                         {text}: the member's own real name, when one is stored
profile.interestItem                     {topic} {note}: one interest with a note
profile.interestItemNoNote               {topic}
profile.unsureMark                       appended to an unconfirmed interest or detail (starts with a space, self-explanatory)
profile.staleMark                        appended to an interest not seen for memory.interestStaleDays (starts with a space)
profile.unknown
profile.episodes                         heading line above the caller's episodes
profile.episode                          {date} {what} {quote} {feeling}: one remembered moment
profile.episodeNoQuote                   {date} {what} {feeling}: the same without a quote
profile.before                           {text}: a closed claim, appended once (after a space) to the interest, detail or alias that superseded it while that one's recordedAt is younger than memory.supersededShownDays (default 7); never shown alone. Missing = not shown
profile.avatar                           {text}: the stored description of the member's current avatar (features.avatars); missing = no line
profile.avatarDefault                    the member shows Discord's default avatar (features.avatars); missing = no line
profile.conflict                         {a} {b} {dateA} {dateB}: two open claims sharing a conflictSetId, rendered together once, the earlier first; a date is validFrom, else the day of recordedAt, else of firstSeen. Missing = both render as separate items
lore.entry                               {title} {text}
emoji.header                             introduces the custom emoji list
emoji.entry                              {name} {text}: one emoji with a caption
emoji.entryNoText                        {name}: one emoji without a caption
emoji.seenInChat                         sub-heading before the described custom emoji that appeared in the transcript but are not in the top list; without it the inline `transcript.emojiDescribed` tag stays
gifs.header                              introduces the GIF library list: per entry, the reply it expresses, visible action, on-screen text
gifs.entry                               {id} {text}: one GIF with a single-line caption (entries without three-field descriptions)
gifs.entryFields                         {id} {reaction} {action} {text}: one GIF with three-field caption; code drops empty fields and their separators
gifs.entryNoText                         {id}: one GIF without a caption
gifs.ownMark                             {ago}: after the handle of a GIF the persona posted within gifs.ownMarkHours, in the reply's and the GIF picker's <gifs_recent>
gifs.ownMarkRecent                       unused since <gifs_recent> carries the persona's posts (kept for older layers)
affinity.bands.hostile | dislike | cool | neutral | warm | fond | devoted
                                         thresholds in code: ≤-60 · ≤-25 · ≤-8 · <8 · <25 · <60 · ≥60
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
server.diary                             shown on every place of her diary (its enabled mirrors) in the `<server>` map. The persona's diary
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
pull.seenBefore                          {ago} {fresh} {older}: shown under the header when a previous view of this channel in the same destination exists within `context.pull.seenTtlMinutes` and at least one message is new or changed since. {fresh} = messages not in the previous view or whose content changed (compared by id and hash; an edited message counts as new); {older} = how many of those {fresh} are older than the earliest line in the previous view. Without it no seen line is shown
pull.seenSame                            {ago}: shown under the header when the previous view exists but every kept message was already shown and none changed. Without it no seen line is shown
elsewhere.called                         {channel} {destination}: appended to the reply task text on a turn answering a call from a read-only channel
elsewhere.link                           {text} {link}: joins the jump link to the persona's posted message; members read it, the model never sees it
triggers.mention | reply | name | followUp | overheard   followUp = an untagged message the address classifier judged to be for the persona; overheard = talk about the persona, not to them. Both post plain, never as a Discord reply. overheard falls back to followUp, then reply
triggers.private                         the trigger for a private (DM) message
triggers.missed                          the trigger for a missed-answer recovery turn (features.missedRecovery)
triggers.errand                            the trigger for the turn a finished errand opens (its `<errand_result>` turn)
draw.when                                {when}: the local date and time shown to the image model so the light and season match. Filled for every picture (diary or not) when the time is known; empty otherwise
videoAudio.none                          appended to the video model's system prompt when the file was measured to have no audible sound (no audio stream or silent throughout). Says it is a measurement, not a guess. No placeholders
videoAudio.map                           {spans}: appended to the video model's system prompt when the file was measured to be mostly silent. {spans} is a comma-separated list of audible stretches (e.g. `0:12-0:13, 1:05-1:20`), formatted by code from the measured audio levels. Says sound is audible only during those stretches
diary.intro                              first line of the `<diary>` block
diary.line                               {date} {kind} {gist}: one past post
diary.picture                            {scene}: appended to a diary line when the post had a picture
diary.pictureUnknown                     placeholder scene when a backfilled post had a picture but the scene was not recorded
diary.pictureSet                         {count} {scene}: appended in place of `diary.picture` when the post was a set of more than one picture (`scene` is the first picture's)
diary.kindUnknown                        placeholder kind for a backfilled post with no recorded kind
diary.kinds                              first line of the `<kinds>` block
diary.kindLine                           {key} {weight} {count} {window}: one kind with its weight and use count
diary.plan                               first line of the `<plan>` block
diary.found                              first line of the `<found>` block
diary.seeds                              first line of the `<seeds>` block
diary.topic                              first line of the `<topic>` block (the owner's topic for a forced post)
memory.privateChannel                    heading used in place of a channel name for a private conversation in a memory batch
memory.redaction                         the neutral token that replaces a forgotten member's mention inside a diary post (one word)
limits.notice                            {limit} {used} {cap}: posted as a plain reply when a rail refuses a triggered action; limit is the config key, used/cap are the numbers
limits.paused                            posted as a plain reply when the persona is called while paused (`features.pauseNotice`). No placeholders. At most once per channel per `mention.pauseNoticeMinutes`
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
participation.earlierHeader              the `<earlier>` block's first line. Without it there is no `<earlier>` block
participation.earlierGap                 the line between two anchors in `<earlier>`. Without it the anchors follow each other directly
participation.earlierOpen                appended to a line of `<earlier>` that is a request to the persona she has not answered. Without it the line is not marked (it still ranks first)
task.part                                {index} {total} {part} {others}: this turn answers one part of a split message. {index} is 1-based, {part} is the text of this part, {others} lists the remaining parts and any queued calls as numbered items joined by `; `. Without this key the splitter is off even when the prompt file exists
task.queued                              {others}: the trigger author has other calls waiting, listed as numbered items joined by `; `. Shown only when there is no `task.part` for this turn. Without this key the waiting calls are not named and the seen-in-history drop rule applies to them
task.queuedOthers                        {others}: other members have calls waiting in this channel, listed as `<n>. <author>: <text>` items joined by `; `. Without this key those calls are not named
task.added                               {added}: later messages from the author were folded into this call while it waited, joined by `; `. Without this key the folded messages are not named
task.missed                              {missed}: on a recovery turn (trigger kind `missed`, `features.missedRecovery`), the earlier messages that got no answer, listed as `<n>. <author>: <text>` items joined by `; `. Appended before `task.part`. Without this key the messages are not named
task.failedEarlier                       {author} {n} {ago} {code}: an addressed turn in this channel that ended `error` with nothing posted (`context.failedTurnsKept`, 24 h, process memory only). {n} is the message's `#n` in the transcript when it is in view, else its Discord link. One line per failure, appended after the task text; cleared once shown. Without this key the failures are not named
task.diagnostics                         OPTIONAL: the line that opens what the parser did with her last answer, added to the task of a loop step before one `- ` line per diagnostic (`tools.diagnostics.<kind>`); told once
task.step.held                           the note's first line when her speech of the previous answer was held (not sent): says so, without repeating her text
task.step.delta                          the lead of the lines that came in since her last answer, numbered past the request's own lines
task.step.late                           the lead of the lines whose video or captions were not ready in the first request and are now, re-rendered under their original numbers, told once
task.step.last                           the notice that this request is the last one: a call in it will not run
task.step.lastInner                      the same for an inner turn, whose last request still runs one terminal call (a post or an intention change)
task.step.delivery                       {n} {total} {code}: some of the messages of her speech did not go out ({code} the first failure)
task.continueInnerOpen                   {list}: the open-intentions line of the note after a post (task.step): the intentions the turn woke for that no `intention.*` call of the turn has named yet, as `<id>: <purpose>` joined by `; `. Without it the line is left out
journal.offLead                          lead line before the persona's recent downtime periods in `<now>`
journal.offPaused                        {from} {to} {length}: one period when the owner paused the persona
journal.offStopped                       {from} {to} {length}: one period when the service was off
tools.line                              {name} {title} {whenToUse} {access} {args}: one skill in the `<skills>` list. {access} is one of tools.access.*; {args} is tools.args.list, or empty when the skill takes no arguments
tools.args.list                         {list}: the arguments of one skill, filling {args} of tools.line (put any leading space or punctuation here, since {args} is empty for a skill without arguments). {list} is the arguments joined by ", ", in the order of the command's options; without this label no arguments are shown
tools.args.required                     {arg}: wraps an argument the call must give
tools.args.values                       {arg} {values}: an argument with a fixed set of values (a choice or a boolean); {values} joined by "|", at most 8, then "…" when there are more
tools.args.range                        {arg} {min} {max}: a numeric argument with bounds; a bound the command leaves open is empty
tools.access.allowed | carried-over | not-allowed | safe-mode | requester-denied    short access phrase for the five states: allowed; allowed through the reply; not switched on; safe mode; not for this person
tools.proposedOff                       {names}: shown at the end of a proposals-only `<skills>` block, naming the proposed skills that are not allowed, except those the asker has no right to
tools.proposedDenied                    {names}: shown after tools.proposedOff in a proposals-only `<skills>` block, naming the proposed skills the persona has but the person who asked has no right to (`requester-denied`). Without this label those skills are not named
errands.header | line                      the `<errands>` block: its first line, then {id} {agent} {state} {error} {age} {goal} per task
errands.unread | unreadMore | resultTurnFailed   the marker of an unread result, {count} of those left out by errands.unreadShown, the note that its result turn never ran
errands.states.queued | running | done | failed | cancelled | expired   the {state} words of `<errands>` and `<errand_result>`
errands.result.header                      {id} {agent} {state} {goal}: the first line of `<errand_result>`
errands.result.text | empty | error        the lead of the result text, the line for none, {error} the code of a task that did not end done
errands.result.sources | files | file      the leads of the numbered sources and of the files; file is {handle} {contentType} {bytes}
errands.result.withheld                    {paths}: shown when the engine's scope policy withheld paths from the agent; paths is a comma-separated list filled by code
errands.result.held                        {names}: shown when the runner held back result files (a secret inside, or read from a withheld path); names is a comma-separated list filled by code, with no handle
intentions.header | line                 the lead of `<intentions>`; line is {id} {state} {purpose}
intentions.states.pending | waiting      the {state} words of `<intentions>`
intentions.due | waiting | outcome       {when}; {errand} {deadline}; {errand} {state}: the parts after an intention's line
intentions.noDue                         {expires}: the due slot of a pending intention with no due time and no attention (nothing will wake her for it): its expiry
intentions.expiresSoon                   {when}: the last part of a line whose expiry is within `intentions.expiryNoticeDays`; not on a line with `noDue`
intentions.every                         {period}: the repeat period (day, week, 12h, 3d)
intentions.notes.wait-deadline | errand-missing   {errand}: how a wait ended without its errand's outcome
intentions.notes.last-occurrence         a recurring intention whose next occurrence would pass its expiry
intentions.destination                   {channel}: where the intention is meant to land
intentions.attend                        {place} {wakes} {perDay} {settle}: an attention's part: the place's name (its address when unknown), the day's attend wakes against her bound, the quiet seconds before a wake
intentions.attendPeople                  {people}: the people whose lines count, by name (the id when unknown), after `intentions.attend` when the attention names any
intentions.candidates | candidate        the lead of the proposed candidates; candidate is {id} {purpose} {span} {marker}
intentions.externalMarker                {marker} of an external candidate's line (empty for her own)
wake.header                              the first line of `<wake>` (an inner turn); without it no `<wake>` block
wake.kinds.intention_due | errand_deadline | review | attend | feedback | heartbeat   {id} {purpose} {errand} {due} {place} {lines} {people} {since}: one wake's line (the last four filled on an attend line only; all empty on a feedback line, which says the lines after it are about her previous turn)
wake.delayed                             {minutes} {code}: shown after a wake's kind line when the wake was retried after a failed inner turn ([Inner life](inner-life.md#when-a-provider-call-fails)). {minutes} is minutes since it was originally due, {code} is `provider-limit`, `provider-error` or `timeout`. Without it the line is left out
wake.feedbackInTurn                      the line that opens the facts kept for her and not told yet, under `<wake>` of an inner turn and as the whole `<wake>` of an addressed turn (in the tail before `<task>`); without it, or without `wake.feedbackItem`, they are left out and stay kept
wake.feedbackItem                        {fact}: one fact under the feedback line or under `wake.feedbackInTurn`; without it the facts are left out
wake.feedback.callFailed                 {skill} {status} {code} {text}: a call whose status was not ok (failed, partial, invalid, denied, not_configured, refused, unknown, timeout), with its code and the operation's own text (cut to `tools.markTextMaxChars`)
wake.feedback.doneWithoutDelivery        {id} {purpose}: an intention she closed as done in that turn while no post, picture, errand or diary entry went through
wake.feedback.loopCut                    {cut} {dropped} {steps}: the loop ended on its steps or time bound (`cut`: steps, time, no-continuation) or the calls past the per-step bound had no step to be told in (`extra-call`), with that many calls dropped, after that many steps
wake.feedback.wakeDropped                {kind} {code} {why} {id} {purpose}: a wake of hers that ended without a turn (`code`: stopped, overflow, stale, superseded, no-channel, error, provider), with the intention; `why` is `wake.feedback.codes.<sub-code>` (stale: done, cancelled, expired, forgotten; no-channel: dm-off, not-writable, unavailable, no-review-channel) or the turn's error code
wake.feedback.wakeDroppedKind            {kind} {code} {why}: the same for a wake with no intention (a review, a feedback wake)
wake.feedback.wakeHeld                   {kind} {code} {id} {purpose} {until}: a wake held on a cap (`per-chain`, `attend-per-day`), and when it can run (the local midnight, date and clock in `bot.timezone`)
wake.feedback.turnFailed                 {code} {kind}: the turn ended error or refused (`code`: its error code), for the wake of that kind
wake.feedback.sendFailed                 {code} {n} {total}: a message of an addressed turn did not go out; n of total went out
wake.feedback.sendUnknown                OPTIONAL {code} {n} {total}: the same for a send whose answer never came and whose message her next turn did not find among her own lines (it may have gone out); without it `sendFailed` is used
wake.feedback.stateLost                  {code}: the inner state file could not be read (the file is kept aside) and she started empty
wake.feedback.memoryFailed              {code} {n}: a memory batch could not be applied (`code`: `apply-error`); `n` lines wait for a new try. One fact per failing batch, told again only after that batch was applied or dropped; a member's private batch is told only in that private chat
wake.feedback.interrupted                {kind} {done}: an inner turn that a restart cut off, after it did what `done` lists (the posts reconciled as sent and the calls that ran, joined by `, `); the wake is handled and not run again
wake.feedback.diagnostic                 not a label: a kept parser diagnostic is worded by `tools.diagnostics.<kind>` (`diagnostic` on the fact names the kind)
wake.feedback.codes.<sub-code>           the words for the sub-codes above, in `{why}`
wake.here                                {channel} {why}: the current channel (`#name`) and why it was chosen (one of `destination`, `asked`, `attend`, `errand`, `feedback`). Without it the line is left out
wake.hereNone                            shown when no current channel exists this wake (a review or a wake with no place); posting needs `message.create` with a channel. Without it the line is left out
wake.now | channels                      {now} {timezone}; {channels}: the moment, and the channels she was last active in (a review)
wake.expired | expiredItem               the lead of a review's expired intentions; expiredItem is {id} {purpose} {when}: one of hers that expired untouched and was not told yet (never a candidate); without both no list
wake.expiredMore                         {more}: how many expired ones follow the list; left out when none
previousThink.note | same | earlier   the `<previous_think>` block: the note (what the think is and how to use it), and the metadata line of a step's own turn (`same`) or of an earlier turn (`earlier`, `{ago}`); without the note or the line of its relation no block
transcript.calledArgs                    {args}: the call's main arguments on a call mark, placed where `transcript.called` has `{args}`; blank or no `{args}` there shows none
wake.places | place                      {total}; {name} {lines} {people} {flags}: the lead of the places page and one place of it (in `<wake>`, and alone in `<places>`); without `places` no page
wake.placeReadOnly | placeAttended       the {flags} of a place she cannot write in, and of one she attends (joined when both)
wake.placesMore                          {more}: how many places follow the page; left out when none
wake.heartbeat.*                         the words of a heartbeat's facts, keys as listed under `<wake>`; without `wake.heartbeat` the heartbeat's wake line stands alone
wake.budgets                             the lead of the budget lines
wake.budget.chain                        {left} {cap} {reset}: what is left of one cap and when it resets
directory.lead                           OPTIONAL: the first line of `<directory>`, before the member lines
directory.line                           {handle} {names}: one member of `<directory>`; {handle} is the exact mention token, `@` included; {names} their stored names as JSON strings joined by ", ". Without this label no `<directory>` block
directory.lineAliases                    {handle} {names} {aliases}: the same for a member with open aliases ({aliases} like {names}). Missing or blank: `directory.line`
channelDirectory.lead                    OPTIONAL: the first line of `<channel_directory>`, before the channel lines
channelDirectory.line                    {handle} {name}: one channel of `<channel_directory>`; {handle} is the exact channel token, `#` included; {name} the channel's name as a JSON string. Without this label no `<channel_directory>` block
channelDirectory.lineCategory            {handle} {name} {category}: the same for a channel inside a category ({category} its name, like {name}). Missing or blank: `channelDirectory.line`
tools.result.ok                         the status line for a reading call that returned data. Body follows on the next line
tools.result.untaggedNote               {name} {handle}: after the result of a `message.create` / `message.edit` that went out, once for each `@name` in its text that named a member of the request without tagging them (`{name}` as written with its `@`, `{handle}` the exact token without the `@`). Only with features.mentionHandles on; the status stays ok. Missing or blank: no note
tools.result.coerced                    {arg} {value}: told ahead of a call's result when an argument she wrote as text was read as the schema says (`"true"` as true, `"5"` as 5)
tools.toolsText.lead | protocol         the text transport's `<tools>` block: the lead before the JSON lines and the protocol after them (how to write a call, where results come back)
tools.result.refused                    {reason}: the engine refused the call before it ran (the old word; `denied` is the current status)
tools.result.denied                     {reason}: a rights check refused the call
tools.result.invalid                    {reason}: the call's arguments were wrong
tools.result.not_configured             {reason}: what the call needs is not set up
tools.result.partial                    {reason}: the call partly worked
tools.result.failed                     {reason}: the call ran and did not succeed
tools.result.unknown                    {reason}: it is uncertain whether the call went through; the model should not retry
peopleNow.lead                           the line that opens `<people_now>`
peopleNow.stale                          a notice under the lead when the gateway connection dropped since the last update
peopleNow.unavailable                    a notice under the lead when the presences intent is off: no activity can be seen
peopleNow.heading                        {who}: an entry's heading line; {who} is the handle and the name
peopleNow.headingMarked                  {who} {mark}: the caller's heading line with its tag
peopleNow.marks.interlocutor | overheard the caller's tag: the one talking to the persona, or (an `overheard` turn) overheard
peopleNow.field                          {field} {value}: one field line of an entry
peopleNow.fields.voice | activity | attitude | moves | messages    the field names
peopleNow.values.yes | no | none | unavailable | stale    the field words; `no`/`none` only where the data can tell
peopleNow.voiceYes                       {channel} {joined} {muted} {deafened} {streaming} {camera}: the voice field of a member in a voice channel
peopleNow.joinedAgo                      {ago}: {joined} when the join was seen (starts with its separator); empty otherwise
peopleNow.activity.playing | streaming | listening | watching | competing | other    {name}: an activity by its type
peopleNow.activityDetails                {activity} {details}: an activity with its details and state
peopleNow.activityTrack                  {activity} {track} {artist}: a Spotify activity with its track and artist
peopleNow.attitude                       {score} {band} {reason}: the attitude field's value
peopleNow.move                           {delta} {date} {reason}: one attitude move from the history
tools.result.reasons.not-allowed | safe-mode | owner-only | skills-off | feature-off | not-granted | not-grantable | unknown-principal | no-requester | mixed-requesters | requester-denied | self-grant | not-self-owned | not-requester | inner-stopped | cooldown | no-budget | daily-cap | channel-no-permission | channel-not-visible | cap-open | cap-tasks | heartbeat-only | heartbeat-cap | heartbeat-recurring-cap | paused | candidate-external | candidate-same-turn | candidate-same-chain | invalid-args | unknown-skill | target-ambiguous | unknown-command | unknown-op | unknown-message | message-deleted | not-own-message | no-own-message | unknown-member | unknown-file | unknown-gif | unknown-agent | unknown-conversation | file-expired | file-elsewhere | agent-required | target-required | destination-required | not-found | not-open | bad-goal | bad-sort | bad-page | bad-time | bad-every | bad-attend | bad-deadline | bad-due | bad-expiry | bad-move | bad-provenance | attend-with-due | attend-with-every | every-without-due | due-after-expiry | not-attend | not-recurring | no-next | no-purpose | reason-required | no-errand | errand-ended | wait-without-errand | terminal | duplicate-id | invalid-action | invalid-emoji | empty-query | no-query | no-link | no-media | not-video-site | turn-cap | scheme | not-configured | unsupported | no-guild | error | timeout | cap | provider | http | network | private | type | size | redirects | runner-down | write-failed | file-unreadable | attachment-too-large | gif-failed | gif-cap | no-result | send-failed | link-closed | link-busy | adapter-threw | refused | image-cap | image-cap-daily | image-cap-user-daily | image-moderation | image-timeout | image-error | image-empty | unsupported-model | speech-cap-daily | speech-prepare-failed | speech-synth-failed | speech-convert-failed | speech-not-configured | other    human phrases for the reason codes (the generated table below lists every code with its status and values); `no-requester`: a turn with no person behind it (inner, spontaneous); `mixed-requesters`: bundled messages from different people; `no-media`, `turn-cap`: a `media.look` on a message with nothing to look at / past `media.look.maxPerTurn`; `not-video-site`: a `media.look` `url` off `media.video.sites`; `candidate-external` through `candidate-same-chain`: intention accept refusals, src/intentions/model.ts#acceptRefusal; `heartbeat-only`: a call outside the memory inspection allowlist and intention changes in a heartbeat wake (`innerLife.heartbeat.intentionsOnly`), or a second change in one step; `heartbeat-cap`, `heartbeat-recurring-cap`: `intention.set` (or making a one-off recurring) past `innerLife.heartbeat.maxOpen` / `maxRecurring` open intentions from heartbeats (the result names the open ones); `target-required`: a `<react>` without its target line; `destination-required`: a `<msg>`, `<gif>` or `draw.create` call in a turn with no current channel; `no-query`: a `memory.search` that left nothing to search; `no-link` through `redirects`: `web.read` page-fetch outcomes; `channel-not-visible`: a `memory.search` or `conversation.read` naming a channel she may not see; `gif-failed`: a `message.create` whose text went out but whose GIF did not (status `partial`); `empty-query`, `provider` (`{status}`), `cap` (`{what}`): `web.search` failures; `timeout` (`{what}`): any timed-out call; `http` (`{status}`): a page returned an error code; `not-configured` (`{feature}`): what the skill needs is not set up; `bad-goal` through `bad-provenance`: malformed intention or errand arguments; `attend-with-due` through `due-after-expiry`: conflicting intention timing; `not-attend` through `no-next`: wrong intention kind for the operation; `image-cap` through `unsupported-model`: drawing failures; `speech-cap-daily` through `speech-not-configured`: `voice.say` outcomes (`speech-prepare-failed` is `failed`: the pronunciation pass did not finish, so no voice message was sent); `link-closed`, `link-busy`, `adapter-threw`: an effect the chat interface did not take over the link, because the link was closed (`unknown`, the effect may have happened), because 256 requests already waited for an answer (`failed`), or because the interface threw on the request (`unknown`); `other` is reached only for codes outside the catalogue
tools.result.reasons.<code>             one entry per code of src/tools/codes.ts with group `skill` (the table under "Reason codes"); `tools/labels-catalogue.mjs --check` fails when a code lacks its entry or an entry its code. Values a reason may name: `{status}` (`http`, `provider`), `{what}` (`timeout`, `cap`), `{feature}` (`not-configured`)
tools.result.params.what | feature      the words a value of `{what}` (chat, page, search, errand, picture) or `{feature}` (web) is told as; a value without an entry is told as it is
tools.refusals.agentRequired            {arg} {agents}: why a `errand.run` call without `agent` did not run, naming the agents it may pick (comma-separated); on the call's mark ahead of every other phrase
tools.refusals.unknownArg               {arg} {args}: why a call with an argument its skill does not take did not run, naming the arguments the skill takes (comma-separated); on the call's mark ahead of `transcript.callReasons.unknown-arg`. Without it, or for a skill without arguments, that reason is used
tools.diagnostics.retiredTag | messageCut | messagesMerged | thinkUnclosed   one line per parser diagnostic (src/llm/parse.js): {tag} (`retiredTag`: a `<call>` or `<draw>` tag written outside code is cut out and never run), {chars} (`messageCut`, which the parser does not produce), {count} (`messagesMerged`); `thinkUnclosed` has no placeholder. Added to the note of the next request under `task.diagnostics`, once
tools.tools.web.source                  {query}: the first line of a `web.search` result (`features.coreTools`): where it came from (her query) and what kind of evidence it is (raw search results: title, link, site, date, snippet per result; the pages not opened)
tools.tools.web.goal                    {goal}: what she said the search should establish, echoed under the source; left out when she named nothing
tools.tools.web.none                    the search found nothing
tools.tools.web.more                    {count}: the closing line of a `web.search` result when results were left out for room (`web.search.resultsChars`)
tools.tools.read.source                 {url} {maxChars}: the first line of a `web.read` result: where the page is (after redirects) and what kind of evidence it is (the page's own text as extracted, not a summary, at most {maxChars} characters)
tools.tools.read.title                  {title}: the page's title, under the source; left out when it has none
tools.tools.read.cut                    {maxChars}: after the text when the page was longer and was cut
tools.tools.read.none                   the page had no readable text
tools.tools.look.image                  {name} {question}: the first line of a `media.look` result on a picture: a closer look at the picture and what was asked; the answer follows as the model gave it
tools.tools.look.video                  {name} {question}: the same for a video or a GIF
tools.tools.look.notVideoSite           {sites}: the data of a `media.look` `url` refused with `not-video-site`: the configured `media.video.sites`, comma separated
tools.tools.look.off                    {feature}: why a `media.look` was not run: the switch that is off (`features.imageRelook`, `features.videoRewatch` or video vision)
tools.tools.memory.source               the first line of a `memory.search` result: where it came from (this server's message history) and what kind of evidence it is (messages quoted as written, each with its time and author; a sample)
tools.tools.memory.window               {date} {channel}: the heading of one quoted stretch (`YYYY-MM-DD` in `bot.timezone`, the channel's name)
tools.tools.memory.windowCut            {dropped}: after a stretch cut at `recall.quoteWindowChars`; the count of lines left out of this stretch
tools.tools.memory.handles              the line after `.source` when the quoted lines carry handles: each starts with a `#N` that continues the request's numbering (past a gap) and works like any message number in `message.edit`, `message.delete`, `message.create reply=`, `message.create media=` and `media.look`; the numbers live for the turn and its loop steps
tools.tools.memory.windowsLeft          {count} {where}: the closing line when stretches did not fit within `recall.quoteMaxChars`; {count} is how many, {where} names each one's channel and day, comma-joined. Steers her toward narrowing the search (when, channel, people or terms). Nothing left out: no line
tools.tools.memory.degraded             the first line of a `memory.search` result when the search by meaning failed and only words were searched
tools.tools.memory.partial              {failed} {total}: the closing line when some of the searches failed or were cut by the time share
tools.tools.memory.hidden               the closing line of a `memory.search` result (with or without stretches) when the search ran in a channel and the best match for it exists only in a private conversation the channel may not open: no content, no count, no name
tools.tools.memory.none                 nothing matched
tools.tools.describe.closest            {names}: shown when `tools.describe` receives a name that matches no skill and no family; the closest skill names, comma-separated
tools.tools.conversation.source         {channel}: the first line of a `conversation.read` result: where it came from (the channel's `#handle`) and what kind of evidence it is (messages in order, each with its time and author)
tools.tools.conversation.handles        the line after `.source`: each line starts with a `#N` that continues the request's numbering and works like any message number in `message.edit`, `message.delete`, `message.create reply=`, `message.create media=`, `media.look` and `memory.journal.read`
tools.tools.conversation.none           the span held no messages
tools.tools.conversation.cut            {dropped}: after the lines when `recall.quoteMaxChars` kept fewer; the count of lines left out
tools.tools.conversation.earlier        {n}: the paging line when earlier messages exist; {n} is the handle of the first line shown, to use with `before=#N`
tools.tools.conversation.later          {n}: the paging line when later messages exist; {n} is the handle of the last line shown, to use with `after=#N`
tools.tools.find.source                 {query} {count}: the first line of a `media.find` result: where it came from (the persona's own GIF library), how many matched and the query
tools.tools.find.none                   no GIFs matched the query
```

### Reason codes

Every code the engine emits for a call, a send, a turn or a wake is listed in `src/tools/codes.ts`, with the status it
reports under and the values its wording may name. Emitters import their code from there; a test refuses a string
literal in a code position. The call mark in the transcript, the call's result and the kept facts read the same
`tools.result.reasons.<code>` with the same values, so a mark rebuilt from the journal after a restart reads the
same. The table is generated: `node tools/labels-catalogue.mjs --write` rewrites it, `--check` (CI) fails when the
catalogue, the labels and the table disagree.

<!-- codes:begin (generated by tools/labels-catalogue.mjs --write; do not edit by hand) -->
| Code | Status | Values | Wording |
|---|---|---|---|
| `ok` | ok | - | none (success) |
| `shadow` | ok | - | none (internal) |
| `staged` | ok | - | none (internal) |
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
| `inner-stopped` | denied | - | `tools.result.reasons.inner-stopped` |
| `cooldown` | denied | - | `tools.result.reasons.cooldown` |
| `no-budget` | denied | - | `tools.result.reasons.no-budget` |
| `daily-cap` | denied | - | `tools.result.reasons.daily-cap` |
| `channel-no-permission` | denied | - | `tools.result.reasons.channel-no-permission` |
| `channel-not-visible` | denied | - | `tools.result.reasons.channel-not-visible` |
| `cap-open` | denied | - | `tools.result.reasons.cap-open` |
| `cap-tasks` | denied | - | `tools.result.reasons.cap-tasks` |
| `cap-diary` | denied | - | `tools.result.reasons.cap-diary` |
| `heartbeat-only` | denied | - | `tools.result.reasons.heartbeat-only` |
| `heartbeat-cap` | denied | - | `tools.result.reasons.heartbeat-cap` |
| `heartbeat-recurring-cap` | denied | - | `tools.result.reasons.heartbeat-recurring-cap` |
| `paused` | denied | - | `tools.result.reasons.paused` |
| `diary-draw-only` | denied | - | `tools.result.reasons.diary-draw-only` |
| `invalid-args` | invalid | - | `tools.result.reasons.invalid-args` |
| `unknown-skill` | invalid | - | `tools.result.reasons.unknown-skill` |
| `unknown-command` | invalid | - | `tools.result.reasons.unknown-command` |
| `unknown-op` | invalid | - | `tools.result.reasons.unknown-op` |
| `unknown-member` | invalid | - | `tools.result.reasons.unknown-member` |
| `unknown-message` | invalid | - | `tools.result.reasons.unknown-message` |
| `message-deleted` | invalid | - | `tools.result.reasons.message-deleted` |
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
| `write-failed` | failed | - | `tools.result.reasons.write-failed` |
| `file-unreadable` | failed | - | `tools.result.reasons.file-unreadable` |
| `attachment-too-large` | failed | - | `tools.result.reasons.attachment-too-large` |
| `gif-failed` | partial | - | `tools.result.reasons.gif-failed` |
| `gif-cap` | failed | - | `tools.result.reasons.gif-cap` |
| `no-result` | failed | - | `tools.result.reasons.no-result` |
| `send-failed` | failed | - | `tools.result.reasons.send-failed` |
| `diary-mirror` | failed | - | `tools.result.reasons.diary-mirror` |
| `link-closed` | unknown | - | `tools.result.reasons.link-closed` |
| `link-busy` | failed | - | `tools.result.reasons.link-busy` |
| `adapter-threw` | unknown | - | `tools.result.reasons.adapter-threw` |
| `refused` | failed | - | `tools.result.reasons.refused` |
| `image-cap` | failed | - | `tools.result.reasons.image-cap` |
| `image-cap-daily` | failed | - | `tools.result.reasons.image-cap-daily` |
| `image-cap-user-daily` | failed | - | `tools.result.reasons.image-cap-user-daily` |
| `image-moderation` | failed | - | `tools.result.reasons.image-moderation` |
| `image-timeout` | failed | - | `tools.result.reasons.image-timeout` |
| `image-error` | failed | - | `tools.result.reasons.image-error` |
| `image-empty` | failed | - | `tools.result.reasons.image-empty` |
| `unsupported-model` | failed | - | `tools.result.reasons.unsupported-model` |
| `speech-cap-daily` | failed | - | `tools.result.reasons.speech-cap-daily` |
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

## Output

Only these tags are acted on:

- `<think>…</think>` always first, private planning written in English whatever the conversation language; its length follows the moment; an unclosed one means silence.
- `<msg>text</msg>` one chat message, up to 3 in a row; `reply="#87"` makes it a Discord reply. A fourth and any later `<msg>` is not dropped: the parser joins its text unchanged into the third, each on its own line (the third keeps its own `reply`, the joined ones' are lost), and the journal records a `message-merge` limit with the number joined; the parser never cuts a message for its length: a message longer than the interface holds is split by the interface's adapter into several messages that join to her text.
- `<react to="#87">💀</react>` one unicode emoji or one server custom emoji as `:name:`; alone or with `<msg>`.
- `<gif reply="#87">g12</gif>` posts a GIF from the library by handle (body = the handle from the `<gifs>` list or from the transcript, never a URL). One per turn; `reply` optional as on `<msg>`. May stand alone or alongside `<msg>` and `<react>`. Unknown handle = nothing posted.
- A picture is the `draw.create` tool, never a tag: a draw tag written in her text is a retired one, cut out of it, never run and counted as a `retiredTag` diagnostic (as the `<call>` tag below).
- `<call …>` is retired: her calls are tool calls, not text (see "The steps of a turn"). A `<call>` written outside code is cut out, never run, and counted as a `retiredTag` diagnostic.
- `<skip/>` stay silent.
- `@handle` (a handle of `<directory>` or of a transcript author, exactly as shown) becomes a real mention; see [Mention handles](#mention-handles). With `features.mentionHandles` off: `@nick` exactly as in the transcript becomes a real mention. Failing that, a name of any other member of the served guild the bot knows (its member cache: display name, nickname, global name, username; with memory on, the stored names and aliases) becomes one too: matched case-insensitively, longest first and only as a whole name, and only when exactly one member carries it (a name two or more members share stays text; a member the request showed keeps a name it shares in any case). Bots and the persona herself are never mentioned.
- `#handle` (a channel handle of `<channel_directory>`, exactly as listed) becomes a real channel link (`<#id>`); see [Mention handles](#mention-handles). Failing that, `#channel-name` of a server channel in `<msg>` text becomes a real channel link (`<#id>`) when `features.channelLinks` is on (default true, missing = on). An exact full name matches first, longest first. Failing that, a written name matches a channel by its core: leading and trailing emoji, symbols and punctuation stripped, case and accents folded. When exactly one channel has that core, the link is made; when two or more share it, no link is made. An existing link is left alone.
- `#93` (a transcript line number) in `<msg>` text becomes the link to that message, in the address form the interface declares (`capabilities().messageUrl`), when `features.messageLinks` is on (default true, missing = on). A number outside the turn's transcript stays as written; code spans and existing URLs are untouched. In a DM the link uses the form for a private chat. The reverse holds in the transcript under the same switch: a message reference the interface put on a line of `<chat>` (or of one pulled channel's `<channel_view>`, `messageRefs`) to a line of that same block is rendered as that line's `#93`, in the span as written, brackets included (src/format.js#formatTranscript); a link in the text with no reference stays as posted. `<other_channels>` has no numbers and keeps every link.
- `:name:` of a known server custom emoji becomes the real emoji in `<msg>` and `<react>`; an unknown name stays as plain text.

An answer cut off at the output cap (the provider's finish reason `length`, on the reply and on a later step) is never read as silence. Its complete tags are acted on as usual and only an unfinished one is lost. With no complete `<msg>`, `<react>` or `<gif>` and no complete tool call (an unclosed `<think>`, or only untagged text, which would be a fragment), nothing is posted and the turn ends `error` with reason `cut-off`; a later step cut off that way ends the turn so only when nothing of it reached the chat. Logged as `turn: cut off` (`channel`, `completionTokens`, `kept`, `followUp`); the think written so far goes to the journal's turn record.

The parser records a diagnostic for each change it makes to the output: a retired `<call>` or `<draw>` tag cut out (`retiredTag`), messages joined past the three-message limit (`messagesMerged`), or unclosed thinking with finish reason `stop` (`thinkUnclosed`). A call that could not be read (`malformed-call`, `truncated-call`) does not suppress the well-formed calls after it; it gets its own result. In a tool loop the diagnostics appear in the next step's task (under `labels.task.diagnostics`, one `- ` line each from `labels.tools.diagnostics.<kind>`); without a following step they are kept as feedback facts for the persona's next inner turn.

`features.reactions: false` drops `<react>`, `features.multiMessage: false` keeps the first `<msg>`;
`features.gifs: false` or an empty library drops `<gif>`; `features.imageGeneration: false` or no image client refuses `draw.create`. Prompts need not know.

With `format.stripDashes` on (default true; missing = on; only `false` turns it off), every em dash and en dash is removed from `<msg>` texts before posting: the dash and the spaces around it become one space, and every guillemet (`«`, `»`) becomes a plain `"`. A message left empty after stripping is not sent. Hyphens stay. `<react>`, `<gif>` and reply ids are not touched. Logged as `turn: dashes stripped` with `channel` and `count`, never the text.

A `<react to="#n">` targeting a `<channel_view>` line places the reaction in that line's channel when the bot has Add Reactions and Read Message History there; otherwise the reaction is dropped. A `reply="#n"` targeting a pulled line posts plain in the turn's channel (never as a Discord reply to a message in another channel); each pulled line is linked at most once per turn. On a turn answering a call from a read-only channel, the first message carries one jump link: to the pulled line it answers, or to the routed call, or to the newest line of the source shown. The authors of pulled lines carry handles too (with `features.mentionHandles` off, `@name` resolves over them).

A tool call writes a `skill` action to the journal (`src/memory/journal.js#op`). The action goes through phases: `proposed` (the persona asked for the call, before any checks), `started` (the call passed its checks and began executing), then one closing phase: `succeeded` (the effect happened), `failed` (it ran and did not work, with a `code` and, on a skill call, the result's `status`), or `unknown` (the outcome could not be determined). Unclosed `started` lines are reconciled at startup (`journal.reconcile`). Each phase is one `action` line in the journal file; the `opId` ties them together.

### Mention handles

With `features.mentionHandles` on (missing = on) the persona picks whom she mentions; the engine never guesses a person from a name in her output. Every member gets a handle derived from the user id alone: `u` and four base-36 digits of the id's SHA-256 (`src/behavior/handles.js`), so a member keeps the same handle across turns, restarts and requesters with nothing stored, and only code maps it back to the id. Inside one request every handle is unique: on a collision the oldest id (the smallest snowflake) keeps the four digits and the others take one more; the members of `<directory>` are placed first, then the other authors in view (the chat, the pulled channels, the neighbours; a private chat: the chat only; never the persona or a bot), so a passer-by never moves a listed member's handle. The authors in view carry their handle on their lines (`transcript.author`), and a member a line really mentions (the interface's `mentionedUserIds`) reads in its text as their `@handle`, not as the `@DisplayName` Discord's clean text shows (a mentioned member with no handle in the request keeps the name; the text of her post is never changed). A line of hers whose text holds `@name` of a member of the request (a name or an alias, any case, whole, not in a URL) who is not among its mentions ends with `transcript.untagged`, and the result of a `message.create` / `message.edit` with such a text carries `tools.result.untaggedNote` for each; a `<msg>` is covered by the mark on her next turn. Nothing is guessed: the text still tags nobody.

In `<msg>` text and the body of `message.create` / `message.edit` (the reply, its continuation, a dry run, a diary post, a private chat alike) only an exact `@handle` of the request becomes `<@id>`: no letter, digit or underscore right before the `@` or after the handle, case as shown, never inside a URL. The members it mentions are the only ones notified (`allowedMentions`; a member with pings off is mentioned without a notification; `@everyone` and `@here` never ping). A handle-shaped token the request does not hold stays plain text and is logged `turn: unknown handle` (`channel`, `count`); a name after `@` stays plain text. The handles are mapped only from the served guild's stored profiles and the lines of the request, so a mention never reaches outside it. With the switch off: no `<directory>`, no handles on the lines, and `@nick` resolves by name as described under Output.

Channels get handles the same way: `#`, then `c` and four base-36 digits of the channel id's SHA-256 (`src/behavior/handles.js#assignChannelHandles`; on a collision the oldest channel keeps the four digits and the other takes one more), so a channel keeps its handle across turns and restarts with nothing stored. `<channel_directory>` lists every text channel the persona can read with its handle, and a channel a line mentions carries its handle there (`transcript.channel`). In `<msg>` text and the body of `message.create` / `message.edit` an exact `#handle` of the request becomes `<#id>` before any name is tried (no letter, digit or underscore right before the `#` or after the handle, never inside a URL); a handle-shaped token the request does not hold goes on to the name matching under Output, and stays text when no name matches. A channel option of a `<call>` resolves the same way: `<#id>` or an id as given, a `#handle` (with or without the `#`) exactly, and only then the name matching (an exact name, else the one channel with the same core; several -> `target-ambiguous`, none -> `unknown-channel`). With the switch off: no `<channel_directory>`, no channel handles on the lines, and channels resolve by name only.

## Version history

When `features.versions` is on (the default), every replacement of a prose field's text is recorded before the new text is stored. The previous text goes into `data/guilds/<guildId>/versions/<kind>/<id>.json`, where `kind` is `users`, `channels`, `guild` (id `guild`) or `lore` (id is a slug of the entry title plus a short hash). Each file holds one JSON object keyed by field name, each value an array of records (newest last):

```
{ "<field>": [ { "at": "ISO", "by": "analyzer"|"voice"|"portrait"|"refresh"|"unknown", "chars": n, "before": n, "after": n, "kept": n, "removed": n, "added": n, "text": "<previous text>" } ] }
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
spontaneous candidate or by the emoji backfill.

A channel entry (`renderChannel` in `src/memory/channels.js`) carries:

- **Discord facts:** name (the `# heading`), category, topic. Present from the moment the channel is first seen.
- **Analyzer notes:** purpose, topics, tone. Written by the memory session (`memory-session.md`) from live batches. All three are free-text, token-resolved (`<@id>` → current name) at render time.
- **Code-maintained counters:** message count, the timestamp of the first and last message, a 30-day activity
  histogram (messages per UTC day, trimmed to the 30 most recent days), and the top 5 writers (by message count,
  excluding bots and the persona). Live traffic keeps them current via `store.touchChannel`.
- **Activity verdict:** `live`, `slow` or `dead`, computed by `channelActivity` from the counters, never the model's
  call. `live` when the sum of today's and yesterday's (UTC) messages reaches
  `context.channelActivity.liveMessagesPerDay` (default 20). `dead` when the channel has never seen a message or the
  last one is older than `context.channelActivity.deadAfterDays` (default 7). `slow` is everything in between.
  Rendered via `labels.server.activity` / `activityLive` / `activitySlow` / `activityDead`.
- **Last message age:** humanised via `labels.server.lastMessage` when the label exists and the data is available.
- **Top writers:** rendered via `labels.server.topWriters`, resolving stored author ids to current names; an id with
  no profile is skipped.

When the current channel has no stored note yet (the memory session has not touched it), a fallback entry is synthesised from
the Discord facts of the messages in the transcript, so the persona still knows where they are.

## Avatars

`features.avatars` (exactly `true`; off by default). The persona knows what each profiled member's avatar looks
like. The avatar a member shows is Discord's asset hash: the server avatar when they set one, else the account avatar,
else none (Discord's default avatar). Each version is described once, by `avatar.md` on the `vision` role (purpose
`avatar`): the system message is the prompt with `{{maxChars}}` = `avatars.descriptionChars` (default 200), the user
message is the picture alone (a static 256 px PNG, downloaded under `context.vision.maxBytes` and
`context.vision.fetchTimeoutMs`), the output cap `media.maxOutputTokens`. The answer's first line, on one line, cut at
a word boundary to `avatars.descriptionChars`, is stored. A default avatar is stored without any request.

Stored in the member's profile as `avatar`: `{ hash, text, describedAt }`, or `{ hash: null, default: true }`. Only the
current avatar is kept; a new version replaces it. Never for a bot or the persona, never a profile created for it: the
member must already have one. It goes with the profile (`/nep memory forget`, the wipe). A hand-broken field is dropped
on read.

Who is described and when: a scan of every profiled member on the first tick after the start (or after the switch is
turned on) and then once a day; between scans, a member is offered when Discord reports a changed avatar
(`guildMemberUpdate` and `userUpdate`, which need `discord.intents.members`) or when they post a message. A background
queue sends one request at a time, `avatars.intervalMs` (default 20000) apart, at most `avatars.maxPerDay` (default 60)
a UTC day (`state.json`: `avatarDay`, `avatarCount`; a missing or broken cap refuses), never while
`llm.maxRequestsPerDay` is spent or the persona is paused; it never blocks a turn. A version whose download or request
failed is tried again at the next scan.

The chat model sees it as one line of the member's `<people>` profile (see `<people>` above). Logs: `avatars: scanned`
(counts), `avatars: described` (`userId`, `chars` or `default`), `avatars: skipped` (`reason`: `avatar-cap`,
`daily-cap`, `download`, `llm-error`, `token-limit`, `empty`, `no-url`, `no-profile`); never the description or a URL.

## Address classifier

After the persona answers someone, a conversation window opens in that channel (`mention.followUpMinutes`, extended
by every further answer). A message inside the window that carries no trigger (no mention, no reply to the persona,
no name) is not answered blindly: code sends the last `mention.followUpContext` (default 15) lines of the channel, the
persona's own lines marked with `labels.self`, plus the new message marked as `<candidate>`, to `address.md` on
the `analyzer` role's model. The transcript carries cached media captions
(pictures, stickers, GIFs, custom emoji, watched videos) in the same label forms as the persona's transcript. Code
makes no new describer requests for the history lines; it describes only the candidate's own media before running the
classifier. Output is ONE word: `yes` when the candidate
addresses the persona or continues the exchange with them, `overheard` when people talk ABOUT the persona to someone else or to the room, `no` when the conversation has nothing to do with the persona.
An empty or blank answer is a failed call (`reason: empty`), not a silent `no`.
An explicit @mention of another member is always `no` before the model is asked; the implicit ping Discord adds for the
replied-to author does not count as such a mention. When `mention.followUpClassifyReplies` is on (default `true`,
missing key = on), a reply to another member's message goes to the classifier like plain text. With the switch off,
any reply to another member is an automatic `no`. With `mention.classifyWhileBusy` on (default `true`, missing key = on), a follow-up candidate that arrives while a turn is running is still sent to the classifier through the same window, no-streak and pre-filter checks; at most one classifier call per channel at a time, and a newer held line replaces an older. The candidate is not classified when the switch is off or when its own channel is busy and `mention.pendingSameChannel` is off (the `yes` would be dropped anyway). Each such call is one `analyzer` request under `llm.maxRequestsPerDay`. A `yes` that meets a busy turn waits in the pending queue (logged `follow-up: deferred`). The queue holds one deferred follow-up per channel; a newer one replaces the older (logged `follow-up: dropped`, reason `newer`). When the attention frees it is picked up (`follow-up: picked up`) through the same checks as a mention (expiry, switches, paused, can send, message still exists) plus two of its own: the follow-up window for that channel and author must still be open (`mention.followUpMinutes` and the no-streak), otherwise dropped `closed`; and the line must not have appeared in the history of a turn that already spoke in that channel, otherwise dropped `answered`. After these checks, the deferred follow-up is counted as a call and rolled against `mention.followUpIgnoreChance`, like a live one. With `mention.pendingOverheard` on (default `true`, missing key = on), an `overheard` that meets a busy turn waits in the pending queue; the reaction runs after the current turn. A waiting follow-up is never pushed out by a later overheard line; a waiting overheard line is pushed out by a later follow-up, a later overheard line, or a direct mention, reply or name call. A waiting overheard line is not counted toward the spam limit and is not reported to other turns as a call waiting in the channel. With the switch off, the overheard is dropped (`busy`).

`yes` goes through an ignore roll first and, unless it is ignored, runs a reply-mode turn with trigger kind `followUp`: its task text is `prompts/follow-up.md` when present (falling back to `reply.md`), so a `yes` does not promise an answer. The follow-up counts as a call by its author, like a mention, and the roll starts from `mention.followUpIgnoreChance` (default `0`) in place of `mention.ignoreChance`; the repeat penalty, the spam threshold and the affinity adjustment apply as for any call. An ignored follow-up is logged as `mention: decided` with reason `ignored:follow-up` (`ignored:repeat` or `ignored:spam` when the author's recent calls count as repeats or spam) and leaves the window and its no-streak as they are. `overheard` runs a reply-mode turn with trigger kind `overheard`: its task text is `prompts/overheard.md` when present (falling back to the mode prompt), no interlocutor mark on the author's profile heading, plain posting, not counted for the repeat penalty, no ignore roll, no limit notice when a rail refuses the turn, no search or re-watch classifier, drawing treated as unasked (no per-user image accounting). With `mention.followUpOverheard` off, an `overheard` answer starts a plain follow-up turn instead (the log still records `answer: 'overheard'`). When a newer message was held during the classifier call and the verdict is `overheard`, the held message is classified first: a `yes` starts the follow-up turn for it, an `overheard` starts the overheard turn for the held message, a `no` starts the overheard turn for the original candidate.

Three `no` in a row (`mention.followUpNoStreak`, default 3) close the window; `overheard` counts as `yes` for the streak. Switch `features.followUp` (default on). Logged as counts, verdicts and `answer` on `follow-up: verdict`.
The window state survives a restart: active windows are saved in `data/state.json` under `followUpWindows` and restored at startup, with expired ones dropped.

## Re-watch classifier

When the persona is directly addressed (a reply turn, not an overheard or spontaneous turn) and a video or picture sits in the last `media.video.rewatch.recentMessages`
(default 60) messages of the channel, a classifier decides whether the message asks about one of those items, asserts a concrete detail about a picture, or asks
to retry a video that did not load. Candidates: watched videos, error-state videos, watched GIFs (an attached GIF or a GIF embed whose cached description came from watching its clip, see `describe-gif.md`), and described pictures (attached pictures, including the persona's own uploads; pasted image links are excluded). Pictures are offered only when `features.imageRelook` is on (never gated by `features.vision`); watched GIFs only while GIFs are watched (`media.gif.watch`, video vision on). At most `media.video.rewatch.maxCandidates` (default 6) items are
offered to the classifier, videos first, then watched GIFs, then pictures, newest-message first within each group. Code sends `rewatch.md` as the system prompt on the
`analyzer` role with a user message
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

On a question hit for a picture, the vision model (`vision` role, `purpose: relook`, prompt `rewatch-answer.md`, which is kind-neutral) looks at the picture again with that question. The answer is not stored as the caption (cached one hour) and the transcript carries `transcript.imageAnswered` (`{question}`, `{text}`) under the picture's line.

The `<senses>` block includes `senses.videoRewatch` when the feature is on.

On a retry hit, the video model watches the clip with `force` (ignoring the error cache), using the same
`describeVideo` path as a first watch. If the retry succeeds, the video's state changes from error to watched and the
transcript shows the summary as first-hand. A retry counts as a new video attempt against `media.video.maxPerTurn` and
`media.video.maxPerDay`.

Rails: at most one re-watch or retry per turn; the classifier and the second look each count against
`llm.maxRequestsPerDay`; a video's second look also counts against `media.video.maxPerDay`, a GIF's against `media.gif.maxPerDay` (never the video counter);
`media.video.rewatch.maxPerDay` (default 20) caps video re-watches, GIF re-watches and picture relooks (shared counter). Answers are cached for one hour per
question (see the video cache section above). Switch `features.videoRewatch` (missing = on, needs
`videoDescriptions` on). Switch `features.imageRelook` (missing = on; the look runs through the `vision` model role, the persona's only sight).

With `features.coreTools` on this classifier is never asked (nor the planner's rewatch block): the persona looks more closely
herself with `media.look` (see [the tool loop](#the-tool-loop-featurescoretools)), which runs the same second look
with her own question.

## Search and recall classifier

When the persona is directly addressed (a reply turn, not an overheard or spontaneous turn) and the `lookup.md` prompt exists, the classifier decides whether the trigger needs a web search, a server-history search, or both. Code sends `lookup.md` as the system prompt on the `analyzer` role with a user message containing a short `<transcript>` (the same as the re-watch classifier, with the persona's own lines marked by `labels.self`) and a `<candidate>` block:

```
<transcript>
...
</transcript>
<candidate>
<author name>: <trigger text>
</candidate>
```

The transcript carries descriptions, video summaries and link reads when available. The trigger text is cut at `context.maxMessageChars`. Output is `none`, or up to five labelled lines in any order:

- `web: <search query>` (plain words, no quotes, no operators, at most 12 words): the message needs facts from outside the chat, or explicitly asks to search the web. This line fires only when `features.webLookup` is on, `web.search.enabled` is not false, `web.search.maxPerTurn` is at least 1, and a `BRAVE_SEARCH_API_KEY` is configured.
- `server: <form>, <form>, ...`: the message asks about something said or done on this server that is not in the transcript. Each form is one word or a short phrase as people would type it, listing inflected forms for the search. Fires only when `features.recall` is on.
- `who: <name form>, <name form>, ...`: the question is about a person not obviously in the transcript. The forms help find them by nickname, username or tag.
- `when: <from> .. <to>`: the question points at a time (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM` on each side of `..`; one date alone means that whole day).
- `when-role: scope | locator` (also read as `when_role` or `when role`; its first word, any case): what the `when:` range is for. It only qualifies `when:`: alone, or without a usable range, it asks nothing. `scope`: the date is the question ("what happened on the 7th", "what did we talk about yesterday"), and the range is a hard bound on every source, exactly as before. `locator`: the date only helps find an event the question names ("remember a week ago when...", "that argument on the 7th about X"); people misremember dates, so the range ranks instead of bounding (see the locator paragraph below). A `when:` beside `server:` or `who:` forms without a usable role is a locator, the safe default: a misread date cannot exclude the answer. A `when:` with neither `server:` nor `who:` is always a scope.
- `recent: yes | no`: `yes` (its first word, any case) marks a vague "recently". It only qualifies the other lines: alone it asks nothing (no server search). A recall is treated as "recently" when its `when:` range starts within the last `recall.recordDays` days (at least one) and ends open or within the last day, or, without a `when:` line, when `recent: yes` is given; a dated range that is not recent wins over the flag.

An optional `skills:` line may appear beside `none` or the lines above (`features.toolsDiscovery`). `skills: inventory` requests the full skill list; `skills: <name>, <name>` (up to 4) names skills relevant to the message. Code reads it through `parseSkillsAnswer`. When the answer is `inventory`, a `<skills>` block with the full list is added to the reply request. Otherwise the named skills are recorded as proposed (`skillsProposed` in the journal turn record). Logged as `skills: inventory` or `skills: proposed` (count).

A single unlabelled line (the old format) is still read as a web query. An empty or blank answer is a failed call (`reason: empty`), not a silent `none`. When the classifier fails on a direct call (a mention, a reply, the name, a follow-up or a private chat) and `recall.fallbackOnClassifierFailure` is on (the default), recall runs with a plan built from the trigger: words of 5+ letters as forms (longest first, at most `recall.maxForms`, the persona's own name left out), members named in it by a stored name or alias as `who`, no date range, no web search; logged as `lookup: fallback`, the journal records a `helper-fallback` limit.

On a `web:` hit, Brave Search runs the query (`web.search.results` results, default 5), the numbered results are condensed by the `analyzer` role through `search-summary.md` (`{{today}}`, `{{query}}`, `{{maxChars}}` = `web.search.summaryChars`, default 900), and the web part is rendered in the `<lookup>` block: `labels.lookup.header` with the query, the condensed text, and `labels.lookup.sources` with the distinct site names. When the search returned nothing or the condenser found nothing useful, `labels.lookup.none` appears instead.

On a `server:` hit (with optional `who:` and `when:` lines), the engine searches the server's message history through the interface's message search (the `messages.search` read). The forms become an ordered list of search queries (content forms round-robin, then author names), or date-range samples when only `when:` is given. Hits the turn already shows in `<chat>` (its history window and the reply parents it fetched) are dropped first, before clustering, and counted as `inChatDropped`. The rest are filtered (other bots and channels the audience rule refuses are excluded) and grouped into clusters by channel and time (`recall.clusterGapMinutes`). Each cluster has a topic score: each distinct `server:` form with hits in the cluster adds 2 when its total server hits are at most `recall.rareHits`, 1 otherwise. The clusters are ranked by topic score, then by all distinct queries, then newest first, and the top `recall.maxClusters + recall.selfExtra` (default 5 + 2) are kept as candidates; `recall.keepOldest` reserves slots for the oldest with a topic score of at least 2. A window of `recall.windowMessages` messages is fetched around each candidate; a window then extends forward while the conversation continues, at most `recall.followMessages` (default 24) more lines, stopping at the first silence longer than `recall.followGapMinutes` (default 5) minutes. Lines of other bots and lines already in `<chat>` are left out of a window; a window that reached into `<chat>` is marked as overlapping the current chat, and a window that holds at least one line of the persona is marked as hers. The candidates are then ranked again by topic score + `recall.selfBonus` (default 1) for a window of hers, then by all distinct queries, then newest first (the same `keepOldest` reservation), and the top `recall.maxClusters` are kept; a candidate whose window could not be fetched takes no slot. A cluster with only name or author hits ranks below any cluster with a topic hit. The classifier's word forms and name forms are also matched against stored memory (never the private layer): members' episodes, lore entries, taught lessons and recent lines. Forms match by word stem (case and accents folded): a form of 5+ letters matches a text word that starts with the form minus its last 2 letters (the prefix is never shorter than 4 letters) and is at most 3 letters longer; shorter forms and forms with digits match whole; a multi-word form matches consecutive words. The archive (items that left hot memory, `data/guilds/<id>/archive/`) is a fifth source: its entries are read as a stream, from the start of the `when:` range or over the last `recall.archiveMonths` (default 6) months, and matched on their `neutral` text and their text fields (an episode's `what` and `quote`, never its `feeling`; a participation episode's message texts); a `when:` range matches their `observedAt` day. Each matching item becomes one line in a `<memory>` block: `kind | date | name | text`, with kinds `episode`, `lore`, `learned`, `recent`, and `archived <itemKind>` for an archive entry (`archived episode`, `archived interest`, `archived realName`, `archived participation`, ...; its date is the local day of `observedAt`, its name the member it is scoped to, its text the item's own text fields: a participation episode as `name: text` per message joined by ` / `, another kind its fields joined by `: `, the `neutral` text when those are empty). A hot item and an archived copy with the same `itemId` are one hit (the hot one); of several archived revisions of one item only the newest recorded stays. A `when:` date range drops undated kinds (lore, learned). At most `recall.memoryItems` (default 6) items, ranked by the number of forms they match and by weight; for a vague "recently" (see `recent:` above) the items holding the persona's own lines (an archived participation episode) come first, then the newest. The block then holds the items in that order until the next line would pass `recall.memoryTokens` (default 600, the token estimate of each line). The `<memory>` block sits after `<people>` and before `<found>`; its items cannot be named as a `stretch`. A run with memory matches and no chat hits still asks the summary. Logged as `stats.memory` (`stats.archived` of them from the archive) on the `recall: searched` line.

The engine reads the record (`data/guilds/<id>/record/`, every observed message) for every recall question: a dated question reads the days of its `when:` range back at most `recall.recordDays` (default 3) from the end of the range (now when it is open), never before the range's start; any other question reads the last `recall.recordDays` days from now. A dateless question that is not a "recently" also keeps the window of its earliest match, so an origin question sees where the thing started. The newest revision of each message counts and a deleted message is left out. A line matches when a `server:` or `who:` form, or a stored name or alias of a member the `who:` forms found, matches a word in it by the same stem rule, or the title or description of a link preview the line carries (the record's `links`), or when it names such a member (author or participant). A match by a name form or a member only locates the person: a line with only such matches ranks below any line with a `server:` form match. Each match brings its reply chain (the messages it replies to, within the read days) and `recall.recordContext` (default 3) lines before and after it in its channel; the stretch then extends forward the same way as a search window. A line's link previews are rendered like a live one, through `labels.transcript.link` / `labels.transcript.linkText` (`{site}`, `{title}`, `{text}` = the description). Lines of the turn's own chat are left out. At most `recall.maxClusters` such windows, the persona's own exchanges first for a "recently", join the search's windows in `<found>` by time, unless the search already shows all their lines; they count as `stats.record`.

Before an archive entry or a record line is matched, the audience rule of the turn's channel applies: an entry with a `scope.channel`, and every record line, of a channel the pull rail refuses toward the turn's channel (on a private turn: a channel the partner cannot view) is skipped. Private entries and private record lines (scoped `private`) match only on a private turn with their own member, whose private archive and record are read too; a server turn reads none.

The summary request (`recall-summary.md` on the `analyzer` model role) gets the system prompt, then one user message with the blocks `<people>`, `<memory>`, `<found>`, `<context>`, `<time_cue>`, `<question>` in that order, each left out when empty. `<time_cue>` appears only when the `when:` range was a locator: `labels.lookup.timeEstimate` with `{range}` the cue's local days (`YYYY-MM-DD`, or `YYYY-MM-DD .. YYYY-MM-DD`, an open side left empty); a missing or blank label adds no block. It tells the summary that the asker's date is an estimate, so the matching event may sit on another date (each `<found>` header carries its own date). Stable content comes first and per-turn content last: the system prompt is the only stable part, and every block of the user message is per-call, so nothing is marked for the prompt cache. The lookup classifier's request is unchanged. `<found>` holds one section per kept window, newest first, each opened by a header `## n | YYYY-MM-DD | #channel` (the local date of its first line; ` | source: record` follows the channel for a window read from the record), followed by its lines with `#n` indices; a line the search matched starts with `>> `. A header gets ` ` + `labels.lookup.stretchSelf` when the window holds a line of the persona, then ` ` + `labels.lookup.stretchCurrent` when it overlaps the current chat; both labels are trimmed, and a missing one adds nothing. `<context>` holds the last `recall.contextMessages` (default 6) chat lines before the question, from the lines the search classifier read (on a routed call, the source channel's), rendered like the classifier transcripts: the transcript header, the persona's own lines under `labels.self`, the captions the turn has, and `#n` indices continuing after the last `<found>` line. `<question>` is `<author name>: <trigger text>`. The analyzer reads the windows, the stored memory, the context and the question, and writes a note. The summary may name one stretch that best answers the question (`stretch: <n>`); if it does, the verbatim lines of that stretch (capped at `recall.stretchChars`) appear alongside the note. When the summary says `nothing`, the `<lookup>` block carries no server part. A summary that fails or runs out of time falls back to the verbatim stretch of the top-ranked window with no note.

With `features.meaningSearch` exactly `true`, a recall run also searches by meaning. The asker's message is embedded (one request to the `embedding` role, purpose `recall-query`); with `recall.meaningWithReply` the replied-to line is included in the query text. The vector index (`src/memory/vectors.js`) is searched within the asked `when:` range (every month without a range or with a locator), returning `recall.meaningCandidates` (default 80) rows after the audience rule and the visible chat's ids are applied. Record rows from the meaning search join the record windows; archive rows join the stored-memory items. Rows found by both words and meaning rank first (reciprocal rank fusion, k = 60); rows found only by meaning follow by cosine; rows found only by words come last. When the embedding or the vector search fails, the run logs `recall: meaning failed` (`stage` `embed` or `search`) and continues with words only.

A `when:` range that is a locator (`when-role: locator`, or no role beside `server:` / `who:` forms) bounds none of the local sources. The record is read over its last `recall.recordDays` days from now, plus the locator's own days read the way a dated question reads them when they lie before that; the archive over its last `recall.archiveMonths` months (from the range's start when that is earlier); the vector index over every month; stored items are not filtered by date (lore and learned items included). Each window, cluster or item then gets a proximity bonus: the full `recall.locatorBonus` (default 2) when its time overlaps the range, falling linearly with the distance to 0 at `recall.locatorDecayDays` (default 7) days away, counted in the unit of the score it is added to (one matched form or topic point; one top rank, 1 / 61, for a score fused with the meaning search; an undated item gets none). The kept slots (`recall.maxClusters` clusters, `recall.maxClusters` record windows, `recall.memoryItems` items) are split: the first `ceil(slots x recall.locatorBroadShare)` (default 0.5) go to the best by content regardless of date (the ordinary ranking), the rest to the best of the others with the bonus, so the date cannot crowd out a better match on another day. With a locator `recall.keepOldest` and the record's earliest-match window are not applied. Discord searches the range exactly as before, plus one broad page of the first planned query sent right after it: no lower bound, `max_id` at the start of the record's last `recall.recordDays` days (no bound without a record), newest first; its hits join the others (its total does not count for rarity). The broad page is skipped when the record reaches back to the locator's start minus `recall.locatorDecayDays` days. A `when:` that is a scope keeps every behaviour above unchanged.

The `recall: searched` log line carries counts only (`memory`, `archived`, `record`, `meaning`, `meaningMs`, `planned`, `queries`, `failed`, `hits`, `inChatDropped`, `kept`, `clusters`, `selfClusters`: the kept clusters whose window holds a line of the persona, `windows`, `people`, `ms`), never a form, a name or a message. To see what a run found and chose, switch on `features.recallTrace` (missing = off): every run that passes the early gates appends one JSON line to `data/guilds/<id>/recall-trace.jsonl`, at most `recall.traceMaxLines` (default 500) lines, the oldest dropped. A line: `{ at, channelId, triggerId, forms, who, when, hits, inChatDropped, clusters, summary, lookupChars, meaning }`. `at` is the run's start (ISO); `when` is `{ from, to, role }` (ISO, either may be null; `role` `scope` or `locator`) or null; in a locator run every kept cluster, record window (`record`) and memory item (`memory`) carries `share` (`broad`: a slot reserved for content regardless of date, `dated`: one won with the proximity bonus; a cluster not kept `null`) and the broad Discord page's `plan` entry `broad: true`, keys absent otherwise; `clusters` lists every candidate as `{ channelId, from, to, score, queries, self, overlapsChat, kept }` (`from`/`to` its first and last hit, ISO; `score` the topic score with the bonus); `summary` is `{ answer, stretch, text }` with `answer` `text` | `nothing` | `fallback` (null when no summary was reached), `stretch` null or `{ n, channelId, channelName, lines }` (the section number and the exact lines handed to the persona), `text` the note; `lookupChars` counts the characters of the note and the stretch lines. `meaning` is null unless the run searched by meaning, else `{ query, candidates, kept, ms }`: `query` is `question` or `question+reply` (what was embedded), `candidates` the raw count from the vector search, `kept` an array of `{ id, kind, score, rank }` per row after deduplication (a message id or an archive itemId, `record` or `archive`, the cosine, the 1-based meaning rank), `ms` the time of the embedding and the vector searches. The file quotes members' messages: it is memory about real people, stays under `data/`, and `/nep memory wipe` deletes it.

When both web and server searches ran, the `<lookup>` block carries `labels.lookup.webHeader` above the web part, `labels.lookup.serverHeader` above the server part, and `labels.lookup.bothNote` between them.

The `<lookup>` block follows the same audience rule as `<other_channels>` (`context.pull.sameAudience`): a server-search window is refused when the channel it came from is not readable by everyone who can read the destination.

Rails: at most one web search and one server search per turn. The classifier, the web condenser and the recall summary each count against `llm.maxRequestsPerDay`; the web search counts against `web.maxPerDay` (shared with link reads); the recall run counts against `recall.maxPerDay` (stored in `state.json` as `recallDay` / `recallCount`). Web results are cached for `web.search.cacheHours` (default 24) hours per normalised query. The classifier fires when either `features.webLookup` or `features.recall` is on. Switches: `features.webLookup` (missing = off), `features.recall` (missing = on).

## Task splitter

A direct call (mention, reply, name, follow-up, private message) that is long and structured enough (`split.minChars` characters with links and Discord tokens excluded, at least two runs of separators) is given to a classifier (`prompts/split.md` on the `analyzer` role, purpose `split`) alongside the turn's preparation. The classifier reads a short `<transcript>` of the last `split.contextMessages` messages with the persona's own lines marked by `labels.self`, then the new message as `<candidate>` (`<author name>: <text>`). Its answer is the word `one`, or 2 to `split.maxTasks` (default 4) lines each starting with `- ` and holding one part in the author's own words. After parsing, a part shorter than `split.minPartChars` (default 20) characters (links and Discord tokens excluded, like `minChars`) is folded into the next part (the last into the previous); when fewer than two parts remain the message is one request (`folded`). An empty, unparsable or late answer (the turn's preparation finished first) is treated as one request and logged `split: failed`. Switch `features.splitTasks` (missing = on).

Parts become a chain of ordinary turns on the same message (`turn: part`). Each part's `analyzer` requests (the search classifier, recall, the route hook, the re-watch) judge that part's text, and the request names the part and the others (`labels.task.part` with `{index}`, `{total}`, `{part}`, `{others}`). The first part reuses the history the whole message's turn fetched and replies to the message; the later ones fetch history afresh and post plain. Each part has its own deadline and drop bar; a part that fails or is refused does not stop the next. The ignore roll, the private daily cap and the ring stamp count once per message. A pause ends the chain before its next part (`turn: chain stopped`). While the chain runs, its unstarted parts are the author's waiting items (`waitingParts` on the turn runner); a later message of the author folded into one of them (`addToPart`) reaches that part's request as `tasks.added`. The attention stays with the chain from the first turn to the end; idle notifications fire once, at the end.

Without `prompts/split.md` the splitter is off (`split: skipped`, `no-prompt`). Without `labels.task.part` the splitter is also off: a parsed answer is discarded. Settings: `split.minChars` (default 80), `split.minPartChars` (default 20), `split.maxTasks` (default 4), `split.contextMessages` (default 6), `split.maxOutputTokens` (default 300).

## Merge classifier

When a call arrives from an author who already has items waiting in that channel (parts of a split message the chain has not reached, or queued calls in the pending list), a classifier (`prompts/merge.md` on the `analyzer` role, purpose `merge`) decides whether the new message belongs to one of them. The classifier reads a `<waiting>` block of numbered items (`1. <text>`, one per waiting item) and the new message as `<candidate>` (`<author name>: <text>`). Its answer is one line: a number from the waiting list or the word `new`. A folded message never gets a turn of its own; it appears in the turn of its item through `labels.task.added` (`{added}`). Routed calls are never folded into. Without the prompt file, every call is queued as its own item (`merge: failed`, `no-prompt`). Logged as `merge: verdict` or `merge: failed`. No config settings of its own; the output cap is `mention.followUpMaxOutputTokens`.

## Missed-answer recovery

When the persona may have left a message unanswered (the follow-up address gate failed, a deferred follow-up was replaced by a newer one, a turn errored, was dropped as too slow, or ended not-now), the message becomes a candidate. The fact of an errored turn carries the turn's reason as its `failure` (e.g. `cut-off`). Switch `features.missedAnswers` (missing = on); `features.memory` off turns it off.

`missed.sweepDelaySeconds` (default 90) after the channel goes quiet, a sweep runs. Code resolves what it can first: a candidate answered by a later turn of the persona in that channel, or expired after `missed.expireMinutes` (default 5, or `missed.questionExpireMinutes` 15 for a message with a question mark). What is left goes to one analyzer call per channel: `prompts/missed.md` on the `analyzer` role (purpose `missed`, output cap `missed.maxOutputTokens` 2000). System: the prompt with `{{name}}`. User: a transcript of the last `missed.contextMessages` (default 20) lines with the persona's own lines marked by `labels.self`, trigger markers when on, then a `<candidates>` block of numbered messages with their transcript line number and the reason code. Each new message in the channel pushes the sweep back, never past `missed.sweepMaxDelaySeconds` (default 240).

Output is one `n: verdict` line per candidate (a period, a parenthesis or a dash may stand for the colon). Verdicts: `owed` (the message needs an answer and none came), `resolved` (a later line of the persona's covers it), `intentional-skip` (the message asks nothing of the persona), `stale` (the conversation moved on), `uncertain` (cannot tell). An empty or failed call gives `unchecked`, never `owed`.

With `features.missedRecovery` exactly `true`, `owed` candidates of a channel start one ordinary reply turn together (trigger kind `missed`, the earliest candidate as the trigger, all listed under `labels.task.missed` with `{missed}` = `<n>. <author>: <text>` items joined by `; `). One attempt per candidate, at most one recovery turn per channel every `missed.channelCooldownMinutes` (default 5), never while paused or warming up. The turn posts nothing when the persona already spoke in that channel since the sweep started. With the switch off (the default), the sweep classifies and journals only (shadow mode).

### Data file

`data/guilds/<id>/missed.json`: the candidate registry, written whole through a `.tmp` file and a rename. Closed candidates and those older than a day are dropped at startup and on every write; the registry holds at most 500 entries. The file survives restarts; at start, candidates are reconciled with the journal of the last hour.

### Journal

Every candidate writes `answer` records to the journal:

- `fact`: a candidate was registered (reason, message id, channel id, author id).
- `verdict`: the analyzer returned a verdict (verdict code, message id).
- `resolved`: code resolved the candidate before the analyzer ran (message id).
- `expired`: the candidate expired without a verdict (message id).
- `recovery`: a recovery turn started for this channel (message ids of the owed candidates).

Records carry ids only, never message text. `/nep memory journal kind:answer` shows these records.

### Status card

The `/nep status` card carries a speed line: `missed: N candidates, M owed, K recovered`, where the counts are the day's totals.

### Logs

`missed: candidate` (channelId, reason, messageId), `missed: resolved` (channelId, messageId), `missed: expired` (channelId, messageId, reason), `missed: verdict` (channelId, verdict, messageId), `missed: helper failed` (channelId, reason or error), `missed: recovery` (channelId, candidates count), `missed: recovery held` (channelId, reason), `missed: sweep skipped` (channelId, reason). Ids and counts only, never message contents.

## Participation episodes

The persona's own exchanges on other channels, kept so a turn in one channel can recall what it said in another hours ago (`src/memory/participation.js`, `data/guilds/<id>/participation.json`). Switch `features.participation` (missing = on); `features.memory` off turns it off too.

Recording. Code records, no model decides. Every text message the persona sends for real in a server channel (follow-up parts and answers to routed calls included; not a private chat, not the diary channel, not a dry run) is saved with the last `participation.linesBefore` lines of the turn's history before it (only those at most `participation.contextMinutes` older than it) and the message it replied to when that one is older (the reply parents the turn already fetched; nothing is fetched for it). A message joins the channel's last episode when that episode's last line is at most `participation.mergeGapMinutes` before the message itself, else it starts a new one; past `participation.maxMessages` an episode continues in a new one. A line by another member within `participation.followMinutes` after the persona's newest line is added, up to `participation.linesAfter` lines (nothing is fetched and no profile read for it). Texts are cut to `participation.maxTextChars`. An episode lives `participation.hours` after the persona's newest line in it; `participation.maxStored` caps the file. A forget removes the member's lines; an episode left without a line of the persona goes.

The classifier. On a server turn that builds a reply request (a reply of any trigger kind, an interject, an initiate, a noticed comment; never a diary post or the second turn after a failed picture), when at least one episode is on offer, `prompts/participation-pick.md` runs on the `analyzer` role (purpose `participation-pick`, output cap `participation.maxOutputTokens`, the analyzer timeout and hedge) beside the turn's preparation, under its deadline and its own time limit `participation.pickTimeoutMs` (default 1500 ms; past it the request is aborted and nothing is picked, logged `participation: late`). System: the prompt with `{{name}}`. User, in this order: `<episodes>` with one line per episode, oldest first (the cache-stable part): `n | #channel | <member name>: <lines of the other members> | <persona name>: <lines of the persona>` (the member name is the author of the episode's first member line; both columns carry ALL the episode's lines of that side in order, each line cut to 90 characters at a word boundary and joined with ` /`, the persona column cut to 320 and the member column to 200 characters; a `|` inside a text becomes `/`; the member part is empty when the episode has none), then `<episode_ages>` with one `n | when` line per episode (`when` is a duration in `labels.units`), then `<transcript>` (the last `participation.contextMessages` lines before the message, the persona's lines marked with `labels.self`) and `<candidate>` (`<author>: <text>`). The answer is one line: numbers from the list, comma- or space-separated, or `none`. Unknown numbers are dropped; `none`, an empty answer or anything that is not a list of numbers picks nothing. Without the prompt file, late (past the turn's deadline or `participation.pickTimeoutMs`), or failed: nothing is picked.

Selection, cutting, dedup. The request shows at most `participation.shown` episodes, `participation.perChannel` per channel: the picked ones in the classifier's order, then the newest. Only channels that pass the audience rule of `<other_channels>` and `<channel_view>` are offered (`context.pull.sameAudience`: everyone who can read the current channel can read that one); never the current channel. A line already shown in `<chat>`, `<other_channels>` or `<channel_view>` is left out; an episode left without a line of the persona is dropped. An episode longer than `participation.episodeChars` characters keeps, in order, the persona's lines with the lines they answer, the lines that share a word of 4+ letters with the new message (and one neighbour on each side), the first and last two lines, then the rest while it fits; a run of cut lines is marked with `labels.participation.skipped`. The budget section `participation` drops whole episodes, the picked ones last. The block sits right after `<recent>`.

Logs (counts and codes only): `participation: recorded` (`channel`, `episodes`; `following: true` for a line after the persona's), `participation: classified` (`channel`, `kind`, `offered`, `picked`, `parse`, `ms`), `participation: skipped` (`no-prompt`, `no-candidate`), `participation: failed` (`reason`: a rail code, `error`, `record-error`, `following-error`). The reply's `turn: model answered` carries `budget.participation` (`used`, `kept`, `dropped`, `offered`, `shown`, `cut`, `deduped`).

## Turn planner

When `features.turnPlanner` is exactly `true`, one analyzer call replaces four classifiers that otherwise run separately before a reply: the channel router (`route-channel.md`), the episode pick (`participation-pick.md`), the re-watch classifier (`rewatch.md`) and the search classifier (`lookup.md`). The address classifier and the GIF picker stay separate.

`planner.md` runs on the `analyzer` role (purpose `planner`), output capped at `web.search.classifierMaxOutputTokens` (default 2000). Placeholders: `{{name}}` (the persona's display name), `{{today}}` (the date in `bot.timezone`, `YYYY-MM-DD`).

### Input

The user message carries the same lists the old classifiers received, in this order: `<channels>` (channel lines from the route classifier), `<episodes>` (episode lines from the participation pick), `<media>` (video and picture lines from the re-watch classifier), then a short transcript of the last `web.search.contextMessages` lines, then `<candidate>` (the new message: `<author name>: <text>`). A block whose list is empty is left out. The `<channels>` and `<episodes>` blocks are tagged `cacheSegment: 'stable'` (they change only when a channel or an episode does); the `<media>` list, the transcript and the candidate are the per-turn tail.

### Output

Four labelled blocks, each present exactly once, in any order:

```
channel: <n> | channel: <n> earlier | channel: none
episodes: <n>, <n>, ... | episodes: none
rewatch: <n> retry | rewatch: <n> question: <text> | rewatch: none
lookup: none
```

When a search is needed, the `lookup` block carries one or more labelled lines instead of `none`:

```
web: <query>
server: <form>, <form>, ...
who: <name form>, <name form>, ...
when: <from> .. <to>
when-role: scope | locator
recent: yes | no
```

`when-role` reads as in the search classifier: `scope` makes the `when:` range a hard bound, `locator` (or no role beside `server:` / `who:`) only ranks by it.

An optional `skills` line may follow (`features.toolsDiscovery`): `skills: inventory`, `skills: <name>, <name>` (up to 4), or `skills: none`. Read by `parseSkillsAnswer`; same effect as in the standalone classifier.

Each lookup label may appear at most once. The grammar of each block matches the output format of the classifier it replaces: `channel` is read by `parseRouteAnswer`, `episodes` by `parseParticipationPick`, `rewatch` by `parseRewatchPickDetailed`, and the lookup lines by `parseLookupAnswer`.

### Block states

Each block in the parsed answer carries a state:

- `ok`: a usable pick.
- `none`: the model answered `none`.
- `invalid`: present but unparsable (a number outside its list, a duplicate line, conflicting content such as `lookup: none` alongside labelled lines).
- `missing`: not answered at all.

An `invalid` or `missing` block takes its safe default: no channel routed, no episodes picked, no second look. The lookup block falls back to the words recall (`recall.fallbackOnClassifierFailure`). On a whole failure (the request threw, timed out or returned a blank answer), every offered block records its fallback and the lookup fallback runs alone. The old classifiers are never re-run.

### Fallback journal entries

Every offered block that ends up `invalid` or `missing`, and every offered block of a failed call, records a `helper-fallback` limit entry: `where: 'planner:<block>'` (e.g. `planner:channel`, `planner:lookup`), `detail`: the state or the failure code.

### Logs

- `planner: classified`: each block's state, the offered counts, the picked counts. Codes and counts only, never a line, a query or a question.
- `planner: failed`: the request threw, timed out or returned a blank answer. Fields: `reason` (`classifier-failed` or `empty`), `rail` (the rail code when applicable).
- `planner: skipped`: the planner had nothing to decide (`reason`: `no-prompt`, `nothing`, `no-candidate`). No request, no fallback recorded.

## Drawing

The persona can produce pictures through a drawing sub-process (`features.imageGeneration`, on by default). When the
model calls `draw.create`, `src/behavior/turn.js` assembles the image prompt from `draw.md` and generates one picture
through OpenRouter's Images API (`src/llm/images.js`). The call runs before her speech goes out, and the picture is
posted as its own message, never inlined. A diary post stages its pictures and posts them after its messages.

### Prompt assembly

`buildDrawPrompt` (`src/behavior/prompt.js`) fills `draw.md` with four placeholders:

- `{{name}}` — the bot's display name.
- `{{appearance}}` — `appearance.md` with `{{name}}` filled, included only when `self` is true. Empty otherwise.
- `{{request}}` — the scene text of the `draw.create` call, clamped to `image.maxPromptChars` (default 1600) at the last sentence or word boundary. `format.md` tells the persona this limit through `{{drawChars}}`.
- `{{when}}` — the local date and time through `labels.draw.when`, so the image model draws the right light and season. Empty when the time is unknown.

The drawing sub-process never receives the character card, `rules.md` or the system prompt. It follows its own style
section inside `draw.md`.

### Reference

When the persona is in the picture (`self` true) and `image.reference` is `'avatar'` (the default), the bot's
Discord avatar is downloaded and sent as an `input_references` entry so the image model can see what the persona looks
like. If the avatar cannot be fetched, the generation proceeds without a reference.

### Senses

The `<senses>` block includes one drawing line when an image client is wired and `features.imageGeneration` is not
false:

- `senses.draw` — the persona can draw.
- `senses.drawSpent` — the daily quota (`image.maxPerDay`) is spent.
- `senses.drawSpentUser` — this member's daily quota (`image.maxPerUserPerDay`) is spent.

An older `labels.json` without `senses.draw` shows nothing.

### Failures

A failed picture is never a turn of its own and never a limit notice. The `draw.create` call comes back to her as a
result with its code: `image-cap-daily` or `image-cap-user-daily` (the caps), `image-moderation`, `image-timeout`,
`image-error`, a refused publication with its gateway code. Her speech of that step is held, and the next request
tells her so ([The steps of a turn](#the-steps-of-a-turn)).

### Rails

- The scene text of one `draw.create` call is clamped to `image.maxPromptChars` (default 1600) at the last sentence or word boundary.
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

**Plan** (`prompts/diary-plan.md` on the `analyzer` role, usage purpose `diary-plan`, `diary.planMaxOutputTokens` 300,
`diary.planTimeoutMs` 20000). No character card. User message blocks: `<now>`, `<server>`, `<about_chat>`, `<recent>`,
`<lore>`, `<world>` (under `diary.world`), `<diary>`, `<kinds>`, `<seeds>`, and `<topic>` when a forced run gave one
(`tools/replay.mjs --topic`). The answer is one JSON object:

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

**Compose** (`prompts/diary.md` as the task, the main model with the character card and all memory blocks). The compose request receives `<world>` (under `diary.world`), `<diary>`, `<plan>`, `<seeds>` (a set post only, `diary.set.seedSets` combinations) and `<found>`
(when the search produced one). The `<diary>` block is fitted by `fitSections`: the oldest lines are cut first, then
the whole block. `<plan>`, `<seeds>` and `<kinds>` are never cut.

### Output rules

Only `<msg>` tags are acted on. Reply attributes are dropped. URLs in the message text are removed mechanically. At most `diary.maxMessages` (3) messages; excess messages are trimmed. `<react>` and `<gif>` are dropped in this mode. `<skip/>` means no post. A post may be a picture alone.

A diary post runs on the same step engine as every turn, bounded by `diary.loop` (`maxSteps` 2, `timeBudgetMs` 600000) and with the same tools; only `draw.create` runs there. Any other call is refused `diary-draw-only` and she reads it (`voice.say` runs too: its file is kept for the entry, not posted). A step takes at most `diary.set.pictures[1]` (6) calls, a post at most that many pictures for a set kind and one for any other kind (past it: `loop-cap`). While the post may carry no picture (no image client, drawing off, no Attach Files, `diary.maxPicturesPerDay` or `image.maxPerDay` spent) `draw.create` is refused `daily-cap` with the gate that closed as its reason. Each picture is staged as it is generated (result `ok`, code `staged`) and counted against `diary.maxPicturesPerDay` then, posted or not, charged to no member. Nothing reaches a chat from the turn. Her speech is held after the calls of the step ran and only when every call worked: a failed picture holds the speech and the staged ones, she reads the failure, and may draw again or post with what she has. A failure is only a result she reads and a log line (`turn: draw error`); nothing else happens. The held speech, the staged pictures and the voice file are recorded as one entry, and the diary's mirrors post it: the voice message, then her messages, then the pictures (`src/behavior/mirror.ts`).

**Set posts.** When the planned kind is in `diary.setKinds` (default `photoset`, `randomSet`), she makes up to `diary.set.pictures[1]` (6) `draw.create` calls in one answer. The mirrors post the staged pictures after the messages as file messages with no text and no reply: one message, split when the pictures exceed `diary.set.maxMessageBytes` (8000000) or 10 files; a single picture of any other kind is a set of one. With fewer than `diary.set.minPosted` (2) pictures staged when the post is due nothing is posted, not even the messages, and the turn ends `refused` with `reason: 'set-short'` (the post is not recorded and the day's post count is not bumped). `diary.set.pictures[0]` (4) is for the prompt; the engine does not enforce it. In dry-run nothing is generated; each `draw.create` call logs `dry-run: would draw` (with `set: true` on a set kind), and a set with fewer calls than `diary.set.minPosted` ends `refused` / `set-short` too.

### The drawing prompt and `{{when}}`

Every drawing request (diary or not) now carries a local time: `draw.md`'s `{{when}}` placeholder is filled with
`labels.draw.when` when the time is known, or left empty. The image model uses it to match the light and the season.

### Recording

After posting, the post is recorded in `diary.json` (`store.appendDiaryPost`, newest `diary.historyPosts` kept): `{ at, kind, gist, picture, messageIds, search }`. `gist` is the post's text collapsed to one line and cut at `diary.gistChars`. `picture` is the scene text (cut the same way) or null. A set post stores the first posted picture's scene as `picture` and adds `pictures` (the count posted); `<diary>` renders it with `labels.diary.pictureSet` when the count is above 1. The day's diary post count is bumped; the picture count is bumped by every picture generated, at generation time, posted or not. The turn's outcome carries `diary: { kind, picture, search, messages, pictures }`.

In dry-run the post is logged and mirrored. Nothing is recorded and no daily counter is bumped.

### Data file

`data/guilds/<id>/diary.json`: `{ posts: [...], updatedAt }`. Posts are newest last, capped at `diary.historyPosts` (150). Each post: `{ at, kind, gist, picture, messageIds, search }`, plus `pictures` on a set post. The file is never deleted by code; clearing `diary.channelId` keeps it.

### Backfill

When `diary.json` has no posts, the first tick with a place of her diary reads up to `diary.historyPosts` of the persona's own messages from that place (REST, oldest first) and store them with `kind: null`, a one-line gist, and `labels.diary.pictureUnknown` as the scene of a message that carried a picture.

### The diary in the server map

The persona's own messages in a place of her diary count toward the channel's `days` and `writers` (one exception to the rule that the persona's lines are not counted). `renderChannel` marks every such place with `labels.server.diary`.

### A mirror place

A place of an enabled diary mirror is written only by the diary's publisher. The core's outbound port refuses every send there (a message, a file, a GIF, a picture, a voice message) from a turn, a wake or a tool with the code `diary-mirror`, worded by `tools.result.reasons.diary-mirror`, and an event there opens no turn. Reactions are not refused.

`message.create` takes `diary` (`true` or `false`, a string choice). With `true` the post goes to her diary in place of a channel ([Diary](diary.md#writing-to-the-diary-from-other-turns)), and `channel` or `reply` beside it is `invalid-args`. The turn's first such call is refused `cap-diary`, worded by `tools.result.reasons.cap-diary`, when `diary.maxPerDay` entries are counted today. The diary turn's writer request does not offer `message.create`. `tools.result.reasons.diary-mirror` tells her to write to her diary with `message.create` and `diary`.

### Logs

`diary: plan` (day, slots count, quiet, carried, hunger, quietStreak), `diary: planned` (kind, brief, search, picture, fallback, pictureAllowed),
`diary: due` (slot), `diary: post` (kind, messages, picture, pictures, search, outcome, reason when the outcome has one, forced),
`turn: set short` (channel, pictures, wanted, dryRun in dry-run), `turn: set posted` (channel, pictures, messages: the file messages sent),
`turn: drew` once per set picture with `set: true`, `turn: draw error` (reason, set) and `turn: draw refused by a limit` (set) for a set picture,
`diary: skip` (reason: `no-channel`, `off`, `paused`, `not-writable`, `cap`, `grace`, `busy`),
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
- The lease applies: a DM that arrives while the persona is busy elsewhere is held as a pending ping.

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

## Limit notices

When a rail refuses a directly requested action (a mention, reply, name trigger, follow-up or private message, not an overheard or spontaneous turn), the
bot posts one plain line from `labels.limits.notice` with `{limit}` (the config key), `{used}` and `{cap}` filled.
Spontaneous turns that hit a rail stay silent. In dry-run the notice is logged and mirrored, not sent.

The config keys that can appear as `{limit}`: `llm.maxRequestsPerDay`, `llm.maxRequestTokens`, `image.maxPerDay`,
`image.maxPerUserPerDay`, `private.maxPerUserPerDay`, `private.maxPerOwnerPerDay`.

Private DM caps post the notice once per person per day (tracked by `replies.noticedDay` in the private file).
An image cap on a `draw.create` call comes back to her as a result (`image-cap-daily`, `image-cap-user-daily`; the
senses line already told her the quota was spent). Video and web daily caps do not block a reply and keep their
in-transcript states; no notice.

## Her memory session and description review

The memory database's session (`src/memory/db/session.js`, `memoryDb.session.mode` `shadow` or `apply`) and the
description review (`src/memory/db/describe.js`). Prompts: `prompts/memory-session.md`, `prompts/description-draft.md`,
`prompts/description-check.md`. They are neutral engine text; the persona comes in through her card, rules and the
memory blocks, as in her turns. The requests go out on the role `memory` (`models.memory`, its own key
`llm.keyByRole.memory`, no fallback to another key), purposes `memory-session`, `description-draft` and
`description-check`. Provider reasoning is never sent: she thinks in `<think>`, then answers.

### Purposes and roles

Each request purpose maps to a role (`src/llm/roles.js#PURPOSE_ROLES`). The memory session and description review sit on their own `memory` role (`src/llm/roles.js#MEMORY_PURPOSES`), outside the main role set:

| Purpose | Role |
|---|---|
| `address`, `room`, `merge`, `route-channel`, `participation-pick`, `rewatch`, `split`, `gif-pick`, `missed`, `lookup`, `planner`, `recall-summary`, `search-summary`, `read-link`, `diary-plan`, `speech`, `web-search` | `analyzer` |
| `reply` | `core` |
| `describe`, `relook`, `avatar` | `vision` |
| `recall-query`, `probe` | `embedding` |
| `memory-session`, `description-draft`, `description-check` | `memory` |

### The live schedule

With `memoryDb.session.mode` `apply` the memory database's tick looks at most once a minute for due scopes: at least
`minMessages` settled lines after the scope's cursor, and either `everyMinutes` since the scope's last run or
`maxMessages` lines waiting, under `sweepsPerScopePerDay`. One sweep runs over the due scopes (one request per scope and
page of people, as below), then the description reviews her runs flagged (a `descriptions` entry of an answer), at most
`reviewsPerDay` a day: the people of her focus close set first when `memoryDb.focus.enabled`, then by the flag's age.
Never two at once.

### Memory session request

System: the same system text her turns get (`system-prompt`, `character-card`, `rules`, `format`, `{{name}}` filled),
then `prompts/memory-session.md`. User content, blocks in this order (stable first; a block with nothing to say drops
out):

- `<self>`: her self facts and lessons, one `[sN] kind: text` line each (`s1`, ...).
- `<place>`: `scope: group|dm`, the places of the batch with a handle each, `[pN] channel: name - topic` (`dm` for a
  private conversation), then the guilds they sit in, `[pN] guild: name`; the current description of each place field as
  `field: text`, then the place's claims as `[cN] kind: text`.
- `<people>`: for each person of this request's page of people (the batch's people, the most active first, at most
  `memoryDb.session.maxPeople` to a request), the profile rendered by `renderProfile` from the profile the database
  rebuilds, `id: <@id>`, `affinity: <number>`, then the person's claims as `[cN] kind: text`. The numbers `cN` run on
  from `<place>`. A batch with more people is sent again, the same lines, with the next page of people.
- `<episodes>`: open episodes with these people, `[eN] date name: what (feeling)`.
- `<intentions>`: her open intentions that concern these people or this place, `status: purpose`.
- `<batch>`: `cutoff: <time>` (the newest line), then the lines in event time (`occurred_at`, then arrival),
  `#n [time] [pN] [aN] name: text`, `pN` being the place handle and `[aN]` the author handle, shown only for authors who are not yet a person; a line addressed to her starts with `→ `; her
  own lines carry her self label (`labels.self`). Times are `YYYY-MM-DD HH:MM` in `bot.timezone`.

Everything in the request apart from the batch (profiles, claims, episodes) is as of the cutoff: what was created or seen
again after it is left out.

One request per scope and page of people: the public channels of an interface together, each private conversation
alone, at most `maxMessages` lines, read after the scope's cursor and never newer than `settleMinutes`.

### Memory session answer

`<think>...</think>`, then exactly one `<memory>` block with a JSON object:

```
{ "claims": [ { "op": "add", "subject", "place", "kind", "text", "how", "sources", "when" },
              { "op": "confirm", "id", "sources" },
              { "op": "revise", "id", "text", "how", "sources", "reason" },
              { "op": "retire", "id", "truth", "reason", "sources" } ],
  "episodes": [ { "subject", "what", "feeling", "sources" } ],
  "affinity": [ { "person", "delta", "reason", "sources" } ],
  "descriptions": [ { "subject", "field", "why" } ],
  "people": [ { "op": "add", "subject", "sources", "reason" } ] }
```

`people` (`people:add`): the `<batch>` renders author handles (`[aN]`) before the name for authors who are not yet
a person. `subject` is the handle `aN` of an account or a thread-local participant that wrote a line
of the batch (the request's `maps.authors`, in order of their first line, her own lines left out); it is dropped as
`unknown_subject` for any other handle, `has_person` when the account already belongs to a person, `no_reason` without a
reason, `bad_op` for an op other than `add`. In `shadow` it is a `decisions` row `proposed:people_add`; in `apply` the
engine mints a tentative person (`person:<uuid>`) with a `proposed` link to the subject and a `decisions` row
`people_add` (rejected whole as `has_person` when the subject gained a person or a live link meanwhile).

`subject` is a person's name or id, `place` or `self`; for a place, `place` names it by the handle the request gave it
(`pN`; there is no default place); `kind` one of `detail`, `interest`, `alias`, `injoke`,
`self_fact`, `lesson`, `pattern`; `how` one of `said`, `saw`, `claimed`, `inferred`, `taught`; `truth` one of
`historical`, `disputed`, `retired`; `field` one of `character`, `style`, `relationship`, `purpose`, `topics`, `tone`,
`patterns`, `starters`, `self_view`. `sources` are the `#n` of the batch.

The engine maps `#n`, `cN`, `sN` and `eN` back to database ids and checks everything it sent. An op is dropped, and
counted by reason in `session_runs.counts`, when: its id is not one the request carried (`unknown_id`), a source is not a
line of the batch (`unknown_source`: the op is dropped whole when any of its sources is unknown, never kept with part of
its evidence), it has no source (`no_sources`), the subject is unknown or a name two people share (`unknown_subject`),
a place op names no place or an unknown handle (`no_place`, `unknown_place`), the kind, `how`, `truth` or field is not in
its list (`bad_kind`, `bad_how`, `bad_truth`, `bad_field`), the text is empty (`no_text`), a revise, a retire, an
affinity change or a description flag has no reason (`no_reason`), an affinity delta is not a non-zero number
(`bad_delta`), or the op is not an object or names another op (`bad_op`). A part that is not a list is dropped
whole (`<part>_not_list`). Nothing is repaired or guessed. A missing or unreadable `<memory>` block is the outcome
`bad_answer` (`no_block`, `bad_json`, `not_object`): no change is made and the cursor stays. An answer in which every
part was dropped (`all_dropped`) leaves the cursor too: the batch stays pending, with a retry count
(`memoryDb.session.retryLimit`), and is skipped with a recorded decision after that many tries. Her whole answer,
`<think>` included, is stored as a `sources` row of kind `memory_session`, scope internal.

A `confirm`, `revise` or `retire` op is written against the claim version the request showed for its `cN` / `sN`: the
engine sets that version as the op's `base` itself, from the request (a `base` in her answer is never read). In `apply`
an op whose claim has gained a newer version by the time it is written is rejected whole as `stale_base` (a `decisions`
row `rejected:stale_base`). What the request rendered (the batch lines, the claims, the place descriptions, the places,
the episodes and the intentions, each with its block and order; not the items inside a profile text) is recorded with
the run as `turn_reads` rows of reader kind `session`, with the claim version, description version and line revision
each showed.

In `shadow` every kept op is a `decisions` row (`by` `her`, `action` `proposed:<op>`, the op in `extra`); in `apply`
the changes land in `claims`, `claim_versions` (with each version's lines in `claim_version_sources`), `claim_sources`, `episodes`, `affinity_events` and `people.affinity`
(the delta is capped by `relationships.maxDeltaPerUpdate`), each with a `decisions` row whose `action` is the op; a
description flag is a `decisions` row only. In `apply` a run is written once (a retried batch returns the first result), an
op whose sources do not all exist is rejected whole, and a claim's scope is the narrowest scope of the run and of the new
sources of the op: when that differs from the claim's own scope (a private line revising a group claim), the change is
written as a new claim of the narrower scope and the old claim stays as it was.

### Description review

Two calls, serial. Call 1 (`description-draft`): her system text, then `<subject>` (`subject`, `kind`, `field`, `cap`
in characters), `<claims>` (each claim with its id, dates, and shown or historical), `<evidence>` (changes since the
last review with their sources), `<samples>` (older lines spread over time); the old description text is not sent.
Answer: `<think>`, `<description>`, `<reason>`. Call 2 (`description-check`): `<draft>`, `<current>` (the stored
description, empty when none) and `<diff>` (the claims the stored text showed and the draft does not, and the reverse,
by a text match); answer: `<think>`, `<description>` (final, may equal the draft), `<reason>`. The final is stored as a
`description_versions` row, the draft in `extra` with the claim and source ids both calls were given, the model and the
hash of both prompts; both whole answers are `sources` rows of kind `description_review`, scope internal. In `shadow` the
row has `origin` `shadow`, is never current and does not move the "last reviewed" mark; in `apply` (authority `db`) its
`origin` is `review` and the same transaction makes it the description's current version. A description's id carries its
scope. A final over the cap is stored as it came, with `extra.overCap`.
