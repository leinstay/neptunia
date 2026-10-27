# Configuration

Every setting lives in `config.json` with its default value. A deployment overrides what it needs in `config.local.json`, which is deep-merged over `config.json` at startup and on every file change. Plain objects merge key by key; arrays and scalars in the local file replace the base value whole.

Both files reload without a restart. Code reads `hot.config` at the moment of use, so an edit takes effect on the next request. A file that fails to parse (half-written JSON, an editor temp file) is ignored: the previous good value stays live and the error is logged. At startup, invalid JSON still throws so a broken deployment fails fast.

Any string value in the merged config may hold `${env:NAME}` (`NAME` is letters, digits and `_`, not starting with a digit). After the merge, each reference is replaced with the variable's value from `.env`, so a credential can stay in `.env` while the config holds only the reference. An unset variable becomes an empty string and is logged once (`config: env ref unset`). `/nep set` keeps the reference in `config.local.json`; it is resolved again on every reload.

## Where the private files live

By default everything sits in the checkout: `config.json`, `config/` and `prompts/` (tracked), your `.env`, `config.local.json`, `config.local/` and `prompts.local/`, and the `data/` directory the bot writes to. Two environment variables move the private parts out of the checkout:

| Variable | Default | What lives there |
|---|---|---|
| `NEPTUNIA_PRIVATE_DIR` | the checkout | `.env`, `config.local.json`, `config.local/`, `prompts.local/` |
| `NEPTUNIA_DATA_DIR` | `data/` in the checkout | everything the bot writes: `guilds/`, `state.json`, `usage.json`, `metrics.json`, caches |

Set them in the process environment (for example `Environment=` in the systemd unit), not in `.env`: the bot reads `.env` from the private directory, so it needs to know that directory first. A relative path is resolved against the checkout. An edit to `config.local.json` or a file in `prompts.local/` inside the private directory still reloads live. The tools read the same two variables; `--data` overrides the data path. At start the bot logs the three resolved directories (`index: paths`). `deploy/neptunia-bot.service` shows the recommended layout.

## Keys that moved

The persona's skills are tools in the settings. `src/config-moves.ts` holds the old names as an ordered list, and `src/config.js` applies it to `config.local.json` before the file is laid over `config.json`, so an old key still sets the value of its new name. Each load that moves a key logs one warning with the counts. Where both names are set, the new one wins.

| Old key | New key |
|---|---|
| `skills.*` | `tools.*` |
| `features.skills` | `features.tools` |
| `features.skillsDiscovery` | `features.toolsDiscovery` |
| `bot.access."skills.describe"` | `bot.access."tools.describe"` |
| `bot.access."task.run"`, `"task.status"`, `"task.read"`, `"task.resolve"`, `"task.cancel"`, `"task.list"` | `bot.access."errand.run"`, `"errand.status"`, `"errand.read"`, `"errand.resolve"`, `"errand.cancel"`, `"errand.list"` |
| `bot.access."intent.set"`, `"intent.update"`, `"intent.cancel"`, `"intent.list"` | `bot.access."intention.set"`, `"intention.update"`, `"intention.cancel"`, `"intention.list"` |
| `agents.opencodePath`, `toolResultChars`, `keepFilesHours`, `recentLines`, `maxOpen`, `resultMaxChars`, `unreadShown`, `resultRetrySeconds`, `resultCooldownSeconds` | the same names under `errands.*` |
| `agents.<name>.search.provider` | `agents.<name>.searchProvider` |

Six keys have no reader any more and are dropped: the grants `bot.access."memory.refresh.channel"`, `"memory.refresh.server"` and `"memory.refresh.user"`, `agents.maxDownloadBytes`, and `agents.thinker.contextLimit` and `contextHard`. The load log line counts them as `dropped` beside `moved` and `shadowed`.

`node tools/config-migrate.mjs --dry-run` prints each move for `config.local.json` (or `--file <path>`), each dropped key as `<path> dropped (no reader)`, and `--apply` writes the result into the file. A second run finds nothing to move. `--dry-run --compare-with <config.json>` reads the settings the moves touch twice, once the old way over the given `config.json` and once through the current readers over this checkout's, and prints `equal: <n>, differ: <n>` with one line per difference. It exits 1 on any difference. `--self <id>` names the persona's user id when `bot.self` is not set, so the grants can be compared.

The owner commands that edit `config.local.json` (`set`, `access grant`, `access revoke`) apply the same moves to the file before they read it, so a write never leaves a key of an old name beside the new one.

The tool texts moved too: `prompts/skills.json` is `config/tools.json`, and a deployment's `prompts.local/skills.json` is `config.local/tools.json` with the entry `skills.describe` renamed `tools.describe`. The `skills` section of `prompts.local/labels.json` is the section `tools`. The errand and intention names changed in the same layer: the ten tool entries `task.*` and `intent.*` of the tool texts are `errand.*` and `intention.*`, and in `labels.json` the section `tasks` is `errands`, the trigger `task` is `errand`, the note `task-missing` is `errand-missing`, the reason codes `no-task`, `task-ended` and `wait-without-task` are `no-errand`, `errand-ended` and `wait-without-errand`, and the placeholder `{task}` is `{errand}` in the texts that carry it. `node tools/tools-file-move.mjs --dry-run` and `--apply` do all of it, read `--dir` or `NEPTUNIA_PRIVATE_DIR`, and change no file when any part is refused. The engine refuses to start while `prompts.local/skills.json` exists.

## Rails

Two hard rails that must stay on:

- **50 000 tokens per request** (`llm.maxRequestTokens`). Every request the bot sends is budgeted against this cap. The prompt builder trims sections by priority to fit.
- **Daily request cap** (`llm.maxRequestsPerDay`, default 5000). Every model request counts (helpers, probes, tools, hedged duplicates).

## `features`

On/off switches. A missing key counts as on, except the ones that need `=== true` to enable: `dryRun`, `webLookup`, `mediaDescriptions`, `privateMessages`, `recallTrace`, `journal`, `record`, `archive`, `meaningSearch`, `embedIndex`, `promptCache`, `turnPlanner`, `missedRecovery`, `avatars`, `coreTools`, `anchoredWindow`, `intentions`, `innerLife`.

| Key | Default | What it does |
|---|---|---|
| `dryRun` | `false` | Full pipeline, never sends. See [Getting started](getting-started.md) |
| `mentions` | `true` | React to @mentions |
| `replies` | `true` | React to replies |
| `nameTriggers` | `true` | React to name mentions in messages |
| `followUp` | `true` | Classify untagged messages after the persona answers to continue a conversation |
| `splitTasks` | `true` | Split a long structured direct call into separate parts, each answered in its own turn. Needs `prompts/split.md` |
| `spontaneous` | `true` | Unprompted messages on a random timer |
| `eavesdrop` | `true` | Random chance to jump into any message |
| `memory` | `true` | Build profiles, track server patterns, record self-claims |
| `relationships` | `true` | Per-member attitude scores (-100 to 100) |
| `episodes` | `true` | Per-person long-term memories (moments, quotes, grudges) |
| `lore` | `true` | Server-wide lorebook |
| `reactions` | `true` | The persona places emoji reactions |
| `customEmoji` | `true` | Rank the server's custom emoji by usage so the persona can use them |
| `gifs` | `true` | Build a GIF library from what members share |
| `embedUpdates` | `true` | Fold a link's embed (Tenor GIFs arrive this way) into the memory buffer when Discord attaches it after the message |
| `seeReactions` | `true` | Show reactions on messages in the transcript. Distinct from `reactions` (whether the persona places them); this one controls whether she sees them |
| `reactionNames` | `true` | On the persona's own messages, each reaction shows who put it (up to `context.reactions.maxNames` names). Process memory only, never stored |
| `triggerMarkers` | `true` | Each line the persona posted names the message that started the turn which posted it, so a late answer is not taken for an answer to a newer question |
| `callMarkers` | `true` | A skill call she made shows on her line in the transcript: the skill, target, outcome and link |
| `previousThink` | `true` | A request carries her one previous think in a `<previous_think>` block. See `context.previousThink.minutes` |
| `multiMessage` | `true` | Allow 2 to 3 messages in a row |
| `mediaDescriptions` | `true` | One-line descriptions for pictures, GIFs, video frames and link thumbnails |
| `videoDescriptions` | `false` | Watch short video clips through a video-capable model. Needs `mediaDescriptions` on, a video-capable model and `yt-dlp`/`ffmpeg` for site links |
| `videoRewatch` | `true` | When addressed, re-watch a video to answer a question about it. Needs `videoDescriptions` on |
| `imageRelook` | `true` | When addressed, look at a picture again to answer a question about it. Shares the daily `media.video.rewatch.maxPerDay` counter with video re-watches |
| `webLookup` | `false` | Read links posted in chat and search the web. Needs `BRAVE_SEARCH_API_KEY` in `.env` for search; without it only link reading works. See [Media](media.md) |
| `recall` | `true` | Search the server's own message history when a question calls for it |
| `recallTrace` | `false` | Write one JSON line per recall run to `data/guilds/<id>/recall-trace.jsonl` for diagnosis. Capped at `recall.traceMaxLines` |
| `journal` | `true` | Keep the persona's journal: for every turn, one line when it starts and one when it ends (what of the chat went into the request, her hidden reasoning, what she posted, token usage), in `data/guilds/<id>/journal/<YYYY-MM-DD>.jsonl` by UTC day. Must be exactly `true` to enable. See `journal.*` |
| `offPeriods` | `true` | `<now>` lists the periods of the last `journal.offWindowHours` hours when the persona was paused or the service was off, newest first, at most 3. Nothing is posted. Needs `journal` |
| `record` | `true` | Keep the record: every message the memory buffer took, every edit as a new line, every deletion, each message the persona posted, in `data/guilds/<id>/record/<YYYY-MM>/<YYYY-MM-DD>.jsonl` by UTC day. Never trimmed. Must be exactly `true` to enable |
| `archive` | `true` | Keep the archive: before anything leaves hot memory, a copy goes to `data/guilds/<id>/archive/<YYYY-MM>.jsonl` by month. The item stays in memory until the archive confirms the write. Never trimmed. Must be exactly `true` to enable. See `archive.*` |
| `meaningSearch` | `false` | On each recall run, embed the question and search the vector index by meaning. Needs `recall` on and the embedding model reachable |
| `embedIndex` | `false` | Keep the vector index current while the bot runs. Needs `meaningSearch` on. Without it the index is built only by `tools/memory-db.mjs` |
| `imageGeneration` | `false` | Let the persona draw pictures. Needs a drawing model in `models.base.drawing`. See [Media](media.md) |
| `speech` | `true` | The persona's voice messages. Her `voice.say` skill sends text through the `speech` role and posts a voice message. See `speech.*` |
| `privateMessages` | `false` | Answer direct messages from guild members. Needs a stored public profile and `affinity.score >= private.minAffinity` |
| `privateLikeServer` | `true` | A private chat works like a server channel: route classifier, channel pull, server search, asked-about episodes. `false` restores the old DM behaviour |
| `gifPicker` | `true` | When the persona's first message is short, a classifier picks a fitting GIF from the library. Needs `gifs` on and a non-empty library |
| `versions` | `true` | Keep a version history of every prose memory field when its text is replaced |
| `recent` | `true` | Show a `<recent>` block of what happened on the server in the last few days. See `memory.recentHours` |
| `participation` | `true` | The persona remembers its own exchanges on other channels and sees a few of them in `<participation>` |
| `anchoredWindow` | `false` | Show older lines that still matter (reply parents, the persona's recent exchanges) in an `<earlier>` block |
| `promptCache` | `true` | Mark parts of the request for the provider's prompt cache. See `llm.cache.*` |
| `channelPull` | `true` | Pull another channel into a turn's request when the messages contain a real channel mention. See `context.pull.*` |
| `pullSeenMarker` | `true` | Show how many messages in a pulled channel are new since the persona last saw it |
| `channelRoute` | `true` | A classifier picks a channel the conversation is about before a turn, so it can be pulled. See `route.*` |
| `turnPlanner` | `false` | One helper call before the reply replaces the channel router, the episode pick, the search classifier and the re-watch classifier. Needs `prompts/planner.md` |
| `channelLinks` | `true` | When the persona writes `#channel-name`, the sent message carries a real channel link |
| `messageLinks` | `true` | When the persona writes `#93`, the posted text carries a Discord message link to that transcript line |
| `mentionHandles` | `true` | Every member with a stored profile gets a short handle (`@u7k2f`), listed in `<directory>`. The persona mentions people by handle |
| `elsewhere` | `true` | Answer a call from a channel where the bot can read but not send. The answer goes to the first usable channel in `memory.mainChannelIds` |
| `diary` | `true` | The persona posts in one owner-chosen channel on its own. With no `diary.channelId` set, nothing happens. See [Diary](diary.md) |
| `typingSimulation` | `true` | Simulate typing speed |
| `pauseNotice` | `true` | Post a short notice when the persona is called while paused. See `mention.pauseNoticeMinutes` |
| `adminCommands` | `true` | Owner slash commands. `false` unregisters them |
| `memberCommands` | `true` | The commands every member may run (`/nep pings`, `/nep task`, `/nep memory search`). `false` restricts them to owners |
| `tools` | `true` | The persona's tool gateway. `false` refuses every tool call |
| `toolsDiscovery` | `true` | The lookup classifier and the turn planner can name tools or request the full list. Off when `tools` is off |
| `coreTools` | `false` | Her own tools replace the classifiers before her reply. She looks things up herself with `web.search`, `web.read`, `media.look` and `memory.search`, each granted to her by name. See [Core](core.md) |
| `memoryPrefetch` | `true` | With `coreTools` on: before a turn, search the record and stored memory once with the trigger message and put the relevant excerpts in `<retrieved>`. See `recall.prefetch.*` |
| `missedAnswers` | `true` | Track messages that may have been left unanswered |
| `missedRecovery` | `false` | When the sweep finds owed candidates, start a reply turn. Off (the default), the sweep classifies and journals only |
| `offlineCatchUp` | `true` | At start, read the messages posted while the bot was down and answer recent calls. See `offlineCatchUp.*` |
| `around` | `true` | The persona sees what a member sees in Discord's sidebar right now (voice channels, activities) in `<people_now>`. See `context.around.*` |
| `avatars` | `false` | The persona knows what each member's avatar looks like. Each avatar is described by the vision model. See `avatars.*` |
| `intentions` | `false` | The persona keeps intentions: things she means to do later. See `intentions.*` and [Inner life](inner-life.md) |
| `innerLife` | `false` | The persona wakes on her own for a reason (a due intention, a review, a heartbeat). See `innerLife.*` and [Inner life](inner-life.md) |

## `discord`

| Key | Default | What it does |
|---|---|---|
| `intents.presences` | `false` | Request the privileged Presence intent so the persona can see members' activities in `<people_now>`. Read once at startup; a change needs a restart. The intent must also be enabled in the Discord Developer Portal |
| `intents.members` | `false` | Request the privileged Server Members intent. Same startup/restart rules. `avatars` uses it to see a changed avatar at once; without it a change is seen at the member's next message or the daily scan |

The voice-state intent (voice channels in `<people_now>`) is not privileged and always requested.

## `bot`

| Key | Default | What it does |
|---|---|---|
| `timezone` | `"UTC"` | Timezone for model timestamps |
| `owners` | `[]` | User IDs for owner commands |
| `commandName` | `"nep"` | Slash command name (lowercase `a-z 0-9 _ -`, up to 32 chars; re-registered on change) |
| `nameTriggers` | `[]` | Extra trigger strings besides @mention |
| `guildId` | `""` | Server to lock to; auto-detected if in exactly one |
| `dryRunChannelId` | `""` | Channel for the dry-run mirror |
| `access` | `{}` | Who besides owners may run which operations (managed by `/nep access`). See [Commands](owner-commands.md) |

## `models`

Three groups, the same three the `/nep status` card shows. Each role is set independently with its own default, so changing one never moves another.

- **`models.base`**: the bot's own requests. The core decides and speaks as the persona; each helper gathers, describes, extracts or finds.
- **`models.errands`**: delegated agents. Each runs its own OpenCode loop as a separate process. See [Errands](errands.md).
- **`models.development`**: agents that work on the repository, not on the persona's behalf. The engine only describes them and shows their spend.

### `models.base`

| Key | Default | What it does |
|---|---|---|
| `core` | `"anthropic/claude-opus-4.6"` | The persona's model. Purposes: `reply`, `memory-voice` |
| `memory` | `"anthropic/claude-opus-4.6"` | Her memory session and description review model. Same default as `core`, not a copy. Its key is `llm.keyByRole.memory` and never falls back |
| `analyzer` | `"openai/gpt-6.1-sol"` | Picks options (address, room, route, split, gif-pick, missed, etc.), plans searches and turns sources into notes. Pin one purpose to another model with `byPurpose` |
| `vision` | `"google/gemini-3.8-flash"` | Describes pictures (describe, relook, avatar) |
| `video` | `"google/gemini-3.8-flash"` | Watches video, looks again on questions |
| `embedding` | `"openai/text-embedding-3-large"` | Turns text into vectors for meaning search. `embed.dimensions` sets the width |
| `speech` | `"elevenlabs/eleven-v4"` | Speaks her text aloud through the speech endpoint. Named on the status card, never probed |
| `drawing` | `"openai/gpt-image-2.5-flare"` | Generates pictures through the Images API. Only `openai/*` and `google/*` families |

### `models.byPurpose`

An object whose keys are purpose strings (e.g. `reply`, `lookup`, `recall-summary`, `diary-plan`, `planner`, `web-search`) and whose values are model ids. A match on purpose wins over the role's model. Default: `{}` (no overrides). Not probed by `/nep status`.

### `models.errands`

| Key | Default | What it does |
|---|---|---|
| `scout` | `"openrouter/openai/gpt-6.1-sol"` | OpenCode model id of the scout errand agent |
| `server` | `"openrouter/openai/gpt-6.1-sol"` | OpenCode model id of the server errand agent |

### `models.development`

| Key | Default | What it does |
|---|---|---|
| `thinker` | `"openrouter/anthropic/claude-opus-5.5"` | OpenCode model id of the orchestrator |
| `dev` | `"openrouter/anthropic/claude-sonnet-5.5"` | OpenCode model id of the coding and writing worker |

Errand and development roles run on OpenCode, not the bot's client. They take OpenCode model ids (`openrouter/<vendor>/<model>`), unlike the base roles' bare OpenRouter ids. `/nep status` does not probe them and `/nep route` cannot route them.

## `llm`

| Key | Default | What it does |
|---|---|---|
| `baseUrl` | `"https://openrouter.ai/api/v1"` | Chat completions endpoint |
| `temperature` | `1` | Sampling temperature |
| `maxOutputTokens` | `2000` | Max output tokens |
| `maxRequestTokens` | `50000` | Hard token cap per request |
| `safetyMargin` | `0.9` | Budgeting fraction of `maxRequestTokens` |
| `timeoutMs` | `300000` | Request timeout (ms) |
| `probeTimeoutMs` | `30000` | Timeout of each model probe and of the key reads on `/nep status` (ms) |
| `helperTimeoutMs` | `30000` | Timeout for a helper running alongside the turn (route classifier, search classifier, recall summary). Past this the helper is abandoned |
| `retries` | `2` | Retries on transient HTTP errors (408/429/5xx) and network failures. A daily-quota 429 is thrown at once |
| `maxRequestsPerDay` | `5000` | Daily request cap |
| `provider` | `null` | OpenRouter `provider` routing object, passed verbatim |
| `providerByModel` | `{}` | Per-model provider routing. See the resolution order below |
| `keyByRole` | `{ "scout": "OPENROUTER_ERRAND_KEY", "server": "OPENROUTER_ERRAND_KEY", "drawing": "OPENROUTER_ERRAND_KEY", "thinker": "OPENROUTER_DEV_KEY", "dev": "OPENROUTER_DEV_KEY", "memory": "OPENROUTER_MEMORY_KEY" }` | Maps a role name to the NAME of a `.env` variable holding an OpenRouter key. Read at every request. A role not in the map falls back to `OPENROUTER_CORE_KEY`. The `memory` role is the exception: with `OPENROUTER_MEMORY_KEY` unset, the session is not configured and no request goes out on any other key |
| `cache.ttl` | `"1h"` | Cache TTL for the markers on the system message and the stable user prefix: `"1h"` or `"5m"` |
| `cache.profilesTtl` | `"1h"` | Cache TTL for the profiles marker: `"1h"`, `"5m"`, or `null`/`false` for none. Never longer than `cache.ttl` |
| `cache.roles` | `["core"]` | Roles whose requests get the cache marker. Add `analyzer` to cache helpers too |
| `cache.models` | `["anthropic/"]` | Model id prefixes whose provider accepts the `cache_control` marker |
| `cache.promptIncludesCached` | `true` | Whether the provider's reported `prompt_tokens` already includes cached and cache-write tokens |
| `hedge.roles` | `["analyzer"]` | Roles whose calls are hedged (two concurrent attempts, first to finish wins) |
| `hedge.afterMs` | `2500` | Milliseconds before the second attempt starts. `0` or below turns hedging off |
| `hedge.timeoutMs` | `8000` | Milliseconds from the first attempt's start at which both are aborted if neither returned |
| `hedge.longTimeoutMs` | `20000` | Timeout used when the caller marks the request `long: true` (the route classifier does this for a large channel list) |

### Provider routing resolution

For one request the provider is resolved in order: a per-call pin, then the longest matching `providerByModel` key for the request's role (`<prefix>@<role>`), then the longest matching role-less key (`<prefix>`), then `llm.provider`, then nothing. A role-specific key always beats a role-less key for the same model. A route may carry `"byok": true` (never sent to OpenRouter): an answer OpenRouter served from its own capacity instead of your provider account fails without a retry.

## `memoryDb`

The memory database. One SQLite file, kept in sync with the stored memory. See [Memory](memory.md).

| Key | Default | What it does |
|---|---|---|
| `file` | `"memory.db"` | The database file under `data/`. Tools open it read-only |
| `closeTimeoutMs` | `10000` | At shutdown, how long to wait for the pass under way before the worker is terminated |
| `turnReads` | `true` | After a turn's request is built, record which memory rows it carried in the database |
| `audienceColumn` | `false` | Filter memory rows by their `audience_id` column instead of the three scope columns. Both give the same rows |
| `diaryMedia` | `false` | Fetch diary posts' messages and save their text and pictures in the database. Needs `diary.channelId` |
| `diaryAudioMaxBytes` | `8388608` | Size cap for an audio attachment of a diary post saved next to the pictures |
| `focus.enabled` | `false` | Compute the focus set (the people her attention is on) once per UTC day from the relationship counts |
| `wakeRuns` | `false` | Record each inner turn as a wake run in the database |
| `skillsRegistry` | `false` | At each open of the database, register every skill with the hash of its definition and manifest |
| `observeTimeoutMs` | `5000` | How long the message handler waits for an observation's commit before going on |
| `backup.enabled` | `false` | Daily backup of the memory database. See the settings below |
| `backup.hour` | `3` | The UTC hour (0 to 23) from which the day's backup is taken |
| `backup.dir` | `"../backups/memory"` | Where the backups go, relative to the data directory or absolute |
| `backup.keep` | `7` | How many finished backups are kept |

### `memoryDb.session`

Her memory session: she reads new chat lines of one scope and says what she keeps, in her own voice, on the model `models.base.memory` and the key `llm.keyByRole.memory`. See [Memory](memory.md).

| Key | Default | What it does |
|---|---|---|
| `mode` | `"off"` | `off`: nothing runs. `shadow`: proposed changes are recorded as decisions, nothing applied. `apply`: changes are written to the database |
| `maxMessages` | `200` | Lines in one request |
| `minMessages` | `5` | A scope with fewer new lines waits |
| `sweepsPerScopePerDay` | `24` | Sweeps that reach one scope per UTC day |
| `everyMinutes` | `60` | Minutes between sweeps (with `mode` `apply`) |
| `reviewsPerDay` | `6` | Description reviews per UTC day. `0` disables |
| `settleMinutes` | `10` | Lines newer than this many minutes wait for the next sweep |
| `since` | `null` | An ISO date; a scope with no cursor starts from this date. `null`: the first line |
| `maxPeople` | `12` | People shown per request, most active first |
| `claimsPerPerson` | `30` | Claims listed per person |
| `selfMax` | `40` | Her own claims listed |
| `episodesMax` | `20` | Episodes listed |
| `maxOutputTokens` | `8000` | Token limit for a session request |
| `timeoutMs` | `300000` | Timeout of a session request |
| `descriptionMaxOutputTokens` | `1500` | Token limit for each call of a description review |
| `retryLimit` | `3` | How many sweeps an `all_dropped` batch is retried before it is skipped |

## `capture`

Foreign capture: when the persona is mentioned in a place her connection does not read continuously, the adapter fetches the context around that line. Not wired to a live adapter yet.

| Key | Default | What it does |
|---|---|---|
| `ancestors` | `2` | Reply chain above the anchor line in the first fetch |
| `before` | `3` | Lines before the anchor |
| `after` | `3` | Lines after the anchor |
| `pageLines` | `60` | Lines one expansion writes |
| `watch` | `[15, 120, 1440]` | Minutes after the anchor at which a watch looks again |
| `watchSameAuthor` | `20` | Later lines of authors already in the bundle that one watch asks for |

## `graph`

The memory graph: typed memory rows projected into nodes and edges, and the walks over it.

| Key | Default | What it does |
|---|---|---|
| `maxDepth` | `6` | Edges a walk follows from where it starts |
| `maxRows` | `2000` | Paths a walk visits before it stops |

## `focus`

Her focus set: the people her attention is on. Computed by the `memoryDb.focus` job. See [Memory](memory.md).

| Key | Default | What it does |
|---|---|---|
| `policyVersion` | `1` | Stored with every member and event; change when the rules or weights change |
| `size` | `24` | People in the close set |
| `exploring` | `4` | Exploring candidates outside the close set |
| `exploringShare` | `0.15` | Share of `innerLife.heartbeat.people` the exploring candidates get |
| `entryAffinity` | `0.6` | Attitude (as 0 to 1) a person needs to enter the close set |
| `margin` | `0.08` | How much a challenger's score must beat the lowest replaceable member |
| `confirmHours` | `24` | Hours a challenger must hold its lead across computations |
| `maxMovesPerWeek` | `2` | Changes of the close set in any 7 days |
| `settleDays` | `21` | Days a new close member cannot be replaced |
| `weights` | `{ "affinity": 0.55, "reciprocity": 0.15, "sharedInterest": 0.1, "recency": 0.1, "consistency": 0.1 }` | Score weights |
| `noveltyMax` | `0.12` | Novelty bonus after a first meaningful exchange |
| `noveltyHalfLifeDays` | `14` | Half-life of the novelty bonus (days) |
| `recencyHalfLifeDays` | `60` | Half-life of recency (days) |
| `consistencyDays` | `28` | Window for counting meaningful days |
| `consistencyCap` | `8` | Meaningful days in that window that give full consistency |

## `embed`

| Key | Default | What it does |
|---|---|---|
| `dimensions` | `1024` | Dimensions requested from the embedding model |
| `batch` | `64` | Lines flushed in one embedding request by the live queue (`embedIndex`) |
| `flushSeconds` | `180` | Seconds between live queue flushes |
| `queueMax` | `2000` | Lines the live queue holds in memory |
| `catchUpHours` | `72` | At start and hourly, re-embed anything from this many hours that the index is missing |
| `catchUpEveryMinutes` | `60` | Minutes between catch-up sweeps |

## `context`

| Key | Default | What it does |
|---|---|---|
| `channelMessages` | `100` | Current channel messages in the window |
| `fetchReplyParents` | `true` | When a reply points to a message older than the window, fetch the parent |
| `replyParentsFor` | `3` | Newest window lines that get their parents fetched. With `anchoredWindow` on, every line is asked |
| `replyParentsMax` | `4` | Total parent lines placed before the window per turn |
| `neighborMessages` | `5` | Messages per neighbour channel |
| `neighborMaxAgeMinutes` | `60` | Max age for neighbour messages (minutes) |
| `neighborMaxChannels` | `8` | Max neighbour channels |
| `neighborMessageChars` | `300` | Characters per message from a neighbouring channel |
| `maxMessageChars` | `2000` | Truncate messages beyond this |
| `maxUrlChars` | `200` | URLs longer than this are cut with an ellipsis. `0` keeps every URL whole |
| `gapMarkerMinutes` | `20` | Time-gap marker threshold (minutes) |
| `ageAfterMinutes` | `60` | Messages at least this old show how long ago they were posted |
| `deletedLinesMax` | `10` | Placeholder lines for messages deleted since the window starts, newest first. `0` turns them off |
| `reactionsPerMessage` | `6` | Max reactions listed per message, most frequent first |
| `reactions.maxMessages` | `500` | How many of the persona's own messages the reactor list follows. Process memory only |
| `reactions.maxNames` | `5` | Names shown per reaction on the persona's messages |
| `reactions.fetchUsers` | `10` | Reactors fetched per reaction after a restart |
| `reactions.fetchTimeoutMs` | `2000` | How long a turn waits for those fetches |
| `replyQuoteChars` | `80` | Code points of the parent text shown in a reply tag. `0` shows all |
| `otherProfiles` | `6` | Max other profiles shown |
| `failedTurnsKept` | `3` | Failed turns remembered per channel (within 24 hours), shown on the next request |
| `askedAboutProfiles` | `3` | Members named in recent messages whose profiles are shown in full |
| `askedAboutEpisodes` | `3` | Episodes shown per asked-about member. `0` hides them |
| `attitudes` | `6` | Members shown in the `<attitudes>` block. `0` turns it off |
| `around.maxTokens` | `400` | Token cap of the voice-channel entries that have no profile in the request |
| `tempo.liveMessages10min` | `4` | Messages in 10 minutes to count the channel as live |
| `tempo.deadSilenceMinutes` | `45` | Silence minutes before the channel counts as dead |
| `caps.interlocutor` | `6000` | Token cap: the caller's profile with episodes |
| `caps.aboutChat` | `2500` | Token cap: server habits and self-facts |
| `caps.people` | `9000` | Token cap: other profiles |
| `caps.attitudes` | `400` | Token cap: attitude list |
| `caps.intentions` | `600` | Token cap: `<intentions>` |
| `caps.neighbors` | `3000` | Token cap: neighbour channels |
| `caps.server` | `4000` | Token cap: channel map |
| `caps.lore` | `1500` | Token cap: lore entries |
| `caps.emoji` | `800` | Token cap: custom emoji |
| `caps.gifs` | `900` | Token cap: GIF library |
| `caps.pulled` | `4000` | Token cap: pulled channel block |
| `caps.participation` | `6000` | Token cap: the persona's exchanges on other channels |
| `caps.earlier` | `2500` | Token cap: the `<earlier>` block |
| `caps.recent` | `1200` | Token cap: recent block |
| `places` | `false` | Show an addressed server turn the places page in a `<places>` block. See [Inner life](inner-life.md) |
| `previousThink.minutes` | `30` | How long after a finished turn a new turn there still carries its think. `0` carries none |
| `channelActivity.liveMessagesPerDay` | `20` | Daily messages for an active channel |
| `channelActivity.deadAfterDays` | `7` | Days without messages for a dead channel |
| `vision.tokensPerImage` | `400` | Tokens charged per image part of a helper request |
| `vision.maxBytes` | `1500000` | Max picture file size (bytes) |
| `vision.fetchTimeoutMs` | `10000` | Download timeout per picture (ms) |

### `context.customEmoji`

| Key | Default | What it does |
|---|---|---|
| `max` | `30` | Custom emoji shown in the `<emoji>` block |
| `storeMax` | `200` | Custom emoji kept in the usage ranking |
| `halfLifeDays` | `30` | Recency half-life for the ranking (days) |
| `backfillMessages` | `500` | Messages read per channel from history at startup to seed the ranking. `0` disables |

### `context.pull`

Settings for pulling another channel (`features.channelPull`).

| Key | Default | What it does |
|---|---|---|
| `windowMinutes` | `60` | Minutes of messages to pull |
| `minMessages` | `5` | Minimum messages; the window extends back to reach this |
| `maxMessages` | `60` | Maximum messages per channel |
| `maxPictures` | `10` | Pictures whose captions are included |
| `maxNewDescriptions` | `8` | Fresh describer requests per pulled channel per turn |
| `describeTimeoutMs` | `15000` | Timeout for fresh caption requests (ms) |
| `scanMessages` | `20` | Recent messages scanned for channel mentions |
| `maxChannels` | `1` | Channels that can be pulled per turn |
| `maxAgeDays` | `0` | Refuse a pull when the channel's newest message is older than this. `0` = no limit |
| `sameAudience` | `true` | Check that every role allowed to view the destination can also view the source. Also governs neighbour channels and server-search windows |
| `seenTtlMinutes` | `120` | Minutes before a previous view expires. `0` = every view is first |
| `keepMinutes` | `10` | Minutes a pulled channel stays in the next turns after the one that pulled it |
| `keepTurns` | `3` | Turns that keep a pulled channel after the one that pulled it. `0` = never carries over |

## `mention`

| Key | Default | What it does |
|---|---|---|
| `ignoreChance` | `0` | Base ignore chance for a message that @mentions the persona |
| `followUpIgnoreChance` | `0` | Chance the persona leaves a follow-up unanswered |
| `emptyMentionIgnoreChance` | `0` | Ignore chance for a bare @mention |
| `repeatWindowMinutes` | `10` | Repeat tracking window (minutes) |
| `repeatPenalty` | `0` | Added ignore chance per repeat |
| `spamThreshold` | `50` | Calls in the window before spam |
| `spamIgnoreChance` | `0.9` | Ignore chance when spammed |
| `nameTriggerChance` | `1` | Name trigger response chance |
| `neverIgnore` | `[]` | User IDs never ignored |
| `affinityIgnoreBonus` | `0` | Max added ignore at affinity -100 |
| `affinityLikeBonus` | `0.08` | Max reduced ignore at affinity +100 |
| `oneAtATime` | `true` | One reply at a time across the server |
| `pendingSameChannel` | `true` | Hold a direct ping in the same channel while a turn is running there |
| `classifyWhileBusy` | `true` | Classify a follow-up candidate while a turn is running |
| `pendingOverheard` | `true` | Hold a line the classifier judges as talk about the persona while she is busy |
| `maxPending` | `6` | Total pending calls held across all channels |
| `pendingMinutes` | `10` | Minutes before a held ping expires |
| `switchDelayMs` | `[2000, 9000]` | Pause before answering in the next channel (ms) |
| `followUpMinutes` | `15` | Follow-up window after the persona's last reply (minutes) |
| `followUpClassifyReplies` | `true` | Send a reply to another member's message to the classifier |
| `followUpOverheard` | `true` | An `overheard` answer from the classifier starts its own turn with `prompts/overheard.md` |
| `followUpContext` | `15` | Transcript lines sent to the classifier |
| `followUpMaxOutputTokens` | `2000` | Max output tokens for the address classifier |
| `followUpAliases` | `5` | Stored aliases sent to the classifier. `0` sends none |
| `followUpNoStreak` | `5` | Consecutive `no` verdicts that close the window |
| `failOpenMinutes` | `3` | Minutes after a failed classifier before the next candidate is tried |
| `pauseNoticeMinutes` | `10` | Minimum minutes between pause notices in the same channel. `0` posts one for every call |

## `missed`

Settings for missed-answer recovery (`features.missedAnswers`).

| Key | Default | What it does |
|---|---|---|
| `sweepDelaySeconds` | `90` | Seconds after the last candidate before the sweep runs |
| `sweepMaxDelaySeconds` | `240` | The sweep fires no later than this many seconds after the last candidate |
| `expireMinutes` | `5` | Minutes before a candidate expires. A question mark uses `questionExpireMinutes` |
| `questionExpireMinutes` | `15` | Expiry for a message with a question mark |
| `channelCooldownMinutes` | `5` | Minimum minutes between recovery turns in the same channel |
| `contextMessages` | `20` | Recent channel messages included in the helper's transcript |
| `maxOutputTokens` | `2000` | Max output tokens for the helper |

## `offlineCatchUp`

Messages posted while the bot was down, read once at start (`features.offlineCatchUp`).

| Key | Default | What it does |
|---|---|---|
| `windowMinutes` | `15` | Only a call younger than this is answered. `0` answers none |
| `maxMessages` | `50` | Newest messages fetched per channel (1 to 100) |

## `typing`

| Key | Default | What it does |
|---|---|---|
| `reactionDelayMs` | `[800, 4000]` | Reaction delay range (ms) |
| `msPerChar` | `[35, 75]` | Per-character typing speed (ms) |
| `minMs` | `900` | Min typing duration (ms) |
| `maxMs` | `12000` | Max typing duration (ms) |
| `betweenMessagesMs` | `[700, 3500]` | Pause between messages (ms) |

## `pace`

How long each stage of a turn may take. A helper that misses its deadline is dropped. A turn whose answer is not in hand by `dropAfterMs` is dropped entirely.

| Key | Default | What it does |
|---|---|---|
| `prepareMs` | `6000` | Milliseconds from the turn's start before the voice request. Everything before the LLM call must finish here. `0` removes the limit |
| `prepareSearchMs` | `18000` | Extended deadline while the search classifier runs. `0` removes the limit |
| `prepareMediaMs` | `20000` | Extended deadline on a direct call whose trigger carries a picture, GIF or video. `0` removes it |
| `dropAfterMs` | `120000` | If the finished answer has not arrived by this time, the turn is dropped. `0` removes it |
| `replyHedgeMs` | `30000` | On a direct call, when the reply has no answer after this long, a second request is sent. `0` = one attempt only |
| `settleMs` | `3000` | Wait for the person to stop writing before reading the chat, so quick messages are answered whole |
| `settleMaxMs` | `8000` | The longest that wait may run from the calling message |
| `typingWhilePreparing` | `false` | Show the typing indicator from the start of a turn, not only while the finished answer is typed out |
| `unpromptedWaits` | `true` | A turn nobody waits for ignores `prepareMs`, `prepareSearchMs` and `dropAfterMs` |

## `format`

| Key | Default | What it does |
|---|---|---|
| `stripDashes` | `true` | Remove em dashes and en dashes from `<msg>` texts before posting. Guillemets become `"`. Only `false` turns it off |

## `split`

Settings for the task splitter (`features.splitTasks`).

| Key | Default | What it does |
|---|---|---|
| `minChars` | `80` | Minimum characters before the splitter is asked |
| `maxTasks` | `4` | Maximum parts. Below 2 the splitter is off |
| `contextMessages` | `6` | Recent channel messages for the classifier |
| `maxOutputTokens` | `300` | Max output tokens |
| `minPartChars` | `20` | A part shorter than this is folded into the next. `0` = no folding |

## `route`

Settings for the channel route classifier (`features.channelRoute`).

| Key | Default | What it does |
|---|---|---|
| `contextMessages` | `20` | Recent channel messages for the classifier |
| `maxChannels` | `40` | Channels listed for the classifier |
| `purposeChars` | `80` | Characters of each channel's stored purpose |
| `maxOutputTokens` | `120` | Max output tokens |

## `elsewhere`

Settings for answering calls from channels where the bot can read but not send (`features.elsewhere`).

| Key | Default | What it does |
|---|---|---|
| `settleSeconds` | `90` | Seconds after the last message in the source channel before the call is answered |
| `settleMaxSeconds` | `300` | Maximum seconds before the answer fires regardless |
| `rememberPings` | `20` | Calls remembered per channel |
| `pingMaxAgeDays` | `7` | Days before a remembered call expires |

## `spontaneous`

| Key | Default | What it does |
|---|---|---|
| `channels` | `[]` | Allowed channels |
| `minIntervalMinutes` | `45` | Min check interval (minutes) |
| `maxIntervalMinutes` | `420` | Max check interval (minutes) |
| `burstChance` | `0.15` | Burst follow-up chance |
| `burstMinutes` | `[3, 15]` | Burst timing range (minutes) |
| `activeHours` | `{ "from": 10, "to": 3 }` | Active hours (wraps midnight) |
| `liveWindowMinutes` | `15` | Live window (minutes) |
| `liveMinMessages` | `4` | Messages for the channel to count as live |
| `deadAfterMinutes` | `90` | Silence before the channel counts as dead (minutes) |
| `initiateChance` | `0.1` | Chance of starting a topic vs interjecting |
| `initiateCooldownHours` | `[24, 48]` | Cooldown after starting a topic (hours). `[0, 0]` = no cooldown |
| `roomQuestionChance` | `0.04` | Chance a message put to the room is picked up. `0` turns it off |
| `eavesdropChance` | `0.02` | Per-message jump-in chance |
| `eavesdropDelayMs` | `[5000, 40000]` | Eavesdrop delay range (ms) |
| `minGapMinutes` | `12` | Min gap between actions (minutes) |
| `maxChannelSilenceHours` | `6` | Channel silence that blocks spontaneous messages (hours). `0` = no limit |
| `someoneAroundMinutes` | `120` | No spontaneous turn when every channel's last message is older than this. `0` = no gate |

## `memory`

| Key | Default | What it does |
|---|---|---|
| `mainChannelIds` | `[]` | Channels where people talk to each other; used for character/style portraits and as the destination for calls from read-only channels. Empty means every channel counts |
| `fieldChars` | `1000` | Character limit for profile prose fields and channel note fields. Server-level `patterns` and `starters` get twice this |
| `clampTolerance` | `1.25` | How far past the limit a first write may go before it is cut |
| `maxDetails` | `15` | Detail items shown per profile |
| `maxDetailsStored` | `40` | Detail items kept per profile |
| `maxInterests` | `12` | Interest items shown per profile |
| `maxInterestsStored` | `40` | Interest items kept per profile |
| `maxSelfFacts` | `20` | Max self-claims |
| `maxEpisodes` | `20` | Max episodes per person |
| `keepNewestEpisodes` | `5` | Newest episodes exempt from eviction. `0` = evict lightest first, then oldest |
| `recentHours` | `72` | Hours of recent notes kept |
| `maxRecentStored` | `150` | Lines kept on disk |
| `maxNewRecent` | `3` | Lines the analyzer may add per batch |
| `recentChars` | `160` | Max characters per recent line |
| `recentShown` | `12` | Live recent lines shown to the analyzer |
| `vaultDir` | `"vault"` | Directory under `data/` that an older install may have used for copies of deleted memory. Nothing in the engine writes here now; the setting tells `/nep memory snapshot` where to find it so the vault is skipped when copying |
| `channelWritersStored` | `20` | Top writers kept per channel |
| `channelWritersHalfLifeDays` | `30` | Half-life of the per-channel writer tally (days) |
| `confirmAfter` | `2` | Sightings before an interest or detail is confirmed |
| `confirmGapHours` | `12` | Hours between sightings to count as a new occasion |
| `interestStaleDays` | `90` | Days without sighting before an interest is marked old |
| `interestHalfLifeDays` | `180` | Weight half-life for interests (days) |
| `detailHalfLifeDays` | `720` | Weight half-life for details (days) |
| `maxLearned` | `20` | Lessons shown |
| `maxLearnedStored` | `60` | Lessons kept on disk |
| `learnedChars` | `160` | Max characters per lesson |
| `learnedHalfLifeDays` | `720` | Weight half-life for lessons (days) |
| `maxAliases` | `5` | Aliases shown per profile |
| `maxAliasesStored` | `15` | Aliases kept per profile |
| `aliasHalfLifeDays` | `365` | Weight half-life for aliases (days) |
| `addressHalfLifeDays` | `30` | Half-life for name-use ordering (days) |
| `maxClosedStored` | `40` | Closed claims kept per profile; past the limit the oldest goes to the archive |
| `supersededShownDays` | `7` | Days a replaced claim is still shown next to the claim that replaced it |

## `lore`

| Key | Default | What it does |
|---|---|---|
| `maxEntries` | `500` | Max lorebook entries per server |
| `scanMessages` | `30` | Messages scanned for key matches |
| `maxMatches` | `8` | Max entries shown per request |
| `textChars` | `600` | Lore entry text limit |

## `relationships`

| Key | Default | What it does |
|---|---|---|
| `damping` | `true` | Damp score changes that push further from zero; changes toward zero apply in full |
| `dampingPower` | `1` | Exponent of the damping factor |
| `maxDeltaPerUpdate` | `15` | Max score change per update |
| `historySize` | `10` | Attitude changes kept per member |
| `shownMoves` | `4` | Attitude moves shown in `<people_now>`. `0` hides them |
| `decayPerDay` | `0.04` | Daily drift toward zero. `0` or missing = off |
| `decayPower` | `1` | Exponent of the decay curve |
| `rewriteOnBandChange` | `true` | Flag the stored `relationship` text for rewrite when the attitude band changes |
| `rewriteOnDrift` | `8` | Flag for rewrite when the score has drifted this many points. `0` = off |
| `rewriteAfterMoves` | `6` | Flag for rewrite after this many history entries. `0` = off |
| `bandHysteresis` | `2` | Points past the band edge before a change counts |
| `textChars` | `800` | Max characters for the relationship text |

## `media`

Settings for the media describer (`features.mediaDescriptions`). The describer model is `models.base.vision`. See [Media](media.md).

| Key | Default | What it does |
|---|---|---|
| `maxOutputTokens` | `2000` | Max output tokens per description |
| `descriptionChars` | `500` | Max characters for a picture description |
| `imageSize` | `512` | Via Discord's proxy, a picture's longer side is scaled to this (px) |
| `maxPerTurn` | `6` | Max descriptions generated per turn |
| `prefillPerMessage` | `5` | Pictures of one observed message sent to the describer as they arrive. `0` turns prefill off |
| `cacheEntries` | `5000` | Description cache size |
| `filePreviewChars` | `10000` | Characters shown from the beginning of text files |
| `embedTextChars` | `200` | Characters shown from link embed text |
| `recacheBefore` | `null` | ISO date-time, or `null` (off). Descriptions written before it are described again when they come up |
| `recacheIntervalMs` | `3000` | Milliseconds between descriptions of a `/nep media pictures recache` run |
| `gif.watch` | `true` | Watch GIFs as short video clips. Needs `mediaDescriptions` and `videoDescriptions` on |
| `gif.maxSeconds` | `15` | Seconds of the animation sent to the video model |
| `gif.maxPerDay` | `200` | Daily GIF watch cap, separate from `video.maxPerDay` |
| `video.provider` | `{ "order": ["google-ai-studio"], "allow_fallbacks": false }` | Provider routing for the direct-URL path. `null` uses the normal resolution |
| `video.maxOutputTokens` | `800` | Max output tokens per video summary |
| `video.summaryChars` | `1500` | Max characters for a video account |
| `video.maxRequestTokens` | `60000` | Token cap per video request |
| `video.maxSeconds` | `300` | Max clip duration for attachments and downloads |
| `video.directUrlMaxSeconds` | `3600` | Max duration for a public-URL video in agentic mode |
| `video.maxBytes` | `14500000` | Max file size for video clips (bytes) |
| `video.maxPerTurn` | `5` | Max new videos per turn |
| `video.maxPerDay` | `40` | Daily video request cap |
| `video.tokensPerSecond` | `120` | Token estimate per second for downloaded clips |
| `video.directUrlTokensPerSecond` | `10` | Token estimate per second for public-URL videos in agentic mode |
| `video.timeoutMs` | `90000` | LLM request timeout for video (ms) |
| `video.toolTimeoutMs` | `120000` | Timeout for `yt-dlp` and `ffmpeg` subprocesses (ms) |
| `video.sites` | `["youtube.com", "youtu.be", "tiktok.com", "vk.com", "vkvideo.ru", "x.com", "twitter.com", "reddit.com", "twitch.tv"]` | Hostnames treated as video |
| `video.directUrlSites` | `["youtube.com", "youtu.be"]` | Sites whose URL is passed directly to the provider |
| `video.directUrlUnknownDuration` | `false` | Send a direct-URL link even when no probe determined the duration |
| `video.canaryUrl` | `"https://www.youtube.com/watch?v=jNQXAC9IVRw"` | YouTube video probed at startup |
| `video.ytdlpPath` | `"yt-dlp"` | Path to `yt-dlp` |
| `video.ffmpegPath` | `"ffmpeg"` | Path to `ffmpeg` |
| `video.proxy` | `""` | A proxy URL for `yt-dlp`. `""` = no proxy |
| `video.proxySites` | `["youtube.com", "youtu.be"]` | Sites that use the proxy |
| `video.proxyRetryMinutes` | `10` | Minutes links skip the proxy after a failure |
| `video.errorRetryMinutes` | `60` | Minutes before an error-cached video is retried |
| `video.urlProcessing` | `"agentic"` | Processing mode for public-URL video parts |
| `video.reasoning` | `{ "effort": "low" }` | Reasoning setting for video requests |
| `video.audioMap` | `{ "noiseDb": -50, "minSilenceSeconds": 0.5, "mapBelowShare": 0.8, "maxSpans": 20 }` | Audio map measured with ffmpeg. `null` or `false` turns it off |
| `video.prefill` | `true` | Watch a video as soon as it arrives |
| `video.prefillPerMessage` | `5` | Videos of one message watched on arrival. `0` turns video prefill off |
| `video.rewatch.maxPerDay` | `20` | Daily re-watch cap (separate from `video.maxPerDay`) |
| `video.rewatch.maxOutputTokens` | `600` | Max output tokens for the re-watch answer |
| `video.rewatch.classifierMaxOutputTokens` | `2000` | Max output tokens for the re-watch classifier |
| `video.rewatch.answerChars` | `1200` | Max characters for the answer |
| `video.rewatch.recentMessages` | `60` | Recent messages scanned for watched videos |
| `video.rewatch.maxCandidates` | `6` | Max videos offered to the classifier |
| `video.rewatch.contextMessages` | `50` | Recent messages rendered for the classifier. `0` omits the block |
| `look.maxPerTurn` | `2` | Max second looks in one turn (with `coreTools` on) |

## `web`

Settings for web lookup (`features.webLookup`). Link reading, search and the persona's own `web.search` and `web.read` share a daily counter (`web.maxPerDay`). See [Media](media.md).

| Key | Default | What it does |
|---|---|---|
| `maxPerDay` | `60` | Shared daily cap for link reads and search requests combined |
| `acceptLanguage` | `"en,ru;q=0.8"` | Accept-Language header when a page is read |
| `links.enabled` | `true` | Read links posted in chat |
| `links.prefill` | `true` | Read a link as soon as it arrives |
| `links.prefillPerUserPerDay` | `10` | Max links the prefill reads per member per day on arrival |
| `links.maxPerTurn` | `2` | Max new link reads per turn |
| `links.maxBytes` | `1500000` | Max page size (bytes) |
| `links.textChars` | `6000` | Max characters of page text sent to the condenser |
| `links.summaryChars` | `700` | Max characters for the condensed excerpt |
| `links.previewChars` | `700` | With `coreTools` on: characters of the page-text opening shown for a link (no condenser) |
| `links.readChars` | `4000` | Max characters the persona's `web.read` returns |
| `links.readCacheHours` | `6` | Hours a page read by `web.read` is cached |
| `links.maxOutputTokens` | `4000` | Max output tokens for the condenser |
| `links.fetchTimeoutMs` | `10000` | Download timeout per page (ms) |
| `links.skipSites` | `["cdn.discordapp.com", ...]` | Hostnames whose links are never read |
| `search.enabled` | `true` | Run a search when the classifier fires |
| `search.engine` | `"brave"` | Search engine: `brave`, `exa` or `openrouter` |
| `search.fallback` | `[]` | Engines tried in order on failure |
| `search.maxPerTurn` | `1` | Max searches per turn |
| `search.results` | `5` | Number of search results requested |
| `search.summaryChars` | `900` | Max characters for the condensed answer |
| `search.snippetChars` | `400` | Max characters of each snippet in the persona's `web.search` result |
| `search.resultsChars` | `3000` | Max characters of the whole `web.search` result |
| `search.rawOutputTokens` | `256` | Max output tokens of the `openrouter` engine's request for `web.search` |
| `search.maxOutputTokens` | `4000` | Max output tokens for the condenser |
| `search.classifierMaxOutputTokens` | `2000` | Max output tokens for the search classifier |
| `search.cacheHours` | `24` | Hours a cached search result is served |
| `search.contextMessages` | `50` | Recent messages for the search classifier |
| `search.timeoutMs` | `10000` | Search request timeout (ms) |

## `participation`

The persona's own exchanges on other channels (`features.participation`).

| Key | Default | What it does |
|---|---|---|
| `hours` | `72` | Hours an episode is kept |
| `linesBefore` | `3` | Lines saved before each of the persona's messages |
| `linesAfter` | `1` | Lines saved after the persona's last message |
| `followMinutes` | `10` | Minutes after the persona's message a reply must come to be saved |
| `mergeGapMinutes` | `10` | A new message joins the channel's last episode when its last line is at most this old |
| `contextMinutes` | `30` | Max age of saved context lines before the persona's message |
| `maxMessages` | `32` | Messages per episode |
| `maxStored` | `120` | Episodes on disk |
| `maxTextChars` | `400` | Characters per saved message |
| `shown` | `4` | Episodes shown per turn |
| `perChannel` | `2` | Episodes per channel |
| `episodeChars` | `1800` | Characters of text per episode |
| `contextMessages` | `6` | Chat lines for the pick classifier |
| `maxOutputTokens` | `60` | Max output tokens for the pick classifier |
| `pickTimeoutMs` | `1500` | How long the turn waits for the pick (ms). `null` waits indefinitely |
| `earlierHours` | `3` | With `anchoredWindow` on: saved episodes of the current channel older than the window, within this many hours |
| `earlierShown` | `3` | Episodes of the current channel in `<earlier>` |

## `recall`

Settings for the server-history search (`features.recall`). See [Memory](memory.md).

| Key | Default | What it does |
|---|---|---|
| `maxForms` | `8` | Word forms per `server:` line |
| `maxPeople` | `2` | People the `who:` line may name |
| `dateSamples` | `4` | Date-only queries sampled across a range |
| `clusterGapMinutes` | `30` | Gap between hits that separates clusters |
| `maxClusters` | `5` | Clusters kept |
| `keepOldest` | `0` | Slots reserved for the oldest clusters. `0` = ranked order only |
| `rareHits` | `5` | A form with at most this many hits counts double. `0` = no rarity bonus |
| `windowMessages` | `16` | Messages fetched around each cluster centre |
| `followMessages` | `24` | Lines added after a stretch while the conversation continues. `0` turns it off |
| `followGapMinutes` | `5` | The extension stops at the first silence this long |
| `selfExtra` | `2` | Extra clusters fetched beyond `maxClusters` for the self bonus. `0` = only `maxClusters` |
| `selfBonus` | `1` | Added to a cluster's score when its window has a line of the persona. `0` = no bonus |
| `contextMessages` | `6` | Chat lines the summary reads as context. `0` = no context |
| `traceMaxLines` | `500` | Lines kept in the trace file |
| `answerChars` | `1200` | Max characters for the summary note |
| `stretchChars` | `1500` | Max characters of the verbatim stretch |
| `quoteWindowChars` | `1500` | Per-stretch character limit of a `memory.search` result |
| `quoteMaxChars` | `9000` | Total character limit of a `memory.search` result |
| `maxPerDay` | `100` | Daily recall runs |
| `timeoutMs` | `15000` | Total time for the recall run |
| `minSummaryMs` | `2500` | Minimum time left for the summary |
| `memoryItems` | `6` | Stored memory items matched against word forms |
| `memoryTokens` | `600` | Token budget of the memory block |
| `archiveMonths` | `6` | Months of archive searched. `0` = archive only for dated questions |
| `recordDays` | `3` | Days of the record read for matching lines. `0` = record not read |
| `recordContext` | `3` | Lines before and after each matching record line |
| `maxOutputTokens` | `500` | Max output tokens for the summary |
| `fallbackOnClassifierFailure` | `true` | Run recall from the trigger's own words when the classifier fails |
| `meaningCandidates` | `80` | Rows from the vector index per meaning search. `0` turns meaning search off |
| `meaningWithReply` | `false` | Embed the trigger together with its replied-to message |
| `locatorBonus` | `2` | Score bonus for stretches near the question's date. `0` = no bonus |
| `locatorDecayDays` | `7` | Days away from the date at which the bonus falls to nothing |
| `locatorBroadShare` | `0.5` | Share of stretches chosen by content alone, regardless of the date |

### `recall.db`

Database backend settings.

| Key | Default | What it does |
|---|---|---|
| `gateShare` | `0.5` | Minimum score as a share of the best, from 0 to 1 |
| `candidates` | `40` | Rows from each list before fusion |
| `wordPool` | `400` | Rows fetched from word/letter lists before ranking |
| `minMeaning` | `0.35` | Least cosine for a meaning hit |
| `vectorDays` | `90` | Days a line's vector is kept by the index policy |
| `touchDays` | `30` | Days a touch keeps a vector |
| `vectorEviction` | `false` | Evict vectors outside the kept classes once per UTC day |
| `reembed` | `false` | Re-embed the evicted vectors of touched lines |

### `recall.prefetch`

The automatic memory prefetch (`features.coreTools` with `features.memoryPrefetch`).

| Key | Default | What it does |
|---|---|---|
| `deadlineMs` | `1000` | How long the prefetch may take (ms) |
| `candidates` | `20` | Candidates per lane and search |
| `maxExcerpts` | `5` | Most excerpts in `<retrieved>` |
| `maxTokens` | `1500` | Most estimated tokens of all excerpts together |
| `excerptChars` | `1200` | Characters of one excerpt |
| `contextLines` | `3` | Lines before a short trigger joined into its third lane. `0` = no such lane |
| `contextTokens` | `500` | Most tokens of that lane's lines |
| `shortWords` | `4` | A trigger of at most this many words is short |
| `minFormsMatched` | `2` | Word forms an item must match to count as relevant |
| `minMeaningScore` | `0.35` | Least cosine to count at all |
| `strongMeaningScore` | `0.55` | Cosine at which a meaning hit counts on its own |
| `singleTermScore` | `0.45` | Least cosine for a line found by only one rare word |
| `maxTermShare` | `0.002` | A word is a search term only when at most this share of messages hold it |
| `rareTermDf` | `30` | A word held by at most this many messages is rare |
| `maxPhraseDf` | `20` | Max messages holding a phrase for it to be searched |
| `minPhraseShare` | `0.2` | Min share of messages holding the rarer word that also hold the phrase |
| `trivial` | `["hi", "hello", ...]` | Bare greetings that are not searched |
| `deictic` | `["that", "this", "it", ...]` | Words that make a trigger deictic |

## `image`

Settings for drawing (`features.imageGeneration`). See [Media](media.md).

| Key | Default | What it does |
|---|---|---|
| `maxPerDay` | `50` | Daily generation cap |
| `maxPerUserPerDay` | `50` | Daily cap per member |
| `maxPromptChars` | `1600` | Scene text clamped to this length |
| `reference` | `"avatar"` | Visual reference when the persona is in the picture. `"avatar"` downloads the bot's avatar; anything else sends nothing |
| `referenceMaxBytes` | `4000000` | Max avatar file size (bytes) |
| `outputFormat` | `"png"` | Output format (`png`, `jpeg`, `webp`) |
| `aspectRatio` | `"auto"` | Aspect ratio. For Google models, `auto` is omitted |
| `timeoutMs` | `120000` | Request timeout (ms) |
| `retries` | `1` | Retries on transient failures |
| `provider` | `null` | Provider routing for image requests. `null` sends nothing |
| `openai.quality` | `"medium"` | Image quality for `openai/*` models |
| `openai.background` | `"auto"` | Background mode for `openai/*` models |
| `openai.moderation` | `"low"` | Moderation level for `openai/*` models |
| `google.resolution` | `"1K"` | Output resolution for `google/*` models |

## `speech`

Settings for voice messages (`features.speech`). The persona's `voice.say` skill sends text through the `speech` role's model and posts it as a Discord voice message.

| Key | Default | What it does |
|---|---|---|
| `voice` | `"jessica"` | Voice name passed to the speech endpoint |
| `maxPerDay` | `100` | Daily voice messages |
| `maxChars` | `1500` | Max text characters per voice message |
| `usdPerMillionChars` | `40` | Estimated cost for the tool gateway's budget |
| `timeoutMs` | `60000` | Speech request timeout (ms) |
| `prepareMaxOutputTokens` | `1500` | Max output tokens for the pronunciation preparation pass |

## `tools`

| Key | Default | What it does |
|---|---|---|
| `safeMode` | `false` | Only the persona's reply effects pass; every other tool is refused |
| `resultMaxChars` | `4500` | Characters of a tool's returned data shown in a call's result |
| `markTextMaxChars` | `200` | Characters of the operation's own error message shown in the transcript mark. `0` = never show it |
| `destructiveCooldownMinutes` | `10` | Minutes between two destructive skill calls from the same channel |
| `callTimeoutMs` | `120000` | How long a skill call may run before its outcome is `unknown` |
| `transport` | `"native"` | How tools reach the model. `native`: structured tool calls. `text`: tools described in the prompt, calls as `<tool_call>` blocks |
| `loop.maxSteps` | `3` | Most further requests one turn makes after her calls |
| `loop.timeBudgetMs` | `20000` | How long the calls and follow-ups may run |
| `loop.maxCallsPerStep` | `4` | Most calls of one answer that run |
| `loop.stepReserveTokens` | `6000` | Tokens the first request leaves for the follow-up requests. `0` = no reserve |

## `diary`

Settings for the diary channel (`features.diary`). See [Diary](diary.md).

| Key | Default | What it does |
|---|---|---|
| `channelId` | `""` | The diary channel. Empty means no diary |
| `world` | `false` | Include `prompts/world.md` as a `<world>` block in diary requests |
| `windows` | see below | Posting windows in `bot.timezone`. Each has `from`, `to` (hours) and `posts: [min, max]` |
| `quietDayChance` | `0.3` | Chance of no posts for the whole day |
| `hungerBoost` | `0.5` | How strongly an empty window pushes later posts. `1` turns hunger off |
| `quietCarry` | `0.25` | After quiet days in a row the quiet chance shrinks. `1` keeps it flat |
| `minGapMinutes` | `90` | Minimum minutes between planned slots |
| `maxPerDay` | `12` | Maximum posts per day |
| `maxPicturesPerDay` | `8` | Maximum diary pictures per day |
| `slotGraceMinutes` | `30` | Minutes after a planned slot during which it still fires |
| `forceWaitMs` | `120000` | Milliseconds a forced post waits for a running turn |
| `maxMessages` | `3` | Maximum messages per diary post |
| `historyPosts` | `150` | Past posts kept and shown to the planner |
| `gistChars` | `200` | Characters per post gist in the diary history |
| `seedSets` | `2` | Random seed combinations shown to the planner. `0` omits them |
| `kinds` | `{ "selfPicture": 3, "picture": 2, "meme": 1, "thought": 2, "people": 2, "news": 2, "facts": 1, "status": 3, "photoset": 1, "randomSet": 1 }` | Post kinds with their weights |
| `searchKinds` | `["news", "facts"]` | Kinds that may trigger a web search |
| `pictureKinds` | `["selfPicture", "picture", "meme", "photoset", "randomSet"]` | Kinds that always get a picture |
| `setKinds` | `["photoset", "randomSet"]` | Kinds whose post is a set of pictures |
| `set.pictures` | `[4, 6]` | Pictures in a set |
| `set.minPosted` | `2` | A set with fewer pictures is not posted |
| `set.seedSets` | `6` | Seed combinations for a set post |
| `set.maxMessageBytes` | `8000000` | Max picture bytes per Discord message |
| `loop.maxSteps` | `2` | Further requests one diary post makes |
| `loop.timeBudgetMs` | `600000` | How long calls and follow-ups may run |
| `planMaxOutputTokens` | `2000` | Max output tokens for the plan request |
| `planTimeoutMs` | `60000` | Timeout for the plan request (ms) |

Default windows:

```json
[
  { "from": 7,  "to": 11, "posts": [0, 0] },
  { "from": 12, "to": 16, "posts": [0, 1] },
  { "from": 18, "to": 1,  "posts": [0, 2] },
  { "from": 1,  "to": 5,  "posts": [0, 1] }
]
```

## `avatars`

Settings for avatar descriptions (`features.avatars`).

| Key | Default | What it does |
|---|---|---|
| `intervalMs` | `20000` | Milliseconds between avatar requests |
| `maxPerDay` | `60` | Avatar requests per UTC day |
| `descriptionChars` | `200` | Characters kept per description |

## `gifs`

Settings for the GIF library (`features.gifs`).

| Key | Default | What it does |
|---|---|---|
| `max` | `25` | GIFs shown in `<gifs>` |
| `reactionChars` | `40` | Characters per reaction label |
| `actionChars` | `70` | Characters per action line |
| `storeMax` | `300` | GIFs kept in the library |
| `halfLifeDays` | `30` | Recency half-life (days) |
| `maxPerDay` | `40` | GIFs the persona may post per day |
| `backfillMessages` | `500` | Messages read per channel at startup to seed the library. `0` disables |
| `backfillDescribe` | `20` | Top GIFs described right after the backfill |
| `recachePerRun` | `50` | Library GIFs re-described per recache run |
| `ownMarkHours` | `24` | Hours after the persona posts a GIF during which it is named in `<gifs_recent>`. `0` turns it off |
| `pick.maxChars` | `160` | First message ceiling for the GIF picker |
| `pick.contextMessages` | `4` | Chat lines for the picker classifier |
| `pick.maxOutputTokens` | `60` | Max output tokens for the picker |
| `pick.graceMs` | `1000` | How long the first message waits for the picker past typing. `null` waits indefinitely |

## `private`

Settings for private chat (`features.privateMessages`).

| Key | Default | What it does |
|---|---|---|
| `minAffinity` | `5` | Minimum public attitude score to answer a DM; owners bypass this |
| `maxPerUserPerDay` | `20` | DM turns per member per day |
| `maxPerOwnerPerDay` | `200` | DM turns per day for owners |

## `errands`

The settings every errand reads, whichever agent runs it. See [Errands](errands.md).

| Key | Default | What it does |
|---|---|---|
| `opencodePath` | `"/opt/opencode/bin/opencode"` | Path to the OpenCode binary |
| `toolResultChars` | `6000` | Cap on each tool result the agent sees |
| `keepFilesHours` | `24` | Hours a task's output files are kept |
| `recentLines` | `6` | Lines of the channel given to the runner as context |
| `maxOpen` | `3` | Errands open at once, all agents together |
| `resultMaxChars` | `3000` | Characters of an errand's result in the `<errand_result>` block |
| `unreadShown` | `5` | Finished errands with unread results in `<errands>` |
| `resultRetrySeconds` | `30` | Seconds before a result turn is tried again |
| `resultCooldownSeconds` | `60` | Seconds between result turns in the same conversation |

## `agents`

The settings of one agent live in its profile, `agents/<name>/profile.json` (see [the agents folder](../agents/README.md)). A deployment overrides a setting under `agents.<name>` of `config.local.json`, and `agentSettings(name, config)` in `src/agent-runner/profiles.js` lays the override over the profile, a nested object merged key by key. The core, the agent runner and the dispatcher all read an agent's settings through it. The table lists the keys and the values the profiles carry.

| Key | Default | What it does |
|---|---|---|
| `enabled` | `false` for `scout` and `server` | Runs the worker. Workers only |
| `cost` | `scout` and `server` `{ "input": 2, "output": 6 }`, `thinker` `{ "input": 4, "output": 20 }`, `dev` `{ "input": 2, "output": 10 }` | Model price (USD per million tokens) for OpenCode's estimate and the spend figures |
| `socket` | `"/run/neptunia-agent-scout/sock"`, `"/run/neptunia-agent-server/sock"` | Unix socket of the runner. Workers only |
| `out` | `"/var/lib/neptunia-agent-scout/out"`, `"/var/lib/neptunia-agent-server/out"` | Directory for output files. Workers only |
| `limits` | `scout` `{ "steps": 25, "seconds": 300 }`, `server` `{ "steps": 20, "seconds": 120 }`, `thinker` `{ "steps": 400, "minutes": 60 }`, `dev` `{ "steps": 300, "minutes": 60 }` | Caps of one run |
| `daily` | `{ "tasks": 40 }` for `scout` and `server` | Tasks per day. Workers only |
| `searchProvider` | `"exa"` for `scout`, `null` for `server` | Web search provider, `exa` or `parallel`. Workers only |
| `ledger.socket` | `null` | Unix socket for the ledger mirror, under `agents.ledger`. `null` means not mirrored |

The thinker and the dev agent run outside the engine; the bot only shows their spend on the status card.

## `intentions`

Settings for the persona's intentions (`features.intentions`). See [Inner life](inner-life.md).

| Key | Default | What it does |
|---|---|---|
| `expiresDays` | `14` | Days before an intention expires |
| `recurringExpiresDays` | `30` | Days before a recurring intention expires |
| `maxOpen` | `20` | Max intentions open at once |
| `maxCandidates` | `5` | Max candidates from her lines per batch, and open at once |
| `candidateExpiresHours` | `48` | Hours before an unhandled candidate expires |
| `waitHours` | `2` | Wait deadline when a wait names none |
| `expiryNoticeDays` | `2` | Days before expiry at which the expiry shows on the intention's line |

## `innerLife`

Settings for the persona's inner life (`features.innerLife`). See [Inner life](inner-life.md).

| Key | Default | What it does |
|---|---|---|
| `mode` | `"shadow"` | `shadow`: reads run, other calls are recorded but never executed. `live`: calls run on her grants |
| `tickSeconds` | `60` | How often the scheduler looks at what is due |
| `queueMax` | `20` | Max wakes waiting at once |
| `chatMessages` | `30` | Last messages an inner turn reads |
| `review.enabled` | `true` | Whether she has a daily review |
| `review.historyDays` | `14` | Days of her own lines that decide when the review happens |
| `review.expiredMax` | `5` | Expired intentions listed in a review |
| `heartbeat.enabled` | `true` | Whether she has a periodic heartbeat wake |
| `heartbeat.everyMinutes` | `180` | Heartbeat interval (minutes) |
| `heartbeat.jitterMinutes` | `60` | Jitter on the heartbeat interval |
| `heartbeat.dueJitterMinutes` | `20` | Jitter on intention due times set by heartbeat |
| `heartbeat.people` | `8` | Members in the heartbeat's people block |
| `heartbeat.filteredShown` | `10` | Lines the helpers filtered without her, listed in the heartbeat |
| `heartbeat.closedShown` | `10` | Closed intentions listed in the heartbeat |
| `heartbeat.historyDays` | `14` | Days of the record read for each person's last contact |
| `heartbeat.placesHours` | `6` | Hours of recent place activity listed in the heartbeat |
| `heartbeat.placesShown` | `6` | Places in the heartbeat's block |
| `heartbeat.placeLines` | `2` | Newest lines of each place quoted in the block |
| `heartbeat.maxTokens` | `2500` | Token cap of the whole heartbeat block. `0` turns the cap off |
| `heartbeat.intentionsOnly` | `true` | A heartbeat may only change one intention. `false` allows posting, reacting, reading and errands |
| `heartbeat.maxOpen` | `3` | Max open intentions created by heartbeat turns |
| `heartbeat.maxRecurring` | `1` | Max recurring intentions from heartbeat turns |
| `heartbeat.focusSource` | `"profiles"` | Where the people block takes its members: `profiles` (by affinity) or `db` (the focus set) |
| `caps.perChain` | `3` | Inner turns of one chain per local day |
| `attention.settleSeconds` | `90` | Quiet seconds an attention waits before waking her |
| `attention.perDayDefault` | `12` | Attend wakes per local day (the default) |
| `attention.pageSize` | `12` | Places per page of `places.list` |
| `attention.placesInWake` | `8` | Places shown in `<wake>` and in `<places>` |
| `attention.lookbackHours` | `24` | How far back the record is indexed for the places' lines |
| `loop.maxSteps` | `4` | Tool loop bounds of an inner turn |
| `loop.timeBudgetMs` | `180000` | Time budget of an inner turn's calls |
| `loop.maxCallsPerStep` | `4` | Calls per answer of an inner turn |
| `loop.callTimeoutMs` | `60000` | Max time per call of an inner turn |
| `retry.delaysMinutes` | `[1, 5, 15, 60]` | Retry delays after a provider failure (minutes) |
| `retry.maxHours` | `6` | Hours before retries stop |
| `wakes.<kind>` | `{ "tools": "*", "maxActs": null, "maxTasks": null, "inputTokens": null }` | The envelope of each wake kind. `tools`: `"*"` or a list of skill names. `maxActs`: most calls that change something. `maxTasks`: most errands. Kinds: `intention_due`, `review`, `errand_deadline`, `attend`, `feedback`, `heartbeat` |
| `factsKeepDays` | `7` | Days an untold fact stays |

## `appendStore`

The journal, record and archive's file writer.

| Key | Default | What it does |
|---|---|---|
| `fsyncMs` | `500` | Milliseconds before a write is flushed to disk |
| `retryMax` | `1000` | Lines kept in memory while the disk refuses writes |

## `journal`

The persona's journal (`features.journal`).

| Key | Default | What it does |
|---|---|---|
| `thinkChars` | `4000` | Characters of her hidden reasoning stored. `0` stores it whole |
| `keepRequests` | `3` | Days the request dumps are kept. `0` writes none |
| `offWindowHours` | `24` | How far back the journal is read for the persona's time away (`features.offPeriods`) |

## `archive`

Before anything leaves hot memory, a copy goes to `data/guilds/<id>/archive/<YYYY-MM>.jsonl`. Needs `features.archive`.

| Key | Default | What it does |
|---|---|---|
| `drainMs` | `30000` | How often pending copies are retried (ms) |
| `holdMaxMs` | `5000` | How long the bot waits on shutdown for an archive write (ms) |
