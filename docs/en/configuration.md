# Configuration

Every key in `config.json` with its default, grouped by section.

## `features`

| Key | Default | Meaning |
|---|---|---|
| `dryRun` | `false` | Full pipeline, never sends. See [Dry run](../../README.md#dry-run) |
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
| `triggerMarkers` | `true` | In the transcripts the persona and her helpers read, each line she posted names the message that started the turn which posted it (`labels.transcript.triggeredBy`, or `triggeredByOlder` when that message is out of view), so a late answer is not taken for an answer to a newer question. A missing key counts as on |
| `customEmoji` | `true` | List the server's custom emoji ranked by usage so the persona can use them by `:name:`. A missing key counts as on |
| `gifs` | `true` | Build a GIF library from what members share and let the persona post from it by handle. A missing key counts as on |
| `gifPicker` | `true` | When the persona's first message is at most `gifs.pick.maxChars` characters and she chose no GIF herself, a classifier picks a fitting GIF from the full library. On a match the GIF replaces that first message; the remaining messages follow as written. A missing key counts as on. Needs `features.gifs` on and a non-empty library |
| `embedUpdates` | `true` | When Discord attaches a link's embed after the message itself (Tenor GIFs arrive this way), fold it into the memory buffer so the GIF library and the analyzer see the GIF. A missing key counts as on |
| `multiMessage` | `true` | Allow 2–3 messages in a row |
| `vision` | `true` | Process attached images |
| `mediaDescriptions` | `true` | One-line descriptions for pictures, GIFs, video frames and link thumbnails |
| `attachedDescriptions` | `true` | Run the describer for pictures that are also attached to the request. Without this, attached pictures carry no helper's caption. A missing key counts as on. Needs both `vision` and `mediaDescriptions` on; one extra describer request per new picture, within `media.maxPerTurn` |
| `videoDescriptions` | `false` | Watch short video clips through a video-capable model; needs `mediaDescriptions` on as well. Turn on in `config.local.json`; still needs a video-capable model and, for site links, `yt-dlp`/`ffmpeg` |
| `videoRewatch` | `true` | When addressed, re-watch a video to answer a question about it; needs `videoDescriptions` on |
| `imageRelook` | `true` | When addressed, look at a picture again to answer a question or check a claimed detail about it; needs `vision` on. Shares the daily `media.video.rewatch.maxPerDay` counter with video re-watches. A missing key counts as on |
| `webLookup` | `false` | Read links posted in chat and search the web when asked a factual question. Unlike other features, a missing key counts as OFF. Needs `BRAVE_SEARCH_API_KEY` in `.env` for search; without it only link reading works. See [Media: Links and search](media.md#links) |
| `imageGeneration` | `false` | Let the persona draw pictures through a drawing sub-process. A missing key counts as on. Turn on in `config.local.json`; needs an image-capable model in `roles.drawing`. See [Media: Drawing](media.md#drawing) |
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
| `meaningSearch` | `false` | On each recall run, embed the asker's message and search the vector index by meaning. Record rows that match by meaning join the word-hit windows; archive rows join the memory items. Combined with word hits through reciprocal rank fusion. Must be exactly `true` to enable; a missing key counts as off. Needs `features.recall` on and the embedding model (`roles.embedding`) reachable. See `recall.meaningCandidates` |
| `embedIndex` | `false` | Keep the vector index current while the bot runs: every message the record takes is queued, and a batch is embedded every `embed.flushSeconds` seconds or once `embed.batch` lines wait. Must be exactly `true` to enable; a missing key counts as off. Needs `features.meaningSearch` on. Without this switch, the index is built only by `tools/embed-index.mjs` |
| `journal` | `true` | Keep the persona's journal: for every turn, one line when it starts and one when it ends (what of the chat went into the request, its hidden reasoning, what it posted and reacted to, token usage, the limits that cut something), in `data/guilds/<id>/journal/<YYYY-MM-DD>.jsonl` by UTC day; a private chat's turns go to `data/guilds/<id>/private/<userId>/journal/` instead. While on, the live log carries only the length of the hidden reasoning (`thinkChars`). Must be exactly `true` to enable; a missing key counts as off. See [`journal`](#journal) |
| `offPeriods` | `true` | `<now>` lists the periods of the last `journal.offWindowHours` hours when the persona was paused by the owner or the service was off, newest first, at most 3, from the journal's system records. Nothing is posted to any channel. A missing key counts as on. Needs `features.journal` |
| `record` | `true` | Keep the record: every message the memory buffer took (written before the batch is analyzed; a batch the disk refuses stays in the buffer and is retried), every edit as a new line with the next revision, every deletion, each message the persona posted and each feeling she stored on a moment, one line each, in `data/guilds/<id>/record/<YYYY-MM>/<YYYY-MM-DD>.jsonl` by UTC day. Only ids, time, channel, author, reply target, text, media kinds and mentions are kept, never a URL. A private chat's lines go to `data/guilds/<id>/private/<userId>/record/` instead. Never trimmed. Must be exactly `true` to enable; a missing key counts as off. See [`record`](#record) |
| `archive` | `true` | Keep the archive: before anything leaves the stored memory (an episode or an interest pushed out by a cap, a recent line or an exchange that expired, a lesson or a self-claim the analyzer removed, an in-joke list rewritten, an attitude move, a diary post or an old note version past its limit, the previous text of an interest changed in place), a copy goes to `data/guilds/<id>/archive/<YYYY-MM>.jsonl` by month (a private chat's items to `data/guilds/<id>/private/<userId>/archive/`). The item stays in memory, over its cap, until the archive confirms the copy; a copy the disk refuses waits in `archive/pending.jsonl` and is retried every `archive.drainMs`. Never trimmed. The same copy is not written twice. Must be exactly `true` to enable; a missing key counts as off. See [`archive`](#archive) |
| `recent` | `true` | Show a `<recent>` block of what happened on the server in the last few days. A missing key counts as on. See `memory.recentHours` and `context.caps.recent` |
| `participation` | `true` | The persona remembers its own exchanges on other channels over the last few days and, on a server turn, sees a few of them in a `<participation>` block. A missing key counts as on. See [`participation`](#participation) and `context.caps.participation` |
| `channelRoute` | `true` | A classifier picks a channel the conversation is about before a turn, so the channel can be pulled into the request. A missing key counts as on. See `route.*` |
| `turnPlanner` | `false` | One helper call before the reply replaces the channel router, the episode pick, the search classifier and the re-watch classifier; the address classifier and the GIF pick stay separate. Must be exactly `true` to enable; a missing key counts as off. Needs `prompts/planner.md` |
| `channelLinks` | `true` | When the persona writes `#channel-name` of a server channel in a message, the sent message carries a real channel link instead of the literal text. Names are matched longest first; an existing link stays. Off: text goes as written. A missing key counts as on |
| `messageLinks` | `true` | When the persona writes a transcript number like `#93` in a message and that number matches a line of the turn's transcript, the posted text carries a Discord message link to that message (Discord renders it as a clickable jump pill). A number that does not match a transcript line stays as written; code spans and existing URLs are untouched. In a DM the link uses `@me`. A missing key counts as on |
| `pauseNotice` | `true` | Post a short notice when the persona is called while paused. A missing key counts as on. See `mention.pauseNoticeMinutes` and `labels.limits.paused` |
| `diary` | `true` | The persona posts in one owner-chosen channel on its own, on a random schedule. A missing key counts as on; with no `diary.channelId` set, nothing happens. See [Diary](diary.md) |
| `splitTasks` | `true` | Split a long structured direct call into separate parts, each answered in its own turn. A missing key counts as on. Needs `prompts/split.md` and `labels.task.part` |
| `followUp` | `true` | Classify untagged messages after the persona answers to continue a conversation |
| `typingSimulation` | `true` | Simulate typing speed |
| `adminCommands` | `true` | Owner slash commands; `false` unregisters them |
| `memberCommands` | `true` | The `/nep pings` command, open to every member; `false` restricts it to owners |
| `skills` | `true` | The persona's skill gateway. `false` refuses every skill call, which also silences carried-over reply effects (messages, reactions, drawing): a full stop. A missing key counts as on |

## `skills`

| Key | Default | Meaning |
|---|---|---|
| `conversations` | `[]` | Conversations the persona may act in besides the current one (channel ids). Empty means the current conversation only |
| `safeMode` | `false` | Only the persona's carried-over reply effects pass (the tags of a normal reply: `<msg>`, `<react>`, `<draw>`, aimed at the current conversation). Every other skill is refused. Must be exactly `true` to enable |

## `bot`

| Key | Default | Meaning |
|---|---|---|
| `timezone` | `"UTC"` | Timezone for model timestamps |
| `owners` | `[]` | User IDs for owner commands |
| `commandName` | `"nep"` | Slash command name (lowercase `a-z 0-9 _ -`, up to 32 chars; re-registered on change) |
| `nameTriggers` | `[]` | Extra trigger strings besides @mention |
| `guildId` | `""` | Server to lock to; auto-detected if in exactly one |
| `dryRunChannelId` | `""` | Channel for the dry-run mirror. See [Dry run](../../README.md#dry-run) |
| `channels.allow` | `[]` | Allowed channels (empty = all visible) |
| `channels.deny` | `[]` | Ignored channels |
| `access` | `{}` | Who besides owners may run which commands (managed by `/nep access`) |

## `roles`

Eight model roles. Each is set independently under `roles.<name>` with its own default, so no role ever takes another role's model. `roles.byPurpose` pins a single purpose to a model of its own whatever its role.

| Key | Default | What it does |
|---|---|---|
| `voice` | `"anthropic/claude-opus-4.6"` | Speaks as the persona: the reply and the memory texts worded in its voice (purposes `reply`, `memory-voice`) |
| `analyzer` | `"openai/gpt-6.1-sol"` | Picks one of a few given options: address, room, merge, route-channel, participation-pick, rewatch, split, gif-pick |
| `reasoner` | `"openai/gpt-6.1-sol"` | Plans a search and turns sources into notes: lookup, planner, recall-summary, search-summary, read-link, diary-plan |
| `extractor` | `"openai/gpt-6.1-sol"` | Turns conversations into stored memory: analyzer batches, portraits, channel and server notes, warmup, backfill |
| `vision` | `"google/gemini-3.8-flash"` | Describes a picture (describe, relook) |
| `video` | `"google/gemini-3.8-flash"` | Watches a video and looks at it again |
| `embedding` | `"openai/text-embedding-3-large"` | Turns text into vectors for search by meaning. `embed.dimensions` (default 1024) sets the width. Probed by `/nep status` with a one-input embedding request; without an embedding client the line says it was not checked |
| `drawing` | `"openai/gpt-image-2.5-flare"` | Generates the persona's pictures through OpenRouter's Images API. Only `openai/*` and `google/*` families are supported |
| `byPurpose` | `{}` | Per-purpose model override: an object whose keys are purpose strings (e.g. `lookup`, `recall-summary`, `diary-plan`, `planner`) and whose values are model ids. A match on purpose wins over the role's model. Not probed by `/nep status` |

**Migration from old keys.** One release reads the deprecated keys `llm.model`, `classifier.text`, `classifier.reason`, `classifier.media`, `classifier.video`, `classifier.embed`, `classifier.byPurpose`, `memory.model` and `image.model`. When any of them is present, the bot logs a startup warning naming the key and the `roles.*` entry it maps to. An old `classifier.text` maps to `roles.analyzer`; an old `classifier.reason` to `roles.reasoner`; `classifier.media` to `roles.vision`; `classifier.video` to `roles.video`; `classifier.embed` to `roles.embedding`; `classifier.byPurpose` to `roles.byPurpose`; `memory.model` to `roles.extractor`; `image.model` to `roles.drawing`; `llm.model` to `roles.voice`. An old `classifier.reason` entry that was `null` (the old "use classifier.text" fallback) maps to the `roles.reasoner` default instead. Move the values by hand and remove the old keys.

## `llm`

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `"https://openrouter.ai/api/v1"` | Chat completions endpoint |
| `temperature` | `1` | Sampling temperature |
| `maxOutputTokens` | `2000` | Max output tokens |
| `maxRequestTokens` | `50000` | Hard token cap per request |
| `safetyMargin` | `0.9` | Budgeting fraction of maxRequestTokens |
| `timeoutMs` | `300000` | Request timeout (ms) |
| `probeTimeoutMs` | `30000` | Timeout of each model probe on the owner's `/nep status` card (ms) |
| `helperTimeoutMs` | `30000` | Timeout for a helper that runs alongside the turn (the route classifier, the search classifier and the recall summary). A helper that runs past this limit is abandoned; the turn continues without its result |
| `retries` | `2` | Retries on transient HTTP errors (408/429/5xx) and network failures. A provider account's daily-quota 429 gets one attempt and is thrown at once, not retried |
| `maxRequestsPerDay` | `5000` | Daily request cap |
| `provider` | `null` | OpenRouter `provider` routing object, passed verbatim; `null` sends nothing |
| `providerByModel` | `{}` | Per-model provider routing; see below |
| `cache.ttl` | `"1h"` | Cache TTL of the markers on the system message and on the reply's stable user prefix (the stable `<senses>` lines, `<self_facts>`, `<about_chat>`, `<gifs>`): `"1h"` or `"5m"` |
| `cache.profilesTtl` | `"1h"` | Cache TTL of the separate marker on the reply's profiles (`<people>`): `"1h"` or `"5m"`; `null` or `false` = no marker there. Never longer than `cache.ttl` (a `"5m"` `cache.ttl` makes it `"5m"`) |
| `cache.roles` | `["voice"]` | Request roles whose system message (and, for the reply, the stable user prefix and the profiles) gets the cache marker. Memory-voice requests opt out, so only the reply is cached. Add `analyzer` and `reasoner` to cache the helpers' stable parts too |
| `cache.models` | `["anthropic/"]` | Model id prefixes (case-sensitive) whose provider accepts the `cache_control` marker. A request to a model outside the list is sent without one |
| `cache.promptIncludesCached` | `true` | Whether the provider's reported `prompt_tokens` already includes cached and cache-write tokens. Set once from a probe; the token calibration and the per-request cap use the full count either way |
| `hedge.roles` | `["analyzer", "reasoner"]` | Request roles whose calls are hedged (two concurrent attempts, first to finish wins) |
| `hedge.afterMs` | `2500` | Milliseconds before the second attempt starts. `0` or below turns hedging off for all roles |
| `hedge.timeoutMs` | `8000` | Milliseconds from the first attempt's start at which both are aborted if neither has returned |
| `hedge.longTimeoutMs` | `20000` | Timeout used instead of `timeoutMs` when the caller marks the request `long: true` (the route classifier does this for a large channel list) |

`llm.provider` sets a default OpenRouter provider routing on chat requests, for example `{ "ignore": ["some-provider"] }` or `{ "order": ["anthropic"], "allow_fallbacks": true }`. `llm.providerByModel` adds per-model overrides: each key is a model id prefix (matching any role) or `<prefix>@<role>` (matching one role only), and each value is an OpenRouter routing object sent verbatim.

For one request the provider is resolved in order: a per-call pin (the video describer uses `media.video.provider` for the direct-URL path), then the longest matching prefix among `providerByModel` keys for the request's role, then the longest matching prefix among role-less keys, then `llm.provider` (for image requests `image.provider`), then nothing. A role-specific key always beats a role-less key for the same model. Role names: `voice`, `analyzer`, `reasoner`, `extractor`, `vision`, `video`, `embedding`, `drawing`.

Example: `"google/": { "only": ["google-vertex"], "allow_fallbacks": false }` routes all Google models through Vertex, while `"google/@video": { "only": ["google-ai-studio"], "allow_fallbacks": false }` sends the video role through AI Studio.

If the OpenRouter account itself restricts allowed providers, ignoring the only one left makes every request fail with "No endpoints found". After changing provider settings, check `/nep status` to verify that every model role is reachable; each role follows its `llm.providerByModel` route, so the provider shown is the one that route selects.

With `features.promptCache` on, the system message is marked for the provider's prompt cache on requests whose role is in `llm.cache.roles` and whose model starts with a prefix in `llm.cache.models`. On the reply, two more markers follow in the user message: one at the end of the stable prefix (`llm.cache.ttl`) and one at the end of the profiles (`llm.cache.profilesTtl`); three of the provider's four markers in all. See "Cache segments" in the [prompt contract](prompt-contract.md). Three helper requests send their user message in two parts so the provider can cache the bulk that repeats between calls: the GIF picker (the `<gifs>` library), the route classifier (the `<channels>` list) and the participation pick (the `<episodes>` list) tag that first part with the same `cacheSegment: 'stable'` (marker TTL `llm.cache.ttl`); the per-turn text follows untagged. The marker is placed only when the helper's role (`analyzer`) is in `llm.cache.roles` and its model matches `llm.cache.models`; add `analyzer` (and `reasoner` for the reasoning helpers) to `llm.cache.roles` to cache them. The markers go on after the token estimate, so the 50k per-request cap and the calibration are unaffected. `llm.cache.promptIncludesCached` tells the engine how the provider reports cached tokens; set it once from a real probe. The `llm: usage` log line gains `cache`: `write`, `read`, `none` or `off`.

The `llm: usage` log line also carries `ms` (wall time of the request), `purpose` (a short string naming what the request was for, e.g. `route-channel`, `recall-summary`, `address`), `origin` (e.g. `replay` for the requests of `tools/replay.mjs`), `hedged` (true when the request was hedged) and `attempt` (1 or 2 for hedged requests, absent otherwise).

With `llm.hedge` configured, requests on the roles it lists are hedged: a second attempt fires `llm.hedge.afterMs` after the first, and the first to finish wins. Both are aborted at `llm.hedge.timeoutMs` (or `longTimeoutMs` for a `long: true` request). This adds one extra request per hedged call that did not finish before the second started; both count against `llm.maxRequestsPerDay`.

## `embed`

| Key | Default | Meaning |
|---|---|---|
| `dimensions` | `1024` | Dimensions requested from the embedding model. A smaller value is faster and cheaper when the model supports truncation |
| `batch` | `64` | Lines flushed in one embedding request by the live queue (`features.embedIndex`) |
| `flushSeconds` | `180` | Seconds between live queue flushes. A flush also runs when `embed.batch` lines are waiting |
| `queueMax` | `2000` | Lines the live queue holds in memory. The oldest are dropped when the queue is full |
| `catchUpHours` | `72` | At start, when the embedding switches turn on, on resume and hourly, the queue re-embeds anything from the last this many hours that the index is missing. An hourly `embedder: coverage` log line reports the count |
| `catchUpEveryMinutes` | `60` | Minutes between catch-up sweeps while the bot runs. Each sweep covers the last `catchUpHours` |

Each message the record takes is embedded with its two preceding lines of the same channel as context, so a short answer carries what it answers. Archive items (episodes, lessons, evicted details and interests) get one vector each. Vectors are stored per month in `data/guilds/<id>/vectors/<YYYY-MM>/` as int8 rows with a per-row scale, one manifest and one metadata file per generation. A private chat's vectors live under `data/guilds/<id>/private/<userId>/vectors/`. `/nep memory forget` drops every row that names the member (same rules as the record and the archive) by rewriting the month files; `/nep memory wipe` deletes the whole `vectors/` tree.

Message text with author names is sent to the embedding provider (OpenAI through OpenRouter). A local forget removes the rows from the index but does not delete the provider's copy of the text.

## `context`

| Key | Default | Meaning |
|---|---|---|
| `channelMessages` | `100` | Current channel messages |
| `fetchReplyParents` | `true` | When a reply in the window points to a message older than the window, fetch the parent and place it before the window so the model can read what was replied to. The discord.js cache is checked before any API call. A missing key counts as on |
| `replyParentsFor` | `3` | How many of the newest window lines that reply to messages older than the window also get their parents fetched. The trigger message is always checked and can bring its parent and grandparent |
| `replyParentsMax` | `4` | Total parent lines placed before the window per turn |
| `neighborMessages` | `5` | Messages per neighbour channel |
| `neighborMaxAgeMinutes` | `60` | Max age for neighbour messages (min) |
| `neighborMaxChannels` | `8` | Max neighbour channels |
| `neighborMessageChars` | `300` | Characters kept per message from a neighbouring channel (`<other_channels>`) |
| `maxMessageChars` | `2000` | Truncate messages beyond this (chars) |
| `gapMarkerMinutes` | `20` | Time-gap marker threshold (min) |
| `ageAfterMinutes` | `60` | When the persona reads a chat, every message at least this many minutes old shows how long ago it was posted next to its time, as in `[14:32 · 2 h 58 min ago]`; newer messages show only `[14:32]`. Applies to the current channel and to pulled and neighbour channels. An empty `transcript.timeAged` in `prompts.local/labels.json` turns ages off |
| `reactionsPerMessage` | `6` | Max reactions listed per message in the transcript, most frequent first |
| `replyQuoteChars` | `80` | Code points of the parent message's text shown in a reply tag. The quote is cut at a word boundary. `0` shows the whole text |
| `otherProfiles` | `6` | Max other profiles shown |
| `askedAboutProfiles` | `3` | Members named in recent messages whose profiles are shown in full, ahead of the other participants |
| `askedAboutEpisodes` | `3` | Episodes shown per member who is asked about. `0` hides episodes for asked-about members. In a private chat, shown when `features.privateLikeServer` is on (the default); hidden otherwise |
| `attitudes` | `6` | Members shown in the `<attitudes>` block, ranked by attitude score strength, warm and cool mixed. `0` turns the block off |
| `tempo.liveMessages10min` | `4` | Messages in 10 min = "live" |
| `tempo.deadSilenceMinutes` | `45` | Silence minutes = "dead" |
| `caps.interlocutor` | `6000` | Token cap: caller's profile with episodes |
| `caps.aboutChat` | `2500` | Token cap: server habits / self-facts |
| `caps.lore` | `1500` | Token cap: lore entries |
| `caps.people` | `9000` | Token cap: other profiles |
| `caps.attitudes` | `400` | Token cap: attitude list |
| `caps.neighbors` | `3000` | Token cap: neighbour channels |
| `caps.server` | `4000` | Token cap: channel map |
| `caps.emoji` | `800` | Token cap: custom emoji |
| `caps.gifs` | `900` | Token cap: GIF library |
| `caps.pulled` | `4000` | Token cap: pulled channel block (`<channel_view>`) |
| `caps.participation` | `6000` | Token cap: the persona's exchanges on other channels (`<participation>`); whole episodes are dropped, the picked ones last |
| `channelActivity.liveMessagesPerDay` | `20` | Daily messages = "active" channel |
| `channelActivity.deadAfterDays` | `7` | Days without messages = "dead" channel |
| `vision.maxImages` | `4` | Max images per request |
| `vision.tokensPerImage` | `400` | Token budget per image |
| `vision.imageSize` | `512` | Via Discord's media proxy, a picture's longer side is scaled down to at most this many px with its aspect kept; a picture of unknown size is sent at its original size |
| `vision.recentImages` | `3` | Recent channel images to include |
| `vision.recentImageMinutes` | `30` | Max age for recent images (min) |
| `vision.maxBytes` | `1500000` | Max image file size (bytes); larger pictures are skipped |
| `vision.fetchTimeoutMs` | `10000` | Download timeout per image (ms) |

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
| `sameAudience` | `true` | Check that every role allowed to view the destination channel can also view the source. Also governs which neighbour channels appear in `<other_channels>` and which server-search windows the recall run keeps. When false, content from a restricted channel can reach a wider audience |
| `seenTtlMinutes` | `120` | Minutes before a previous view of the same channel in the same destination expires. A view older than this is ignored when comparing which messages are new. `0` = every view is treated as the first |

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

The persona's own exchanges on other channels (`features.participation`). Every message the persona sends in a server channel (not a private chat, not the diary channel, not a dry run) is saved with a few lines before it, the message it answered, and the lines that follow it, in `data/guilds/<id>/participation.json`. On a server turn the persona sees up to `shown` of these episodes from other channels in a `<participation>` block: the ones a classifier (`prompts/participation-pick.md` on the `analyzer` role) picks as the ones the message refers to, then the newest. Only channels everyone in the current channel can also read are offered (the `context.pull.sameAudience` rule). Logged as `participation: recorded`, `participation: classified`, `participation: skipped` or `participation: failed`.

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

Settings for the server-history search (`features.recall`). When the lookup classifier (`prompts/lookup.md`) answers with `server:` forms, `who:` name forms or `when:` date ranges, the engine searches the server's own message history through Discord's search API, groups the hits into clusters, fetches a window of messages around each, and asks a summary helper (`prompts/recall-summary.md` on the `reasoner` role) what the history answers. The summary may single out one stretch that the persona then gets verbatim alongside the condensed note. Logged as `recall: searched`, `recall: summary`, `recall: skipped` or `recall: failed`.

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
| `maxPerDay` | `100` | Daily recall runs (stored in `state.json` as `recallDay` / `recallCount`) |
| `timeoutMs` | `15000` | Total time for the recall run (search, windows, summary). Once half the time is gone no further search is sent; the summary runs only when at least `minSummaryMs` is left |
| `minSummaryMs` | `2500` | Minimum time left for the summary helper to be asked. Without it the verbatim stretch of the top window is returned without a note |
| `memoryItems` | `6` | Stored memory items (episodes, lore, lessons, recent lines, and archived items) matched against the classifier's word forms and name forms and sent in the `<memory>` block of the recall summary. `0` turns the match off |
| `memoryTokens` | `600` | Token budget of the `<memory>` block (estimated per line): lines are added in rank order until the next one would pass it. `0` = no line fits |
| `archiveMonths` | `6` | Months of the archive (items that left hot memory: evicted, expired or replaced) searched for `<memory>` when the question has no `when:` range; with a range, the archive is searched from the range's start. Read as a stream, never loaded whole. `0` = the archive is searched only for a dated question |
| `recordDays` | `3` | Days of the record (every observed message on disk) read for matching lines on any recall question: a dated question reads back from the end of its `when:` range, any other from now, at most this many days. A dateless question that is not a "recently" also keeps the earliest match's window. Matching lines become extra stretches marked `source: record`. `0` = the record is not read |
| `recordContext` | `3` | Lines before and after each matching record line added to its stretch, besides the chain of messages it replies to |
| `maxOutputTokens` | `500` | Max output tokens for the summary helper |
| `fallbackOnClassifierFailure` | `true` | Run recall from the trigger's own words when the lookup classifier fails (an error, a timeout or an empty answer) on a direct call and server recall is available. The plan uses words of 5+ letters (longest first, at most `maxForms`, the persona's name left out) as forms, members named by a stored name or alias as `who`, no date range and no web search. Logged as `lookup: fallback` |
| `meaningCandidates` | `80` | Rows returned from the vector index per meaning search. These candidates are fused with the word hits and then go through the same window builder and cluster ranking. `0` turns the meaning search off even when `features.meaningSearch` is on |
| `meaningWithReply` | `false` | When the trigger message is a reply and the replied-to message is among the recent lines, embed the trigger together with that line (the asker's question in context). Otherwise only the trigger is embedded |

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
| `ownMarkHours` | `24` | Hours after the persona posts a GIF during which the entry carries `gifs.ownMark` in the `<gifs>` list. `0` turns the mark off |

### `gifs.pick`

Settings for the GIF picker (`features.gifPicker`). When the persona's first outgoing message is short (at most `gifs.pick.maxChars` characters) and she chose no GIF herself, a classifier (`analyzer` role, prompt `prompts/gif-pick.md`) receives the last few chat lines with the answered message named, that first message, and the whole captioned library (every entry with its caption, each carrying the own-mark when applicable), and answers one handle or `none`. On a handle the GIF replaces the first message; the remaining messages follow in order. The classifier runs during the first message's typing simulation; the daily GIF rail `gifs.maxPerDay` applies.

| Key | Default | Meaning |
|---|---|---|
| `maxChars` | `160` | First message ceiling: the picker runs only when the persona's first outgoing message is at most this many characters |
| `contextMessages` | `4` | Recent chat lines sent to the classifier alongside the reply and the library |
| `maxOutputTokens` | `60` | Max output tokens for the picker classifier |

## `media`

Settings for the media describer (`features.mediaDescriptions`). The describer model is `roles.vision`.

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

### `media.gif`

Settings for watching GIFs as short clips (`media.gif.watch`). When enabled, a GIF's animation is converted to a short mp4 and sent to the `video` role's model instead of describing a single frame. The watched caption replaces the one-frame description. A GIF that cannot be watched (no animation source, a failed conversion, a spent daily cap) falls back to the one-frame description.

| Key | Default | Meaning |
|---|---|---|
| `watch` | `true` | Watch GIFs as short video clips instead of describing a single frame. Needs `features.mediaDescriptions` and `features.videoDescriptions` on. A missing key counts as on |
| `maxSeconds` | `15` | Seconds of the animation sent to the video model; the clip is converted with ffmpeg. A GIF's second look on a question (`media.video.rewatch`) uses the same cap |
| `maxPerDay` | `200` | Daily GIF watch cap, counted separately from `media.video.maxPerDay`. Once spent, a GIF gets the one-frame description instead. A GIF's second look on a question takes a slot here too |

### `media.video`

Settings for the video describer (`features.videoDescriptions`). Video vision needs BOTH `features.mediaDescriptions` and `features.videoDescriptions` on. The video model is `roles.video`. A separate video-capable model watches short clips: Discord video attachments and links to the sites in `media.video.sites`. Results are cached in the media cache alongside picture descriptions; a repost costs nothing.

| Key | Default | Meaning |
|---|---|---|
| `provider` | `{ "order": ["google-ai-studio"], "allow_fallbacks": false }` | OpenRouter provider routing for the direct-URL path (YouTube within the length cap). Overrides `llm.providerByModel` and `llm.provider` for this path; `null` lets the normal resolution order apply |
| `maxOutputTokens` | `800` | Max output tokens per video summary |
| `summaryChars` | `1500` | Max characters for a video account; fills `{{maxChars}}` in `describe-video.md` |
| `maxRequestTokens` | `60000` | Token cap per video request (input + output), used instead of `llm.maxRequestTokens`. A public-URL video in agentic mode uses `directUrlTokensPerSecond` (10) for the estimate: one hour of YouTube is 36 000 tokens. Downloaded clips use `tokensPerSecond` (120): three minutes is 21 600 tokens |
| `maxSeconds` | `180` | Max clip duration (seconds) for attachments and downloaded site videos; longer attachments are trimmed with `ffmpeg`, longer site videos are cut to their first `maxSeconds` by `yt-dlp`. Direct-URL sites use `directUrlMaxSeconds` instead |
| `directUrlMaxSeconds` | `3600` | Max duration (seconds) for a public-URL video (YouTube and other `directUrlSites`) when `urlProcessing` is `agentic`. In any other mode the effective cap is the smaller of this value and `maxRequestTokens / tokensPerSecond`. Longer videos take the download route (first `maxSeconds` via yt-dlp), which YouTube often blocks with a bot check on servers |
| `maxBytes` | `12000000` | Max file size (bytes) for attachments and downloaded site clips; the download itself may be up to 4x this size. Over-size files are re-encoded to 360p with `ffmpeg` first; only a clip still too large after re-encoding is refused as a permanent miss |
| `maxPerTurn` | `5` | Max NEW videos per turn; every fetch attempt counts, failed or not |
| `maxPerDay` | `40` | Daily video request cap (stored in `state.json` as `videoDay`/`videoCount`) |
| `tokensPerSecond` | `120` | Token estimate per second of video for the budget check. Applies to downloaded clips and to public-URL videos outside agentic mode; in agentic mode `directUrlTokensPerSecond` is used instead |
| `directUrlTokensPerSecond` | `10` | Per-second token estimate for the pre-flight budget check on a public-URL video in agentic mode (the model loads only what it needs; the video itself is not counted as prompt tokens). A missing or invalid value falls back to `tokensPerSecond`. `tokensPerSecond` (120) still applies to downloaded clips and to URLs in other modes |
| `timeoutMs` | `90000` | LLM request timeout for video (ms) |
| `toolTimeoutMs` | `60000` | Timeout for `yt-dlp` and `ffmpeg` subprocesses (ms) |
| `sites` | `["youtube.com", "youtu.be", "tiktok.com", "vk.com", "vkvideo.ru", "x.com", "twitter.com", "reddit.com", "twitch.tv"]` | Hostnames whose links are treated as video |
| `directUrlSites` | `["youtube.com", "youtu.be"]` | Sites whose public URL can be passed directly to the provider (the provider fetches the video itself) |
| `directUrlUnknownDuration` | `false` | Send a direct-URL-site link to the provider even when no probe could determine the duration; the token estimate uses `maxSeconds`. See the duration chain below |
| `canaryUrl` | `"https://www.youtube.com/watch?v=jNQXAC9IVRw"` | A fixed YouTube video probed at startup to test the YouTube API key and duration sources |
| `ytdlpPath` | `"yt-dlp"` | Path to the `yt-dlp` binary; needed for site video links and for probing duration |
| `ffmpegPath` | `"ffmpeg"` | Path to `ffmpeg`; needed for trimming and downscaling long or large attachments |
| `proxy` | `""` | A proxy URL for `yt-dlp`, in any format it accepts (`socks5h://user:pass@host:port`, `http://host:port`); `""` = no proxy. Needed when a site refuses the server's own address (YouTube returns "confirm you're not a bot" on datacenter IPs). Only links to `proxySites` use it. The value may hold credentials and never appears in the log. A proxied download fetches the whole video and `ffmpeg` cuts the first `maxSeconds` locally, because yt-dlp's section-download mode runs ffmpeg, which cannot use a SOCKS proxy; so the download ceiling (4x `maxBytes`) decides whether a long video fits |
| `proxySites` | `["youtube.com", "youtu.be"]` | Sites whose links use `proxy` for the duration probe and the download. A host matches when it equals a listed site or ends with `.<site>`. Links to other sites go direct. `[]` turns the proxy off |
| `proxyRetryMinutes` | `10` | After a proxied download or probe fails, the bot checks whether the proxy still accepts a connection. If it does, the video itself is the problem and the link is reported as not loaded. If the proxy is down, the link is retried without it at once, and all links skip the proxy for this many minutes (`fetch-video: proxy failed`, then one `fetch-video: proxy skipped` for the window). Kept in memory; a restart clears it |
| `errorRetryMinutes` | `60` | Minutes before an error-cached video is retried on its own; a forced retry from the re-watch classifier ignores this |
| `urlProcessing` | `"agentic"` | OpenRouter's processing mode sent on public-URL video parts; without it some providers see only a single frame. `null` omits the field |
| `reasoning` | `{ "effort": "low" }` | OpenRouter `reasoning` setting for every video request; keeps reasoning from eating the output budget. A non-object omits the field |
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
| `interestStaleDays` | `90` | Days without sighting before an interest is marked old |
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
| `supersededShownDays` | `7` | Days a replaced claim is still shown to the persona, once, next to the claim that replaced it (counted from when the new claim was recorded). Read at each request |
| `maxInjokes` | `15` | Max server in-jokes |
| `maxSelfFacts` | `20` | Max self-claims |
| `maxEpisodes` | `20` | Max episodes kept per person |
| `maxNewEpisodes` | `3` | Max new episodes per person per batch |
| `timeoutMs` | `900000` | Analyzer timeout (ms), separate from `llm.timeoutMs` |

The analyzer prompt reads these limits as placeholders, so raising a value takes effect on the next batch. Bigger profiles cost context tokens (`context.caps.people`, `context.caps.interlocutor`) and analyzer output (`memory.maxOutputTokens`).

**Migration.** `memory.voiceModel` is no longer read; a config that still sets it logs one warning and the value is ignored. Replies and memory wording both use `roles.voice`.

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
| `shownMoves` | `4` | Attitude moves shown after the score in the profile, strongest by absolute delta first. `0` hides them |
| `directTriggerCount` | `6` | Direct interactions that force early update |
| `decayPerDay` | `0.04` | Daily drift toward zero; per day the score loses `decayPerDay * |score| * (|score| / 100) ^ decayPower`. `0` or missing = off |
| `decayPower` | `1` | Exponent of the decay curve; higher values make scores close to zero decay slower. Not a positive number = 1 |
| `rewriteOnBandChange` | `true` | Flag a stored `relationship` text for rewrite when the attitude band has changed since it was written. Missing key = on |
| `rewriteOnDrift` | `8` | Flag the text for rewrite when the score has drifted this many points since the text was written, even within the same band. `0` = off |
| `rewriteAfterMoves` | `6` | Flag the text for rewrite after this many attitude history entries since the text was written. `0` = off |
| `bandHysteresis` | `2` | Points past the old band's edge before a band change is counted as a rewrite cause. Prevents rewrites from scores that hover near a band boundary |
| `textChars` | `800` | Max characters for the relationship text. Fills `{{relationshipChars}}` in the analyzer prompt. A rewrite over the limit is refused and the stored text stays; only the first write of an empty field is cut |

With `damping` on, a change that pushes the score further from zero is scaled by `(1 - |score| / 100) ^ dampingPower`, so extremes take sustained effort; a change back toward zero applies at full strength. The score is stored with fractional precision and shown as a whole number; `/nep memory affinity` sets it directly without damping.

With `decayPerDay` set, every stored affinity (public and private) drifts toward zero once a day. At score 100 with the default settings, the daily loss is 4; at 64 about 1.6; at 30 about 0.36. The sweep runs at startup and hourly, applying whole days from a per-profile stamp (`affinity.decayedAt`), so downtime is caught up. Never runs while paused or during the warmup. No attitude history entry is written.

## `lore`

| Key | Default | Meaning |
|---|---|---|
| `maxEntries` | `500` | Max lorebook entries per server |
| `scanMessages` | `30` | Messages scanned for key matches |
| `maxMatches` | `8` | Max entries shown per request |
| `textChars` | `600` | Lore entry text limit (chars). A rewrite over the limit is refused and the stored text stays; only the first write is cut. `/nep lore add` on an existing title stores the owner's text as written |

## `web`

Settings for the web lookup (`features.webLookup`). Both link reading and search share a daily counter (`web.maxPerDay`). Results are cached in the media cache (`data/guilds/<id>/media.json`). Model calls go through the `analyzer` role (the classifier) and the `reasoner` role (the condenser, the link reader).

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
| `maxOutputTokens` | `4000` | Max output tokens for the condenser |
| `fetchTimeoutMs` | `10000` | Download timeout per page (ms) |
| `skipSites` | `["cdn.discordapp.com", "media.discordapp.net", "tenor.com", "giphy.com", "klipy.com", "imgur.com", "i.redd.it", "v.redd.it", "pbs.twimg.com"]` | Hostnames (subdomains included) whose links are never read (in addition to video sites, which are always excluded) |

### `web.search`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Run a search when the classifier fires; needs `BRAVE_SEARCH_API_KEY` in `.env` |
| `maxPerTurn` | `1` | Max searches per turn |
| `results` | `5` | Number of Brave Search results requested |
| `summaryChars` | `900` | Max characters for the condensed answer; fills `{{maxChars}}` in `search-summary.md` |
| `maxOutputTokens` | `4000` | Max output tokens for the condenser |
| `classifierMaxOutputTokens` | `2000` | Max output tokens for the search classifier and the turn planner. Raised to fit the multi-line answer format (`web:`, `server:`, `who:`, `when:`). A reasoning model that thinks before answering needs a larger cap |
| `cacheHours` | `24` | Hours a cached search result is served before re-searching |
| `contextMessages` | `50` | Recent channel messages rendered as a `<transcript>` for the search classifier |
| `timeoutMs` | `10000` | Brave Search request timeout (ms) |

## `image`

Settings for the drawing sub-process (`features.imageGeneration`). The persona emits a `<draw>` tag; code generates one picture through OpenRouter's Images API and posts it as a separate message. Generation and daily counts are stored in `data/state.json` (`imageDay`, `imageCount`, `imageUsers`). All pictures go through `roles.drawing`.

| Key | Default | Meaning |
|---|---|---|
| `maxPerDay` | `50` | Daily generation cap for the whole instance |
| `maxPerUserPerDay` | `50` | Daily generation cap per member; spontaneous turns and `/nep draw` do not count against a member |
| `maxPromptChars` | `1600` | Scene text from the `<draw>` tag is clamped to this length, cut at the last sentence or word boundary |
| `reference` | `"avatar"` | What to send as a visual reference when the persona is in the picture (`self="yes"`). `"avatar"` downloads the bot's Discord avatar; any other value or `null` sends nothing |
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
| `channelId` | `""` | The diary channel. Written by `/nep diary set`, read at every tick. Empty means no diary |
| `world` | `false` | Include `prompts/world.md` as a `<world>` block in the diary's plan and compose requests. Must be exactly `true`; a missing key counts as off. `/nep set diary.world true` turns it on. The file describes the persona's virtual world, used only by the diary, never in an ordinary turn |
| `windows` | see below | Posting windows in `bot.timezone`. Each window has `from` and `to` (hours 0–24, wrapping past midnight) and `posts: [min, max]` (how many posts the window draws). The default four windows are described in [Diary: windows](diary.md#windows) |
| `quietDayChance` | `0.3` | Chance that the whole day gets no posts. Rolled once when the day plan is created |
| `hungerBoost` | `0.5` | How strongly an empty window pushes later posts. A window that drew no posts gets one extra roll per hunger point, and each roll redraws its count with chance 1 minus this value. `1` turns hunger off |
| `quietCarry` | `0.25` | After quiet days in a row the quiet chance is `quietDayChance` times this value per quiet day, so a long silence gets less likely. `1` keeps the chance flat |
| `minGapMinutes` | `90` | Minimum minutes between two planned slots. A slot closer than this to the previous one is dropped |
| `maxPerDay` | `12` | Maximum posts per day. When the planner draws more slots than this, extras are dropped at random. The daily count also gates `/nep diary post` |
| `maxPicturesPerDay` | `8` | Maximum diary pictures per day. Shared with `image.maxPerDay`: whichever cap runs out first wins. When spent, the plan's `picture` is forced false and the senses say no drawing. The cap is checked before a post starts; a set post counts every picture it generated, so one set can take the day's count past the cap |
| `slotGraceMinutes` | `30` | Minutes after a planned slot during which it still fires. A slot missed by more than this while the bot was down is dropped, not fired late |
| `forceWaitMs` | `120000` | Milliseconds `/nep diary post` waits for a running turn to finish before posting. When the wait runs out the command answers `busy`. Scheduled posts are not affected |
| `maxMessages` | `3` | Maximum `<msg>` messages per diary post. Excess messages are trimmed |
| `historyPosts` | `150` | Past posts kept in `diary.json` and shown to the planner and the composer in the `<diary>` block. The oldest are dropped when the cap is exceeded |
| `gistChars` | `200` | Characters kept per post gist and per picture scene in the diary history |
| `seedSets` | `2` | Random seed combinations drawn from `prompts/diary-seeds.md` and shown to the planner in the `<seeds>` block. `0` omits the block |
| `kinds` | `{ "selfPicture": 3, "picture": 2, "meme": 1, "thought": 2, "people": 2, "news": 2, "facts": 1, "status": 3, "photoset": 1, "randomSet": 1 }` | Post kinds with their weights. A kind with weight 0 is never chosen. The planner sees these weights and how many recent posts used each kind. Hot-reloaded, so the owner can steer the mix at any time |
| `searchKinds` | `["news", "facts"]` | Kinds that may trigger a web search. The planner writes a query only for these kinds |
| `pictureKinds` | `["selfPicture", "picture", "meme", "photoset", "randomSet"]` | Kinds that always get a picture when the day's picture caps allow it, whatever the planner answered. Other kinds draw only when the planner asks |
| `setKinds` | `["photoset", "randomSet"]` | Kinds whose post is a set of pictures instead of one. Keep them in `pictureKinds` too, so they are dropped with the other picture kinds when the post cannot carry a picture |
| `set.pictures` | `[4, 6]` | How many pictures a set has: the prompt asks for between the two numbers, the bot generates at most the second (the first `<draw>` tags of the answer, the rest ignored) |
| `set.minPosted` | `2` | A set with fewer pictures generated than this is not posted at all, its messages included. Generation stops early once the pictures left cannot reach it. The pictures already generated still count against the day's picture caps |
| `set.seedSets` | `6` | Random seed combinations shown in a `<seeds>` block of the compose request of a set post (the plan request keeps `seedSets`). `0` omits the block |
| `set.maxMessageBytes` | `8000000` | The most picture bytes one Discord message carries. A set larger than this, or of more than 10 pictures, is split over several messages |
| `planMaxOutputTokens` | `2000` | Max output tokens for the plan request |
| `planTimeoutMs` | `60000` | Timeout for the plan request (ms). Also the limit of its hedged call when `llm.hedge.roles` includes `reasoner`, in place of `llm.hedge.timeoutMs` |

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
| `keepRequests` | `3` | Days the request dumps are kept. Each turn writes a full dump of the model request and its raw answer to `requests/<day>/<turnId>-<attempt>.json` in the journal directory (a private chat's under its partner's private journal): the system prompt, the message parts as sent (pictures reduced to their size) and the raw answer with its token usage. Day directories older than this many days are deleted at start and then daily. `0` writes no dump and deletes none. Needs `features.journal` |
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

The engine uses eight model roles (`roles.*`). Each is set independently, so the voice can use a premium model while the helpers stay cheap. No role takes another role's model: an unset role keeps its own default.

### Voice

The most capable model the budget allows. Roleplay quality, in-character consistency and natural conversation all depend on it. A smaller model breaks character, forgets context cues and sounds flat. In two-stage mode, the same model also words the persona's memory texts (purposes `reply`, `memory-voice`).

Default: `anthropic/claude-opus-4.6`. A cheaper option: `anthropic/claude-sonnet-4.6`.

### Analyzer

Picks one option from a short list: address, room, merge, route-channel, participation-pick, rewatch, split, gif-pick. The cheapest text model that can answer "yes" or "no" reliably. Default: `openai/gpt-6.1-sol`.

### Reasoner

Plans a search and turns sources into notes: lookup, planner, recall-summary, search-summary, read-link, diary-plan. Default: `openai/gpt-6.1-sol`.

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
