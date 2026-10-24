# Configuration

Every key in `config.json` with its default, grouped by section.

Any string value in `config.json` or `config.local.json` may reference an environment variable as `${env:NAME}` (`NAME` is letters, digits and `_`, not starting with a digit). After the two files are merged, each reference is replaced with the variable's value, so a value that holds credentials can stay in `.env` while the config file holds only the reference. A reference can make up the whole value or part of a longer string. An unset variable becomes an empty string and is logged once as `config: env ref unset` with its name, never a value. Config written by `/nep set` keeps the reference in `config.local.json`; it is resolved again on every reload.

## Where the private files live

By default everything sits in the checkout: `config.json` and `prompts/` (tracked), your `.env`, `config.local.json` and `prompts.local/`, and the `data/` directory the bot writes its memory to. Two optional environment variables let you move the private parts out of the checkout, so a clone or a deploy carries only the code:

| Variable | Default | What lives there |
|---|---|---|
| `NEPTUNIA_PRIVATE_DIR` | the checkout | `.env`, `config.local.json`, `prompts.local/` |
| `NEPTUNIA_DATA_DIR` | `data/` in the checkout | everything the bot writes: `guilds/`, `state.json`, `usage.json`, `metrics.json`, caches |

Set them in the process environment (for example with `Environment=` in the systemd unit), not in `.env`: the bot reads `.env` from the private directory, so it needs to know that directory before it reads the file. A relative path is resolved against the checkout (`src/paths.js`). Editing `config.local.json` or a file in `prompts.local/` inside the private directory still reloads live, without a restart. The tools under `tools/` read the same two variables; a tool's `--data` flag overrides the data path. At start the bot logs the three resolved directories (`index: paths`). `deploy/neptunia-bot.service` shows the recommended layout: one root `/opt/neptunia` with the checkout in `app/`, the private files in `etc/` and the data in `data/`; `deploy/install.sh` sets it up.

## `features`

| Key | Default | Meaning |
|---|---|---|
| `dryRun` | `false` | Full pipeline, never sends. See [Dry run](../README.md#dry-run) |
| `mentions` | `true` | React to @mentions |
| `replies` | `true` | React to replies |
| `nameTriggers` | `true` | React to name mentions in messages |
| `spontaneous` | `true` | Unprompted messages on a random timer |
| `eavesdrop` | `true` | Random chance to jump into any message |
| `memory` | `true` | Build profiles, track server patterns, record self-claims |
| `relationships` | `true` | Per-member attitude scores (-100..100) |
| `episodes` | `true` | Per-person long-term memories (moments, quotes, grudges) |
| `lore` | `true` | Server-wide lorebook |
| `reactions` | `true` | Emoji reactions (the persona places them) |
| `seeReactions` | `true` | Show reactions on messages in the transcript. A missing key counts as on. Distinct from `reactions`, which controls whether the persona PLACES reactions; this one controls whether they SEE them |
| `reactionNames` | `true` | On the persona's own messages, each reaction shows who put it, as a member sees by hovering it: up to `context.reactions.maxNames` names, written the way the transcript names authors, then "+N" for the rest; a reaction whose reactors are not known keeps its count. Other members' messages keep counts. Who reacted is followed live from Discord's reaction events (the non-privileged reactions intent) and kept in process memory only, never stored; after a restart the reactors of her recent messages are fetched once when a transcript shows them. Needs `seeReactions`. A missing key counts as on. See `context.reactions.*` |
| `triggerMarkers` | `true` | In the transcripts the persona and her helpers read, each line she posted names the message that started the turn which posted it (`labels.transcript.triggeredBy`, or `triggeredByOlder` when that message is out of view), so a late answer is not taken for an answer to a newer question. A missing key counts as on |
| `callMarkers` | `true` | In the transcripts the persona reads, a skill call she made shows on her last line of the turn that made it (or, when that turn posted nothing in the channel, as a line of hers at the call's time): the skill, its target, how it went and, for a message it posted, that message's link (`labels.transcript.called`). A message a call posted in another channel says which channel's turn posted it (`labels.transcript.postedFrom`). Rebuilt from the journal at start. A missing key counts as on |
| `previousThink` | `true` | A request carries her one previous think in a `<previous_think>` block: a tool-loop step the think of the step before it, a new turn the think of the latest finished turn tied to the same place within `context.previousThink.minutes` ([Prompt contract](prompt-contract.md)). Off: none is carried; the thinks are still kept for the journal and her memory episodes. Read per request, so it can be switched live. A missing key counts as on |
| `customEmoji` | `true` | List the server's custom emoji ranked by usage so the persona can use them by `:name:`. A missing key counts as on |
| `gifs` | `true` | Build a GIF library from what members share and let the persona post from it by handle. A missing key counts as on |
| `gifPicker` | `true` | When the persona's first message is at most `gifs.pick.maxChars` characters and she chose no GIF herself, a classifier picks a fitting GIF from the full library. On a match the GIF replaces that first message; the remaining messages follow as written. A missing key counts as on. Needs `features.gifs` on and a non-empty library |
| `embedUpdates` | `true` | When Discord attaches a link's embed after the message itself (Tenor GIFs arrive this way), fold it into the memory buffer so the GIF library and the analyzer see the GIF. A missing key counts as on |
| `multiMessage` | `true` | Allow 2–3 messages in a row |
| `mediaDescriptions` | `true` | One-line descriptions for pictures, GIFs, video frames and link thumbnails |
| `videoDescriptions` | `false` | Watch short video clips through a video-capable model; needs `mediaDescriptions` on as well. Turn on in `config.local.json`; still needs a video-capable model and, for site links, `yt-dlp`/`ffmpeg` |
| `videoRewatch` | `true` | When addressed, re-watch a video to answer a question about it; needs `videoDescriptions` on |
| `imageRelook` | `true` | When addressed, look at a picture again to answer a question or check a claimed detail about it (the re-watch classifier's pick, or her own `media.look`); the second look runs through the `vision` helper model like the captions. Shares the daily `media.video.rewatch.maxPerDay` counter with video re-watches. A missing key counts as on |
| `webLookup` | `false` | Read links posted in chat and search the web when asked a factual question. Unlike other features, a missing key counts as OFF. Needs `BRAVE_SEARCH_API_KEY` in `.env` for search; without it only link reading works. See [Media: Links and search](media.md#links) |
| `imageGeneration` | `false` | Let the persona draw pictures through a drawing sub-process. A missing key counts as on. Turn on in `config.local.json`; needs an image-capable model in `models.base.drawing`. See [Media: Drawing](media.md#drawing) |
| `privateMessages` | `false` | Answer direct messages from guild members. Needs a stored public profile and `affinity.score >= private.minAffinity`. See [Messages and memory: Private layer](messages-and-memory.md#private-layer) |
| `privateLikeServer` | `true` | A private chat works like a server channel: the route classifier, channel pull, server search (recall) and asked-about episodes all run in a DM. A pulled channel enters a DM only when the partner has View Channel permission on it. A missing key counts as on. `false` restores the old DM behaviour (no pull, no route, no recall, no asked-about episodes) |
| `channelPull` | `true` | Pull another channel into a turn's request when the recent messages or the trigger contain a real channel mention. A missing key counts as on. See `context.pull.*` |
| `pullSeenMarker` | `true` | Show a line under a pulled channel view's header saying how many of its messages are new since the persona was last shown that channel in this destination, how many of those are older than what it saw then, or that they are the same and no older ones were loaded. Messages are compared by id and content; an edited message counts as new. The comparison is remembered in process memory only, not across a restart. A missing key counts as on. See `context.pull.seenTtlMinutes` |
| `elsewhere` | `true` | Answer a call (@mention, reply, name) from a channel where the bot can read but not send. The answer goes to the first usable channel in `memory.mainChannelIds`. A missing key counts as on |
| `portraitRefresh` | `true` | Refresh a member's portrait by message counters on a periodic schedule. A missing key counts as on |
| `notesRefresh` | `true` | Periodically re-examine channel and server notes from a spread sample of recent messages. A missing key counts as on. See `memory.notesRefreshDays*` and [Warmup: Keeping the notes current](warmup.md#keeping-the-notes-current) |
| `versions` | `true` | Keep a version history of every prose memory field when its text is replaced. Previous texts are stored in `data/guilds/<id>/versions/`. `/nep memory forget` and `/nep memory wipe` delete version files. A missing key counts as on |
| `memoryTwoStage` | `false` | Split the memory analyzer into two stages: a neutral GPT model decides what changed (stage A), then the voice model words the persona's texts (stage B). Must be exactly `true` to enable; a missing key counts as off. See `memory.voice.*` |
| `promptCache` | `true` | Mark the system message, and on the reply the stable user prefix and the profiles (each separately), for the provider's prompt cache. A cached read costs a fraction of normal input; some providers do not count cached reads against token quotas. Must be exactly `true` to enable; a missing key counts as off. See `llm.cache.*` |
| `recall` | `true` | Search the server's own message history beside the web search when a question calls for it. A missing key counts as on. See [Media: Search](media.md#search) and `recall.*` |
| `recallTrace` | `false` | Write one JSON line per recall run to `data/guilds/<id>/recall-trace.jsonl`: the forms, the clusters with their scores and flags, the summary's text and the stretch the persona got. For diagnosing a recall that went wrong; the file quotes members' messages, so it stays under `data/`. Capped at `recall.traceMaxLines`; `/nep memory wipe` deletes it. Must be exactly `true` to enable; a missing key counts as off |
| `meaningSearch` | `false` | On each recall run, embed the asker's message and search the vector index by meaning. Record rows that match by meaning join the word-hit windows; archive rows join the memory items. Combined with word hits through reciprocal rank fusion. Must be exactly `true` to enable; a missing key counts as off. Needs `features.recall` on and the embedding model (`models.base.embedding`) reachable. See `recall.meaningCandidates` |
| `embedIndex` | `false` | Keep the vector index current while the bot runs: every message the record takes is queued, and a batch is embedded every `embed.flushSeconds` seconds or once `embed.batch` lines wait. Must be exactly `true` to enable; a missing key counts as off. Needs `features.meaningSearch` on. Without this switch, the index is built only by `tools/embed-index.mjs` |
| `memoryDb` | `false` | Keep the memory database (`data/<memoryDb.file>`) equal to the JSON memory files while the bot runs: it is opened with a writer lock when the switch turns on and closed when it turns off, filled by a first full import in slices, then synced after each store flush and at least every `memoryDb.syncSeconds`. The JSON files stay the writer. Must be exactly `true` to enable; a missing key counts as off. See `memoryDb` |
| `journal` | `true` | Keep the persona's journal: for every turn, one line when it starts and one when it ends (what of the chat went into the request, its hidden reasoning, what it posted and reacted to, token usage, the limits that cut something), in `data/guilds/<id>/journal/<YYYY-MM-DD>.jsonl` by UTC day; a private chat's turns go to `data/guilds/<id>/private/<userId>/journal/` instead. While on, the live log carries only the length of the hidden reasoning (`thinkChars`). Must be exactly `true` to enable; a missing key counts as off. See [`journal`](#journal) |
| `offPeriods` | `true` | `<now>` lists the periods of the last `journal.offWindowHours` hours when the persona was paused by the owner or the service was off, newest first, at most 3, from the journal's system records. Nothing is posted to any channel. A missing key counts as on. Needs `features.journal` |
| `record` | `true` | Keep the record: every message the memory buffer took (written before the batch is analyzed; a batch the disk refuses stays in the buffer and is retried), every edit as a new line with the next revision, every deletion, each message the persona posted and each feeling she stored on a moment, one line each, in `data/guilds/<id>/record/<YYYY-MM>/<YYYY-MM-DD>.jsonl` by UTC day. Only ids, time, channel, author, reply target, text, media kinds, mentions and, for a posted link with a preview, the link's URL, title, description (cut to 200 characters) and site (at most 3 links) are kept, never the URL of a file. A private chat's lines go to `data/guilds/<id>/private/<userId>/record/` instead. Never trimmed. Must be exactly `true` to enable; a missing key counts as off. See [`record`](#record) |
| `archive` | `true` | Keep the archive: before anything leaves the stored memory (an episode or an interest pushed out by a cap, a recent line or an exchange that expired, a lesson or a self-claim the analyzer removed, an in-joke list rewritten, an attitude move, a diary post or an old note version past its limit, the previous text of an interest changed in place), a copy goes to `data/guilds/<id>/archive/<YYYY-MM>.jsonl` by month (a private chat's items to `data/guilds/<id>/private/<userId>/archive/`). The item stays in memory, over its cap, until the archive confirms the copy; a copy the disk refuses waits in `archive/pending.jsonl` and is retried every `archive.drainMs`. Never trimmed. The same copy is not written twice. Must be exactly `true` to enable; a missing key counts as off. See [`archive`](#archive) |
| `recent` | `true` | Show a `<recent>` block of what happened on the server in the last few days. A missing key counts as on. See `memory.recentHours` and `context.caps.recent` |
| `anchoredWindow` | `false` | The anchored chat window: lines of the current channel older than the `context.channelMessages` window that still matter are shown in an `<earlier>` block of the tail: the messages the trigger and the window's lines reply to (asked for every window line, at most `context.replyParentsMax`; they leave `<chat>` but keep their numbers), and the persona's saved exchanges in this channel of the last `participation.earlierHours` hours (with `participation` on). A request to her she has not answered is marked and kept first. Cap `context.caps.earlier`. Never in a private chat. Off: the parents stay at the head of `<chat>` and there is no block. Must be exactly `true` to enable; a missing key counts as off |
| `participation` | `true` | The persona remembers its own exchanges on other channels over the last few days and, on a server turn, sees a few of them in a `<participation>` block. A missing key counts as on. See [`participation`](#participation) and `context.caps.participation` |
| `channelRoute` | `true` | A classifier picks a channel the conversation is about before a turn, so the channel can be pulled into the request. A missing key counts as on. See `route.*` |
| `turnPlanner` | `false` | One helper call before the reply replaces the channel router, the episode pick, the search classifier and the re-watch classifier; the address classifier and the GIF pick stay separate. Must be exactly `true` to enable; a missing key counts as off. Needs `prompts/planner.md` |
| `channelLinks` | `true` | When the persona writes `#channel-name` of a server channel in a message, the sent message carries a real channel link instead of the literal text. Names are matched longest first; an existing link stays. Off: text goes as written. A missing key counts as on |
| `messageLinks` | `true` | When the persona writes a transcript number like `#93` in a message and that number matches a line of the turn's transcript, the posted text carries a Discord message link to that message (Discord renders it as a clickable jump pill). A number that does not match a transcript line stays as written; code spans and existing URLs are untouched. In a DM the link uses `@me`. The other way round, a Discord message link someone posted that points at a line of the same rendered transcript (`<chat>`, or one pulled channel's `<channel_view>`) reads there as that line's `#93`; a link to anything else stays as posted. A missing key counts as on |
| `mentionHandles` | `true` | Every member with a stored profile gets a short handle derived from their user id (for example `@u7k2f`), listed with their names and aliases in a `<directory>` block, and every author in view carries theirs on their lines. To mention someone the persona writes the handle; only an exact handle becomes a mention, and a name after `@` stays plain text. Off: no directory, no handles, and `@name` is matched against the names the bot knows, as before (kept for rollback). A missing key counts as on |
| `pauseNotice` | `true` | Post a short notice when the persona is called while paused. A missing key counts as on. See `mention.pauseNoticeMinutes` and `labels.limits.paused` |
| `diary` | `true` | The persona posts in one owner-chosen channel on its own, on a random schedule. A missing key counts as on; with no `diary.channelId` set, nothing happens. See [Diary](diary.md) |
| `splitTasks` | `true` | Split a long structured direct call into separate parts, each answered in its own turn. A missing key counts as on. Needs `prompts/split.md` and `labels.task.part` |
| `followUp` | `true` | Classify untagged messages after the persona answers to continue a conversation |
| `typingSimulation` | `true` | Simulate typing speed |
| `adminCommands` | `true` | Owner slash commands; `false` unregisters them |
| `memberCommands` | `true` | The `/nep pings` command, open to every member; `false` restricts it to owners |
| `skills` | `true` | The persona's skill gateway. `false` refuses every skill call, which also silences carried-over reply effects (messages, reactions, drawing): a full stop. A missing key counts as on |
| `skillsDiscovery` | `true` | The lookup classifier and the turn planner can name skills relevant to the message or request the full list on an inventory question. A `<skills>` block with the full list is added on an inventory request (her own tools are sent with every request either way, see `skills.transport`). Off when `features.skills` is off. A missing key counts as on |
| `coreTools` | `false` | Whether her own tools replace the classifiers before her reply. On: no search classifier runs (nor the turn planner's lookup and skills blocks) and no re-watch classifier: she looks things up herself with `web.search`, `web.read`, `media.look` (a picture or a video of a message looked at again with her question by the image or video model, `media.look.maxPerTurn`) and `memory.search` (this server's history through the recall runner, `recall.*`, quoted, no summary), each of which must be granted to her by name, and the automatic memory prefetch may run. A link posted in chat is shown with the opening of its page's text (`web.links.previewChars`), no helper condensing it. Off: the classifiers run as before. Her tools are sent with every request either way, and the step engine runs either way (see `skills.loop`). Must be exactly `true` to enable; a missing key counts as off. See [`skills`](#skills) |
| `memoryPrefetch` | `true` | With `coreTools` on: before a turn that a person's new message opened, search the server's history (the record) and the persona's stored memory once with that message -- by words and, with `meaningSearch` on, by meaning -- and put the few relevant excerpts found in the request as `<retrieved>`, labelled as automatically retrieved candidates, not memories. No model writes the query or reads the results first; trivial messages (empty, commands, bare greetings) are not searched; bounded by `recall.prefetch.deadlineMs`, never blocking the turn. Has no effect with `coreTools` off. A missing key counts as on. See [`recall.prefetch`](#recallprefetch) and [the contract](prompt-contract.md#the-automatic-memory-prefetch-featurescoretools) |
| `missedAnswers` | `true` | Track messages that may have been left unanswered: a failed address classifier, a replaced deferred follow-up, a turn that errored, was dropped or ended not-now. Each becomes a candidate in a registry, journaled as kind `answer`. A missing key counts as on. See [`missed`](#missed) |
| `missedRecovery` | `false` | When the sweep finds owed candidates, start one reply turn to pick them up (trigger kind `missed`, `labels.task.missed`). Off (the default), the sweep classifies and journals only (shadow mode). Must be exactly `true` to enable; a missing key counts as off |
| `offlineCatchUp` | `true` | At start, read the messages posted while the bot was down: in each channel with a newer message than the last one the bot saw, the newest `offlineCatchUp.maxMessages` are fetched and the ones after that last seen message are taken in like live ones, oldest first. A mention, a reply to the persona or her name younger than `offlineCatchUp.windowMinutes`, with no message of hers after it in that channel, is answered as it would have been live; older ones are only remembered. A message the gateway also delivers is handled once. Nothing while paused. A missing key counts as on. See [`offlineCatchUp`](#offlinecatchup) |
| `around` | `true` | The persona sees, at the corner of her eye, what a member sees in Discord's sidebar right now. Each person the request is about gets an entry in `<people_now>` (in the tail of the request): a heading with their handle and name, then one labelled line each for whether they sit in a voice channel (which one, for how long when the bot saw them join, muted, deafened, streaming, camera, each yes or no) and their current activity (playing, streaming, listening to (a Spotify track with its artist), watching, or none). People sitting in a voice channel who have no profile in the request get an entry of their own. When the data cannot tell, the line says unavailable or stale instead of no. Custom statuses are never shown. A live snapshot in process memory, never stored, logged or backed up. Activities need `discord.intents.presences`; without it they read unavailable and only voice channels show. The Discord status (online, idle, do not disturb, offline) is never shown. Not shown in a private chat or a diary post. Off: the entries keep only what memory holds (the attitude, its recent moves, the message count). A missing key counts as on. See `context.around.maxTokens` and [`discord`](#discord) |
| `avatars` | `false` | The persona knows what each member's avatar looks like. Every member with a profile (never a bot) gets their current avatar (the server avatar when set, else the account one) described once by the vision model in one short line, kept in their profile and shown in it; a new avatar replaces the old description, no history is kept. Discord's default avatar is noted without a request. A background queue, one request every `avatars.intervalMs` at most and `avatars.maxPerDay` a day; it never delays a reply. Needs `prompts/avatar.md`. Changed avatars are seen at once with `discord.intents.members`, else at the member's next message or the daily scan. Must be exactly `true` to enable; a missing key counts as off. See [`avatars`](#avatars) |
| `intentions` | `false` | The persona keeps intentions: things she means to do later, set by her own `intent.set` call or proposed by the memory analyzer from her own lines and confirmed by her (`intent.update` with `state:pending`, or rejected with `intent.cancel`). Each has an expiry; one may wait for one of her errands until a deadline, and when the errand ends (or the reconciliation at start finds it ended, gone or past the deadline) it is open again with the outcome noted. Every turn but a diary post shows them in `<intentions>` (the tail, after `<tasks>`). With `innerLife` on, one that comes due wakes her for an inner turn. Off: the `intent.*` skills do not exist for her, `/nep task intent` answers `feature-off`, the analyzer is not asked, and every request is as without the feature. Must be exactly `true` to enable; a missing key counts as off. See [`intentions`](#intentions) and [Intentions](intentions.md) |
| `innerLife` | `false` | The persona wakes on her own for a reason: an intention of hers comes due (with `intentions` on), a wait for one of her errands runs past its deadline, or her one review of the day comes (a random moment inside the hours she usually speaks in, from her own lines in the record, drawn again every day). A scheduler lists what is due every `innerLife.tickSeconds`, no model choosing; each item is a wake that waits while people's turns hold her attention, and wakes about the same conversation run as one inner turn. An inner turn has no message from anyone: her request carries `<wake>` (why she is awake, the time, what is left of her budgets) and the task `prompts/inner.md`, she may use her tools, post through an explicit call, or end silent. `innerLife.mode` `shadow` (the default) runs nothing but her reads and records what she would have done; `live` lets her calls run on her own grants. Bounded by `innerLife.caps`. `/nep task inner` stops and starts it. An attention of hers (`intent.set attend=<place>`) adds a wake source: new lines in that place since her last look there, once the place has been quiet `innerLife.attention.settleSeconds`. Must be exactly `true` to enable; a missing key counts as off: nothing is listed and nothing is written. See [`innerLife`](#innerlife) and [Inner life](inner-life.md) |

## `skills`

| Key | Default | Meaning |
|---|---|---|
| `safeMode` | `false` | Only the persona's carried-over reply effects pass (the speech tags of a normal reply, `<msg>` and `<react>`, and the `message.create`, `message.react.add` and `draw.create` tools, aimed at the current conversation). Every other skill is refused. Must be exactly `true` to enable |
| `resultMaxChars` | `4500` | How many characters of a skill's returned data are shown in a call's result (the tool message that answers it). The text is cut at a word boundary with an ellipsis |
| `markTextMaxChars` | `200` | When a skill call did not work and no specific label words its reason (a missing or wrong argument, a message not found or not hers, a channel she may not write in), the call's mark in the persona's transcript carries the operation's own message, ahead of the general reason phrase, because it says what exactly went wrong (for example a diary that has no channel set). On one line, cut to this many characters with an ellipsis. Kept in memory only: after a restart such a mark shows the general reason. `0` = never show the operation's message |
| `destructiveCooldownMinutes` | `10` | Minutes between two destructive skill calls from the same channel. A destructive skill (one whose effect is `destructive` in `src/ops/effects.js`) called sooner is refused with reason `cooldown` |
| `callTimeoutMs` | `120000` | How long a skill call may run before its outcome is reported as `unknown` and the call is never retried |
| `transport` | `"native"` | How her tools reach the model. `native`: the tools go in the request's `tools` field and her calls come back as structured tool calls. `text`: the same tools are described in a `<tools>` block of the prompt and she writes each call as a `<tool_call>` block with JSON. Read once at the start of a turn and kept for the whole turn; changing it affects the next turn only |
| `loop.maxSteps` | `3` | The most further requests one turn makes after her calls (the requests that carry the results back to her, each appended to the previous ones). The last of them is always the final one: she is told it is the last step, a call in her answer to it gets a `loop-cap` result that only the journal keeps and her speech is held. An inner turn ([Inner life](inner-life.md)) uses `innerLife.loop` instead of `skills.loop`: people wait for an ordinary turn, nobody for an inner one |
| `loop.timeBudgetMs` | `20000` | How long the calls and follow-ups of one turn may run, counted from its first call. Once it is spent, the next request is her last. Each call runs at most for what is left of it (2 seconds at least) or `callTimeoutMs`, whichever is smaller. Not an inner turn's: see `innerLife.loop.timeBudgetMs` |
| `loop.maxCallsPerStep` | `4` | The most calls of one answer that run; each one past it gets a `loop-cap` result and is counted in the turn record. Not an inner turn's: see `innerLife.loop.maxCallsPerStep` |
| `loop.stepReserveTokens` | `6000` | The room the first request leaves under `llm.maxRequestTokens` for the requests that follow her calls: the sections of the first request share the cap less the tools field (native) and less this many tokens, on both transports, so a step's results (`resultMaxChars` each, up to `maxCallsPerStep` of them) and its note still fit when the context is full. Without it a full context left no room, and a call that needed a follow-up (a search) ended the turn with the loop cut by tokens. The continuation request is measured against the same prompt rail (`llm.maxRequestTokens` x `llm.safetyMargin`); the output budget is separate. `0` = no reserve. Applies to every turn, an inner turn's included |

## `discord`

| Key | Default | Meaning |
|---|---|---|
| `intents.presences` | `false` | Request the privileged Presence intent, so the persona can see members' activities (`<people_now>`). Read once at startup: intents are fixed when the bot logs in, so a change needs a restart. The intent must also be switched on for the bot in the Discord Developer Portal; requesting a privileged intent that is not enabled there makes the login fail and the bot stays down. Off: activities are unknown and not shown |
| `intents.members` | `false` | Request the privileged Server Members intent (member events and a fuller member cache). Same rules as `intents.presences`: read once at startup, needs the Developer Portal switch first, a restart to change. `features.avatars` uses its member and user updates to see a changed avatar at once; without it a change is seen at the member's next message or the daily scan |

The voice-state intent (the voice channels in `<people_now>`) is not privileged and is always requested.

## `bot`

| Key | Default | Meaning |
|---|---|---|
| `timezone` | `"UTC"` | Timezone for model timestamps |
| `owners` | `[]` | User IDs for owner commands |
| `commandName` | `"nep"` | Slash command name (lowercase `a-z 0-9 _ -`, up to 32 chars; re-registered on change) |
| `nameTriggers` | `[]` | Extra trigger strings besides @mention |
| `guildId` | `""` | Server to lock to; auto-detected if in exactly one |
| `dryRunChannelId` | `""` | Channel for the dry-run mirror. See [Dry run](../README.md#dry-run) |
| `access` | `{}` | Who besides owners may run which commands (managed by `/nep access`) |

## `models`

The models sit in three groups, the same three the `/nep status` card shows. Each role is set independently with its own default, so changing one never moves another. `models.byPurpose` pins a single purpose to a model of its own whatever its role.

- **`models.base`: her core and organs.** The roles the bot's own requests go out on, through its own client. The core decides and speaks as the persona; each helper gathers, describes, extracts or finds and hands the core an attributed report; drawing is one Images API request with no loop.
- **`models.errands`: delegated agents.** Each runs its own [OpenCode](https://opencode.ai) loop as a separate process and answers later, asynchronously. See [Errand agents](agents.md).
- **`models.development`: outside her.** Agents that work on this repository, not on the persona's behalf; the engine only describes them and shows their spend.

### `models.base`

| Key | Default | What it does |
|---|---|---|
| `core` | `"anthropic/claude-opus-4.6"` | The persona's model, a string. Purposes: `reply`, `memory-voice` (the memory texts worded in its voice) |
| `memory` | `"anthropic/claude-opus-4.6"` | The model of her memory session and description review (`memoryDb.session`), a string. Purposes: `memory-session`, `description-draft`, `description-check`. It is her voice like the core, but a role of its own: the same default as `core`, not a copy of it, and `/nep model` does not list it. Provider reasoning is never used on it. Its key is `llm.keyByRole.memory` and never falls back to another key |
| `analyzer` | `"openai/gpt-6.1-sol"` | The core's helper model. Picks one of a few given options (address, room, merge, route-channel, participation-pick, rewatch, split, gif-pick, missed), plans a search and turns sources into notes (lookup, planner, recall-summary, search-summary, read-link, diary-plan), and runs the persona's own `web.search` on the `openrouter` engine (web-search). Pin one purpose to another model with `byPurpose` |
| `extractor` | `"openai/gpt-6.1-sol"` | Turns conversations into stored memory: analyzer batches, portraits, channel and server notes, warmup, backfill |
| `vision` | `"google/gemini-3.8-flash"` | Describes a picture (describe, relook, avatar) |
| `video` | `"google/gemini-3.8-flash"` | Watches a video and looks at it again |
| `embedding` | `"openai/text-embedding-3-large"` | Turns text into vectors for search by meaning. `embed.dimensions` (default 1024) sets the width. Probed by `/nep status` with a one-input embedding request; without an embedding client the line says it was not checked |
| `speech` | `"elevenlabs/eleven-v4"` | Speaks her text aloud through OpenRouter's speech endpoint. Shown by `/nep status`, never probed |
| `drawing` | `"openai/gpt-image-2.5-flare"` | Generates the persona's pictures through OpenRouter's Images API (the bot's own client, so a bare OpenRouter image model id). Only `openai/*` and `google/*` families are supported |

### `models.byPurpose`

| Key | Default | What it does |
|---|---|---|
| `byPurpose` | `{}` | Per-purpose model override: an object whose keys are purpose strings (e.g. `reply`, `lookup`, `recall-summary`, `diary-plan`, `planner`, `web-search`) and whose values are model ids. A match on purpose wins over the role's model, the core's included. Not probed by `/nep status` |

### `models.errands`

| Key | Default | What it does |
|---|---|---|
| `scout` | `"openrouter/openai/gpt-6.1-sol"` | OpenCode model id of the `scout` errand agent (the internet). See [Errand agents](agents.md) |
| `server` | `"openrouter/openai/gpt-6.1-sol"` | OpenCode model id of the `server` errand agent (this machine) |

### `models.development`

| Key | Default | What it does |
|---|---|---|
| `thinker` | `"openrouter/anthropic/claude-opus-5.5"` | OpenCode model id of the development agent that picks up and steers the coding tasks; it runs outside this engine and reads its model from here |
| `dev` | `"openrouter/anthropic/claude-sonnet-5.5"` | OpenCode model id of the coding worker, which runs outside this engine and reads it from here |
| `writer` | `"openrouter/anthropic/claude-opus-4.6"` | OpenCode model id of the development agent that writes the texts (prompts, documents); it runs outside this engine and reads its model from here |

The errand and development roles run on OpenCode, not through the bot's own OpenRouter client: they take OpenCode model ids (`openrouter/<vendor>/<model>`: the provider first), unlike the base roles' bare OpenRouter ids (`<vendor>/<model>`). No request of the bot goes out on them, so `/nep status` does not probe them and `/nep route` cannot route them.

`memory.voice.*` is the settings section of the memory-wording stage (purpose `memory-voice`), not a role.

## `llm`

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `"https://openrouter.ai/api/v1"` | Chat completions endpoint |
| `temperature` | `1` | Sampling temperature |
| `maxOutputTokens` | `2000` | Max output tokens |
| `maxRequestTokens` | `50000` | Hard token cap per request |
| `safetyMargin` | `0.9` | Budgeting fraction of maxRequestTokens |
| `timeoutMs` | `300000` | Request timeout (ms) |
| `probeTimeoutMs` | `30000` | Timeout of each model probe and of the key and activity reads on the owner's `/nep status` card (ms) |
| `helperTimeoutMs` | `30000` | Timeout for a helper that runs alongside the turn (the route classifier, the search classifier and the recall summary). A helper that runs past this limit is abandoned; the turn continues without its result |
| `retries` | `2` | Retries on transient HTTP errors (408/429/5xx) and network failures. A provider account's daily-quota 429 gets one attempt and is thrown at once, not retried |
| `maxRequestsPerDay` | `5000` | Daily request cap |
| `provider` | `null` | OpenRouter `provider` routing object, passed verbatim; `null` sends nothing |
| `providerByModel` | `{}` | Per-model provider routing; see below. A route may carry `"byok": true` (never sent to OpenRouter): an answer to a request on that route that OpenRouter served from its own capacity instead of your provider account (`usage.is_byok` is `false`) is logged as `llm: not byok` and fails without a retry |
| `keyByRole` | `{ "scout": "OPENROUTER_ERRAND_KEY", "server": "OPENROUTER_ERRAND_KEY", "drawing": "OPENROUTER_ERRAND_KEY", "thinker": "OPENROUTER_DEV_KEY", "dev": "OPENROUTER_DEV_KEY", "writer": "OPENROUTER_DEV_KEY", "memory": "OPENROUTER_MEMORY_KEY" }` | Maps a role name (`core`, `analyzer`, `extractor`, `vision`, `video`, `embedding`, `speech`, `drawing`, `scout`, `server`, `thinker`, `dev`, `writer`, `memory`) to the NAME of a `.env` variable holding an OpenRouter key. Read at every request. Only names matching `OPENROUTER_[A-Z0-9_]+` are accepted; a role not in the map, a bad name or an unset variable goes out on the main key `OPENROUTER_CORE_KEY`; a bad or unset main key logs `llm: role key missing` once. The role `memory` (her memory session) is the exception: its key is `OPENROUTER_MEMORY_KEY`, and with that variable unset the session is not configured (`/nep status` says so) and no request goes out on any other key. `/nep status` shows each extra key's limit and rolling spend. Defaults: `scout`, `server` and `drawing` on `OPENROUTER_ERRAND_KEY` (shown on the card as `errands`), `thinker`, `dev` and `writer` on `OPENROUTER_DEV_KEY` (shown as `development`). A role mapped to `OPENROUTER_SIM_KEY` appears on the simulator key's line, with no line of its own. The bot sends no request on the OpenCode roles; with a variable unset in `.env` the card shows no line for it (the main key is never shown as theirs) |
| `cache.ttl` | `"1h"` | Cache TTL of the markers on the system message and on the reply's stable user prefix (the stable `<senses>` lines, `<self_facts>`, `<about_chat>`, `<gifs>`): `"1h"` or `"5m"`. Also the length of the bucket over which the stable prefix holds what memory changes (`<self_facts>`): a change shows at the next bucket edge |
| `cache.profilesTtl` | `"1h"` | Cache TTL of the separate marker on the reply's profiles (`<people>`): `"1h"` or `"5m"`; `null` or `false` = no marker there. Never longer than `cache.ttl` (a `"5m"` `cache.ttl` makes it `"5m"`) |
| `cache.roles` | `["core"]` | Request roles whose system message (and, for the reply, the stable user prefix and the profiles) gets the cache marker. Memory-voice requests opt out, so only the reply is cached. Add `analyzer` to cache the helpers' stable parts too |
| `cache.models` | `["anthropic/"]` | Model id prefixes (case-sensitive) whose provider accepts the `cache_control` marker. A request to a model outside the list is sent without one |
| `cache.promptIncludesCached` | `true` | Whether the provider's reported `prompt_tokens` already includes cached and cache-write tokens. Set once from a probe; the token calibration and the per-request cap use the full count either way |
| `hedge.roles` | `["analyzer"]` | Request roles whose calls are hedged (two concurrent attempts, first to finish wins) |
| `hedge.afterMs` | `2500` | Milliseconds before the second attempt starts. `0` or below turns hedging off for all roles |
| `hedge.timeoutMs` | `8000` | Milliseconds from the first attempt's start at which both are aborted if neither has returned |
| `hedge.longTimeoutMs` | `20000` | Timeout used instead of `timeoutMs` when the caller marks the request `long: true` (the route classifier does this for a large channel list) |

`llm.provider` sets a default OpenRouter provider routing on chat requests, for example `{ "ignore": ["some-provider"] }` or `{ "order": ["anthropic"], "allow_fallbacks": true }`. `llm.providerByModel` adds per-model overrides: each key is a model id prefix (matching any role) or `<prefix>@<role>` (matching one role only), and each value is an OpenRouter routing object sent verbatim, except the engine's own `byok` key, which is never sent.

For one request the provider is resolved in order: a per-call pin (the video describer uses `media.video.provider` for the direct-URL path), then the longest matching prefix among `providerByModel` keys for the request's role, then the longest matching prefix among role-less keys, then `llm.provider` (for image requests `image.provider`), then nothing. A role-specific key always beats a role-less key for the same model. Role names: `core`, `analyzer`, `extractor`, `vision`, `video`, `embedding`, `drawing`.

Example: `"google/": { "only": ["google-vertex"], "allow_fallbacks": false }` routes all Google models through Vertex, while `"google/@video": { "only": ["google-ai-studio"], "allow_fallbacks": false }` sends the video role through AI Studio.

If the OpenRouter account itself restricts allowed providers, ignoring the only one left makes every request fail with "No endpoints found". After changing provider settings, check `/nep status` to verify that every model role is reachable; each role follows its `llm.providerByModel` route, so the provider shown is the one that route selects.

With `features.promptCache` on, the system message is marked for the provider's prompt cache on requests whose role is in `llm.cache.roles` and whose model starts with a prefix in `llm.cache.models`. On the reply, two more markers follow in the user message: one at the end of the stable prefix (`llm.cache.ttl`) and one at the end of the profiles (`llm.cache.profilesTtl`); three of the provider's four markers in all. See "Cache segments" in the [prompt contract](prompt-contract.md). Three helper requests send their user message in two parts so the provider can cache the bulk that repeats between calls: the GIF picker (the `<gifs>` library), the route classifier (the `<channels>` list) and the participation pick (the `<episodes>` list) tag that first part with the same `cacheSegment: 'stable'` (marker TTL `llm.cache.ttl`); the per-turn text follows untagged. The marker is placed only when the helper's role (`analyzer`) is in `llm.cache.roles` and its model matches `llm.cache.models`; add `analyzer` to `llm.cache.roles` to cache them. The markers go on after the token estimate, so the 50k per-request cap and the calibration are unaffected. `llm.cache.promptIncludesCached` tells the engine how the provider reports cached tokens; set it once from a real probe. The `llm: usage` log line gains `cache`: `write`, `read`, `none` or `off`.

The `llm: usage` log line also carries `ms` (wall time of the request), `purpose` (a short string naming what the request was for, e.g. `route-channel`, `recall-summary`, `address`), `origin` (e.g. `replay` for the requests of `tools/replay.mjs`), `hedged` (true when the request was hedged) and `attempt` (1 or 2 for hedged requests, absent otherwise).

With `llm.hedge` configured, requests on the roles it lists are hedged: a second attempt fires `llm.hedge.afterMs` after the first, and the first to finish wins. Both are aborted at `llm.hedge.timeoutMs` (or `longTimeoutMs` for a `long: true` request). This adds one extra request per hedged call that did not finish before the second started; both count against `llm.maxRequestsPerDay`.

## `memoryDb`

The memory database (`features.memoryDb`). One SQLite file holding the memory in a new shape, kept equal to the JSON memory files by a sync that runs off the turn path, in a worker thread: the worker holds the writer connection and runs the passes and the turn records; the main thread only reads.

| Key | Default | Meaning |
|---|---|---|
| `file` | `"memory.db"` | The database file under `data/`. Only the bot writes it (a lock file `<file>.lock` names the process); the tools open it read-only |
| `syncSeconds` | `60` | The longest gap between sync passes. A pass also runs soon after each store flush. A pass reads only the files that changed since the last one (a month of vectors that only grew reads just its new rows). The first pass on an empty database is the full import |
| `closeTimeoutMs` | `10000` | At shutdown (or when the switch turns off), how long to wait for the pass under way and for the worker to close the database before the worker is terminated. A pass cut short is safe: the next start takes it up again |
| `read` | `false` | Needs `features.memoryDb`. The store takes a memory file's first load, and the list of ids under a directory, from the database instead of the JSON files, once the process has synced. A file the database does not hold, or holds behind the disk, is read from the disk as before. Writes are unchanged. Must be exactly `true` to enable |
| `authority` | `"json"` | Who writes the memory: `json` (the JSON files; the default) or `db` (the database). Separate from `read`: the read switch never unlocks a write. `session.mode` `apply` and the description review's `apply` need `db` (otherwise the status code `APPLY_JSON_WRITER`, and the writer refuses inside its transaction). While `json`, the JSON-to-database sync runs; while `db`, the sync is off (no tick pass, no pass after a flush, no pass at shutdown) and the status says so. Any other value counts as `json`. This is the switch and its guards only; moving the writers to the database is a separate piece of work |
| `diaryMedia` | `false` | Needs `features.memoryDb`, the first import done and `diary.channelId`. The core keeps its own copy of the diary: for every diary post that has Discord message ids and no text yet, it fetches those messages through the interface (at most one fetch a second), stores the post's text in the database and saves each picture under `data/media/diary/` (size cap `image.referenceMaxBytes`, timeout `context.vision.fetchTimeoutMs`), with a `media` row that carries the post's scope. The diary in the database is the one truth: a post whose messages are all gone keeps what the database holds, with an empty text, and is not asked for again. A failure leaves the post for the next start. New posts are picked up after the next sync. Must be exactly `true` to enable |
| `session` | see below | Her memory session and description review, an object (below). Needs `features.memoryDb`, the first import done and the key `OPENROUTER_MEMORY_KEY` |
| `diaryAudioMaxBytes` | `8388608` | Size cap for an audio attachment (a voice message, mp3, m4a, wav) of a diary post that the `diaryMedia` job saves next to the pictures under `data/media/diary/` (same numbering and timeout). The `media` row's `extra` carries `voice`, the voiced text and the duration when known. A post saved before audio was kept is fetched again once if it has a `voice` field and no audio row |
| `focus.enabled` | `false` | Needs `features.memoryDb` and the first import done. Once per UTC day, at a tick, the relationship counts of yesterday and today are counted again from the stored lines (a line of theirs addressed to her or replying to hers, a line of hers replying to theirs or naming them; a day is meaningful for a person when both happened) and her focus set is computed again with the `focus` settings, in the worker. Nothing reads the set unless `innerLife.heartbeat.focusSource` is `db`. Must be exactly `true` to enable |
| `turnReads` | `true` | Needs `features.memoryDb`. After a turn's request is built, record which memory rows it carried (profile items, channel and guild notes, lore, recent lines, participation episodes, retrieved sources) in the database, one transaction per turn step. Each row is resolved when the request is assembled, not later: the block it was rendered in, its order in the request, the exact claim or description version and the source revision. Only the write is deferred. A missing key counts as on |
| `wakeRuns` | `false` | Needs `features.memoryDb`. Each inner turn is recorded as a wake run (`wake_runs`, schema 11): its kind, what its view showed (ids with their versions), the envelope's policy version, each of its actions once by its number (a restarted run records nothing twice) and how it ended (`succeeded` or `failed` with the outcome). At each open of the database, a run left `running` for longer than `innerLife.loop.timeBudgetMs` becomes `interrupted`. The journal and the inner state file are unchanged. Must be exactly `true` to enable |
| `skillsRegistry` | `false` | Needs `features.memoryDb`. At each open of the database every skill is registered (`skills`, `skill_versions`, schema 11) with the hash of its definition and of its operation's source file, the hash of its manifest (what it may reach: tools, destinations, network, file access, capabilities) and the engine commit (`git rev-parse HEAD`, else `unknown`). A skill's first version is active; a later one is a candidate until its evaluations allow it. Nothing reads the registry yet. Must be exactly `true` to enable |
| `observeLive` | `false` | Needs `features.memoryDb`. Every message memory observes (her own, the server's and a private chat's) and every edit the record writes is also written to the database as an observation (the interface's account, place and line, with its replies and mentions), through the database's writer and never on the message's path. While the JSON files are the writer the observation lands on the rows the sync writes: a line the sync already holds is that line, and a line written first by the observation is taken over by the sync when its file brings it. An edit's revision is counted by the database. `tools/memory-db.mjs observe-check --db <file> --since <iso>` lists the lines only one side wrote. Must be exactly `true` to enable |
| `audienceColumn` | `false` | Needs `features.memoryDb`. Every read of the memory database (recall, her memory session, the description review, the hidden-DM hint) filters rows by their `audience_id` (`aud:none`, `aud:group:<interface>`, `aud:dm:<DM place>`) instead of the three scope columns. Both give the same rows: every writer fills both from one resolver. Off, the scope columns are read as before. Must be exactly `true` to enable |

### `memoryDb.session`

Her memory session (`src/memory/db/session.js`): she reads the new chat lines of one scope (all the public channels of an interface together, each private conversation alone) and says what she keeps, in her own voice, on the model `models.memory` and the key `llm.keyByRole.memory`. Provider reasoning is never sent. A scope is read after its own cursor in the database (`meta`, one cursor per mode and scope), so a line is read once. The description review (`reviewDescription`, `src/memory/db/describe.js`) is two calls on the same model.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `"off"` | `off`: nothing runs. `shadow`: every proposed change is written as a `decisions` row (`by` `her`, `action` `proposed:<op>`, the whole op in `extra`) and one `session_runs` row per request; no claim, episode or attitude is touched. `apply`: the changes are written to the database (claims with their versions and sources, episodes, attitude events, decisions); refused with the status code `APPLY_JSON_WRITER` while `memoryDb.authority` is not `db`, because the JSON files are still the writer then. A run is applied once: a retried batch returns the first result and changes nothing; the cursor moves in the same transaction as the last write, by compare-and-set. Her whole answer, `<think>` included, is stored as a `sources` row of kind `memory_session` (scope internal). Any mode other than `shadow` and `apply` is refused by the writer |
| `maxMessages` | `200` | The most lines in one request |
| `minMessages` | `5` | A scope with fewer new lines waits for more |
| `sweepsPerDay` | `4` | The most sweeps (one pass over every scope with new lines) per UTC day |
| `settleMinutes` | `10` | Lines newer than this many minutes are left for the next sweep, so a conversation under way is not cut |
| `since` | `null` | An ISO date; a scope with no cursor starts at the first line from this date on (null: the first line there is) |
| `maxPeople` | `12` | The most people shown in one request, the most active in the batch first. A batch with more people is sent again with the next people, one request per page of the same lines; every person of the batch is a subject in exactly one of them |
| `retryLimit` | `3` | How many sweeps an `all_dropped` batch (every part of her answer dropped) is tried again before it is skipped: the cursor moves past it and a `decisions` row records the skip. Until then the batch stays pending, visible in the session status with its retry count |
| `claimsPerPerson` | `30` | The most claims listed with their ids for each person |
| `selfMax` | `40` | The most of her own claims listed |
| `episodesMax` | `20` | The most episodes listed |
| `maxOutputTokens` | `4000` | The answer's token limit for a session request |
| `timeoutMs` | `300000` | The timeout of a session request |
| `descriptionMaxOutputTokens` | `1500` | The answer's token limit for each call of a description review |

The status of the session (`off`, `not_configured` while the key variable is unset or blank, `apply_refused`, or the last sweep's outcome) is part of the memory database's state. A missing key means no request at all: the session never runs on another key.

## `capture`

Foreign capture (`src/memory/db/observe.js`, schema v8): when the persona writes, is mentioned or is replied to in a place her connection does not read continuously (a foreign thread, a wall, a post's comments), the adapter fetches the context around that line and the core stores it as a bundle with a coverage that says what was fetched and what was not. Not wired to a live adapter yet. The numbers are a first fetch and a page size, never a ceiling: a bundle grows by further expansions, up to the whole thread, and no number makes a bundle count as complete. Read at the moment of use.

| Key | Default | Meaning |
|---|---|---|
| `ancestors` | `2` | The reply chain above the anchor line in the first fetch |
| `before` | `3` | Lines before the anchor in thread order in the first fetch |
| `after` | `3` | Lines after the anchor in thread order in the first fetch |
| `pageLines` | `60` | The most lines one expansion writes. What does not fit is handed back to the caller and the bundle's coverage says `pending_expansion` until a further expansion adds it |
| `watch` | `[15, 120, 1440]` | Minutes after the anchor line at which a watch looks again for new direct replies and mentions; a watch that cannot run records `unavailable` |
| `watchSameAuthor` | `20` | The most later lines of authors already in the bundle that one watch asks for, where the site allows it |

## `graph`

The memory graph (`src/memory/db/graph.js`, schema v9): the typed memory rows projected into nodes and edges, each edge with the audience of the row it came from, and the walks over it (everything a person said anywhere, what happened in a place and the places it contains, who replied to a line, the places that continue a place). A walk only follows edges and reaches nodes the reading context may see. These are the defaults of a walk; a caller may ask for less. Read at the moment of use.

| Key | Default | Meaning |
|---|---|---|
| `maxDepth` | `6` | How many edges a walk follows from where it starts. A walk that stopped there with further edges says so (`reason: depth`) |
| `maxRows` | `2000` | How many paths a walk visits before it stops and says so (`reason: rows`), with the position the next page starts from |

## `focus`

Her focus set (`src/memory/db/focus.js`, schema v10): the people her own attention is on, the close set and a few exploring candidates outside it, computed by the job `memoryDb.focus`. It governs her attention (the heartbeat's people block with `innerLife.heartbeat.focusSource` `db`), never recognition. Each person gets a score: the weights below times affinity (the profile's attitude, -100..100 taken as 0..1; none counts 0.5), reciprocity and shared interest (both 0.5 until her memory sessions record them), recency of the last meaningful day and consistency of meaningful days, plus a novelty bonus after a first meaningful exchange. Every change of the sets and every challenge is kept in `focus_events`. The owner's pins and exclusions (`focus_overrides`) go first: an excluded person is never in the set, a person whose every verified account is a bot is never close, a pinned person is close within the size (pins over it are reported, the size is not widened), and a new member is safe from challengers while it settles. Read at the moment of use.

| Key | Default | Meaning |
|---|---|---|
| `policyVersion` | `1` | The version of these rules, stored with every member and event; change it when the rules or weights change |
| `size` | `24` | The most people in the close set. Fewer when fewer pass the entry bar |
| `exploring` | `4` | The most exploring candidates: the best scored people outside the close set after at least one meaningful exchange, with no negative attitude, never excluded and never bots |
| `exploringShare` | `0.15` | The share of `innerLife.heartbeat.people` the exploring candidates get in the heartbeat's people block (rounded, at least one when there are any) |
| `entryAffinity` | `0.6` | The entry bar: the attitude, taken as 0..1, a person needs to enter the close set. A negative attitude never holds a close slot unless pinned |
| `margin` | `0.08` | How much a challenger's score must beat the lowest member that can be replaced by |
| `confirmHours` | `24` | A challenger (or a person taking a free slot) must hold its lead at computations at least this many hours apart, with none between where it did not |
| `maxMovesPerWeek` | `2` | The most changes of the close set in any 7 days: a free slot taken is one, a replacement (one leaves, one enters) is one. Exclusions, bots, a negative attitude and pins are not counted. The first computation ever fills the set at once |
| `settleDays` | `21` | A new close member cannot be replaced by a challenger for this many days (a pin still goes first) |
| `weights` | `{ "affinity": 0.55, "reciprocity": 0.15, "sharedInterest": 0.1, "recency": 0.1, "consistency": 0.1 }` | The weights of the score's parts |
| `noveltyMax` | `0.12` | The novelty bonus right after a first meaningful exchange; it halves every `noveltyHalfLifeDays`. None with a negative attitude |
| `noveltyHalfLifeDays` | `14` | The half-life of the novelty bonus (days) |
| `recencyHalfLifeDays` | `60` | The half-life of recency (days since the last meaningful day) |
| `consistencyDays` | `28` | The window in which meaningful days are counted for consistency |
| `consistencyCap` | `8` | Meaningful days in that window that give full consistency |

## `embed`

| Key | Default | Meaning |
|---|---|---|
| `dimensions` | `1024` | Dimensions requested from the embedding model. A smaller value is faster and cheaper when the model supports truncation |
| `batch` | `64` | Lines flushed in one embedding request by the live queue (`features.embedIndex`) |
| `flushSeconds` | `180` | Seconds between live queue flushes. A flush also runs when `embed.batch` lines are waiting |
| `queueMax` | `2000` | Lines the live queue holds in memory. The oldest are dropped when the queue is full |
| `catchUpHours` | `72` | At start, when the embedding switches turn on, on resume and hourly, the queue re-embeds anything from the last this many hours that the index is missing. An hourly `embedder: coverage` log line reports the count |
| `catchUpEveryMinutes` | `60` | Minutes between catch-up sweeps while the bot runs. Each sweep covers the last `catchUpHours` |

Each message the record takes is embedded with its two preceding lines of the same channel as context, so a short answer carries what it answers; a line's link preview titles and descriptions are embedded with its text. Archive items (episodes, lessons, evicted details and interests) get one vector each. Vectors are stored per month in `data/guilds/<id>/vectors/<YYYY-MM>/` as int8 rows with a per-row scale, one manifest and one metadata file per generation. A private chat's vectors live under `data/guilds/<id>/private/<userId>/vectors/`. `/nep memory forget` drops every row that names the member (same rules as the record and the archive) by rewriting the month files; `/nep memory wipe` deletes the whole `vectors/` tree.

Message text with author names is sent to the embedding provider (OpenAI through OpenRouter). A local forget removes the rows from the index but does not delete the provider's copy of the text.

## `context`

| Key | Default | Meaning |
|---|---|---|
| `channelMessages` | `100` | Current channel messages |
| `fetchReplyParents` | `true` | When a reply in the window points to a message older than the window, fetch the parent and place it before the window so the model can read what was replied to. The discord.js cache is checked before any API call. A missing key counts as on |
| `replyParentsFor` | `3` | How many of the newest window lines that reply to messages older than the window also get their parents fetched. The trigger message is always checked and can bring its parent and grandparent. With `features.anchoredWindow` on, every window line is asked |
| `replyParentsMax` | `4` | Total parent lines placed before the window per turn |
| `neighborMessages` | `5` | Messages per neighbour channel |
| `neighborMaxAgeMinutes` | `60` | Max age for neighbour messages (min) |
| `neighborMaxChannels` | `8` | Max neighbour channels |
| `neighborMessageChars` | `300` | Characters kept per message from a neighbouring channel (`<other_channels>`) |
| `maxMessageChars` | `2000` | Truncate messages beyond this (chars) |
| `maxUrlChars` | `200` | A link someone posted stays in the message text as it was posted, query and tracking parameters included; a URL longer than this many characters is cut there with an ellipsis. URLs of attachments, stickers, custom emoji and GIFs are never shown. `0` keeps every URL whole |
| `gapMarkerMinutes` | `20` | Time-gap marker threshold (min) |
| `ageAfterMinutes` | `60` | When the persona reads a chat, every message at least this many minutes old shows how long ago it was posted next to its time, as in `[14:32 · 2 h 58 min ago]`; newer messages show only `[14:32]`. Applies to the current channel and to pulled and neighbour channels. An empty `transcript.timeAged` in `prompts.local/labels.json` turns ages off |
| `reactionsPerMessage` | `6` | Max reactions listed per message in the transcript, most frequent first |
| `reactions.maxMessages` | `500` | How many of the persona's own messages the reactor list follows (`features.reactionNames`); past it the oldest message is dropped. Process memory only |
| `reactions.maxNames` | `5` | Names shown per reaction on the persona's messages; the others are counted as "+N" |
| `reactions.fetchUsers` | `10` | Reactors fetched per reaction of one of her messages whose reactors are not known yet (after a restart): one request per message and emoji, once |
| `reactions.fetchTimeoutMs` | `2000` | How long a turn waits for those fetches before going on with counts; what is still running finishes in the background and shows on a later turn |
| `replyQuoteChars` | `80` | Code points of the parent message's text shown in a reply tag. The quote is cut at a word boundary. `0` shows the whole text |
| `otherProfiles` | `6` | Max other profiles shown |
| `failedTurnsKept` | `3` | When an addressed turn ends `error` with nothing posted, the engine keeps a record of it per channel: the message id, the author, the time and the error code. At most this many per channel, within 24 hours. Her next request in that channel carries one `labels.task.failedEarlier` line per kept failure, after the task text. The entries clear once shown. In process memory only: a restart forgets them |
| `askedAboutProfiles` | `3` | Members named in recent messages whose profiles are shown in full, ahead of the other participants |
| `askedAboutEpisodes` | `3` | Episodes shown per member who is asked about. `0` hides episodes for asked-about members. In a private chat, shown when `features.privateLikeServer` is on (the default); hidden otherwise |
| `attitudes` | `6` | Members shown in the `<attitudes>` block, ranked by attitude score strength, warm and cool mixed. `0` turns the block off |
| `around.maxTokens` | `400` | Token cap of the `<people_now>` entries of the people sitting in a voice channel who have no profile in the request (`features.around`), one entry each (about 40 to 60 tokens), by name; over the cap the last names go first, `0` shows none. They are the lowest priority of the request, so they never push out anything else. The entries of the people the request has a profile for are not under this cap: the speaker's is never cut, and anyone else's is kept or dropped together with their profile |
| `deletedLinesMax` | `10` | At most this many placeholder lines for messages deleted since the window starts appear per chat window, the newest first. Each placeholder takes the place of the deleted message, numbered like any line, with the author and the time but no text. A skill call on such a line is refused `message-deleted`. `0` turns placeholders off |
| `tempo.liveMessages10min` | `4` | Messages in 10 min = "live" |
| `tempo.deadSilenceMinutes` | `45` | Silence minutes = "dead" |
| `caps.interlocutor` | `6000` | Token cap: caller's profile with episodes |
| `caps.aboutChat` | `2500` | Token cap: server habits / self-facts |
| `caps.lore` | `1500` | Token cap: lore entries |
| `caps.people` | `9000` | Token cap: other profiles |
| `caps.attitudes` | `400` | Token cap: attitude list |
| `caps.intentions` | `600` | Token cap: `<intentions>` (`features.intentions`), whole lines, her own first, then the candidates |
| `places` | `false` | Show an addressed server turn the places page as a `<places>` block ([Inner life](inner-life.md#her-attention)): the first `innerLife.attention.placesInWake` places by recent activity, each with the lines and people since her last look there, whether she can write there and whether she attends it, with the total. An inner turn carries the page inside `<wake>` whatever this says; her `places.list` skill is always hers. Must be exactly `true` to enable (cost); a missing key counts as off |
| `previousThink.minutes` | `30` | How long after a finished turn tied to a place (the place it ran in and each place where a message of hers was delivered) a new turn there still carries that turn's think (min); `0` carries none across turns (a tool-loop step still carries the step before it, `features.previousThink`) |
| `caps.neighbors` | `3000` | Token cap: neighbour channels |
| `caps.server` | `4000` | Token cap: channel map |
| `caps.emoji` | `800` | Token cap: custom emoji |
| `caps.gifs` | `900` | Token cap: GIF library |
| `caps.pulled` | `4000` | Token cap: pulled channel block (`<channel_view>`) |
| `caps.participation` | `6000` | Token cap: the persona's exchanges on other channels (`<participation>`); whole episodes are dropped, the picked ones last |
| `caps.earlier` | `2500` | Token cap: the anchored window's `<earlier>` block (`features.anchoredWindow`); whole anchors are dropped, the trigger's reply parent and the unanswered requests to the persona last, then the other parents, then the persona's saved stretches, the oldest first |
| `channelActivity.liveMessagesPerDay` | `20` | Daily messages = "active" channel |
| `channelActivity.deadAfterDays` | `7` | Days without messages = "dead" channel |
| `vision.tokensPerImage` | `400` | What the request rail charges for one image part of a helper request (the describer's, the avatar queue's); the persona's own request never carries one |
| `vision.maxBytes` | `1500000` | Max picture file size (bytes) the describer, the second look and the avatar queue download; larger pictures are skipped |
| `vision.fetchTimeoutMs` | `10000` | Download timeout per picture (ms) for the same downloads |

**Removed.** `features.vision` and `features.attachedDescriptions` are no longer read: pictures never go into the persona's own request; she sees them through the describer's captions (`features.mediaDescriptions`) and her second look (`features.imageRelook`), both on the `vision` helper model. A config that still sets either key logs one warning and the value is ignored. `context.vision.maxImages`, `imageSize`, `recentImages` and `recentImageMinutes`, which only picked the pictures for that request, are gone with it (the describer scales a picture by `media.imageSize`).

### `context.customEmoji`

Settings for the custom emoji block (`features.customEmoji`). The memory analyzer tracks which custom emoji members use and how often.

| Key | Default | Meaning |
|---|---|---|
| `max` | `30` | Custom emoji shown in the `<emoji>` block, ranked by member usage; when fewer than `max` have been ranked the rest are filled from the server's emoji in server order |
| `storeMax` | `200` | Custom emoji kept in the usage ranking; the top `max` are shown |
| `halfLifeDays` | `30` | Recency half-life for the usage ranking (days); rank = log2(count + 0.5) + last / halfLife; an emoji not used recently sinks below one used often |
| `backfillMessages` | `500` | Messages read per channel from history at startup to seed the ranking. Runs once when `features.customEmoji` is on and no backfill has run yet for this server; the result is stamped in `guild.json`. `0` disables the backfill |

### `context.pull`

Settings for pulling another channel into a turn's request (`features.channelPull`). When the recent messages or the trigger contain a real Discord channel mention (`<#id>`), the mentioned channel's latest messages are rendered as a `<channel_view>` block. The window ends at that channel's newest message, however old.

| Key | Default | Meaning |
|---|---|---|
| `windowMinutes` | `60` | Minutes of messages to pull, ending at the channel's newest message |
| `minMessages` | `5` | Minimum messages in the window; the window extends further back to reach this count |
| `maxMessages` | `60` | Maximum messages pulled per channel |
| `maxPictures` | `10` | Pictures whose captions are included; cached captions are free, fresh ones are requested only when the turn is certain to run |
| `maxNewDescriptions` | `8` | Fresh describer requests for pictures in a pulled channel per turn |
| `describeTimeoutMs` | `15000` | Timeout for fresh caption requests (ms) |
| `scanMessages` | `20` | Recent messages of the current channel scanned for channel mentions |
| `maxChannels` | `1` | Channels that can be pulled per turn |
| `maxAgeDays` | `0` | Refuse a pull when the channel's newest message is older than this many days. `0` = no limit |
| `sameAudience` | `true` | Check that every role allowed to view the destination channel can also view the source. A named member's view is proved through his roles from the guild's member cache; a member not in the cache is proved only through the everyone permission and the channel's role denies, as before. Also governs which neighbour channels appear in `<other_channels>` and which server-search windows the recall run keeps. When false, content from a restricted channel can reach a wider audience |
| `seenTtlMinutes` | `120` | Minutes before a previous view of the same channel in the same destination expires. A view older than this is ignored when comparing which messages are new. `0` = every view is treated as the first |
| `keepMinutes` | `10` | Minutes a pulled channel stays in the next turns of the same exchange after the turn that pulled it (a mention or the router). A later turn keeps it only when its trigger comes from the same author, unless the router picks another channel (that one replaces it) or the author changes. Such a turn logs `pull: kept` (`pullReason` `kept`). Remembered in process memory only. `0` = a pull never carries over |
| `keepTurns` | `3` | Most turns that keep a pulled channel after the one that pulled it. `0` = a pull never carries over |

## `elsewhere`

Settings for answering calls from channels where the bot can read but not send (`features.elsewhere`). A call (mention, reply, name) in such a channel waits for the conversation there to settle, then the persona answers in the first usable channel of `memory.mainChannelIds` with a link back to the call.

| Key | Default | Meaning |
|---|---|---|
| `settleSeconds` | `90` | Seconds after the last message in the source channel before the call is answered |
| `settleMaxSeconds` | `300` | Maximum seconds from the first call in a burst before the answer fires regardless |
| `rememberPings` | `20` | Calls remembered in the ring per channel |
| `pingMaxAgeDays` | `7` | Days before a remembered call expires from the ring |

## `pace`

How long each stage of a turn may take when someone is waiting for the answer. All hot-reloaded. A helper that misses its deadline is dropped; the turn continues without it. A turn whose answer is not in hand by `dropAfterMs` is dropped entirely (logged as `turn: dropped`). Each request logs the time of every stage in `turn: timings`.

| Key | Default | Meaning |
|---|---|---|
| `prepareMs` | `6000` | Milliseconds from the turn's start before the voice request. Everything that runs before the LLM call (history, captions, the route and search classifiers) must finish within this window. `0` or a non-number removes the limit |
| `prepareSearchMs` | `18000` | The deadline extends to this limit while the search classifier is deciding and while any search it requests runs. A 'no search' verdict releases the hold at once. Never shorter than `prepareMs`. `0` or a non-number removes the limit |
| `prepareMediaMs` | `20000` | Extended deadline on a direct call whose trigger message (or the line it replies to) carries a picture, GIF or video the describer or video stage will work on. Never shorter than `prepareMs`; when the search extension also applies, the larger limit wins. `0` or a non-number removes the extension |
| `dropAfterMs` | `120000` | Milliseconds from the turn's start. If the finished answer has not arrived by this time, the turn is dropped unposted (`turn: dropped`). `0` or a non-number removes the bar |
| `replyHedgeMs` | `30000` | On a turn answering a direct call, when the reply request has no answer after this many milliseconds, a second identical request is sent. The first to finish wins and the other is aborted. The second attempt counts against `llm.maxRequestsPerDay`. The `dropAfterMs` bar still ends everything. `0` or a non-number = one attempt only. Turns nobody waits for (`unpromptedWaits`) never send a second attempt |
| `settleMs` | `3000` | On a turn answering a person (mention, reply, name, follow-up, overheard, private), the persona first waits until that person has written nothing in that channel for this many milliseconds, then reads the chat. Every new message of theirs restarts the count, so a thought posted as two or three quick messages is answered whole. The persona's attention is taken during the wait, and the `prepareMs`, `prepareSearchMs`, `prepareMediaMs` and `dropAfterMs` clocks start only after it. Turns nobody started (interjecting, starting a topic, the diary) never wait. `0`, a negative value or a non-number = no wait. The wait actually spent is logged as `settleMs` in `turn: timings` |
| `settleMaxMs` | `8000` | The longest that wait may run, counted from the message that called the persona: once this many milliseconds have passed since it, the turn goes on even if the person is still writing. `0` or a non-number = at most one `settleMs` from that message |
| `typingWhilePreparing` | `false` | Show the typing indicator from the start of a turn answering a direct call (mention, reply, name, follow-up, private), not only while the finished answer is being typed out. Must be exactly `true` to enable |
| `unpromptedWaits` | `true` | A turn nobody waits for (interjecting, starting a topic, noticed comment, room question, overheard) waits for every stage and posts when ready, ignoring `prepareMs`, `prepareSearchMs` and `dropAfterMs`. `false` applies the same deadlines to every turn. A missing key counts as on |

## `format`

Post-processing applied to the model's output before it is sent to Discord. All hot-reloaded.

| Key | Default | Meaning |
|---|---|---|
| `stripDashes` | `true` | Remove em dashes and en dashes from `<msg>` texts before posting. The dash and the spaces around it become one space. Every guillemet (`«`, `»`) becomes a plain `"`. A message left empty after stripping is not sent. Hyphens stay. `<draw>`, `<react>`, `<gif>` and reply ids are not touched. A missing key counts as on; only `false` turns it off |

## `route`

Settings for the channel route classifier (`features.channelRoute`). When the conversation names or refers to another channel, a classifier (`prompts/route-channel.md` on the `analyzer` role) picks the channel number from a list. The picked channel is pulled into the request as a `<channel_view>` block alongside any explicit channel mentions. Logged as `route: classified`, `route: skipped` or `route: failed`.

| Key | Default | Meaning |
|---|---|---|
| `contextMessages` | `20` | Recent channel messages rendered for the classifier |
| `maxChannels` | `40` | Channels listed for the classifier to choose from |
| `purposeChars` | `80` | Characters of each channel's stored purpose shown in the list |
| `maxOutputTokens` | `120` | Max output tokens for the classifier |

## `participation`

The persona's own exchanges on other channels (`features.participation`). Every message the persona sends in a server channel (not a private chat, not the diary channel, not a dry run) is saved with a few lines before it, the message it answered, and the lines that follow it, in `data/guilds/<id>/participation.json`. On a server turn the persona sees up to `shown` of these episodes from other channels in a `<participation>` block: the ones a classifier (`prompts/participation-pick.md` on the `analyzer` role) picks as the ones the message refers to, then the newest. Only channels everyone in the current channel can also read are offered (the `context.pull.sameAudience` rule). Logged as `participation: recorded`, `participation: classified`, `participation: skipped`, `participation: late` or `participation: failed`.

| Key | Default | Meaning |
|---|---|---|
| `hours` | `72` | How long an episode is kept after the persona's newest line in it (h) |
| `linesBefore` | `3` | Channel lines saved before each of the persona's messages |
| `linesAfter` | `1` | Lines by others saved after the persona's last message in an episode |
| `followMinutes` | `10` | How soon after the persona's message a line by someone else must come to be saved with it (min) |
| `mergeGapMinutes` | `10` | A new message of the persona's joins the channel's last episode when that episode's last line is at most this many minutes before it; otherwise it starts a new one |
| `contextMinutes` | `30` | Channel lines saved before a message of the persona's are kept only when at most this many minutes older than it (min); the message she replied to is kept whatever its age |
| `maxMessages` | `32` | Messages per episode; a longer exchange continues in a new episode |
| `maxStored` | `120` | Episodes kept on disk; the oldest go first |
| `maxTextChars` | `400` | Characters kept per saved message, cut at a word boundary |
| `shown` | `4` | Episodes shown per turn |
| `perChannel` | `2` | Episodes shown per channel |
| `episodeChars` | `1800` | Characters of text shown per episode; a longer one keeps the persona's lines, the lines they answer, the lines that share a word with the new message and the ends, and marks the cut lines |
| `contextMessages` | `6` | Recent channel lines rendered for the pick classifier alongside the new message |
| `maxOutputTokens` | `60` | Max output tokens for the pick classifier |
| `pickTimeoutMs` | `1500` | How long the turn waits for the pick classifier (ms). Past it the request is aborted and the newest episodes are shown, logged `participation: late` and journaled as a `helper-timeout` limit on `participation-pick`. `null` leaves only the turn's own preparation deadline |
| `earlierHours` | `3` | With `features.anchoredWindow` on, the same saved episodes also cover the current channel: the lines of it that are older than the oldest line of `<chat>` and younger than this many hours come in the `<earlier>` block, so a conversation the count-based history (`context.channelMessages`) has already let go of is not lost. `0` leaves them out (h) |
| `earlierShown` | `3` | Episodes of the current channel shown in `<earlier>`, the newest ones; each is cut to `episodeChars` |

## `split`

Settings for the task splitter (`features.splitTasks`). When a direct call (mention, reply, name, follow-up, private message) is long enough and structured enough, a classifier (`prompts/split.md` on the `analyzer` role) decides whether it holds several separate requests. Each part is answered in its own turn; the first replies to the message, the rest post plain. The splitter runs beside the turn's preparation and never slows a single request. Logged as `split: verdict`, `split: skipped` or `split: failed`; each part logs `turn: part`.

| Key | Default | Meaning |
|---|---|---|
| `minChars` | `80` | Minimum characters (links and Discord tokens excluded) before the splitter is asked |
| `minPartChars` | `20` | A returned part shorter than this (characters, links and Discord tokens excluded, like `minChars`) is folded into the next part (the last into the previous). When fewer than two parts remain the message is one request. `0` = no folding |
| `maxTasks` | `4` | Maximum parts the splitter may return. Below 2 the splitter is off |
| `contextMessages` | `6` | Recent channel messages rendered for the classifier alongside the candidate |
| `maxOutputTokens` | `300` | Max output tokens for the classifier |

## `recall`

Settings for the server-history search (`features.recall`). When the lookup classifier (`prompts/lookup.md`) answers with `server:` forms, `who:` name forms or `when:` date ranges, the engine searches the server's own message history through Discord's search API, groups the hits into clusters, fetches a window of messages around each, and asks a summary helper (`prompts/recall-summary.md` on the `analyzer` role) what the history answers. The summary may single out one stretch that the persona then gets verbatim alongside the condensed note. Logged as `recall: searched`, `recall: summary`, `recall: skipped` or `recall: failed`.

| Key | Default | Meaning |
|---|---|---|
| `maxForms` | `8` | Search forms (word inflections) the classifier may list per `server:` line |
| `maxPeople` | `2` | People the `who:` line may name |
| `dateSamples` | `4` | Date-only queries sampled across a `when:` range when no content forms are given |
| `clusterGapMinutes` | `30` | Gap between hits that separates them into clusters |
| `maxClusters` | `5` | Clusters kept, ranked by topic score (each distinct `server:` form with hits in the cluster adds 2 when rare, 1 otherwise) plus `selfBonus` when the fetched window holds a line of the persona, then by all distinct queries, then newest first. A cluster with only name or author hits ranks below any cluster with a topic hit. Hits already shown in the turn's chat never form a cluster |
| `keepOldest` | `0` | Of the `maxClusters` kept, this many slots go to the oldest clusters with a topic score of at least 2. A cluster scoring below 2 never gets a reserved slot. `0` = ranked order only |
| `rareHits` | `5` | A `server:` form whose search returned at most this many hits on the whole server counts double in a cluster's topic score. `0` = no rarity bonus |
| `windowMessages` | `16` | Messages fetched around each cluster centre |
| `followMessages` | `24` | At most this many lines after a stretch's last line are added while the conversation continues, so a stretch reaches where an exchange settled. `0` turns the extension off |
| `followGapMinutes` | `5` | The extension stops at the first silence longer than this many minutes |
| `selfExtra` | `2` | Extra clusters whose windows are fetched beyond `maxClusters`, so a window with the persona's own line can still win a slot once `selfBonus` applies. `0` = only `maxClusters` windows (the bonus then only reorders them) |
| `selfBonus` | `1` | Added to the topic score of a cluster whose window holds at least one line of the persona. `0` = no bonus |
| `contextMessages` | `6` | Chat lines before the question that the summary reads as `<context>` (the lines the search classifier read). `0` = no `<context>` block |
| `traceMaxLines` | `500` | Lines kept in the trace file (`features.recallTrace`); the oldest go first. At least 1 |
| `answerChars` | `1200` | Max characters for the summary note; fills `{{answerChars}}` in `recall-summary.md` |
| `stretchChars` | `1500` | Max characters of the verbatim stretch shown to the persona |
| `quoteWindowChars` | `1500` | Per-stretch character limit of a `memory.search` result (`features.coreTools`). Each stretch is cut by whole lines; the lines that do not fit are counted in `skills.tools.memory.windowCut`. The first stretch always stays |
| `quoteMaxChars` | `9000` | Total character limit of a `memory.search` result. Stretches are counted one by one; a stretch that would push past the limit is left out with every one after it, and a closing line (`skills.tools.memory.windowsLeft`) names what was not shown. `skills.resultMaxChars` does not apply to a `memory.search` result |
| `maxPerDay` | `100` | Daily recall runs (stored in `state.json` as `recallDay` / `recallCount`) |
| `timeoutMs` | `15000` | Total time for the recall run (search, windows, summary). Once half the time is gone no further search is sent; the summary runs only when at least `minSummaryMs` is left |
| `minSummaryMs` | `2500` | Minimum time left for the summary helper to be asked. Without it the verbatim stretch of the top window is returned without a note |
| `memoryItems` | `6` | Stored memory items (episodes, lore, lessons, recent lines, and archived items) matched against the classifier's word forms and name forms and sent in the `<memory>` block of the recall summary. `0` turns the match off |
| `memoryTokens` | `600` | Token budget of the `<memory>` block (estimated per line): lines are added in rank order until the next one would pass it. `0` = no line fits |
| `archiveMonths` | `6` | Months of the archive (items that left hot memory: evicted, expired or replaced) searched for `<memory>` when the question has no `when:` range; with a range, the archive is searched from the range's start. Read as a stream, never loaded whole. `0` = the archive is searched only for a dated question |
| `recordDays` | `3` | Days of the record (every observed message on disk) read for matching lines on any recall question: a dated question reads back from the end of its `when:` range, any other from now, at most this many days (a date that only locates the event: from now, plus the date's own days). A dateless question that is not a "recently" also keeps the earliest match's window. Matching lines become extra stretches marked `source: record`. `0` = the record is not read |
| `recordContext` | `3` | Lines before and after each matching record line added to its stretch, besides the chain of messages it replies to |
| `maxOutputTokens` | `500` | Max output tokens for the summary helper |
| `fallbackOnClassifierFailure` | `true` | Run recall from the trigger's own words when the lookup classifier fails (an error, a timeout or an empty answer) on a direct call and server recall is available. The plan uses words of 5+ letters (longest first, at most `maxForms`, the persona's name left out) as forms, members named by a stored name or alias as `who`, no date range and no web search. Logged as `lookup: fallback` |
| `meaningCandidates` | `80` | Rows returned from the vector index per meaning search. These candidates are fused with the word hits and then go through the same window builder and cluster ranking. When fused, the best record line that matches a topic word keeps one of the record's windows even if lines found by both searches rank above it. `0` turns the meaning search off even when `features.meaningSearch` is on |
| `meaningWithReply` | `false` | When the trigger message is a reply and the replied-to message is among the recent lines, embed the trigger together with that line (the asker's question in context). Otherwise only the trigger is embedded |
| `locatorBonus` | `2` | When the question's date only helps find the event (`when-role: locator`, or a `when:` beside word or name forms without a role), the record, the archive and the vector index search past that date, and each stretch, cluster or memory item near it gets up to this much added to its score (in topic points: one matched form; scaled to one top rank when the score is fused with the meaning search). The full bonus inside the date's range, less with distance. `0` = the date gives no bonus |
| `locatorDecayDays` | `7` | The bonus above falls linearly to nothing at this many days away from the date's range. Also how far before the date the record must reach for the extra broad Discord page to be skipped. `0` = a bonus only inside the range |
| `locatorBroadShare` | `0.5` | Share of the kept stretches, clusters and memory items (rounded up) chosen by content alone, regardless of the date, so a misremembered date cannot crowd out the right event; the rest are chosen with the bonus. From `0` (all by the bonus) to `1` (all by content: the date changes nothing) |
| `backend` | `"discord"` | Where the persona's own `memory.search` and the memory prefetch read the server's history. `"discord"`: Discord's search, the record, the record index and the vector files, as before. `"db"`: the memory database (`features.memoryDb` on, the database open and synced once; until then the old way is used), inside the read scope of the turn: a channel turn reads what a group may see, a private chat what its partner may. Read at the moment of use. See `recall.db` |

### `recall.db`

The settings of the database backend (`recall.backend: "db"`); the window and follow sizes are the `recall` ones above (`recordContext`, `followMessages`, `followGapMinutes`, `maxClusters`).

| Key | Default | What it does |
|---|---|---|
| `gateShare` | `0.5` | From `0` to `1`. After the word, letter, meaning and people lists are fused (reciprocal rank, k 60), a hit needs at least this share of the best fused score to stay; the ones that stay are ranked by closeness to the question's date (the middle of its range) when it names one; with no date, by how many distinct terms and phrases a hit holds, and by closeness to now only among hits holding the same. `0` keeps every hit |
| `candidates` | `40` | Rows taken from each list (words, letters, meaning, people) before they are fused. At least 1 |
| `wordPool` | `400` | Rows fetched from the word and letter lists before they are ranked by how many distinct terms (then phrases, then bm25) each holds; the best `candidates` of that order go on to the fusion. At least 1; a value under `candidates` counts as `candidates` |
| `minMeaning` | `0.35` | The least cosine a meaning hit needs to join the fusion, from `-1` to `1` |
| `vectorDays` | `90` | The index policy (schema 11, `vectorEviction`): a line's vector is kept while the line is younger than this many days; after that only when the line is cited by a claim or an episode, pinned, or touched, and always for consolidated memory (an archive item's vector) |
| `touchDays` | `30` | How long a touch lasts: a line a request carried or a memory session read is kept (its vector embedded again by `reembed`) for this many days, then evicted again by the next run |
| `vectorEviction` | `false` | Needs `features.memoryDb`. Once per UTC day the index policy gives every stored line its tier (`a`: hers, addressed to her, in a DM, cited, pinned or touched; `c`: captured from a foreign place; `b`: the rest) and evicts the vectors outside the classes above: the vector's bytes are dropped, its row, model, dims and norm stay, no text is touched, and recall no longer reads it. While on, the lines a request carried and a session read are touched. Under `memoryDb.authority` `json` the vector files still hold the bytes. `tools/memory-db.mjs index-policy --db <file>` shows what a run would evict. Must be exactly `true` to enable |
| `reembed` | `false` | Needs `features.memoryDb`. At most once a minute, the evicted vectors of touched lines are embedded again through the embedding client (the line and the lines before it, as its vector was made; rows of another embedding model or size are left evicted). Must be exactly `true` to enable |

A `memory.search` call that names an `anchor` (a `#N` of a quoted line) with `move` (`up` earlier, `down` later) and `messages` or `minutes` reads the lines next to it instead of searching. The `hidden` marker (a better match exists only in a private conversation a channel turn may not open) carries no text and no count.

### `recall.prefetch`

The automatic memory prefetch (`features.coreTools` with `features.memoryPrefetch`): what it searches with, how it judges relevance and how much it may show. It searches the whole record through an in-memory word index (built on first use, refreshed in the background), the stored memory and the archive (`recall.memoryItems`, `recall.archiveMonths`) and, with `features.meaningSearch`, the vector index; it sends no Discord request and counts no `recall.maxPerDay` run. The words it searches with are the message's rarest ones in the server's history (no model picks them); word endings are learned from the record itself. Logged `recall: prefetched`.

| Key | Default | What it does |
|---|---|---|
| `deadlineMs` | `1000` | How long the whole prefetch may take. What has not settled by then is abandoned; the request is built with what had, or with the timeout status line. At least 1 |
| `candidates` | `20` | Candidates per lane and search: rows of the vector index per lane, and record hits per lane by words (in windows of up to four hits; three times as many word hits are checked by their meaning first). At least 1 |
| `maxExcerpts` | `5` | The most excerpts shown in `<retrieved>`. At least 1; fewer (or none) when fewer are relevant |
| `maxTokens` | `1500` | The most estimated tokens of all excerpts together; an excerpt that does not fit is skipped and the next tried. At least 1 |
| `excerptChars` | `1200` | Characters of one history excerpt, cut by whole lines from its far ends around its relevant lines (a relevant line is never cut) |
| `contextLines` | `3` | Lines before a short or deictic trigger joined into its third lane (`recent`). `0` = no such lane |
| `contextTokens` | `500` | The most estimated tokens of that lane's lines with the trigger |
| `shortWords` | `4` | A trigger of at most this many words is short: it gets the `recent` lane, and a trigger of two words or more up to this many is also searched as one exact phrase |
| `minFormsMatched` | `2` | Word forms of a lane a stored item must match to count as relevant (fewer when the lane has fewer; a quoted phrase match always counts; a name alone never does). `0` counts as 1 |
| `minMeaningScore` | `0.35` | The least cosine similarity a meaning-search row needs to count at all, from `0` to `1`; also the least a history line found by two or more words needs when the meaning search is on. Rows below it are dropped, so a weak match shows nothing |
| `strongMeaningScore` | `0.55` | A meaning-search row at or above this cosine counts on its own; below it, it counts only when one of the message's distinctive words or phrases appears on its line or within two lines of it (speakers' names included). A line of fewer than three words never counts by meaning. From `0` to `1` |
| `singleTermScore` | `0.45` | The least cosine a history line found by only one rare word needs to count (with the meaning search on; without it such a line never counts). From `0` to `1` |
| `maxTermShare` | `0.002` | A word of the message is a search term only when at most this share of the record's messages hold it (word endings folded); the rarest `recall.maxForms` are used. From `0` to `1` |
| `rareTermDf` | `30` | A word held by at most this many messages is rare: one such word can find a line on its own (see `singleTermScore`) |
| `maxPhraseDf` | `20` | Two or three adjacent words of the message (each of three letters or more) are searched as a phrase when the record holds them together in at most this many messages, at least once. At least 1 |
| `minPhraseShare` | `0.2` | ... and when at least this share of the messages holding the phrase's rarer word hold the phrase (the words belong together, like a catchphrase). A history line holding such a phrase, or a quoted phrase of the message, always counts. From `0` to `1` |
| `trivial` | `["hi", "hello", ...]` | Bare greetings and acknowledgements that are not searched (compared folded: case and accents ignored, the persona's names and Discord tokens left out). A short phrase not on the list is searched. The local layer adds the server's languages |
| `deictic` | `["that", "this", "it", ...]` | Words that make a trigger deictic (it points at something said before): such a trigger also gets the `recent` lane whatever its length |

## `gifs`

Settings for the GIF library (`features.gifs`). Uses are counted as each message arrives (members only, bots and the persona excluded). A one-time backfill from channel history seeds the ranking at startup.

| Key | Default | Meaning |
|---|---|---|
| `max` | `25` | GIFs shown in the `<gifs>` block, ranked by recency-weighted use |
| `reactionChars` | `40` | Characters kept per reaction label in the `<gifs>` list and a library GIF's transcript line. `0` shows the whole text |
| `actionChars` | `70` | Characters kept per action line in the `<gifs>` list and a library GIF's transcript line, cut at a word boundary. `0` shows the whole line |
| `storeMax` | `300` | GIFs kept in the library; the top `max` are shown |
| `halfLifeDays` | `30` | Recency half-life for the usage ranking (days); same formula as custom emoji |
| `maxPerDay` | `40` | GIFs the persona may post per day |
| `backfillMessages` | `500` | Messages read per channel from history at startup to seed the library. Runs once when `features.gifs` is on and no backfill has run yet for this server. `0` disables |
| `backfillDescribe` | `20` | Top GIFs by rank that are sent to the describer for a caption right after the backfill; the rest get captions as the chat meets them |
| `recachePerRun` | `50` | Library GIFs re-described per `/nep media gifs recache` run. One-frame captions outside the library are dropped at once; watched entries in the old format (no `reaction` field) are queued alongside unfinished ones, oldest first. Up to this many are watched per run, capped by `media.gif.maxPerDay` |
| `ownMarkHours` | `24` | Hours after the persona posts a GIF during which the reply's tail and the GIF picker's tail name it in `<gifs_recent>` (with how long ago). `0` turns both off |

### `gifs.pick`

Settings for the GIF picker (`features.gifPicker`). When the persona's first outgoing message is short (at most `gifs.pick.maxChars` characters) and she chose no GIF herself, a classifier (`analyzer` role, prompt `prompts/gif-pick.md`) receives the last few chat lines with the answered message named, that first message, and the whole captioned library (every entry with its caption; with `features.promptCache` on held per cache bucket like the reply's `<gifs>`; the GIFs the persona posted lately follow in `<gifs_recent>`), and answers one handle or `none`. On a handle the GIF replaces the first message; the remaining messages follow in order. The classifier runs during the first message's typing simulation and gets at most `gifs.pick.graceMs` past its end; the daily GIF rail `gifs.maxPerDay` applies.

| Key | Default | Meaning |
|---|---|---|
| `maxChars` | `160` | First message ceiling: the picker runs only when the persona's first outgoing message is at most this many characters |
| `contextMessages` | `4` | Recent chat lines sent to the classifier alongside the reply and the library |
| `maxOutputTokens` | `60` | Max output tokens for the picker classifier |
| `graceMs` | `1000` | How long the first message, once its typing simulation is over, still waits for the picker. A picker still out then is left behind for this turn: the text goes as written, logged `gifs: pick late` and journaled as a `helper-timeout` limit on `gif-pick`. `null` waits for the answer however long it takes. Without the typing simulation the first message waits for the answer |

## `avatars`

Settings for the avatar descriptions (`features.avatars`). The queue scans every member with a profile when the bot starts (or the switch is turned on) and once a day, and queues those whose avatar changed since it was described. Each description is one request on the `vision` role (purpose `avatar`, prompt `prompts/avatar.md`, output cap `media.maxOutputTokens`) and counts against `llm.maxRequestsPerDay`. A description that failed is tried again at the next scan.

| Key | Default | Meaning |
|---|---|---|
| `intervalMs` | `20000` | Milliseconds between two avatar requests; one request at a time |
| `maxPerDay` | `60` | Avatar requests per UTC day; the rest wait for the next day. Counted in `data/state.json`. A missing or invalid value refuses every request |
| `descriptionChars` | `200` | Characters kept of a description (`{{maxChars}}` in `prompts/avatar.md`), cut at a word boundary |

## `media`

Settings for the media describer (`features.mediaDescriptions`). The describer model is `models.base.vision`.

| Key | Default | Meaning |
|---|---|---|
| `maxOutputTokens` | `2000` | Max output tokens per description; raise for a reasoning model whose thinking counts against this cap |
| `descriptionChars` | `500` | Max characters for a picture description; the first line is kept and cut on a word boundary. Fills `{{maxChars}}` in `describe.md` when the placeholder is present |
| `imageSize` | `512` | Via Discord's media proxy, a picture's longer side is scaled down to at most this many px with its aspect kept; a picture of unknown size is sent at its original size |
| `maxPerTurn` | `6` | Max descriptions generated per turn |
| `prefillPerMessage` | `5` | Pictures, stickers and custom emoji of one observed message sent to the describer as they arrive; `0` turns the picture prefill off |
| `cacheEntries` | `5000` | Description cache size, keyed by attachment |
| `filePreviewChars` | `10000` | Characters shown from the beginning of text files |
| `embedTextChars` | `200` | Characters shown from link embed text |
| `recacheBefore` | `null` | An ISO date-time, or `null` (off). A cached picture, GIF or video description written before it (or never stamped with its time, as every description from before 15.10.2026 is) is described again the next time it comes up, through the normal path and under the same limits as a new one (`llm.maxRequestsPerDay`, `media.maxPerTurn`, `context.pull.maxNewDescriptions`, the daily video and GIF caps). A failed attempt keeps the old description and waits an hour (`media.video.errorRetryMinutes` for a video) before the next one. `/nep model set` for the `vision` or `video` role sets it to the moment of the change |
| `recacheIntervalMs` | `3000` | Milliseconds between two descriptions of a `/nep media kind:pictures action:recache` run (one at a time). The run takes the cached picture descriptions used in the last `days` days (the command's option, default 7, from 1 to 60) that were written by an older model: written before `recacheBefore` when it is set, and never by the current `vision` model (the `video` model for a watched GIF). It stops when `llm.maxRequestsPerDay` is spent, the bot is paused or a warmup starts |

### `media.gif`

Settings for watching GIFs as short clips (`media.gif.watch`). When enabled, a GIF's animation is converted to a short mp4 and sent to the `video` role's model instead of describing a single frame. The watched caption replaces the one-frame description. A GIF that cannot be watched (no animation source, a failed conversion, a spent daily cap) falls back to the one-frame description.

| Key | Default | Meaning |
|---|---|---|
| `watch` | `true` | Watch GIFs as short video clips instead of describing a single frame. Needs `features.mediaDescriptions` and `features.videoDescriptions` on. A missing key counts as on |
| `maxSeconds` | `15` | Seconds of the animation sent to the video model; the clip is converted with ffmpeg. A GIF's second look on a question (`media.video.rewatch`) uses the same cap |
| `maxPerDay` | `200` | Daily GIF watch cap, counted separately from `media.video.maxPerDay`. Once spent, a GIF gets the one-frame description instead. A GIF's second look on a question takes a slot here too |

### `media.video`

Settings for the video describer (`features.videoDescriptions`). Video vision needs BOTH `features.mediaDescriptions` and `features.videoDescriptions` on. The video model is `models.base.video`. A separate video-capable model watches short clips: Discord video attachments and links to the sites in `media.video.sites`. Results are cached in the media cache alongside picture descriptions; a repost costs nothing.

| Key | Default | Meaning |
|---|---|---|
| `provider` | `{ "order": ["google-ai-studio"], "allow_fallbacks": false }` | OpenRouter provider routing for the direct-URL path (YouTube within the length cap). Overrides `llm.providerByModel` and `llm.provider` for this path; `null` lets the normal resolution order apply |
| `maxOutputTokens` | `800` | Max output tokens per video summary |
| `summaryChars` | `1500` | Max characters for a video account; fills `{{maxChars}}` in `describe-video.md` |
| `maxRequestTokens` | `60000` | Token cap per video request (input + output), used instead of `llm.maxRequestTokens`. A public-URL video in agentic mode uses `directUrlTokensPerSecond` (10) for the estimate: one hour of YouTube is 36 000 tokens. Downloaded clips use `tokensPerSecond` (120): five minutes is 36 000 tokens |
| `maxSeconds` | `300` | Max clip duration (seconds) for attachments and downloaded site videos; longer attachments are trimmed with `ffmpeg`, longer site videos are cut to their first `maxSeconds` by `yt-dlp`. Direct-URL sites use `directUrlMaxSeconds` instead |
| `directUrlMaxSeconds` | `3600` | Max duration (seconds) for a public-URL video (YouTube and other `directUrlSites`) when `urlProcessing` is `agentic`. In any other mode the effective cap is the smaller of this value and `maxRequestTokens / tokensPerSecond`. Longer videos take the download route (first `maxSeconds` via yt-dlp), which YouTube often blocks with a bot check on servers |
| `maxBytes` | `14500000` | Max file size (bytes) for attachments and downloaded site clips. 14.5 MB because Google AI Studio rejects request bodies over 20 MB, and base64 encoding adds roughly a third. The download itself may be up to 4x this size. Over-size files are re-encoded with `ffmpeg` first; when the normally re-encoded clip is still over `maxBytes`, it is re-encoded once more at a bitrate fitted to `maxBytes` (audio 48 kbps, video between 100 and 400 kbps). Only a clip still too large after the fitted re-encode is refused as a permanent miss |
| `maxPerTurn` | `5` | Max NEW videos per turn; every fetch attempt counts, failed or not |
| `maxPerDay` | `40` | Daily video request cap (stored in `state.json` as `videoDay`/`videoCount`) |
| `tokensPerSecond` | `120` | Token estimate per second of video for the budget check. Applies to downloaded clips and to public-URL videos outside agentic mode; in agentic mode `directUrlTokensPerSecond` is used instead |
| `directUrlTokensPerSecond` | `10` | Per-second token estimate for the pre-flight budget check on a public-URL video in agentic mode (the model loads only what it needs; the video itself is not counted as prompt tokens). A missing or invalid value falls back to `tokensPerSecond`. `tokensPerSecond` (120) still applies to downloaded clips and to URLs in other modes |
| `timeoutMs` | `90000` | LLM request timeout for video (ms) |
| `toolTimeoutMs` | `120000` | Timeout for `yt-dlp` and `ffmpeg` subprocesses (ms) |
| `sites` | `["youtube.com", "youtu.be", "tiktok.com", "vk.com", "vkvideo.ru", "x.com", "twitter.com", "reddit.com", "twitch.tv"]` | Hostnames whose links are treated as video |
| `directUrlSites` | `["youtube.com", "youtu.be"]` | Sites whose public URL can be passed directly to the provider (the provider fetches the video itself) |
| `directUrlUnknownDuration` | `false` | Send a direct-URL-site link to the provider even when no probe could determine the duration; the token estimate uses `maxSeconds`. See the duration chain below |
| `canaryUrl` | `"https://www.youtube.com/watch?v=jNQXAC9IVRw"` | A fixed YouTube video probed at startup to test the YouTube API key and duration sources |
| `ytdlpPath` | `"yt-dlp"` | Path to the `yt-dlp` binary; needed for site video links and for probing duration |
| `ffmpegPath` | `"ffmpeg"` | Path to `ffmpeg`; needed for trimming and downscaling long or large attachments |
| `proxy` | `""` | A proxy URL for `yt-dlp`, in any format it accepts (`socks5h://user:pass@host:port`, `http://host:port`); `""` = no proxy. Needed when a site refuses the server's own address (YouTube returns "confirm you're not a bot" on datacenter IPs). Only links to `proxySites` use it. The value may hold credentials and never appears in the log; to keep them out of the config file, put the URL in `.env` and set `proxy` to a reference such as `"${env:VIDEO_PROXY}"`. A proxied download fetches the whole video and `ffmpeg` cuts the first `maxSeconds` locally, because yt-dlp's section-download mode runs ffmpeg, which cannot use a SOCKS proxy; so the download ceiling (4x `maxBytes`) decides whether a long video fits |
| `proxySites` | `["youtube.com", "youtu.be"]` | Sites whose links use `proxy` for the duration probe and the download. A host matches when it equals a listed site or ends with `.<site>`. Links to other sites go direct. `[]` turns the proxy off |
| `proxyRetryMinutes` | `10` | After a proxied download or probe fails, the bot checks whether the proxy still accepts a connection. If it does, the video itself is the problem and the link is reported as not loaded. If the proxy is down, the link is retried without it at once, and all links skip the proxy for this many minutes (`fetch-video: proxy failed`, then one `fetch-video: proxy skipped` for the window). Kept in memory; a restart clears it |
| `errorRetryMinutes` | `60` | Minutes before an error-cached video is retried on its own; a forced retry from the re-watch classifier ignores this |
| `urlProcessing` | `"agentic"` | OpenRouter's processing mode sent on public-URL video parts; without it some providers see only a single frame. `null` omits the field |
| `reasoning` | `{ "effort": "low" }` | OpenRouter `reasoning` setting for every video request; keeps reasoning from eating the output budget. A non-object omits the field |
| `audioMap` | `{ "noiseDb": -50, "minSilenceSeconds": 0.5, "mapBelowShare": 0.8, "maxSpans": 20 }` | Audio map for downloaded video clips, measured read-only with ffmpeg `silencedetect`. When the clip has no audio stream or nothing audible, `videoAudio.none` is appended to the video model's system prompt. When the audible share of the clip is below `mapBelowShare`, `videoAudio.map` is appended with up to `maxSpans` time spans formatted as `m:ss`. `noiseDb` is the silence threshold in dB; `minSilenceSeconds` the shortest gap counted as silence. Missing or default values turn the map on; `null` or `false` turns it off. Pinned direct URLs (YouTube by URL) and GIFs never get an audio note |
| `prefill` | `true` | Watch a video as soon as it arrives, so the next turn finds it cached |
| `prefillPerMessage` | `5` | Videos of one observed message watched as they arrive (with `prefill` on); `0` turns the video prefill off |

Both `yt-dlp` and `ffmpeg` are optional system binaries. Without them, attachments within the caps still work (sent as-is). Longer attachments and all site links fall back to the still frame or preview picture, and the persona is told the reason. Every video request counts against `llm.maxRequestsPerDay` and the video token cap (`maxRequestTokens`).

For YouTube links, the duration is learned through a chain: yt-dlp first, then the YouTube Data API (when `YOUTUBE_API_KEY` is set in `.env`), then a scrape of the watch page. When every probe fails and `directUrlUnknownDuration` is off (the default), the link is reported as "could not load." With the switch on, the URL is sent to the provider anyway, billed as `maxSeconds` in the token estimate. The Data API key is free: enable YouTube Data API v3 in the Google Cloud console and create a key; the free quota is 10,000 units/day and one duration lookup costs 1 unit. At startup the bot probes `canaryUrl` and logs the API key status (e.g. `youtube: API key — ok`). A cached length-limit result records the video's duration and is retried when the cap is raised.

### `media.video.rewatch`

Settings for the re-watch classifier (`features.videoRewatch`). When the persona is addressed and a watched video sits in the recent transcript, a cheap classifier decides whether the message asks about one of those videos; if so, the video model watches the clip again and the answer is appended to the transcript. The classifier uses the `analyzer` role. The second look always uses the `video` role.

| Key | Default | Meaning |
|---|---|---|
| `maxPerDay` | `20` | Daily re-watch cap (separate from `media.video.maxPerDay`) |
| `maxOutputTokens` | `600` | Max output tokens for the re-watch answer (the video model's second-look response, not the classifier's pick) |
| `classifierMaxOutputTokens` | `2000` | Max output tokens for the re-watch classifier (the pick/retry/none decision). A reasoning model that thinks before answering needs a larger cap, or it returns an empty answer |
| `answerChars` | `1200` | Max characters for the answer; fills `{{maxChars}}` in `rewatch-answer.md` |
| `recentMessages` | `60` | How many recent messages to scan for watched or error-state videos |
| `maxCandidates` | `6` | Max videos offered to the classifier from the recent window, newest first |
| `contextMessages` | `50` | Recent channel messages (excluding the trigger) rendered as a `<transcript>` block for the classifier; `0` omits the block |

At most one re-watch or retry per turn. Answers are cached for one hour per question. The classifier and the second look each count against `llm.maxRequestsPerDay`; the second look also counts against `media.video.maxPerDay`. Watched GIFs are offered too, listed as videos (only while `media.gif.watch` is on); a GIF's second look fetches its clip again under `media.gif.maxSeconds` and counts against `media.gif.maxPerDay` instead of `media.video.maxPerDay`.

With `features.coreTools` on the classifier never runs: the persona asks for a second look herself with `media.look` (see [`media.look`](#medialook)). The second look, its prompt, its cache and the daily caps above stay the same.

### `media.look`

The persona's own second look (`features.coreTools` on, `media.look` granted to her by name): she names a message `#N`, optionally which of its pictures or videos, and her question; the describer looks again exactly as the re-watch does (pictures on the `vision` role, videos and GIFs on the video model) and the answer comes back in her turn, marked as that model's observation. The daily caps of `media.video.rewatch`, `media.video` and `media.gif` apply as they are.

| Key | Default | Meaning |
|---|---|---|
| `maxPerTurn` | `2` | Max second looks in one turn of hers, counted across the tool loop's steps; a further call fails with `turn-cap` |

## `mention`

| Key | Default | Meaning |
|---|---|---|
| `ignoreChance` | `0` | Base ignore chance for a message whose text @mentions the persona; raise to make the persona skip some pings |
| `followUpIgnoreChance` | `0` | Chance that the persona leaves a follow-up unanswered so the other person gets the last word. A follow-up is an untagged message the address classifier judged to be said to the persona, or a Discord reply to one of the persona's messages when the member who replied did not type an @mention of the persona; the automatic ping Discord adds to a reply does not count. For these messages it replaces `ignoreChance`, and the repeat penalty, the spam threshold and the affinity bonuses apply as usual; a skipped follow-up is not a `no` for `followUpNoStreak` |
| `emptyMentionIgnoreChance` | `0` | Ignore chance for bare @mention; raise to make the persona skip some |
| `repeatWindowMinutes` | `10` | Repeat tracking window (min) |
| `repeatPenalty` | `0` | Added ignore chance per repeat; raise to penalize repeats |
| `spamThreshold` | `50` | Calls in window before spam |
| `spamIgnoreChance` | `0.9` | Ignore chance when spammed |
| `nameTriggerChance` | `1` | Name trigger response chance |
| `neverIgnore` | `[]` | User IDs never ignored |
| `affinityIgnoreBonus` | `0` | Max added ignore at affinity -100; raise so disliked members are ignored more often |
| `affinityLikeBonus` | `0.08` | Max reduced ignore at affinity +100 |
| `oneAtATime` | `true` | One reply at a time across the server |
| `pendingSameChannel` | `true` | Hold a direct ping in the same channel while a turn is running there; answered after the turn with the usual ignore chance. Missing key = on |
| `classifyWhileBusy` | `true` | Classify a follow-up candidate while a turn is running. The candidate passes the same window, no-streak and pre-filter gates; at most one classifier call per channel at a time, newer candidate replaces the one waiting. A `yes` at a busy attention waits in the pending queue (one per channel); an `overheard` is dropped as `busy` unless `mention.pendingOverheard` is on. With the switch off, the candidate is skipped without a call. Also skipped when `mention.pendingSameChannel` is off and the candidate's own channel is busy. Each call is one `analyzer` request under `llm.maxRequestsPerDay`. Missing key = on |
| `pendingOverheard` | `true` | Hold a line the classifier judges as talk about the persona (not to them) in the pending queue while the persona is busy. The persona reacts after the current turn. A waiting follow-up is never pushed out by a later overheard line; a waiting overheard line is pushed out by a later follow-up, a later overheard line, or a direct mention, reply or name call. A waiting overheard line is not counted toward the spam limit and is not reported to other turns as a call waiting in the channel. Off: the line is dropped while busy. Missing key = on |
| `maxPending` | `6` | Total pending calls held across all channels and authors. The single oldest is evicted when full (`mention: dropped`, reason `full`) |
| `pendingMinutes` | `10` | Minutes before a held ping expires |
| `switchDelayMs` | `[2000, 9000]` | Pause before answering in the next channel (ms) |
| `followUpMinutes` | `15` | Follow-up window after the persona's last reply (min) |
| `followUpClassifyReplies` | `true` | Send a reply to another member's message to the classifier instead of automatic `no`. Missing key = on. With the switch off, any reply is `no` before the model is asked |
| `followUpContext` | `15` | Transcript lines sent to the classifier |
| `followUpMaxOutputTokens` | `2000` | Max output tokens for the address classifier. A reasoning model that thinks before answering needs a larger cap, or it returns an empty answer |
| `followUpOverheard` | `true` | When on, an `overheard` answer from the address classifier starts its own kind of turn with `prompts/overheard.md`. Off: an `overheard` answer counts as a plain `yes` (a follow-up turn). Missing key = on |
| `followUpAliases` | `5` | Stored aliases of the persona sent to the address classifier alongside their name, so the classifier recognises them as a call. `0` sends none |
| `followUpNoStreak` | `5` | Consecutive `no` verdicts that close the window |
| `pauseNoticeMinutes` | `10` | Minimum minutes between pause notices in the same channel. `0` posts one for every call |

Follow-up windows are persisted in `data/state.json` under `followUpWindows` and restored at startup; expired ones are dropped.

## `missed`

Settings for missed-answer recovery (`features.missedAnswers`). When a message may have been left unanswered (the address classifier failed, a deferred follow-up was replaced, a turn errored, was dropped or ended not-now), it becomes a candidate. After the channel goes quiet, a helper (`prompts/missed.md` on the `analyzer` role, purpose `missed`) reads the recent transcript and returns one verdict per candidate. With `features.missedRecovery` on, owed candidates start a reply turn; with it off, the verdicts are only journaled. State is persisted in `data/guilds/<id>/missed.json`.

| Key | Default | Meaning |
|---|---|---|
| `sweepDelaySeconds` | `90` | Seconds after the last candidate in a channel before the sweep runs. Pushed back by every new message, never past `sweepMaxDelaySeconds` |
| `sweepMaxDelaySeconds` | `240` | The sweep fires no later than this many seconds after the last candidate, whatever the traffic |
| `expireMinutes` | `5` | Minutes before a candidate expires without a verdict. A message with a question mark uses `questionExpireMinutes` instead |
| `questionExpireMinutes` | `15` | Expiry for a message that contains a question mark (ASCII or full-width) |
| `channelCooldownMinutes` | `5` | Minimum minutes between recovery turns in the same channel |
| `contextMessages` | `20` | Recent channel messages included in the helper's transcript |
| `maxOutputTokens` | `2000` | Max output tokens for the helper |

## `offlineCatchUp`

The messages posted while the bot was down (a deploy, a restart), read once at start (`features.offlineCatchUp`). Discord does not replay them through the gateway, so without this a member who tagged the persona during a restart would get no answer. The channels looked at are the ones memory knows, with the last message the bot saw there; a channel Discord shows nothing newer for is not fetched. The counts per channel are logged (`catch-up: channel`, `catch-up: done`) and, with `features.journal` on, written as one `system` record with `event: catch-up`. A channel whose fetch fails is logged (`catch-up: fetch failed`) and skipped; the start never waits for the catch-up.

| Key | Default | Meaning |
|---|---|---|
| `windowMinutes` | `15` | Only a call younger than this many minutes is answered; an older one is taken into memory and nothing else, so a long outage brings no replies to stale chatter. `0` answers none |
| `maxMessages` | `50` | The newest messages fetched per channel (1 to 100). After a longer outage the older ones are not read |

## `typing`

| Key | Default | Meaning |
|---|---|---|
| `reactionDelayMs` | `[800, 4000]` | Reaction delay range (ms) |
| `msPerChar` | `[35, 75]` | Per-character typing speed (ms) |
| `minMs` | `900` | Min typing duration (ms) |
| `maxMs` | `12000` | Max typing duration (ms) |
| `betweenMessagesMs` | `[700, 3500]` | Pause between messages (ms) |

## `spontaneous`

| Key | Default | Meaning |
|---|---|---|
| `channels` | `[]` | Allowed channels |
| `maxChannelSilenceHours` | `6` | Channel silence that blocks spontaneous messages (hours); 0 = no limit |
| `someoneAroundMinutes` | `120` | No spontaneous turn when every readable channel's last message is older than this (minutes). The persona's own last post in a channel does not count; another bot's does. `0` = no gate |
| `initiateCooldownHours` | `[24, 48]` | Cooldown after starting a topic (hours); no further topic starts until it expires. Interjecting, room questions, eavesdrop, noticed comments and `/nep talk initiate` are not affected. Stored in `state.json`; `/nep status` shows the end while active. `[0, 0]` = no cooldown |
| `minIntervalMinutes` | `45` | Min check interval (min) |
| `maxIntervalMinutes` | `420` | Max check interval (min) |
| `burstChance` | `0.15` | Burst follow-up chance |
| `burstMinutes` | `[3, 15]` | Burst timing range (min) |
| `activeHours` | `{ from: 10, to: 3 }` | Active hours (wraps midnight) |
| `liveWindowMinutes` | `15` | Live window (min) |
| `liveMinMessages` | `4` | Min messages for "live" |
| `deadAfterMinutes` | `90` | Silence before "dead" (min) |
| `initiateChance` | `0.1` | Chance of starting a topic vs interjecting |
| `roomQuestionChance` | `0.04` | Chance that a message put to the room (not to one person) is picked up by the persona. A classifier (`prompts/room.md`) pre-filters. `0` turns it off |
| `eavesdropChance` | `0.02` | Per-message jump-in chance |
| `eavesdropDelayMs` | `[5000, 40000]` | Eavesdrop delay range (ms) |
| `minGapMinutes` | `12` | Min gap between actions (min) |

## `memory`

| Key | Default | Meaning |
|---|---|---|
| `temperature` | `0.3` | Sampling temperature of every extractor-role request: stream analyzer batches (server and private), the warmup's channel, profile and server requests and the portrait refresh |
| `mainChannelIds` | `[]` | Channels where people talk to each other; the portrait of a member's character and style is drawn from them; empty means every channel counts. Also the destination for answers to calls from read-only channels (`features.elsewhere`): the first usable channel in the list is used |
| `portraitRefreshHours` | `24` | Min hours between portrait refreshes triggered by the analyzer's cue per member |
| `portraitRefreshMessages` | `300` | Own messages since the last portrait before a code-triggered refresh is due. Also the sample size for the refresh |
| `portraitRefreshDays` | `3` | Days since the last successful refresh before a code-triggered refresh is due |
| `portraitRefreshPerDay` | `3` | Max portrait refreshes per server per day (code-triggered, analyzer cue and `/nep memory refresh` share this cap). The day counter lives in `state.json` as `portraitDay` / `portraitCount` and survives `tools/warmup.mjs reset` |
| `portraitRetryHours` | `24` | Hours to wait after a failed refresh attempt before trying the same member again |
| `portraitCheckMinutes` | `60` | How often the portrait scheduler checks for members due a refresh |
| `analyzerEpisodes` | `8` | Episodes shown per author in the analyzer's `<existing_profiles>`. Only the top by weight and recency are sent; the stored list keeps every episode. `0` sends none |
| `keepNewestEpisodes` | `5` | The newest episodes (by when they were added) are exempt from eviction. `0` uses the previous rule: evict lightest first, then oldest |
| `recentHours` | `72` | Hours of recent notes kept and shown in the `<recent>` block. Lowering it narrows the view at once and deletes older lines at the next write |
| `maxRecentStored` | `150` | Lines kept on disk. When a write adds lines past this cap, the lightest, then the oldest are evicted |
| `maxNewRecent` | `3` | Lines the analyzer may add per batch |
| `recentChars` | `160` | Max characters per recent line |
| `recentShown` | `12` | Live recent lines the analyzer is shown in `<existing_recent>` so it does not repeat them |
| `notesStaleDays` | `7` | Days since the last valid review or text change before a channel's or the server's notes are flagged for a stale-note review in the next qualifying batch. The flag is sent only when enough messages have accumulated since then (`notesMinMessages` for a channel, `notesGuildMinMessages` for the server) and the batch carries at least `notesBatchLines` lines from that channel. `0` turns the flag off |
| `notesBatchLines` | `8` | Messages from a channel in the current batch for its stale flag to be considered. The batch provides local evidence; the accumulated count (`notesMinMessages`) tracks whether enough activity happened since the last review |
| `notesMinMessages` | `30` | Messages tallied in a channel since the later of its last text change and last valid review before that channel's notes become eligible for a stale-note flag |
| `notesGuildMinMessages` | `100` | Messages tallied across all stored channels since the later of the server notes' last text change and last valid review before the server notes become eligible for a stale flag |
| `notesRetryHours` | `24` | Hours before the same channel or server is flagged again after a flag was sent. Covers both the stream analyzer flag and the sample refresh attempt |
| `notesRefreshDaysMain` | `7` | Days since the last text change or sample review before a channel in `mainChannelIds` is due for a sample refresh (`features.notesRefresh`) |
| `notesRefreshDays` | `21` | Same as `notesRefreshDaysMain`, for channels not in `mainChannelIds` |
| `notesServerRefreshDays` | `7` | Days since the last text change or sample review before the server notes are due for a sample refresh. The server goes after the channels in a cycle and is outside the daily cap |
| `notesRefreshPerDay` | `4` | Successful channel note refreshes per UTC day. A failed request does not take a slot. The day counter lives in `state.json` as `notesRefreshDay` / `notesRefreshCount` |
| `notesCheckMinutes` | `60` | How often the notes refresh scheduler checks for overdue channels and the server. Last check time is stored in `state.json` as `notesRefreshLookAt` |
| `notesSampleDays` | `30` | Days of channel history read for a sample refresh |
| `notesSampleMessages` | `160` | Target number of messages in the spread sample. Messages are spread over the days (newest day first, one message per day per round) to avoid sampling only the latest conversation |
| `notesSampleMaxAuthorShare` | `0.35` | One author may hold at most this share of the sample; excess messages from a dominant author are replaced with other authors' lines |
| `versionsKept` | `20` | Previous texts kept per field in the version history. When a field accumulates more, the oldest entry is dropped. Only prose fields are versioned: member `character`, `style`, `relationship`; channel `purpose`, `topics`, `tone`; server `patterns`, `starters`; lore `text` |
| `vaultDir` | `"vault"` | Directory, relative to `data/` (or absolute), where `/nep memory forget` and `/nep memory wipe` put a plain copy of everything they are about to delete or rewrite: `forget-<userId>-<UTC time>/` and `wipe-<UTC time>/`, with each file under its path below `data/`. The engine never reads it back and `/nep memory snapshot` never copies it; putting a member back means copying files by hand and removing their entry from `data/guilds/<id>/forgotten.json`. Read at each forget or wipe |
| `overLimitRetries` | `1` | Retries when a model answer for a prose field exceeds its character limit. The retry sends the model's own answer back with the exact field name, character count and limit, and asks for a shorter version. `0` turns the retry off; any positive value means exactly one retry. Applies to the voice model, the portrait refresh and the notes refresh. The stream analyzer never retries (the overflowing field is dropped from that batch) |
| `portraitMaxAgeDays` | `21` | A portrait older than this (with at least `portraitMinMessages` own messages since) is due for a refresh even if it has not reached `portraitRefreshMessages` |
| `portraitMinMessages` | `60` | Own messages since the last portrait for the age-based due path (`portraitMaxAgeDays`) |
| `privateMaxAgeMinutes` | `360` | Minutes before a quiet private buffer is analyzed even though it has not reached `minBatchMessages` |
| `channelWritersStored` | `20` | Top writers kept per channel, ranked by a decayed tally |
| `channelWritersHalfLifeDays` | `30` | Half-life of the per-channel writer tally (days); a writer who stopped writing sinks below active ones |
| `reasoning` | `null` | OpenRouter `reasoning` object sent on the analyzer's stage A requests and the warmup's neutral route. `null` omits the field. Example: `{ "effort": "low" }` |
| `batchMessages` | `60` | Ideal batch size |
| `minBatchMessages` | `15` | Min messages before update |
| `maxBatchAgeMinutes` | `180` | Force update after (min) |
| `maxOutputTokens` | `20000` | Max analyzer output tokens |
| `fieldChars` | `1000` | Character limit for profile prose fields (`character`, `style`) and channel note fields (`purpose`, `topics`, `tone`). Server-level `patterns` and `starters` use `fieldChars * 2`. A rewrite that exceeds the limit is refused and the stored text stays; only the first write of an empty field is cut to the limit (see `clampTolerance`) |
| `clampTolerance` | `1.25` | How far past the limit a first write may go before it is cut. Applies only when the field was empty: the text is accepted up to `limit * clampTolerance`, cut at a sentence or word boundary, never inside a member reference. On a rewrite (the field already has text), tolerance is not applied: the text must fit within the exact limit or it is refused |
| `maxDetails` | `15` | Detail items shown to the persona and analyzer per profile |
| `maxDetailsStored` | `40` | Detail items kept per profile; the top by frequency and recency are shown |
| `maxInterests` | `12` | Interest items shown to the persona and analyzer per profile |
| `maxInterestsStored` | `40` | Interest items kept per profile; the top by frequency and recency are shown |
| `interestTopicChars` | `40` | Max chars for an interest topic |
| `interestNoteChars` | `120` | Max chars for an interest note |
| `confirmAfter` | `2` | Sightings before an interest or detail is confirmed |
| `confirmGapHours` | `12` | Hours between sightings to count as a new occasion |
| `interestStaleDays` | `90` | Days without sighting before an interest is marked old (checked against the start of the current UTC day, so the mark changes only once a day) |
| `interestHalfLifeDays` | `180` | Weight half-life for interests (days); an unseen item's weight halves each period, so a new pastime can overtake an old one |
| `detailHalfLifeDays` | `720` | Weight half-life for details (days) |
| `maxLearned` | `20` | Lessons shown to the analyzer and the chat model |
| `maxLearnedStored` | `60` | Lessons kept on disk; the top by frequency and recency are shown |
| `learnedChars` | `160` | Max chars per lesson |
| `learnedHalfLifeDays` | `720` | Weight half-life for lessons (days) |
| `maxAliases` | `5` | Aliases shown to the persona and analyzer per profile |
| `maxAliasesStored` | `15` | Aliases kept per profile; the top by frequency and recency are shown |
| `aliasRosterSize` | `40` | Members carried in the `<known_members>` block of a guild analyzer batch: stored profiles not present as authors, so the analyzer can record an alias for one of them. `0` turns the roster off. Private batches never carry it |
| `aliasHalfLifeDays` | `365` | Weight half-life for aliases (days) |
| `addressHalfLifeDays` | `30` | Days for a name use to lose half its weight in the "called most often" order |
| `maxClosedStored` | `40` | Closed claims kept per profile: an interest, detail, alias or real name the analyzer marked as replaced by a newer one (`supersedes`) leaves the ranked list and is kept here with the dates it was true; past the limit the oldest goes to the archive (event `replaced`). Read at each write |
| `supersededShownDays` | `7` | Days a replaced claim is still shown to the persona, once, next to the claim that replaced it (counted from when the new claim was recorded, checked against the start of the current UTC day). Read at each request |
| `maxInjokes` | `15` | Max server in-jokes |
| `maxSelfFacts` | `20` | Max self-claims |
| `maxEpisodes` | `20` | Max episodes kept per person |
| `maxNewEpisodes` | `3` | Max new episodes per person per batch |
| `timeoutMs` | `900000` | Analyzer timeout (ms), separate from `llm.timeoutMs` |

The analyzer prompt reads these limits as placeholders, so raising a value takes effect on the next batch. Bigger profiles cost context tokens (`context.caps.people`, `context.caps.interlocutor`) and analyzer output (`memory.maxOutputTokens`).

**Migration.** `memory.voiceModel` is no longer read; a config that still sets it logs one warning and the value is ignored. Replies and memory wording both use `models.base.core`.

### `memory.voice`

Settings for stage B of the two-stage analyzer (`features.memoryTwoStage`). Stage B takes the neutral briefs queued by stage A and words them in the persona's voice. The queue is persisted in `data/guilds/<id>/voice.json` and survives restarts.

| Key | Default | Meaning |
|---|---|---|
| `maxItems` | `24` | Items per voice request, fitted under the 50k token rail |
| `maxPerDay` | `100` | Voice requests per UTC day. `0` prevents sending (useful for stage-A-only simulation runs) |
| `maxOutputTokens` | `3000` | Max output tokens per voice request |
| `retryMinutes` | `15` | Back-off after a voice answer that left an item out; the delay doubles on each miss |
| `maxAttempts` | `4` | Answers that left an item out before it takes the degraded path. A failed request (bad JSON, timeout) does not count toward this |
| `queueMax` | `100` | Items kept in the queue; the oldest non-character items overflow to the degraded path |
| `queueHours` | `24` | Hours before a queued item expires to the degraded path. Character items never expire |
| `timeoutMs` | `120000` | Request timeout for voice requests (ms) |

## `relationships`

| Key | Default | Meaning |
|---|---|---|
| `damping` | `true` | Damp score changes that push further from zero; changes toward zero apply in full |
| `dampingPower` | `1` | Exponent of the damping factor; higher values make the ends of the scale harder to reach |
| `maxDeltaPerUpdate` | `15` | Max score change per update |
| `historySize` | `10` | Attitude changes kept per member |
| `shownMoves` | `4` | Attitude moves shown under the attitude in the person's `<people_now>` entry, strongest by absolute delta first (at most one for someone who only took part in the conversation). `0` hides them |
| `directTriggerCount` | `6` | Direct interactions that force early update |
| `decayPerDay` | `0.04` | Daily drift toward zero; per day the score loses `decayPerDay * |score| * (|score| / 100) ^ decayPower`. `0` or missing = off |
| `decayPower` | `1` | Exponent of the decay curve; higher values make scores close to zero decay slower. Not a positive number = 1 |
| `rewriteOnBandChange` | `true` | Flag a stored `relationship` text for rewrite when the attitude band has changed since it was written. Missing key = on |
| `rewriteOnDrift` | `8` | Flag the text for rewrite when the score has drifted this many points since the text was written, even within the same band. `0` = off |
| `rewriteAfterMoves` | `6` | Flag the text for rewrite after this many attitude history entries since the text was written. `0` = off |
| `bandHysteresis` | `2` | Points past the old band's edge before a band change is counted as a rewrite cause. Prevents rewrites from scores that hover near a band boundary |
| `textChars` | `800` | Max characters for the relationship text. Fills `{{relationshipChars}}` in the analyzer prompt. A rewrite over the limit is refused and the stored text stays; only the first write of an empty field is cut |

With `damping` on, a change that pushes the score further from zero is scaled by `(1 - |score| / 100) ^ dampingPower`, so extremes take sustained effort; a change back toward zero applies at full strength. The score is stored with fractional precision and shown as a whole number.

With `decayPerDay` set, every stored affinity (public and private) drifts toward zero once a day. At score 100 with the default settings, the daily loss is 4; at 64 about 1.6; at 30 about 0.36. The sweep runs at startup and hourly, applying whole days from a per-profile stamp (`affinity.decayedAt`), so downtime is caught up. Never runs while paused or during the warmup. No attitude history entry is written.

## `lore`

| Key | Default | Meaning |
|---|---|---|
| `maxEntries` | `500` | Max lorebook entries per server |
| `scanMessages` | `30` | Messages scanned for key matches |
| `maxMatches` | `8` | Max entries shown per request |
| `textChars` | `600` | Lore entry text limit (chars). A rewrite over the limit is refused and the stored text stays; only the first write is cut. `/nep lore add` on an existing title stores the owner's text as written |

## `web`

Settings for the web lookup (`features.webLookup`). Link reading, search and the persona's own `web.search` and `web.read` share a daily counter (`web.maxPerDay`). Results are cached in the media cache (`data/guilds/<id>/media.json`). Model calls go through the `analyzer` role (the classifier, the condenser, the link reader, the `openrouter` engine of `web.search`).

With `features.coreTools` on, no helper reads for the persona: a link posted in chat is shown with the opening of the page's own text (`web.links.previewChars`, no model request); her `web.search` returns the engine's results as they are (title, link, site, date, snippet; no summary request); her `web.read` returns one page's extracted text, cut at `web.links.readChars`. Both are skills granted to her by name (`/nep access grant`), like `memory.search`.

| Key | Default | Meaning |
|---|---|---|
| `maxPerDay` | `60` | Shared daily cap for link reads and search requests combined |
| `acceptLanguage` | `"en,ru;q=0.8"` | The Accept-Language header sent when a page is read; empty sends none |

### `web.links`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Read links posted in chat (http/https only, private addresses refused, video-site links excluded) |
| `prefill` | `true` | Read a link as soon as it arrives, so the next turn finds it cached |
| `prefillPerUserPerDay` | `10` | Max links the prefill reads per member per day on arrival; the turn path is not limited by this |
| `maxPerTurn` | `2` | Max new link reads per turn (each fetch attempt counts) |
| `maxBytes` | `1500000` | Max page size (bytes) before the page is refused |
| `textChars` | `6000` | Max characters of page text sent to the condenser |
| `summaryChars` | `700` | Max characters for the condensed excerpt; fills `{{maxChars}}` in `read-link.md` |
| `previewChars` | `700` | With `features.coreTools` on: max characters of the page-text opening shown for a link posted in chat (no condenser) |
| `readChars` | `4000` | Max characters of page text the persona's `web.read` returns; longer pages are cut and say so |
| `readCacheHours` | `6` | Hours a page read by `web.read` is served from the cache (a failure is not cached) |
| `maxOutputTokens` | `4000` | Max output tokens for the condenser |
| `fetchTimeoutMs` | `10000` | Download timeout per page (ms) |
| `skipSites` | `["cdn.discordapp.com", "media.discordapp.net", "tenor.com", "giphy.com", "klipy.com", "imgur.com", "i.redd.it", "v.redd.it", "pbs.twimg.com"]` | Hostnames (subdomains included) whose links are never read (in addition to video sites, which are always excluded) |

### `web.search`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Run a search when the classifier fires; the `brave` engine needs `BRAVE_SEARCH_API_KEY` in `.env` |
| `engine` | `"brave"` | The search engine: `brave` (Brave Search, needs `BRAVE_SEARCH_API_KEY`), `exa` (Exa, keyless; `EXA_API_KEY` optional) or `openrouter` (OpenRouter's web plugin on Exa: one `analyzer` request searches and condenses, billed to credits; for the persona's own `web.search` the same request carries only her query and its answer is not read, the results being the plugin's citations) |
| `fallback` | `[]` | Engines tried in order when the chosen one fails with `rate-limited`, `timeout` or `network` (never after an empty result); the daily `web.maxPerDay` slot is spent once per lookup |
| `maxPerTurn` | `1` | Max searches per turn |
| `results` | `5` | Number of search results requested (1-10; the web plugin's `max_results` for `openrouter`) |
| `summaryChars` | `900` | Max characters for the condensed answer; fills `{{maxChars}}` in `search-summary.md` |
| `snippetChars` | `400` | Max characters of each result's snippet in the persona's own `web.search` result |
| `resultsChars` | `3000` | Max characters of the whole `web.search` result; results past it are left out |
| `rawOutputTokens` | `256` | Max output tokens of the `openrouter` engine's request for `web.search` (its answer is never read; the plugin's results are) |
| `maxOutputTokens` | `4000` | Max output tokens for the condenser |
| `classifierMaxOutputTokens` | `2000` | Max output tokens for the search classifier and the turn planner. Raised to fit the multi-line answer format (`web:`, `server:`, `who:`, `when:`). A reasoning model that thinks before answering needs a larger cap |
| `cacheHours` | `24` | Hours a cached search result is served before re-searching |
| `contextMessages` | `50` | Recent channel messages rendered as a `<transcript>` for the search classifier |
| `timeoutMs` | `10000` | Search request timeout (ms) for `brave` and `exa` |

## `image`

Settings for the drawing sub-process (`features.imageGeneration`). The persona calls the `draw.create` tool; code generates one picture through OpenRouter's Images API and posts it as a separate message. Generation and daily counts are stored in `data/state.json` (`imageDay`, `imageCount`, `imageUsers`). All pictures go through `models.base.drawing`.

| Key | Default | Meaning |
|---|---|---|
| `maxPerDay` | `50` | Daily generation cap for the whole instance |
| `maxPerUserPerDay` | `50` | Daily generation cap per member; spontaneous turns and `/nep draw` do not count against a member |
| `maxPromptChars` | `1600` | Scene text of a `draw.create` call is clamped to this length, cut at the last sentence or word boundary |
| `reference` | `"avatar"` | What to send as a visual reference when the persona is in the picture (`self` true). `"avatar"` downloads the bot's Discord avatar; any other value or `null` sends nothing |
| `referenceMaxBytes` | `4000000` | Max avatar file size (bytes); a larger avatar is skipped |
| `outputFormat` | `"png"` | Requested output format (`png`, `jpeg`, `webp`) |
| `aspectRatio` | `"auto"` | Aspect ratio (`auto`, `1:1`, `16:9`, `9:16`, etc.). For Google models, `auto` is omitted from the request |
| `timeoutMs` | `120000` | Request timeout (ms) |
| `retries` | `1` | Retries on transient failures (HTTP 408/429/5xx, network errors) |
| `provider` | `null` | OpenRouter `provider` routing for image requests, used when no `llm.providerByModel` entry matches; `null` sends nothing. Family-specific provider options (e.g. `openai.moderation`) are merged over the resolved routing |

### `image.openai`

Provider-specific options for `openai/*` image models.

| Key | Default | Meaning |
|---|---|---|
| `quality` | `"medium"` | Image quality (`auto`, `low`, `medium`, `high`; 2.5 models also accept `xhigh`, `max`) |
| `background` | `"auto"` | Background mode (`auto`, `opaque`; 2.5 models also accept `transparent`) |
| `moderation` | `"low"` | Sent as a provider passthrough under `provider.options.openai.moderation` |

### `image.google`

Provider-specific options for `google/*` image models.

| Key | Default | Meaning |
|---|---|---|
| `resolution` | `"1K"` | Output resolution (`512`, `1K`, `2K`, `4K`; support varies by model). `gemini-2.5-flash-image` has no resolution knob |

## `diary`

Settings for the diary channel (`features.diary`). The persona posts in one owner-chosen channel on its own, at random times drawn from configurable windows. Each post is planned by a classifier, then composed by the main model with the character card and all the usual memory blocks. All hot-reloaded. See [Diary](diary.md) for the setup and cost.

| Key | Default | Meaning |
|---|---|---|
| `channelId` | `""` | The diary channel. Set with `/nep set diary.channelId` or in `config.local.json`, read at every tick. Empty means no diary |
| `world` | `false` | Include `prompts/world.md` as a `<world>` block in the diary's plan and compose requests. Must be exactly `true`; a missing key counts as off. `/nep set diary.world true` turns it on. The file describes the persona's virtual world, used only by the diary, never in an ordinary turn |
| `windows` | see below | Posting windows in `bot.timezone`. Each window has `from` and `to` (hours 0–24, wrapping past midnight) and `posts: [min, max]` (how many posts the window draws). The default four windows are described in [Diary: windows](diary.md#windows) |
| `quietDayChance` | `0.3` | Chance that the whole day gets no posts. Rolled once when the day plan is created |
| `hungerBoost` | `0.5` | How strongly an empty window pushes later posts. A window that drew no posts gets one extra roll per hunger point, and each roll redraws its count with chance 1 minus this value. `1` turns hunger off |
| `quietCarry` | `0.25` | After quiet days in a row the quiet chance is `quietDayChance` times this value per quiet day, so a long silence gets less likely. `1` keeps the chance flat |
| `minGapMinutes` | `90` | Minimum minutes between two planned slots. A slot closer than this to the previous one is dropped |
| `maxPerDay` | `12` | Maximum posts per day. When the planner draws more slots than this, extras are dropped at random. |
| `maxPicturesPerDay` | `8` | Maximum diary pictures per day. Shared with `image.maxPerDay`: whichever cap runs out first wins. When spent, the plan's `picture` is forced false and the senses say no drawing. The cap is checked before a post starts; a set post counts every picture it generated, so one set can take the day's count past the cap |
| `slotGraceMinutes` | `30` | Minutes after a planned slot during which it still fires. A slot missed by more than this while the bot was down is dropped, not fired late |
| `forceWaitMs` | `120000` | Milliseconds a forced post (`tools/replay.mjs --diary`) waits for a running turn to finish before posting. When the wait runs out the answer is `busy`. Scheduled posts are not affected |
| `maxMessages` | `3` | Maximum `<msg>` messages per diary post. Excess messages are trimmed |
| `historyPosts` | `150` | Past posts kept in `diary.json` and shown to the planner and the composer in the `<diary>` block. The oldest are dropped when the cap is exceeded |
| `gistChars` | `200` | Characters kept per post gist and per picture scene in the diary history |
| `seedSets` | `2` | Random seed combinations drawn from `prompts/diary-seeds.md` and shown to the planner in the `<seeds>` block. `0` omits the block |
| `kinds` | `{ "selfPicture": 3, "picture": 2, "meme": 1, "thought": 2, "people": 2, "news": 2, "facts": 1, "status": 3, "photoset": 1, "randomSet": 1 }` | Post kinds with their weights. A kind with weight 0 is never chosen. The planner sees these weights and how many recent posts used each kind. Hot-reloaded, so the owner can steer the mix at any time |
| `searchKinds` | `["news", "facts"]` | Kinds that may trigger a web search. The planner writes a query only for these kinds |
| `pictureKinds` | `["selfPicture", "picture", "meme", "photoset", "randomSet"]` | Kinds that always get a picture when the day's picture caps allow it, whatever the planner answered. Other kinds draw only when the planner asks |
| `setKinds` | `["photoset", "randomSet"]` | Kinds whose post is a set of pictures instead of one. Keep them in `pictureKinds` too, so they are dropped with the other picture kinds when the post cannot carry a picture |
| `set.pictures` | `[4, 6]` | How many pictures a set has: the prompt asks for between the two numbers, a step takes at most the second as `draw.create` calls, and a set post stages at most that many pictures (the rest are `loop-cap` results) |
| `set.minPosted` | `2` | A set with fewer pictures staged than this when the post is due is not posted at all, its messages included. The pictures already generated still count against the day's picture caps |
| `set.seedSets` | `6` | Random seed combinations shown in a `<seeds>` block of the compose request of a set post (the plan request keeps `seedSets`). `0` omits the block |
| `set.maxMessageBytes` | `8000000` | The most picture bytes one Discord message carries. A set larger than this, or of more than 10 pictures, is split over several messages |
| `loop.maxSteps` | `2` | The most further requests one diary post makes after her calls (her picture calls and what they returned). The last one is always the final, no-action request |
| `loop.timeBudgetMs` | `600000` | How long the calls and follow-ups of one diary post may run, counted from its first call. Once it is spent, the next request is her last |
| `planMaxOutputTokens` | `2000` | Max output tokens for the plan request |
| `planTimeoutMs` | `60000` | Timeout for the plan request (ms). Also the limit of its hedged call when `llm.hedge.roles` includes `analyzer`, in place of `llm.hedge.timeoutMs` |

Default `windows`:

```json
[
  { "from": 7,  "to": 11, "posts": [0, 0] },
  { "from": 12, "to": 16, "posts": [0, 1] },
  { "from": 18, "to": 1,  "posts": [0, 2] },
  { "from": 1,  "to": 5,  "posts": [0, 1] }
]
```

Morning (7–11) is off. Day (12–16) draws 0 or 1 post. Evening (18–01 the next day) draws 0, 1 or 2. Night (01–05) draws 0 or 1. All times are in `bot.timezone`. A window whose `to` is not after its `from` wraps past midnight: `{ "from": 18, "to": 1 }` runs from 18:00 today to 01:00 tomorrow.

## `private`

Settings for private chat (`features.privateMessages`). All hot-reloaded. The gate checks these locally with zero tokens before any LLM request.

| Key | Default | Meaning |
|---|---|---|
| `minAffinity` | `5` | Minimum public attitude score to answer a DM; owners bypass this check |
| `maxPerUserPerDay` | `20` | DM turns per member per day that reached the model (answered or silent); a cap hit posts a limit notice once per day |
| `maxPerOwnerPerDay` | `200` | DM turns per day for bot owners that reached the model (answered or silent) |
| `purgeMaxMessages` | `5000` | Max DM messages `/nep memory private purge` scans (newest first) in one run |

With `features.relationships` off, public scores stay at 0, so with the default `minAffinity` only owners can DM.

## `warmup`

| Key | Default | Meaning |
|---|---|---|
| `lookbackDays` | `60` | How far back to sample (days) |
| `minMessages` | `30` | Own messages for a member to qualify |
| `maxPeople` | `40` | Members processed, most active first |
| `messagesPerPerson` | `2000` | Own messages sampled per member |
| `contextBefore` | `1` | Context lines before each sampled message |
| `maxChannelShare` | `0.5` | Max share of samples from one channel |
| `messagesPerChannel` | `200` | Newest messages a channel is described from |
| `serverSampleMessages` | `600` | Recent main-channel messages for the server request |
| `fetchLimitPerChannel` | `15000` | Messages fetched per channel for the sample pool |
| `maxOutputTokens` | `6000` | Max output tokens per warmup request |
| `maxRequestTokens` | `120000` | Max tokens per warmup request (input + output) |
| `maxTokens` | `6000000` | Total token budget for the run |
| `rateLimitWaitMinutes` | `10` | Minutes to wait on a rate limit |
| `rateLimitMaxWaits` | `36` | Consecutive waits before the run aborts |

## `agents`

The persona's errand agents: two separate processes (`scout` and `server`), each an OpenCode worker behind a Unix socket, that run tasks the persona hands off (`src/agent-runner/`); the core side (`src/errands/`) queues the tasks, sends them to the runner of an enabled profile and brings the results back to her. A profile with `enabled` off answers every task `not-configured`. The agents run on their own OpenRouter key (`OPENROUTER_ERRAND_KEY`), never the persona's; like every key it lives in the bot's `.env`, and the core sends it with each task, with, for `scout`, the proxy `MEDIA_VIDEO_PROXY` (the residential proxy of the video fetches, sent in its http form) and `OPENCODE_WEBSEARCH_KEY` (optional); a runner's own environment is used only for what a task does not bring. Their models are `models.errands.scout` and `models.errands.server` (set with `/nep model set`; a runner reads the config again at each task, so a change reaches its next task without a restart). See [Errand agents](agents.md).

| Key | Default | Meaning |
|---|---|---|
| `opencodePath` | `"/opt/opencode/bin/opencode"` | Path to the OpenCode binary each task runs as a child process |
| `toolResultChars` | `6000` | Cap on each tool result the agent's model sees (OpenCode `tool_output.max_bytes`) |
| `maxDownloadBytes` | `20000000` | Size cap for a file the `scout` agent downloads (bytes) |
| `keepFilesHours` | `24` | Hours a task's output files are kept before deletion (applied by the runner: at its start and then hourly it deletes each task directory under its `out` whose newest file is older, never a running or queued task's; read from the config at each sweep) |
| `recentLines` | `6` | Lines of the channel an errand was asked in that its runner gets as `context.recent` (author's display name and text, each cut to 200 characters), taken from the analyzer's buffer when the task is queued; at most 20, `0` sends none. A task asked in a private chat sends none |
| `maxOpen` | `3` | Errands open (queued or running) at once, both agents together; one more is refused `cap-open`. The drawing agent's pictures are not errands and do not count |
| `resultMaxChars` | `3000` | Characters of an errand's result text in the `<task_result>` block of the turn its end opens |
| `unreadShown` | `5` | How many finished errands with unread results appear in `<tasks>` (oldest first). The rest are counted in one line (`labels.tasks.unreadMore`). A result is read when a completed result turn showed it or when `task.read` returned it; `task.resolve` also clears it |
| `resultRetrySeconds` | `30` | Seconds before an errand's result turn is tried again while another turn holds the persona's attention or fails (at most 20 tries; then the result waits, unread, in her `<tasks>` block) |
| `resultCooldownSeconds` | `60` | Seconds between two result turns in the same conversation |
| `ledger` | `{ "socket": null }` | The ledger mirror of the errands: `socket` is the ledger's Unix socket for the `core` principal (for example `/run/neptunia-ledger/core.sock`). With `null`, the errands are not mirrored. Read at the moment of use. See [Errand agents: the ledger mirror](agents.md#the-ledger-mirror) |

### `agents.scout`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Run the scout errand agent |
| `cost` | `{ "input": 2, "output": 6 }` | Model price (USD per million tokens) passed to OpenCode so its cost estimate is right (OpenCode's price catalog fetch is disabled in the sandbox). Set it to the price of the model in `models.errands.scout` |
| `socket` | `"/run/neptunia-agent-scout/sock"` | Unix socket the runner listens on and the core connects to |
| `out` | `"/var/lib/neptunia-agent-scout/out"` | Directory for per-task working dirs and output files; the core reads a task's files from `<out>/<task id>/` |
| `limits` | `{ "steps": 25, "seconds": 300 }` | Per-task caps: model calls, wall-clock seconds |
| `daily` | `{ "tasks": 40 }` | Per-day cap (UTC day), applied core-side when a task is asked for: `cap-tasks` past `tasks` |
| `search` | `{ "provider": "exa" }` | OpenCode web search provider: `exa` (no key) or `parallel` (needs a key in `OPENCODE_WEBSEARCH_KEY`) |

### `agents.server`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Run the server-read errand agent |
| `cost` | `{ "input": 2, "output": 6 }` | Model price (USD per million tokens) passed to OpenCode for its cost estimate; the price of the model in `models.errands.server` |
| `socket` | `"/run/neptunia-agent-server/sock"` | Unix socket the runner listens on and the core connects to |
| `out` | `"/var/lib/neptunia-agent-server/out"` | Directory for per-task working dirs and output files; the core reads a task's files from `<out>/<task id>/` |
| `limits` | `{ "steps": 20, "seconds": 120 }` | Per-task caps: model calls, wall-clock seconds |
| `daily` | `{ "tasks": 40 }` | Per-day cap (UTC day), applied core-side, as for `scout` |

### `agents.drawing`

The drawing agent (a `tool` agent: the core runs it, no runner). See [The drawing agent](agents.md#the-drawing-agent).

| Key | Default | Meaning |
|---|---|---|
| `limits` | `{ "seconds": 300 }` | How long one picture may take (wall-clock seconds); a longer run is cut off and counts as a timed-out generation |
| `daily` | `{ "tasks": 100 }` | Per-day cap (UTC day), applied core-side before a picture starts, with the same limit notice as `image.maxPerDay`: `tasks` is a picture count |

### `agents.thinker`, `agents.dev`, `agents.writer`

The development agents: they run outside this engine (the ledger's attempt runner and orchestrator read these keys; their models are `models.development.thinker`, `dev`, `writer`), so the bot only shows their spend, which it reads from the ledger (`agents.ledger.socket`) on the owner's `/nep status` card (`costs.development`).

| Key | Default | Meaning |
|---|---|---|
| `cost` | thinker `{ "input": 4, "output": 20 }`, dev `{ "input": 2, "output": 10 }`, writer `{ "input": 5, "output": 25 }` | Model price (USD per million tokens) for OpenCode's cost estimate; the price of the agent's model in `models.development` |
| `limits` | thinker `{ "steps": 400, "minutes": 60 }`, dev `{ "steps": 300, "minutes": 60 }`, writer `{ "steps": 150, "minutes": 45 }` | Caps of one run (a thinker turn, a dev or writer attempt): model calls, wall-clock minutes |
| `contextLimit` | `350000` | Thinker only: the context size (tokens) its model is given in OpenCode, which compacts its session before reaching it |
| `contextHard` | `400000` | Thinker only: a turn that ends above this context (tokens) without a compaction is followed by a handover and a fresh session |

## `intentions`

Settings for the persona's intentions (`features.intentions`; [Intentions](intentions.md)). Read at the moment of use.

| Key | Default | Meaning |
|---|---|---|
| `expiresDays` | `14` | An intention of hers (and an accepted candidate, from its acceptance) expires this many days after it was set, unless it names its own `expires` |
| `recurringExpiresDays` | `30` | A recurring intention of hers (`every=` set) expires this many days after it was set, unless it names its own `expires`; the expiry stays binding, the last occurrence before it carries the note `last-occurrence` on its `<wake>` line |
| `maxOpen` | `20` | At most this many of her intentions open (pending or waiting) at once: a new one, or accepting a candidate, is refused `cap-open` past it |
| `maxCandidates` | `5` | At most this many candidates from her lines per analyzer batch, and open at once (`{{maxCandidates}}` of `prompts/memory-intentions.md`) |
| `candidateExpiresHours` | `48` | A candidate she neither accepts nor rejects expires after this many hours |
| `waitHours` | `2` | The wait deadline when a wait on an errand names none |
| `expiryNoticeDays` | `2` | An intention whose expiry is this many days away or less ends its `<intentions>` line with the expiry (`labels.intentions.expiresSoon`), one-off, recurring, waiting and attention alike. One with no due time and no wait carries its expiry on every turn instead (`labels.intentions.noDue`: nothing will wake her for it) |

## `innerLife`

Settings for the persona's inner life (`features.innerLife`; [Inner life](inner-life.md)). Read at the moment of use. The persona cannot change this section or the switch herself (`/nep set` refuses them for her).

| Key | Default | Meaning |
|---|---|---|
| `mode` | `"shadow"` | `shadow`: an inner turn runs her reads (`web.search`, `web.read`, `memory.search`, `intent.list` and any other read) and records every other call as proposed in the journal, never running it, so a stretch of shadow shows what she would have done. `live`: her calls run through the gateway on her own grants. Anything but `"live"` is shadow |
| `tickSeconds` | `60` | How often the scheduler looks at what is due (seconds); ticks missed while the bot was down coalesce into the first one after it |
| `queueMax` | `20` | At most this many wakes wait at once; one more is journalled as an overflow and not queued |
| `chatMessages` | `30` | How many of the conversation's last messages an inner turn reads |
| `review.enabled` | `true` | Whether she has a daily review at all |
| `review.historyDays` | `14` | How many days of her own lines in the record decide her active hours (when she usually speaks) for the review's random moment |
| `review.expiredMax` | `5` | At most this many of her intentions that expired untouched since she was last told are listed in a review's `<wake>` (the newest first; the rest counted and told next time); a candidate is never listed. Each listed one is marked shown on its record once the review turn ran |
| `heartbeat.enabled` | `true` | Whether she has a heartbeat: a wake of its own with no outside reason, carrying facts about people, places, her own life and what happened since the last one ([Inner life](inner-life.md#the-heartbeat)). Inside `features.innerLife` and `innerLife.mode` like every wake |
| `heartbeat.everyMinutes` | `180` | The interval of the heartbeat (minutes), a dial for the experiment: from minutes to hours. The next moment is drawn after each run (and at start when none is kept in the inner state) |
| `heartbeat.jitterMinutes` | `60` | The interval is moved by a random amount in this many minutes either way, so the heartbeat has no fixed hour |
| `heartbeat.dueJitterMinutes` | `20` | An intention a heartbeat set for herself wakes her at its due time moved by a random amount in this many minutes either way (fixed per intention and due time, at most a quarter of the lead time, never past its expiry; 0 turns it off), so a round clock time is not hit to the second; intentions set in a conversation stay exact and she always sees the time she chose |
| `heartbeat.people` | `8` | How many members (the closest by affinity) the heartbeat's people block lists |
| `heartbeat.filteredShown` | `10` | How many lines the helpers filtered without her (the missed helper's dismissals, the address helper's "not to her", both from the journal) the heartbeat lists, newest first; the rest are counted |
| `heartbeat.closedShown` | `10` | At most this many of her closed intentions (done, cancelled, expired or dropped, the newest first, each with its outcome or reason) are listed in the heartbeat after her open ones; the rest are counted on one line. Nothing is deleted: a closed record beyond the 50 the file keeps moves to `intentions-archive.jsonl` |
| `heartbeat.historyDays` | `14` | How many days of the record are read for the last contact with each person in the people block and for the last line each of them wrote |
| `heartbeat.placesHours` | `6` | The places block of the heartbeat lists the places where others wrote in this many last hours (read from the record, her own lines left out); a place with no line in that time is not listed |
| `heartbeat.placesShown` | `6` | At most this many places in that block, the busiest first; the rest are counted |
| `heartbeat.placeLines` | `2` | How many of the newest lines of each place the block quotes (author, time, a preview, a media marker and a `#N` handle she can use in a message call's reply, in `media.look` and in a reaction) |
| `heartbeat.maxTokens` | `2500` | The cap of the whole heartbeat block (estimated tokens). Over it the lists shed their last items in this order: the lines filtered without her, the lines of what she did, the places beyond 3, the people beyond 5; the shed items are counted. `0` turns the cap off |
| `heartbeat.intentionsOnly` | `true` | A heartbeat may inspect memory and conversations (the allowlist is in [inner life](inner-life.md#what-a-heartbeat-may-do)), then change one intention (`intent.set`, `intent.update`, `intent.cancel`) or end with `<skip/>`. Other calls are refused `heartbeat-only` with a result she reads, and the turn ends after the first change that went through, with no further request. `false` gives back the earlier behaviour (the heartbeat may also post, react, read and start errands). Read when a call is planned, so a change applies to the next call |
| `heartbeat.maxOpen` | `3` | At most this many open (pending or waiting) intentions created by heartbeat turns (their record carries `origin: heartbeat`, stamped by the engine). At the cap `intent.set` from a heartbeat is refused `heartbeat-cap` with a result naming the open ones, so she can update or cancel one; the count and the create are one step. The origin changes no priority and no other limit |
| `heartbeat.maxRecurring` | `1` | Of those, at most this many recurring ones (`every=`); one more, or a heartbeat's one-off made recurring, is refused `heartbeat-recurring-cap` |
| `heartbeat.focusSource` | `"profiles"` | Where the heartbeat's people block takes its members from. `profiles`: the members she is closest to by the profiles' affinity, as before. `db`: her focus set in the memory database (`focus`, filled by the job `memoryDb.focus`): the close members first, then the exploring ones with a share of `focus.exploringShare` of `heartbeat.people` (rounded, at least one when there are any, more when the close set leaves room). While the memory database is closed the profiles are used. Only this block changes: everyone who speaks is recognised as before. Any other value counts as `profiles` |
| `caps.perChain` | `3` | Inner turns of one chain per local day (`bot.timezone`): an intention's `chain`, else the intention itself; a review is its day's chain. Past the cap the chain's wakes wait as `per-chain` and run after the local midnight. A feedback wake is never held and does not count against this cap. See [Inner life: bounds](inner-life.md#bounds) |
| `attention.settleSeconds` | `90` | The quiet an attention waits for before it wakes her: the newest line of the attended place must be this many seconds old (so she does not cut into a line being typed). The default of `intent.set attend=`; she may set her own `settle=`, 0 included ([Inner life](inner-life.md#her-attention)) |
| `attention.perDayDefault` | `12` | An attention's own bound: attend wakes per local day. The default of `intent.set attend=`; she sets her own with `perday=`. Past it the wake waits in the queue (`attend-per-day`) and runs the next local day |
| `attention.pageSize` | `12` | Places per page of her `places.list` skill (`page=` turns them; the total and how many more are always said) |
| `attention.placesInWake` | `8` | How many places (by recent activity, with the total) the page inside `<wake>` shows on every inner turn, and the `<places>` block of an addressed turn with `context.places` on. `0` keeps the view to her `places.list` skill |
| `attention.lookbackHours` | `24` | How far back the record is indexed for the places' lines: the lines and people since her last look there are counted within this window at most. An attention counts nothing from before it was set |
| `loop.maxSteps` | `4` | The tool loop's bounds of an inner turn, in place of `skills.loop` (which never reaches an inner turn; nobody waits for one, so its budget is generous, and `llm.maxRequestsPerDay` bounds the cost as before): the most further requests one inner turn makes after her calls. The last one tells her no call will run; one post or intention change she writes there still runs ([Inner life](inner-life.md)) |
| `loop.timeBudgetMs` | `180000` | How long the calls and follow-ups of one inner turn may run, counted from its first call. Once it is spent, the next request is her last |
| `loop.maxCallsPerStep` | `4` | The most calls of one answer that run; each one past it gets a `loop-cap` result and is counted in the turn record. Not an inner turn's: see `innerLife.loop.maxCallsPerStep` |
| `loop.callTimeoutMs` | `60000` | The most one call of an inner turn may run: this, or what is left of `loop.timeBudgetMs` (2 seconds at least), whichever is smaller. A call that runs out of it is reported as `unknown` and never retried, as on every turn (`skills.callTimeoutMs` is not read for an inner turn's loop) |
| `retry.delaysMinutes` | `[1, 5, 15, 60]` | When an inner turn fails with `provider-limit`, `provider-error` or `timeout`, its wakes go back to the queue after the next delay in this list (minutes). The first failure uses the first value, the second failure the second, and so on; the last value repeats. See [Inner life: when a provider call fails](inner-life.md#when-a-provider-call-fails) |
| `retry.maxHours` | `6` | Retries continue as long as the first failure of that group is younger than this many hours. Past the window the wakes are dropped with code `provider` and told to her as a `wakeDropped` fact |
| `wakes.<kind>` | `{ "tools": "*", "maxActs": null, "maxTasks": null, "inputTokens": null }` for each kind | The envelope of each wake kind (`intention_due`, `review`, `errand_deadline`, `attend`, `feedback`, `heartbeat`). `tools`: `"*"` or a list of skill names (`<family>.*` names a family) an inner turn of that kind may call; checked at the call and again where a skill posts inside its own operation (a picture, a voice message), refused `not-allowed`. `maxActs`: the most calls that change something in one turn of that kind; `maxTasks`: the most errands (`task.run`); `null` is no cap. `inputTokens`: the input budget the envelope declares, recorded and not enforced yet. The defaults change nothing |
| `factsKeepDays` | `7` | Days an untold fact (a dropped or held wake, a failed call or turn) stays before it is removed. A told fact is kept one more day. See [Inner life: feedback](inner-life.md#feedback-on-her-own-turn) |
| `memory.enabled` | `true` | What an inner turn's reads found, with her thinking, goes to the memory analyzer as lines of hers ([Inner life](inner-life.md#what-she-found-goes-to-her-memory)); shadow turns too. `false`: no episode is buffered |

`loop.strayFollowUps` is retired. If set, a startup warning names it; the key is ignored. Output tags are lowered into calls now, so the stray follow-up step no longer exists.
| `memory.thinkChars` | `1200` | The end of her thinking kept in an episode (characters) |
| `memory.resultChars` | `1500` | Each read's result is cut to this many characters in an episode |
| `memory.maxFindings` | `5` | At most this many reads per episode, in the order she made them |
| `memory.maxSources` | `10` | At most this many links of one read listed as its sources |
| `memory.skills` | `["web.search", "web.read", "memory.search", "task.status", "task.list"]` | The read skills whose results make an episode; a turn whose reads are all of other skills buffers nothing |

## `appendStore`

The journal, record and archive are written through a shared append-only file writer. These settings control how it flushes and recovers.

| Key | Default | Meaning |
|---|---|---|
| `fsyncMs` | `500` | Append-only files under `data/` are flushed to disk (fsync) at most this long (ms) after a write; writes that must survive a crash flush at once |
| `retryMax` | `1000` | Lines kept in memory while the disk refuses writes, retried every second in order. When the queue is full, further writes are refused until the disk answers again |

## `journal`

The persona's journal: one record per turn (what of the chat went into the request, the hidden reasoning, what was posted, token usage), written by UTC day to `data/guilds/<id>/journal/<YYYY-MM-DD>.jsonl`. Needs `features.journal` (on by default).

| Key | Default | Meaning |
|---|---|---|
| `thinkChars` | `4000` | The persona's hidden reasoning is stored in the journal cut to this many characters at a word boundary; a cut record carries `thinkTruncated: true`. `0` stores it whole |
| `retentionDays` | `0` | Days a journal file is kept; `0` keeps it forever. Not yet applied |
| `keepRequests` | `3` | Days the request dumps are kept. Each turn writes a full dump of the model request and its raw answer to `requests/<day>/<turnId>-<attempt>.json` in the journal directory, and each later request of the turn (the tool loop's steps, the follow-up after a call) beside it as `<turnId>-<attempt>-s<step>.json` with the same fields and its `step` (a private chat's under its partner's private journal): the system prompt, the message parts as sent (pictures reduced to their size) and the raw answer with its token usage (`prompt`, `cached`: read from the prompt cache, `cacheWrite`: written to it, `completion`; the turn record carries the same). Day directories older than this many days are deleted at start and then daily. `0` writes no dump and deletes none. Needs `features.journal` |
| `offWindowHours` | `24` | How far back the journal is read for the persona's time away. See `features.offPeriods` |

## `record`

The witnessed record: every message the memory buffer takes, every message the persona posts and every feeling stored on an episode, written by UTC day to `data/guilds/<id>/record/<YYYY-MM>/<YYYY-MM-DD>.jsonl`. Never trimmed. Needs `features.record` (on by default).

| Key | Default | Meaning |
|---|---|---|
| `fsyncMs` | `500` | The record's files are flushed to disk (fsync) at most this long (ms) after a write. Read at startup |

## `archive`

Before anything leaves hot memory (an episode, interest, detail, alias, real name, lesson, attitude move, recent line, participation episode, diary gist or old version past its cap), a copy goes to `data/guilds/<id>/archive/<YYYY-MM>.jsonl`. The item stays in memory, over its cap, until the archive confirms the write. Never trimmed. Needs `features.archive` (on by default).

| Key | Default | Meaning |
|---|---|---|
| `pendingMax` | `500` | Copies waiting in the archive's pending queue (the disk refused them) before memory updates stop: past it no analyzer batch and no voice run is applied, the messages stay in the buffer, `memory: archive stalled` is logged and one status line goes to `bot.dryRunChannelId`. Updates resume by themselves once the queue is back at or under the limit. Read at each batch |
| `drainMs` | `30000` | How often (ms) the copies waiting in the pending queue are retried; once archived, their items leave memory. Read before each wait |
| `holdMaxMs` | `5000` | A memory file whose item was rewritten in place is not written to disk until the old version is in the archive (or its pending queue). On shutdown and on `/nep pause` the bot waits up to this long (ms) for that, then writes the file anyway and logs `store: flushed held`. Read at that moment |

## Models

The engine's own requests go out on the roles of `models.base`; the errand and development roles (`scout`, `server`, `thinker`, `dev`, `writer`) are run by OpenCode workers (see [`models`](#models)). Each is set independently, so the core can use a premium model while the helpers stay cheap. No role takes another role's model: an unset role keeps its own default.

### Core

The most capable model the budget allows. Roleplay quality, in-character consistency and natural conversation all depend on it. A smaller model breaks character, forgets context cues and sounds flat. In two-stage mode, the same model also words the persona's memory texts (purposes `reply`, `memory-voice`).

Default: `anthropic/claude-opus-4.6`. A cheaper option: `anthropic/claude-sonnet-4.6`.

### Analyzer

Picks one option from a short list (address, room, merge, route-channel, participation-pick, rewatch, split, gif-pick), plans searches and turns sources into notes (lookup, planner, recall-summary, search-summary, read-link, diary-plan). A cheap model that follows structured prompts reliably. Default: `openai/gpt-6.1-sol`.

### Extractor

Turns conversations into stored memory: the memory analyzer's batches, portraits, channel and server notes, warmup, backfill. Reasons over long transcripts and returns strict JSON. In two-stage mode (`features.memoryTwoStage`), this model runs stage A (neutral decisions). Default: `openai/gpt-6.1-sol`.

### Embedding

The embedding model, for meaning search. Default: `openai/text-embedding-3-large` with `embed.dimensions` 1024. Its requests go through the same transport, retries and daily cap as chat requests. The `/nep status` card probes it with a one-input embedding request; without an embedding client the line says it was not checked.

### Vision

Any cheap vision model. Writes one-line descriptions, so reasoning power barely matters.

Default: `google/gemini-3.8-flash`. Cheapest alternative: `google/gemini-2.5-flash-lite`.

### Video

Only models that accept BOTH video and audio input through OpenRouter work here. Models that take frames but no audio (Qwen VL, GLM, Seed, Gemma) do not hear speech and miss most of the point.

`google/gemini-flash-latest` is a floating alias whose price can change without notice. Batch (`:batch`) variants are asynchronous and unusable for a live reply. The direct-URL path (YouTube within the length cap, sent as a public URL with `media.video.provider`) needs Google AI Studio as the provider.

Cost per one-minute clip, USD, from OpenRouter prices on 2026-09-23:

| Model | ~USD / 1 min clip |
|---|---|
| `google/gemini-2.5-flash-lite` | 0.002 |
| `google/gemini-3.1-flash-lite` | 0.005 |
| `google/gemini-3.5-flash-lite` | 0.006 |
| `google/gemini-3.7-flash` | 0.014 |
| `google/gemini-3.8-flash` (default) | 0.014 |

`qwen/qwen3.8-omni-flash` also accepts video and audio. Prices change; the table is a snapshot as of the date above.

### Drawing

Generates pictures through OpenRouter's Images API (`POST /api/v1/images`). Only two families are supported: `openai/*` and `google/*`. An unsupported family is refused before any request or count.

**OpenAI models.** Honour `image.openai.quality`, `image.openai.background`, `image.openai.moderation`, `image.aspectRatio`, `image.outputFormat` and `input_references`.

| Model | Notes |
|---|---|
| `openai/gpt-image-2.5-flare` (default) | Fast tier |
| `openai/gpt-image-2.5-sunburst` | Editing-precision tier |
| `openai/gpt-image-2` | |
| `openai/gpt-image-1` | |
| `openai/gpt-image-1-mini` | |

**Google models.** Honour `image.google.resolution`, `image.aspectRatio`, `image.outputFormat` and `input_references`. `image.aspectRatio` of `auto` is omitted from the Google request.

| Model | Notes |
|---|---|
| `google/gemini-3.1-flash-image` | Nano Banana 2 |
| `google/gemini-3-pro-image-preview` | |
| `google/gemini-2.5-flash-image` | No resolution knob |

Pricing is per output token, not per picture; the provider's `usage.cost` is reported by `/nep draw` and logged. A request refused by the engine before it is sent (daily or per-member cap, unsupported model family) costs nothing; a generation the provider rejects is usually not billed; a timeout, or an upload that fails after the picture was generated, may still be billed.
