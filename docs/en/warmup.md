# Warmup

The warmup builds the persona's memory of a server from a sample of recent messages. It is an operations tool, `tools/warmup.mjs`, run on the server from the bot's checkout with the bot stopped, before the first start (see [Running it](#running-it)). It has no slash command.

The bot never runs the warmup. The tool resumes an unfinished run itself.

## Stages

A full run proceeds in a fixed order: channels, people, server.

### Channels

Every readable channel gets one request, described from the newest `warmup.messagesPerChannel` (default 200) messages regardless of their age. When a channel's history has fewer messages than that, a deeper fetch is attempted. A channel with no history at all is described from its name, category and topic alone. The result is a set of channel notes (purpose, topics, tone) and code-maintained facts (message counts, top writers, a 30-day activity histogram).

### People

The most active members qualify: at least `warmup.minMessages` own messages within the last `warmup.lookbackDays` days, up to `warmup.maxPeople`, most active first. `node tools/warmup.mjs people` lists qualifying members under the current settings.

For each qualifying member the engine samples up to `warmup.messagesPerPerson` of their messages with `warmup.contextBefore` lines of surrounding context. No single channel may contribute more than `warmup.maxChannelShare` of the sample. Large samples are split chronologically into chunks that fit `warmup.maxRequestTokens`; each chunk after the first receives the previous answer as a `<draft>` block so the model keeps what holds, corrects what changed and extends with new evidence. The final answer stores character, style, interests, details, episodes and aliases; message count and first/last seen timestamps are computed by code.

### Server

One request takes all channel notes, a one-line summary per profiled member (name, top habits, top interests) and the newest `warmup.serverSampleMessages` (default 600) lines of the main channels (`memory.mainChannelIds`; when empty, every channel counts). The output is stored as server-wide patterns, conversation starters, in-jokes and lore entries.

## Scope

The warmup writes: channel notes (purpose, topics, tone), member profiles (character, style, interests, details, episodes, aliases), server habits (patterns, starters, in-jokes) and lore.

Attitude and relationship are never warmed up. They grow only from live conversation through the stream analyzer.

`character` and `style` are prose fields written exclusively by the profile prompt (`profile.md`), both during the warmup and during a portrait refresh. The stream analyzer never edits them directly. See the [prompt contract](prompt-contract.md) for the data model and the output schema.

## Progress

Progress is persisted to `state.warmup` in `data/state.json` after every request and survives restarts. A run interrupted by Ctrl+C, the token budget, a rate limit or three failed requests in a row resumes from where it left off when `node tools/warmup.mjs run` is called again. `node tools/warmup.mjs reset` clears progress only, not stored memory.

## Rails

The total token budget for a run is `warmup.maxTokens` (default 6,000,000). Each request is capped at `warmup.maxRequestTokens` (default 120,000 input plus output) and `warmup.maxOutputTokens` (default 6,000 output). The channel fetch that builds the sample pool reads up to `warmup.fetchLimitPerChannel` (default 15,000) messages per channel.

When the provider returns HTTP 429, the warmup waits `warmup.rateLimitWaitMinutes` (default 10) minutes and retries. After `warmup.rateLimitMaxWaits` (default 36) consecutive waits the run aborts; progress is kept and the run can be resumed.

## Portrait refresh

After the warmup finishes, the stream analyzer keeps memory current from live batches. Portraits are refreshed in two ways.

**By counters** (`features.portraitRefresh`). A periodic scheduler checks every `memory.portraitCheckMinutes` (default 60) minutes for members who have written at least `memory.portraitRefreshMessages` (default 300) own messages since their last portrait AND whose last successful refresh was at least `memory.portraitRefreshDays` (default 3) ago. It refreshes up to `memory.portraitRefreshPerDay` (default 3) members per day, most active first. A member whose portrait has never been refreshed counts all their messages, so several may qualify at once after deploy; the daily cap spreads them over a few days. A failed attempt backs off for `memory.portraitRetryHours` (default 24) hours. The sample is fitted under the 50k token rail.

**By the analyzer's cue.** When the stream analyzer detects a recurring habit or a change in how someone writes that the stored portrait misses or contradicts, it returns a one-line portrait hint, and code queues a refresh. This path uses the existing per-member cooldown of `memory.portraitRefreshHours` (default 24) hours. The stream analyzer can no longer overwrite `character` or `style` directly.

In two-stage mode, a portrait refresh does not run while the member's character text is waiting for the voice model (`voice-pending`). A forced refresh (`/nep memory refresh kind:user`) overrides this check. `/nep memory refresh kind:user` tells the owner when the member has a queued character item.

Both paths share the daily cap. `/nep memory refresh kind:user <user>` forces a refresh regardless of timers but still counts against it. Each refresh counts against `llm.maxRequestsPerDay`.

A refresh calls `profile.md` with the stored portrait as a `<draft>` and the analyzer's note as a `<hint>` (when present). The draft is a merge base: what still holds stays (condensed to make room), what the sample contradicts is revised, new recurring habits are added, and a point the sample merely does not show is not dropped. The new character and style replace the stored ones; interests, details, episodes and aliases from the answer are ignored.

## Running it

Run the tool from the bot's checkout, as the service user, with the bot stopped:

```bash
sudo systemctl stop neptunia-bot
cd /opt/neptunia-bot
sudo -u neptunia-bot node tools/warmup.mjs run --guild <server id> --dry-run
sudo -u neptunia-bot node tools/warmup.mjs run --guild <server id> --spend <usd>
sudo systemctl start neptunia-bot
```

`--guild` can be left out once `data/guilds/` holds exactly one server, or when `bot.guildId` is set. The tool reads `config.json`, `config.local.json`, `prompts/`, `prompts.local/` and `.env` from the checkout, reads Discord's history over REST with the bot token (no gateway session, nothing posted) and sends the model requests with the OpenRouter key.

| Subcommand | What it does | Spends |
|---|---|---|
| `run` | Every readable channel, every qualifying member and the server notes that the progress has not done yet, in that order | yes |
| `users [--user <id>]` | Profile that member, or every qualifying member, whatever the progress says | yes |
| `channels [--channel <id>]` | Describe that channel, or every readable channel | yes |
| `server` | Rebuild the server notes and lore | yes |
| `people` | List qualifying members | no |
| `status` | Phase, progress, tokens used against `warmup.maxTokens` | no |
| `reset` | Clear progress only, not stored memory | no |

**Spending.** `run`, `users`, `channels` and `server` print the plan (channels, members, the server notes) and the estimate first, and refuse with exit code 2 unless `--spend <usd>` covers the estimate. The estimate counts every request at `warmup.maxRequestTokens`, bounded by what is left of `warmup.maxTokens` and by `--max-usd <n>` when given, priced at `--usd-per-ktok` (0.005 USD per thousand tokens by default). The run then uses that estimate as its token budget: it stops there, resumable, and never spends past it. A member whose sample takes more than one request can reach that budget early; run again to continue. `--dry-run` prints the plan and the estimate and sends nothing. The requests never count against `llm.maxRequestsPerDay`.

**Safety.** `run`, `users`, `channels`, `server` and `reset` refuse while the bot runs on the same `data/` (its journal's `.running` marker) and name `sudo systemctl stop neptunia-bot`. The spending subcommands also refuse while a forget is under way, refuse while memory is paused, and apply the deletion ledger first when `data/` still holds something it removes. `people`, `status` and the dry runs write nothing. Ctrl+C cancels the request in flight and stops the run; progress is kept. Before it exits the tool flushes memory to disk, archive copies included.

**What it writes.** Channel notes and facts under `data/guilds/<id>/channels/`, member profiles under `data/guilds/<id>/users/`, server notes in `data/guilds/<id>/guild.json`, lore in `data/guilds/<id>/lore.json`, progress in `data/state.json`; with `features.archive` on, what a rewrite drops goes to the archive first.

**Afterwards.** Start the bot. From then on memory is kept current by the bot: the stream analyzer from live batches, the portrait refresh and the notes refresh below. `/nep memory refresh kind:user <user>` rewrites one member's portrait now; `kind:channel <channel>` and `kind:server` rewrite a channel's notes or the server notes from a fresh sample, the same request as the notes refresh below, under the live rails, with the persona talking. A channel with no notes yet and the lore are the tool's: `channels --channel <id>` and `server`.

For a truly fresh start, use `/nep memory wipe` first: it clears member profiles with their attitudes and episodes, server habits, the channel map, lore entries and warmup progress.

## Keeping the notes current

Channel and server notes are written during the warmup, then updated by the stream analyzer when a batch carries enough evidence. Over time, though, short batches miss gradual shifts in how people talk or what a channel is about. The notes refresh (`features.notesRefresh`) catches this by periodically re-examining notes from a full sample of recent messages, the same way the warmup described the channel in the first place.

### What happens

A scheduler checks every `memory.notesCheckMinutes` (default 60) minutes which channels and server notes are overdue. A channel is due when: it already has notes text (a channel the warmup never described is left to the warmup); enough days have passed since its last text change or last sample review (`memory.notesRefreshDaysMain`, default 7 for channels in `memory.mainChannelIds`, or `memory.notesRefreshDays`, default 21 for the rest); at least `memory.notesMinMessages` (default 30) messages have been tallied since then; the channel had a message within `warmup.lookbackDays` (default 60) days; and no failed attempt within `memory.notesRetryHours` (default 24).

For a due channel, the engine reads `memory.notesSampleDays` (default 30) days of history, drops the persona's and other bots' lines, and picks `memory.notesSampleMessages` (default 160) messages spread over the days. The spread avoids overrepresenting the latest conversation: the engine takes one message per day per round, newest day first, and one author may hold at most `memory.notesSampleMaxAuthorShare` (default 0.35) of the sample. If fewer than `notesMinMessages` usable messages remain, the channel is skipped (`too-few`).

The request uses the same `channel.md` (or `server.md` for the server) that the warmup uses, with one addition: an `<existing_notes>` block showing the stored notes as JSON plus `writtenDaysAgo` (whole days since they last changed, null when unknown). The prompt tells the model to treat these as claims to evaluate against the sample, not as evidence. The answer replaces the stored purpose, topics and tone (or patterns, starters and in-jokes for the server). If the channel's text changed between the history read and the answer (another batch updated it), the answer is dropped (`conflict`). Either way, a valid answer stamps `notesSampleReviewedAt`. The stored text's `updatedAt` moves only when the text actually changed.

The server follows the same rule: `memory.notesServerRefreshDays` (default 7) since the last change or review, at least `memory.notesGuildMinMessages` (default 100) messages summed over all channels. The server goes after the channels in a cycle and is outside the daily cap.

### How often, what it costs

Up to `memory.notesRefreshPerDay` (default 4) successful channel refreshes per UTC day. A failed request does not take a slot. The day counter lives in `state.json` as `notesRefreshDay` / `notesRefreshCount`. Server refreshes are not counted toward the channel cap.

Each refresh request counts against `llm.maxRequestsPerDay` and the 50k token cap, but not against the warmup's `warmup.maxTokens`. The persona is not muted during a refresh. A refresh is refused while a warmup pass runs.

### Log lines

`warmup: notes refreshed` with `{ target: "channel" | "server", channelId, changed, sample, authors, days }`.

`warmup: notes refresh failed` with `{ target, channelId, reason }`. Reasons: `running` (a warmup pass is in flight), `paused`, `gone` (the channel no longer exists), `too-few` (too few usable messages), `conflict` (the stored text changed between the history read and the answer), `bad-json`, `llm-error`, `token-limit`, `daily-cap`, `no-prompt`.

`notes refresh: look` with `{ due, started, refreshed, changed, skipped }` and `buckets { neverReviewed, fresh, due, few, quiet, retryWait }` counted over all channels.

Nothing is rewritten to look fresh. When the sample cannot tell whether a claim still holds, the stored text stays as it is.

For the full list of warmup configuration keys see [Configuration: warmup](configuration.md#warmup).
