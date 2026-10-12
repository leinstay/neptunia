<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner-dark.png">
    <img src=".github/assets/banner.png" width="700" alt="Neptunia - AI character engine for Discord">
  </picture>
</p>
<p align="center">English | <a href="docs/zh/README.md">中文</a> | <a href="docs/ja/README.md">日本語</a> | <a href="docs/ru/README.md">Русский</a></p>
<p align="center">
  <a href="https://github.com/leinstay/neptunia-bot/stargazers"><img src="https://img.shields.io/github/stars/leinstay/neptunia-bot" alt="GitHub stars"></a>
  <a href="https://github.com/leinstay/neptunia-bot/forks"><img src="https://img.shields.io/github/forks/leinstay/neptunia-bot" alt="GitHub forks"></a>
  <a href="https://github.com/leinstay/neptunia-bot/issues"><img src="https://img.shields.io/github/issues/leinstay/neptunia-bot" alt="GitHub issues"></a>
  <a href="https://github.com/leinstay/neptunia-bot/pulls"><img src="https://img.shields.io/github/issues-pr/leinstay/neptunia-bot" alt="GitHub pull requests"></a>
  <a href="https://github.com/leinstay/neptunia-bot/blob/main/LICENSE"><img src="https://img.shields.io/github/license/leinstay/neptunia-bot" alt="License"></a>
  <a href="https://github.com/leinstay/neptunia-bot/actions/workflows/test.yml"><img src="https://github.com/leinstay/neptunia-bot/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
</p>

---

Neptunia is a locally run Discord bot that plays one configurable character through an LLM, behaving like an ordinary chat member. It runs on Node.js 20+ with a single dependency (discord.js) and talks to any OpenRouter-compatible endpoint. It comes with a pluggable character card written without touching code, hot-reloaded prompts and config, per-member memory with attitudes and episodes, a server-wide lorebook, vision for attached pictures, one-line media descriptions from a helper model, drawing on request through an image generation model, private chat in Discord DMs with a separate memory layer, owner slash commands for live tuning, and a dry-run mode. A working example character is included; write your own card for a different persona.

The persona responds to mentions, replies and name triggers, sometimes ignoring them. They cut into conversations at random intervals and start topics in dead channels. They remember people, track attitudes from -100 to 100, and use them in replies. The score never appears in chat. All config and prompts are hot-reloaded; owner commands tune the bot live from Discord.

Each instance serves one server, one bot account, one personality. For a second server or character, run a second copy with its own `.env`, `config.local.json`, `prompts.local/` and `data/`. Discord marks bot accounts with an APP badge; the engine does not disguise that.

## Quick start

Create a Discord application at [discord.com/developers](https://discord.com/developers/applications). Enable the **Message Content** privileged intent on the Bot page. The invite URL needs both scopes (`scope=bot%20applications.commands`) and `permissions=101440` (view channels, send messages, read history, add reactions, attach files). If slash commands do not appear after the bot joins, the log says why; re-opening the invite URL and walking through it again fixes registration without removing the bot.

Get an API key from [OpenRouter](https://openrouter.ai/keys) (or any compatible endpoint).

```bash
git clone https://github.com/leinstay/neptunia-bot.git
cd neptunia-bot && npm install
cp .env.example .env
```

Edit `.env` with your Discord token and API key. Create `config.local.json` with your Discord user ID:

```json
{
  "bot": {
    "owners": ["YOUR_DISCORD_USER_ID"]
  }
}
```

```bash
npm start
```

When `bot.guildId` is empty and the bot is in exactly one server, it locks to that server automatically. If the bot is in several servers, it refuses to start. Set `bot.guildId` in `config.local.json`.

## Features and changes

**12.10.2026**  
The diary no longer falls silent for days: after an empty window, posts come later the same day. Two new kinds of diary post carry four to six pictures at once: a photo set from one outing, in the same outfit at the same hour, or a gallery of anything Neptunia likes, not only self-portraits. A member who asked not to be pinged is answered without a notification.

**11.10.2026**  
Neptunia keeps a few lines around what they said on other channels for three days. When a new message refers to one of those exchanges, even only by meaning, they answer from the conversation they actually had instead of guessing, and they do not bring those exchanges up on their own.

**06.10.2026**  
Neptunia keeps a diary: one channel where they post on their own, without anyone asking. The posts come at random times across the day, with quiet days mixed in. A post can be a drawing of a scene, a meme, a thought, a retold news item, a curious fact or a one-line mood update. Before posting, they look over their recent posts and pick something they have not done yet. For news and facts they search the web first and retell what they found in their own words.

**05.10.2026**  
Neptunia distinguishes between someone talking to them and people talking about them in the third person. When a conversation mentions another channel, they open that channel and read the latest messages with pictures, even when the channel was named in words without a link. If someone calls them in a channel where they cannot write, they answer in the main channel with a link to that message, and on their own they can comment there on something they read in such a channel. A question asked to everyone is more likely to get their answer than one aimed at a specific person. Neptunia remembers what mattered over the last few days: what someone gave them or asked them to do, what they promised, what happened between members, and when someone asks about a person, the moments connected to that person come back. Old server messages they search the same way as the web: for questions like "what did we do on New Year's" or "who is ..." they find the right conversation and answer from it.

**04.10.2026**  
Neptunia knows what is in the pictures that were recently posted in other channels.

**03.10.2026**  
When Neptunia has not talked to someone in a while, their attitude toward that person gradually returns to neutral.

**30.09.2026**  
Neptunia uses the server's custom emoji in their messages on their own and posts GIFs from the ones people share on the server, seeing what happens in them. They know today's date.

**29.09.2026**  
Neptunia replies in direct messages, and what someone tells them there does not appear in the server channels. They see which reactions people put on messages.

**28.09.2026**  
Neptunia draws pictures on request or on their own. They can draw themselves: they have a consistent appearance.

**26.09.2026**  
Neptunia sees pictures and videos inside forwarded messages. They also watch long videos from YouTube.

**24.09.2026**  
Neptunia remembers what people teach them in the chat: facts, rules, "that's how we do things here."

**23.09.2026**  
Neptunia watches videos: both attached files and links from YouTube, TikTok, VK, X (Twitter), Reddit, Twitch. When asked about a detail in a video they already watched, they re-watch it with that question. Links from messages they open and read, and they search the web when a question needs fresh facts or when someone directly asks them to look something up.

**22.09.2026**  
Neptunia understands when someone is talking to them without a mention or a tag, from the context of the conversation.

**21.09.2026**  
Neptunia sees pictures posted in the chat, along with stickers, the server's custom emoji and link previews with the site title and description. If a message has an attachment they cannot open, such as a file or a voice message, they know it is there and do not pretend they looked. Forwarded messages they understand too: who sent the original and what it says. Neptunia remembers individual moments with people, who said or did what and what they thought about it, keeps track of local jokes and server stories, and remembers a person's hobbies and facts about them, but only what has come up more than once. Nicknames too: what members call each other.

**20.09.2026**  
Neptunia answers when called: by a mention, a reply to their message, or just their name in the text. They can also write in a channel on their own when nobody called them, join someone else's conversation when they have something to say on the topic, or ignore a message, like someone who reads it and stays quiet. Replies are not instant: a typing indicator shows, the answer may come as several short messages, and sometimes instead of words they place a reaction. Neptunia remembers every member, who each one is and how each one talks, and their attitude toward each person is different and changes depending on how that person talks to them. They can tell whether a channel has a live conversation or is quiet, and they know which channels the server has and what each one is about. On the first launch they read older messages from the server and build a first picture of the people and channels, so they do not start from zero.

## Prompt layers

Prompts load from two directories:

- `prompts/`: tracked engine defaults shipping a working example character.
- `prompts.local/`: your personality (gitignored). A file here replaces the same-named file in `prompts/`. `labels.json` is deep-merged, so only overridden keys are needed.

Both are hot-reloaded.

The only file you must rewrite is `character-card.md`. Copy it to `prompts.local/` and write your persona. Everything else works as-is, or override individual files as needed.

The prompt files, placeholders, labels, context blocks and output tags are described in [`docs/en/prompt-contract.md`](docs/en/prompt-contract.md).

## Configuration

`config.json` holds every setting with its default. `config.local.json` (gitignored) is deep-merged over it. Both are hot-reloaded. See [`docs/en/configuration.md`](docs/en/configuration.md) for the full reference of every key.

## Warmup

On first start, when `warmup.enabled` is true and no profile exists, the engine runs a warmup that builds memory of people, channels and the server from a sample of recent messages. The total token spend is capped by `warmup.maxTokens`. The persona stays mute while the warmup runs. See [`docs/en/warmup.md`](docs/en/warmup.md) for the stages, progress, rails and owner commands.

## Dry run

With `features.dryRun: true` the bot runs the full pipeline (memory, triggers, LLM calls) but never sends a message or reaction. Output goes to the log (`dry-run: would send` / `dry-run: would react`). Set `bot.dryRunChannelId` to a private channel for a readable mirror; everything posted in that channel is ignored by the bot. Slash commands work in any channel, the mirror included, because they are not messages.

First run on a new server: enable `features.dryRun`, watch the mirror or `journalctl -u neptunia-bot -f`, tune live, then `/nep set features.dryRun false`.

## Commands

One Discord slash command, `/nep` (the name comes from `bot.commandName`). It is registered as a guild command on start, for the served server only. Every answer is ephemeral; only the caller sees it, in whatever channel it was typed. See [`docs/en/owner-commands.md`](docs/en/owner-commands.md) for every subcommand and the access grants.

## Messages and memory

The persona responds to mentions, replies and name triggers, sometimes ignoring them. They cut into conversations at random intervals, start topics in dead channels, and may pick up a question put to the room. After answering, they track follow-up messages in that channel through a classifier. They write one reply at a time across the server; pings in other channels are held and answered in turn, any number per channel and author, up to `mention.maxPending` (default 6). When a message holds several separate requests, each is answered in its own turn. When someone sends another message about something still waiting, it is folded into that item instead of queueing separately. When someone talks about another channel, a classifier picks the channel so the persona can read it.

A separate memory analyzer runs when enough messages accumulate. It builds per-member profiles with interests, details, aliases, episodes and attitudes, server-wide habits and in-jokes, a lorebook of events and stories, and a list of things people taught the persona directly (words, facts, requests). Profiles are updated incrementally; stored facts are never re-summarised. The persona also learns what people call each other and recognises a member by name or alias. Lessons are stored at the server level (`memory.maxLearned` shown, `memory.maxLearnedStored` kept on disk, `memory.learnedChars` per item) and always appear in the prompt.

See [`docs/en/messages-and-memory.md`](docs/en/messages-and-memory.md) for the pipeline steps, the analyzer, profiles, episodes, the lorebook and the owner commands that touch memory.

## Media

The persona can see attached pictures, watch short video clips, read pages behind links, search the web and the server's own message history for facts they do not have, draw pictures on request through an image generation model, and post GIFs from a library built from what the chat shares. Each capability is a separate feature switch, off or capped by default, with its own daily limit. A `<senses>` block in each request tells the persona what is on; they never claim to have perceived anything beyond it. See [`docs/en/media.md`](docs/en/media.md) for pictures, video vision, link reading, search, drawing, tools, costs and privacy.

## Private chat

`features.privateMessages` (off by default) lets guild members talk to the persona in Discord DMs. The persona is the same character with the same public memory; what is said in a DM is remembered in a per-member private layer that no other conversation ever sees. DMs need the same server membership and no extra permission beyond what the invite URL already grants. See [`docs/en/messages-and-memory.md`](docs/en/messages-and-memory.md#private-layer) for the gate, the private memory layer and the owner commands.

## Mentor

`features.mentor` (off by default) adds a manual testing sub-process with its own model. A case is a real message of the persona plus one sentence about what is wrong with it. The mentor stores the chat that led to the message, invents more situations of the same kind, runs the persona through all of them in a sandbox with the live prompts and memory, and scores every answer on five axes (0–10). When a run fails or scores poorly, the mentor names likely causes in the persona's context and proposes changes as advice for the owner to review. All work stays in `data/`. When `bot.dryRunChannelId` is set, a finished run is posted there as well; without an admin channel the owner follows a run with `/nep mentor status` and reads the report with `/nep mentor show <id>`.

The mentor model, budget and commands are independent from the persona's. See [`docs/en/configuration.md`](docs/en/configuration.md#mentor) for the config keys and [`docs/en/owner-commands.md`](docs/en/owner-commands.md) for the `/nep mentor` subcommands.

## Costs

Each turn is one LLM request; a memory update adds a second. A split-message classifier and a merge classifier may add one request each on the `classifier.text` model when their conditions are met. Cost depends on the model and endpoint; `llm.model` and `llm.baseUrl` accept any compatible values. The daily cap (`llm.maxRequestsPerDay`) prevents runaway spending. Video descriptions add one request per watched clip to a separate, cheaper model (`media.video.maxPerDay` caps the daily count); `yt-dlp` and `ffmpeg` run locally and cost nothing beyond bandwidth. Link reads and web searches (`features.webLookup`, off by default) add requests to the text classifier model, capped by `web.maxPerDay`; web search additionally needs a Brave Search API key (free tier: 2,000 queries/month). Server-history searches (`features.recall`, on by default) use Discord's built-in search API and add only the classifier and summary requests. Image generation (`features.imageGeneration`, off by default) bills per output token through `image.model`; `image.maxPerDay` caps the daily count separately from chat requests. Private chat (`features.privateMessages`, off by default) uses the same LLM and caps; each DM reply is one request, each private analyzer batch is another. With `features.webLookup` on, the bot makes outbound HTTP requests to fetch pages and to the Brave Search API; private addresses are refused.

`data/` holds per-member profiles, relationship scores, channel observations, server patterns, cached media descriptions and web excerpts. It stays on your machine, is gitignored, and is only sent to the LLM as context. The analyzer is instructed not to store sensitive details. `/nep memory forget` deletes a profile entirely.

Tell your server members. They should know their messages are processed by an LLM and that the bot keeps notes.

## Service

An example systemd unit is in `deploy/neptunia-bot.service`. Adjust `WorkingDirectory` and `User`, then install:

```bash
sudo cp deploy/neptunia-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now neptunia-bot
```

The private layer lives alongside the code: `.env`, `config.local.json`, `prompts.local/`, `data/`. To update:

```bash
git pull && sudo systemctl restart neptunia-bot
```

A restart loses nothing; all state is on disk. Restarts are only needed after code changes under `src/`. Prompt and config edits apply live.

Memory lives in the process and is written to `data/`; editing those files under a running bot is unsafe because the next write overwrites the change. To edit memory by hand: `/nep pause`, edit the files, `/nep resume`. The pause stops all activity, flushes memory to disk and unloads it; a running warmup pauses after the current request. The state is persisted: a restart comes back paused, and the warmup does not auto-start until resume. `/nep resume` validates every JSON file under `data/` and refuses if any do not parse, naming the broken ones; otherwise it reloads memory and continues, including a warmup from where it left off. Read-only and config commands work while paused; commands that write memory are refused. `/nep status` shows the paused state.

## Contributing

Issues and pull requests are welcome; read `CONTRIBUTING.md` first. Target branch is `main`, one change per pull request, tests pass with `npm test`, English only. The contract between the prompt files and the code is in `docs/en/prompt-contract.md`. A change on one side requires the matching change on the other, in the same pull request. The engine stays character-neutral; behaviour of one character belongs in that deployment's `prompts.local/`. Security reports go through `SECURITY.md`, not public issues.

## Tests

```bash
npm test
```

Runs with `node --test`. No network or Discord connection needed. The same command runs in CI on every pull request.

## Structure

```
config.json                defaults for every setting, hot-reloaded
.env.example               template for DISCORD_TOKEN, OPENROUTER_API_KEY, optional YOUTUBE_API_KEY and BRAVE_SEARCH_API_KEY
prompts/
  system-prompt.md         how to behave like an ordinary chat member
  character-card.md        the personality (working example)
  rules.md                 owner's live corrections
  format.md                output tags the model uses
  reply.md                 task: someone called you
  interject.md             task: jump into a conversation
  initiate.md              task: start a topic
  forced.md                appended on a forced turn (/nep interject, /nep initiate)
  private.md               appended in a DM turn (features.privateMessages)
  memory.md                prompt for the memory analyzer
  diary.md                 task: write a diary post
  diary-plan.md            diary planner: pick the kind and subject for the next post
  world.md                 the persona's virtual world (diary posts only)
  diary-seeds.md           random seed families for the diary planner
  draw.md                  prompt for the drawing sub-process (image generation)
  appearance.md            the persona's visual look for self-portraits
  describe.md              prompt for the media describer
  describe-video.md        prompt for the video describer
  describe-gif.md          prompt for the GIF describer
  rewatch.md               classifier: re-watch a video for a question
  rewatch-answer.md        prompt for the re-watch answer
  address.md               classifier for follow-up messages
  lookup.md                classifier: does a question need a web or server search
  read-link.md             condense a fetched page
  search-summary.md        condense web search results
  recall-summary.md        condense server-history search results
  room.md                  classifier: is this message for everyone in the room
  route-channel.md         classifier: does answering need another channel
  elsewhere.md             task: comment on a read-only channel in the main channel
  mentor-situations.md     mentor: invent test situations
  mentor-score.md          mentor: score the persona's answers
  mentor-signs.md          mentor: known habits of model-written text
  mentor-diagnose.md       mentor: explain weak answers after scoring
  split.md                 classifier: does a direct call hold several separate requests
  merge.md                 classifier: does a new message belong to something already waiting
  profile.md               warmup: one member's profile from a message sample
  channel.md               warmup: channel notes from a message sample
  server.md                warmup: server-level notes from channel notes and member summaries
  labels.json              every code-inserted string in prompts
prompts.local/             your personality (gitignored)
docs/
  en/
    prompt-contract.md     the contract between prompt files and code
    configuration.md       full reference for every config key
    owner-commands.md      every subcommand and the access grants
    warmup.md              the warmup: stages, progress, rails, commands
    media.md               pictures, video, links, search, tools, costs
    messages-and-memory.md the pipeline, the analyzer, profiles, episodes, the lorebook
    diary.md               the diary feature: setup, windows, costs, tuning
  zh/                      Chinese
    README.md
    prompt-contract.md
    configuration.md
    owner-commands.md
    warmup.md
    media.md
    messages-and-memory.md
    diary.md
  ja/                      Japanese
    README.md
    prompt-contract.md
    configuration.md
    owner-commands.md
    warmup.md
    media.md
    messages-and-memory.md
    diary.md
  ru/                      Russian
    README.md
    prompt-contract.md
    configuration.md
    owner-commands.md
    warmup.md
    media.md
    messages-and-memory.md
    diary.md
src/
  index.js                 entry point, wiring, timers, shutdown
  config.js                .env parser, config loader, deepMerge
  hot.js                   live config + prompts via fs.watch
  log.js                   structured JSON logging
  admin.js                 owner commands
  llm/
    tokens.js              token estimation with self-calibration
    budget.js              priority-ordered section trimming
    openrouter.js          chat completions, safety rails
    parse.js               output tags to actions
  discord/
    guild.js               single-guild resolution
    commands.js            slash commands, registration, interaction adapter
    access.js              per-command access grants for non-owners
    events.js              message pipeline
    collect.js             channel history, neighbours, permissions
    format.js              transcript lines, time gaps, tempo
    media.js               media classification, label selection, proxy URLs
    search.js              Discord message search and member search
    pull-fetch.js          audience check, pull-channel fetch
    fetch-image.js         download and cache images for inline LLM requests
    video-sites.js         video site matching, URL cache keys, yt-dlp/ffmpeg args
    fetch-video.js         download, probe and trim videos for the video describer
  web/
    readable.js            HTML to text, paywall detection
    fetch-page.js          SSRF-guarded page fetcher
    brave.js               Brave Search client
    lookup.js              link reading and web search
  behavior/
    mention.js             call detection, ignore heuristics
    prompt.js              request builder with token budget
    turn.js                one turn: collect, build, call, act
    diary.js               diary scheduler, day plan, backfill
    spontaneous.js         chaotic timer, eavesdrop, room questions
    split.js               pure: task splitter pre-filter and answer parse
    pending.js             pending calls, merge answer parse, fold-into
    private.js             pure: DM gate, merged profiles, effective affinity
    limits.js              pure: limit and pause notices from labels
    recall.js              pure: server-history search decisions
    recall-run.js          recall runner: Discord search, windows, summary
    route.js               pure: channel route decisions
    route-channel.js       channel route classifier: picks a channel for the turn
    participation-pick.js  picks which past exchanges from other channels a turn shows
    elsewhere.js           pure: noticed comments from read-only channels
  memory/
    store.js               JSON file persistence, atomic writes
    update.js              batch memory updates
    affinity.js            relationship score logic
    interests.js           remembered interests: sightings, confirmation, eviction
    details.js             remembered details: sightings, confirmation, eviction
    aliases.js             remembered aliases: sightings, confirmation, eviction
    episodes.js            remembered episodes: append, weight-based eviction
    channels.js            channel map rendering, activity verdicts
    mentions.js            member-id tokens in stored text: toTokens and fromTokens
    clamp.js               text clamping: soft limits, sentence boundaries, safe member tokens
    ranking.js             shared ranking for interests and details: frequency, recency, decay
    lore.js                lorebook logic: key matching, entry selection
    recent.js              recent notes: the last few days of short events
    participation.js       pure: the persona's own exchanges on other channels, kept a few days
    describe.js            media describer: one picture in, one cached caption out
    portrait.js            periodic portrait refresh scheduler
    youtube-check.js       YouTube duration probes and the API key check
    warmup.js              sample-based memory warmup
tests/                     node --test, pure-function unit tests
deploy/
  neptunia-bot.service     example systemd unit
data/                      persistent state (gitignored, created at runtime)
  state.json               scheduler times, token calibration, daily counters, warmup progress, post ledger
  guilds/<id>/guild.json   server habits, in-jokes, the persona's self-claims
  guilds/<id>/buffer.json  messages observed since the last memory update
  guilds/<id>/media.json   media description cache
  guilds/<id>/gifs.json    GIF library: handles, URLs, use counts
  guilds/<id>/recent.json  recent notes from the analyzer
  guilds/<id>/participation.json  the persona's own exchanges on other channels
  guilds/<id>/users/       per-member profiles and relationships
  guilds/<id>/private/     per-member private DM memory
  guilds/<id>/channels/    channel observations from the analyzer
  guilds/<id>/diary.json   diary post history (one-line gists)
  guilds/<id>/lore.json    lorebook entries
```
