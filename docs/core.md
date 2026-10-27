# The core

How the engine processes one event from start to finish: the event door, the pipeline, a turn, the tool loop, prompt assembly, model roles, and the safety rails.

## The composition root

`startCore` in `src/core.js` builds every subsystem in one order and starts it: the configuration and its hot reload, the memory database, the stores, the model clients, the link to the interface, the turn runner and the behaviours, the event door and the timers, then the startup steps. It takes the paths, the environment and the interfaces as arguments, so a test starts the whole core over temporary directories with a scripted model and the fake interface (`tests/core-slice.test.ts`). `src/index.js` is the entry that supplies the real ones and the Discord package. See [Starting the core](interfaces.md#starting-the-core).

## The event door

Every event enters through one door (`src/interface/door.js`). An interface adapter (Discord today) normalizes what the platform delivers into a typed event (defined in `src/protocol/events.js`): a received message, a reaction, an owner command, a membership change, a voice state change. The core's own events (a scheduler tick, a completed errand, an inner-life wake) enter the same way.

The door validates each event against the protocol's schema and deduplicates by event id. An id that was already handled gets a `duplicate` status and its handler does not run again. An id whose handler threw is not remembered, so redelivery gets another try. Nothing throws out of the door: the answer is always a status with a reason.

The behaviours' clock is one such event. `src/behavior/scheduler.ts` keeps one timer for the earliest of its beats: `spontaneous.tick` and `diary.tick` (which also sends what the diary's mirrors hold queued) every 30 seconds and the inner life's tick every `innerLife.tickSeconds` (default 60), read before each wait. A wait ends in a `scheduler.tick` event submitted through the door, and the door's handler starts every beat that is due without waiting for it. A beat that throws is logged and the others still run. The housekeeping timers (store flush, memory database tick, embedding and avatar queues, metrics, usage, archive drain, affinity decay) are plain intervals in `src/core.js`.

## The pipeline

A `message.received` event enters the message pipeline (`src/behavior/pipeline.js`). The pipeline decides the outcome:

1. **Filter.** Bot messages, system messages, empty messages and messages from the bot itself are ignored.
2. **Private-chat gate.** A direct message goes through `src/behavior/private.js`: it needs `features.privateMessages`, server membership, a profile and a passing affinity check.
3. **Trigger detection.** The pipeline checks whether the message is a mention, a reply, a name trigger or a follow-up to an earlier exchange (`src/behavior/mention.js`). An address classifier (an `analyzer` call with `prompts/address.md`) decides ambiguous cases.
4. **Spontaneous interest.** A message that is not addressed to the persona may still trigger a spontaneous answer: eavesdropping, random interjection, or a question put to the whole room.
5. **Pending queue.** When the persona is already answering someone, a new call goes into the pending queue. One turn runs at a time across the whole server. Calls are answered in order, any number per channel and author, up to `mention.maxPending` (default 6). A new message about something already waiting is folded into that pending item instead of queueing separately.
6. **Turn.** A call that passes the queue starts a turn.

## A turn

A turn (`src/behavior/turn.js`) has four stages:

**Collect.** The turn gathers the context it needs: channel history, memory profiles, the persona's recent participation on other channels, media descriptions (pictures, video) from the `vision` and `video` model roles, lorebook entries matched by the transcript, and recall hits if a search classifier or the automatic prefetch found anything relevant.

**Build.** `src/behavior/prompt.js` assembles one LLM request under the token budget. The budget is spent in priority order (see "Prompt assembly" below). What does not fit is trimmed by `src/llm/budget.js`, lowest priority first.

**Call.** The request goes to the LLM through `src/llm/openrouter.js`. The response is parsed for output tags (`src/llm/parse.js`): `<msg>`, `<react>`, `<draw>`, `<gif>`, `<call>`, `<skip/>` and others defined in `prompts/format.md`.

**Act.** Messages are posted with realistic timing: a pause proportional to the text length, a typing indicator, multiple short messages sent in sequence. Reactions land on the message they answer. Drawings go through the image generation client. Tool calls enter the tool loop.

## The tool loop

When `features.coreTools` is on, the persona's granted tools appear in the LLM request as callable tools (native tool definitions by default, or as a `<tools>` text block with `tools.transport` set to `text`). Each `<call>` in the model's output passes the tool gateway (`src/tools/gateway.ts`): it checks access, validates arguments against the tool's schema, checks the requester's rights and the budget.

After the calls of one answer run, their results come back in another LLM request. This loop repeats up to `tools.loop.maxSteps` times (default 3), with a time budget of `tools.loop.timeBudgetMs` (default 20 seconds) and at most `tools.loop.maxCallsPerStep` calls per answer (default 4). When the step or time limit runs out, the current answer is the persona's last.

When `features.coreTools` is off (the default), the classifiers before the reply do the work instead: a lookup classifier picks web and server searches, a rewatch classifier picks a second look at media, and a route classifier picks another channel to show. The persona has no callable tools in this mode.

The persona's tools are defined in `src/tools/definitions.ts`: operations covering messages, reactions, drawing, voice, web search, memory reads, errands, intentions, config, media and more. Each is wired to an operation of the ops layer (`src/tools/impl/`), and each has a declared effect (read, write, destructive, administrative, paid) that the gateway enforces.

## Prompt assembly

`src/behavior/prompt.js` builds one request: a system message (the character-agnostic rules, the character card, live corrections, the output format) and a user message with context blocks, ordered for the provider's prompt cache.

The token budget (`llm.maxRequestTokens`, default 50,000) is spent in this priority order:

1. System prompt, the task text, the clock, tempo, the interlocutor's current state. Never cut.
2. Memory about the trigger's author.
3. What the persona looked up this turn (web results, server history recall, or both).
4. Server patterns and what the persona has claimed about itself. Lorebook entries.
5. The server's channel map.
6. The channel transcript (newest messages first). Another channel pulled into this turn.
7. The anchored window (older lines of the current channel that matter).
8. Recent lines and recent moments of the people present.
9. The persona's own exchanges on other channels.
10. Memory about other people in the transcript.
11. Neighbouring channels.
12. The server's custom emoji.
13. The GIF library.

What does not fit is trimmed starting from the bottom. The system prompt, the task and the clock are never cut.

### Cache layout

The user message is split into three text parts, stable to per-turn:

1. **Stable part.** What changes only with the config: senses, the persona's tools in text form (when `tools.transport` is `text`), self-facts, chat patterns, GIFs, the people directory. This part survives across turns and hits the provider's prompt cache.
2. **Profiles.** The interlocutor's profile alone.
3. **Tail.** Everything else: other people's profiles, current states, the chat transcript, the clock, per-turn senses, tempo and the task text (where the model attends most).

The block order is laid out for caching and is not cosmetic. `src/llm/openrouter.js#withCacheMarker` is the one place cache markers are set.

## Model roles

Every LLM request goes out on a named role, and each role has its own model. The models sit in three groups in config (`models.base`, `models.errands`, `models.development`):

| Group | Roles | What they do |
|---|---|---|
| `models.base` | `core`, `analyzer`, `vision`, `video`, `embedding`, `speech`, `drawing` | The persona's own requests: the core speaks, the other model roles classify, describe, embed, speak and draw |
| `models.errands` | `scout`, `server` | The errand agents, run asynchronously through a separate runner |
| `models.development` | `thinker`, `dev` | Development agents (outside the engine, working on the repository) |

A role never borrows another role's model. An unset role uses its own default (the same value `config.json` ships). `models.byPurpose` can pin a single purpose to a model of its own regardless of its role.

### Keys

`OPENROUTER_CORE_KEY` is the main key. `llm.keyByRole` maps individual roles to their own key (a different environment variable name). The errand and development roles never go out on the main key.

## Web search and page reading

The persona can search the web and read pages behind links. Both require `features.webLookup` set to `true` (off by default). The code lives in `src/web/` (the clients) and `src/tools/tools.ts` (the tool wrappers).

### How a search happens

There are two paths, depending on whether `features.coreTools` is on.

With `features.coreTools` off (the default), a lookup classifier (`prompts/lookup.md`, run on the `analyzer` role) reads the recent chat and decides whether the question needs a web search, a server history search, or both. Its output is a plan with labelled lines (`web:` a query, `server:` word forms, `who:` name forms, `when:` a date range). The `analyzer` then condenses the search results through `prompts/search-summary.md` into one note with inline sources.

With `features.coreTools` on, the lookup classifier does not run. The persona calls `web.search` and `web.read` as tools in the tool loop. `web.search` returns the results raw (title, URL, site, snippet, date) with no summary request. `web.read` fetches a single page through the SSRF-guarded fetcher (`src/web/fetch-page.js`) and returns its extracted main text, cut at `web.links.readChars` (default 4,000 characters).

When the turn planner is on (`features.turnPlanner`), its lookup block replaces the classifier.

### Search engines

`web.search.engine` picks which engine runs the search:

- `brave` (the default): the Brave Search API (`src/web/brave.js`). Needs `BRAVE_SEARCH_API_KEY`.
- `exa`: Exa's public MCP endpoint (`src/web/exa.js`). Works without a key; `EXA_API_KEY` is optional.
- `openrouter`: OpenRouter's web plugin on Exa. The summary request itself searches in one call, billed to credits. Sources come from the answer's `url_citation` annotations.

`web.search.fallback` lists engines to try in order when one fails with `rate-limited`, `timeout` or `network`. A search that returns nothing (`empty`) is not retried.

### Link reading

When `features.webLookup` is on and a message contains a link, the engine reads the page. With `features.coreTools` off, the `analyzer` condenses the page through `prompts/read-link.md` into an excerpt of at most `web.links.summaryChars` (default 700). With `features.coreTools` on, the excerpt is the opening of the page's own extracted text, cut at `web.links.previewChars` (default 700), with no model request.

### Limits

All web activity (link reads and searches) shares one daily counter: `web.maxPerDay` (default 60). Each lookup takes one slot, whatever the attempts. Search results are cached for `web.search.cacheHours` (default 24 hours). Page reads are cached for `web.links.readCacheHours` (default 6 hours). Every model call also counts against `llm.maxRequestsPerDay`.

### Compared to a scout errand

The `web.search` and `web.read` tools run in the persona's own turn, synchronously. A scout errand (`errand.run` with the scout agent, see [docs/errands.md](errands.md)) runs asynchronously in a separate process: it can do multi-step research, fetch media and files, and bring back attachments. The in-turn tools are fast and cheap (one search, one page). The errand is for work that takes several steps or needs to return files.

## Safety rails

Two hard limits that cannot be turned off:

1. **Per-request token cap.** No request larger than `llm.maxRequestTokens` (default 50,000 tokens) ever leaves the process. `src/llm/budget.js` trims to fit; `src/llm/openrouter.js` refuses what is still too large.
2. **Daily request cap.** No more than `llm.maxRequestsPerDay` requests are made per UTC day. This prevents a spam of mentions from burning the API budget.

Both errors reach the persona through their turn result: a `token-limit` or `daily-cap` code. When the persona was asked directly and a rail refuses, one plain limit notice is posted from `labels.json` wording so the person knows what happened.

### How failures reach the persona

Every action the persona takes is answered by a result (the interface port's contract). The port the core hands to her turns, wakes and tools is guarded (`src/behavior/mirror.ts#guardMirrorPort`): a send to a place of an enabled diary mirror goes nowhere and fails with the code `diary-mirror`. Only the diary's mirrors hold the interface's own port. The result's status is `ok`, `failed`, `unknown`, `unsupported` or `forbidden`. A failed drawing, a refused tool call, a daily cap are all reported this way. The persona's tool loop sees the result of each call and can decide what to do next.
