# Commands

Channels, roles and users are picked from Discord's own pickers; `set`/`unset` and `access grant`/`access revoke` autocomplete their `path`/`command` options.

`/nep` is visible to every member from the start; access is gated per command at the moment it runs, never through Discord's own command visibility. Owners (`bot.owners`) can always run every command. Everyone else needs a grant: `/nep access grant <command> [role] [user]` opens one command key (e.g. `memory.show`), a whole group (e.g. `memory`), or every command (`*`) to everyone (no role/user given), a role, or a user; `/nep access revoke` undoes one of those; `/nep access list` shows the current grants. Without a grant, a non-owner who runs `/nep` gets an ephemeral "Not allowed" reply. `private.show`, `private.forget` and `private.purge` are owner-only and excluded from all grants; `access grant` refuses them, and `access list` does not offer them. The `mentor` and `access` groups are owner-only the same way and cannot be granted.

| Command | What it does |
|---|---|
| `/nep status` | Model, calibration, quotas (today's LLM requests after midnight, image count and image model, GIF watches, portraits refreshed), per-guild memory status (profiles, buffer, next spontaneous), voice queue size and today's voice requests (when two-stage is on), private chat on/off and private file count |
| `/nep reload` | Reload config and prompts now |
| `/nep ping [role]` | Send a minimal request to one or all model roles (`voice`, `analyzer`, `classifier.text`, `classifier.media`, `classifier.video`, `mentor`, `image`), following each role's `llm.providerByModel` route, and report model, latency, provider, tokens or the error; `/nep ping classifier` pings all three classifier roles. The model lines are printed together, then the API-key checks: `youtube: API key — {status}` (e.g. `ok`, `not needed (yt-dlp ok)`, `missing (blocked)`) and `web: API key — {status}` (`ok`, `missing` or `off`). `role:image` checks `image.model` against the provider's public model listing (one free GET, no generation) and confirms the model is listed and outputs images; a pass does not guarantee that a generation will succeed. Without a role the image check runs after the other model lines. Does not count against `llm.maxRequestsPerDay` and works while paused or warming up |
| `/nep pause` | Stop all activity, flush memory to disk and unload it; a mentor run in flight is stopped and its report posted before the flush. `data/` is safe to edit while paused |
| `/nep resume` | Reload memory from `data/` and continue; refuses if any JSON file does not parse, naming the broken ones |
| `/nep interject [channel]` | Jump into the current conversation in this channel now |
| `/nep initiate [channel]` | Start a topic in this channel now |
| `/nep draw <text> [self]` | Draw one picture through the drawing prompt. Answered only to you (ephemeral with the picture attached). Spends balance against `image.maxPerDay` but not against a member's quota. Refused while paused. NOT gated by `features.imageGeneration` |
| `/nep set <path> <value>` | Override a config value (writes to `config.local.json`). Paths under `bot.owners` and `bot.access` are owner-only even for members granted `set`. The value must be of the same JSON type as the current one and the path must be a leaf |
| `/nep unset <path>` | Remove a config override. The same owner-only and leaf restrictions as `set` |
| `/nep rule add <text>` | Append a rule to `prompts.local/rules.md` |
| `/nep rule list` | List the rules, numbered |
| `/nep rule remove <number>` | Remove a rule by number |
| `/nep model show` | Show active models for each role (`voice`, `analyzer`, `classifier.text`, `classifier.media`, `classifier.video`, `mentor`, `image`) |
| `/nep model set <role> <id>` | Set the model for a role (`voice`, `analyzer`, `classifier.text`, `classifier.media`, `classifier.video`, `mentor`, `image`) |
| `/nep route list` | Every route in `llm.providerByModel`, then each role's current model and the routing that applies to it. Access key `route.list` (read-only) |
| `/nep route set <model> <providers> [role] [fallbacks]` | Route a model prefix to these providers only. `model` is a model id or prefix (e.g. `google/`, no `@` or spaces). `providers` is a comma-separated list of provider slugs (e.g. `google-vertex`; lowercase letters, digits and hyphens). `role` limits the route to one role (default: any). `fallbacks` allows other providers when these are unavailable (default: false). Writes `{ "only": [...], "allow_fallbacks": ... }` to `config.local.json` under `llm.providerByModel` and reloads. Access key `route.set` |
| `/nep route remove <model> [role]` | Remove a route. The key must exist in `config.local.json`; a key set only in `config.json` cannot be removed this way. Access key `route.remove` |
| `/nep memory show <user> [section] [limit] [order]` | Without a section: compact summary. Sections: `character`, `style`, `relationship`, `affinity`, `aliases`, `interests`, `details`, `episodes`, `raw` (stored JSON). List sections take `limit` 1..100 (default 25) and `order`: `rank` (default, divider at the visibility cutoff) or `recent`. Stored member references resolve to the current name, except in `raw` |
| `/nep memory channel [channel]` | With a channel: stored note in full (purpose, topics, tone, message count, activity, top writers). Without: a table of every channel the persona knows, sorted by last message |
| `/nep memory server` | Server-wide notes: how people talk, how conversations start, in-jokes, self-facts, plus counts of profiles, channels and lore entries |
| `/nep memory recent` | Show the guild's live recent lines: the notes inside the current `memory.recentHours` window, newest first, with id, moment, channel and weight |
| `/nep memory refresh <user>` | Force a portrait refresh for a member. The sample is fitted under the 50k token rail. Counts against `memory.portraitRefreshPerDay`. When the member has a character-text voice item queued (`voice-pending`), the reply says so and refuses unless the refresh is forced |
| `/nep memory forget <user>` | Delete a stored profile, its private memory and any queued voice items (including lessons the member taught). Waits for a running analyzer batch to finish first |
| `/nep memory affinity <user> [score] [reason]` | Show or set attitude (-100..100) |
| `/nep memory wipe <confirm>` | Wipe all analyzer memory for this server; type the exact server name to confirm. Deleted: member profiles and their private memory, server habits (patterns, starters, in-jokes), learned items, the voice queue, recent lines, the emoji ranking, the channel map, analyzer lore, warmup progress. Kept: owner lore entries, the media description cache, the GIF library, token calibration, daily counts, the spontaneous schedule. Waits for a running analyzer batch to finish first |
| `/nep private show <user>` | Show a member's private memory: relationship, interests, details, episodes, private and effective attitude, today's reply count. No private layer is a plain answer, not an error. Owner-only; cannot be granted |
| `/nep private forget <user>` | Delete only a member's private memory and their private voice queue items; the public profile is kept. Waits for a running analyzer batch to finish first. Owner-only; cannot be granted |
| `/nep private purge <user>` | Delete the bot's own messages in the DM chat with a member (scans up to `private.purgeMaxMessages`), then their private memory. The member's own messages stay. Refused while paused. Owner-only; cannot be granted |
| `/nep diary set <channel>` | Point the diary at this channel. The bot must be able to view, read, send and attach files there. Writes `diary.channelId` to `config.local.json`. When the diary history is empty, fills it from the persona's own past posts in that channel. Replies with the channel, the backfilled count and today's plan |
| `/nep diary show` | Show the diary channel, today's slots with done marks (in `bot.timezone`), posts and pictures used today, each window's hunger with the quiet streak, and the history size |
| `/nep diary off` | Clear `diary.channelId`. The diary history file stays |
| `/nep diary post [kind] [topic]` | Force one diary post now. Waits up to `diary.forceWaitMs` for a running turn to finish; answers `busy` when the wait runs out. Optional kind key (e.g. `selfPicture`, `thought`); an unknown kind is refused with the list. Optional free-text topic steers the post toward that subject. Obeys the daily caps; a cap refusal names the limit and the counts. A picture kind is refused when the post cannot carry a picture: the reply names the cap and its counts when a cap closed it, or says `pictures` for the other cases. A set kind (`diary.setKinds`) that gets fewer than `diary.set.minPosted` pictures posts nothing and answers `refused (set-short)`. In dry-run the post is mirrored, not sent |
| `/nep alias add <user> <name>` | Add a chat alias; confirmed at once |
| `/nep alias remove <user> <name>` | Remove a chat alias |
| `/nep learned list` | List lessons with ids, who taught each one, sightings |
| `/nep learned add <text>` | Add a lesson by hand (no teacher, confirmed) |
| `/nep learned remove <id>` | Delete a lesson |
| `/nep lore add <title> <keys> <text> [always]` | Add or overwrite a lorebook entry; an entry with the same title is replaced and becomes owner-owned, so the analyzer never edits it again |
| `/nep lore list [query]` | List lorebook entries |
| `/nep lore show <id>` | Show a lorebook entry |
| `/nep lore remove <id>` | Remove a lorebook entry |
| `/nep emoji status` | Show the emoji ranking: size, top 10 names with counts, when the backfill ran |
| `/nep emoji rescan` | Clear the usage ranking and recount from channel history |
| `/nep gifs status` | Show the GIF library: size, top 10 with handle, count and caption or name, when the backfill ran, posted today vs `gifs.maxPerDay`, watched today vs `media.gif.maxPerDay`, `captions:` (how many library entries are watched / one-frame / failed watch / none), and `caption format:` (watched with fields / watched in the old format, to re-describe / unwatched) |
| `/nep gifs rescan` | Reset use counts to zero and recount from channel history; entries and handles are kept, entries not found remain at zero until the size cap evicts them |
| `/nep gifs recache` | Drop one-frame GIF captions outside the library, queue watched entries in the old format (no `reaction` field) for re-description, then watch up to `gifs.recachePerRun` library GIFs in the background, oldest first. The daily cap `media.gif.maxPerDay` is shared with live watches; 300 entries at 50 per run need 6 commands over at least two UTC days. Replies at once; follow progress with `/nep gifs status`. Refused while paused, during a warmup, or when GIFs are not watched |
| `/nep warmup run` | Start or resume a full run: channels, then people, then server |
| `/nep warmup users [member]` | With a member: profile or re-profile that one now; without: re-profile every qualifying member |
| `/nep warmup channels [channel]` | With a channel: describe or re-describe that one now; without: every readable channel |
| `/nep warmup server` | Rebuild the server notes and lore now |
| `/nep warmup people` | List members who qualify |
| `/nep warmup status` | Show warmup progress and token usage |
| `/nep warmup stop` | End any warmup work at once; the request in flight is cancelled, progress is kept so `run` can resume |
| `/nep warmup reset` | Clear warmup progress, not stored memory |
| `/nep mentor add message:<link or id> text:<comment>` | Add a case: a message of the persona you rejected, plus one sentence about what is wrong with it. Both are required. The message must be the persona's; a link into another server, a direct message, a channel the bot cannot read, a deleted reply target and a message that is not the persona's are all refused. Answers with the case id and the resolved moment |
| `/nep mentor anchor id:<case> message:<link or id>` | Add another moment to an existing case. Same refusals as `add`, plus: unknown case, retired case, a non-reply case, the same message twice, a moment whose chat is empty or ends with the persona, and more than `mentor.anchor.max` moments |
| `/nep mentor cases` | List cases: id, state (`new`, `passing`, `failing`), target, last score, number of moments (when any), text clipped to 80 chars |
| `/nep mentor remove <id>` | Retire a case |
| `/nep mentor run <id>` | Run the full cycle for one case. Answers at once that it started. With an admin channel (`bot.dryRunChannelId`), the report is posted there; without one, the reply points at `/nep mentor status` and `/nep mentor show <id>` |
| `/nep mentor check` | Replay the stored situations of every active case that has a run, with `mentor.check.samples` samples each (real moments use `mentor.anchor.samples`). With an admin channel, posts one combined report; without one, the reply points at `/nep mentor status` and `/nep mentor show <id>` |
| `/nep mentor stop` | Cancel the run in flight, including the model call in progress |
| `/nep mentor show <id>` | The report of the last run: situations, answers, scores, comments, and the diagnosis when present |
| `/nep mentor wrong <id> <reason>` | Tell the mentor it judged that case wrongly and why; kept as a counter-example for future scoring |
| `/nep mentor status` | Model, enabled or not, tokens used today / cap, cases by state, the run in flight (shows `, stopping` while a stop is pending), and the most recent finished run (`last:`): its case, outcome, median overall, scored answers, tokens and finish time |
| `/nep access grant <command> [role] [user]` | Open a command, group or `*` to everyone (default), a role, or a user. `private.*`, `mentor.*` and `access.*` are excluded; see above |
| `/nep access revoke <command> [role] [user]` | Revoke a previous grant from everyone (default), a role, or a user |
| `/nep access list` | List every current access grant |

## Member commands

`/nep pings` is the one command every server member may run without a `bot.access` grant. `features.memberCommands: false` restricts it to owners.

| Command | What it does |
|---|---|
| `/nep pings [mode]` | Show or change whether the persona's messages notify you. Without `mode`: your current setting. `on` / `off`: set the preference. When off, replies to your messages carry no reply ping and @mentions of you in the persona's text still render but send no notification. The wording is the same either way. Ephemeral reply: `Pings: on` or `Pings: off`. Stored per server, survives restarts, cleared by `/nep memory wipe` |
