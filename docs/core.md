# The core

How the engine processes one event from the door to the answer: the composition root, the event door, the pipeline, a turn, the tool loop, prompt assembly, model roles and keys, web search, the task board's core side and the safety rails. It is for someone who runs the engine or changes `src/`.

## The composition root

`startCore` in `src/core.ts` runs `buildCore` and, when the start fails, closes everything the start opened in reverse order, so a failed start leaves no socket, timer or database lock behind. `buildCore` checks that the private directory is the data directory, claims the data directory for one core (a live holder of the database lock refuses the start with `locked`, another holder's `core:alive` lease with `core-running`), opens the key store and key ring, the configuration with its hot reload, the memory database, the stores, the model clients, the link to the interface, the turn runner and the behaviours, and the event door and timers. The startup steps run last: the memory probe, the journal, missed messages, errands, intention reconciliation, the embedding catch-up, the backfills, the affinity decay and the archive drain.

`startCore` takes the paths, the environment and the interfaces as arguments, so a test starts the whole core over temporary directories with a scripted model and the fake interface (`tests/core-slice.test.ts`). It starts at most one interface. With none, the interfaces run as separate units and `bot.guildId` must name the community. It returns the door, `stop()` and the interface list with `disable(name)` and `enable(name)`. `disable` writes `interfaces.<name>.enabled: false` to `config.local/config.json`, stops sending to that interface, gives its actions in flight `interfaces.drainMs` (default 10000) and ends the rest `unknown`. `src/index.ts` supplies the real arguments and the Discord package. See [Starting the core](interfaces.md#starting-the-core).

## The event door

Every event enters through one door (`src/interface/door.ts`). An interface adapter normalizes what its platform delivers into a typed event defined in `src/protocol/events.ts`: a received message, a reaction, an owner command, a membership change, a voice state change. The core's own events (a scheduler tick, a completed errand, an inner-life wake) enter the same way.

The door validates each event against the protocol's schema and deduplicates by event id. An id that was already handled gets the status `duplicate` and its handler does not run again. Nothing throws out of the door. The answer is a status (`ok`, `duplicate`, `invalid`, `unhandled` or `failed`) with a reason. The completed-event cache holds `DEFAULT_CAPACITY` ids, `10_000`, scoped by sender. Presence, voice and connection state events are deduplicated in memory only, and durable `ingest` rows recognize every other redelivery after a restart.

Each handler gets a trusted `receipt`. Its `observe` method claims one atomic write of the observed line and its `ingest` row together. A successful claim acknowledges the event without a separate receipt write. A refused, failed or pending claim makes the door answer `failed`, and a second claim is refused. A handler that never claims leaves the receipt to the door, which commits it through the ingestion writer after the handler returns. A duplicate whose observation is still pending answers `failed` without starting another handler. A failed write releases the event for redelivery, and a successful write is remembered even when later handler work throws. `createMessageProducers` in `src/behavior/core-message-producers.ts` carries the receipt beside the validated message event through the pipeline for new messages, edits and deletions. Fields inside an incoming event cannot replace the receipt. The write's deadline is `memoryDb.observeTimeoutMs` (default 5000), and receipts are kept `memoryDb.ingestKeepDays` days (default 7). See [Memory](memory.md#1-a-message-arrives).

### The scheduler

The behaviours' clock is an event too. `src/behavior/scheduler.ts` keeps one timer for the earliest of three beats registered in `src/core.ts`:

| Beat | Interval | What it runs |
|---|---|---|
| `diary.tick` | 30 seconds | The diary's day plan, then the sending of what the diary's mirrors hold queued |
| `board.reap` | `board.reapSeconds` (default 60) | The board's reaper |
| `inner.tick` | `wakes.tickSeconds` (default 60) | The inner life's tick |

Each interval is read before each wait. A wait ends in a `scheduler.tick` event submitted through the door, and the door's handler starts every beat that is due without waiting for it. A beat that throws is logged and the others still run. The housekeeping timers are plain intervals in `src/core.ts` and not beats: the store flush, the memory database tick, the flush of the intention and errand stores, the embedding and avatar queues, the metrics and usage saves, the memory probe check, the archive drain and the hourly affinity decay.

## The pipeline

A `message.received` event enters the message pipeline. `createMessageHandler` in `src/behavior/pipeline.ts` builds the topic modules of `src/pipeline/` once, and `src/pipeline/handle-message.ts` takes each message through these steps:

1. The filter ignores bot messages, system messages, empty messages and the persona's own messages.
2. A direct message goes through the private-chat gate (`src/pipeline/private-gate.ts`, `src/behavior/private.ts`). It needs `private.enabled`, server membership, a profile and a passing affinity check.
3. Trigger detection (`src/behavior/mention.ts`) decides whether the message is a mention, a reply, a name trigger or a follow-up to an earlier exchange. An address classifier on the `analyzer` role with `prompts/address.md` (`src/pipeline/address-classifier.ts`, `src/pipeline/follow-up.ts`) decides the ambiguous cases.
4. When the persona is already answering someone, a new call goes into the pending queue (`src/pipeline/pending-queue.ts`), which `src/pipeline/drain.ts` works off after each turn. One turn runs at a time across the whole server, and calls are answered in order, up to `mention.maxPending` (default 6). A new message about something already waiting is folded into that pending item.
5. A call that passes the queue starts a turn.

A message that arrives while the core is paused is written with its whole event in `ingest.held` and replayed once at `/resume` (`src/behavior/core-pause.ts`).

An authenticated command-line message reaches the turn as an internal execution context, carried beside the event (see [Audiences and visibility](memory.md#audiences-and-visibility)).

## A turn

`src/behavior/turn.ts` runs a turn through the phases in `src/turn/phases/` (preflight, context, request, response, tool round, act and outcome). They fall into four stages.

**Collect.** The turn gathers channel history, memory profiles, the persona's recent participation on other channels, media descriptions from the `vision` and `video` roles, lorebook entries the transcript matches, and recall hits from the automatic prefetch.

**Build.** `src/behavior/prompt.ts` assembles one request under the token budget, in the priority order of "Prompt assembly" below. `src/llm/budget.ts` trims what does not fit, lowest priority first.

**Call.** The request goes to the model through `src/llm/openrouter.ts`. `src/llm/parse.ts` parses the answer for the output tags of `prompts/format.md`: `<msg>`, `<react>`, `<draw>`, `<gif>`, `<call>`, `<skip/>` and the others.

**Act.** Messages go out with a pause proportional to their length, a typing indicator and short messages in sequence (`typing.*`). Reactions land on the message they answer. Drawings go through the image client. Tool calls enter the tool loop.

Every request of the core and of the memory writer passes `archivedLlm` (`src/llm/archive.ts`), which writes it to the `model_requests` table before it goes out and closes the row with the answer, so a turn's full request, its whole `<think>` and its tool calls stay readable (see [The request archive](memory.md#the-request-archive)). The journal stores the whole think of a turn, and the next request in the same place carries at most one previous think, younger than 30 minutes (`src/behavior/previous-think.ts`).

## The tool loop

Her granted tools appear in the request as native tool definitions, or as a `<tools>` text block when `tools.transport` is `text` (default `native`). Each call passes the tool gateway (`src/tools/gateway.ts`), which checks access, validates the arguments against the tool's schema, and checks the requester's rights and the budget. With `tools.safeMode` on, only the tools behind the reply tags pass.

After the calls of one answer run, their results come back in another request. The loop runs at most `tools.loop.maxSteps` further requests (default 3), for at most `tools.loop.timeBudgetMs` (default 20000) from the first call, with at most `tools.loop.maxCallsPerStep` calls per answer (default 4). The first request leaves `tools.loop.stepReserveTokens` tokens (default 6000) for the follow-ups. A call that runs past `tools.callTimeoutMs` (default 120000) ends `unknown`, and a result shows at most `tools.resultMaxChars` characters of data (default 4500). When the step or time limit runs out, the current answer is her last.

The tools are defined in `src/tools/definitions.ts` and cover messages, reactions, drawing, voice, web search, memory reads, conversation reads, errands, intentions, config, media, executable skills and more. Each maps to an operation in `src/tools/impl/`, and each has a declared effect (`read`, `write`, `destructive`, `administrative` or `paid`, `src/tools/impl/effects.ts`) that the gateway enforces. A few operations are never grantable to her (`NOT_GRANTABLE_TO_PERSONA` in `src/tools/access.ts`).

`conversation.read` reads a span of one channel, from the record first and from the interface's history when the record lacks it (`src/tools/conversation-read.ts`). In an ordinary turn it reads the current conversation and the channels a pull check allows. In the owner's internal turn it reads every stored conversation in that conversation's own community, and the turn's publication stays restricted to its origin conversation (`src/turn/in-turn-tools.ts`).

## Prompt assembly

`buildRequest` in `src/behavior/prompt.ts` builds a system message (the character-agnostic rules, the character card, the owner's corrections, the output format) and a user message of context blocks ordered for the provider's prompt cache. The block builders live in `src/turn/request/`, one module per group of blocks, and `src/turn/request/sections.ts` lists the budget sections.

The input budget is `floor(llm.maxRequestTokens * 0.9)` tokens (`SAFETY_MARGIN` in `src/llm/budget.ts`, `llm.maxRequestTokens` default 50,000). It is spent in this priority order:

1. The system prompt, the task text, the clock, tempo and the interlocutor's current state. Never cut.
2. Memory about the trigger's author.
3. What the persona looked up this turn, from the web, from the server's history, or both.
4. Server patterns, what the persona has said about herself, and matched lorebook entries.
5. The server's channel map.
6. The channel transcript, newest messages first, and another channel pulled into the turn.
7. The anchored window, the older lines of the current channel that matter.
8. Recent lines and recent moments of the people present.
9. The persona's own exchanges on other channels.
10. Memory about the other people in the transcript, and the members she feels most strongly about.
11. Neighbouring channels.
12. The server's custom emoji.
13. The GIF library.
14. The current state of people in voice that the request has no profile for.

A diary post adds its own sections (see [Diary](diary.md)). What does not fit is trimmed from the bottom of the list.

### Cache layout

The user message is split into three text parts, stable to per-turn. The stable part holds what changes only with the config: senses, her tools in text form, self-facts, chat patterns, GIFs and the people directory. The profiles part holds the interlocutor's profile alone. The tail holds everything else: other people's profiles, current states, the transcript, the clock, per-turn senses, tempo and the task text, where the model attends most. The order is laid out for the cache and is not cosmetic. `withCacheMarker` in `src/llm/openrouter.ts` is the one place cache markers are set, for the roles in `llm.cache.roles` (default `core`) on models with a prefix in `llm.cache.models`, with the lifetime `llm.cache.ttl` (default `1h`).

## Model roles

Every request goes out on a named role, and each role has its own model. The roles sit in three groups in config (`models.base`, `models.errands`, `models.development`):

| Group | Roles | What they do |
|---|---|---|
| `models.base` | `core`, `memory`, `analyzer`, `vision`, `video`, `embedding`, `speech`, `drawing` | The persona's own requests. The core speaks, the memory role runs her memory session, and the others classify, describe, embed, speak and draw |
| `models.errands` | `scout`, `server` | The errand agents, run through a separate runner |
| `models.development` | `thinker`, `dev` | The development agents, working on the repository outside the engine |

`core`, `memory`, `analyzer` and `embedding` are mandatory: `config/config.json` ships a model for each, and the settings check refuses a `null` for one. `vision`, `video`, `drawing` and `speech` ship as `null`, which turns the role off (see [Optional roles that are off](media.md#optional-roles-that-are-off)). `roleOn` and `offRoles` in `src/llm/roles.ts` answer which are on.

A role never borrows another role's model. A mandatory role whose key is unset uses its own built-in default (`ROLE_DEFAULTS`). An optional role whose key is absent from the config counts as on with its built-in default, and a `null`, `false` or empty string is off. `models.byPurpose` pins a single purpose to a model of its own whatever its role. Quick web search has a request role of its own, `search`, with the model `web.search.model` (default `openai/gpt-6.1-sol`).

### Keys

A deployment with a `keys.json` in the private folder takes its keys from the key store, and the rest of this section describes the path used while the file is absent (see [Keys](keys.md)).

`OPENROUTER_CORE_KEY` is the main key. `llm.keyByRole` maps a role to the name of its own key variable, or to a list of names with the primary first. The shipped config binds `scout`, `server` and `drawing` to `OPENROUTER_ERRAND_KEY`, `thinker` and `dev` to `OPENROUTER_DEV_KEY` and `memory` to `OPENROUTER_MEMORY_KEY`. The errand and development roles never go out on the main key, and with `OPENROUTER_MEMORY_KEY` unset the memory session is not configured.

A role with two or more keys is on one of them at a time, kept in memory by `src/llm/key-failover.ts`. The core has such a list without any setting when `OPENROUTER_CORE_BACKUP_KEY` is set. A request that gets HTTP 402, or 429 whose body names credits or balance, moves the role to the next key and is sent again once on it. After the last key the role goes back to the first. When every key of the list failed within a minute, the request fails with the code `keys-exhausted` and `src/llm/role-health.ts` marks the role down until 00:00 UTC. Other statuses leave the key alone. The `llm: key switched` log line carries the role, the two variable names and the status, never a key. A request in the hedge path (`llm.hedge`, roles `analyzer` by default) does not fail over.

The `llm: usage` line names the variable of the key a request used (left out for the main key), and the usage unit keeps the spend per key name. `llm.keys.<VARIABLE_NAME>` gives a key a grant in dollars and a reset day of the month, and `src/llm/key-grants.ts` computes a key's balance as the grant minus the spend since the last reset. Her wake view shows one line of the core keys' summed balances (see [Prompt contract](prompt-contract.md)). `/status` names the key each listed role runs on, when it last switched, each core key's balance and the keys with no grant.

## Web search and page reading

The code lives in `src/web/` (the clients) and `src/tools/tools.ts` (the tool wrappers). `web.search` and `web.read` are tools in the tool loop. `web.search` returns the results raw (title, URL, site, snippet, date) with no summary request. `web.read` fetches one page through the SSRF-guarded fetcher (`src/web/fetch-page.ts`) and returns its extracted main text, cut at `PAGE_READ_CHARS` (4,000 characters) in `src/web/lookup.ts`. With `web.search.enabled` false, `web.search` leaves her tool list and her senses point her to the scout.

Only the diary's search is condensed. A request on the `search` role with `prompts/search-summary.md` turns the numbered results into one note with inline sources, at most `SEARCH_SUMMARY_CHARS` (900 characters).

`web.search.engine` picks the engine:

| Engine | How it searches |
|---|---|
| `brave` (default) | The Brave Search API (`src/web/brave.ts`). Needs `BRAVE_SEARCH_API_KEY` |
| `exa` | Exa's public MCP endpoint (`src/web/exa.ts`). Works without a key, and `EXA_API_KEY` is optional |
| `openrouter` | OpenRouter's web plugin on Exa. One request on the `search` role searches and answers, billed to credits, and the sources are the answer's `url_citation` annotations |

`web.search.fallback` lists engines to try in order when one fails with `rate-limited`, `timeout` or `network`. A search that returns nothing (`empty`) is not retried.

A link in a message is read as the message arrives. The excerpt is the opening of the page's own extracted text, cut at `LINK_PREVIEW_CHARS` (700 characters), with no model request ([Media](media.md#links)). Search results are cached for `web.search.cacheHours` (default 24) and page reads for `web.links.readCacheHours` (default 6). Every request that needs a model counts against `llm.maxRequestsPerDay`.

A scout errand (`errand.run` with the scout agent, see [Errands](errands.md)) runs asynchronously in a separate process and can research in several steps, fetch media and files and bring back attachments. The in-turn tools run synchronously and cost one search or one page.

## The task board

The task board (`src/board/`) holds the development tasks, her errands and their history in `memory.db`, beside her memory and apart from it (see [Memory](memory.md#the-task-boards-tables)). `openBoard` takes the memory database's connection, the private directory and the board's settings. `Board.call(principal, op, args, idempotency)` runs one operation, such as `task.add`, `task.claim` or `task.submit`, in one transaction. A mutation that carries an idempotency key answers the same for 24 hours. `Board.reap` returns the tasks whose lease expired to `approved`, and the core calls it on the `board.reap` beat. Roles, settings, costs, restore and import are in [The task board](board.md).

The state machine is data in `src/board/machine.ts`: eleven statuses from `proposed` to `done`, and for each move the roles that may make it and what it requires. A principal's roles come from its `boardRoles` in `clients.json` (see [Configuration](configuration.md#clients-and-their-tokens)), read at every call. The board derives `holder`, `requester` and `answerer` per task. `owner` holds every right of `reviewer`, and a reviewer approves a plan only at low risk and merges once CI is green, never claiming a task itself. A principal with no board role is refused every operation with `forbidden`, and a `watcher` reads and files a task and nothing else. A board that is not at its schema version answers `board-unavailable`.

A claim raises the task's `lease_generation` and answers it, and `Board.reap` raises it again when it takes back an expired lease. The holder's calls `task.heartbeat`, `task.result`, `task.ask`, `task.block`, `task.submit`, `task.release` and `attempt.end` take that `generation`. A generation other than the task's is refused `stale-lease` before the board checks the status or writes anything, so a worker that lost its lease to the reaper changes nothing. `Board.call` accepts a holder call without a generation, and the socket does not (below). A lease handed back after an answer or after `changes` keeps its generation, and `task.orient` shows it to the holder.

`task.block` moves the holder's task to `blocked` with a `reason` and `unblocks`, what would let the work go on, and ends the lease. Only the holder blocks. `task.unblock` by the owner or a reviewer takes a `note`, writes it as a comment and moves the task to `approved`. A blocked task is never ready and cannot be claimed, and it is cancelled like any open task.

`task.submit` by the holder records the work in one `board_results` row of kind `handoff` and moves the task to `needs_validation`. The handoff is a JSON object with a non-empty `result` and four lists that default to `[]`. `evidence`, `artifacts` and `open_issues` hold strings, and `tests` holds `{ command, passed, failed }` entries with a command and non-negative integer counts. Any other key is refused `invalid`. A submitting `task.result` of kind `pr`, `diff` or `summary` writes a handoff as well, with the body as its result, or the uri when there is no body, and the uri as its one artifact. `task.show` returns the latest handoff as `handoff`.

`task.review` decides on a task in `needs_validation`. `accept` moves it to `done` under the merge rule above. `changes` needs a `comment`, writes it on the task and hands the lease back to the principal who submitted. Each review writes a `board_reviews` row of scope `merge`. A reviewer never reviews a task it filed, and a principal holding `persona` never reviews a task filed for the persona, even when it holds `owner` as well. The owner reviews its own filings. `task.approve` with scope `merge` works beside `task.review`.

`task.add` with a `parent` files the task as a child, a `parent-child` row in `board_dependencies`. A child never holds up its parent's claim. The parent's move to `done`, by any route, is refused `blocked` while one of its children is open.

`task.orient` answers the caller with four lists: the tasks it holds with their generations, the tasks it blocked, the tasks in `needs_validation` it may review, and the unanswered questions addressed to it. A `watcher` gets four empty lists.

### The board on the core's socket

The core opens no board of its own. Each board write is a write of kind `board` of the memory writer (`src/board/writer.ts`), which runs it whole on the writer's connection with the core's clock, the live `board.*` settings and the private directory's `clients.json`. The board's agents reach it over the core's socket. A client of kind `agent` says hello under `agent` and sends `command.requested` events named `task.*`, and the link answers any other event or command of it `invalid` (`src/interface/link.ts`). `src/interface/neptunia-cli.ts` runs each such command under the client's name through `src/board/commands.ts`, so the board's own rights decide it, and it answers while the core is paused. A `task.*` command of the `cli` client goes the same way under that client's `boardRoles`. `neptunia task` sends these commands from a shell (see [The neptunia command](cli.md#the-task-board)).

A board op whose name starts with `task.` is the command of the same name. Every other op takes the prefix: `task.attempt.start`, `task.attempt.end`, `task.run.start`, `task.run.end`, `task.costs.agents` and `task.outbox.pull`. Two arguments belong to the command layer and never reach the board. With `json: true` the answer's text is the JSON of its data, otherwise the plain lines of `src/board/text.ts`. `idempotency` is the key of `Board.call`. A refusal answers the board's error code with its message.

Over the socket a holder call must carry its generation. `task.heartbeat`, `task.release`, `task.block`, `task.submit` and `task.attempt.end` always need it, and `task.result` and `task.ask` need it when the caller holds the task's lease. A call without it is refused `invalid` before the board is called.

`task.next` with a `lane` (default `dev`) and a `role` claims the first ready task of that lane triaged for that role, by priority, then age, then filing order, and answers it with its generation. A task another caller claimed between the list and the claim is passed over. The whole command is one write, so of two agents asking at once for the one ready task only one gets it. With nothing ready it answers `ok` with no data and writes nothing. It holds back a task that waits for its brief: some client of `clients.json` holds `reviewer`, the task's latest attempt ended `needs_answer`, and one of its questions was answered at or after that end by a principal without the `reviewer` role. The wait ends when a reviewer comments on the task or updates it, or once `board.briefWaitMs` (default `1800000`) has passed since the answer. `task.events` with `from` (default `0`) and `limit` (default and most `1000`) answers the events after that sequence number.

The reaper is the scheduler beat `board.reap`. A lease that expired while its worker was cut off goes back to `approved` at the next beat with its generation raised, so the worker's late heartbeat or submit is refused `stale-lease`.

Her tools `board.propose` and `board.status` (`src/tools/impl/board.ts`) call the board as the builtin principal `persona`, whose only board role is `persona` whatever `clients.json` says of that name. `board.propose` files a `dev` task in `proposed` with her evidence as its description and `persona:self` as its requester and subscriber. `board.status` reads every task filed for `persona:self` with its questions and reviews. She never approves, reviews or merges, and the tracked `config.json` grants neither tool to her. A proposal of `kind` `skill` or `fix` carries its examples, benefit and evaluation case ([Skills](skills.md)). A refusal reaches her as `forbidden` or `board-unavailable`.

Her errands are tasks of the board's errand lane, written by the errand store as the builtin principal `core` (see [Errands](errands.md#where-errands-are-kept)). A principal whose only board role is `errand-runner` sees only the errand tasks of its own name.

`scripts/memory-db.ts board list` and `board show <id>` read the board with the core up or down, and `board verify-errands` compares the errand archive with the board.

## Safety rails

Two limits cannot be turned off.

1. No request larger than `llm.maxRequestTokens` (default 50,000 tokens) leaves the process. `src/llm/budget.ts` trims to fit and `src/llm/openrouter.ts` refuses what is still too large.
2. No more than `llm.maxRequestsPerDay` requests (default 5000) go out per UTC day, so a spam of mentions cannot burn the budget.

Both reach the persona through the turn result as a `token-limit` or `daily-cap` code. When she was asked directly and a rail refuses, one plain limit notice is posted in the wording of `labels.limits.notice` in `config/labels.json`, so the person knows what happened.

### How failures reach the persona

Every action the persona takes is answered by a result, the interface port's contract. The status is `ok`, `failed`, `unknown`, `unsupported` or `forbidden`. A failed drawing, a refused tool call and a daily cap are all reported this way, and the tool loop shows her each call's result so she can decide what to do next. The port the core hands to her turns, wakes and tools is guarded (`guardMirrorPort` in `src/behavior/mirror.ts`): a send to a place of an enabled diary mirror goes nowhere and fails with the code `diary-mirror`. Only the diary's mirrors hold the interface's own port.
