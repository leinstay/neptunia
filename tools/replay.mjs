#!/usr/bin/env node
// Operations tool. One purpose: replay a real or a scheduled turn of the
// engine without side effects, with the working tree's code, prompts and
// memory, and print what the persona would do now and what her request looked
// like. Five modes:
// - a message: one real message answered again (or its splitter, its server
//   search, or the request a journal turn sent);
// - a pair of prompt layers (`--pair`): the same triggers answered with two
//   prompt directories, on a blind sheet;
// - a diary brief (`--diary`): the diary's scheduled turn run in the diary
//   channel, its plan and drawing brief reported;
// - a diary day (`--diary-day`): a whole seeded day plan of the diary, each
//   slot's turn run to the end with nothing posted, every drawing call recorded;
// - skill scenarios (`--skills`): an invented request put to the persona
//   after a real chat, with her tools sent as a live turn sends them, to see
//   whether she calls one or declines; her calls pass the real gateway and
//   never run (writes and paid effects are answered canned), but her reading
//   tools (web.search, memory.search) do run, read only;
// - a pair of transports (`--pair-transport`): the same triggers answered with
//   the native tool-calling transport (A) and the text one (B), on a blind sheet;
// - a loop run (`--loop-triggers`): real triggers answered on one transport,
//   every step of the turn recorded (calls, held speech, tokens, latency);
// - an inner turn (`--inner`): one turn of her inner life (src/behavior/inner.js) built
//   from the live data and run in shadow, her proposed actions reported.
// Exists so a prompt or profile change can be checked against real moments
// before it is deployed.
//
// Not for: measuring what her memory session writes (tools/memory-session.mjs);
// reading the journal's day numbers (tools/journal-report.mjs).
//
//   cd /opt/neptunia/app && node tools/replay.mjs <channelId> <triggerMessageId>
//        [--before 40] [--samples 1] [--show-request] [--as-of-moment]
//        [--hide-self <substring>]... [--hide-self-all] [--snapshot <dir>] [--spend <usd>]
//   cd /opt/neptunia/app && node tools/replay.mjs <channelId> <triggerMessageId> --split
//        [--text "<candidate text>"] [--before <split.contextMessages>] [--samples 3] [--spend <usd>]
//   cd /opt/neptunia/app && node tools/replay.mjs <channelId> <triggerMessageId> --recall
//        [--text "<candidate text>"] [--before <context.channelMessages - 1>] [--budget <ms>] [--show-request] [--spend <usd>]
//   cd /opt/neptunia/app && node tools/replay.mjs --pair <promptsDirA> <promptsDirB>
//        (--triggers <file> | <channelId> <triggerMessageId>) [--before 40] [--as-of-moment]
//        [--snapshot <dir>] [--out <dir>] [--spend <usd>]
//   cd /opt/neptunia/app && node tools/replay.mjs --show-request <turnId> [--steps] [--snapshot <dir>] [--before 40] [--as-of-moment]
//   cd /opt/neptunia/app && node tools/replay.mjs --diary <selfPicture|picture> [--count 1] [--topic "<text>"]
//        [--prompts <dir>] [--out <file>] [--spend <usd>]
//   cd /opt/neptunia/app && node tools/replay.mjs --skills <scenarios.json>
//        [--prompts <dir> | --pair-prompts <dirA> <dirB>] [--out <dir>] [--before 40]
//        [--as-of-moment] [--snapshot <dir>] [--dry] [--core-tools] [--transport native|text] [--spend <usd>]
//   cd /opt/neptunia/app && node tools/replay.mjs --pair-transport
//        (--triggers <file> | <channelId> <triggerMessageId>) [--before 40] [--as-of-moment]
//        [--snapshot <dir>] [--out <dir>] [--spend <usd>]
//   cd /opt/neptunia/app && node tools/replay.mjs --loop-triggers
//        (--triggers <file> | <channelId> <triggerMessageId>) [--transport native|text] [--before 40]
//        [--as-of-moment] [--snapshot <dir>] [--out <dir>] [--spend <usd>]
//   cd /opt/neptunia/app && node tools/replay.mjs --diary-day [--seed <text>] [--date YYYY-MM-DD]
//        [--draw fake|live] [--max-pictures <n>] [--out <dir>] [--spend <usd>]
//   cd /opt/neptunia/app && node tools/replay.mjs --inner <intention_due|errand_deadline|review|heartbeat>
//        [--intention <id> | --review] [--snapshot <dir>] [--show-request] [--samples n] [--prompts <dir>] [--out <file>] [--spend <usd>] [--answers-dir <dir>]
//
// `--inner <kind>`: the inner turn the scheduler would run for one wake, against the live data
// (or `--snapshot`) read only: `--intention <id>` names the intention of an `intention_due` or
// `errand_deadline` wake (required for those), `--review` (or the kind `review`) the day's
// review, in the channel she was last active in (the review's stored channels, else her own
// lines of the last `innerLife.review.historyDays` in the record). Its `<wake>` carries what is
// left of her caps as data/guilds/<id>/inner.json has them now. The real turn runner over
// Discord REST (GET only, every write refused), an in-memory port and an unflushed copy of the
// memory store; `innerLife.mode` forced to `shadow`, so her reads run (on the simulator key)
// and every other call is only proposed; features.dryRun and the journal off (a journal read, `memory.journal.read`, answers from the journal of the data read, read only); intentions read
// only (an expiry sweep writes nothing). Prints the request's blocks (`--show-request`: the
// whole request), her answers, her proposed and executed actions, the cost.
//
// `--inner heartbeat`: the heartbeat's turn. The wake is built by the scheduler itself (a real
// src/behavior/inner.js life over a throwaway copy of inner.json, with a turn runner that only
// records the wake and the conversation it was handed), so its `<wake>` is the one the live
// heartbeat would carry now: the heartbeat view over the stores, read only. Takes neither
// `--intention` nor `--review`. Every `--inner` kind takes `--samples n` (n independent runs of
// the same request, one after another, default 1), `--prompts <dir>` (a prompt layer laid over
// the live prompts.local/ as `--diary --prompts` does: a directory holding only heartbeat.md
// replaces only that file, so a variant of the task text is tried without a deploy) and
// `--out <file>` (the report as Markdown; not under data/). The JSON on stdout holds every
// sample: the `<wake>` block, her `<think>`, her messages and calls with their arguments,
// the actions (proposed, executed, refused), the cost; the same report in Markdown goes to
// stderr. `--spend` also stops the samples: none starts when the cost reported so far plus the
// last sample's would pass it.
//
// `--answers-dir <dir> [--answers-first-only] [--answers-timeout-min 20]` (any mode that sends requests): the offline model
// (`--answers-first-only`: only a turn's first answer comes from the files, its tool-loop steps go to the real model,
// so a frozen first answer is continued live).
// Every request to an Anthropic model (`anthropic/claude-*`) is not sent: it is written to
// `<dir>/req-<n>.json` (exact strings: model, purpose, system, messages) and `<dir>/req-<n>.md` (n from 1 per run, 3 digits: the model id and the purpose, then every message
// under `## system` / `## user` / `## assistant`, verbatim) and the run waits (polling, up to the
// timeout) for `<dir>/ans-<n>.txt`, whose content is the model's text (and, optionally, `<dir>/ans-<n>.tool-calls.json`:
// a JSON array of `{ id?, name, arguments }` -- `arguments` an object or a string -- for the answer's native tool calls; a
// request that had tools also lists them, with its tool choice, in `req-<n>.json`) (no cost; the result carries
// `answersDir: { dir, requests }`). `<dir>/done` (`exit <code>`) is written when the run ends. Other
// models still go to OpenRouter. The directory must hold no files of an earlier run. Such a run
// needs no `--spend` (only other models are billed; with `--spend` they are capped as usual).
// The spend gate (tools/lib/cli.mjs#spendGate): every mode that sends model
// requests prints its estimate first (~USD_PER_ANSWER per request: a persona
// answer, a splitter sample, the recall classifier and its summary, a diary
// brief's plan and compose requests, a skill run's answer and its possible
// follow-up, per message of every step of a multi-step scenario -- each may
// get its own turn --, twice with `--pair-prompts`) and refuses, exit code 2,
// without `--spend <usd>` covering it.
// `--skills` also stops once what the provider reports spent (`usage.cost`,
// else the estimate per request) reaches `--spend`.
//
// `--skills <file>`: a JSON array of scenarios (tools/prompts/skill-scenarios.example.json
// shows the shape; parseScenarios checks it), each `{ id, channelId, before?,
// author, text, grants, runs?, result?, discovery? }` (or `steps` or
// `taskResult` for `author` and `text`, see below). For each one: the last
// `--before` messages of the channel up to and including the message `before`
// names (omitted: the newest ones), fetched and normalized as in the message
// mode; then `text` as a new message by the member `author` (their real
// profile and attitude), one minute after that message (now, without
// `before`), calling the persona by a tag (a `mention`, no reply). The
// persona's grants are exactly `grants` in a copy of the config (never
// written; src/behavior/sandbox.js#personaGrantsConfig): skill names, groups
// and `*` expanded as `/nep access grant` expands them for her
// (src/ops/access.js#expandPersonaGrant: a group or `*` is its read skills); a
// name no grant opens for her is kept, so the gateway refuses it as live.
// An errand (`task.run`) passes the gateway's budget exactly as live: the
// open tasks against `agents.maxOpen` and today's tasks and dollars against
// `agents.<agent>.daily` (agents.scout, agents.server; the profile's defaults
// under them), from the guild's data/guilds/<id>/tasks.json of the data read
// (--snapshot's when given) and the config, read only
// (sandboxErrandBudget, src/errands/store.js#budget); nothing is ever queued.
// Her `<skills>` block is the catalogue of that requester as the live turn
// lists it (src/behavior/sandbox.js#scenarioInventory): whole, as after
// `skills: inventory` (`discovery` "inventory", the default), the named ones
// (`discovery` a list of up to four names, as after `skills: <names>`), or
// none ("none"). Answered `runs` times (1..10, default 1) in the sandbox
// (src/behavior/sandbox.js#answerSkillScenario). A tool call is resolved and
// checked as live (#simulateCall: src/skills/executors.js#resolveCall over
// the guild's channels, roles and stored members, src/skills/gateway.js#checkSkill
// with the requester's real role ids, the image quota read from a copy of
// the state); the operation never runs: a call that passed is recorded and
// answered `ok` with `result` (the text an operation would have answered,
// '' when omitted); a refusal is answered as live. Whether a request follows
// is the step engine's decision over the results (below), not the scenario's.
// A multi-step scenario has `steps` instead of `author` / `text` (parseScenarios:
// each `{ author?, text?, gapMinutes?, burst?, result? }`): each run replays
// every step from the start. A step's message, then its `burst` (more messages,
// each by its own real author, 5 s apart), joins the channel `gapMinutes`
// (default 1) after the newest line so far. The step's own message tags the
// persona (a `mention`); a burst's message calls her only as a live message
// would -- her tag `<@id>` in its text, one of `bot.nameTriggers` as a whole
// word, read by the live classifier (src/behavior/mention.js#detectTrigger,
// each switch as live) -- and is otherwise a plain follow-up the address
// classifier said yes to (it is not asked). The step is then played as the
// live queue plays it (src/behavior/sandbox.js#burstTurns, playSteps): the
// first message starts her turn; every call after it waits for its own turn,
// in arrival order (the cap `mention.maxPending` drops the oldest waiting);
// the plain follow-ups share the channel's one follow-up slot, a newer one
// replacing the older (`replaced`; live, a missed-answer candidate). Each turn
// is one decision answered exactly as a single-turn run (the same request
// builder, gateway, fake executor and follow-up; the step's `result`, else
// the scenario's) over every message of the step, at the newest line so far,
// its trigger's author the requester and its trigger kind as live; the calls
// still waiting are named in its task as a live turn names them
// (`labels.task.queued` for the author's own, `labels.task.queuedOthers` for
// another member's). Not played: the ignore rolls, the merge classifier, a
// follow-up's window. What she did in a turn is carried into the channel the
// next turn and step read (src/behavior/sandbox.js#afterScenarioTurn): her
// messages of both passes as her lines, her reactions, a post her call left in
// this channel, and the call's mark as a live transcript shows it (a post into
// another channel leaves only the mark). The memory is the one at the first
// decision for every step; the image quota is not counted down. A step of one
// message is one turn.
// A line of the persona's own is seeded with a step `{ self: "<text>", gapMinutes? }`
// or a burst item `{ self: true, text }`: it joins the channel as if she had said
// it, timed as any message of a step, shaped exactly as her lines carried from a
// turn (src/behavior/sandbox.js#seededSelfLine; no call mark, no link to a
// trigger), and no turn is run for it: no request, no record, no letter in the
// pattern. So a decision can be put after her own question. A scenario needs at
// least one step with a message that is not hers.
// A task-result scenario has `taskResult` instead of `author` / `text` /
// `steps`: `{ agent, goal, state, text?, files?, asker }` (parseScenarios),
// one of her errands ended `done` or `failed` -- what was asked, what it
// brought back, the files it saved (`{ name, contentType?, bytes? }`), the
// member who asked; its origin channel is the scenario's `channelId`. Instead
// of a mention it runs the turn an errand's end opens (src/errands/turns.js):
// one minute after the anchor (now, without `before`), in that channel, an
// interjection of trigger kind `task` (no message of the chat to reply to)
// whose request carries the `<task_result>` block
// (src/errands/blocks.js#taskResultText), the asker its requester. The
// errand is named `t<8 hex>` from the scenario's id (scenarioTaskId) and its
// files by their live handles `file:<task id>/<name>`, which her calls
// resolve to as live (scenarioFileOf; the files are not on disk and nothing
// reads them); a `message.create` with a file handle, its channel and body
// passes the real resolution and gateway and is recorded like any call
// (runs.jsonl's `executed`, the report). Runs, results, follow-ups and the
// report as a single-turn scenario; `--dry` adds the errand's id, whether
// the request holds `<task_result>` and its file count.
// Her turn on the step engine (every `--skills`, `--pair-transport` and `--loop-triggers` turn;
// src/behavior/sandbox.js#runSkillLoop, mirroring src/behavior/turn.js#runSteps): her tools are
// sent with every request as a live turn sends them (src/behavior/sandbox.js#sandboxToolset: the
// skills granted to her and the carried-over ones, as the `tools` field on the native transport or
// as the `<tools>` block and `<tool_call>` blocks on the text one, `skills.transport` or `--transport`);
// her answer is split into speech and tool calls (src/behavior/turn.js#answerOf); each call is
// refused before it runs when unreadable, unknown, cut off or past the step's cap
// (`skills.loop.maxCallsPerStep`), repaired by coerceArgs, and put through the real resolution and
// gateway (loopCall), the reads together, every other call alone in her order; her speech of a step
// stands only when every call worked and its result is an effect or an accepted errand, else it is
// held and never posted; a step that left something to read is followed by one request that appends her
// answer, one result per call and a note to the first messages (nothing rebuilt), up to
// `skills.loop.maxSteps` follow-ups, the last of them final (its calls get `loop-cap` results), and
// `skills.loop.timeBudgetMs`. features.coreTools is only the pre-reply classifiers' switch: on, no
// search classifier runs (no `<skills>` block whatever `discovery` says) and the memory prefetch and the
// server search's senses line stand in every request; off, the search classifier names her skills.
// Her `web.search` and `memory.search` that passed run for real and read only
// (createReplayTools): the web search through the live lookup module and engines on the
// simulator key (its summary request; the media cache and the daily web counter private
// copies, nothing written back), the memory search through the live recall runner over the
// data read (live data/ or --snapshot: its record, archive and vector index iterated, the
// daily recall counter a private copy; Discord's own searches over REST, GET only). Every
// other call, a write or a paid effect (`draw.create` included), is answered canned as above and
// nothing real runs; a `task.run` that passed is never dispatched, only recorded with its agent
// and goal (`errand`). runs.jsonl's line of a run keeps the single-call fields (the first call, the
// first follow-up) and adds `loop`: per step (0 the reply) its calls in order with their verdict,
// result status, code and size, time and the tool's own usage, the calls dropped and why, whether her
// speech was held, whether her text began with her thinking, the arguments read in another type, her
// answer, the request's size, latency, tokens (with the cache reads and writes) and cost; then the
// turn's calls, errands, drawings, posts, posted messages, final messages, counts, latency and
// cost (loopRecord); report.md shows per run the calls in order, the final messages, the
// total latency and cost, then each step. The estimate per decision is loopRequestEstimate (an
// expected count, not a bound: the run stops once the reported cost reaches --spend).
// `--dry` adds the tools' count, tokens and transport, whether `<tools>` is in the first request
// and the loop's bounds.
//
// `--pair-transport`: the same triggers (`--triggers <file>`, as `--pair` reads it, or one as
// positionals) answered twice over the same fetched chat, memory (`--snapshot`,
// `--as-of-moment`) and clock (the trigger's moment), once on the native tool-calling transport
// (A) and once on the text one (B), under the live grants, each as a skill-scenario turn of the
// sandbox (runTriggerLoops). What a live turn runs before her reply is run once and shared: the
// memory prefetch with features.coreTools on, else the search classifier (preTurnLookup: its web
// search on the simulator key, its server search read only, its `skills:` line naming her
// `<skills>`, the `<lookup>` it found). No errand is dispatched. Written to `--out` (default
// ./replay-pair-transport-<time>/, refused when it exists and is not empty) as `--pair`
// writes it: `sheet.html` (every posted message of each side's turn, its reactions, pictures and
// message-call posts, blind and in a random order) and `key.json` (`a`/`b` name the sides; per pair
// `first`, the trigger, both answers with the calls, `runs`: per side the first request's
// estimated tokens, the tools' tokens, the reported tokens and cost, the latency, the calls, the
// turn's counts, `blocks` (which of `<lookup>`, `<skills>`, `<tools>` and the search and recall
// senses lines its request held) and the whole run record, and `shared`: the pre-reply
// requests), which tools/replay-score.mjs tallies.
//
// `--loop-triggers`: the same triggers answered on one side, `--transport native|text` (default:
// `skills.transport` of the config), and every turn recorded. `--out` (default
// ./replay-loop-triggers-<time>/) gets `runs.jsonl` (one line per trigger: the trigger, its mode and
// kind, the chat before it, the counts and the run record with every step -- calls with names and
// statuses, held, thinkMissing, coerced, capped, requests, tokens in and out and from the cache,
// latency) and `report.md`. Its requests carry the prompt-cache marker a live turn has (`--no-cache`: none). With `--answers-dir` give each scenario its own directory and `--out`
// (one trigger as the two positionals), or one directory for a whole `--triggers` file. The old and the
// new side are compared blind by tools/replay-compare.mjs.
//
// `--prompts <dir>`: every scenario answered with `<dir>` laid over a copy of
// the live prompts.local/ (a file of the same name replaces the private one,
// the others stay; labels.json and skills.json deep-merge over the private
// ones as src/hot.js merges its layers). `--pair-prompts <dirA> <dirB>`: every
// scenario answered under both layers, each laid over prompts.local/ the same
// way, over the same fetched chat, config and memory, the same number of
// runs; runs.jsonl lines carry `side` (`A` / `B`) and report.md is the side by
// side one (renderPairReport). The live prompts.local/ is only read.
// Written to `--out` (default ./replay-skills-<time>/, refused under data/
// and when it exists and is not empty): `runs.jsonl` (one line per run --
// per turn of a step of a run for a multi-step scenario, with `step`, and for
// a step of several messages `turn` and `queue`: the turns the step got, its
// trigger's kind, author and text, how many calls still waited, the replaced
// and dropped messages --: decision
// `call` / `no-call` / `malformed-call`, the skill with the arguments she
// wrote and the resolved ones, the gateway's verdict, her visible messages of
// both passes with the members they would mention -- a call's text too, its
// body or a message's `text` attribute (`callMentions`) -- and her whole
// `<think>`, tokens and cost) and `report.md` (a table per scenario: calls,
// runs without a call, refusals; a table of the multi-step ones: each run's
// calls per decision as letters, `CCCN NNNN`, the first step without a call,
// how many runs made a call again after one; then every run, step by step and
// turn by turn with the start of her `<think>`, and per burst which messages
// got a turn and which were replaced or dropped. Under `--pair-prompts`: per
// scenario A's letters against B's (`CCCCCN` vs `CCNNNN`), the first declines,
// then every decision side by side: the call, her messages, the first 300
// characters of her `<think>`).
// stdout: the summary. `--dry`: no model request and no key needed; the
// first request of every scenario is built and its sizes printed.
// THE FILES HOLD MESSAGE CONTENTS: the server's eyes only, like stdout.
//
// Prompt layers (tools/lib/prompt-layers.mjs#promptLayersHot, the one helper
// for every mode that takes a prompt directory): a scratch copy of the config
// files and the tracked prompts/, with directories copied into prompts.local/
// in order and read by src/hot.js as the bot reads its own. `--pair` gives
// each side its directory alone as prompts.local/; `--diary --prompts <dir>`
// lays the directory over the live prompts.local/ (a file of the same name
// replaces it whole, labels.json included); `--skills --prompts` and
// `--pair-prompts` lay it the same way but merge labels.json and skills.json
// (overlayPromptsHot). The live config.local.json and prompts.local/ are the
// private directory's (NEPTUNIA_PRIVATE_DIR, else the checkout; privateDirOf).
// Nothing in the checkout changes. A prompts.local/ (or a
// directory given) that is a link -- a separate checkout linking to the live
// layer -- is read through it and copied as files, never linked to or written.
//
// `--diary <kind>`: `--count` briefs (1..50) of one diary kind, each one
// `runTurn({ channel, mode: 'diary', diary: { kind, [topic], forced: false } })`
// of the real turn runner (src/behavior/turn.js, wired as src/index.js wires
// it) in the diary channel (`diary.channelId`): the plan request on the
// classifier model with the given kind the only one offered (as `/nep diary
// post <kind>` does; `forced: false` keeps the compose request a scheduled
// post's), then the compose request on the voice model. Not the sandbox: the
// sandbox never builds a diary post (src/behavior/sandbox.js#SANDBOX_OMITS).
// `--topic`: the owner's topic as `/nep diary post <kind> <topic>` threads it
// (trimmed, blank is none, then src/behavior/diary.js#diaryTopic). What keeps
// the bot and its memory untouched here: hot is seen with
// `features.dryRun = true` and `bot.dryRunChannelId = ''` (the turn ends in
// its dry-run branch: nothing acted, drawn, recorded or mirrored); every
// Discord REST call but GET is refused and the channel's send / sendTyping
// throw; the store is the real one with an in-memory copy of its state that
// is never flushed (flush, forget, wipe and reload methods throw); the image
// client keeps its quota and refuses to generate; in that in-memory state
// only, today's diary picture and image counts read 0 so the picture gate
// opens. Requests carry `origin: 'replay'` and never count against
// `llm.maxRequestsPerDay`. Output: the briefs `[{ kind, plan, self, request,
// messages, outcome }]` (request = the first `<draw>` scene text, self its
// self flag, messages the post's `<msg>` texts after the diary's filters) to
// `--out <file>` (rewritten after each brief; refused under data/) with a
// summary on stdout, else on stdout. Exit code 1 when no brief drew.
//
// `--diary-day`: one day of the diary as the live diary runs it
// (src/behavior/diary.js#createDiary's tick), for the record of what it would
// draw. The day plan: planDay for the local date `--date` (default today in
// `bot.timezone`) at its local midnight, with no hunger carried in, on a random
// stream seeded by `--seed` (default a fresh one, printed and kept in the
// report): the same config, date and seed give the same slots
// (tools/lib/diary-day.mjs#planDiaryDay). The turns draw from a second stream
// of the same seed. Then, slot by slot in order, the clock of the turn runner
// and the image client set to the slot (and running on from there), the diary's
// own checks as the tick makes them (the day's posts under `diary.maxPerDay`,
// else `skip` with reason `cap`), and `runTurn({ channel, mode: 'diary', diary:
// { kind: null, forced: false } })` of the real turn runner in the diary
// channel: the plan request, its search, the compose request, then the post
// acted to the end -- the single picture or the set generated, as a live post
// is -- into an in-memory interface port (src/interface/fake.js), never into
// Discord. A post a slot made is kept in the in-memory diary and counters, so
// the next slot sees it as the live diary would (not in the chat history, which
// is fetched from Discord). What keeps the bot and its memory untouched: every
// Discord REST call but GET is refused and the channel's send / sendTyping
// throw; the turn's posts go to the in-memory port only; hot is seen with
// `features.dryRun` off (the engine's dry-run branch generates no picture, the
// very thing recorded here), `features.typingSimulation` off and
// `bot.dryRunChannelId` empty; the store is the real one over an in-memory copy
// of its state that is never flushed, with today's diary post, diary picture
// and image counts at 0; no journal and no record are wired; requests carry
// `origin: 'replay'` and never count against `llm.maxRequestsPerDay`.
// `--draw fake` (the default): the image client is the real one
// (src/llm/images.js#createImageGen, its caps and model check) over a fetch that
// answers a 1x1 fixture PNG, so no picture is paid for. `--draw live`: the real
// client on OPENROUTER_SIM_KEY (required: no fall back to the bot's key here),
// at most `--max-pictures` pictures (default 2; past it a picture is refused as
// an image cap refuses it), each written to `<out>/pictures/`. Every
// `generate()` call is recorded at the client's boundary: `{ prompt, reference,
// userId }`, the reference as its media type, size and hash, never its bytes.
// The spend gate: the plan is made first (no request), then the estimate --
// 2 requests per slot (the plan and the compose) at ~USD_PER_ANSWER, plus with
// `--draw live` `--max-pictures` pictures at ~0.025 USD -- and the refusal
// without `--spend` covering it; the run also stops once what the provider
// reports spent reaches `--spend`. A day with no slot sends nothing. Written to
// `--out` (default ./replay-diary-day-<time>/, refused under data/ and when it
// exists and is not empty), rewritten after each slot: `report.json` (`{ date,
// timezone, seed, draw, quiet, plan: { slots, hunger }, slots: [{ n, at, local,
// outcome, reason, plan, diary, messages, attachments, draws: [{ prompt,
// reference, userId, result, file }], requests, cost }], usage, stopped }`) and
// `report.md`. stdout: the paths, the slot outcomes and the usage. Exit code 1
// when a slot ended in `error` or the run was stopped.
//
// `--snapshot <dir>`: the memory is read from a snapshot of data/ (written by
// `/nep memory snapshot`, or an unpacked stop-backup) instead of the live
// data/, read only as ever. The memory is the memory database of that
// directory (its `memory.db`, opened read only by tools/lib/memory-read.mjs);
// the operational files beside it (state.json, inner.json) are read as files.
//
// `--pair <promptsDirA> <promptsDirB>`: the same triggers answered twice, once
// with each prompt layer: each directory is laid over the tracked prompts/
// exactly as prompts.local/ is at runtime (so `--pair prompts prompts` gives
// two identical sides: the harness check, which must score even). The
// triggers: a file of lines `<channelId> <triggerMessageId> [<turnId>]`
// (`--triggers`, tools/lib/pair.mjs#parseTriggers), or one trigger as
// positionals. Both sides share everything else: the fetched chat, the memory
// (`--snapshot`), the clock (the trigger's moment), `--as-of-moment`, the
// config, the model, one sample each. Tool results: the sandbox runs no tool
// (see "Left out" below), so neither side gets any; when a line names its
// `turnId`, the journal's action records of that turn (data/guilds/<g>/journal,
// read only) are copied into key.json so the owner sees which tools the live
// turn ran. Per pair the side shown first is drawn at random. Written to
// `--out` (default ./replay-pair-<time>/, refused when it exists and is not
// empty): `sheet.html` (the blind sheet: each pair's chat, then the two
// answers as "1" and "2", nothing saying which side is which, a choice per
// pair and a button that writes the scores as JSON) and `key.json` (`{ a, b,
// pairs: { <pairId>: { first, channelId, triggerId, turnId, journalActions } } }`).
// tools/replay-score.mjs tallies the scores. stdout: one JSON object with the
// paths, the pair count, the failed pairs and the usage.
//
// `--show-request <turnId> [--steps]`: no model request. Prints the request dumps of
// that turn when the journal kept them (data/guilds/<g>/journal/requests/<day>/
// <turnId>-<attempt>.json, every attempt; `source: 'dump'`; with `--steps` also each
// attempt's later requests, `<turnId>-<attempt>-s<step>.json`: the tool loop's steps and the
// follow-up after a call, each after its base dump); else rebuilds it
// (`source: 'rebuilt'`, with a note saying so): the turn's `turn.start` record
// gives the channel, the trigger message, the mode and the trigger kind; the
// chat is fetched as below and the sandbox request (see "Left out") is built
// with the memory of `--snapshot` (else the live data/), never sent. Without
// a turnId after it, `--show-request` is the switch it always was.
//
// The engine's modules are imported from the current working directory
// (`<cwd>/src/...`), so the same file works wherever it is placed.
//
// What it does:
// - Fetches over REST the trigger and the `--before` messages preceding it,
//   oldest first, normalized exactly as a live history is
//   (interfaces/discord/collect.js#fetchHistoryWindow -> normalizeMessage): ids,
//   authors (display names as the live client resolves them: every author and
//   mentioned member is fetched over REST one by one before the messages are
//   normalized), the persona's own messages marked `self`, reply references,
//   mentions, attachment / embed / sticker labels, reactions. Pictures are
//   never downloaded or described; the describer's cached captions and watched
//   summaries are rendered as the live transcript renders them
//   (src/behavior/sandbox.js#replayMedia, every entry the cache holds now).
// - Answers it in the replay sandbox (src/behavior/sandbox.js#answerReply
//   with `{ history, triggerId, kind, mode }`) at the trigger's time. The
//   trigger kind and mode come from the journal's newest `turn.start` record
//   whose trigger is this message (data/guilds/<g>/journal, read only);
//   otherwise the sandbox guesses: `reply` when the trigger replies to the
//   persona, else `mention`.
// - Memory: the live view (src/behavior/sandbox.js#liveView: data/, the live
//   config.local.json and prompts.local/), except that `<recent>` never shows
//   lines the analyzer added at or after the trigger (they describe what came
//   after it). `--as-of-moment` hides every dated item written at or after
//   the trigger instead (src/behavior/sandbox.js#momentView) and reports what
//   was hidden.
// - `--hide-self <substring>` (repeatable) leaves out of the request every
//   self fact of the guild memory (`getGuild().self`) that contains any given
//   substring (case-insensitive); `--hide-self-all` leaves out every self
//   fact. Either way it works on a copy of the guild memory (the store's own
//   arrays are never touched) and the output reports `hiddenSelf: <count>`.
//   It applies on top of both memory modes above.
//
// `--split`: no reply at all. Sends instead, `--samples` times (default 3:
// the classifier is not deterministic), the very request a live turn's
// splitter sends (src/behavior/turn.js#maybeSplit): system = prompts.split
// (the live layers, prompts.local/ first) with `{{name}}` and `{{maxTasks}}`
// filled; user = the `<transcript>` of the last `split.contextMessages`
// fetched messages before the trigger (src/behavior/prompt.js#classifierTranscript,
// the describer's cached captions when features.mediaDescriptions is on)
// and the `<candidate>` line; on the analyzer model (roleModel) with
// helperRequestOptions (role `analyzer`, `split.maxOutputTokens`,
// purpose `split`); each answer parsed by src/behavior/split.js#parseSplitAnswer.
// `--text "<candidate text>"` replaces the trigger's content (same author,
// same time, same lines before it), so an invented message is tested in the
// real channel's context. `--before` defaults to `split.contextMessages`
// here. The output says whether a live turn would ask at all
// (splitCandidate, labels.task.part); the request is sent either way, so the
// prompt can be tested. Only --text / --before / --samples go with it. No
// cache marker on any of these requests.
//
// `--recall`: no reply either. Reproduces the server search of a live turn
// (src/behavior/turn.js#maybeLookup) for the trigger, or for `--text` in its
// place (same author, time and lines before it, as with --split):
// 1. the search classifier's request, once: system = prompts.lookup with
//    `{{name}}` and `{{today}}` (the trigger's day in `bot.timezone`); user =
//    the `<transcript>` of the last `web.search.contextMessages` fetched
//    messages before the trigger (cached captions with
//    features.mediaDescriptions on, cached video states with video vision on,
//    cached link reads with features.webLookup and web.links on) and the
//    `<candidate>` line; on the analyzer model (roleModel) with helperRequestOptions
//    (role `analyzer`, `web.search.classifierMaxOutputTokens`, purpose
//    `lookup`); the answer parsed by src/behavior/recall.js#parseLookupAnswer
//    at the trigger's time;
// 2. when the answer has a server part, the `run()` of
//    src/behavior/recall-run.js#createRecall with the turn's arguments (the
//    served guild, this channel, the persona's id and name, `history` = the
//    fetched lines, `candidate` = the trigger, `server` = the parsed part),
//    over REST: the member and message searches (interfaces/discord/search.js), the
//    pull rail toward this channel, the windows, the summary request
//    (prompts/recall-summary.md, purpose `recall-summary`). Its clock starts
//    at the trigger's moment (the summary's `{{today}}`, the recent-lines
//    window and the pull rail's age read as the live turn read them);
//    `recall.timeoutMs` is its budget, `--budget <ms>` overrides it. Memory:
//    the live store read only (profiles, lore, learned items; `<recent>`
//    without the lines added at or after the trigger); the daily recall
//    counter is a private copy (the store's is never bumped), and nothing
//    runs when `recall.maxPerDay` is already spent today on the real counter.
// The windows (`clusters`), the stored notes (`memory`) and the number of the
// stretch the summary named are read back from the summary request as sent
// (its `<memory>` and `<found>` blocks), so they are exactly what the summary
// saw; a line of a message with line breaks is shown with the message line
// before it (a gap or date marker too: the text cannot tell them apart). With no summary request (skipped for
// lack of time, or nothing found) there are no clusters to show. Also
// printed: every Discord search with its query and hit count, the hits per
// channel with the pull rail's verdict, whether the run's deadline fired,
// and whether the classifier plus the search would have come in after the
// turn's `pace.prepareSearchMs` (`late`; a live turn's history fetch and file
// previews are not counted). `--before` defaults to `context.channelMessages`
// - 1 (the live history, the trigger included): the search never looks past
// the oldest line of that chat. `--show-request` adds both requests. Left
// out, unlike a live turn: file previews in the transcript, the web search
// (the classifier's `web` line is printed, not run), a routed call, a private
// chat; no prompt-cache marker. Exit code 1 when the classifier fails or the
// run is stopped.
//
// Left out, unlike a live turn (the sandbox does none of it): no web search
// or link reading, no server recall, no pictures sent to the model, no
// neighbouring channels or pulled channels, no variety pass (`<worn>`), no
// owner-forced text, no private chat, no line on where a read-only channel's
// call is answered. `<senses>` still says whether a web search could run
// (the lookup's hasSearch() for web.search.engine: `brave` needs
// BRAVE_SEARCH_API_KEY, `exa` and `openrouter` no key), as a live turn's
// does; no search is run (but for her own in-turn tools under the tool loop, above).
//
// What keeps the running bot undisturbed: no gateway session (a discord.js
// Client that never logs in, its token on REST only); the memory store is the
// real one behind a wrapper that passes only the sandbox's read methods and
// refuses every write; the llm client counts on an in-memory copy of the
// daily counters and every request goes out with `countAgainstDailyCap:
// false`, `skipCalibration: true`, `origin: 'replay'`; with one sample no
// prompt-cache marker is sent at all (a cache write would cost more and serve
// nothing). `--recall` sends Discord's own searches (GET only) and reads the
// media cache through a private copy. Nothing is written anywhere and nothing
// is posted.
//
// Output: every log line (the engine's JSON lines included) goes to stderr;
// stdout carries exactly one JSON object. THIS TOOL PRINTS MESSAGE CONTENTS
// AND MEMORY ABOUT REAL PEOPLE (the answers, the `<people>` block, the lines
// the server search found and, with `--show-request`, the whole request): it
// is a diagnostic for the owner's
// and the lead's eyes on the server; never paste its output into a commit, an
// issue or a chat. It never prints a token. Exit code 0 on success, 1 on any
// error (the message on stderr). Ctrl-C once stops the sampling; twice exits.

import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
// CliError: an operator-facing failure, printed as is, exit code `exitCode` (1 unless the spend gate refused: 2).
import { createAnswersDir, withAnswersDir, ANSWERS_TIMEOUT_MIN } from './lib/answers-dir.mjs';
import { simKey, CliError, REFUSED_EXIT, defaultDataDir, privateDirOf, resolveGuildId, spendGate } from './lib/cli.mjs';
import {
  DRAW_MODES,
  DEFAULT_LIVE_PICTURES,
  MAX_PICTURES,
  diaryDayEstimate,
  fixtureImagesFetch,
  isDateKey,
  planDiaryDay,
  recordingImages,
  renderDiaryDayReport,
  seededRng,
} from './lib/diary-day.mjs';
import { pairOrder, parseTriggers, renderSheet } from './lib/pair.mjs';
import { promptLayersHot } from './lib/prompt-layers.mjs';
import { readOnlyMemory } from './lib/memory-read.mjs';
import {
  conversationOfChannel,
  conversationRef,
  discordReads,
  guildListing,
  hiddenReads,
  onPlatformChannel,
  requesterOfChannel,
} from './lib/platform-objects.ts';

export { guildListing, hiddenReads, requesterOfChannel, roleIdsOf } from './lib/platform-objects.ts';

/** The memory of a data directory, read only (tools/lib/memory-read.mjs), one per directory for the whole run. */
const memories = new Map();
function memoryFor(dataDir) {
  if (!memories.has(dataDir)) memories.set(dataDir, readOnlyMemory(dataDir).memoryDb);
  return memories.get(dataDir);
}

const USAGE =
  'usage: node tools/replay.mjs <channelId> <triggerMessageId> [--before 40] [--samples 1] [--show-request] [--as-of-moment] [--hide-self <substring>]... [--hide-self-all] [--snapshot <dir>] [--spend <usd>]\n' +
  '       node tools/replay.mjs <channelId> <triggerMessageId> --split [--text "<candidate text>"] [--before <split.contextMessages>] [--samples 3] [--spend <usd>]\n' +
  '       node tools/replay.mjs <channelId> <triggerMessageId> --recall [--text "<candidate text>"] [--before <context.channelMessages - 1>] [--budget <ms>] [--show-request] [--spend <usd>]\n' +
  '       node tools/replay.mjs --pair <promptsDirA> <promptsDirB> (--triggers <file> | <channelId> <triggerMessageId>) [--before 40] [--as-of-moment] [--snapshot <dir>] [--out <dir>] [--spend <usd>]\n' +
  '       node tools/replay.mjs --show-request <turnId> [--steps] [--snapshot <dir>] [--before 40] [--as-of-moment]\n' +
  '       node tools/replay.mjs --diary <selfPicture|picture> [--count 1] [--topic "<text>"] [--prompts <dir>] [--out <file>] [--spend <usd>]\n' +
  '       node tools/replay.mjs --skills <scenarios.json> [--prompts <dir> | --pair-prompts <dirA> <dirB>] [--out <dir>] [--before 40] [--as-of-moment] [--snapshot <dir>] [--dry] [--core-tools] [--transport native|text] [--spend <usd>]\n' +
  '       node tools/replay.mjs --pair-transport (--triggers <file> | <channelId> <triggerMessageId>) [--no-cache] [--before 40] [--as-of-moment] [--snapshot <dir>] [--out <dir>] [--spend <usd>]\n' +
  '       node tools/replay.mjs --loop-triggers (--triggers <file> | <channelId> <triggerMessageId>) [--transport native|text] [--no-cache] [--before 40] [--as-of-moment] [--snapshot <dir>] [--out <dir>] [--spend <usd>]\n' +
  '       node tools/replay.mjs --diary-day [--seed <text>] [--date YYYY-MM-DD] [--draw fake|live] [--max-pictures <n>] [--out <dir>] [--spend <usd>]   (cwd: the bot directory)\n' +
  '       node tools/replay.mjs --inner <intention_due|errand_deadline|review|heartbeat> [--intention <id> | --review] [--snapshot <dir>] [--show-request] [--samples n] [--prompts <dir>] [--out <file>] [--spend <usd>] [--hide-channel <id>]... [--hide-message <id>]...\n' +
  '       (any mode that sends requests also takes: [--answers-dir <dir> [--answers-first-only] [--answers-timeout-min 20]])';
/** The wake kinds `--inner` runs (src/behavior/inner.js#WAKE_KINDS). */
export const INNER_KINDS = Object.freeze(['intention_due', 'errand_deadline', 'review', 'heartbeat']);
/** An inner turn's requests at most: her answer and up to four tool-loop steps (innerLife.loop.maxSteps' default). */
const INNER_REQUESTS = 5;
/** An intention id (src/intentions/model.js#newIntentionId). */
const INTENTION_ID = /^[A-Za-z0-9_-]{1,20}$/;
/** The diary kinds a brief is asked of: the ones that draw. */
const DIARY_KINDS = Object.freeze(['selfPicture', 'picture']);
/** A diary brief's requests: the plan (classifier model) and the compose (voice model). */
const DIARY_REQUESTS_PER_BRIEF = 2;
const MAX_DIARY_COUNT = 50;
/** The longest `--seed` of a `--diary-day` run. */
const MAX_SEED_CHARS = 200;
/** `diary.maxPerDay` when the config has none (src/behavior/diary.js's default, config.json's value). */
const DEFAULT_DIARY_MAX_PER_DAY = 12;
/** The estimate per model request this tool sends: about what a persona answer costs on the live key. */
const USD_PER_ANSWER = 0.15;
/** A journal turn id (src/memory/journal.js#start). */
const TURN_ID = /^t-[A-Za-z0-9-]{1,80}$/;
/** A recall run's requests at most: the classifier and the summary. */
const RECALL_REQUESTS = 2;
const SNOWFLAKE = /^\d{17,20}$/;
const DEFAULT_BEFORE = 40;
const MAX_BEFORE = 500;
const DEFAULT_SAMPLES = 1;
const DEFAULT_SPLIT_SAMPLES = 3;
const MAX_SAMPLES = 10;
const MAX_BUDGET_MS = 600000;

/** A deep-frozen copy of a JSON value. */
function frozenCopy(value) {
  const copy = value === undefined ? {} : structuredClone(value);
  const freeze = (v) => {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.freeze(v);
      for (const item of Object.values(v)) freeze(item);
    }
    return v;
  };
  return freeze(copy);
}

/**
 * The real store with every write refused: the methods in `reads` pass
 * through; any other method throws; `state` is a frozen copy whose
 * `markDirty` throws. Nothing is ever flushed from here.
 * @param {object} store  From src/memory/store.js#createStore.
 * @param {readonly string[]} reads
 */
function readOnlyStore(store, reads) {
  const refused = (name) => () => {
    throw new Error(`replay-cli: the memory store is read-only here (${name} refused)`);
  };
  const out = {};
  for (const key of Object.keys(store)) {
    if (key === 'state') continue;
    if (typeof store[key] !== 'function') continue;
    out[key] = reads.includes(key) ? (...args) => store[key](...args) : refused(key);
  }
  const data = frozenCopy(store.state?.data);
  out.state = {
    get data() {
      return data;
    },
    markDirty: refused('state.markDirty'),
  };
  return out;
}

/** A whole number in [min, max] from a flag's value, or a CliError with the usage. */
function intFlag(value, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new CliError(USAGE);
  return n;
}

/**
 * A view of the same shape as `view` whose guild memory lacks the self facts
 * that match: every one when `all`, else those containing any of `needles`
 * (lower-cased; compared case-insensitively). `getGuild` returns a shallow
 * copy with a new `self` array; the store's own guild object and array are
 * never mutated. Returns `{ view, hidden }` with the number of facts left out
 * (counted on the guild memory as it stands now).
 */
function withoutSelfFacts(view, { all, needles }) {
  const keeps = (fact) => {
    if (all) return false;
    if (typeof fact !== 'string') return true;
    const text = fact.toLowerCase();
    return !needles.some((needle) => text.includes(needle));
  };
  const filtered = (guild) => {
    const self = Array.isArray(guild?.self) ? guild.self : null;
    return self ? { ...guild, self: self.filter(keeps) } : guild;
  };
  const before = view.memory.getGuild();
  const hidden = Array.isArray(before?.self) ? before.self.filter((fact) => !keeps(fact)).length : 0;
  return {
    hidden,
    view: {
      get prompts() {
        return view.prompts;
      },
      get config() {
        return view.config;
      },
      get calibrator() {
        return view.calibrator;
      },
      memory: { ...view.memory, getGuild: () => filtered(view.memory.getGuild()) },
    },
  };
}

/**
 * `argv` (after the script) as `{ channelId, triggerId, before, samples,
 * showRequest, asOfMoment, hideSelf, hideSelfAll, split, recall, budget, text }`
 * (`hideSelf`: the substrings, lower-cased; `before` null when not given:
 * the caller picks the mode's default; `text` null without `--text`;
 * `budget` null without `--budget`); throws a CliError with the usage.
 * `--split` takes no reply-mode flag; `--recall` takes only `--text`,
 * `--before`, `--budget` and `--show-request`; `--text` needs `--split`
 * or `--recall`, `--budget` needs `--recall`. Also `pair` ([dirA, dirB] or
 * null), `triggers` (a file, with `--pair` only), `snapshot`, `outDir` (with
 * `--pair` only), `spend` (the raw `--spend` value, undefined when absent) and
 * `showRequestTurn` (`--show-request <turnId>`: no positionals, no mode flag; `--steps`
 * sets `steps` and goes only with it).
 * `--diary <kind>` sets `diary` (one of DIARY_KINDS) and takes only `--count`
 * (`count`, 1 by default), `--topic` (`topic`, raw), `--prompts` (`prompts`),
 * `--out` (`outDir`: the briefs file) and `--spend`; those three take nothing
 * else. `--skills <file>` sets `skills` (the scenario file) and takes only
 * `--out`, `--before`, `--as-of-moment`, `--snapshot`, `--spend`, `--dry`
 * (`dry`, only with it), and one of `--prompts <dir>` (`prompts`) and
 * `--pair-prompts <dirA> <dirB>` (`pairPrompts`, [dirA, dirB], only with it;
 * null when absent); no positionals. `--diary-day` sets `diaryDay` and takes only `--seed`
 * (`seed`, raw, null when absent), `--date` (`date`, a calendar `YYYY-MM-DD`), `--draw` (`draw`,
 * `fake` by default), `--max-pictures` (`maxPictures`, only with `--draw live`, DEFAULT_LIVE_PICTURES
 * by default there, null with `fake`), `--out` and `--spend`; those four take nothing else.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const out = {
    before: null,
    samples: null,
    showRequest: false,
    asOfMoment: false,
    hideSelf: [],
    hideSelfAll: false,
    split: false,
    recall: false,
    budget: null,
    text: null,
    pair: null,
    triggers: null,
    snapshot: null,
    outDir: null,
    spend: undefined,
    showRequestTurn: null,
    diary: null,
    count: null,
    topic: null,
    prompts: null,
    skills: null,
    dry: false,
    pairPrompts: null,
    diaryDay: false,
    seed: null,
    date: null,
    draw: null,
    maxPictures: null,
    coreTools: false,
    pairTransport: false,
    loopTriggers: false,
    transport: null,
    steps: false,
    noCache: false,
    inner: null,
    intention: null,
    review: false,
    hideChannels: [],
    hideMessages: [],
    answersDir: null,
    answersFirstOnly: false,
    answersTimeoutMin: ANSWERS_TIMEOUT_MIN,
  };
  const positional = [];
  const pathValue = (value) => {
    if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) throw new CliError(USAGE);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--show-request') {
      // `--show-request <turnId>`: the stored or rebuilt request of a journal turn; bare, the old switch.
      if (TURN_ID.test(argv[i + 1] ?? '')) out.showRequestTurn = argv[(i += 1)];
      else out.showRequest = true;
    } else if (arg === '--pair') out.pair = [pathValue(argv[(i += 1)]), pathValue(argv[(i += 1)])];
    else if (arg === '--triggers') out.triggers = pathValue(argv[(i += 1)]);
    else if (arg === '--snapshot') out.snapshot = pathValue(argv[(i += 1)]);
    else if (arg === '--out') out.outDir = pathValue(argv[(i += 1)]);
    else if (arg === '--spend') out.spend = pathValue(argv[(i += 1)]);
    else if (arg === '--answers-dir') out.answersDir = pathValue(argv[(i += 1)]);
    else if (arg === '--answers-first-only') out.answersFirstOnly = true;
    else if (arg === '--answers-timeout-min') out.answersTimeoutMin = intFlag(argv[(i += 1)], 1, 1440);
    else if (arg === '--skills') out.skills = pathValue(argv[(i += 1)]);
    else if (arg === '--dry') out.dry = true;
    else if (arg === '--steps') out.steps = true;
    else if (arg === '--core-tools') out.coreTools = true;
    else if (arg === '--pair-transport') out.pairTransport = true;
    else if (arg === '--loop-triggers') out.loopTriggers = true;
    else if (arg === '--no-cache') out.noCache = true;
    else if (arg === '--transport') {
      const transport = argv[(i += 1)];
      if (transport !== 'native' && transport !== 'text') throw new CliError(USAGE);
      out.transport = transport;
    } else if (arg === '--as-of-moment') out.asOfMoment = true;
    else if (arg === '--hide-self-all') out.hideSelfAll = true;
    else if (arg === '--split') out.split = true;
    else if (arg === '--recall') out.recall = true;
    else if (arg === '--budget') out.budget = intFlag(argv[(i += 1)], 1, MAX_BUDGET_MS);
    else if (arg === '--diary-day') out.diaryDay = true;
    else if (arg === '--inner') {
      const kind = argv[(i += 1)];
      if (!INNER_KINDS.includes(kind)) throw new CliError(USAGE);
      out.inner = kind;
    } else if (arg === '--hide-channel' || arg === '--hide-message') {
      const id = argv[(i += 1)];
      if (!/^\d{1,25}$/.test(id ?? '')) throw new CliError(USAGE);
      (arg === '--hide-channel' ? out.hideChannels : out.hideMessages).push(id);
    } else if (arg === '--intention') {
      const id = argv[(i += 1)];
      if (!INTENTION_ID.test(id ?? '')) throw new CliError(USAGE);
      out.intention = id;
    } else if (arg === '--review') out.review = true;
    else if (arg === '--seed') {
      const seed = pathValue(argv[(i += 1)]);
      if (seed.length > MAX_SEED_CHARS) throw new CliError(USAGE);
      out.seed = seed;
    } else if (arg === '--date') {
      const date = argv[(i += 1)];
      if (!isDateKey(date)) throw new CliError(USAGE);
      out.date = date;
    } else if (arg === '--draw') {
      const draw = argv[(i += 1)];
      if (!DRAW_MODES.includes(draw)) throw new CliError(USAGE);
      out.draw = draw;
    } else if (arg === '--max-pictures') out.maxPictures = intFlag(argv[(i += 1)], 1, MAX_PICTURES);
    else if (arg === '--diary') {
      const kind = argv[(i += 1)];
      if (!DIARY_KINDS.includes(kind)) throw new CliError(USAGE);
      out.diary = kind;
    } else if (arg === '--count') out.count = intFlag(argv[(i += 1)], 1, MAX_DIARY_COUNT);
    else if (arg === '--prompts') out.prompts = pathValue(argv[(i += 1)]);
    else if (arg === '--pair-prompts') out.pairPrompts = [pathValue(argv[(i += 1)]), pathValue(argv[(i += 1)])];
    else if (arg === '--topic') {
      const topic = argv[(i += 1)];
      if (typeof topic !== 'string') throw new CliError(USAGE);
      out.topic = topic;
    } else if (arg === '--text') {
      const text = argv[(i += 1)];
      if (typeof text !== 'string' || text.trim() === '') throw new CliError(USAGE);
      out.text = text;
    } else if (arg === '--hide-self') {
      const needle = argv[(i += 1)];
      if (typeof needle !== 'string' || needle.trim() === '' || needle.startsWith('--')) throw new CliError(USAGE);
      out.hideSelf.push(needle.toLowerCase());
    } else if (arg === '--before') out.before = intFlag(argv[(i += 1)], 0, MAX_BEFORE);
    else if (arg === '--samples') out.samples = intFlag(argv[(i += 1)], 1, MAX_SAMPLES);
    else if (arg.startsWith('--')) throw new CliError(USAGE);
    else positional.push(arg);
  }
  if (out.steps && out.showRequestTurn === null) throw new CliError(USAGE);
  const [channelId, triggerId, extra] = positional;
  // --no-cache: the trigger runs send her requests with the prompt-cache marker a live turn has; this one sends none.
  if (out.noCache && !(out.pairTransport || out.loopTriggers)) throw new CliError(USAGE);
  if (out.inner !== null) {
    // --intention for an intention's wake, --review only with the review (the heartbeat takes neither); --snapshot, --show-request,
    // --samples, --prompts, --out and --spend; no positionals.
    const review = out.inner === 'review';
    const bare = review || out.inner === 'heartbeat';
    if (
      positional.length > 0 ||
      (bare ? out.intention !== null : out.intention === null || out.review) ||
      (out.review && !review) ||
      out.diaryDay ||
      out.diary !== null ||
      out.skills !== null ||
      out.showRequestTurn !== null ||
      out.pair ||
      out.triggers !== null ||
      out.split ||
      out.recall ||
      out.text !== null ||
      out.budget !== null ||
      out.hideSelfAll ||
      out.hideSelf.length > 0 ||
      out.asOfMoment ||
      out.before !== null ||
      out.count !== null ||
      out.topic !== null ||
      out.dry ||
      out.pairPrompts !== null ||
      out.coreTools ||
      out.pairTransport ||
      out.loopTriggers ||
      out.transport !== null ||
      out.seed !== null ||
      out.date !== null ||
      out.draw !== null ||
      out.maxPictures !== null
    ) {
      throw new CliError(USAGE);
    }
    return { ...out, review, samples: out.samples ?? 1, channelId: null, triggerId: null };
  }
  if (out.intention !== null || out.review || out.hideChannels.length > 0 || out.hideMessages.length > 0)
    throw new CliError(USAGE);
  if (out.diaryDay) {
    // The day flags, --out and --spend only; no positionals; --max-pictures with --draw live only.
    if (
      positional.length > 0 ||
      out.diary !== null ||
      out.skills !== null ||
      out.showRequestTurn !== null ||
      out.showRequest ||
      out.pair ||
      out.triggers !== null ||
      out.split ||
      out.recall ||
      out.samples !== null ||
      out.text !== null ||
      out.budget !== null ||
      out.hideSelfAll ||
      out.hideSelf.length > 0 ||
      out.asOfMoment ||
      out.before !== null ||
      out.snapshot !== null ||
      out.count !== null ||
      out.topic !== null ||
      out.prompts !== null ||
      out.dry ||
      out.pairPrompts !== null ||
      out.coreTools ||
      out.pairTransport ||
      out.loopTriggers ||
      out.transport !== null ||
      (out.maxPictures !== null && out.draw !== 'live')
    ) {
      throw new CliError(USAGE);
    }
    const draw = out.draw ?? 'fake';
    return {
      ...out,
      draw,
      maxPictures: draw === 'live' ? (out.maxPictures ?? DEFAULT_LIVE_PICTURES) : null,
      samples: 1,
      channelId: null,
      triggerId: null,
    };
  }
  if (out.seed !== null || out.date !== null || out.draw !== null || out.maxPictures !== null)
    throw new CliError(USAGE);
  if (out.skills !== null) {
    // The scenario file with the memory, output and prompt-layer flags, --spend and --dry only; no positionals.
    if (
      positional.length > 0 ||
      out.diary !== null ||
      out.showRequestTurn !== null ||
      out.showRequest ||
      out.pair ||
      out.triggers !== null ||
      out.split ||
      out.recall ||
      out.samples !== null ||
      out.text !== null ||
      out.budget !== null ||
      out.hideSelfAll ||
      out.hideSelf.length > 0 ||
      out.count !== null ||
      out.topic !== null ||
      (out.prompts !== null && out.pairPrompts !== null) ||
      out.pairTransport ||
      out.loopTriggers
    ) {
      throw new CliError(USAGE);
    }
    return { ...out, samples: 1, channelId: null, triggerId: null };
  }
  if (out.dry || out.pairPrompts !== null || out.coreTools) throw new CliError(USAGE);
  if (
    (out.pairTransport || out.loopTriggers) &&
    (out.pair || out.diary !== null || out.showRequestTurn !== null || (out.pairTransport && out.loopTriggers))
  )
    throw new CliError(USAGE);
  if (out.transport !== null && !out.loopTriggers) throw new CliError(USAGE);
  if (out.diary !== null) {
    // The diary flags, --out and --spend only; no positionals.
    if (
      positional.length > 0 ||
      out.showRequestTurn !== null ||
      out.showRequest ||
      out.pair ||
      out.triggers !== null ||
      out.split ||
      out.recall ||
      out.samples !== null ||
      out.text !== null ||
      out.budget !== null ||
      out.hideSelfAll ||
      out.hideSelf.length > 0 ||
      out.asOfMoment ||
      out.before !== null ||
      out.snapshot !== null
    ) {
      throw new CliError(USAGE);
    }
    return { ...out, count: out.count ?? 1, samples: 1, channelId: null, triggerId: null };
  }
  if (out.count !== null || out.topic !== null || out.prompts !== null) throw new CliError(USAGE);
  if (out.showRequestTurn !== null) {
    // Only the memory and history flags go with it; no model request is made.
    if (
      positional.length > 0 ||
      out.showRequest ||
      out.pair ||
      out.triggers ||
      out.split ||
      out.recall ||
      out.samples !== null ||
      out.text !== null ||
      out.budget !== null ||
      out.hideSelfAll ||
      out.hideSelf.length > 0 ||
      out.outDir
    ) {
      throw new CliError(USAGE);
    }
    return { ...out, samples: DEFAULT_SAMPLES, channelId: null, triggerId: null };
  }
  if (out.pair || out.pairTransport || out.loopTriggers) {
    // Reply mode only, one sample per side; the triggers from the file or the two positionals.
    // --pair-transport: the two sides are the native transport (A) and the text one (B), not two prompt layers.
    // --loop-triggers: one side (`--transport`, default the config's), the turn's steps recorded.
    if (
      out.split ||
      out.recall ||
      out.samples !== null ||
      out.showRequest ||
      out.text !== null ||
      out.budget !== null ||
      out.hideSelfAll ||
      out.hideSelf.length > 0
    )
      throw new CliError(USAGE);
    if (
      out.triggers !== null
        ? positional.length > 0
        : extra !== undefined || !SNOWFLAKE.test(channelId ?? '') || !SNOWFLAKE.test(triggerId ?? '')
    )
      throw new CliError(USAGE);
    return { ...out, samples: 1, channelId: channelId ?? null, triggerId: triggerId ?? null };
  }
  if (out.triggers !== null || out.outDir !== null) throw new CliError(USAGE);
  if (extra !== undefined || !SNOWFLAKE.test(channelId ?? '') || !SNOWFLAKE.test(triggerId ?? ''))
    throw new CliError(USAGE);
  if (out.split && (out.showRequest || out.asOfMoment || out.hideSelfAll || out.hideSelf.length > 0))
    throw new CliError(USAGE);
  if (out.split && out.recall) throw new CliError(USAGE);
  if (out.recall && (out.samples !== null || out.asOfMoment || out.hideSelfAll || out.hideSelf.length > 0))
    throw new CliError(USAGE);
  if (out.text !== null && !out.split && !out.recall) throw new CliError(USAGE);
  if (out.budget !== null && !out.recall) throw new CliError(USAGE);
  return {
    ...out,
    samples: out.samples ?? (out.split ? DEFAULT_SPLIT_SAMPLES : DEFAULT_SAMPLES),
    channelId,
    triggerId,
  };
}

/** The `<tag>` block of a request's user text, whole (tags included); null when it has none. */
function blockOf(text, tag) {
  const match = new RegExp(`(?:^|\\n\\n)(<${tag}>\\n[\\s\\S]*?\\n</${tag}>)(?=\\n\\n|$)`).exec(text ?? '');
  return match ? match[1] : null;
}

/**
 * The journal's newest `turn.start` record whose trigger is `triggerId` (a
 * turn that answered this message), or null.
 * @param {object[]} records  The journal's records, oldest first (journalRecords).
 * @param {string} triggerId
 */
function turnStartForTrigger(records, triggerId) {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record?.kind === 'turn.start' && record.trigger?.messageId === triggerId) return record;
  }
  return null;
}

/**
 * A REST-only Discord connection: no login, no gateway, no event handler.
 * Fetches the served guild (`bot.guildId`, else the only guild the bot is
 * in), its channels (so `#channel` mentions and categories resolve as in the
 * live cache), its custom emoji, the bot's own user and member.
 */
export async function connectDiscord({ discord, token, configuredGuildId, resolveGuild, log }) {
  const { Client, Routes } = discord;
  const client = new Client({ intents: [] });
  client.rest.setToken(token);
  try {
    const guilds = await client.rest.get(Routes.userGuilds());
    const resolved = resolveGuild(
      configuredGuildId,
      (Array.isArray(guilds) ? guilds : []).map((g) => ({ id: g.id, name: g.name }))
    );
    if (resolved.error) throw new CliError(`replay-cli: ${resolved.error}`);
    const guildId = resolved.guildId;
    const guild = await client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    try {
      await guild.emojis.fetch();
    } catch (err) {
      log.warn('replay-cli: the custom emoji cannot be fetched', { errorName: err?.name, statusCode: err?.status });
    }
    const me = await client.rest.get(Routes.user());
    try {
      client.user = new discord.ClientUser(client, me);
    } catch {
      // Only `guild.members.me` needs it; nothing here reads it.
    }
    // A reaction's emoji getter reads `client.application.emojis`; without a gateway login the application is null.
    try {
      if (!client.application) client.application = new discord.ClientApplication(client, { id: me.id });
    } catch (err) {
      log.warn('replay-cli: the application object cannot be built', { errorName: err?.name });
    }
    let member = null;
    try {
      member = await guild.members.fetch(me.id);
    } catch (err) {
      log.warn('replay-cli: the bot member cannot be fetched, using the user name', {
        errorName: err?.name,
        statusCode: err?.status,
      });
    }
    const self = { id: String(me.id), name: member?.displayName ?? me.username ?? 'bot' };
    log.info('replay-cli: discord over REST', {
      guildId,
      channels: channels.size,
      emoji: guild.emojis.cache.size,
      self: self.id,
    });
    return { client, guild, guildId, self };
  } catch (err) {
    await client.destroy().catch(() => {});
    throw err;
  }
}

/**
 * Puts every member in `ids` into the guild's member cache, one REST call
 * each (`GET /guilds/{id}/members/{user}`; the list form would need the
 * gateway), so normalizeMessage reads their display names. A member who left
 * stays unresolved (the user's own name is used). Returns the counts.
 */
async function cacheMembers(guild, ids) {
  let fetched = 0;
  let missing = 0;
  for (const id of ids) {
    if (guild.members.cache.has(id)) continue;
    try {
      await guild.members.fetch(id);
      fetched += 1;
    } catch {
      missing += 1;
    }
  }
  return { fetched, missing };
}

/**
 * The `--split` mode: the request src/behavior/turn.js#maybeSplit sends for
 * `trigger` (its classifierContext rebuilt here: the trigger's text cut to
 * `context.maxMessageChars`, the last `split.contextMessages` messages of
 * `history` other than the trigger in a `<transcript>` block), sent
 * `samples` times one after another, each answer parsed. A failed request
 * is a verdict with `reason: 'failed'` and its rail code; any failure or a
 * stop makes the code 1. Returns `{ code, result }`.
 */
async function runSplit({
  hot,
  mods,
  llm,
  history,
  trigger,
  triggerKind,
  kindFrom,
  selfName,
  descriptions,
  samples,
  signal,
}) {
  const {
    splitSettings,
    splitCandidate,
    mayHaveParts,
    parseSplitAnswer,
    fillPromptTemplate,
    classifierTranscript,
    roleModel,
    helperRequestOptions,
    railReason,
  } = mods;
  const config = hot.config;
  const prompt = hot.prompts?.split;
  if (!prompt) throw new CliError('replay-cli: prompts.split is missing (prompts/split.md or prompts.local/split.md)');
  const labels = hot.prompts?.labels;
  const settings = splitSettings(config);

  // src/behavior/turn.js#classifierContext with the splitter's arguments (no videos, no reads).
  const triggerText = [...String(trigger.content ?? '')].slice(0, config.context?.maxMessageChars ?? 800).join('');
  const context =
    settings.contextMessages > 0 ? history.filter((m) => m.id !== trigger.id).slice(-settings.contextMessages) : [];
  const transcriptBlock =
    context.length === 0
      ? ''
      : `<transcript>\n${classifierTranscript(context, { config, selfName, labels, descriptions })}\n</transcript>\n`;
  const system = fillPromptTemplate(prompt, { name: selfName ?? '', maxTasks: settings.maxTasks });
  const user = `${transcriptBlock}<candidate>\n${trigger.authorName}: ${triggerText}\n</candidate>`;
  const model = roleModel(config, 'analyzer', 'split');

  // Whether a live turn would ask at all (the gate in runTurnOnce), with the reasons when not.
  const candidate = splitCandidate(trigger, triggerKind, config);
  const textPasses = mayHaveParts(trigger.content, settings.minChars);
  const labelsPart = Boolean(labels?.task?.part);
  const notAsked = [];
  if (config?.features?.splitTasks === false) notAsked.push('feature-off');
  if (!['mention', 'reply', 'name', 'followUp', 'private'].includes(triggerKind)) notAsked.push('trigger-kind');
  if (settings.maxTasks < 2) notAsked.push('max-tasks');
  if (!textPasses) notAsked.push('text-too-short-or-one-sentence');
  if (!labelsPart) notAsked.push('no-labels-task-part');

  const verdicts = [];
  let usage = { requests: 0, promptTokens: 0, completionTokens: 0 };
  let failed = false;
  let stopped = false;
  for (let i = 0; i < samples; i += 1) {
    if (signal?.aborted) {
      stopped = true;
      break;
    }
    const startedAt = Date.now();
    try {
      const completion = await llm.complete(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        {
          model,
          ...helperRequestOptions(config, {
            role: 'analyzer',
            maxOutputTokens: settings.maxOutputTokens,
            purpose: 'split',
            signal,
          }),
        }
      );
      const u = completion?.usage;
      usage = {
        requests: usage.requests + 1,
        promptTokens: usage.promptTokens + (Number(u?.prompt_tokens) || 0),
        completionTokens: usage.completionTokens + (Number(u?.completion_tokens) || 0),
      };
      const { parts, reason } = parseSplitAnswer(completion?.text, settings.maxTasks);
      verdicts.push({ raw: completion?.text ?? null, parts, reason, ms: Date.now() - startedAt });
    } catch (err) {
      if (signal?.aborted) {
        stopped = true;
        break;
      }
      failed = true;
      verdicts.push({
        raw: null,
        parts: null,
        reason: 'failed',
        error: railReason(err),
        status: err?.statusCode ?? null,
        ms: Date.now() - startedAt,
      });
    }
  }

  return {
    code: failed || stopped ? 1 : 0,
    result: {
      trigger: {
        id: trigger.id,
        author: trigger.authorName ?? null,
        at: Number.isFinite(trigger.ts) ? new Date(trigger.ts).toISOString() : null,
        kind: triggerKind ?? null,
        kindFrom,
      },
      text: String(trigger.content ?? ''),
      mayHaveParts: {
        wouldAsk: candidate && labelsPart,
        splitCandidate: candidate,
        textPasses,
        notAsked,
        settings,
      },
      model: model ?? null,
      contextLines: context.length,
      verdicts,
      stopped,
      usage,
      request: { system, user },
    },
  };
}

/** The state.json fields of the daily recall counter (src/behavior/recall-run.js RECALL_DAILY). */
const RECALL_DAILY = Object.freeze({ dayKey: 'recallDay', countKey: 'recallCount' });
/** The heading of a `<found>` section (src/behavior/recall.js#buildRecallRequest): `## n | YYYY-MM-DD | #channel`. */
const FOUND_HEADER_RE = /^## (\d+) \| (\d{4}-\d{2}-\d{2}) \| #(.*)$/;
/**
 * The mark src/behavior/recall.js#renderRecallWindows puts before the LAST
 * line of a message the search matched (recall.js HIT_MARK): the `#n [` line
 * of a one-line message, the last line of a message with line breaks.
 */
const FOUND_HIT = '>> ';
/** A message line of a `<found>` section: `#n [`, after the hit mark on a matched one-line message. */
const FOUND_LINE_RE = /^(>> )?#\d+ \[/;

/**
 * The engine functions --recall uses, named one by one (no module spread: two
 * modules may export the same name). A missing one is a CliError.
 */
async function loadRecallMods(load) {
  const recall = await load('behavior/recall.js');
  const runner = await load('behavior/recall-run.js');
  const prompt = await load('behavior/prompt.js');
  const roles = await load('llm/roles.js');
  const openrouter = await load('llm/openrouter.js');
  const time = await load('time.js');
  const turn = await load('behavior/turn.js');
  const describe = await load('memory/describe.js');
  const lookup = await load('web/lookup.js');
  const media = await load('media/classify.js');
  const pull = await load('../interfaces/discord/index.js');
  const youtube = await load('memory/youtube-check.js');
  const mods = {
    parseLookupAnswer: recall.parseLookupAnswer,
    recallSettings: recall.recallSettings,
    parseRecallAnswer: recall.parseRecallAnswer,
    createRecall: runner.createRecall,
    classifierTranscript: prompt.classifierTranscript,
    fillPromptTemplate: prompt.fillPromptTemplate,
    roleModel: roles.roleModel,
    helperRequestOptions: openrouter.helperRequestOptions,
    railReason: openrouter.railReason,
    zonedDay: time.zonedDay,
    countToday: time.countToday,
    paceSettings: turn.paceSettings,
    createDescriber: describe.createDescriber,
    createLookup: lookup.createLookup,
    collectReadableLinks: media.collectReadableLinks,
    checkPull: pull.checkPull,
    createDiscordInterface: pull.createDiscordInterface,
    isVideoVisionOn: youtube.isVideoVisionOn,
  };
  for (const [name, fn] of Object.entries(mods)) {
    if (typeof fn !== 'function') throw new CliError(`replay-cli: the engine has no ${name} (--recall needs it)`);
  }
  return mods;
}

/** The inside of the `<tag>` block of a request's text (src/behavior/prompt.js#block), or null. */
function innerBlock(text, tag) {
  const match = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text ?? '');
  return match ? match[1] : null;
}

/**
 * The windows of a summary request's `<found>` block, in its order: `{ n,
 * date, channel, lines (messages), matched (the messages the search matched,
 * the hit mark dropped), text (the section as sent) }`. A heading counts
 * only first or after a blank line (sections are separated by one); a line
 * that is no message line goes with the message line before it, and one
 * that opens with the hit mark marks that message as matched.
 */
function foundSections(user) {
  const inner = innerBlock(user, 'found');
  if (inner === null) return [];
  const sections = [];
  let current = null;
  let last = null;
  let previous = null;
  for (const line of inner.split('\n')) {
    const header = previous === null || previous === '' ? FOUND_HEADER_RE.exec(line) : null;
    previous = line;
    if (header) {
      current = { n: Number(header[1]), date: header[2], channel: header[3], messages: [], text: [] };
      sections.push(current);
      last = null;
      continue;
    }
    if (!current) continue;
    current.text.push(line);
    const message = FOUND_LINE_RE.exec(line);
    if (message) {
      last = { text: line.slice(message[1]?.length ?? 0), hit: Boolean(message[1]) };
      current.messages.push(last);
    } else if (last && line.startsWith(FOUND_HIT)) {
      last.text += `\n${line.slice(FOUND_HIT.length)}`;
      last.hit = true;
    } else if (last) last.text += `\n${line}`;
  }
  return sections.map((s) => ({
    n: s.n,
    date: s.date,
    channel: s.channel,
    lines: s.messages.length,
    matched: s.messages.filter((m) => m.hit).map((m) => m.text.trimEnd()),
    text: s.text.join('\n').trimEnd(),
  }));
}

/** An ISO time from epoch ms, or null. */
function isoOf(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * The `--recall` mode: the search classifier's request of a live turn for
 * `trigger` (src/behavior/turn.js#maybeLookup: its classifierContext rebuilt
 * here), then, when the answer has a server part, recall-run's `run()` with
 * the turn's arguments; read only (see the header). Every model request goes
 * through `llm` (the tool's rails) and is recorded; the Discord searches are
 * recorded on the way through the guild's REST client (restored after).
 * Returns `{ code, result }`: code 1 when the classifier failed or the run
 * was stopped.
 */
async function runRecall({
  hot,
  mods,
  llm,
  store,
  guild,
  guildId,
  channel,
  self,
  history,
  trigger,
  triggerKind,
  kindFrom,
  mediaCache,
  recentAsOf,
  replayMedia,
  budget,
  showRequest,
  at,
  signal,
}) {
  const {
    parseLookupAnswer,
    recallSettings,
    parseRecallAnswer,
    createRecall,
    classifierTranscript,
    fillPromptTemplate,
    roleModel,
    helperRequestOptions,
    railReason,
    zonedDay,
    countToday,
    paceSettings,
    createDescriber,
    createLookup,
    collectReadableLinks,
    checkPull,
    createDiscordInterface,
    isVideoVisionOn,
  } = mods;
  const config = hot.config;
  const prompt = hot.prompts?.lookup;
  if (!prompt)
    throw new CliError('replay-cli: prompts.lookup is missing (prompts/lookup.md or prompts.local/lookup.md)');
  const labels = hot.prompts?.labels;
  const timezone = config.bot?.timezone;
  const selfName = self.name;
  const startedAt = Date.now();

  // Every model request of this mode, with its answer (the summary's request is where the windows are read back from).
  const calls = [];
  let usage = { requests: 0, promptTokens: 0, completionTokens: 0 };
  const recording = {
    async complete(messages, options) {
      const call = { purpose: options?.purpose ?? null, messages, raw: null, error: null, status: null, ms: null };
      calls.push(call);
      const t = Date.now();
      try {
        const completion = await llm.complete(messages, options);
        const u = completion?.usage;
        usage = {
          requests: usage.requests + 1,
          promptTokens: usage.promptTokens + (Number(u?.prompt_tokens) || 0),
          completionTokens: usage.completionTokens + (Number(u?.completion_tokens) || 0),
        };
        call.raw = completion?.text ?? null;
        return completion;
      } catch (err) {
        call.error = err?.name === 'TimeoutError' ? 'timeout' : railReason(err);
        call.status = err?.statusCode ?? null;
        throw err;
      } finally {
        call.ms = Date.now() - t;
      }
    },
  };
  // The describer's caption cache and the link cache read through a private copy of the media cache
  // (their reads LRU-touch it); no request can leave from them.
  let cacheCopy = null;
  const cacheStore = {
    getMediaCache: () => (cacheCopy ??= structuredClone(mediaCache ?? {})),
    markMediaCacheDirty() {},
  };
  const refusing = {
    complete: async () => {
      throw new Error('replay-cli: no request from the caches');
    },
  };

  // 1. The search classifier, as maybeLookup builds it: the media states a live turn has by then, from the caches.
  const media = replayMedia(history, { cache: mediaCache, sites: config.media?.video?.sites, before: null });
  const descriptions = config.features?.mediaDescriptions === true ? media.descriptions : undefined;
  const videos = isVideoVisionOn(config) ? media.videos : undefined;
  let reads;
  if (config.features?.webLookup === true && config.web?.links?.enabled !== false) {
    // src/behavior/turn.js#readableLinkCandidates: newest message first.
    const sites = config.media?.video?.sites ?? [];
    const links = [];
    for (let i = history.length - 1; i >= 0; i -= 1)
      links.push(...collectReadableLinks(history[i], { videoSites: sites }));
    reads = createLookup({ hot, store: cacheStore, llm: refusing }).cachedReads(guildId, links);
  }
  const searchCfg = config.web?.search ?? {};
  const contextMessages = Math.max(0, Math.floor(searchCfg.contextMessages ?? 50));
  const triggerText = [...String(trigger.content ?? '')].slice(0, config.context?.maxMessageChars ?? 800).join('');
  const context = contextMessages > 0 ? history.filter((m) => m.id !== trigger.id).slice(-contextMessages) : [];
  const transcriptBlock =
    context.length === 0
      ? ''
      : `<transcript>\n${classifierTranscript(context, { config, selfName, labels, descriptions, videos, reads })}\n</transcript>\n`;
  // The skills list of skills discovery is left empty: a replay reads only the search lines.
  const lookupSystem = fillPromptTemplate(prompt, { today: zonedDay(at, timezone), name: selfName ?? '', skills: '' });
  const lookupUser = `${transcriptBlock}<candidate>\n${trigger.authorName}: ${triggerText}\n</candidate>`;
  const model = roleModel(config, 'analyzer', 'lookup');
  let classifierRaw = null;
  let classifierError = null;
  try {
    const completion = await recording.complete(
      [
        { role: 'system', content: lookupSystem },
        { role: 'user', content: lookupUser },
      ],
      {
        model,
        ...helperRequestOptions(config, {
          role: 'analyzer',
          maxOutputTokens: searchCfg.classifierMaxOutputTokens ?? 200,
          purpose: 'lookup',
          signal,
        }),
      }
    );
    classifierRaw = completion?.text ?? null;
  } catch (err) {
    classifierError = signal?.aborted ? 'stopped' : railReason(err);
  }
  const classifierMs = Date.now() - startedAt;
  let parsed = null;
  if (classifierError === null) {
    // An empty answer is a failed call in the live turn too (`lookup: classifier failed`, `empty`).
    if (String(classifierRaw ?? '').trim())
      parsed = parseLookupAnswer(classifierRaw, { timezone, now: at, maxForms: recallSettings(config)?.maxForms });
    else classifierError = 'empty';
  }
  const server = parsed?.server ?? null;

  // 2. The server search, when the answer asks for it and the rails allow it.
  const recallHot = {
    get config() {
      const live = hot.config;
      return budget === null ? live : { ...live, recall: { ...(live.recall ?? {}), timeoutMs: budget } };
    },
    get prompts() {
      return hot.prompts;
    },
  };
  const settings = recallSettings(recallHot.config);
  let notRun = null;
  if (classifierError !== null) notRun = 'no-classifier-answer';
  else if (!server) notRun = 'no-server-part';
  else if (!settings) notRun = 'feature-off';
  else if (countToday(store.state.data, RECALL_DAILY, Date.now()) >= settings.maxPerDay) notRun = 'daily';
  else if (signal?.aborted) notRun = 'stopped';
  if (notRun === 'daily')
    process.stderr.write('replay-cli: recall.maxPerDay is spent today; the server search is not run\n');

  const searches = [];
  const rawHits = new Map();
  let deadlineFired = false;
  let found = null;
  let recallMs = 0;
  if (notRun === null) {
    // The daily recall counter: a private copy, bumped by the run and dropped after it.
    const data = { recallDay: store.state.data.recallDay, recallCount: store.state.data.recallCount };
    const recallStore = {
      state: { data, markDirty() {} },
      listUserProfiles: (id) => store.listUserProfiles(id),
      getLore: (id) => store.getLore(id),
      getGuild: (id) => store.getGuild(id),
      getRecent: () => recentAsOf(),
    };
    const describer = createDescriber({ hot, store: cacheStore, llm: refusing });
    // The run's first timer is its deadline (recall.timeoutMs); the second only cuts a search still out.
    let timersSet = 0;
    const timers = {
      set: (fn, ms) => {
        const deadline = timersSet === 0;
        timersSet += 1;
        return setTimeout(() => {
          if (deadline) deadlineFired = true;
          fn();
        }, ms);
      },
      clear: (timer) => clearTimeout(timer),
    };
    // Discord's searches recorded on the way (queries, totals, raw hits); every other route passes untouched.
    const rest = guild.client.rest;
    const ownGet = Object.hasOwn(rest, 'get') ? rest.get : null;
    const restGet = rest.get.bind(rest);
    rest.get = async (route, options) => {
      const kind = /\/messages\/search$/.test(String(route))
        ? 'messages'
        : /\/members\/search$/.test(String(route))
          ? 'members'
          : null;
      if (!kind) return restGet(route, options);
      const entry = {
        route: kind,
        query: options?.query ? Object.fromEntries(options.query) : {},
        total: null,
        hits: null,
        error: null,
        status: null,
      };
      searches.push(entry);
      try {
        const body = await restGet(route, options);
        if (kind === 'members') entry.hits = Array.isArray(body) ? body.length : null;
        else if (Array.isArray(body?.messages)) {
          // The same flattening as interfaces/discord/search.js#searchMessages.
          let count = 0;
          for (const group of body.messages) {
            const list = Array.isArray(group) ? group : [group];
            const flagged = list.filter((m) => m?.hit === true);
            for (const m of flagged.length > 0 ? flagged : list) {
              if (!m?.id) continue;
              count += 1;
              if (!rawHits.has(m.id))
                rawHits.set(m.id, {
                  channelId: m.channel_id ?? null,
                  bot: m.author?.bot === true,
                  authorId: m.author?.id ?? null,
                });
            }
          }
          entry.total = Number.isFinite(body.total_results) ? body.total_results : null;
          entry.hits = count;
        } else entry.error = 'not-indexed';
        return body;
      } catch (err) {
        entry.error = err?.name ?? 'Error';
        entry.status = err?.status ?? err?.statusCode ?? null;
        throw err;
      }
    };
    // The run's clock starts at the trigger's moment, as the live turn's did.
    const offset = at - Date.now();
    const clock = () => Date.now() + offset;
    const t = Date.now();
    try {
      const recall = createRecall({
        hot: recallHot,
        store: recallStore,
        llm: recording,
        discord: createDiscordInterface().capabilities,
        describer,
        now: clock,
        timers,
      });
      found = await recall.run({
        guild,
        guildId,
        channel,
        selfId: self.id,
        selfName,
        history,
        candidate: trigger,
        server,
      });
    } finally {
      recallMs = Date.now() - t;
      if (ownGet) rest.get = ownGet;
      else delete rest.get;
    }
  }

  // 3. What the summary saw and said, read back from its request as sent.
  const summaryCall = calls.find((call) => call.purpose === 'recall-summary') ?? null;
  const summaryUser = summaryCall?.messages?.find?.((m) => m?.role === 'user')?.content ?? null;
  const summarySystem = summaryCall?.messages?.find?.((m) => m?.role === 'system')?.content ?? null;
  const sections = foundSections(summaryUser);
  const stats = found?.stats ?? null;
  const answered = stats?.summary === 'answered';
  const named =
    answered && summaryCall?.raw != null
      ? parseRecallAnswer(summaryCall.raw, { answerChars: settings?.answerChars, count: sections.length }).stretch
      : null;
  const stretch = found?.stretch
    ? {
        n: named,
        from: answered ? 'summary' : 'fallback',
        channelId: found.stretch.channelId ?? null,
        channel: found.stretch.channelName ?? null,
        date: Number.isFinite(found.stretch.startTs) ? zonedDay(found.stretch.startTs, timezone) : null,
        at: isoOf(found.stretch.startTs),
        lines: found.stretch.lines,
      }
    : null;
  // The hits per channel and what the turn's filters made of them (other bots, the turn's own chat, the pull rail).
  const ownIds = new Set(history.map((m) => m.id));
  const perChannel = new Map();
  for (const [id, hit] of rawHits) {
    const key = hit.channelId ?? '';
    if (!perChannel.has(key)) perChannel.set(key, { hits: 0, bots: 0, ownChat: 0 });
    const row = perChannel.get(key);
    row.hits += 1;
    if (hit.bot && hit.authorId !== self.id) row.bots += 1;
    if (ownIds.has(id)) row.ownChat += 1;
  }
  const hitChannels = [...perChannel].map(([channelId, row]) => {
    let pull = null;
    try {
      pull =
        checkPull({ guild, channelId, destination: channel, partner: null, config: recallHot.config, now: at }).skip ??
        'ok';
    } catch (err) {
      pull = `error:${err?.name ?? 'Error'}`;
    }
    return { channelId, channel: guild.channels.cache.get(channelId)?.name ?? null, ...row, pull };
  });
  const pace = paceSettings(config);
  const elapsedMs = classifierMs + recallMs;
  const stopped = Boolean(signal?.aborted);

  const result = {
    trigger: {
      id: trigger.id,
      author: trigger.authorName ?? null,
      at: isoOf(trigger.ts),
      kind: triggerKind ?? null,
      kindFrom,
    },
    text: String(trigger.content ?? ''),
    classifier: {
      raw: classifierRaw,
      parsed: parsed
        ? {
            web: parsed.web ?? null,
            server: server
              ? {
                  forms: server.forms,
                  who: server.who,
                  from: server.from,
                  to: server.to,
                  fromAt: isoOf(server.from),
                  toAt: isoOf(server.to),
                }
              : null,
            reason: parsed.reason ?? null,
          }
        : null,
      error: classifierError,
      model: model ?? null,
      contextLines: context.length,
      ms: classifierMs,
    },
    recall: {
      ran: notRun === null,
      notRun,
      budgetMs: settings?.timeoutMs ?? null,
      budgetFrom: budget === null ? 'config' : 'flag',
      stats,
    },
    people: (found?.people ?? []).map((p) => ({ ...p, newestAt: isoOf(p.newestTs) })),
    clusters: sections,
    memory: (innerBlock(summaryUser, 'memory') ?? '').split('\n').filter(Boolean),
    stretch,
    summary: found?.text ?? null,
    summaryRaw: summaryCall?.raw ?? null,
    outcome: {
      summary: stats?.summary ?? null,
      summaryError: summaryCall?.error ?? null,
      timedOut: deadlineFired,
      searchCut: searches.some((s) => s.error === 'AbortError'),
      late: {
        limitMs: pace.prepareSearchMs,
        elapsedMs,
        late: pace.prepareSearchMs !== null && elapsedMs > pace.prepareSearchMs,
      },
    },
    searches,
    hitChannels,
    stopped,
    ms: Date.now() - startedAt,
    usage,
  };
  if (showRequest) {
    result.request = {
      lookup: { system: lookupSystem, user: lookupUser },
      summary: summaryCall ? { system: summarySystem, user: summaryUser } : null,
    };
  }
  return { code: classifierError !== null || stopped ? 1 : 0, result };
}

/**
 * The channel, the chat up to the trigger (normalized as a live history is)
 * and the trigger's line and moment, over REST (see the header): a CliError
 * when the channel or the trigger cannot be read. Returns `{ channel,
 * history, triggerLine, at }`.
 */
async function readMoment({
  client,
  guild,
  guildId,
  self,
  channelId,
  triggerId,
  before,
  config,
  fetchHistoryWindow,
  fetchMessage,
  log,
}) {
  const channel = await readableChannel({ client, guild, guildId, channelId });

  const trigger = await fetchMessage(channel, triggerId);
  if (!trigger) throw new CliError('replay-cli: the trigger message was not found');
  if (trigger.author?.id === self.id)
    throw new CliError("replay-cli: the trigger is the persona's own message; give the message she answered");

  const history = await fetchWindow({
    guild,
    channel,
    self,
    anchorId: triggerId,
    limit: before + 1,
    config,
    fetchHistoryWindow,
    log,
  });
  if (history.length === 0 || history[history.length - 1].id !== triggerId) {
    throw new CliError('replay-cli: the chat up to the trigger cannot be read');
  }
  const triggerLine = history[history.length - 1];
  return { channel, history, triggerLine, at: triggerLine.ts };
}

/** A channel of the served guild that can be read: from the guild's fetched channels, else one REST fetch (a thread is not in that list); else a CliError. */
async function readableChannel({ client, guild, guildId, channelId }) {
  let channel = guild.channels.cache.get(channelId) ?? null;
  if (!channel) {
    try {
      channel = await client.channels.fetch(channelId);
    } catch {
      channel = null;
    }
  }
  if (!channel || typeof channel.messages?.fetch !== 'function')
    throw new CliError('replay-cli: that channel cannot be read');
  if (String(channel.guildId ?? channel.guild?.id ?? '') !== String(guildId))
    throw new CliError('replay-cli: that channel is not in the served guild');
  return channel;
}

/**
 * The last `limit` messages of `channel` up to and including `anchorId` (the newest ones when
 * it is null), oldest first, normalized as a live history is: the authors and mentioned members
 * (and the ids of `memberIds`) put into the member cache first, so their display names resolve.
 */
async function fetchWindow({ guild, channel, self, anchorId, limit, config, fetchHistoryWindow, log, memberIds = [] }) {
  const windowOptions = {
    anchorId: anchorId ?? undefined,
    limit,
    selfId: self.id,
    embedTextChars: config.media?.embedTextChars,
    videoSites: config.media?.video?.sites,
    maxUrlChars: config.context?.maxUrlChars,
  };
  // Pass 1 learns who wrote and who is mentioned; their members are cached; pass 2 normalizes with their display names.
  const first = limit > 0 ? await fetchHistoryWindow(channel, windowOptions) : [];
  const ids = new Set(memberIds.filter((id) => id !== self.id));
  for (const message of first) {
    if (message.authorId !== self.id) ids.add(message.authorId);
    for (const id of message.mentionedUserIds ?? []) if (id !== self.id) ids.add(id);
  }
  const members = await cacheMembers(guild, ids);
  // The audience rail's view of bots: the members named in per-member channel overwrites,
  // fetched like src/index.js warms them at startup (interfaces/discord/audience-warm.js).
  try {
    const warm = await import(
      pathToFileURL(path.join(process.cwd(), 'interfaces', 'discord', 'audience-warm.js')).href
    );
    const overwriteIds = warm.overwriteMemberIds(guild.channels.cache.values(), (id) => guild.members.cache.has(id));
    const warmed = await warm.fetchMembers(overwriteIds, (id) => guild.members.fetch(id));
    log.info('replay-cli: audience members warmed', warmed);
  } catch (err) {
    log.warn('replay-cli: audience warm skipped', { error: String(err?.message ?? err).slice(0, 120) });
  }
  const history = limit > 0 ? await fetchHistoryWindow(channel, windowOptions) : [];
  log.info('replay-cli: chat fetched', {
    channelId: channel.id,
    lines: history.length,
    members: members.fetched,
    membersMissing: members.missing,
  });
  return history;
}

/**
 * The memory view of a reply-mode answer (see the header): live memory with
 * `<recent>` cut at the trigger, or every dated item cut with
 * `--as-of-moment`; self facts left out on `--hide-self`. `hotLike` gives
 * the prompts and the config (a pair's side has its own prompts). Returns
 * `{ view, hiddenSelf, hidden }`.
 */
function memoryViewFor({ hotLike, store, guildId, calibrator, situation, at, args, mods }) {
  const { liveView, momentView, momentCutoff, hiddenLater } = mods;
  const base = liveView({ hot: hotLike, store, guildId, calibrator });
  const cutoff = momentCutoff(situation) ?? at;
  const asOf = momentView(base, cutoff);
  const memoryView = args.asOfMoment
    ? asOf
    : {
        get prompts() {
          return base.prompts;
        },
        get config() {
          return base.config;
        },
        calibrator: base.calibrator,
        // Live memory, but `<recent>` never shows a line the analyzer added at or after the trigger.
        memory: { ...base.memory, getRecent: asOf.memory.getRecent },
      };
  // Self facts left out of the request on the operator's word: a copy of the guild memory, the store untouched.
  const selfFilter = args.hideSelfAll || args.hideSelf.length > 0;
  const { view, hidden: hiddenSelf } = selfFilter
    ? withoutSelfFacts(memoryView, { all: args.hideSelfAll, needles: args.hideSelf })
    : { view: memoryView, hidden: 0 };
  return { view, hiddenSelf, hidden: args.asOfMoment ? hiddenLater(base, cutoff) : null };
}

/** The text of a message's content: a string, or its text parts joined. */
function textOfContent(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content)
    ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
    : '';
}

/** The JSON records of every journal day file under `dir`, oldest day first; unreadable lines skipped. */
function journalRecords(dir) {
  let names = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n').slice(0, -1)) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // a torn or hand-broken line
      }
    }
  }
  return out;
}

/** One stored `later` message as shown: role, then tool_calls and tool_call_id when it has them, then content. */
function laterView(message) {
  if (!message || typeof message !== 'object') return message;
  return {
    role: message.role,
    ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
    ...(typeof message.tool_call_id === 'string' ? { tool_call_id: message.tool_call_id } : {}),
    content: message.content ?? null,
  };
}

/**
 * The request dumps of `turnId` under a journal directory, every attempt, oldest day first, then
 * by attempt: the base dumps (`<turnId>-<attempt>.json`, the reply's request) only, unless `steps`
 * (`--steps`): then each attempt's later requests (`<turnId>-<attempt>-s<step>.json`, the tool
 * loop's steps and the follow-up after a call) follow its base dump in step order.
 * @param {string} journalDir
 * @param {string} turnId
 * @param {{ steps?: boolean }} [options]
 * @returns {{ file: string, dump: object }[]}
 */
export function storedDumps(journalDir, turnId, { steps = false } = {}) {
  const root = path.join(journalDir, 'requests');
  let days = [];
  try {
    days = fs
      .readdirSync(root)
      .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
      .sort();
  } catch {
    return [];
  }
  const out = [];
  for (const day of days) {
    const found = [];
    for (const name of fs.readdirSync(path.join(root, day))) {
      if (!name.startsWith(`${turnId}-`)) continue;
      const match = /^(\d+)(?:-s(\d+))?\.json$/.exec(name.slice(turnId.length + 1));
      if (!match || (match[2] !== undefined && !steps)) continue;
      found.push({ name, attempt: Number(match[1]), step: match[2] === undefined ? 0 : Number(match[2]) });
    }
    found.sort((a, b) => a.attempt - b.attempt || a.step - b.step);
    for (const { name } of found) {
      try {
        const dump = JSON.parse(fs.readFileSync(path.join(root, day, name), 'utf8'));
        // A request that had tools names them by hash; the stored copy is read back as `toolDefinitions`
        // (absent when the copy is gone), so a replay re-sends the schemas the turn really saw.
        if (typeof dump.tools === 'string' && /^[0-9a-f]{64}$/.test(dump.tools)) {
          try {
            dump.toolDefinitions = JSON.parse(fs.readFileSync(path.join(root, 'tools', `${dump.tools}.json`), 'utf8'));
          } catch {
            // the copy is missing: the hash stays
          }
        }
        // The messages after the first two, shown as role, tool_calls and tool_call_id with their content.
        if (Array.isArray(dump.later)) dump.later = dump.later.map(laterView);
        out.push({ file: path.join(root, day, name), dump });
      } catch {
        // a dump cut short: skipped
      }
    }
  }
  return out;
}

/**
 * The turn a `--diary` brief runs: `{ mode: 'diary', diary: { kind, [topic],
 * forced: false } }`. The topic as `/nep diary post` threads it: trimmed,
 * blank is none, then `diaryTopic` (src/behavior/diary.js), on the params
 * only when present.
 * @param {{ diary: string, topic: string|null }} args  From parseArgs.
 * @param {{ diaryTopic: (text: string|null) => string|null }} mods
 */
export function diaryTurnParams(args, { diaryTopic }) {
  const topic = diaryTopic(String(args.topic ?? '').trim() || null);
  return { mode: 'diary', diary: { kind: args.diary, ...(topic ? { topic } : {}), forced: false } };
}

/**
 * The prompt layers of a `--diary --prompts <dir>` run, for promptLayersHot:
 * the live prompts.local/ (when the private directory has one: NEPTUNIA_PRIVATE_DIR, else the
 * checkout; tools/lib/cli.mjs#privateDirOf), then `promptsDir`. The live layer is named
 * `prompts.local` when it is in the checkout, by its absolute path when it is apart.
 * @param {string} root
 * @param {string} promptsDir
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function diaryPromptLayers(root, promptsDir, env = process.env) {
  const privateDir = privateDirOf(root, env);
  const local = privateDir === path.resolve(root) ? 'prompts.local' : path.join(privateDir, 'prompts.local');
  return fs.existsSync(path.resolve(root, local)) ? [local, promptsDir] : [promptsDir];
}

/**
 * A hot view whose private layer is a copy of the live prompts.local/ with `promptsDir` laid over
 * it (diaryPromptLayers, then tools/lib/prompt-layers.mjs): a file of the directory replaces the
 * private one of the same name, the rest stay. `mergeJson` (src/config.js#deepMerge) merges the
 * directory's labels.json / skills.json over the private ones as src/hot.js merges its layers
 * (`--skills --prompts` and `--pair-prompts`); without it they replace them whole (`--diary
 * --prompts`). The live prompts.local/ is only read. Returns `{ hot, dir }`: the caller closes
 * the view and removes `dir`.
 * @param {(options: { rootDir: string }) => object} createHot
 * @param {string} root
 * @param {string} promptsDir
 * @param {{ mergeJson?: Function|null, tmpDir?: string }} [options]
 */
export function overlayPromptsHot(createHot, root, promptsDir, { mergeJson = null, tmpDir } = {}) {
  return promptLayersHot(createHot, root, diaryPromptLayers(root, promptsDir), {
    mergeJson,
    ...(tmpDir ? { tmpDir } : {}),
  });
}

/**
 * `hot` as a `--diary` turn sees it: `features.dryRun` on and
 * `bot.dryRunChannelId` empty (the turn acts on nothing and mirrors nothing);
 * everything else, the config's other keys included, read from `hot` at use.
 * @param {object} hot  From src/hot.js#createHot.
 */
export function dryRunHot(hot) {
  return new Proxy(hot, {
    get(target, prop) {
      if (prop === 'config') {
        const config = target.config ?? {};
        return {
          ...config,
          features: { ...(config.features ?? {}), dryRun: true },
          bot: { ...(config.bot ?? {}), dryRunChannelId: '' },
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Whether a live turn's web search could run (`<senses>`'s search line): the
 * lookup's own `hasSearch()` for the configured `web.search.engine`, wired as
 * src/index.js wires it (`brave` needs BRAVE_SEARCH_API_KEY, `exa` and
 * `openrouter` need no key). Builds the lookup only to ask; no search is run
 * and nothing is read or written (its llm and store refuse everything).
 * @param {{ hot: object, createLookup: Function, searches: object, env?: object }} input
 *   `createLookup` from src/web/lookup.js; `searches` the engine clients (`{ brave, exa }`).
 * @returns {boolean}
 */
export function searchAvailableOf({ hot, createLookup, searches, env = process.env }) {
  const refuse = () => {
    throw new Error('replay-cli: no search from the availability check');
  };
  const lookup = createLookup({
    hot,
    store: { getMediaCache: refuse, markMediaCacheDirty: refuse },
    llm: { complete: async () => refuse() },
    searches,
    keys: { brave: env.BRAVE_SEARCH_API_KEY || null, exa: env.EXA_API_KEY || null },
  });
  return lookup.hasSearch() === true;
}

/**
 * The real store for a `--diary` run: reads pass through; `state` is an
 * in-memory deep copy whose markDirty does nothing; flush, forget, wipe and
 * reload methods throw; the recall trace is a no-op. Other mutations touch
 * only this process's cache, which is never flushed.
 * @param {object} store  From src/memory/store.js#createStore.
 */
export function unflushedStore(store) {
  const state = { data: structuredClone(store.state?.data ?? {}), markDirty() {} };
  const refused = new Set([
    'flush',
    'flushEntry',
    'forgetUser',
    'forgetPrivate',
    'wipeGuild',
    'setPingsOff',
    'dropCaches',
    'reloadState',
  ]);
  const proxy = new Proxy(store, {
    get(target, prop) {
      if (prop === 'state') return state;
      if (refused.has(prop)) {
        return () => {
          throw new Error(`replay-cli: the memory store is not written here (${String(prop)} refused)`);
        };
      }
      if (prop === 'appendRecallTrace') return () => undefined;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { store: proxy, state };
}

/**
 * The `--diary` mode (see the header): `args.count` briefs of one kind from
 * the real turn runner in the diary channel, nothing acted on. Returns
 * `{ code, result }`.
 */
/** The engine modules a diary run (`--diary`, `--diary-day`) wires, from the checkout at `load`. */
export async function loadDiaryMods(load) {
  return {
    ...(await load('behavior/diary.js')),
    ...(await load('memory/store.js')),
    ...(await load('llm/tokens.js')),
    ...(await load('llm/openrouter.js')),
    ...(await load('llm/images.js')),
    ...(await load('behavior/turn.js')),
    ...(await load('behavior/route-channel.js')),
    ...(await load('behavior/recall-run.js')),
    ...(await load('../interfaces/discord/index.js')),
    ...(await load('interface/fake.js')),
    ...(await load('interface/reads.ts')),
    ...(await load('interface/recall-bridge.ts')),
    ...(await load('memory/describe.js')),
    ...(await load('media/fetch-image.js')),
    ...(await load('media/fetch-video.js')),
    ...(await load('web/fetch-page.js')),
    ...(await load('web/brave.js')),
    ...(await load('web/exa.js')),
    ...(await load('web/lookup.js')),
    ...(await load('llm/parse.js')),
    ...(await load('skills/tool-calls.js')),
    ...(await load('memory/clamp.js')),
    ...(await load('time.js')),
  };
}

/**
 * The llm client of a diary run: every request the tool's own (`origin: 'replay'`, never
 * counted against the daily cap, no calibration; `noCache`: no prompt-cache marker), each one
 * recorded in `calls` as `{ purpose, text, toolCalls, finishReason, usage, error, code }` (`toolCalls`: the native
 * transport's calls of the answer; `code`: the short failure code of `errorCodeOf`, when given, else `error`).
 */
export function recordingLlm(realLlm, calls, { noCache = false, errorCodeOf = null } = {}) {
  return new Proxy(realLlm, {
    get(target, prop) {
      if (prop === 'complete') {
        return async (messages, options = {}) => {
          const call = {
            purpose: options?.purpose ?? null,
            text: null,
            toolCalls: null,
            finishReason: null,
            usage: null,
            error: null,
            code: null,
          };
          calls.push(call);
          try {
            const completion = await target.complete(messages, {
              ...options,
              origin: 'replay',
              countAgainstDailyCap: false,
              skipCalibration: true,
              ...(noCache ? { cache: false } : {}),
            });
            call.text = completion?.text ?? null;
            call.toolCalls = Array.isArray(completion?.toolCalls) ? completion.toolCalls : null;
            call.finishReason = completion?.finishReason ?? null;
            call.usage = completion?.usage ?? null;
            return completion;
          } catch (err) {
            call.error = `${err?.name ?? 'Error'}: ${err?.message ?? err}`;
            call.code = typeof errorCodeOf === 'function' ? errorCodeOf(err) : 'error';
            throw err;
          }
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** What one recorded request cost, as the provider reported it (else 0). */
function callCost(call) {
  const cost = Number(call.usage?.cost_details?.upstream_inference_cost ?? call.usage?.cost ?? 0);
  return Number.isFinite(cost) ? cost : 0;
}

/** `usage` with the recorded requests `mine` added. */
function addUsage(usage, mine) {
  let out = usage;
  for (const call of mine) {
    out = {
      ...out,
      requests: out.requests + 1,
      promptTokens: out.promptTokens + (Number(call.usage?.prompt_tokens) || 0),
      completionTokens: out.completionTokens + (Number(call.usage?.completion_tokens) || 0),
      cost: Math.round((out.cost + callCost(call)) * 10000) / 10000,
    };
  }
  return out;
}

/**
 * The diary channel over REST, in the served guild (else a CliError), with Discord's every
 * write refused: the REST queue passes GET only, the channel's send and sendTyping throw. Warns
 * when the bot could not send or attach there (the live diary would skip it).
 */
async function openDiaryChannel({ client, guildId, diaryChannelId, canSend, canAttach, log }) {
  const queueRequest = client.rest.queueRequest.bind(client.rest);
  client.rest.queueRequest = (request) => {
    const method = String(request?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') return Promise.reject(new Error(`replay-cli: Discord ${method} refused (read-only tool)`));
    return queueRequest(request);
  };
  let channel = null;
  try {
    channel = await client.channels.fetch(diaryChannelId);
  } catch {
    channel = null;
  }
  if (!channel || String(channel.guildId ?? channel.guild?.id ?? '') !== String(guildId))
    throw new CliError('replay-cli: the diary channel is not in the served guild');
  const refuse = (name) => async () => {
    throw new Error(`replay-cli: channel.${name} refused (read-only tool)`);
  };
  channel.send = refuse('send');
  channel.sendTyping = refuse('sendTyping');
  let writable = false;
  try {
    writable = canSend(channel) && canAttach(channel);
  } catch {
    writable = false;
  }
  if (!writable)
    log.warn(
      'replay-cli: the bot cannot send or attach in the diary channel; the live diary would skip it (not-writable)',
      {}
    );
  return channel;
}

/**
 * The turn runner of a diary run, wired as src/index.js wires it over `client` (REST only): the interface's reads are
 * the Discord adapter's over that client, `wrapReads` may filter them (what the replay hides, what a week scripts).
 * `port`: the interface port the turn acts through (else the Discord adapter over `client`, whose writes the replay
 * has refused); `rng` / `now`: the runner's random stream and clock (else its defaults).
 */
export function diaryTurnRunner(
  mods,
  {
    hot,
    store,
    llm,
    calibrator,
    client,
    guildId,
    self,
    images,
    state,
    port = null,
    rng = null,
    now = null,
    extra = {},
    wrapReads = null,
  }
) {
  const imageFetcher = mods.createImageFetcher();
  const describer = mods.createDescriber({
    hot,
    store,
    llm,
    imageFetcher,
    videoFetcher: mods.createVideoFetcher(),
    state,
    youtubeApiKey: process.env.YOUTUBE_API_KEY || null,
  });
  const lookup = mods.createLookup({
    hot,
    store,
    llm,
    state,
    pageFetcher: mods.createPageFetcher(),
    searches: { brave: mods.createBraveSearch(), exa: mods.createExaSearch() },
    keys: { brave: process.env.BRAVE_SEARCH_API_KEY || null, exa: process.env.EXA_API_KEY || null },
  });
  // The Discord interface over `client`: its adapter reads for the turn and writes unless a port is given; its
  // capabilities are what the recall runner (which still takes the platform's objects) is given.
  const discord = mods.createDiscordInterface({ client, config: () => hot.config });
  const capabilities = discord.capabilities;
  const found = mods.createReads(discord.port, { info() {}, warn() {}, error() {} });
  const reads = wrapReads ? wrapReads(found) : found;
  return mods.createTurnRunner({
    hot,
    store,
    llm,
    calibrator,
    describer,
    imageFetcher,
    lookup,
    images,
    recall: mods.bridgeRecall(mods.createRecall({ hot, store, llm, discord: capabilities, describer }), client),
    emoji: mods.createEmojiIndex(client, () => guildId),
    getSelfName: () => self.name,
    selfId: () => self.id,
    reads,
    port: port ?? discord.port,
    routeChannels: mods.createChannelRouter({ hot, store, llm }),
    activity: null,
    ...(rng ? { rng } : {}),
    ...(now ? { now } : {}),
    // `--inner`: her skills, the commands they run through, her intentions and errands, read only.
    ...extra,
  });
}

async function runDiary({ args, root, load, hot: liveHot, createHot, loadDotEnv, log, signal, rng }) {
  const mods = await loadDiaryMods(load);
  const { DIARY_PICTURES_DAILY, diaryTopic, isPictureKind, isSetKind, stripUrls, validatePlan } = mods;
  const { createStore, createCalibrator, createLlm, createImageGen, canAttach, canSend, resolveGuild } = mods;
  const { parseJsonObject, parseOutput, stripDashes, countToday } = mods;

  const params = diaryTurnParams(args, { diaryTopic });
  const { kind } = params.diary;
  const topic = params.diary.topic ?? null;
  const liveData = defaultDataDir(root);
  if (!fs.existsSync(liveData)) throw new CliError(`replay-cli: no data directory at ${liveData}`);
  const outFile = args.outDir !== null ? path.resolve(root, args.outDir) : null;
  if (outFile !== null && (outFile === liveData || outFile.startsWith(`${liveData}${path.sep}`)))
    throw new CliError('replay-cli: --out may not be under data/');

  loadDotEnv(privateDirOf(root));
  const discordToken = process.env.DISCORD_TOKEN;
  if (!discordToken) throw new CliError('replay-cli: DISCORD_TOKEN is not set (.env)');
  const openrouterKey = simKey('replay-cli');

  let layered = null;
  let client = null;
  try {
    if (args.prompts !== null) {
      layered = overlayPromptsHot(createHot, root, args.prompts);
      log.info('replay-cli: diary prompt layers', { layers: diaryPromptLayers(root, args.prompts).length });
    }
    const hot = dryRunHot(layered?.hot ?? liveHot);
    const config = hot.config;
    const diaryChannelId = config.diary?.channelId;
    if (!diaryChannelId) throw new CliError('replay-cli: diary.channelId is not set');
    if (config.features?.diary === false)
      log.warn('replay-cli: features.diary is off; the live diary would not post', {});
    const weight = config.diary?.kinds?.[kind];
    if (!(Number.isFinite(weight) && weight > 0))
      log.warn('replay-cli: the kind has no positive weight in diary.kinds', { kind, weight: weight ?? null });
    if (!isPictureKind(kind, config.diary?.pictureKinds))
      log.warn('replay-cli: the kind is not in diary.pictureKinds; it draws only when the plan says picture', { kind });
    if (isSetKind(kind, config.diary?.setKinds))
      log.warn('replay-cli: the kind is a set kind; only the first <draw> is reported', { kind });

    // The store and the counters: an in-memory copy; the picture gate opened there only.
    const { store, state } = unflushedStore(createStore({ dataDir: liveData, memoryDb: memoryFor(liveData) }));
    const nowMs = Date.now();
    const were = {
      diaryPictures: countToday(state.data, DIARY_PICTURES_DAILY, nowMs),
      images: countToday(state.data, { dayKey: 'imageDay', countKey: 'imageCount' }, nowMs),
    };
    state.data[DIARY_PICTURES_DAILY.countKey] = 0;
    state.data.imageCount = 0;
    log.info('replay-cli: diary gates opened', {
      diaryPicturesWere: were.diaryPictures,
      imagesWere: were.images,
      paused: Boolean(state.data.paused),
    });

    // The model clients: every request the tool's own, recorded with its purpose.
    const calibrator = createCalibrator(state.data.calibration);
    const realLlm = createLlm({ apiKey: openrouterKey, getConfig: () => hot.config, calibrator, state });
    const calls = [];
    const llm = recordingLlm(realLlm, calls, { noCache: args.count === 1 });
    const realImages = createImageGen({ apiKey: openrouterKey, getConfig: () => hot.config, state });
    const images = {
      quota: (...a) => realImages.quota(...a),
      familyOf: (...a) => realImages.familyOf(...a),
      generate: async () => {
        throw new Error('replay-cli: picture generation is disabled in this tool');
      },
    };

    // Discord over REST, every write refused.
    const discord = createRequire(path.join(root, 'package.json'))('discord.js');
    const connection = await connectDiscord({
      discord,
      token: discordToken,
      configuredGuildId: config.bot?.guildId || '',
      resolveGuild,
      log,
    });
    client = connection.client;
    const { guildId, self } = connection;
    const channel = await openDiaryChannel({ client, guildId, diaryChannelId, canSend, canAttach, log });

    // The engine, wired as src/index.js wires it.
    const turns = diaryTurnRunner(mods, { hot, store, llm, calibrator, client, guildId, self, images, state });
    log.info('replay-cli: diary ready', {
      guildId,
      channelId: channel.id,
      kind,
      count: args.count,
      topicChars: topic ? topic.length : 0,
    });

    const briefs = [];
    let usage = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    for (let n = 1; n <= args.count; n += 1) {
      if (signal?.aborted) break;
      const from = calls.length;
      let result;
      try {
        result = await turns.runTurn({ conversation: conversationRef(channel), ...params });
      } catch (err) {
        result = { outcome: 'error', reason: `${err?.name ?? 'Error'}: ${err?.message ?? err}` };
      }
      const mine = calls.slice(from);
      usage = addUsage(usage, mine);
      const planCall = mine.filter((c) => c.purpose === 'diary-plan').pop() ?? null;
      const composeCall = mine.filter((c) => c.purpose === 'reply' && c.text !== null).pop() ?? null;

      // The plan as the turn built it: the planner's JSON with the kind forced, validated against the one kind offered.
      let answer = null;
      if (planCall?.text) {
        try {
          answer = parseJsonObject(planCall.text);
        } catch {
          answer = null;
        }
      }
      if (answer && typeof answer === 'object' && !Array.isArray(answer)) answer = { ...answer, kind };
      const pictureAllowed = result?.outcome !== 'refused' || result?.reason !== 'pictures';
      const validated = validatePlan(
        answer,
        { [kind]: 1 },
        { pictureAllowed, searchKinds: config.diary?.searchKinds, pictureKinds: config.diary?.pictureKinds },
        rng
      );
      const plan = topic ? { ...validated, topic } : validated;

      // The compose answer as runTurn reads it for a diary post.
      let draw = null;
      let messages = [];
      if (composeCall?.text) {
        // The post's picture is her draw.create call (a tool call of the native transport, a block of the text one).
        const split = mods.answerOf(
          { text: composeCall.text, toolCalls: composeCall.toolCalls ?? [], finishReason: composeCall.finishReason },
          { transport: mods.transportOf(hot.config) }
        );
        const parsed = parseOutput(split.speechText);
        const live = hot.config;
        messages = parsed.messages.map((m) => m.text);
        if (live.features?.multiMessage === false) messages = messages.slice(0, 1);
        if (live.format?.stripDashes !== false) messages = messages.map(stripDashes).filter((t) => t !== '');
        messages = messages
          .map(stripUrls)
          .filter((t) => t !== '')
          .slice(0, Math.max(0, live.diary?.maxMessages ?? 3));
        const drawCall = split.calls.find((call) => call.name === 'draw.create' && !call.problem);
        draw = drawCall
          ? {
              text: String(drawCall.args.text ?? ''),
              self: drawCall.args.self === true || drawCall.args.self === 'true',
            }
          : null;
      }
      const brief = {
        kind,
        plan,
        self: draw ? draw.self === true : null,
        request: draw ? draw.text : null,
        messages,
        outcome: result?.outcome ?? null,
        ...(result?.reason ? { reason: result.reason } : {}),
        ...(planCall?.error ? { planError: planCall.error } : {}),
      };
      briefs.push(brief);
      if (outFile !== null) {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, `${JSON.stringify(briefs, null, 1)}\n`);
      }
      log.info('replay-cli: diary brief', {
        n,
        outcome: brief.outcome,
        planFallback: plan.fallback ?? null,
        self: brief.self,
        requestChars: brief.request ? brief.request.length : 0,
        requests: mine.length,
      });
    }
    const withDraw = briefs.filter((b) => b.request).length;
    const stopped = Boolean(signal?.aborted);
    const code = withDraw === 0 || stopped ? 1 : 0;
    if (outFile === null) return { code, result: briefs };
    return {
      code,
      result: {
        out: outFile,
        kind,
        topic: Boolean(topic),
        prompts: args.prompts !== null,
        briefs: briefs.length,
        withDraw,
        stopped,
        usage,
      },
    };
  } finally {
    if (layered) {
      layered.hot.close();
      fs.rmSync(layered.dir, { recursive: true, force: true });
    }
    if (client && typeof client.destroy === 'function') await Promise.resolve(client.destroy()).catch(() => {});
  }
}

// ---- an inner turn (--inner) ----------------------------------------------------

/**
 * `hot` as an `--inner` turn sees it: `features.innerLife` on and `innerLife.mode` forced to
 * `shadow` (her reads run, nothing else does), `features.dryRun` off (shadow keeps everything in;
 * a dry run would not run her tool loop), `features.journal` off (nothing is journalled), the
 * dry-run mirror off. Every other value as the config read has it; the live config untouched.
 */
export function innerReplayHot(hot) {
  return new Proxy(hot, {
    get(target, prop) {
      if (prop === 'config') {
        const config = target.config ?? {};
        return {
          ...config,
          features: { ...(config.features ?? {}), innerLife: true, dryRun: false, journal: false },
          bot: { ...(config.bot ?? {}), dryRunChannelId: '' },
          innerLife: { ...(config.innerLife ?? {}), mode: 'shadow' },
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * The wake an `--inner` turn runs for, as the scheduler's drain builds it
 * (src/behavior/inner.js#createInnerLife): the intention's wake (`intention`, for
 * `intention_due` / `errand_deadline`) or the day's review, the budgets from `state` (the guild's
 * inner.json as read) under `settings`, the review's channel names. `inner` is
 * src/behavior/inner.js's module. Pure.
 * @returns {{ wake: object, info: object }}
 */
export function innerReplayWake({
  inner,
  kind,
  intention = null,
  state,
  settings,
  now,
  timezone,
  day,
  channelNames = [],
}) {
  const wake =
    kind === 'review'
      ? inner.reviewWake(day, now)
      : inner.wakeOfDue({
          intention,
          reason: kind === 'errand_deadline' ? 'wait-deadline' : 'due',
          at: Number.isFinite(intention?.dueAt) ? intention.dueAt : now,
        });
  const chain = inner.chainBudget(state, wake.chainId, settings.caps.perChain, { now, timezone });
  return {
    wake,
    info: {
      kind: wake.kind,
      items: [{ kind: wake.kind, reason: wake.reason, intentionIds: wake.intentionIds, taskId: wake.taskId ?? null }],
      intentions: intention ? [intention] : [],
      now,
      timezone,
      channels: kind === 'review' ? channelNames : [],
      budgets: { chain },
      chainId: wake.chainId,
    },
  };
}

/** The guild's intention stores with every write refused (`read-only`): an expiry sweep writes nothing. */
function readOnlyIntentionStores(stores) {
  return {
    get(guildId) {
      const store = stores.get(guildId);
      if (!store) return null;
      return new Proxy(store, {
        get(target, prop) {
          if (prop === 'add' || prop === 'update') return () => ({ ok: false, code: 'read-only' });
          if (prop === 'forgetUser' || prop === 'wipe')
            return () => {
              throw new Error('replay-cli: intentions are read-only here');
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}

/** The tag names of a request's user text, in order, each once. */
function blockNames(text) {
  return [...new Set([...String(text).matchAll(/^<([a-z_]+)>$/gm)].map((match) => match[1]))];
}

/**
 * The journal of `--inner`, read functions only (`read`, `findTurn`, `timeline`) over the data
 * directory the run reads: a simulated `memory.journal.read` returns the real records, and
 * nothing can be written (no `system`, no `start`).
 * @param {object} journal  From src/memory/journal.js#createJournal.
 */
export function readOnlyJournal(journal) {
  return { read: journal.read, findTurn: journal.findTurn, timeline: journal.timeline };
}

/**
 * The ids `--hide-channel` / `--hide-message` name, as sets (an experiment: salient items removed from a frozen moment).
 * @param {{ hideChannels?: string[], hideMessages?: string[] }} args  From parseArgs.
 * @returns {{ channels: Set<string>, messages: Set<string>, any: boolean }}
 */
export function hideSetsOf(args = {}) {
  const channels = new Set((args.hideChannels ?? []).map(String));
  const messages = new Set((args.hideMessages ?? []).map(String));
  return { channels, messages, any: channels.size > 0 || messages.size > 0 };
}

/** True when a record line is in a hidden channel or is (or was made of) a hidden message. */
function recordLineHidden(line, hide) {
  const channel = line?.scope?.channel;
  if (typeof channel === 'string' && hide.channels.has(channel)) return true;
  if (typeof line?.messageId === 'string' && hide.messages.has(line.messageId)) return true;
  return Array.isArray(line?.sourceMessageIds) && line.sourceMessageIds.some((id) => hide.messages.has(String(id)));
}

/**
 * The record with the hidden channels' and messages' lines left out of what it iterates (every other method
 * passes through). Nothing is written; the real record is only read.
 */
export function hiddenRecord(record, hide) {
  if (!hide?.any || !record) return record;
  return new Proxy(record, {
    get(target, prop) {
      if (prop === 'iterate') {
        return async function* iterate(...args) {
          for await (const line of target.iterate(...args)) if (!recordLineHidden(line, hide)) yield line;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The places list without the hidden channels (the channel directory is another list and stays whole). */
export function hiddenPlaces(places, hide) {
  if (!hide?.any || typeof places !== 'function') return places;
  return (...args) => places(...args).filter((entry) => !hide.channels.has(String(entry?.id)));
}

/**
 * The heartbeat's wake, built by the scheduler itself: a real inner life (src/behavior/inner.js#createInnerLife)
 * over a throwaway data directory holding a copy of the guild's inner.json (`dataDir` is only read), the
 * stores and sources it was given, the heartbeat wake queued for `now` and one drain; its turn runner only
 * records what it was handed (the `<wake>` facts, the conversation, the current channel) and ends the turn
 * as a skip. So the facts are the ones the live heartbeat would carry now (heartbeat-view.js over the
 * stores). Nothing is written under `dataDir`; the throwaway directory is removed. A CliError when the drain
 * ran no turn (stopped, paused, no conversation).
 * @param {object} input
 * @param {object} input.inner  src/behavior/inner.js's module.
 * @param {object} input.hot
 * @param {string} input.dataDir
 * @param {string} input.guildId
 * @param {number} input.now
 * @param {object} [input.deps]  The createInnerLife options besides hot, dataDir and turns:
 *   intentions, record, journal (reads only), places, nameOf, reads, iface, store, heartbeat.
 * @param {string} [input.tmpRoot]  Where the throwaway directory is made (default the OS temp directory).
 * @param {object} [input.log]
 * @returns {Promise<{ info: object, conversation: { iface: string, conversationId: string }, currentChannel: string|null }>}
 */
export async function heartbeatReplayWake({
  inner,
  hot,
  dataDir,
  guildId,
  now,
  deps = {},
  tmpRoot = os.tmpdir(),
  log = { info() {}, warn() {} },
}) {
  const scratch = fs.mkdtempSync(path.join(tmpRoot, 'replay-heartbeat-'));
  try {
    const stateFile = path.join(dataDir, 'guilds', String(guildId), 'inner.json');
    if (fs.existsSync(stateFile)) {
      // A copy with the kill switch lifted (a stopped life would queue nothing; a preview is wanted anyway).
      const kept = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      fs.mkdirSync(path.join(scratch, 'guilds', String(guildId)), { recursive: true });
      fs.writeFileSync(
        path.join(scratch, 'guilds', String(guildId), 'inner.json'),
        JSON.stringify({ ...kept, stopped: false })
      );
    }
    let seen = null;
    const life = inner.createInnerLife({
      ...deps,
      hot,
      dataDir: scratch,
      turns: {
        runTurn: async (turn) => {
          seen = {
            info: turn.inner.wake,
            conversation: turn.conversation,
            currentChannel: turn.inner.currentChannel ?? null,
          };
          return { outcome: 'skip', reason: 'replay-capture' };
        },
      },
      getGuildId: () => guildId,
      journal: deps.journal ?? null,
      now: () => now,
      rng: () => 0.5,
      log,
    });
    const queued = life.onWake({
      kind: 'inner.wake',
      at: now,
      id: `inner.wake:heartbeat:${now}`,
      guildId,
      wake: inner.heartbeatWake(now),
    });
    if (queued?.status !== 'queued')
      throw new CliError(`replay-cli: the heartbeat wake was not queued (${queued?.status ?? 'unknown'})`);
    const drained = await life.drain(guildId);
    if (!seen) {
      const why =
        drained?.deferred ??
        drained?.refused ??
        (drained?.dropped ? 'no conversation (no channel she spoke in lately that she can write in)' : 'nothing ran');
      throw new CliError(`replay-cli: the scheduler would not run the heartbeat now: ${why}`);
    }
    return seen;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * One reply of an `--inner` run, as the report shows it: her `<think>` whole, her messages, her tool calls with
 * their arguments (a drawing is a `draw.create` call), her reactions, gif, whether she skipped. `tools` gives
 * the transport's side of the answer (`{ answerOf, transport, toolCalls, finishReason }`: src/behavior/turn.js#answerOf
 * splits the text into speech and calls); without it the text is read as speech only. Pure.
 * @param {string|null} text  The raw reply.
 * @param {Function} parseOutput  src/llm/parse.js#parseOutput.
 * @param {string|null} [failedCode]  The failure code when the model request of this step failed (no reply).
 * @param {{ answerOf?: Function, transport?: string, toolCalls?: object[]|null, finishReason?: string|null }|null} [tools]
 */
export function innerAnswerOf(text, parseOutput, failedCode = null, tools = null) {
  if (failedCode) {
    // The request itself failed: no answer exists, and an empty one would read as her choosing to skip.
    return {
      failed: { code: String(failedCode) },
      think: '',
      messages: [],
      calls: [],
      reactions: [],
      gif: null,
      skip: false,
      text: '',
    };
  }
  const split =
    typeof tools?.answerOf === 'function'
      ? tools.answerOf(
          { text: String(text ?? ''), toolCalls: tools.toolCalls ?? [], finishReason: tools.finishReason ?? null },
          { transport: tools.transport ?? 'native' }
        )
      : { speechText: String(text ?? ''), calls: [] };
  const parsed = parseOutput(split.speechText);
  return {
    think: parsed.think,
    messages: parsed.messages.map((message) => message.text),
    calls: split.calls.map((call) => ({
      skill: call.name,
      args: call.args,
      ...(call.problem ? { problem: call.problem } : {}),
    })),
    reactions: parsed.reactions,
    gif: parsed.gif,
    skip: parsed.skip,
    text: String(text ?? ''),
  };
}

/**
 * The Markdown report of an `--inner` result (`runInner`'s): the `<wake>` block once, then per sample her think,
 * her answer, the actions and the cost. Pure.
 * @param {object} result
 * @returns {string}
 */
export function innerReportMarkdown(result) {
  const fence = (text) => `~~~\n${String(text ?? '')}\n~~~`;
  const lines = [
    `# Inner turn: ${result.kind}${result.intention ? ` (${result.intention})` : ''}`,
    '',
    `Channel: ${result.channelId ?? '-'}`,
    '',
  ];
  if (result.hidden && (result.hidden.channels?.length > 0 || result.hidden.messages?.length > 0))
    lines.push(
      `Hidden channels: ${(result.hidden.channels ?? []).join(', ') || '-'}`,
      `Hidden messages: ${(result.hidden.messages ?? []).join(', ') || '-'}`,
      ''
    );
  if (result.wake) lines.push('## wake', '', fence(result.wake), '');
  if (result.request?.messages)
    lines.push('## request', '', fence(JSON.stringify(result.request.messages, null, 2)), '');
  (result.samples ?? []).forEach((sample, index) => {
    const failedSteps = sample.answers.filter((answer) => answer.failed).length;
    const lastFailed = sample.answers.at(-1)?.failed ?? null;
    lines.push(
      `## Sample ${index + 1}`,
      '',
      `Outcome: ${sample.outcome ?? '-'}${sample.reason ? ` (${sample.reason})` : ''}${lastFailed ? `; ended in error (${lastFailed.code})` : ''}`,
      ''
    );
    if (failedSteps > 0)
      lines.push(
        `Failed steps: ${failedSteps} of ${sample.answers.length} (the model request failed; these are not her answers)`,
        ''
      );
    sample.answers.forEach((answer, step) => {
      if (answer.failed) {
        lines.push(`### Step ${step + 1}: error (${answer.failed.code})`, '');
        return;
      }
      lines.push(`### Answer ${step + 1}`, '', 'think:', '', fence(answer.think || '(none)'), '');
      if (answer.messages.length > 0)
        lines.push('messages:', '', ...answer.messages.map((message) => `- ${message.replace(/\n/g, '\n  ')}`), '');
      if (answer.calls.length > 0) lines.push('calls:', '', fence(JSON.stringify(answer.calls, null, 2)), '');
      if (answer.reactions?.length > 0) lines.push('reactions:', '', fence(JSON.stringify(answer.reactions)), '');
      if (answer.gif) lines.push('gif:', '', fence(JSON.stringify(answer.gif)), '');
      if (answer.skip) lines.push('skip', '');
    });
    lines.push(
      'actions:',
      '',
      sample.actions.length > 0 ? fence(JSON.stringify(sample.actions, null, 2)) : '(none)',
      ''
    );
    lines.push(
      `posted: ${sample.posted}; requests: ${sample.usage.requests}; tokens: ${sample.usage.promptTokens} in, ${sample.usage.completionTokens} out; cost: ${Number(sample.usage.cost ?? 0).toFixed(4)} USD`,
      ''
    );
  });
  lines.push(
    `Total cost: ${Number(result.usage?.cost ?? 0).toFixed(4)} USD${result.stopped ? ` (stopped: ${result.stopped})` : ''}`,
    ''
  );
  return lines.join('\n');
}

/**
 * The `--inner` mode (see the header): one inner turn for one wake (`--samples` times), in shadow, against the
 * live data (or `--snapshot`) read only. Returns `{ code, result }`.
 */
async function runInner({ args, root, load, hot: liveHot, createHot, loadDotEnv, log, budget = null }) {
  const mods = {
    ...(await loadDiaryMods(load)),
    ...(await load('behavior/inner.js')),
    ...(await load('intentions/store.js')),
    ...(await load('intentions/service.js')),
    ...(await load('errands/store.js')),
    ...(await load('memory/append-store.js')),
    ...(await load('memory/record.js')),
    ...(await load('memory/journal.js')),
    ...(await load('admin.js')),
    ...(await load('skills/registry.js')),
    ...(await load('behavior/prompt.js')),
  };
  await load('ops/index.js');
  const { createJournal } = await load('memory/journal.js');
  const { grantedSkillNames } = await load('skills/discovery.js');
  const { PROFILES: AGENT_PROFILES } = await load('agent-runner/profiles.js');
  const { deepMerge } = await load('config.js');
  const {
    createStore,
    createCalibrator,
    createLlm,
    resolveGuild,
    createFakeAdapter,
    createIntentionStores,
    createIntentionService,
    createTaskStore,
    createAppendStore,
    createRecord,
    createAdmin,
    skillRegistry,
    userText,
  } = mods;
  const liveData = defaultDataDir(root);
  const dataDir = args.snapshot !== null ? path.resolve(root, args.snapshot) : liveData;
  if (!fs.existsSync(dataDir)) throw new CliError(`replay-cli: no data directory at ${dataDir}`);
  const outFile = args.outDir !== null ? path.resolve(root, args.outDir) : null;
  if (outFile !== null && [liveData, dataDir].some((dir) => outFile === dir || outFile.startsWith(`${dir}${path.sep}`)))
    throw new CliError('replay-cli: --out may not be under data/');

  loadDotEnv(privateDirOf(root));
  const discordToken = process.env.DISCORD_TOKEN;
  if (!discordToken) throw new CliError('replay-cli: DISCORD_TOKEN is not set (.env)');
  const openrouterKey = simKey('replay-cli');

  let layered = null;
  let client = null;
  try {
    if (args.prompts !== null) {
      layered = overlayPromptsHot(createHot, root, args.prompts, { mergeJson: deepMerge });
      log.info('replay-cli: inner prompt layers', { layers: diaryPromptLayers(root, args.prompts).length });
    }
    const hot = innerReplayHot(layered?.hot ?? liveHot);
    const config = hot.config;
    const settings = mods.innerSettings(config);
    const timezone = config.bot?.timezone ?? 'UTC';
    const { store, state } = unflushedStore(createStore({ dataDir, memoryDb: memoryFor(dataDir) }));
    const calibrator = createCalibrator(state.data.calibration);
    const realLlm = createLlm({ apiKey: openrouterKey, getConfig: () => hot.config, calibrator, state });
    const calls = [];
    const requests = [];
    const recorded = recordingLlm(realLlm, calls, { noCache: true, errorCodeOf: mods.errorCodeOf });
    const llm = new Proxy(recorded, {
      get(target, prop) {
        if (prop === 'complete') {
          return (messages, options = {}) => {
            requests.push({ purpose: options?.purpose ?? null, messages });
            return target.complete(messages, options);
          };
        }
        return Reflect.get(target, prop, target);
      },
    });

    // Discord over REST, every write refused; anything the turn would post goes to an in-memory port.
    const discord = createRequire(path.join(root, 'package.json'))('discord.js');
    const connection = await connectDiscord({
      discord,
      token: discordToken,
      configuredGuildId: config.bot?.guildId || '',
      resolveGuild,
      log,
    });
    client = connection.client;
    const { guildId, self } = connection;
    const queueRequest = client.rest.queueRequest.bind(client.rest);
    client.rest.queueRequest = (request) => {
      const method = String(request?.method ?? 'GET').toUpperCase();
      if (method !== 'GET') return Promise.reject(new Error(`replay-cli: Discord ${method} refused (read-only tool)`));
      return queueRequest(request);
    };
    const hide = hideSetsOf(args);
    const capabilities = mods.createDiscordInterface({ client }).capabilities;
    // What the turn and the scheduler read of the interface, minus what the run hides.
    const discordPort = mods.createDiscordInterface({ client, config: () => hot.config }).port;
    const reads = hiddenReads(mods.createReads(discordPort, log), hide);

    // Her intentions and errands, read only; her inner state as it stands.
    const taskStore = createTaskStore({
      guildId,
      config: () => hot.config,
      journal: null,
      memoryDb: memoryFor(dataDir),
    });
    const errands = {
      view: ({ privateChannelId = null } = {}) =>
        [...taskStore.open(), ...taskStore.unseen()].filter(
          (task) =>
            task.scope !== 'dm' || (privateChannelId !== null && task.origin?.channelId === String(privateChannelId))
        ),
      markSeen: () => {},
      budget: ({ agent }) => taskStore.budget(agent),
      store: () => taskStore,
    };
    const intentions = createIntentionService({
      stores: readOnlyIntentionStores(createIntentionStores({ memoryDb: memoryFor(dataDir) })),
      hot,
      tasks: { store: () => taskStore },
      getGuildId: () => guildId,
    });
    let innerState = mods.emptyState();
    try {
      innerState = mods.normalizeState(
        JSON.parse(fs.readFileSync(path.join(dataDir, 'guilds', guildId, 'inner.json'), 'utf8'))
      );
    } catch (err) {
      if (err?.code !== 'ENOENT')
        log.warn('replay-cli: inner.json unreadable, budgets from an empty state', { code: err?.code ?? 'parse' });
    }

    const now = Date.now();
    let intention = null;
    let conversation = null;
    let info = null;
    let currentChannel;
    if (args.inner === 'heartbeat') {
      // The scheduler builds it: the heartbeat view over the stores as they are, in the conversation it picks.
      if (!settings.heartbeat.enabled)
        log.warn('replay-cli: innerLife.heartbeat.enabled is off; the live scheduler would not wake her', {});
      // A pause of hers would hold the live drain; a preview is wanted anyway (the copy of the store is not written).
      if (state.data.paused)
        log.warn('replay-cli: she is paused; the live scheduler would hold the heartbeat, the preview runs it', {});
      const schedulerStore = new Proxy(store, {
        get(target, prop) {
          if (prop === 'state') return { ...state, data: { ...state.data, paused: false } };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const record = hiddenRecord(createRecord({ dataDir, log, memoryDb: memoryFor(dataDir) }), hide);
      const journalRead = createJournal({ dataDir, config: () => ({}), log, memoryDb: memoryFor(dataDir) });
      const caught = await heartbeatReplayWake({
        inner: mods,
        hot,
        dataDir,
        guildId,
        now,
        log,
        deps: {
          intentions,
          record,
          journal: { read: (...a) => journalRead.read(...a) },
          places: hiddenPlaces((id) => {
            const guild = client.guilds.cache.get(String(id));
            if (!guild) return [];
            return capabilities.channelDirectoryOf(guild, hot.config.bot).map((entry) => {
              let writable = null;
              try {
                const found = guild.channels.cache.get(entry.id);
                writable = found ? capabilities.canSend(found) : null;
              } catch {
                writable = null;
              }
              return { id: entry.id, name: entry.name, writable };
            });
          }, hide),
          nameOf: (id, memberId) => store.getUser(id, memberId)?.names?.[0] ?? null,
          reads,
          iface: () => discordPort.iface,
          store: schedulerStore,
          heartbeat: {
            tasks: () => taskStore.recent(100),
            skills: () => grantedSkillNames({ config: hot.config, selfId: self.id, registry: skillRegistry() }),
            agents: () => Object.keys(AGENT_PROFILES),
            selfId: () => self.id,
          },
        },
      });
      ({ info, conversation, currentChannel } = caught);
    } else {
      let channelIds = [];
      if (args.inner !== 'review') {
        intention = intentions.store(guildId)?.get(args.intention) ?? null;
        if (!intention) throw new CliError(`replay-cli: no intention ${args.intention}`);
        if (!['pending', 'waiting'].includes(intention.status))
          log.warn('replay-cli: the intention is not open; the scheduler would not wake her for it', {
            status: intention.status,
          });
        const privateChat = intention.provenance?.scope === 'dm';
        const target = privateChat
          ? intention.provenance?.channelId
          : (intention.destination ?? intention.provenance?.channelId);
        if (target) channelIds = [String(target)];
      } else {
        channelIds = innerState.review?.channels ?? [];
        if (channelIds.length === 0) {
          const record = hiddenRecord(createRecord({ dataDir, log, memoryDb: memoryFor(dataDir) }), hide);
          const from = new Date(now - settings.review.historyDays * 86_400_000).toISOString();
          const own = [];
          for await (const line of record.iterate(guildId, { from }))
            if (line?.kind === 'said' && typeof line.scope?.channel === 'string') own.push(line);
          own.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
          channelIds = [...new Set(own.map((line) => line.scope.channel))].slice(0, 3);
        }
      }
      for (const id of channelIds) {
        const found = await client.channels.fetch(id).catch(() => null);
        if (found) {
          conversation = conversationRef(found);
          break;
        }
      }
      if (!conversation)
        throw new CliError(
          'replay-cli: no conversation for this wake (its channel is gone, or she has no recent line)'
        );
      const channelNames = channelIds.map((id) => client.channels.cache.get(id)?.name ?? null).filter(Boolean);
      info = innerReplayWake({
        inner: mods,
        kind: args.inner,
        intention,
        state: innerState,
        settings,
        now,
        timezone,
        day: mods.zonedDay(now, timezone),
        channelNames,
      }).info;
    }

    // The engine, wired as src/index.js wires it: her skills through a real admin over the copies.
    const port = createFakeAdapter({
      iface: 'discord',
      selfId: self.id,
      now: Date.now,
      capabilities: { maxFileBytes: 64 * 1024 * 1024 },
    });
    const admin = createAdmin({
      hot,
      store,
      client,
      discord: capabilities,
      port,
      intentions,
      errands,
      journal: readOnlyJournal(createJournal({ dataDir, config: () => ({}), log, memoryDb: memoryFor(dataDir) })),
      getGuildId: () => guildId,
      dataDir: null,
    });
    const turns = diaryTurnRunner(mods, {
      hot,
      store,
      llm,
      calibrator,
      client,
      guildId,
      self,
      images: null,
      state,
      port,
      wrapReads: (found) => hiddenReads(found, hide),
      extra: {
        skills: skillRegistry(),
        runOp: admin.runSkillOp,
        runOwnOp: admin.runOwnSkillOp,
        runInitiativeOp: admin.runInitiativeSkillOp,
        intentions,
        errands,
      },
    });
    log.info('replay-cli: inner ready', {
      guildId,
      channelId: conversation.conversationId,
      kind: args.inner,
      intention: intention?.id ?? null,
      samples: args.samples,
    });

    const samples = [];
    let firstRequest = null;
    let total = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    let stopped = null;
    let lastCost = 0;
    let code = 0;
    let posted = 0;
    for (let n = 0; n < args.samples; n += 1) {
      // The same request again, independent runs; none starts when its expected cost would pass --spend.
      if (n > 0 && budget !== null && total.cost + lastCost > budget) {
        stopped = 'spend';
        break;
      }
      requests.length = 0;
      calls.length = 0;
      let result;
      try {
        result = await turns.runTurn({
          conversation,
          guildId,
          mode: 'inner',
          triggerKind: 'inner',
          inner: {
            wake: structuredClone(info),
            shadow: true,
            mayAct: () => false,
            ...(args.inner === 'heartbeat' ? { currentChannel } : {}),
          },
        });
      } catch (err) {
        result = { outcome: 'error', reason: `${err?.name ?? 'Error'}: ${err?.message ?? err}` };
      }
      const replies = requests.filter((request) => request.purpose === 'reply');
      if (n === 0)
        firstRequest = {
          text: replies[0] ? userText(replies[0].messages[1]?.content) : '',
          messages: replies[0]?.messages ?? null,
        };
      const usage = addUsage({ requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 }, calls);
      total = {
        requests: total.requests + usage.requests,
        promptTokens: total.promptTokens + usage.promptTokens,
        completionTokens: total.completionTokens + usage.completionTokens,
        cost: total.cost + usage.cost,
      };
      lastCost = usage.cost;
      const sent = port.calls.filter((call) => call.op === 'send').length;
      if (result?.outcome === 'error') code = 1;
      const answers = calls
        .filter((call) => call.purpose === 'reply')
        .map((call) =>
          innerAnswerOf(call.text, mods.parseOutput, call.error ? (call.code ?? 'error') : null, {
            answerOf: mods.answerOf,
            transport: mods.transportOf(hot.config),
            toolCalls: call.toolCalls,
            finishReason: call.finishReason,
          })
        );
      samples.push({
        outcome: result?.outcome ?? null,
        reason: result?.reason ?? null,
        failedSteps: answers.filter((answer) => answer.failed).length,
        ...(answers.at(-1)?.failed ? { endedInError: answers.at(-1).failed.code } : {}),
        answers,
        actions: result?.inner?.actions ?? [],
        posted: sent - posted,
        usage,
      });
      posted = sent;
    }
    const blocks = {};
    for (const tag of ['wake', 'intentions', 'tasks', 'retrieved', 'task']) {
      const whole = blockOf(firstRequest?.text ?? '', tag);
      if (whole) blocks[tag] = whole;
    }
    const report = {
      kind: args.inner,
      intention: intention?.id ?? null,
      channelId: conversation.conversationId,
      hidden: hide.any ? { channels: [...hide.channels], messages: [...hide.messages] } : null,
      wake: blocks.wake ?? null,
      request: {
        blocks: blockNames(firstRequest?.text ?? ''),
        ...blocks,
        ...(args.showRequest && firstRequest?.messages ? { messages: firstRequest.messages } : {}),
      },
      samples,
      usage: total,
      ...(stopped ? { stopped } : {}),
    };
    const markdown = innerReportMarkdown(report);
    if (outFile !== null) {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, markdown);
    }
    process.stderr.write(`${markdown}\n`);
    return { code, result: report };
  } finally {
    if (layered) {
      layered.hot.close();
      fs.rmSync(layered.dir, { recursive: true, force: true });
    }
    if (client && typeof client.destroy === 'function') await Promise.resolve(client.destroy()).catch(() => {});
  }
}

// ---- a diary day (--diary-day) ---------------------------------------------------

/**
 * `hot` as a `--diary-day` turn sees it: `features.dryRun` off (its branch generates no
 * picture: the posts go to an in-memory port instead), `features.typingSimulation` off (no
 * waits) and `bot.dryRunChannelId` empty; everything else read from `hot` at use.
 * @param {object} hot  From src/hot.js#createHot.
 */
export function noPostHot(hot) {
  return new Proxy(hot, {
    get(target, prop) {
      if (prop === 'config') {
        const config = target.config ?? {};
        return {
          ...config,
          features: { ...(config.features ?? {}), dryRun: false, typingSimulation: false },
          bot: { ...(config.bot ?? {}), dryRunChannelId: '' },
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * The OpenRouter key of a `--diary-day` run: with `--draw live` OPENROUTER_SIM_KEY only (a
 * CliError without it: live pictures never fall back to the bot's key), else the tools' slot
 * (tools/lib/cli.mjs#simKey). Never printed.
 * @param {string} draw
 * @param {Record<string, string|undefined>} [env]
 */
export function diaryDayKey(draw, env = process.env) {
  if (draw !== 'live') return simKey('replay-cli', env);
  const key = env.OPENROUTER_SIM_KEY;
  if (typeof key !== 'string' || key.trim() === '')
    throw new CliError("replay-cli: --draw live needs OPENROUTER_SIM_KEY (.env); it never spends the bot's key");
  return key;
}

/** The file extension of a picture's media type. */
function pictureExtension(mediaType) {
  const sub = String(mediaType ?? '').split('/')[1] ?? '';
  if (sub === 'jpeg') return 'jpg';
  return /^[a-z0-9]{1,8}$/.test(sub) ? sub : 'png';
}

/**
 * The plan and the spend gate of a `--diary-day` run, before anything is read or sent: the
 * local date (`args.date`, else the day of `nowMs` in `bot.timezone`), the seed (`args.seed`,
 * else a fresh one), the seeded day plan (tools/lib/diary-day.mjs#planDiaryDay over `config`),
 * its estimate (DIARY_REQUESTS_PER_BRIEF requests per slot at ~USD_PER_ANSWER, the live pictures
 * on top) and tools/lib/cli.mjs#spendGate's verdict on `args.spend`: a refusal is a CliError
 * with exit code REFUSED_EXIT. Returns `{ timezone, date, seed, day, estimate, gate }`.
 * @param {object} args  From parseArgs.
 * @param {object} config  The live config (hot.config).
 * @param {{ planDay: Function, zonedEpoch: Function, localDayKey: Function }} mods  src/behavior/diary.js, src/time.js.
 * @param {number} [nowMs]
 */
export function diaryDayGate(args, config, { planDay, zonedEpoch, localDayKey }, nowMs = Date.now()) {
  const timezone = config?.bot?.timezone || 'UTC';
  const date = args.date ?? localDayKey(nowMs, timezone);
  const seed = args.seed ?? randomBytes(6).toString('hex');
  const day = planDiaryDay({ diaryCfg: config?.diary, timezone, date, seed, planDay, zonedEpoch });
  const estimate = diaryDayEstimate({
    slots: day.slots.length,
    draw: args.draw,
    maxPictures: args.maxPictures ?? 0,
    requestsPerSlot: DIARY_REQUESTS_PER_BRIEF,
    usdPerRequest: USD_PER_ANSWER,
  });
  const gate = spendGate({
    estimateUsd: estimate.estimateUsd,
    requests: estimate.requests,
    spend: args.spend,
    detail: estimate.detail,
  });
  if (!gate.ok) throw new CliError(`replay-cli: ${gate.text}`, { exitCode: REFUSED_EXIT });
  return { timezone, date, seed, day, estimate, gate };
}

/**
 * The `--diary-day` mode (see the header): the seeded day plan, the spend gate, then every slot's
 * diary turn run to the end into an in-memory port, every drawing call recorded. Returns
 * `{ code, result }`.
 */
async function runDiaryDay({ args, root, load, hot: liveHot, loadDotEnv, log, signal }) {
  const mods = await loadDiaryMods(load);
  const { DIARY_DAILY, DIARY_PICTURES_DAILY, localDayKey, planDay } = mods;
  const {
    createStore,
    createCalibrator,
    createLlm,
    createImageGen,
    ImageCapError,
    canAttach,
    canSend,
    resolveGuild,
    createFakeAdapter,
  } = mods;
  const { parseJsonObject, countToday, zonedEpoch } = mods;

  // The day plan, before anything is read from Discord or sent: its slots are the estimate.
  const { timezone, date, seed, day, gate } = diaryDayGate(args, liveHot.config, { planDay, zonedEpoch, localDayKey });
  process.stderr.write(`replay-cli: ${gate.text}\n`);

  const liveData = defaultDataDir(root);
  if (!fs.existsSync(liveData)) throw new CliError(`replay-cli: no data directory at ${liveData}`);
  const outDir = path.resolve(
    root,
    args.outDir ?? `replay-diary-day-${new Date().toISOString().replace(/[:.]/g, '-')}`
  );
  if (outDir === liveData || outDir.startsWith(`${liveData}${path.sep}`))
    throw new CliError('replay-cli: --out may not be under data/');
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0)
    throw new CliError(`replay-cli: ${outDir} is not empty`);

  const report = {
    date,
    timezone,
    seed,
    draw: args.draw,
    quiet: day.quiet,
    plan: { slots: day.slots.map((at) => new Date(at).toISOString()), hunger: day.hunger },
    slots: [],
    usage: { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0, pictures: 0 },
    stopped: null,
  };
  const reportJson = path.join(outDir, 'report.json');
  const reportMd = path.join(outDir, 'report.md');
  const writeReport = () => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(reportJson, `${JSON.stringify(report, null, 1)}\n`);
    fs.writeFileSync(reportMd, renderDiaryDayReport(report));
  };
  const done = (code) => ({
    code,
    result: {
      out: outDir,
      report: reportJson,
      date,
      seed,
      draw: args.draw,
      quiet: day.quiet,
      slots: report.slots.map((slot) => ({
        n: slot.n,
        at: slot.at,
        outcome: slot.outcome,
        ...(slot.reason ? { reason: slot.reason } : {}),
        draws: slot.draws.length,
      })),
      usage: report.usage,
      stopped: report.stopped,
    },
  });
  if (day.slots.length === 0) {
    writeReport();
    log.info('replay-cli: diary day without a slot', { date, quiet: day.quiet });
    return done(0);
  }

  loadDotEnv(privateDirOf(root));
  const discordToken = process.env.DISCORD_TOKEN;
  if (!discordToken) throw new CliError('replay-cli: DISCORD_TOKEN is not set (.env)');
  const openrouterKey = diaryDayKey(args.draw);

  let client = null;
  try {
    const hot = noPostHot(liveHot);
    const config = hot.config;
    const diaryChannelId = config.diary?.channelId;
    if (!diaryChannelId) throw new CliError('replay-cli: diary.channelId is not set');
    if (config.features?.diary === false)
      log.warn('replay-cli: features.diary is off; the live diary would not post', {});

    // The clock of the turn runner and the image client: the slot's instant, running on from there.
    const clock = { base: day.start, real: Date.now() };
    const now = () => clock.base + (Date.now() - clock.real);

    // The store and the counters: an in-memory copy, today's diary and image counts at 0.
    const { store, state } = unflushedStore(createStore({ dataDir: liveData, memoryDb: memoryFor(liveData) }));
    state.data[DIARY_DAILY.countKey] = 0;
    state.data[DIARY_PICTURES_DAILY.countKey] = 0;
    state.data.imageCount = 0;
    if (state.data.paused) log.warn('replay-cli: the bot is paused; every slot will answer paused', {});

    const calibrator = createCalibrator(state.data.calibration);
    const realLlm = createLlm({ apiKey: openrouterKey, getConfig: () => hot.config, calibrator, state });
    const calls = [];
    const llm = recordingLlm(realLlm, calls);
    const live = args.draw === 'live';
    const picturesDir = path.join(outDir, 'pictures');
    const realImages = createImageGen({
      apiKey: openrouterKey,
      getConfig: () => hot.config,
      state,
      now,
      ...(live ? {} : { fetchImpl: fixtureImagesFetch() }),
    });
    const images = recordingImages({
      images: realImages,
      ImageCapError,
      maxPictures: live ? args.maxPictures : null,
      onPicture: live
        ? (picture, index) => {
            fs.mkdirSync(picturesDir, { recursive: true });
            const file = path.join(picturesDir, `picture-${index}.${pictureExtension(picture.mediaType)}`);
            fs.writeFileSync(file, picture.buffer);
            return path.relative(outDir, file);
          }
        : null,
    });

    // Discord over REST, every write refused; the turn's posts go to an in-memory port.
    const discord = createRequire(path.join(root, 'package.json'))('discord.js');
    const connection = await connectDiscord({
      discord,
      token: discordToken,
      configuredGuildId: config.bot?.guildId || '',
      resolveGuild,
      log,
    });
    client = connection.client;
    const { guildId, self } = connection;
    const channel = await openDiaryChannel({ client, guildId, diaryChannelId, canSend, canAttach, log });
    const port = createFakeAdapter({
      iface: 'discord',
      selfId: self.id,
      now,
      capabilities: { maxFileBytes: 64 * 1024 * 1024 },
    });
    const turns = diaryTurnRunner(mods, {
      hot,
      store,
      llm,
      calibrator,
      client,
      guildId,
      self,
      images,
      state,
      port,
      rng: seededRng(seed, 'turns'),
      now,
    });
    log.info('replay-cli: diary day ready', {
      guildId,
      channelId: channel.id,
      date,
      slots: day.slots.length,
      draw: args.draw,
    });

    const budget = gate.budget;
    for (const [index, at] of day.slots.entries()) {
      if (signal?.aborted) {
        report.stopped = 'interrupted';
        break;
      }
      if (budget !== null && report.usage.cost >= budget) {
        report.stopped = 'spend';
        break;
      }
      clock.base = at;
      clock.real = Date.now();
      const slot = {
        n: index + 1,
        at: new Date(at).toISOString(),
        local: `${localDayKey(at, timezone)} ${new Date(at).toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' })}`,
        outcome: null,
        draws: [],
        messages: [],
        attachments: 0,
        requests: 0,
        cost: 0,
      };
      // The tick's own check: the day's posts under diary.maxPerDay.
      const cap = hot.config.diary?.maxPerDay ?? DEFAULT_DIARY_MAX_PER_DAY;
      if (countToday(state.data, DIARY_DAILY, now()) >= cap) {
        Object.assign(slot, { outcome: 'skip', reason: 'cap' });
        report.slots.push(slot);
        writeReport();
        continue;
      }
      const fromCalls = calls.length;
      const fromDraws = images.calls.length;
      const fromPort = port.calls.length;
      let result;
      try {
        result = await turns.runTurn({
          conversation: conversationRef(channel),
          mode: 'diary',
          diary: { kind: null, forced: false },
        });
      } catch (err) {
        result = { outcome: 'error', reason: `${err?.name ?? 'Error'}: ${err?.message ?? err}` };
      }
      const mine = calls.slice(fromCalls);
      const planCall = mine.filter((c) => c.purpose === 'diary-plan').pop() ?? null;
      let plan = null;
      if (planCall?.text) {
        try {
          plan = parseJsonObject(planCall.text);
        } catch {
          plan = null;
        }
      }
      const sends = port.calls
        .slice(fromPort)
        .filter((c) => c.op === 'send')
        .map((c) => c.args[1] ?? {});
      const draws = images.calls.slice(fromDraws);
      const pictureCost = draws.reduce((sum, d) => sum + (Number.isFinite(d.result?.cost) ? d.result.cost : 0), 0);
      const before = report.usage;
      const after = addUsage(before, mine);
      report.usage = {
        ...after,
        cost: Math.round((after.cost + pictureCost) * 10000) / 10000,
        pictures: before.pictures + draws.filter((d) => d.result && !d.result.error).length,
      };
      Object.assign(slot, {
        outcome: result?.outcome ?? null,
        ...(result?.reason ? { reason: result.reason } : {}),
        plan,
        ...(planCall?.error ? { planError: planCall.error } : {}),
        diary: result?.diary ?? null,
        messages: sends.map((content) => content.text).filter((text) => typeof text === 'string' && text !== ''),
        attachments: sends.reduce(
          (sum, content) => sum + (Array.isArray(content.attachments) ? content.attachments.length : 0),
          0
        ),
        draws,
        requests: mine.length,
        cost: Math.round((report.usage.cost - before.cost) * 10000) / 10000,
      });
      report.slots.push(slot);
      writeReport();
      log.info('replay-cli: diary slot', {
        n: slot.n,
        outcome: slot.outcome,
        draws: draws.length,
        requests: mine.length,
      });
    }
    writeReport();
    const failed = report.slots.some((slot) => slot.outcome === 'error');
    return done(failed || report.stopped !== null ? 1 : 0);
  } finally {
    if (client && typeof client.destroy === 'function') await Promise.resolve(client.destroy()).catch(() => {});
  }
}

// ---- skill scenarios (--skills) ----------------------------------------------------

/** The fields a scenario may have. */
const SCENARIO_KEYS = Object.freeze([
  'id',
  'channelId',
  'before',
  'author',
  'text',
  'steps',
  'taskResult',
  'grants',
  'runs',
  'result',
  'discovery',
]);
/** The fields of a task-result scenario's errand, and those of one of its files. */
const TASK_RESULT_KEYS = Object.freeze(['agent', 'goal', 'state', 'text', 'files', 'asker']);
const TASK_FILE_KEYS = Object.freeze(['name', 'contentType', 'bytes']);
/** The ends an errand's result turn follows (src/errands/store.js: a cancelled one opens none). */
const TASK_RESULT_STATES = Object.freeze(['done', 'failed']);
/** An agent's name (src/agent-runner/profiles.js: the profile's key), the longest result text, the most files. */
const AGENT_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_TASK_TEXT = 20_000;
const MAX_TASK_FILES = 10;
/** A file name a handle may carry (src/errands/store.js#parseFileHandle): no slash, no line break. */
const TASK_FILE_NAME = /^[^/\\\r\n]{1,200}$/;
/** The error code of a failed errand when it gives none (src/errands/store.js#finish's). */
const TASK_FAILED_CODE = 'failed';
/** The fields a step of a multi-step scenario may have, and those of a burst message. */
const STEP_KEYS = Object.freeze(['author', 'text', 'gapMinutes', 'burst', 'result', 'self']);
const BURST_KEYS = Object.freeze(['author', 'text', 'self']);
/** The most steps a scenario may have, and the most messages a burst adds. */
const MAX_STEPS = 20;
const MAX_BURST = 10;
/** A step's default distance from the line before it, and its longest (minutes): a week. */
const DEFAULT_GAP_MINUTES = 1;
const MAX_GAP_MINUTES = 7 * 24 * 60;
/** How far apart the messages of one step (its message, then its burst) come in. */
const BURST_SPACING_MS = 5_000;
const SCENARIO_ID = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_RUNS = 10;
/** Discord's longest message: the most a scenario's text or canned result may hold. */
const MAX_SCENARIO_TEXT = 4000;
/** The most skills a classifier's `skills:` line names (src/skills/discovery.js#MAX_PROPOSED). */
const MAX_DISCOVERY_NAMES = 4;
/** How long after the anchor message the invented one is written. */
const SCENARIO_AFTER_MS = 60_000;
/** Discord's epoch, for the invented message's id (a snowflake of its moment). */
const DISCORD_EPOCH = 1420070400000n;
/** A run's requests at most: her answer and the follow-up after a call. */
const SKILL_REQUESTS_PER_RUN = 2;

/**
 * The scenarios of a `--skills` file (`text`, its content): a non-empty JSON array of
 * `{ id, channelId, before?, author, text, grants, runs?, result?, discovery? }` -- `id` 1..64
 * of `A-Z a-z 0-9 . _ -`, unique; `channelId`, `author` and `before` (optional) message, channel
 * and member ids; `text` the invented message (1..4000 characters); `grants` a list of skill
 * names, groups or `*` (may be empty); `runs` 1..10 (default 1); `result` the text the
 * operation answers when a call passes (default ''); `discovery` `"inventory"` (default),
 * `"none"` or a list of 1..4 skill names. A multi-step scenario has `steps` instead of
 * `author` / `text`: 1..20 of `{ author?, text?, gapMinutes?, burst?, result? }` -- the step's
 * message (`author` and `text` together, or neither), then `burst`, 1..10 more `{ author, text }`
 * from anyone (at least one message per step), played as the live queue plays them (playSteps);
 * `gapMinutes` how long
 * after the line before it the step's first message comes (more than 0, at most a week, default
 * 1); `result` the text the operation answers in this step (default: the scenario's). A line of
 * the persona's own is seeded, no turn run for it (playSteps): a step `{ self: "<text>",
 * gapMinutes? }` (nothing else beside it), or a burst item `{ self: true, text }` (no author);
 * at least one step must hold a message that is not hers. Parsed, a step is `{ messages:
 * [{ author, text } | { self: true, text }], own, gapMinutes, result: string|null }` (`own`: its
 * first message is the step's own `author` / `text`, which tags the persona) and the scenario
 * has no `author` / `text`. A task-result scenario has `taskResult` instead of `author` /
 * `text` / `steps`: `{ agent, goal, state, text?, files?, asker }` -- `agent` an agent's name
 * (1..32 of `A-Z a-z 0-9 _ -`), `goal` what was asked (1..4000 characters), `state` `"done"` or
 * `"failed"`, `text` what it brought back (at most 20000 characters, default ''), `files` up to
 * 10 `{ name, contentType?, bytes? }` (a name of 1..200 characters without a slash or a line
 * break, unique; `contentType` text, default ''; `bytes` a whole number >= 0, default 0), `asker`
 * the member id who asked; its origin channel is the scenario's `channelId`. Parsed, it is
 * `{ agent, goal, state, text, files: [{ name, contentType, bytes }], asker }`. Any other field,
 * type or value is a CliError naming the scenario (and the step). Names are checked against the
 * registry later (scenarioGrants, scenarioDiscovery).
 * @param {string} text
 * @returns {{ id: string, channelId: string, before: string|null, author?: string, text?: string,
 *   steps?: { messages: ({ author: string, text: string } | { self: true, text: string })[], own: boolean, gapMinutes: number, result: string|null }[],
 *   taskResult?: { agent: string, goal: string, state: 'done'|'failed', text: string, files: { name: string, contentType: string, bytes: number }[], asker: string },
 *   grants: string[], runs: number, result: string, discovery: 'inventory'|'none'|string[] }[]}
 */
export function parseScenarios(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new CliError(`replay-cli: the scenario file is not JSON (${err.message})`);
  }
  if (!Array.isArray(data) || data.length === 0)
    throw new CliError('replay-cli: the scenario file must be a non-empty JSON array');
  const ids = new Set();
  return data.map((raw, index) => {
    const bad = (what) =>
      new CliError(`replay-cli: scenario ${index + 1}${typeof raw?.id === 'string' ? ` (${raw.id})` : ''}: ${what}`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('not an object');
    for (const key of Object.keys(raw)) if (!SCENARIO_KEYS.includes(key)) throw bad(`unknown field ${key}`);
    if (typeof raw.id !== 'string' || !SCENARIO_ID.test(raw.id))
      throw bad('id must be 1..64 characters of A-Z a-z 0-9 . _ -');
    if (ids.has(raw.id)) throw bad('the id is used twice');
    ids.add(raw.id);
    if (typeof raw.channelId !== 'string' || !SNOWFLAKE.test(raw.channelId))
      throw bad('channelId must be a channel id');
    if (
      raw.before !== undefined &&
      raw.before !== null &&
      (typeof raw.before !== 'string' || !SNOWFLAKE.test(raw.before))
    )
      throw bad('before must be a message id or omitted');
    const multi = raw.steps !== undefined;
    const errand = raw.taskResult !== undefined;
    if (errand && (multi || raw.author !== undefined || raw.text !== undefined))
      throw bad('taskResult replaces author, text and steps: give one or the other');
    if (multi && (raw.author !== undefined || raw.text !== undefined))
      throw bad('steps replace author and text: give one or the other');
    const steps = multi ? parseSteps(raw.steps, bad) : null;
    const taskResult = errand ? parseTaskResult(raw.taskResult, bad) : null;
    const single = !multi && !errand;
    if (single && (typeof raw.author !== 'string' || !SNOWFLAKE.test(raw.author)))
      throw bad('author must be a member id');
    if (single && !isScenarioText(raw.text)) throw bad(`text must be 1..${MAX_SCENARIO_TEXT} characters`);
    if (!Array.isArray(raw.grants) || raw.grants.some((g) => typeof g !== 'string' || !g.trim()))
      throw bad('grants must be a list of skill names, groups or "*"');
    const runs = raw.runs ?? 1;
    if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) throw bad(`runs must be a whole number 1..${MAX_RUNS}`);
    const result = raw.result ?? '';
    if (typeof result !== 'string' || result.length > MAX_SCENARIO_TEXT)
      throw bad(`result must be text of at most ${MAX_SCENARIO_TEXT} characters`);
    const discovery = raw.discovery ?? 'inventory';
    const named =
      Array.isArray(discovery) &&
      discovery.length >= 1 &&
      discovery.length <= MAX_DISCOVERY_NAMES &&
      discovery.every((n) => typeof n === 'string' && n.trim());
    if (discovery !== 'inventory' && discovery !== 'none' && !named)
      throw bad(`discovery must be "inventory", "none" or a list of 1..${MAX_DISCOVERY_NAMES} skill names`);
    return {
      id: raw.id,
      channelId: raw.channelId,
      before: raw.before ?? null,
      ...(multi ? { steps } : errand ? { taskResult } : { author: raw.author, text: raw.text }),
      grants: raw.grants.map((g) => g.trim()),
      runs,
      result,
      discovery: named ? discovery.map((n) => n.trim()) : discovery,
    };
  });
}

/** The `taskResult` of a task-result scenario (see parseScenarios), a CliError made by `bad` when wrong. */
function parseTaskResult(raw, bad) {
  const wrong = (what) => bad(`taskResult: ${what}`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw wrong('not an object');
  for (const key of Object.keys(raw)) if (!TASK_RESULT_KEYS.includes(key)) throw wrong(`unknown field ${key}`);
  if (typeof raw.agent !== 'string' || !AGENT_NAME.test(raw.agent)) throw wrong("agent must be an agent's name");
  if (!isScenarioText(raw.goal)) throw wrong(`goal must be 1..${MAX_SCENARIO_TEXT} characters`);
  if (!TASK_RESULT_STATES.includes(raw.state))
    throw wrong(`state must be ${TASK_RESULT_STATES.map((state) => `"${state}"`).join(' or ')}`);
  const text = raw.text ?? '';
  if (typeof text !== 'string' || text.length > MAX_TASK_TEXT)
    throw wrong(`text must be text of at most ${MAX_TASK_TEXT} characters`);
  const files = raw.files ?? [];
  if (!Array.isArray(files) || files.length > MAX_TASK_FILES)
    throw wrong(`files must be a list of at most ${MAX_TASK_FILES} files`);
  const names = new Set();
  const parsed = files.map((file, index) => {
    const where = `file ${index + 1}`;
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw wrong(`${where} is not an object`);
    for (const key of Object.keys(file))
      if (!TASK_FILE_KEYS.includes(key)) throw wrong(`${where}: unknown field ${key}`);
    if (
      typeof file.name !== 'string' ||
      !TASK_FILE_NAME.test(file.name) ||
      file.name.trim() !== file.name ||
      file.name === '.' ||
      file.name === '..'
    ) {
      throw wrong(`${where}: name must be 1..200 characters without a slash or a line break`);
    }
    if (names.has(file.name)) throw wrong(`${where}: the name is used twice`);
    names.add(file.name);
    const contentType = file.contentType ?? '';
    if (typeof contentType !== 'string' || contentType.length > 200) throw wrong(`${where}: contentType must be text`);
    const bytes = file.bytes ?? 0;
    if (!Number.isInteger(bytes) || bytes < 0) throw wrong(`${where}: bytes must be a whole number of 0 or more`);
    return { name: file.name, contentType, bytes };
  });
  if (typeof raw.asker !== 'string' || !SNOWFLAKE.test(raw.asker)) throw wrong('asker must be a member id');
  return { agent: raw.agent, goal: raw.goal, state: raw.state, text, files: parsed, asker: raw.asker };
}

/** Whether `value` is an invented message's text: 1..MAX_SCENARIO_TEXT characters, not blank. */
function isScenarioText(value) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_SCENARIO_TEXT;
}

/** The `steps` of a multi-step scenario (see parseScenarios), each a CliError made by `bad` when wrong. */
function parseSteps(steps, bad) {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS)
    throw bad(`steps must be a list of 1..${MAX_STEPS} steps`);
  const parsed = steps.map((step, index) => {
    const wrong = (what) => bad(`step ${index + 1}: ${what}`);
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw wrong('not an object');
    for (const key of Object.keys(step)) if (!STEP_KEYS.includes(key)) throw wrong(`unknown field ${key}`);
    const message = (item, where) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw wrong(`${where} is not an object`);
      for (const key of Object.keys(item)) if (!BURST_KEYS.includes(key)) throw wrong(`${where}: unknown field ${key}`);
      if (item.self !== undefined) {
        // A line of hers, seeded: no author, no turn run for it.
        if (item.self !== true) throw wrong(`${where}: self must be true`);
        if (item.author !== undefined) throw wrong(`${where}: a line of hers has no author`);
        if (!isScenarioText(item.text)) throw wrong(`${where}: text must be 1..${MAX_SCENARIO_TEXT} characters`);
        return { self: true, text: item.text };
      }
      if (typeof item.author !== 'string' || !SNOWFLAKE.test(item.author))
        throw wrong(`${where}: author must be a member id`);
      if (!isScenarioText(item.text)) throw wrong(`${where}: text must be 1..${MAX_SCENARIO_TEXT} characters`);
      return { author: item.author, text: item.text };
    };
    const seeded = step.self !== undefined;
    if (seeded && Object.keys(step).some((key) => key !== 'self' && key !== 'gapMinutes'))
      throw wrong('self takes only gapMinutes beside it');
    if (seeded && !isScenarioText(step.self)) throw wrong(`self must be 1..${MAX_SCENARIO_TEXT} characters`);
    const own = step.author !== undefined || step.text !== undefined;
    const messages = seeded
      ? [{ self: true, text: step.self }]
      : own
        ? [message({ author: step.author, text: step.text }, 'the message')]
        : [];
    if (step.burst !== undefined) {
      if (!Array.isArray(step.burst) || step.burst.length === 0 || step.burst.length > MAX_BURST)
        throw wrong(`burst must be a list of 1..${MAX_BURST} messages`);
      step.burst.forEach((item, i) => messages.push(message(item, `burst ${i + 1}`)));
    }
    if (messages.length === 0) throw wrong('needs author and text, or a burst');
    const gapMinutes = step.gapMinutes ?? DEFAULT_GAP_MINUTES;
    if (
      typeof gapMinutes !== 'number' ||
      !Number.isFinite(gapMinutes) ||
      gapMinutes <= 0 ||
      gapMinutes > MAX_GAP_MINUTES
    )
      throw wrong(`gapMinutes must be more than 0 and at most ${MAX_GAP_MINUTES}`);
    if (step.result !== undefined && (typeof step.result !== 'string' || step.result.length > MAX_SCENARIO_TEXT))
      throw wrong(`result must be text of at most ${MAX_SCENARIO_TEXT} characters`);
    return { messages, own, gapMinutes, result: step.result ?? null };
  });
  if (!parsed.some(runsTurn))
    throw bad('steps: needs at least one step that runs her turn (a message that is not hers)');
  return parsed;
}

/** Whether a parsed step runs her turn: it holds a message that is not a seeded line of hers. */
function runsTurn(step) {
  return Array.isArray(step?.messages) && step.messages.some((message) => message?.self !== true);
}

/**
 * The model requests a `--skills` file may send at most (the spend gate's estimate): up to
 * SKILL_REQUESTS_PER_RUN per decision -- her answer and the follow-up after a call -- and a
 * run is one decision, or for a multi-step scenario one per message of every step (each run
 * replays every step; every message of a burst may get its own turn, playSteps) -- a seeded
 * line of hers none: no turn is run for it. The caller doubles it for `--pair-prompts`.
 * @param {{ runs: number, steps?: { messages: object[] }[] }[]} scenarios  parseScenarios's.
 * @returns {number}
 */
export function skillRequestEstimate(scenarios, { perDecision = SKILL_REQUESTS_PER_RUN } = {}) {
  const turns = (step) =>
    Array.isArray(step.messages) ? step.messages.filter((message) => message?.self !== true).length : 1;
  const decisions = (scenario) =>
    Array.isArray(scenario.steps) ? scenario.steps.reduce((sum, step) => sum + turns(step), 0) : 1;
  return scenarios.reduce((total, scenario) => total + perDecision * scenario.runs * decisions(scenario), 0);
}

/** What a decision with her tool loop is expected to send beyond her reply: one follow-up step, one call before it. */
const EXPECTED_LOOP_STEPS = 1;
const EXPECTED_CALLS_PER_STEP = 1;
/** What a turn with features.coreTools off is expected to send before her reply: the search classifier and one search's summary. */
const PRE_TURN_REQUESTS = 2;

/**
 * The model requests one decision with her tool loop (features.coreTools) is expected to send --
 * a realistic estimate, not a bound: the run stops on what the provider reports spent (`--spend`
 * is a hard cap), so `--spend` can be about the real cost with a margin. Her reply, the expected
 * follow-up steps (EXPECTED_LOOP_STEPS, at most `settings.maxSteps`) and a request per expected
 * call before each (a web search's summary; a memory search sends none). The `perDecision` of
 * skillRequestEstimate under the loop. Pure.
 * @param {{ maxSteps: number, maxCallsPerStep: number }} settings
 * @returns {number}
 */
export function loopRequestEstimate(settings) {
  const steps = Math.min(EXPECTED_LOOP_STEPS, settings.maxSteps);
  return 1 + steps + steps * Math.min(EXPECTED_CALLS_PER_STEP, settings.maxCallsPerStep);
}

/**
 * The skill names a scenario's `grants` store for the persona, in order, de-duplicated: each
 * key expanded by `expand` (src/ops/access.js#expandPersonaGrant: a skill by name, a group or
 * `*` as its read skills), a name no grant opens for her kept (`refused`) so the gateway
 * refuses it as live. A key that names no skill is a CliError naming the scenario.
 * @param {{ id: string, grants: string[] }} scenario
 * @param {(key: string) => ({ names: string[], refused: string[] } | null)} expand
 * @returns {string[]}
 */
export function scenarioGrants(scenario, expand) {
  const names = [];
  for (const key of scenario.grants) {
    const expanded = expand(key);
    if (!expanded) throw new CliError(`replay-cli: scenario ${scenario.id}: grants names no skill: ${key}`);
    for (const name of [...expanded.names, ...expanded.refused]) if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** A scenario's `discovery` against the registry's skill `names`: a CliError for a name it does not have. */
export function scenarioDiscovery(scenario, names) {
  if (!Array.isArray(scenario.discovery)) return scenario.discovery;
  const unknown = scenario.discovery.filter((name) => !names.includes(name));
  if (unknown.length > 0)
    throw new CliError(`replay-cli: scenario ${scenario.id}: discovery names no skill: ${unknown.join(', ')}`);
  return scenario.discovery;
}

/**
 * The invented message of a scenario as a normalized history line (interfaces/discord/collect.js#normalizeMessage's
 * shape): by `authorId` / `authorName` in `channel` at `at`, the text as given, tagging the
 * persona (`mentionedUserIds`: `selfId`) unless `tagged` is false -- a burst's message, which
 * tags her only when its text holds her tag `<@selfId>` --, replying to nothing, without media.
 * Its id is the snowflake of its moment, so it sorts after every line before it. Pure.
 * @param {{ text: string, authorId: string, authorName: string, channel: { id: string, name?: string|null,
 *   category?: string|null, topic?: string|null }, selfId: string, at: number, tagged?: boolean }} input
 * @returns {object}
 */
export function scenarioTrigger({ text, authorId, authorName, channel, selfId, at, tagged = true }) {
  const tags = tagged || text.includes(`<@${selfId}>`) || text.includes(`<@!${selfId}>`);
  return {
    id: String((BigInt(Math.floor(at)) - DISCORD_EPOCH) << 22n),
    channelId: String(channel.id),
    channelName: channel.name ?? null,
    channelCategory: channel.category ?? null,
    channelTopic: channel.topic ?? null,
    authorId: String(authorId),
    authorName,
    self: false,
    bot: false,
    content: text,
    ts: at,
    mentionedUserIds: tags ? [String(selfId)] : [],
    mentionedChannelIds: [],
    replyToId: null,
    replyPingUserId: null,
    forwardedFrom: null,
    attachments: [],
    links: [],
    forwarded: [],
    stickers: [],
    emojis: [],
    reactions: [],
  };
}

/**
 * The id of a task-result scenario's errand: `t` and 8 hex digits, as src/errands/store.js names
 * a task, taken from the scenario's id so every run (and both sides of a pair) names the same
 * files. Pure.
 * @param {string} scenarioId
 * @returns {string}
 */
export function scenarioTaskId(scenarioId) {
  return `t${createHash('sha256').update(String(scenarioId)).digest('hex').slice(0, 8)}`;
}

/**
 * A task-result scenario's errand as src/errands/store.js keeps a finished task: its id
 * (scenarioTaskId), agent and goal; asked by `asker` (a member) in the scenario's channel, from
 * no message she can reply to (src/errands/turns.js then opens an interjection); `group` scope;
 * ended at `at` in `state` (`failed` with the store's default code), its result's text and files
 * (no sources), not seen. A file has no path: nothing is on disk, and nothing reads one. Pure.
 * @param {{ id: string, channelId: string, taskResult: { agent: string, goal: string, state: string, text: string,
 *   files: { name: string, contentType: string, bytes: number }[], asker: string } }} scenario
 * @param {{ at: number }} options
 * @returns {object}
 */
export function scenarioTask(scenario, { at }) {
  const errand = scenario.taskResult;
  return {
    id: scenarioTaskId(scenario.id),
    agent: errand.agent,
    goal: errand.goal,
    requester: { userId: errand.asker, kind: 'member' },
    origin: { channelId: String(scenario.channelId), messageId: null },
    scope: 'group',
    state: errand.state,
    createdAt: at,
    startedAt: at,
    endedAt: at,
    usage: null,
    result: {
      text: errand.text,
      sources: [],
      files: errand.files.map((file) => ({
        path: null,
        name: file.name,
        contentType: file.contentType,
        bytes: file.bytes,
      })),
    },
    error: errand.state === 'done' ? null : TASK_FAILED_CODE,
    seen: false,
  };
}

/**
 * The call view's `fileOf` for a task-result scenario (src/behavior/turn.js#callViewOf): a handle
 * `file:<task id>/<name>` (read by `parseFileHandle`, src/errands/store.js's) that names a file of
 * `task` resolves as src/errands/service.js#fileOf resolves a live one -- `{ path, name,
 * contentType, bytes, task }`, `path` null --, any other handle to null. Pure.
 * @param {object} task  scenarioTask's.
 * @param {(handle: string) => ({ id: string, name: string }|null)} parseFileHandle
 * @returns {(handle: string) => object|null}
 */
export function scenarioFileOf(task, parseFileHandle) {
  return (handle) => {
    const parsed = parseFileHandle(handle);
    if (!parsed || parsed.id !== task.id) return null;
    const file = task.result.files.find((entry) => entry.name === parsed.name);
    return file
      ? { path: null, name: file.name, contentType: file.contentType, bytes: file.bytes, task: structuredClone(task) }
      : null;
  };
}

/**
 * The errands' budget the sandbox gateway reads (src/skills/gateway.js, `context.tasks`), read
 * only: a task store of `guildId` over `dataDir` (src/errands/store.js#createTaskStore: its
 * tasks.json and tasks.jsonl read once, the live data/ or a snapshot) whose `budget(agent)` -- the open tasks
 * against `agents.maxOpen`, today's tasks and dollars against `agents.<agent>.daily` (the
 * profile's defaults under them), read from `config()` at the moment of use -- answers a
 * `task.run` exactly as a live turn's (src/errands/service.js#budget). Only `budget` is handed
 * out: nothing is ever queued, and the store writes nothing for it.
 * @param {{ createTaskStore: Function, guildId: string, config: () => object, now?: () => number, log?: object,
 *   memoryDb?: object|null }} input  `memoryDb`: the memory read (tools/lib/memory-read.mjs); without it no task is known
 * @returns {{ budget(agent: string): { spent: boolean, key: string|null, code: string|null } }}
 */
export function sandboxErrandBudget({ createTaskStore, guildId, config, now = Date.now, log, memoryDb = null }) {
  const store = createTaskStore({
    guildId: String(guildId),
    config,
    now,
    journal: null,
    memoryDb,
    ...(log ? { log } : {}),
  });
  return Object.freeze({ budget: (agent) => store.budget(agent) });
}

/** `config` with features.coreTools on (`--core-tools`): a shallow copy, the live config untouched. Pure. */
export function withCoreTools(config) {
  return { ...config, features: { ...(config?.features ?? {}), coreTools: true } };
}

/** The result of an in-turn tool that ran past its time (src/skills/executors.js#executeCall's). */
const TOOL_TIMEOUT_RESULT = Object.freeze({ status: 'unknown', code: 'timeout', data: Object.freeze({ text: '' }) });

/**
 * The `onCall` of a scenario run with her tool loop (features.coreTools): her call taken through
 * `simulate(call, refs)` (simulateCall over the call view: the real resolution and gateway, the
 * operation never run), then -- when it passed and its skill is one of `inTurn` (web.search,
 * memory.search) -- run for real: `runTool(skill, resolvedArgs, refs)` resolving `{ result, usage }`
 * within `refs.timeoutMs` (past it the timeout result a live call gets), the result in place of the
 * canned one, and `tool: { ms, requests,
 * tokens, cost }` what the tool's own requests used. A `task.run` that passed is never dispatched:
 * it keeps the canned result and records `errand: { agent, goal }` (the goal as resolved, else her
 * body). A tool that throws answers `failed` / `error` and logs one warning with the message (`log`). `now` is the clock.
 * @param {{ simulate: Function, runTool?: Function|null, inTurn: readonly string[], now?: () => number, log?: { warn?: Function }|null }} input
 * @returns {(call: object, refs: object) => Promise<object>}
 */
export function loopCall({ simulate, runTool = null, inTurn, now = Date.now, log = null }) {
  return async (call, refs = {}) => {
    const outcome = simulate(call, refs);
    const executed = outcome?.verdict?.ok === true ? outcome.executed : null;
    if (executed?.skill === 'task.run') {
      return {
        ...outcome,
        errand: { agent: String(executed.args?.agent ?? ''), goal: String(executed.args?.goal ?? call?.body ?? '') },
      };
    }
    if (!executed || !inTurn.includes(executed.skill) || typeof runTool !== 'function') return outcome;
    const started = now();
    let timer = null;
    let ran;
    try {
      const limit = Number.isFinite(refs.timeoutMs) && refs.timeoutMs > 0 ? refs.timeoutMs : null;
      const timeout =
        limit === null
          ? null
          : new Promise(
              (resolve) =>
                (timer = setTimeout(() => resolve({ result: TOOL_TIMEOUT_RESULT, usage: null, timedOut: true }), limit))
            );
      const running = Promise.resolve(runTool(executed.skill, { ...executed.args }, refs));
      ran = await (timeout ? Promise.race([running, timeout]) : running);
    } catch (err) {
      log?.warn?.('replay: in-turn tool threw', { skill: executed.skill, error: err?.message ?? String(err) });
      ran = { result: { status: 'failed', code: 'error' }, usage: null };
    } finally {
      if (timer) clearTimeout(timer);
    }
    const result = {
      ...(ran?.result && typeof ran.result.status === 'string' ? ran.result : { status: 'failed', code: 'error' }),
      skill: executed.skill,
    };
    const usage = ran?.usage ?? {};
    return {
      ...outcome,
      result,
      tool: {
        ms: now() - started,
        requests: usage.requests ?? 0,
        tokens: usage.tokens ?? { prompt: 0, completion: 0 },
        cost: Number.isFinite(usage.cost) ? usage.cost : null,
      },
    };
  };
}

/**
 * Her in-turn tools for a replay (features.coreTools), run for real but writing nothing:
 * `web.search` through the live lookup module (src/web/lookup.js#createLookup over `hot`: its
 * engines and `searches` with `keys`, its summary request on `llm` -- the replay's, on the
 * simulator key --, over a private copy of the media cache and of the daily web counter) and
 * `memory.search` through the live recall runner (src/behavior/recall-run.js#createRecall over a
 * private copy of the daily recall counter, the store's read methods, `sources` -- the record, the
 * archive and the vector index of the data read, iterated only -- and `embed`), each by its
 * src/skills/tools.js runner. `run(skill, args, { history, at })` resolves `{ result, usage }`
 * (`usage`: the requests the call itself sent, their tokens and cost); `recallAvailable()` whether
 * the server search could run now (its senses line). `prefetch({ trigger, triggerKind, mode,
 * history, at })` the automatic memory prefetch a live turn with features.coreTools runs for that
 * trigger (src/behavior/prefetch.js#prefetchLanes and the recall runner's `prefetch`, as of `at`:
 * nothing after it is read), null when none would run or the engine has none (`prefetchLanes`,
 * `prefetchOn`, `recallSettings` its pure parts). `conversation.read` runs the live reader
 * (src/skills/conversation-read.js, `conversation`: its runConversationRead, fetchSpan, recordMessages,
 * searchHandles and pullPictures) over `record` (iterated only) and the REST channel (GET only), its
 * handles numbered on past the request's own (`idByIndex`). Nothing reaches the store or data/.
 */
export function createReplayTools({
  hot,
  store,
  guild,
  guildId,
  channel,
  selfId,
  selfName,
  llm,
  createLookup,
  createRecall,
  runWebSearch,
  runMemorySearch,
  runWebRead = null,
  pageFetcher = null,
  linkOfMessage = null,
  discord,
  reads = null,
  iface = 'discord',
  describer = null,
  searches = {},
  keys = {},
  sources = {},
  embed = null,
  mediaCache = null,
  prefetchLanes = null,
  prefetchOn = null,
  recallSettings = null,
  conversation = null,
  record = null,
  mediaTools = null,
  log = null,
}) {
  const data = store.state?.data ?? {};
  const media = structuredClone(mediaCache ?? {});
  // The second looks media.look took (the per-turn count of the live turn).
  let looks = 0;
  const webStore = { getMediaCache: () => media, markMediaCacheDirty() {} };
  const webState = { data: { webDay: data.webDay, webCount: data.webCount }, markDirty() {} };
  const recallStore = {
    state: { data: { recallDay: data.recallDay, recallCount: data.recallCount }, markDirty() {} },
    listUserProfiles: (id) => store.listUserProfiles(id),
    getLore: (id) => store.getLore(id),
    getGuild: (id) => store.getGuild(id),
    ...(typeof store.getRecent === 'function' ? { getRecent: (id) => store.getRecent(id) } : {}),
    appendRecallTrace() {},
  };
  const recallOf = (client) =>
    createRecall({
      hot,
      store: recallStore,
      llm: client,
      discord,
      describer,
      archive: sources.archive ?? null,
      record: sources.record ?? null,
      vectors: sources.vectors ?? null,
      embed,
      memoryDb: sources.memoryDb ?? null,
    });
  const metered = () => {
    const usage = { requests: 0, tokens: { prompt: 0, completion: 0 }, cost: null };
    const client = {
      async complete(messages, options) {
        const completion = await llm.complete(messages, options);
        const u = completion?.usage ?? {};
        usage.requests += 1;
        usage.tokens.prompt += Number(u.prompt_tokens) || 0;
        usage.tokens.completion += Number(u.completion_tokens) || 0;
        if (Number.isFinite(Number(u.cost))) usage.cost = (usage.cost ?? 0) + Number(u.cost);
        return completion;
      },
    };
    return { usage, client };
  };
  // conversation.read as a live turn runs it (src/behavior/turn.js#readConversation), read only: the record iterated,
  // the interface's history over GET requests of the replay's channel. One registry of handles for the tools' life,
  // numbered on past the highest line of the request (searchHandles over a draft with that floor).
  const draft = {};
  const readConversation = async (args, { at, idByIndex }) => {
    const { runConversationRead, fetchSpan, recordMessages, searchHandles, pullPictures } = conversation;
    const config = hot.config;
    const labels = hot.prompts?.labels ?? {};
    const floor = idByIndex instanceof Map ? Math.max(0, ...[...idByIndex.keys()].filter(Number.isFinite)) : 0;
    draft.handleFloor = Math.max(draft.handleFloor ?? 0, floor);
    const channelOf = (id) =>
      String(id) === String(channel.id) ? channel : (guild.channels?.cache?.get?.(String(id)) ?? null);
    const profiles = typeof store.listUserProfiles === 'function' ? (store.listUserProfiles(guildId) ?? []) : [];
    const stored = new Map(profiles.filter((p) => p?.id).map((p) => [String(p.id), p]));
    const nameOf = (id) =>
      (typeof stored.get(String(id))?.names?.[0] === 'string' ? stored.get(String(id)).names[0] : null) ??
      guild.members?.cache?.get?.(id)?.displayName ??
      null;
    const settings = typeof recallSettings === 'function' ? recallSettings(config) : null;
    const timezone = config.bot?.timezone ?? 'UTC';
    return runConversationRead({
      args,
      labels,
      config,
      channelId: String(channel.id),
      channelNameOf: (id) => channelOf(id)?.name ?? null,
      allowed: (id) => {
        if (String(id) === String(channel.id) && channel.guild) return true;
        try {
          return (
            discord.checkPull({ guild, channelId: String(id), destination: channel, partner: null, config, now: at })
              .skip === null
          );
        } catch {
          return false;
        }
      },
      readRecord: ({ channelId, from }) =>
        config.features?.record === true
          ? recordMessages(record, guildId, { channelId, from, nameOf, selfName })
          : Promise.resolve([]),
      fetchLive: (request) => fetchSpan(reads, { iface, conversationId: String(request.channelId) }, request),
      render: (slice) => {
        let descriptions;
        if (config.features?.mediaDescriptions === true && typeof describer?.cachedDescriptions === 'function') {
          const { items, rest, emoji } = pullPictures(slice, 0);
          try {
            descriptions = describer.cachedDescriptions(guildId, [...items, ...rest, ...emoji]) ?? undefined;
          } catch {
            descriptions = undefined;
          }
        }
        return {
          timezone,
          gapMinutes: config.context?.gapMarkerMinutes,
          maxChars: config.context?.maxMessageChars ?? 2000,
          selfName,
          labels,
          descriptions,
          seeReactions: config.features?.seeReactions !== false,
          reactionsPerMessage: config.context?.reactionsPerMessage,
        };
      },
      refs: searchHandles(draft),
      now: at,
      timezone,
      ...(Number.isFinite(settings?.quoteMaxChars) ? { maxChars: settings.quoteMaxChars } : {}),
    });
  };
  return {
    // The lookup and the recall runner over the same private copies, on one metered client: the
    // searches a live switch-off turn runs before her reply (preTurnLookup).
    searchers() {
      const { usage, client } = metered();
      return {
        lookup: createLookup({ hot, store: webStore, llm: client, state: webState, searches, keys }),
        recall: recallOf(client),
        client,
        usage,
      };
    },
    recallAvailable: () => {
      try {
        return recallOf(llm).available() === true;
      } catch {
        return false;
      }
    },
    async prefetch({ trigger, triggerKind = null, mode = null, history = [], at = Date.now() } = {}) {
      if (
        typeof prefetchLanes !== 'function' ||
        typeof prefetchOn !== 'function' ||
        typeof recallSettings !== 'function' ||
        !prefetchOn(hot.config)
      )
        return null;
      const settings = recallSettings(hot.config)?.prefetch;
      if (!settings) return null;
      const names = new Map(
        (store.listUserProfiles?.(guildId) ?? [])
          .filter((p) => p?.id)
          .map((p) => [String(p.id), typeof p.names?.[0] === 'string' ? p.names[0] : null])
      );
      const nameOf = hot.config.features?.memory !== false ? (id) => names.get(String(id)) ?? null : null;
      const { lanes, skip } = prefetchLanes({
        trigger,
        triggerKind,
        mode,
        history,
        settings,
        selfId,
        selfName,
        selfNames: hot.config.bot?.nameTriggers ?? [],
        nameOf,
      });
      if (skip) return null;
      const recall = recallOf(llm);
      if (typeof recall.prefetch !== 'function') return null;
      return recall.prefetch({ guild, guildId, channel, partner: null, selfId, selfName, history, lanes, at });
    },
    async run(skill, args, { history = [], at = Date.now(), idByIndex = null } = {}) {
      const { usage, client } = metered();
      const labels = hot.prompts?.labels ?? {};
      if (skill === 'web.search') {
        const lookup = createLookup({ hot, store: webStore, llm: client, state: webState, searches, keys });
        return { result: await runWebSearch({ lookup, config: hot.config, labels, guildId, args }), usage };
      }
      // web.read: the page fetched for real (no model request, free), into the private cache copy.
      if (skill === 'web.read' && typeof runWebRead === 'function' && pageFetcher) {
        const lookup = createLookup({
          hot,
          store: webStore,
          llm: client,
          state: webState,
          pageFetcher,
          searches,
          keys,
        });
        const linkOf = (id) => {
          const message = history.find((item) => String(item?.id) === String(id));
          return message && typeof linkOfMessage === 'function' ? linkOfMessage(message) : null;
        };
        return { result: await runWebRead({ lookup, config: hot.config, labels, guildId, args, linkOf }), usage };
      }
      if (skill === 'memory.search') {
        const result = await runMemorySearch({
          recall: onPlatformChannel(recallOf(client), { guild, channel }),
          store,
          config: hot.config,
          labels,
          guild,
          guildId,
          channel: conversationOfChannel(channel, String(guildId)),
          partner: null,
          selfId,
          selfName,
          history,
          decorate: null,
          args,
          now: at,
        });
        return { result, usage };
      }
      if (skill === 'conversation.read' && conversation) {
        return { result: await readConversation(args, { at, idByIndex }), usage };
      }
      // media.look as a live turn runs it (src/behavior/turn.js#inTurnTools): a describer over the private cache copy and
      // the metered client (the vision helper, on the simulator key as every replay helper), its second look downloading
      // the attachment itself; the message `#N` named is looked up in the request's history. At most lookPerTurn per tools' life.
      if (skill === 'media.look' && mediaTools?.createDescriber && mediaTools.runMediaLook) {
        const lookDescriber = mediaTools.createDescriber({ hot, store: webStore, llm: client });
        const cap = typeof mediaTools.lookPerTurn === 'function' ? mediaTools.lookPerTurn(hot.config) : Infinity;
        const result = await mediaTools.runMediaLook({
          describer: lookDescriber,
          config: hot.config,
          labels,
          guildId,
          args,
          mediaOf: (id) => history.find((item) => String(item?.id) === String(id)) ?? null,
          takeTurnSlot: () => {
            if (looks >= cap) return false;
            looks += 1;
            return true;
          },
        });
        return { result, usage };
      }
      // media.find: the GIF library read from the store, the descriptions from the private cache copy; nothing written.
      if (skill === 'media.find' && mediaTools?.runMediaFind) {
        const findStore = { getGifs: (id) => store.getGifs?.(id) ?? [], getMediaCache: () => media };
        return {
          result: mediaTools.runMediaFind({
            store: typeof store.getGifs === 'function' ? findStore : null,
            config: hot.config,
            labels,
            guildId,
            args,
          }),
          usage,
        };
      }
      // Every other tool: an explicit refusal she can read as one (never a bare error), and a warning in the log.
      log?.warn?.('replay: no tool runs this skill', { skill });
      return { result: { status: 'not_configured', code: 'not-configured', reason: 'replay-no-tool' }, usage };
    },
  };
}

/**
 * The members her messages would mention (the sandbox's `mentions` per message, each id once,
 * in order) and the handle-shaped tokens nobody holds, as `{ mentions, unknownHandles }`; {}
 * when no message holds a handle, so an answer without one keeps its shape.
 */
function mentionsOf(answer) {
  const messages = Array.isArray(answer?.messages) ? answer.messages : [];
  if (!messages.some((m) => Array.isArray(m.mentions))) return {};
  const mentions = [...new Set(messages.flatMap((m) => m.mentions ?? []))];
  return { mentions, unknownHandles: messages.reduce((sum, m) => sum + (m.unknownHandles ?? 0), 0) };
}

/** What she showed in one pass (a shaped answer): her messages, reactions, GIF, drawing, skip, and her think. */
function visibleOf(answer) {
  if (!answer) return null;
  return {
    messages: answer.messages.map((m) => m.text),
    ...mentionsOf(answer),
    reactions: answer.reactions.map((r) => r.emoji),
    gif: answer.gif?.id ?? null,
    skip: answer.skip,
    think: answer.think ?? '',
  };
}

/**
 * One run of a scenario (answerSkillScenario's) as its JSONL line: the decision (`call`,
 * `malformed-call`, `no-call`), the skill and the arguments she wrote (the body as `body`),
 * the gateway's verdict, the call recorded when it passed (`executed`), the result she got, her
 * visible messages of both passes (the follow-up's with `continuation`: whether it continued the
 * turn), the tokens of both and their cost (`usage.cost` as the
 * provider reported it; null when it reported none). Pure.
 * @param {string} scenarioId
 * @param {number} index  0-based.
 * @param {object} run
 * @returns {object}
 */
export function runRecord(scenarioId, index, run) {
  const loop = run.loop ? loopRecord(run.loop) : null;
  const usages = loop ? [] : [run.usage, run.followUp?.usage].filter(Boolean);
  const sum = (key) => usages.reduce((total, u) => total + (Number(u?.[key]) || 0), 0);
  const costs = usages.map((u) => Number(u?.cost)).filter(Number.isFinite);
  const outcome = run.outcome ?? null;
  const follow = run.followUp;
  const tokens = loop ? loop.tokens : { prompt: sum('prompt_tokens'), completion: sum('completion_tokens') };
  const cost = loop ? loop.cost : costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null;
  return {
    scenario: scenarioId,
    run: index + 1,
    decision: run.call ? 'call' : run.callError ? 'malformed-call' : 'no-call',
    skill: run.call?.skill ?? null,
    args: run.call ? { ...run.call.args, ...(run.call.body ? { body: run.call.body } : {}) } : null,
    // The members the call's text would mention, when it holds a handle.
    ...(run.callMentions ? { callMentions: run.callMentions } : {}),
    extraCalls: run.extraCalls ?? 0,
    verdict: outcome?.verdict ?? null,
    executed: outcome?.executed ?? null,
    result: outcome ? { status: outcome.result.status, code: outcome.result.code ?? null } : null,
    first: visibleOf(run.answer),
    followUp: follow
      ? follow.error
        ? { error: follow.error }
        : {
            ...visibleOf(follow.answer),
            extraCall: follow.extraCall === true,
            continuation: follow.continuation === true,
          }
      : null,
    tokens,
    cost,
    ...(loop ? { loop } : {}),
  };
}

/** The tokens and cost (null when none was reported) of a list of provider usages. */
function usageTotals(usages) {
  const list = usages.filter(Boolean);
  const costs = list.map((u) => Number(u?.cost)).filter(Number.isFinite);
  const cached = (u) => Number(u?.prompt_tokens_details?.cached_tokens ?? u?.cache_read_input_tokens) || 0;
  const written = (u) => Number(u?.prompt_tokens_details?.cache_write_tokens ?? u?.cache_creation_input_tokens) || 0;
  return {
    prompt: list.reduce((t, u) => t + (Number(u?.prompt_tokens) || 0), 0),
    completion: list.reduce((t, u) => t + (Number(u?.completion_tokens) || 0), 0),
    cacheRead: list.reduce((t, u) => t + cached(u), 0),
    cacheWrite: list.reduce((t, u) => t + written(u), 0),
    cost: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
  };
}

/** A sum of costs that may be null: null only when every one is. */
function addCost(a, b) {
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
}

/**
 * A tool-loop run's record (`run.loop`, src/behavior/sandbox.js#runSkillLoop's) as runs.jsonl keeps
 * it: per step (0 the reply) its number, the calls it made in order -- the skill, the arguments she
 * wrote, the gateway's verdict, the resolved arguments when it passed, the result's status, code and
 * size (`chars`, its text), how long it took, what an in-turn tool's own requests used (`tool`) and,
 * for a `task.run` that passed, the errand recorded (`errand`: agent and goal; never dispatched) --,
 * the calls dropped (`dropped`; `capped` its reason), whether her speech of the step was `held`
 * (never posted), `thinkMissing` (her text did not begin with her thinking), `coerced` (arguments
 * read in another type), her visible answer, the size of the request it answered (`requestChars`),
 * its latency (`ms`), tokens (with the cache reads and writes) and cost; then the calls of the whole
 * turn in order (`calls`), the errands, the pictures she asked for (`drawings`), the texts her message
 * calls posted (`posts`), every message of the turn that was posted -- a held step's are not --
 * (`messages`), the last posted step's (`final`), the turn's counts (`requests`, `held`, `thinkMissing`,
 * `coerced`, `capped`, `malformed`) and latency (`ms`), and its tokens and cost (her requests and the
 * tools' together). Pure.
 * @param {{ steps: object[], ms: number }} loop
 * @returns {object}
 */
export function loopRecord(loop) {
  const steps = (loop.steps ?? []).map((step) => {
    const own = usageTotals([step.usage]);
    const calls = (step.calls ?? []).map(({ call, outcome, ms }) => {
      const result = outcome?.result ?? null;
      const tool = outcome?.tool ?? null;
      return {
        skill: call?.skill ?? null,
        args: call ? { ...call.args, ...(call.body ? { body: call.body } : {}) } : null,
        ...(call?.toolCallId ? { id: call.toolCallId } : {}),
        verdict: outcome?.verdict ?? null,
        executed: outcome?.executed ?? null,
        result: result
          ? { status: result.status, code: result.code ?? null, chars: String(result.data?.text ?? '').length }
          : null,
        ms: Number.isFinite(ms) ? ms : null,
        ...(tool ? { tool } : {}),
        ...(outcome?.errand ? { errand: outcome.errand } : {}),
      };
    });
    return {
      step: step.step,
      calls,
      dropped: step.dropped ?? 0,
      capped: step.capped ?? null,
      held: step.held === true,
      thinkMissing: step.thinkMissing === true,
      coerced: step.coerced ?? 0,
      ...(step.continuation !== undefined ? { continuation: step.continuation === true } : {}),
      ...(step.error ? { error: step.error } : { answer: visibleOf(step.answer) }),
      requestChars: step.requestChars ?? null,
      ms: Number.isFinite(step.ms) ? step.ms : null,
      tokens: { prompt: own.prompt, completion: own.completion, cacheRead: own.cacheRead, cacheWrite: own.cacheWrite },
      cost: own.cost,
      resultChars: calls.reduce((total, c) => total + (c.result?.chars ?? 0), 0),
    };
  });
  const tools = steps.flatMap((step) => step.calls.map((c) => c.tool).filter(Boolean));
  const toolTokens = tools.reduce(
    (t, x) => ({
      prompt: t.prompt + (Number(x.tokens?.prompt) || 0),
      completion: t.completion + (Number(x.tokens?.completion) || 0),
    }),
    { prompt: 0, completion: 0 }
  );
  const toolCost = tools.reduce((total, x) => addCost(total, Number.isFinite(x.cost) ? x.cost : null), null);
  const ownCost = steps.reduce((total, step) => addCost(total, step.cost), null);
  const posted = steps.filter((step) => step.answer && !step.held);
  const okCalls = steps.flatMap((step) =>
    step.calls
      .filter((c) => c.result?.status === 'ok' && c.verdict?.ok !== false)
      .map((c) => ({ step: step.step, ...c }))
  );
  return {
    steps,
    calls: steps.flatMap((step) =>
      step.calls.map((c) => ({
        step: step.step,
        skill: c.skill,
        status: c.result?.status ?? null,
        code: c.result?.code ?? (c.verdict && !c.verdict.ok ? c.verdict.code : null),
      }))
    ),
    errands: steps.flatMap((step) => step.calls.filter((c) => c.errand).map((c) => ({ step: step.step, ...c.errand }))),
    drawings: okCalls
      .filter((c) => c.skill === 'draw.create')
      .map((c) => ({
        step: c.step,
        text: String(c.args?.text ?? ''),
        self: c.args?.self === true,
        channel: c.args?.channel ?? null,
      })),
    posts: okCalls
      .filter((c) => c.skill === 'message.create' && typeof c.args?.text === 'string' && c.args.text)
      .map((c) => ({ step: c.step, text: c.args.text, channel: c.args.channel ?? null })),
    messages: posted.flatMap((step) => step.answer.messages),
    final: posted.length > 0 ? posted[posted.length - 1].answer.messages : [],
    requests:
      steps.filter((step) => !step.error).length + tools.reduce((total, x) => total + (Number(x.requests) || 0), 0),
    turnRequests: steps.filter((step) => !step.error).length,
    held: steps.filter((step) => step.held).length,
    thinkMissing: steps.filter((step) => step.thinkMissing).length,
    coerced: steps.reduce((total, step) => total + step.coerced, 0),
    // Calls refused by a cap, plus a step that ended the loop on the token cap with none dropped.
    capped: steps.reduce((total, step) => total + step.dropped + (step.dropped === 0 && step.capped ? 1 : 0), 0),
    malformed: steps.reduce(
      (total, step) =>
        total + step.calls.filter((c) => ['malformed-call', 'truncated-call'].includes(c.verdict?.code)).length,
      0
    ),
    ms: Number.isFinite(loop.ms) ? loop.ms : null,
    tokens: {
      prompt: steps.reduce((t, step) => t + step.tokens.prompt, 0) + toolTokens.prompt,
      completion: steps.reduce((t, step) => t + step.tokens.completion, 0) + toolTokens.completion,
      cacheRead: steps.reduce((t, step) => t + step.tokens.cacheRead, 0),
      cacheWrite: steps.reduce((t, step) => t + step.tokens.cacheWrite, 0),
    },
    cost: addCost(ownCost, toolCost),
  };
}

/**
 * A scenario's counts over its run records: runs, calls (of which `passed` and `denied` by the
 * resolution, the gateway or the command), `noCall` (she declined or deflected: no call),
 * `malformed`, follow-ups answered, tokens and cost (null when no run reported one). Pure.
 * @param {object[]} records  runRecord's.
 */
export function scenarioSummary(records) {
  const calls = records.filter((r) => r.decision === 'call');
  const costs = records.map((r) => r.cost).filter(Number.isFinite);
  return {
    runs: records.length,
    calls: calls.length,
    passed: calls.filter((r) => r.verdict?.ok === true).length,
    denied: calls.filter((r) => r.verdict && r.verdict.ok !== true).length,
    noCall: records.filter((r) => r.decision === 'no-call').length,
    malformed: records.filter((r) => r.decision === 'malformed-call').length,
    followUps: records.filter((r) => r.followUp && !r.followUp.error).length,
    promptTokens: records.reduce((t, r) => t + r.tokens.prompt, 0),
    completionTokens: records.reduce((t, r) => t + r.tokens.completion, 0),
    cost: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
  };
}

/** A step record's letter in a run's pattern: C a call, N no call, M a malformed call. */
const DECISION_LETTERS = Object.freeze({ call: 'C', 'no-call': 'N', 'malformed-call': 'M' });

/**
 * A multi-step scenario's counts over its step records (runRecord's with `step`, 1-based):
 * scenarioSummary's over every decision, with `runs` the runs (not the decisions), `steps` the
 * scenario's steps, `decisions` the step records, and per run its `pattern` (one letter per
 * step answered, in order: `C` a call, `N` no call, `M` a malformed call), `firstDecline` (the
 * first step she made no call in; null when she made one in every step), `resumed` (whether she
 * made a call in a later step after that decline; null without one) and `complete` (every step
 * answered, every turn of a burst included: a run stopped by --spend or Ctrl-C is cut short).
 * A step played as a burst (records with `turn` and `queue`) has one letter per turn, in order.
 * `pattern` is every run's pattern, space-separated (`CCCN NNNN`). A step that only seeds a line
 * of hers (`seededSteps` of them) has no record and no letter; a run is complete without it.
 * Pure.
 * @param {object[]} records  runRecord's, each with `step` (and `turn` / `queue` on a burst's).
 * @param {number} steps  The scenario's step count.
 * @param {{ seededSteps?: number }} [options]  How many of the steps run no turn (only her seeded lines).
 */
export function sequenceSummary(records, steps, { seededSteps = 0 } = {}) {
  const sequences = runPatterns(records).map(({ run, ordered, pattern, firstDecline }) => {
    const answered = new Set(ordered.map((record) => record.step));
    const last = ordered[ordered.length - 1];
    const lastDone = !last?.queue || ordered.filter((record) => record.step === last.step).length === last.queue.turns;
    return {
      run,
      pattern,
      firstDecline,
      resumed:
        firstDecline === null
          ? null
          : ordered.some((record) => record.step > firstDecline && record.decision === 'call'),
      complete: answered.size === steps - seededSteps && lastDone,
    };
  });
  return {
    ...scenarioSummary(records),
    runs: sequences.length,
    steps,
    decisions: records.length,
    pattern: sequences.map((s) => s.pattern).join(' '),
    sequences,
  };
}

/**
 * Run records grouped by run, in run order: each run's records in the order they were decided
 * (`step`, then `turn`; a single-turn scenario's one record per run), its `pattern` (one
 * DECISION_LETTERS letter per record) and `firstDecline` (the step of the first record without a
 * call -- 1 for a single-turn run --, null when she made a call every time). Pure.
 * @param {object[]} records  runRecord's.
 * @returns {{ run: number, ordered: object[], pattern: string, firstDecline: number|null }[]}
 */
function runPatterns(records) {
  const byRun = new Map();
  for (const record of records) {
    if (!byRun.has(record.run)) byRun.set(record.run, []);
    byRun.get(record.run).push(record);
  }
  return [...byRun.entries()]
    .sort(([a], [b]) => a - b)
    .map(([run, list]) => {
      const ordered = [...list].sort((a, b) => (a.step ?? 1) - (b.step ?? 1) || (a.turn ?? 1) - (b.turn ?? 1));
      const decline = ordered.find((record) => record.decision === 'no-call') ?? null;
      return {
        run,
        ordered,
        pattern: ordered.map((record) => DECISION_LETTERS[record.decision] ?? '?').join(''),
        firstDecline: decline ? (decline.step ?? 1) : null,
      };
    });
}

/** The newest moment among `lines` (ms), or `fallback` when none has one. */
function newestTs(lines, fallback) {
  const times = lines.map((line) => line?.ts).filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : fallback;
}

/**
 * The lines one step adds to the channel (`transcript`, the channel before it), in arrival
 * order: the first `gapMinutes` after the newest line so far (the first step's at `firstAt`),
 * the next ones BURST_SPACING_MS apart. A member's message is `lineOf(message, at, { tagged })`
 * (tagging her when it is the step's own, `own`), a seeded line of hers `seedLine(message, at)`.
 * `callers` the members' lines (those that may get a turn), `seeded` hers. Pure.
 */
function stepLines({ step, index, transcript, firstAt, lineOf, seedLine }) {
  const start = index === 0 ? firstAt : newestTs(transcript, firstAt) + step.gapMinutes * 60_000;
  const incoming = step.messages.map((message, i) => {
    const at = start + i * BURST_SPACING_MS;
    if (message.self !== true) return lineOf(message, at, { tagged: step.own !== false && i === 0 });
    if (typeof seedLine !== 'function') throw new CliError('replay-cli: a seeded line of hers needs seedLine');
    return seedLine(message, at);
  });
  const seeded = incoming.filter((_, i) => step.messages[i].self === true);
  return { incoming, callers: incoming.filter((line) => !seeded.includes(line)), seeded };
}

/**
 * The first decision of a multi-step scenario, as playSteps reaches it: the channel (`lines`:
 * `history`, then every step up to and including the first that runs her turn -- the steps
 * before it only seed lines of hers, stepLines) and that step's first turn (`turn`, planBurst's).
 * What `--dry` builds and the memory is read at. Pure apart from what the callbacks do.
 * @param {{ scenario: { steps: object[] }, history: object[], firstAt: number, lineOf: Function, seedLine?: Function, planBurst: Function }} input
 * @returns {{ lines: object[], turn: { line: object, kind: string, queued: object[] } }}
 */
export function firstDecision({ scenario, history, firstAt, lineOf, seedLine, planBurst }) {
  let transcript = [...history];
  for (const [index, step] of scenario.steps.entries()) {
    const { incoming, callers, seeded } = stepLines({ step, index, transcript, firstAt, lineOf, seedLine });
    if (callers.length > 0) {
      const plan = planBurst(callers, { history: [...transcript, ...seeded] });
      return { lines: [...transcript, ...incoming], turn: plan.turns[0] };
    }
    transcript = [...transcript, ...incoming];
  }
  throw new CliError('replay-cli: the scenario has no step that runs her turn');
}

/**
 * One run of a multi-step scenario, every step from the start: before each step its messages
 * join the channel (`lineOf(message, at, { tagged })`: a normalized line by the message's own
 * author at `at`, tagging the persona when `tagged` -- the step's own message, `own` --, a burst's
 * message by its text alone) -- the first `gapMinutes` after the newest line so far (the first
 * step's at `firstAt`), the next ones BURST_SPACING_MS apart (stepLines). A seeded line of hers
 * (`{ self: true, text }`) joins as `seedLine(message, at)` (src/behavior/sandbox.js#seededSelfLine:
 * shaped as her live lines) and runs no turn: it costs no request and leaves no record; a step of
 * nothing else is only that line. `planBurst(incoming, { history })` -- the members' messages --
 * (src/behavior/sandbox.js#burstTurns over the channel before the step) says which of them get a
 * turn, in the order the live queue answers them, and which a newer follow-up `replaced` (or the
 * queue's cap `dropped`). Each turn is one decision: `answerStep({ situation, trigger, at,
 * callMarks, result, step, turn, queued })` (her turn over the channel so far -- every message of
 * the step, her earlier turns -- at its newest moment, with the trigger's kind, the earlier
 * calls' marks, the calls still waiting after it, the step's `result` else the scenario's;
 * resolves `{ run, stopped }`), its run recorded (runRecord with `step`, 1-based, and -- a step
 * of more than one member's message -- `turn` and `queue`: `{ turns, kind, trigger: { id,
 * author, text }, queued, replaced: [{ id, author, text, by }], dropped: [{ id, author, text,
 * reason }] }`; handed to `onRecord` as it comes), then carried into the channel the next turn
 * reads by `afterTurn({ transcript, callMarks, run, at, triggerId })`
 * (src/behavior/sandbox.js#afterScenarioTurn: her lines and the call's mark). A stopped answer
 * ends the run (`stopped`). `bursts` lists, per step of more than one member's message, the ids
 * that got a turn and the replaced and dropped ones. Nothing here sends or writes; `answerStep`
 * and `afterTurn` do what they do.
 * @param {{ scenario: { id: string, result: string, steps: object[] }, history: object[], firstAt: number, runIndex: number,
 *   lineOf: Function, seedLine?: Function, planBurst: Function, answerStep: Function, afterTurn: Function, onRecord?: Function }} input
 * @returns {Promise<{ records: object[], stopped: boolean, transcript: object[],
 *   bursts: { step: number, turns: string[], replaced: object[], dropped: object[] }[] }>}
 */
export async function playSteps({
  scenario,
  history,
  firstAt,
  runIndex,
  lineOf,
  seedLine,
  planBurst,
  answerStep,
  afterTurn,
  onRecord,
}) {
  let transcript = [...history];
  let callMarks = [];
  const records = [];
  const bursts = [];
  for (const [index, step] of scenario.steps.entries()) {
    const { incoming, callers, seeded } = stepLines({ step, index, transcript, firstAt, lineOf, seedLine });
    const plan =
      callers.length > 0
        ? planBurst(callers, { history: [...transcript, ...seeded] })
        : { turns: [], replaced: [], dropped: [] };
    const byId = new Map(callers.map((line) => [line.id, line]));
    const about = (id) => ({ id, author: byId.get(id)?.authorId ?? null, text: byId.get(id)?.content ?? '' });
    const burst =
      callers.length > 1
        ? {
            step: index + 1,
            turns: plan.turns.map((turn) => turn.line.id),
            replaced: plan.replaced.map(({ id, by }) => ({ ...about(id), by })),
            dropped: plan.dropped.map(({ id, reason }) => ({ ...about(id), reason })),
          }
        : null;
    if (burst) bursts.push(burst);
    let lines = [...transcript, ...incoming];
    for (const [turnIndex, turn] of plan.turns.entries()) {
      const at = newestTs(lines, turn.line.ts);
      const situation = { history: lines, triggerId: turn.line.id, kind: turn.kind, mode: 'reply' };
      const answered = await answerStep({
        situation,
        trigger: turn.line,
        at,
        callMarks,
        result: step.result ?? scenario.result,
        step: index + 1,
        turn: turnIndex + 1,
        queued: turn.queued,
      });
      if (answered?.stopped || !answered?.run) return { records, stopped: true, transcript: lines, bursts };
      const { scenario: id, run, ...rest } = runRecord(scenario.id, runIndex, answered.run);
      const queue = burst
        ? {
            turns: plan.turns.length,
            kind: turn.kind,
            trigger: about(turn.line.id),
            queued: turn.queued.length,
            replaced: burst.replaced,
            dropped: burst.dropped,
          }
        : null;
      const record = queue
        ? { scenario: id, run, step: index + 1, turn: turnIndex + 1, ...rest, queue }
        : { scenario: id, run, step: index + 1, ...rest };
      records.push(record);
      if (typeof onRecord === 'function') onRecord(record);
      ({ transcript: lines, callMarks } = afterTurn({
        transcript: lines,
        callMarks,
        run: answered.run,
        at,
        triggerId: turn.line.id,
      }));
    }
    transcript = lines;
  }
  return { records, stopped: false, transcript, bursts };
}

/** At most THINK_EXCERPT_CHARS of her `<think>` for the report, on one line; the whole stays in runs.jsonl. */
const THINK_EXCERPT_CHARS = 300;

/** One line of text for a markdown table cell. */
function cell(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

/** `text` as a markdown quote, line by line. */
function quoted(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * One pass of a run (visibleOf's) as markdown lines; with `detail` (a step of a multi-step
 * scenario) the members her messages would mention and the start of her `<think>` too.
 */
function passLines(pass, { detail = false } = {}) {
  if (!pass) return [];
  const out = [];
  for (const message of pass.messages) out.push(quoted(message), '');
  if (pass.reactions.length > 0) out.push(`reactions: ${pass.reactions.join(' ')}`, '');
  if (pass.gif) out.push(`gif: ${pass.gif}`, '');
  if (pass.messages.length === 0 && pass.reactions.length === 0 && !pass.gif)
    out.push(pass.skip ? '(skip)' : '(nothing)', '');
  if (detail && Array.isArray(pass.mentions))
    out.push(
      `mentions: ${pass.mentions.length > 0 ? pass.mentions.join(', ') : '(none)'}; unknown handles: ${pass.unknownHandles ?? 0}`,
      ''
    );
  if (detail && pass.think) out.push(`think: ${thinkExcerpt(pass.think)}`, '');
  return out;
}

/** The start of her `<think>` on one line: at most THINK_EXCERPT_CHARS, `...` when cut. */
function thinkExcerpt(text) {
  const think = cell(text);
  return think.length > THINK_EXCERPT_CHARS ? `${think.slice(0, THINK_EXCERPT_CHARS)}...` : think;
}

/** One decision (a run, or a step of one) as markdown lines under `heading`; `detail` as passLines. */
function recordLines(record, heading, { detail = false } = {}) {
  const lines = [heading, ''];
  if (record.decision === 'call') {
    const verdict = record.verdict?.ok
      ? 'passed'
      : `refused at ${record.verdict?.stage}: ${record.verdict?.code}${record.verdict?.reason ? ` (${record.verdict.reason})` : ''}`;
    lines.push(`call: \`${cell(record.skill)}\` ${cell(JSON.stringify(record.args))}`, '', `gateway: ${verdict}`, '');
    if (detail && record.callMentions)
      lines.push(
        `call mentions: ${record.callMentions.mentions.join(', ') || '(none)'}; unknown handles: ${record.callMentions.unknownHandles ?? 0}`,
        ''
      );
  }
  if (record.extraCalls > 0) lines.push(`extra calls ignored: ${record.extraCalls}`, '');
  lines.push(...passLines(record.first, { detail }));
  if (record.followUp?.error) lines.push(`follow-up failed: ${cell(record.followUp.error)}`, '');
  else if (record.followUp)
    lines.push(
      `after the result (${record.result?.status}${record.result?.code ? `, ${record.result.code}` : ''}):`,
      '',
      ...passLines(record.followUp, { detail })
    );
  lines.push(
    `tokens: ${record.tokens.prompt} in, ${record.tokens.completion} out; cost: ${record.cost === null ? '-' : record.cost.toFixed(4)}`,
    ''
  );
  return lines;
}

/** A cost for the report: 4 decimals, '-' for none. */
function costText(cost) {
  return cost === null || cost === undefined ? '-' : cost.toFixed(4);
}

/**
 * A tool-loop run (runRecord's `loop`) as markdown lines under `heading`: the calls made in order
 * (`step.skill status`), her final messages, the turn's latency and cost, then step by step the
 * calls with their verdicts, result sizes and times, the calls dropped, her messages and the
 * request's size, latency, tokens and cost.
 */
function loopLines(record, heading) {
  const loop = record.loop;
  const calls = loop.calls.map((c) => `${c.step}:${c.skill} ${c.status ?? 'refused'}${c.code ? ` (${c.code})` : ''}`);
  const lines = [heading, '', `calls in order: ${calls.length > 0 ? cell(calls.join('; ')) : '(none)'}`, ''];
  lines.push(
    'final messages:',
    '',
    ...(loop.final.length > 0 ? loop.final.flatMap((m) => [quoted(m), '']) : ['(none)', ''])
  );
  lines.push(
    `turn: ${loop.ms ?? '-'} ms, ${loop.steps.length} requests, ${record.tokens.prompt} in, ${record.tokens.completion} out, cache ${record.tokens.cacheRead ?? 0} read / ${record.tokens.cacheWrite ?? 0} written; cost: ${costText(record.cost)}`,
    ''
  );
  if (loop.held || loop.thinkMissing || loop.coerced || loop.capped || loop.malformed)
    lines.push(
      `held steps: ${loop.held ?? 0}; think missing: ${loop.thinkMissing ?? 0}; coerced: ${loop.coerced ?? 0}; capped: ${loop.capped ?? 0}; unreadable calls: ${loop.malformed ?? 0}`,
      ''
    );
  for (const errand of loop.errands)
    lines.push(
      `errand recorded (step ${errand.step}, not dispatched): ${cell(errand.agent)}: ${cell(errand.goal)}`,
      ''
    );
  for (const step of loop.steps) {
    lines.push(
      `step ${step.step}${step.step === 0 ? ' (reply)' : ''}: ${step.requestChars ?? '-'} chars, ${step.ms ?? '-'} ms, ${step.tokens.prompt} in, ${step.tokens.completion} out, cost ${costText(step.cost)}`,
      ''
    );
    if (step.error) lines.push(`failed: ${cell(step.error)}`, '');
    else {
      if (step.held) lines.push('speech held (not posted):', '');
      lines.push(...passLines(step.answer, { detail: true }));
    }
    for (const c of step.calls) {
      const verdict = c.verdict?.ok ? 'passed' : `refused at ${c.verdict?.stage}: ${c.verdict?.code}`;
      const tool = c.tool
        ? `, tool ${c.tool.ms ?? '-'} ms, ${c.tool.requests ?? 0} requests, cost ${costText(c.tool.cost)}`
        : '';
      lines.push(
        `- call \`${cell(c.skill)}\` ${cell(JSON.stringify(c.args))}: ${verdict}; ${c.result?.status ?? '-'}${c.result?.code ? ` (${c.result.code})` : ''}, ${c.result?.chars ?? 0} chars, ${c.ms ?? '-'} ms${tool}`
      );
    }
    if (step.calls.length > 0) lines.push('');
    if (step.dropped > 0) lines.push(`dropped: ${step.dropped}${step.capped ? ` (loop cap: ${step.capped})` : ''}`, '');
    else if (step.capped) lines.push(`loop ended: cap ${step.capped}`, '');
  }
  return lines;
}

/**
 * What a scenario puts to her, as markdown lines: its steps (stepsLines), the end of its errand
 * (`errand <id> (<agent>, <state>) asked by <asker>`, the goal, the result's text, each file's
 * handle), or its message.
 */
function stimulusLines(scenario) {
  if (scenario.steps) return stepsLines(scenario.steps);
  if (!scenario.taskResult) return [quoted(scenario.text), ''];
  const errand = scenario.taskResult;
  const id = scenarioTaskId(scenario.id);
  const lines = [
    `errand ${id} (${errand.agent}, ${errand.state}) asked by ${errand.asker}:`,
    '',
    quoted(errand.goal),
    '',
  ];
  if (errand.text) lines.push('result:', '', quoted(errand.text), '');
  if (errand.files.length > 0)
    lines.push(`files: ${errand.files.map((file) => `\`file:${id}/${cell(file.name)}\``).join(', ')}`, '');
  return lines;
}

/**
 * A multi-step scenario's steps as markdown lines: each message by its author (a seeded line of
 * hers by `persona (seeded)`), the gap before it, a step of only her lines marked as running no turn.
 */
function stepsLines(steps) {
  const lines = [];
  steps.forEach((step, index) => {
    const notes = [`+${step.gapMinutes} min`];
    if (step.messages.length > 1) notes.push(`a burst of ${step.messages.length}`);
    if (step.messages.length > 0 && step.messages.every((message) => message.self === true))
      notes.push('seeded, no turn');
    lines.push(`step ${index + 1} (${notes.join(', ')}):`, '');
    for (const message of step.messages)
      lines.push(quoted(`${message.self === true ? 'persona (seeded)' : message.author}: ${message.text}`), '');
  });
  return lines;
}

/**
 * The markdown report of a `--skills` run: a table of every scenario's counts (scenarioSummary;
 * a multi-step scenario's over every decision, its runs counted as runs), a table of the
 * multi-step ones (sequenceSummary: each run's pattern, its first decline, how many resumed
 * after one), then per scenario its message (or steps), grants and every run: the decision, the
 * call with its arguments and the gateway's verdict, her messages of the first pass and of the
 * follow-up -- step by step for a multi-step one, with the members her messages would mention
 * and the start of her `<think>`. Tool output for the owner, not model-facing. Pure.
 * @param {{ scenario: object, grantNames: string[], summary: object, records: object[], error?: string }[]} entries
 * @returns {string}
 */
export function renderSkillsReport(entries) {
  const lines = [
    '# Skill scenarios',
    '',
    '| scenario | runs | calls | passed | denied | no call | malformed | follow-ups | cost (USD) |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const { scenario, summary, error } of entries) {
    if (error) lines.push(`| ${cell(scenario.id)} | failed: ${cell(error)} | | | | | | | |`);
    else
      lines.push(
        `| ${cell(scenario.id)} | ${summary.runs} | ${summary.calls} | ${summary.passed} | ${summary.denied} | ${summary.noCall} | ${summary.malformed} | ${summary.followUps} | ${summary.cost === null ? '-' : summary.cost.toFixed(4)} |`
      );
  }
  const sequences = entries.filter(
    (entry) => !entry.error && entry.scenario.steps && Array.isArray(entry.summary?.sequences)
  );
  if (sequences.length > 0) {
    lines.push(
      '',
      '| scenario | steps | runs | calls per step (C call, N none, M malformed) | first decline | resumed after a decline |',
      '|---|---|---|---|---|---|'
    );
    for (const { scenario, summary } of sequences) {
      const declined = summary.sequences.filter((s) => s.firstDecline !== null);
      const firsts = summary.sequences.map((s) => (s.firstDecline === null ? '-' : String(s.firstDecline))).join(' ');
      const resumed = `${declined.filter((s) => s.resumed).length}/${declined.length}`;
      const cut = summary.sequences.some((s) => !s.complete) ? ' (cut short)' : '';
      lines.push(
        `| ${cell(scenario.id)} | ${summary.steps} | ${summary.runs} | \`${cell(summary.pattern)}\`${cut} | ${firsts} | ${resumed} |`
      );
    }
  }
  for (const { scenario, grantNames, records = [], error } of entries) {
    const stimulus = stimulusLines(scenario);
    lines.push(
      '',
      `## ${scenario.id}`,
      '',
      ...stimulus,
      `grants: ${grantNames?.length ? grantNames.join(', ') : '(none)'}; discovery: ${Array.isArray(scenario.discovery) ? scenario.discovery.join(', ') : scenario.discovery}`,
      ''
    );
    if (error) {
      lines.push(`failed: ${cell(error)}`);
      continue;
    }
    if (!scenario.steps) {
      for (const record of records)
        lines.push(
          ...(record.loop
            ? loopLines(record, `### run ${record.run}: ${record.decision}`)
            : recordLines(record, `### run ${record.run}: ${record.decision}`))
        );
      continue;
    }
    for (const { run, ordered, pattern } of runPatterns(records)) {
      lines.push(`### run ${run}: ${pattern}`, '');
      for (const record of ordered) {
        if (record.queue && record.turn === 1) lines.push(...burstLines(ordered.filter((r) => r.step === record.step)));
        const title = `#### ${decisionTitle(record)}: ${record.decision}`;
        lines.push(...(record.loop ? loopLines(record, title) : recordLines(record, title, { detail: true })));
      }
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** A step record's place: `step 2`, or for a burst's turn `step 2, turn 1 of 3 (name, <author>: <text>)`. */
function decisionTitle(record) {
  if (!record.queue) return `step ${record.step}`;
  const trigger = record.queue.trigger ?? {};
  return `step ${record.step}, turn ${record.turn} of ${record.queue.turns} (${record.queue.kind}, ${cell(trigger.author)}: ${cell(trigger.text)})`;
}

/**
 * How the live queue played one step's burst (the step's records of one run, playSteps's `queue`):
 * the messages that got a turn in the order they got it, the follow-ups a newer one replaced
 * (live, missed-answer candidates) and the calls the queue's cap dropped, as markdown lines.
 */
function burstLines(stepRecords) {
  const queue = stepRecords[0]?.queue;
  if (!queue) return [];
  const turns = stepRecords.map(
    (record) =>
      `${record.turn}. ${cell(record.queue.trigger?.author)}: ${cell(record.queue.trigger?.text)} (${record.queue.kind})`
  );
  const lines = [`burst: ${queue.turns} turns: ${turns.join('; ')}`, ''];
  if (queue.replaced.length > 0)
    lines.push(`replaced: ${queue.replaced.map((m) => `${cell(m.author)}: ${cell(m.text)}`).join('; ')}`, '');
  if (queue.dropped.length > 0)
    lines.push(
      `dropped (${queue.dropped[0].reason}): ${queue.dropped.map((m) => `${cell(m.author)}: ${cell(m.text)}`).join('; ')}`,
      ''
    );
  return lines;
}

/** The two prompt layers of `--pair-prompts`, in the order they are given. */
const PAIR_SIDES = Object.freeze(['A', 'B']);

/** One decision as a pair-report cell: the call with its arguments and the gateway's verdict, no call, a malformed call; '-' for none. */
function decisionCell(record) {
  if (!record) return '-';
  if (record.decision === 'call') {
    const verdict = record.verdict?.ok ? 'passed' : `refused at ${record.verdict?.stage}: ${record.verdict?.code}`;
    return `call \`${cell(record.skill)}\` ${cell(JSON.stringify(record.args))} (${cell(verdict)})`;
  }
  return record.decision === 'malformed-call' ? 'malformed call' : 'no call';
}

/** One pass's messages as a pair-report cell: joined by ` / `, `(skip)` / `(nothing)` without one, its error; '-' for no pass. */
function messagesCell(pass) {
  if (!pass) return '-';
  if (pass.error) return `failed: ${cell(pass.error)}`;
  if (Array.isArray(pass.messages) && pass.messages.length > 0) return pass.messages.map(cell).join(' / ');
  return pass.skip ? '(skip)' : '(nothing)';
}

/** The key of one decision of a run: its run, step and turn (1 for a single-turn scenario's). */
function decisionKey(record) {
  return `${record.run}|${record.step ?? 1}|${record.turn ?? 1}`;
}

/**
 * The markdown report of a `--skills --pair-prompts` run: the two prompt directories (`a`, `b`),
 * a table of every scenario with each side's decisions (runPatterns: one letter per decision, a
 * run's letters together, runs space-separated: `CCCCCN` vs `CCNNNN`), its first declines per run
 * and its cost; then per scenario its message (or steps) and grants, and every decision of every
 * run side by side -- a burst's turns each on its own (decisionTitle) --: the decision, her
 * messages, those after the result when either side had a follow-up, and the first
 * THINK_EXCERPT_CHARS of her `<think>`. A side that failed shows its error. Tool output for the
 * owner, not model-facing. Pure.
 * @param {{ scenario: object, grantNames?: string[], error?: string,
 *   sides?: Record<'A'|'B', { records: object[], summary: object|null, error?: string }> }[]} entries
 * @param {{ a: string, b: string }} dirs
 * @returns {string}
 */
export function renderPairReport(entries, { a, b }) {
  const lines = [
    '# Skill scenarios: prompt layers A and B',
    '',
    `A: ${a}`,
    '',
    `B: ${b}`,
    '',
    '| scenario | runs | A: calls per decision | B: calls per decision | A: first decline | B: first decline | A: cost (USD) | B: cost (USD) |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const { scenario, sides, error } of entries) {
    if (error) {
      lines.push(`| ${cell(scenario.id)} | failed: ${cell(error)} | | | | | | |`);
      continue;
    }
    const shown = PAIR_SIDES.map((side) => {
      const result = sides?.[side];
      if (!result || result.error)
        return { runs: 0, pattern: `failed: ${cell(result?.error ?? 'not run')}`, declines: '-', cost: '-' };
      const patterns = runPatterns(result.records ?? []);
      return {
        runs: patterns.length,
        pattern: patterns.length > 0 ? `\`${patterns.map((p) => p.pattern).join(' ')}\`` : '-',
        declines:
          patterns.length > 0
            ? patterns.map((p) => (p.firstDecline === null ? '-' : String(p.firstDecline))).join(' ')
            : '-',
        cost: Number.isFinite(result.summary?.cost) ? result.summary.cost.toFixed(4) : '-',
      };
    });
    const [left, right] = shown;
    lines.push(
      `| ${cell(scenario.id)} | ${Math.max(left.runs, right.runs)} | ${left.pattern} | ${right.pattern} | ${left.declines} | ${right.declines} | ${left.cost} | ${right.cost} |`
    );
  }
  for (const { scenario, grantNames, sides, error } of entries) {
    const stimulus = stimulusLines(scenario);
    lines.push(
      '',
      `## ${scenario.id}`,
      '',
      ...stimulus,
      `grants: ${grantNames?.length ? grantNames.join(', ') : '(none)'}; discovery: ${Array.isArray(scenario.discovery) ? scenario.discovery.join(', ') : scenario.discovery}`,
      ''
    );
    if (error) {
      lines.push(`failed: ${cell(error)}`);
      continue;
    }
    const bySide = PAIR_SIDES.map(
      (side) => new Map((sides?.[side]?.records ?? []).map((record) => [decisionKey(record), record]))
    );
    const all = [
      ...new Map(
        [...bySide[1].values(), ...bySide[0].values()].map((record) => [decisionKey(record), record])
      ).values(),
    ].sort((x, y) => x.run - y.run || (x.step ?? 1) - (y.step ?? 1) || (x.turn ?? 1) - (y.turn ?? 1));
    let run = null;
    for (const record of all) {
      if (record.run !== run) {
        run = record.run;
        lines.push(`### run ${run}`, '');
      }
      const key = decisionKey(record);
      const [left, right] = bySide.map((map) => map.get(key) ?? null);
      if (scenario.steps) lines.push(`#### ${decisionTitle(record)}`, '');
      const think = (side) => (side?.first?.think ? thinkExcerpt(side.first.think) : '-');
      lines.push(
        '| | A | B |',
        '|---|---|---|',
        `| decision | ${decisionCell(left)} | ${decisionCell(right)} |`,
        `| messages | ${messagesCell(left?.first)} | ${messagesCell(right?.first)} |`
      );
      if (left?.followUp || right?.followUp)
        lines.push(`| after the result | ${messagesCell(left?.followUp)} | ${messagesCell(right?.followUp)} |`);
      lines.push(`| think | ${think(left)} | ${think(right)} |`, '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * The `--skills` mode (see the header): every scenario of `scenarios` put to the persona after
 * its channel's real chat, nothing posted, run or written but the output files. `sides`: the
 * prompt layers the scenarios are answered under, `[{ label, hot }]` -- one with label null (the
 * live prompts, or `--prompts`), or A and B (`--pair-prompts`: every scenario under both, over
 * the same fetched chat, the same config and memory, the same number of runs). Returns
 * `{ code, result }`: code 1 when a scenario failed or the runs were stopped.
 */
async function runSkills({
  args,
  scenarios,
  root,
  liveData,
  dataDir,
  mods,
  hot,
  sides,
  store,
  guild,
  guildId,
  client,
  self,
  llm,
  calibrator,
  mediaCache,
  gifs,
  customEmoji,
  searchAvailable,
  before,
  log,
  signal,
  budget,
  viewMods,
  channelOf,
  channelDirectory = null,
  loopDeps = null,
}) {
  const {
    answerSkillScenario,
    skillScenarioRequest,
    scenarioInventory,
    simulateCall,
    personaGrantsConfig,
    replayMedia,
    fetchHistoryWindow,
    requesterOf,
    callViewOf,
    skillRegistry,
    expandPersonaGrant,
    createImageGen,
    grantedSkillNames,
    createTaskStore,
    parseFileHandle,
  } = mods;
  // Her tools run for real where they only read (web.search, memory.search: `loopDeps`); `coreOn` (features.coreTools in the
  // config read, or forced by --core-tools) is the pre-reply classifiers' switch: off, the search classifier names her skills.
  const coreOn = loopDeps.coreOn;
  const registry = skillRegistry();
  const names = [...registry.keys()];
  const pairing = sides.length > 1;
  // Every name is checked before anything is fetched or sent.
  const plans = scenarios.map((scenario) => ({
    scenario,
    grantNames: scenarioGrants(scenario, expandPersonaGrant),
    discovery: scenarioDiscovery(scenario, names),
  }));

  let outDir = null;
  if (!args.dry) {
    outDir = path.resolve(root, args.outDir ?? `replay-skills-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    if (outDir === liveData || outDir.startsWith(`${liveData}${path.sep}`))
      throw new CliError('replay-cli: --out may not be under data/');
    if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0)
      throw new CliError(`replay-cli: ${outDir} is not empty`);
    fs.mkdirSync(outDir, { recursive: true });
  }
  const jsonl = outDir ? path.join(outDir, 'runs.jsonl') : null;
  // A record as runs.jsonl holds it: under --pair-prompts with its side after the scenario.
  const writeRecords = (records, label) => {
    if (!jsonl || records.length === 0) return;
    const lines = records.map((record) =>
      JSON.stringify(label ? { scenario: record.scenario, side: label, ...record } : record)
    );
    fs.appendFileSync(jsonl, `${lines.join('\n')}\n`);
  };

  // The spend cap: what the provider reports spent (else the estimate per request) stops the runs at --spend.
  let spent = 0;
  const spendStop = new AbortController();
  // Ctrl-C stops the runs too: one signal for both.
  if (signal?.aborted) spendStop.abort();
  else signal?.addEventListener?.('abort', () => spendStop.abort(), { once: true });
  const runSignal = spendStop.signal;
  if (jsonl) fs.writeFileSync(jsonl, '');
  const capped = {
    async complete(messages, options) {
      if (budget !== null && spent >= budget) {
        spendStop.abort();
        throw new Error('replay-cli: --spend reached');
      }
      const completion = await llm.complete(messages, { ...options, signal: runSignal });
      const cost = Number(completion?.usage?.cost);
      spent += Number.isFinite(cost) ? cost : USD_PER_ANSWER;
      if (budget !== null && spent >= budget) spendStop.abort();
      return completion;
    },
  };
  // The image quota a drawing's budget is read from: today's counters of the state copy, read only.
  const refusing = async () => {
    throw new Error('replay-cli: no request from the image client');
  };
  const frozenState = {
    data: store.state.data,
    markDirty() {
      throw new Error('replay-cli: the state is read-only here');
    },
  };
  const errorOf = (err) => (err instanceof CliError ? err.message : `${err?.name ?? 'Error'}`);

  const entries = [];
  const dry = [];
  let cut = false;
  for (const { scenario, grantNames, discovery } of plans) {
    if (runSignal.aborted) {
      cut = true;
      break;
    }
    // The moment the scenario is put after, fetched once for every side.
    let moment;
    try {
      const channel = await readableChannel({ client, guild, guildId, channelId: scenario.channelId });
      // Every member who writes in the scenario: one, or each step's authors; for an errand's end, who asked for it.
      const authors = scenario.steps
        ? [
            ...new Set(
              scenario.steps.flatMap((step) =>
                step.messages.filter((message) => message.self !== true).map((message) => message.author)
              )
            ),
          ]
        : [scenario.taskResult ? scenario.taskResult.asker : scenario.author];
      if (authors.includes(self.id))
        throw new CliError(`replay-cli: the ${scenario.taskResult ? 'asker' : 'author'} is the persona`);
      const history = await fetchWindow({
        guild,
        channel,
        self,
        anchorId: scenario.before,
        limit: Math.max(1, before),
        config: hot.config,
        fetchHistoryWindow,
        log,
        memberIds: authors,
      });
      if (scenario.before && history[history.length - 1]?.id !== scenario.before)
        throw new CliError('replay-cli: the anchor message was not found in that channel');
      if (scenario.taskResult && history.length === 0)
        throw new CliError("replay-cli: the channel has no message to put the errand's end after");
      const last = history[history.length - 1] ?? null;
      const firstGapMs = scenario.steps ? scenario.steps[0].gapMinutes * 60_000 : SCENARIO_AFTER_MS;
      const at = scenario.before && last ? last.ts + firstGapMs : Date.now();
      moment = { channel, history, at };
    } catch (err) {
      const error = errorOf(err);
      if (args.dry) dry.push({ id: scenario.id, error });
      else entries.push({ scenario, grantNames, records: [], summary: null, error });
      continue;
    }
    const { channel, history, at } = moment;
    const nameOf = (id) => guild.members.cache.get(id)?.displayName ?? store.getUser(guildId, id)?.names?.[0] ?? id;
    // A scenario's message: the single one and a step's own tag her; a burst's message calls her by its text alone.
    const lineOf = (message, ts, { tagged = true } = {}) =>
      scenarioTrigger({
        text: message.text,
        authorId: message.author,
        authorName: nameOf(message.author),
        channel: channelOf(channel),
        selfId: self.id,
        at: ts,
        tagged,
      });
    // The config with her grants, read now and kept for the scenario (both sides); never written.
    // --core-tools: features.coreTools on in that copy; --transport: the tools' transport.
    const scenarioConfig = personaGrantsConfig(
      withTransport(args.coreTools ? withCoreTools(hot.config) : hot.config, args.transport),
      self.id,
      grantNames
    );
    // A step's burst as the live queue plays it, with the scenario's config (name triggers, switches, caps).
    const planBurst = (incoming, { history: before }) =>
      mods.burstTurns(incoming, { selfId: self.id, config: scenarioConfig, history: before });
    // A line of hers the scenario seeds: shaped as her live lines, no turn run for it.
    const seedLine = (message, ts) =>
      mods.seededSelfLine({
        text: message.text,
        at: ts,
        selfId: self.id,
        selfName: self.name,
        channel: channelOf(channel),
      });
    // An errand's end (a task-result scenario): the turn src/errands/turns.js opens at `at` in its
    // origin channel -- no message of the chat to reply to, so an interjection of kind `task` --,
    // asked for by its asker (the requester a live result turn hands in: the id, no roles).
    const task = scenario.taskResult ? scenarioTask(scenario, { at }) : null;
    // A single-turn scenario's message, or the steps up to the first that runs her turn (5 s apart within one): what the first request reads.
    const first = scenario.steps
      ? firstDecision({ scenario, history, firstAt: at, lineOf, seedLine, planBurst })
      : task
        ? { lines: history, turn: null }
        : { lines: [...history, lineOf(scenario, at)], turn: null };
    const firstTurn = task
      ? null
      : (first.turn ?? { line: first.lines[first.lines.length - 1], kind: 'mention', queued: [] });
    const trigger = firstTurn?.line ?? null;
    const situation = task
      ? { history: first.lines, mode: 'interject' }
      : { history: first.lines, triggerId: trigger.id, kind: firstTurn.kind, mode: 'reply' };
    const images = {
      quota: createImageGen({ apiKey: '', getConfig: () => scenarioConfig, state: frozenState, fetchImpl: refusing })
        .quota,
    };
    // An errand's budget as live: the guild's tasks.json of the data read (live or --snapshot) against the scenario's config, never queued into.
    const tasks = sandboxErrandBudget({
      createTaskStore,
      guildId,
      config: () => scenarioConfig,
      log,
      memoryDb: memoryFor(dataDir),
    });
    // The files of the scenario's errand, named by their handles as live (`file:<task id>/<name>`).
    const fileOf = task ? scenarioFileOf(task, parseFileHandle) : null;
    const memoryOn = scenarioConfig.features?.memory !== false;
    // Her call taken through the real resolution and gateway at `now`, never run: answered with `resultText`.
    // Her in-turn tools run for real (`tools`, loopCall); every other call, a write or a paid effect, is answered canned; a task.run is only recorded.
    const onCallOf = (callRequester, now, resultText, tools) => {
      const simulate = simulatedCallOf(callRequester, now, resultText);
      return loopCall({
        simulate,
        runTool: (skill, toolArgs, refs) =>
          tools.run(skill, toolArgs, { history: refs.history ?? [], at: now, idByIndex: refs.idByIndex ?? null }),
        inTurn: loopDeps.IN_TURN_TOOLS,
        log,
      });
    };
    const simulatedCallOf =
      (callRequester, now, resultText) =>
      (call, { idByIndex, history: lines, channelHandles = null }) =>
        simulateCall({
          call,
          view: callViewOf({
            channel,
            snapshot: guildListing(channel),
            guildId,
            idByIndex,
            lines,
            pulledIds: new Map(),
            memoryOn,
            store,
            selfId: self.id,
            skills: registry,
            channelHandles,
            fileOf,
          }),
          config: scenarioConfig,
          selfId: self.id,
          requester: callRequester,
          conversationId: channel.id,
          now,
          images,
          tasks,
          resultText,
        });

    // One prompt layer's runs of the scenario (`label` its side under --pair-prompts): its records,
    // written to runs.jsonl as they come, and its summary (or its `--dry` sizes).
    const playSide = async (sideHot, label) => {
      const hotLike = {
        get prompts() {
          return sideHot.prompts;
        },
        get config() {
          return scenarioConfig;
        },
      };
      // Her in-turn tools over this side's prompts (the labels their results are worded by); with
      // features.coreTools on the server search's senses line and the memory prefetch stand in every request, as live.
      const tools = loopDeps.toolsFor({ hot: hotLike, channel, llm: capped });
      const coreTools = coreOn
        ? {
            recallAvailable: tools.recallAvailable(),
            // The automatic memory prefetch a live turn runs for the scenario's trigger, as of its first decision.
            prefetch: await tools.prefetch({
              trigger,
              triggerKind: task ? 'task' : null,
              mode: situation.mode ?? null,
              history: situation.history,
              at: task ? at : newestTs(situation.history, trigger?.ts),
            }),
          }
        : null;
      const loop = { settings: loopDeps.loopSettings(scenarioConfig) };
      const loopInput = { ...(coreTools ? { coreTools } : {}), loop };
      // The first decision is answered once the first step's messages are in: at the newest of them (an errand's end: when it ended).
      const firstAt = task ? at : newestTs(situation.history, trigger.ts);
      // The memory as it stands at the scenario's first decision, for every step: nothing is learned in between.
      const { view } = memoryViewFor({
        hotLike,
        store,
        guildId,
        calibrator,
        situation,
        at: firstAt,
        args: { asOfMoment: args.asOfMoment, hideSelf: [], hideSelfAll: false },
        mods: viewMods,
      });
      // One decision's request inputs: the requester's catalogue (the trigger's author), the media of the channel so far.
      const turnInput = (turnMoment, turnAt, turnTrigger) => {
        // An errand's end: who asked for it, as src/errands/turns.js hands them in (no roles: src/behavior/turn.js#callEnvelope).
        const requester = task ? { id: task.requester.userId, roleIds: [] } : requesterOf(turnTrigger, channel);
        // With features.coreTools on no search classifier runs before her reply, so none names her skills: no <skills> (as live).
        const inventory = coreOn
          ? null
          : scenarioInventory({
              config: scenarioConfig,
              selfId: self.id,
              texts: sideHot.prompts?.skills,
              requester,
              conversationId: channel.id,
              registry,
              discovery,
            });
        const media = replayMedia(turnMoment.history, {
          cache: mediaCache,
          sites: scenarioConfig.media?.video?.sites,
          before: null,
        });
        const input = {
          view,
          situation: turnMoment,
          selfId: self.id,
          selfName: self.name,
          channel: channelOf(channel),
          at: turnAt,
          descriptions: media.descriptions,
          videos: media.videos,
          customEmoji,
          gifs,
          mediaCache,
          searchAvailable,
          skillsInventory: inventory,
          channelDirectory,
          ...(task ? { taskResult: task } : {}),
        };
        return {
          input,
          requester,
          shown: { rows: inventory?.length ?? 0, allowed: (inventory ?? []).filter((row) => row.allowed).length },
        };
      };
      const { input, requester, shown } = turnInput(situation, firstAt, trigger);
      if (args.dry) {
        const request = skillScenarioRequest({
          ...input,
          queued: firstTurn?.queued ?? null,
          ...(coreTools ? { coreTools } : {}),
        });
        return {
          dry: {
            id: scenario.id,
            channelId: channel.id,
            lines: history.length,
            systemChars: request.system.length,
            userChars: request.user.length,
            tokens: request.tokens,
            limit: request.limit,
            toolsTokens: request.toolsTokens,
            tools: request.tools,
            transport: request.transport,
            toolsBlock: blockOf(request.user, 'tools') !== null,
            skillsBlock: blockOf(request.user, 'skills') !== null,
            skills: shown,
            runs: scenario.runs,
            ...(scenario.steps ? { steps: scenario.steps.length } : {}),
            ...(task
              ? {
                  taskResult: {
                    id: task.id,
                    block: blockOf(request.user, 'task_result') !== null,
                    files: task.result.files.length,
                  },
                }
              : {}),
            loop: loop.settings,
            ...(coreTools ? { coreTools: { recallAvailable: coreTools.recallAvailable } } : {}),
          },
        };
      }
      if (scenario.steps) {
        // Each run replays every step from the start: her turns carried into the channel the next turn reads.
        const { afterScenarioTurn } = mods;
        const records = [];
        let tokensEstimate = null;
        let stopped = false;
        for (let runIndex = 0; runIndex < scenario.runs; runIndex += 1) {
          if (runSignal.aborted) {
            stopped = true;
            break;
          }
          const played = await playSteps({
            scenario,
            history,
            firstAt: at,
            runIndex,
            lineOf,
            seedLine,
            planBurst,
            answerStep: async ({
              situation: turnMoment,
              trigger: turnTrigger,
              at: turnAt,
              callMarks,
              result,
              queued,
            }) => {
              const turn = turnInput(turnMoment, turnAt, turnTrigger);
              const answered = await answerSkillScenario({
                ...turn.input,
                ...loopInput,
                llm: capped,
                runs: 1,
                signal: runSignal,
                callMarks,
                queued,
                onCall: onCallOf(turn.requester, turnAt, result, tools),
              });
              tokensEstimate ??= answered.request.tokens;
              return { run: answered.runs[0] ?? null, stopped: answered.stopped };
            },
            afterTurn: ({ transcript, callMarks, run, at: turnAt, triggerId }) =>
              afterScenarioTurn({
                transcript,
                callMarks,
                run,
                at: turnAt,
                selfId: self.id,
                selfName: self.name,
                channel: channelOf(channel),
                triggerId,
                config: scenarioConfig,
              }),
            onRecord: (record) => writeRecords([record], label),
          });
          records.push(...played.records);
          if (played.stopped) {
            stopped = true;
            break;
          }
        }
        const summary = sequenceSummary(records, scenario.steps.length, {
          seededSteps: scenario.steps.filter((step) => !runsTurn(step)).length,
        });
        return { records, summary: { ...summary, skills: shown, tokensEstimate }, stopped };
      }
      const answered = await answerSkillScenario({
        ...input,
        ...loopInput,
        llm: capped,
        runs: scenario.runs,
        signal: runSignal,
        onCall: onCallOf(requester, task ? at : trigger.ts, scenario.result, tools),
      });
      const records = answered.runs.map((run, index) => runRecord(scenario.id, index, run));
      writeRecords(records, label);
      return {
        records,
        summary: { ...scenarioSummary(records), skills: shown, tokensEstimate: answered.request.tokens },
        stopped: answered.stopped,
      };
    };

    const results = {};
    for (const side of sides) {
      const key = side.label ?? 'single';
      if (runSignal.aborted) {
        cut = true;
        results[key] = { records: [], summary: null, error: 'not run: stopped' };
        continue;
      }
      try {
        const out = await playSide(side.hot, side.label);
        if (out.dry) {
          dry.push(side.label ? { ...out.dry, side: side.label } : out.dry);
          continue;
        }
        if (out.stopped) cut = true;
        results[key] = { records: out.records, summary: out.summary };
        log.info('replay-cli: skill scenario', {
          runs: out.summary.runs,
          calls: out.summary.calls,
          ...(out.summary.steps ? { steps: out.summary.steps } : {}),
          ...(side.label ? { side: side.label } : {}),
        });
      } catch (err) {
        const error = errorOf(err);
        if (args.dry) dry.push({ id: scenario.id, ...(side.label ? { side: side.label } : {}), error });
        else results[key] = { records: [], summary: null, error };
      }
    }
    if (args.dry) continue;
    if (pairing) entries.push({ scenario, grantNames, sides: { A: results.A, B: results.B } });
    else
      entries.push({
        scenario,
        grantNames,
        records: results.single.records,
        summary: results.single.summary,
        ...(results.single.error ? { error: results.single.error } : {}),
      });
  }
  // Stopped only when something was left unanswered: by Ctrl-C, else by the spend cap.
  const stoppedBy = !cut ? null : signal?.aborted ? 'signal' : 'spend';
  if (args.dry) return { code: dry.some((d) => d.error) ? 1 : 0, result: { dry: true, scenarios: dry } };
  const report = path.join(outDir, 'report.md');
  const dirs = pairing
    ? { a: path.resolve(root, args.pairPrompts[0]), b: path.resolve(root, args.pairPrompts[1]) }
    : null;
  fs.writeFileSync(report, pairing ? renderPairReport(entries, dirs) : renderSkillsReport(entries));
  const failed = pairing
    ? entries.flatMap((e) =>
        e.error
          ? [{ id: e.scenario.id, error: e.error }]
          : PAIR_SIDES.filter((side) => e.sides[side]?.error).map((side) => ({
              id: e.scenario.id,
              side,
              error: e.sides[side].error,
            }))
      )
    : entries.filter((e) => e.error).map((e) => ({ id: e.scenario.id, error: e.error }));
  const scenariosOut = pairing
    ? entries
        .filter((e) => !e.error)
        .map((e) => ({ id: e.scenario.id, A: e.sides.A?.summary ?? null, B: e.sides.B?.summary ?? null }))
    : entries.filter((e) => !e.error).map((e) => ({ id: e.scenario.id, ...e.summary }));
  return {
    code: failed.length > 0 || stoppedBy !== null ? 1 : 0,
    result: {
      out: outDir,
      runs: jsonl,
      report,
      ...(pairing ? { prompts: dirs } : args.prompts !== null ? { prompts: path.resolve(root, args.prompts) } : {}),
      scenarios: scenariosOut,
      failed,
      stoppedBy,
      spentUsd: Math.round(spent * 10000) / 10000,
    },
  };
}

/** The trigger kinds a failed search classifier falls back on (src/behavior/turn.js#DIRECT_CALLS). */
const DIRECT_CALL_KINDS = Object.freeze(['mention', 'reply', 'name', 'followUp', 'private']);

/**
 * What a live turn with features.coreTools off runs before her reply (src/behavior/turn.js#maybeLookup,
 * the classifier path; the turn planner's is not reproduced): the search classifier -- prompts.lookup
 * with `{{name}}`, `{{today}}` (`at`'s day in `bot.timezone`) and `{{skills}}` (`discovery.index`), the
 * user part lookupClassifierInput builds, on the `analyzer` (roleModel, helperRequestOptions, purpose
 * `lookup`) -- asked when its prompt is there and a side can run: the web side under
 * features.webLookup, web.search.enabled, `web.search.maxPerTurn` >= 1, the lookup's search and its
 * daily slots; the server side when the recall runner is available. Its answer (parseLookupAnswer) runs
 * a `web` query through `lookup.search` and a `server` part through `recall.run` (the chat as
 * history, the trigger as candidate), in parallel, a failing part counting as nothing; a failed or
 * empty answer on a direct call falls back to the server search on the question's own words
 * (fallbackLookupPlan, recall.fallbackOnClassifierFailure). Resolves `{ lookup, skills, recallAvailable,
 * trace }`: `lookup` the request's input as the live turn hands it to buildRequest (the web result,
 * `server` when the server search found text or a stretch; null when nothing), `skills` the answer's
 * `skills:` line (null for none), `trace` what happened (asked, error, the web query and the server
 * part asked for, which ran and found). Never throws for a failed part.
 */
export async function preTurnLookup({
  config,
  prompts,
  llm,
  lookup,
  recall,
  discovery,
  guild,
  guildId,
  channel,
  selfId,
  selfName,
  history,
  trigger,
  triggerKind,
  descriptions,
  videos,
  at,
  store,
  deps,
}) {
  const {
    lookupClassifierInput,
    fillPromptTemplate,
    zonedDay,
    roleModel,
    helperRequestOptions,
    parseLookupAnswer,
    recallSettings,
    fallbackLookupPlan,
  } = deps;
  const searchCfg = config.web?.search ?? {};
  const webOn =
    config.features?.webLookup === true && searchCfg.enabled !== false && typeof lookup?.search === 'function';
  const webCan =
    webOn &&
    (searchCfg.maxPerTurn ?? 1) >= 1 &&
    (typeof lookup.hasSearch !== 'function' || lookup.hasSearch()) &&
    (typeof lookup.webCapLeft !== 'function' || lookup.webCapLeft() > 0);
  let serverOn = false;
  try {
    serverOn = typeof recall?.available === 'function' ? recall.available() === true : Boolean(recall);
  } catch {
    serverOn = false;
  }
  const trace = {
    asked: false,
    error: null,
    web: null,
    server: null,
    webRan: false,
    webFound: false,
    serverRan: false,
    serverFound: false,
    fallback: false,
  };
  const done = (found, skills = null) => ({ lookup: found, skills, recallAvailable: serverOn, trace });
  const prompt = prompts?.lookup;
  if (!prompt || (!webCan && !serverOn)) return done(null);
  const { triggerText, user } = lookupClassifierInput({
    config,
    labels: prompts.labels,
    selfName,
    history,
    trigger,
    descriptions,
    videos,
    reads: undefined,
  });
  const timezone = config.bot?.timezone;
  trace.asked = true;
  let parsed = null;
  try {
    const completion = await llm.complete(
      [
        {
          role: 'system',
          content: fillPromptTemplate(prompt, {
            today: zonedDay(at, timezone),
            name: selfName ?? '',
            skills: discovery.index,
          }),
        },
        { role: 'user', content: user },
      ],
      {
        model: roleModel(config, 'analyzer', 'lookup'),
        ...helperRequestOptions(config, {
          role: 'analyzer',
          maxOutputTokens: searchCfg.classifierMaxOutputTokens ?? 2000,
          purpose: 'lookup',
        }),
      }
    );
    if (String(completion?.text ?? '').trim())
      parsed = parseLookupAnswer(completion.text, {
        timezone,
        now: at,
        maxForms: recallSettings(config)?.maxForms,
        skillNames: discovery.names,
      });
    else trace.error = 'empty';
  } catch (err) {
    trace.error = err?.name ?? 'classifier-failed';
  }
  let web = parsed?.web ?? null;
  let server = parsed?.server ?? null;
  if (!parsed) {
    // The failed classifier's fallback: on a direct call, the server search on the question's own words.
    const settings = recallSettings(config);
    const plan =
      serverOn && DIRECT_CALL_KINDS.includes(triggerKind) && settings?.fallbackOnClassifierFailure
        ? fallbackLookupPlan({
            text: triggerText,
            profiles: store.listUserProfiles?.(guildId) ?? [],
            selfId,
            selfName,
            maxForms: settings.maxForms,
          })
        : null;
    if (!plan) return done(null);
    trace.fallback = true;
    web = null;
    server = plan;
  }
  trace.web = web;
  trace.server = server;
  const runWeb = webCan && Boolean(web);
  const runServer = serverOn && Boolean(server);
  trace.webRan = runWeb;
  trace.serverRan = runServer;
  const settle = (work) =>
    Promise.resolve()
      .then(work)
      .catch(() => null);
  const [webResult, found] = await Promise.all([
    runWeb ? settle(() => lookup.search(guildId, web)) : null,
    runServer
      ? settle(() =>
          recall.run({
            guild,
            guildId,
            channel,
            selfId,
            selfName,
            history,
            context: history,
            contextDescriptions: descriptions,
            candidate: trigger,
            server,
          })
        )
      : null,
  ]);
  trace.webFound = Boolean(webResult?.text);
  const serverPart =
    found && (found.text || found.stretch)
      ? {
          text: found.text ?? null,
          stretch: found.stretch ?? null,
          people: Array.isArray(found.people) ? found.people : [],
        }
      : null;
  trace.serverFound = Boolean(serverPart);
  const result = serverPart ? { ...(webResult ?? {}), server: serverPart } : (webResult ?? null);
  return done(result, parsed?.skills ?? null);
}

/**
 * Whether the replay's requests go out without the prompt-cache marker: the splitter and the recall run, one sample
 * outside a scenario file, or `--no-cache`. The trigger runs (`--pair-transport`, `--loop-triggers`) are marked like a
 * live turn, their steps included, so the cache numbers and the cost they report are real.
 * @param {{ noCache?: boolean, split?: boolean, recall?: boolean, samples?: number|null, pairTransport?: boolean, loopTriggers?: boolean }} args
 * @param {boolean} hasScenarios  A `--skills` file is run.
 */
export function replayWithoutCache(args, hasScenarios) {
  if (args.noCache || args.split || args.recall) return true;
  return args.samples === 1 && !hasScenarios && !(args.pairTransport || args.loopTriggers);
}

/** Which of the turn-shaping blocks and lines a request's user text holds (the key of --pair-transport and --loop-triggers). */
export function requestBlocks(user, labels) {
  const has = (tag) => blockOf(user, tag) !== null;
  const line = (text) => typeof text === 'string' && text !== '' && String(user ?? '').includes(text);
  return {
    lookup: has('lookup'),
    skills: has('skills'),
    tools: has('tools'),
    searchLine: line(labels?.senses?.search),
    searchToolLine: line(labels?.senses?.searchTool),
    recallLine: line(labels?.senses?.recall),
    recallToolLine: line(labels?.senses?.recallTool),
  };
}

/** The two sides of `--pair-transport`: the native transport (A) and the text one (B). */
const TRANSPORT_SIDES = Object.freeze({ A: 'native', B: 'text' });

/** `config` with her tools' transport set (`skills.transport`): a shallow copy, the live config untouched; `transport` null leaves it. Pure. */
export function withTransport(config, transport) {
  if (transport !== 'native' && transport !== 'text') return config;
  return { ...config, skills: { ...(config?.skills ?? {}), transport } };
}

/**
 * One side's answer (runRecord's, of a reply turn answered as a skill scenario) as the blind sheet
 * shows it (tools/lib/pair.mjs#renderSheet): every message of the turn that was posted in order (a
 * held step's speech is not), the reactions and GIF of the posted steps, the pictures she drew
 * (`drawings`: her draw.create calls that went through) and the texts her message calls posted
 * (`posts`), her think, `skip` when nothing at all was said or done; and the calls she made in order
 * (`calls`, for the key: the sheet does not show them). A record without a loop (an old run: a reply and
 * one follow-up) is read as it was. Pure.
 * @param {object|null} record
 * @returns {object|null}
 */
export function pairAnswerOf(record) {
  if (!record) return null;
  const first = record.first ?? { messages: [], reactions: [], gif: null, skip: true, think: '' };
  const loop = record.loop ?? null;
  const posted = loop
    ? loop.steps.filter((step) => step.answer && !step.held).map((step) => step.answer)
    : [first, ...(record.followUp && !record.followUp.error ? [record.followUp] : [])];
  const messages = posted.flatMap((answer) => answer.messages);
  const reactions = posted.flatMap((answer) => answer.reactions ?? []);
  const gif = posted.map((answer) => answer.gif).find(Boolean) ?? null;
  const calls = loop
    ? loop.calls.map((c) => ({ step: c.step, skill: c.skill, status: c.status, code: c.code }))
    : record.skill
      ? [{ step: 0, skill: record.skill, status: record.result?.status ?? null, code: record.result?.code ?? null }]
      : [];
  const drawings = loop ? loop.drawings.map((d) => ({ text: d.text })) : [];
  const posts = loop ? loop.posts.map((d) => ({ text: d.text })) : [];
  const acted = messages.length > 0 || reactions.length > 0 || gif || drawings.length > 0 || posts.length > 0;
  return {
    think: first.think ?? '',
    messages,
    reactions,
    gif: gif ? { id: gif } : null,
    drawings,
    posts,
    skip: !acted,
    calls,
  };
}

/** A turn's flat counts for a report line or the compare tool: calls, requests, held steps and the like (runRecord's `loop`). */
function turnCounts(record) {
  const loop = record.loop;
  return {
    calls: loop.calls.length,
    requests: loop.requests,
    turnRequests: loop.turnRequests,
    held: loop.held,
    thinkMissing: loop.thinkMissing,
    steps: loop.steps.length,
    coerced: loop.coerced,
    capped: loop.capped,
    malformed: loop.malformed,
  };
}

/**
 * `--pair-transport` and `--loop-triggers` (see the header): every trigger of `pairTriggers` answered as a
 * skill-scenario turn of the sandbox over the same fetched chat, memory and clock, under the live grants --
 * her calls through the real gateway, web.search and memory.search run for real (loopCall), every write and
 * paid effect canned, a task.run only recorded --, her turn on the step engine (src/behavior/sandbox.js#runSkillLoop).
 * `sides`: `[{ key, transport }]` -- A (native) and B (text) for the pair, one side (`--transport`, else the
 * config's) for the loop run. What a live turn runs before her reply is run once per trigger and shared by the
 * sides: with features.coreTools on the memory prefetch, else the search classifier (preTurnLookup). The pair
 * writes the sheet and key `--pair` writes (tools/lib/pair.mjs#renderSheet; the key's `pairs.<id>.answers` and, per
 * side, `runs`: the first request's estimated tokens, the tools' tokens, the tokens and cost reported, the latency,
 * the calls, `blocks`, the whole run record); the loop run writes `runs.jsonl` (one line per trigger: the
 * trigger, its chat, the run record with every step -- calls, held, thinkMissing, coerced, capped, tokens with
 * the cache, latency) and `report.md`. Stops at `budget` (what the provider reports spent, else USD_PER_ANSWER per
 * request). Returns `{ code, result }`.
 */
export async function runTriggerLoops({
  single,
  args,
  root,
  liveData,
  pairTriggers,
  rng,
  hot,
  store,
  guild,
  guildId,
  self,
  llm,
  calibrator,
  mediaCache,
  gifs,
  customEmoji,
  searchAvailable,
  channelDirectory,
  signal,
  budget,
  mods,
  loopDeps,
  viewMods,
  momentOf,
  journalOf,
  channelOf,
  dataDir,
  log,
}) {
  const {
    answerSkillScenario,
    simulateCall,
    callViewOf,
    requesterOf,
    skillRegistry,
    createImageGen,
    createTaskStore,
    replayMedia,
    momentMode,
    momentKind,
    isSpontaneous,
    scenarioInventory,
    situationHistory,
  } = mods;
  const registry = skillRegistry();
  const sides = single
    ? [{ key: 'single', transport: args.transport }]
    : Object.entries(TRANSPORT_SIDES).map(([key, transport]) => ({ key, transport }));
  const outDir = path.resolve(
    root,
    args.outDir ??
      `replay-${single ? 'loop-triggers' : 'pair-transport'}-${new Date().toISOString().replace(/[:.]/g, '-')}`
  );
  if (outDir === liveData || outDir.startsWith(`${liveData}${path.sep}`))
    throw new CliError('replay-cli: --out may not be under data/');
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0)
    throw new CliError(`replay-cli: ${outDir} is not empty`);
  let spent = 0;
  const stop = new AbortController();
  if (signal?.aborted) stop.abort();
  else signal?.addEventListener?.('abort', () => stop.abort(), { once: true });
  const capped = {
    async complete(messages, options) {
      if (budget !== null && spent >= budget) {
        stop.abort();
        throw new Error('replay-cli: --spend reached');
      }
      const completion = await llm.complete(messages, { ...options, signal: stop.signal });
      const cost = Number(completion?.usage?.cost);
      spent += Number.isFinite(cost) ? cost : USD_PER_ANSWER;
      if (budget !== null && spent >= budget) stop.abort();
      return completion;
    },
  };
  const frozenState = {
    data: store.state.data,
    markDirty() {
      throw new Error('replay-cli: the state is read-only here');
    },
  };
  const refusing = async () => {
    throw new Error('replay-cli: no request from the image client');
  };
  const order = pairOrder(pairTriggers.length, rng);
  const sheet = [];
  const key = {
    a: 'native transport',
    b: 'text transport',
    mode: 'transport',
    asOfMoment: args.asOfMoment,
    snapshot: args.snapshot !== null ? dataDir : null,
    pairs: {},
  };
  const lines = [];
  const failed = [];
  for (const [index, trigger] of pairTriggers.entries()) {
    if (stop.signal.aborted) break;
    const id = `p${index + 1}`;
    let moment;
    try {
      moment = await momentOf(trigger.channelId, trigger.triggerId);
    } catch (err) {
      failed.push({
        id,
        triggerId: trigger.triggerId,
        error: err instanceof CliError ? err.message : `${err?.name ?? 'Error'}`,
      });
      continue;
    }
    const { channel, history, triggerLine, at } = moment;
    const recorded = turnStartForTrigger(journalOf(), trigger.triggerId);
    const recordedMode = recorded ? momentMode(recorded.mode) : null;
    const mode = recordedMode && !isSpontaneous(recordedMode) ? recordedMode : 'reply';
    const kind = recorded ? momentKind(recorded.trigger?.kind) : null;
    const situation = { history, triggerId: trigger.triggerId, kind, mode };
    const triggerKind = situationHistory(situation).triggerKind;
    const media = replayMedia(history, { cache: mediaCache, sites: hot.config.media?.video?.sites, before: null });
    const requester = requesterOf(triggerLine, channel);
    const answers = {};
    const runs = {};
    // What a live turn runs before her reply, once for every side: the memory prefetch with features.coreTools on,
    // else the search classifier and its searches (preTurnLookup over private copies).
    const baseConfig = structuredClone(hot.config);
    const baseHot = {
      get prompts() {
        return hot.prompts;
      },
      get config() {
        return baseConfig;
      },
    };
    const shared = loopDeps.toolsFor({ hot: baseHot, channel, llm: capped });
    const coreOn = loopDeps.coreToolsOn(baseConfig);
    let sharedInput = {};
    let preTurn = null;
    let prefetched = null;
    try {
      if (coreOn) {
        prefetched = await shared.prefetch({ trigger: triggerLine, triggerKind, mode, history, at });
        sharedInput = { coreTools: { recallAvailable: shared.recallAvailable(), prefetch: prefetched } };
      } else {
        const preStarted = Date.now();
        const searchers = shared.searchers();
        const found = await preTurnLookup({
          config: baseConfig,
          prompts: hot.prompts,
          llm: searchers.client,
          lookup: searchers.lookup,
          recall: searchers.recall,
          discovery: loopDeps.discoveryOf(baseConfig, registry, hot.prompts?.skills),
          guild,
          guildId,
          channel,
          selfId: self.id,
          selfName: self.name,
          history,
          trigger: triggerLine,
          triggerKind,
          descriptions: media.descriptions,
          videos: media.videos,
          at,
          store,
          deps: loopDeps.preTurnDeps,
        });
        const discovery = found.skills
          ? found.skills.inventory === true
            ? 'inventory'
            : Array.isArray(found.skills.names) && found.skills.names.length > 0
              ? found.skills.names
              : 'none'
          : 'none';
        const inventory = scenarioInventory({
          config: baseConfig,
          selfId: self.id,
          texts: hot.prompts?.skills,
          requester,
          conversationId: channel.id,
          registry,
          discovery,
        });
        sharedInput = {
          preTurn: { lookup: found.lookup, recallAvailable: found.recallAvailable },
          ...(inventory ? { skillsInventory: inventory } : {}),
        };
        preTurn = { ...found.trace, skills: found.skills ?? null, usage: searchers.usage, ms: Date.now() - preStarted };
      }
    } catch (err) {
      failed.push({ id, error: err instanceof CliError ? err.message : `${err?.name ?? 'Error'}` });
      continue;
    }
    for (const side of sides) {
      // The config read now, with the tools' transport of this side; never written.
      const config = withTransport(structuredClone(hot.config), side.transport);
      const hotLike = {
        get prompts() {
          return hot.prompts;
        },
        get config() {
          return config;
        },
      };
      const { view } = memoryViewFor({ hotLike, store, guildId, calibrator, situation, at, args, mods: viewMods });
      const images = {
        quota: createImageGen({ apiKey: '', getConfig: () => config, state: frozenState, fetchImpl: refusing }).quota,
      };
      const tasks = sandboxErrandBudget({
        createTaskStore,
        guildId,
        config: () => config,
        log,
        memoryDb: memoryFor(dataDir),
      });
      const simulate = (call, { idByIndex, history: lines2, channelHandles = null }) =>
        simulateCall({
          call,
          view: callViewOf({
            channel,
            snapshot: guildListing(channel),
            guildId,
            idByIndex,
            lines: lines2,
            pulledIds: new Map(),
            memoryOn: config.features?.memory !== false,
            store,
            selfId: self.id,
            skills: registry,
            channelHandles,
          }),
          config,
          selfId: self.id,
          requester,
          conversationId: channel.id,
          now: at,
          images,
          tasks,
          resultText: '',
        });
      const tools = loopDeps.toolsFor({ hot: hotLike, channel, llm: capped });
      const onCall = loopCall({
        simulate,
        runTool: (skill, toolArgs, refs) =>
          tools.run(skill, toolArgs, { history: refs.history ?? [], at, idByIndex: refs.idByIndex ?? null }),
        inTurn: loopDeps.IN_TURN_TOOLS,
        log,
      });
      try {
        const answered = await answerSkillScenario({
          view,
          situation,
          selfId: self.id,
          selfName: self.name,
          channel: channelOf(channel),
          llm: capped,
          runs: 1,
          at,
          signal: stop.signal,
          descriptions: media.descriptions,
          videos: media.videos,
          customEmoji,
          gifs,
          mediaCache,
          searchAvailable,
          channelDirectory,
          onCall,
          loop: { settings: loopDeps.loopSettings(config) },
          ...sharedInput,
        });
        const run = answered.runs[0] ?? null;
        if (!run) throw new Error(answered.stopped ? 'stopped' : 'no answer');
        const record = runRecord(id, 0, run);
        answers[side.key] = pairAnswerOf(record);
        runs[side.key] = {
          transport: side.transport ?? loopDeps.transportOf(config),
          requestTokens: answered.request.tokens,
          tools: answered.request.tools,
          toolsTokens: answered.request.toolsTokens,
          tokens: record.tokens,
          cost: record.cost,
          ms: record.loop.ms,
          calls: answers[side.key].calls,
          counts: turnCounts(record),
          blocks: requestBlocks(answered.request.user, hot.prompts?.labels),
          record,
        };
      } catch (err) {
        answers[side.key] = null;
        failed.push({ id, side: side.key, error: err instanceof CliError ? err.message : `${err?.name ?? 'Error'}` });
      }
    }
    const sharedOut = {
      ...(preTurn ? { preTurn } : {}),
      ...(prefetched ? { prefetch: prefetchSummary(prefetched) } : {}),
    };
    if (single) {
      const one = runs.single;
      if (one) {
        lines.push({
          id,
          scenario: id,
          channelId: trigger.channelId,
          triggerId: triggerLine.id,
          turnId: trigger.turnId,
          at: new Date(at).toISOString(),
          mode,
          kind,
          transport: one.transport,
          requestTokens: one.requestTokens,
          tools: one.tools,
          toolsTokens: one.toolsTokens,
          blocks: one.blocks,
          counts: one.counts,
          context: history.map((line) => ({
            author: line.self ? self.name : (line.authorName ?? line.authorId),
            text: line.content ?? '',
          })),
          ...(Object.keys(sharedOut).length > 0 ? { shared: sharedOut } : {}),
          ...one.record,
        });
      }
      continue;
    }
    const first = order[index];
    const second = first === 'A' ? 'B' : 'A';
    sheet.push({
      id,
      context: history.map((line) => ({
        author: line.self ? self.name : (line.authorName ?? line.authorId),
        text: line.content ?? '',
      })),
      first: answers[first],
      second: answers[second],
    });
    key.pairs[id] = {
      first,
      channelId: trigger.channelId,
      triggerId: triggerLine.id,
      turnId: trigger.turnId,
      answers: { A: answers.A ?? null, B: answers.B ?? null },
      runs: { A: runs.A ?? null, B: runs.B ?? null },
      ...(Object.keys(sharedOut).length > 0 ? { shared: sharedOut } : {}),
    };
  }
  fs.mkdirSync(outDir, { recursive: true });
  const stoppedBy = stop.signal.aborted ? (signal?.aborted ? 'signal' : 'spend') : null;
  if (single) {
    fs.writeFileSync(path.join(outDir, 'runs.jsonl'), lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
    fs.writeFileSync(
      path.join(outDir, 'report.md'),
      renderLoopTriggersReport(lines, { transport: sides[0].transport ?? loopDeps.transportOf(hot.config), failed })
    );
    return {
      code: failed.length > 0 || stoppedBy !== null ? 1 : 0,
      result: {
        out: outDir,
        runs: path.join(outDir, 'runs.jsonl'),
        report: path.join(outDir, 'report.md'),
        triggers: lines.length,
        failed,
        stoppedBy,
        spentUsd: Math.round(spent * 10000) / 10000,
      },
    };
  }
  fs.writeFileSync(path.join(outDir, 'sheet.html'), renderSheet(sheet));
  fs.writeFileSync(path.join(outDir, 'key.json'), `${JSON.stringify(key, null, 1)}\n`);
  return {
    code: failed.length > 0 || stoppedBy !== null ? 1 : 0,
    result: {
      sheet: path.join(outDir, 'sheet.html'),
      key: path.join(outDir, 'key.json'),
      pairs: sheet.length,
      failed,
      stoppedBy,
      spentUsd: Math.round(spent * 10000) / 10000,
    },
  };
}

/**
 * The report of a `--loop-triggers` run: a table of the turns (steps, calls, held steps, think missing, tokens
 * in, out and from the cache, cost, latency), then per trigger its calls in order with their results and each
 * step's posted or held speech. Pure.
 * @param {object[]} lines  runs.jsonl's lines.
 * @param {{ transport: string, failed?: object[] }} meta
 * @returns {string}
 */
export function renderLoopTriggersReport(lines, { transport, failed = [] }) {
  const out = [
    `# Loop triggers (${transport} transport)`,
    '',
    `${lines.length} turn(s)${failed.length > 0 ? `, ${failed.length} failed` : ''}`,
    '',
  ];
  out.push(
    '| id | trigger | steps | calls | held | think missing | coerced | capped | in | out | cache read | cost | ms |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|'
  );
  for (const line of lines) {
    const c = line.counts;
    out.push(
      `| ${line.id} | ${line.triggerId} | ${c.steps} | ${c.calls} | ${c.held} | ${c.thinkMissing} | ${c.coerced} | ${c.capped} | ${line.tokens.prompt} | ${line.tokens.completion} | ${line.tokens.cacheRead ?? 0} | ${costText(line.cost)} | ${line.loop.ms ?? '-'} |`
    );
  }
  out.push('');
  for (const item of failed) out.push(`failed: ${item.id}${item.side ? ` (${item.side})` : ''}: ${cell(item.error)}`);
  if (failed.length > 0) out.push('');
  for (const line of lines)
    out.push(
      `## ${line.id}: ${line.triggerId}`,
      '',
      ...loopLines(line, `### turn (${line.transport}, ${line.mode}${line.kind ? `, ${line.kind}` : ''})`)
    );
  return `${out.join('\n').trimEnd()}\n`;
}

/** The prefetch of a side as its key records it: the status, the lanes, the excerpts' sources and ids, the time. */
function prefetchSummary(found) {
  return {
    status: found.status,
    basis: found.basis ?? [],
    excerpts: (found.excerpts ?? []).map((e) => ({
      source: e.source,
      id: e.id ?? null,
      channelId: e.channelId ?? null,
    })),
    ms: found.ms ?? null,
    ...(found.partial ? { partial: true } : {}),
  };
}

/** One answer as the output and the sheet show it. */
function answerOut(answer) {
  return answer
    ? {
        think: answer.think,
        messages: answer.messages.map((m) => m.text),
        ...mentionsOf(answer),
        skip: answer.skip,
        reactions: answer.reactions,
        gif: answer.gif,
        draw: answer.draw ?? null,
      }
    : null;
}

/**
 * What a run on the step engine needs: the loop's bounds, the in-turn tools, and `toolsFor({ hot, channel, llm })` -- createReplayTools over the guild of
 * this connection: the lookup with the live search engines (Brave's and Exa's keys from the
 * environment, as src/index.js reads them), the recall runner over the data read (its record,
 * archive and vector index iterated only; with features.meaningSearch on, the embedder on the
 * simulator key, off the daily counter), the describer's cached captions only.
 */
async function loopDepsOf({
  load,
  hot,
  store,
  guild,
  guildId,
  self,
  dataDir,
  mediaCache,
  openrouterKey,
  turnMod,
  coreOn,
  log = null,
}) {
  const { createLookup } = await load('web/lookup.js');
  const { createBraveSearch } = await load('web/brave.js');
  const { createExaSearch } = await load('web/exa.js');
  const { createRecall } = await load('behavior/recall-run.js');
  const { createDescriber } = await load('memory/describe.js');
  const { createDiscordInterface } = await load('../interfaces/discord/index.js');
  const {
    runWebSearch,
    runMemorySearch,
    runWebRead = null,
    firstLinkIn = null,
    runMediaLook = null,
    runMediaFind = null,
    lookPerTurn = null,
    IN_TURN_TOOLS,
  } = await load('skills/tools.js');
  // media.look and media.find (absent from an older engine: refused honestly).
  const mediaTools =
    typeof runMediaLook === 'function' ? { createDescriber, runMediaLook, runMediaFind, lookPerTurn } : null;
  // web.read (absent from an older engine: its calls fail as an unknown tool's).
  const { createPageFetcher = null } = await load('web/fetch-page.js').catch(() => ({}));
  const { collectReadableLinks = null } = await load('media/classify.js').catch(() => ({}));
  const pageFetcher = typeof createPageFetcher === 'function' ? createPageFetcher() : null;
  const linkOfMessage = (message) =>
    (typeof collectReadableLinks === 'function' ? collectReadableLinks(message)[0]?.url : null) ??
    (typeof firstLinkIn === 'function' ? firstLinkIn(message?.content) : null);
  // conversation.read (absent from an older engine: its calls fail as an unknown tool's).
  const conversationMod = await load('skills/conversation-read.js').catch(() => null);
  const { pullPictures = null } = await load('behavior/pull.js').catch(() => ({}));
  const conversation =
    conversationMod &&
    typeof conversationMod.runConversationRead === 'function' &&
    typeof turnMod?.searchHandles === 'function' &&
    typeof pullPictures === 'function'
      ? {
          runConversationRead: conversationMod.runConversationRead,
          fetchSpan: conversationMod.fetchSpan,
          recordMessages: conversationMod.recordMessages,
          searchHandles: turnMod.searchHandles,
          pullPictures,
        }
      : null;
  const { transportOf } = await load('skills/tool-calls.js');
  const { skillsIndex, discoveryOn } = await load('skills/discovery.js');
  // The automatic memory prefetch a live turn with the tool loop runs (absent from an older engine: none).
  const { prefetchLanes = null, prefetchOn = null } = await load('behavior/prefetch.js').catch(() => ({}));
  // The search classifier's path before her reply with features.coreTools off (preTurnLookup).
  const { fillPromptTemplate } = await load('behavior/prompt.js');
  const { parseLookupAnswer, recallSettings } = await load('behavior/recall.js');
  const { zonedDay } = await load('time.js');
  const { roleModel } = await load('llm/roles.js');
  const { helperRequestOptions } = await load('llm/openrouter.js');
  const preTurnDeps = {
    lookupClassifierInput: turnMod.lookupClassifierInput,
    fallbackLookupPlan: turnMod.fallbackLookupPlan,
    fillPromptTemplate,
    zonedDay,
    roleModel,
    helperRequestOptions,
    parseLookupAnswer,
    recallSettings,
  };
  const { createAppendStore } = await load('memory/append-store.js');
  const { createRecord } = await load('memory/record.js');
  const { createArchive } = await load('memory/archive.js');
  const { createVectors } = await load('memory/vectors.js');
  const fns = {
    createLookup,
    createBraveSearch,
    createExaSearch,
    createRecall,
    createDescriber,
    createDiscordInterface,
    runWebSearch,
    runMemorySearch,
    transportOf,
    createAppendStore,
    createRecord,
    createArchive,
    createVectors,
    skillsIndex,
    discoveryOn,
    ...preTurnDeps,
  };
  for (const [name, fn] of Object.entries(fns))
    if (typeof fn !== 'function') throw new CliError(`replay-cli: the engine has no ${name} (the tool loop needs it)`);
  if (!Array.isArray(IN_TURN_TOOLS))
    throw new CliError('replay-cli: the engine has no IN_TURN_TOOLS (the tool loop needs it)');
  // Iteration only: the archive's append store never gets an append, so it never opens a file for writing.
  const record = createRecord({ dataDir, memoryDb: memoryFor(dataDir) });
  const archive = createArchive({ appendStore: createAppendStore(), dataDir, memoryDb: memoryFor(dataDir) });
  const vectors = createVectors({ dataDir, memoryDb: memoryFor(dataDir) });
  const sources = {
    record: { iterate: (...a) => record.iterate(...a) },
    archive: { iterate: (...a) => archive.iterate(...a) },
    vectors: { search: (...a) => vectors.search(...a) },
    memoryDb: memoryFor(dataDir),
  };
  let embed = null;
  if (hot.config.features?.meaningSearch === true && openrouterKey) {
    const { createEmbedder } = await load('llm/embed.js');
    const embedder = createEmbedder({ apiKey: openrouterKey, env: {}, state: { data: {}, markDirty() {} } });
    embed = (texts, options = {}) =>
      embedder.embed(texts, { ...options, origin: 'replay', countAgainstDailyCap: false });
  }
  const refusing = {
    complete: async () => {
      throw new Error('replay-cli: no request from the caches');
    },
  };
  let captions = null;
  const describer = createDescriber({
    hot,
    store: { getMediaCache: () => (captions ??= structuredClone(mediaCache ?? {})), markMediaCacheDirty() {} },
    llm: refusing,
  });
  const searches = { brave: createBraveSearch(), exa: createExaSearch() };
  const keys = { brave: process.env.BRAVE_SEARCH_API_KEY || null, exa: process.env.EXA_API_KEY || null };
  const discord = createDiscordInterface().capabilities;
  // The interface's reads over this guild's client, GET only as the rest of the replay is: the history conversation.read
  // asks for.
  const { reads, iface } = discordReads(guild.client, () => hot.config);
  return {
    IN_TURN_TOOLS,
    transportOf,
    // Whether the pre-reply classifiers are replaced by her own tools (features.coreTools); `coreOn` is the run's reading of it (--core-tools forces it).
    coreOn,
    coreToolsOn: turnMod.coreToolsOn,
    loopSettings: turnMod.loopSettings,
    preTurnDeps,
    // The search classifier's `{{skills}}` and the names its `skills:` line may give (src/behavior/turn.js#discoveryPrompt):
    // the registry without her in-turn tools, never offered to a classifier.
    discoveryOf: (config, registry, texts) => {
      if (!discoveryOn(config)) return { index: '', names: [] };
      const offered = new Map([...registry].filter(([name]) => !IN_TURN_TOOLS.includes(name)));
      return { index: skillsIndex(offered, texts), names: [...offered.keys()] };
    },
    toolsFor: ({ hot: sideHot, channel, llm }) =>
      createReplayTools({
        hot: sideHot,
        store,
        guild,
        guildId,
        channel,
        selfId: self.id,
        selfName: self.name,
        llm,
        createLookup,
        createRecall,
        runWebSearch,
        runMemorySearch,
        runWebRead,
        pageFetcher,
        linkOfMessage,
        discord,
        reads,
        iface,
        describer,
        searches,
        keys,
        sources,
        embed,
        mediaCache,
        prefetchLanes,
        prefetchOn,
        recallSettings,
        conversation,
        record: sources.record ?? null,
        mediaTools,
        log,
      }),
  };
}

/**
 * The whole tool. Returns `{ code, result }`; never prints to stdout itself.
 * @param {string[]} argv
 * @param {{ root?: string, signal?: AbortSignal, rng?: () => number }} [options]
 */
export async function main(argv, { root = process.cwd(), signal, rng = Math.random } = {}) {
  const args = parseArgs(argv);
  if (args.answersDir === null) return runMain(args, { root, signal, rng, answers: null });
  // `--answers-dir`: Anthropic models are answered through files (tools/lib/answers-dir.mjs); `done` ends the run.
  const { estimateMessages } = await import(pathToFileURL(path.join(root, 'src', 'llm', 'tokens.js')).href);
  const answers = createAnswersDir({
    dir: path.resolve(root, args.answersDir),
    timeoutMin: args.answersTimeoutMin,
    estimate: (messages) => estimateMessages(messages),
  });
  answers.firstOnly = args.answersFirstOnly;
  let code = 1;
  try {
    const out = await runMain(args, { root, signal, rng, answers });
    code = out.code;
    return { ...out, result: { ...out.result, answersDir: { dir: answers.dir, requests: answers.count() } } };
  } catch (err) {
    code = err instanceof CliError ? err.exitCode : 1;
    throw err;
  } finally {
    answers.finish(code);
  }
}

async function runMain(args, { root, signal, rng, answers }) {
  const src = path.join(root, 'src');
  if (!fs.existsSync(path.join(src, 'behavior', 'sandbox.js')))
    throw new CliError(`replay-cli: no engine under ${src}; run it from the bot's directory`);
  const loadModule = (rel) => import(pathToFileURL(path.join(src, rel)).href);
  // With an answers directory every llm client built from src/llm/openrouter.js answers Anthropic models from files.
  let load = loadModule;
  if (answers) {
    const { roleModel } = await loadModule('llm/roles.js');
    load = async (rel) => {
      const mod = await loadModule(rel);
      return rel === 'llm/openrouter.js'
        ? {
            ...mod,
            createLlm: withAnswersDir(mod.createLlm, answers, (config, purpose) => roleModel(config, 'core', purpose), {
              firstOnly: Boolean(answers.firstOnly),
            }),
          }
        : mod;
    };
  }

  // The triggers of a pair, read before anything else: their number is the estimate.
  let pairTriggers = null;
  if (args.pair || args.pairTransport || args.loopTriggers) {
    if (args.triggers !== null) {
      try {
        pairTriggers = parseTriggers(fs.readFileSync(path.resolve(root, args.triggers), 'utf8'));
      } catch (err) {
        throw new CliError(`replay-cli: ${args.triggers}: ${err?.code === 'ENOENT' ? 'not found' : err.message}`);
      }
      if (pairTriggers.length === 0) throw new CliError(`replay-cli: ${args.triggers} names no trigger`);
    } else pairTriggers = [{ channelId: args.channelId, triggerId: args.triggerId, turnId: null }];
  }
  // The scenarios of --skills, read before anything else too: their runs are the estimate.
  let scenarios = null;
  if (args.skills !== null) {
    let text;
    try {
      text = fs.readFileSync(path.resolve(root, args.skills), 'utf8');
    } catch (err) {
      throw new CliError(`replay-cli: ${args.skills}: ${err?.code === 'ENOENT' ? 'not found' : err.message}`);
    }
    scenarios = parseScenarios(text);
  }
  const { loadDotEnv, deepMerge } = await load('config.js');
  const { createHot } = await load('hot.js');
  const { log } = await load('log.js');

  // Reads config.json, config.local.json and both prompt layers; writes nothing. Not watched: one request.
  const hot = createHot({ rootDir: root, privateDir: privateDirOf(root) });
  // Her turns run on the step engine in every mode that answers as a skill scenario (--skills, --pair-transport,
  // --loop-triggers); its bounds are read now for the estimate. (The operations register first, as for the skills
  // below: src/ops/index.js.)
  const loopWanted = Boolean(scenarios || args.pairTransport || args.loopTriggers);
  if (loopWanted) await load('ops/index.js');
  const turnMod = loopWanted ? await load('behavior/turn.js') : null;
  if (loopWanted && (typeof turnMod.coreToolsOn !== 'function' || typeof turnMod.loopSettings !== 'function')) {
    hot.close();
    throw new CliError('replay-cli: the engine has no step engine (coreToolsOn, loopSettings)');
  }
  const coreOn = loopWanted && (args.coreTools || turnMod.coreToolsOn(hot.config));
  const loopBounds = loopWanted ? turnMod.loopSettings(args.coreTools ? withCoreTools(hot.config) : hot.config) : null;

  // The spend gate: the estimate first; nothing is sent without --spend covering it.
  let spendBudget = null;
  // A diary day's estimate needs its plan, made from the config: its gate is in runDiaryDay.
  if (args.showRequestTurn === null && !args.diaryDay) {
    const perDecision = loopBounds ? loopRequestEstimate(loopBounds) : SKILL_REQUESTS_PER_RUN;
    const requests = args.dry
      ? 0
      : args.inner
        ? INNER_REQUESTS * args.samples
        : args.diary
          ? DIARY_REQUESTS_PER_BRIEF * args.count
          : args.pairTransport
            ? ((coreOn ? 0 : PRE_TURN_REQUESTS) + 2 * perDecision) * pairTriggers.length
            : args.loopTriggers
              ? ((coreOn ? 0 : PRE_TURN_REQUESTS) + perDecision) * pairTriggers.length
              : args.pair
                ? 2 * pairTriggers.length
                : args.recall
                  ? RECALL_REQUESTS
                  : scenarios
                    ? skillRequestEstimate(scenarios, { perDecision }) * (args.pairPrompts ? PAIR_SIDES.length : 1)
                    : args.samples;
    const loopDetail = loopBounds
      ? `~${perDecision} expected per turn (her reply, a follow-up step, a web search's summary; the run stops at --spend on reported cost)`
      : `up to ${SKILL_REQUESTS_PER_RUN}`;
    const skillDetail = `, ${loopDetail} per decision (a run, or each turn of each step of a run)${args.pairPrompts ? ', under both prompt layers' : ''}`;
    const triggerDetail = `, per trigger${coreOn ? '' : ` ~${PRE_TURN_REQUESTS} before her reply (the search classifier, a search's summary) and`} ${loopDetail}${args.pairTransport ? ' on each of the two transports' : ''}`;
    const detail = `~${USD_PER_ANSWER} USD per request${args.diary ? `, ${DIARY_REQUESTS_PER_BRIEF} per brief: the plan and the compose` : ''}${scenarios ? skillDetail : ''}${args.pairTransport || args.loopTriggers ? triggerDetail : ''}`;
    let gate = spendGate({ estimateUsd: requests * USD_PER_ANSWER, requests, spend: args.spend, detail });
    // Anthropic models are answered from files and bill nothing: without --spend the run goes on (other models would bill, unbudgeted).
    if (!gate.ok && answers && args.spend === undefined)
      gate = {
        ...gate,
        ok: true,
        text: `${gate.text.split('\n')[0]}\nanswers-dir: Anthropic models are answered from files, not billed; give --spend <usd> to cap any other model`,
      };
    if (!gate.ok) {
      hot.close();
      throw new CliError(`replay-cli: ${gate.text}`, { exitCode: REFUSED_EXIT });
    }
    spendBudget = gate.budget;
    process.stderr.write(`replay-cli: ${gate.text}\n`);
  }
  if (args.diary) {
    try {
      return await runDiary({ args, root, load, hot, createHot, loadDotEnv, log, signal, rng });
    } finally {
      hot.close();
    }
  }
  if (args.diaryDay) {
    try {
      return await runDiaryDay({ args, root, load, hot, loadDotEnv, log, signal });
    } finally {
      hot.close();
    }
  }
  if (args.inner) {
    try {
      return await runInner({ args, root, load, hot, createHot, loadDotEnv, log, budget: spendBudget });
    } finally {
      hot.close();
    }
  }
  const liveData = defaultDataDir(root);
  const dataDir = args.snapshot !== null ? path.resolve(root, args.snapshot) : liveData;
  if (!fs.existsSync(dataDir)) throw new CliError(`replay-cli: no data directory at ${dataDir}`);

  // --show-request <turnId>: a stored dump needs neither Discord nor a key.
  let turnStart = null;
  if (args.showRequestTurn !== null) {
    const journalGuild = resolveGuildId(liveData, hot.config.bot?.guildId || undefined);
    const journalDirs = [
      ...new Set([
        path.join(liveData, 'guilds', journalGuild, 'journal'),
        path.join(dataDir, 'guilds', journalGuild, 'journal'),
      ]),
    ];
    for (const dir of journalDirs) {
      const dumps = storedDumps(dir, args.showRequestTurn, { steps: args.steps });
      if (dumps.length > 0) {
        hot.close();
        return {
          code: 0,
          result: {
            source: 'dump',
            turnId: args.showRequestTurn,
            dumps: dumps.map(({ file, dump }) => ({ file, ...dump })),
          },
        };
      }
    }
    for (const dir of journalDirs) {
      turnStart =
        journalRecords(dir).find((record) => record?.kind === 'turn.start' && record.turnId === args.showRequestTurn) ??
        null;
      if (turnStart) break;
    }
    if (!turnStart)
      throw new CliError(
        `replay-cli: no request dump and no turn.start record of ${args.showRequestTurn} in the journal`
      );
    if (!SNOWFLAKE.test(turnStart.scope?.channel ?? '') || !SNOWFLAKE.test(turnStart.trigger?.messageId ?? '')) {
      throw new CliError(
        'replay-cli: that turn has no channel or trigger message to rebuild it from (a spontaneous or private turn)'
      );
    }
    args.channelId = turnStart.scope.channel;
    args.triggerId = turnStart.trigger.messageId;
  }

  loadDotEnv(privateDirOf(root));
  const discordToken = process.env.DISCORD_TOKEN;
  if (!discordToken) throw new CliError('replay-cli: DISCORD_TOKEN is not set (.env)');
  const keyNeeded = args.showRequestTurn === null && !args.dry;
  const openrouterKey = keyNeeded ? simKey('replay-cli') : process.env.OPENROUTER_SIM_KEY || undefined;
  const searchAvailable = searchAvailableOf({
    hot,
    createLookup: (await load('web/lookup.js')).createLookup,
    searches: {
      brave: (await load('web/brave.js')).createBraveSearch(),
      exa: (await load('web/exa.js')).createExaSearch(),
    },
  });

  const { createStore } = await load('memory/store.js');
  const { createCalibrator } = await load('llm/tokens.js');
  const { createLlm } = await load('llm/openrouter.js');
  const {
    SANDBOX_STORE_READS,
    liveView,
    answerReply,
    situationHistory,
    sandboxRequestInput,
    momentView,
    momentCutoff,
    hiddenLater,
    momentKind,
    momentMode,
    isSpontaneous,
    replayMedia,
    answerSkillScenario,
    skillScenarioRequest,
    scenarioInventory,
    simulateCall,
    personaGrantsConfig,
    afterScenarioTurn,
    burstTurns,
    seededSelfLine,
  } = await load('behavior/sandbox.js');
  const discordPackage = /** @type {Record<string, unknown>} */ (await load('../interfaces/discord/index.js'));
  const { channelDirectoryOf, fetchHistoryWindow, fetchMessage, createEmojiIndex, resolveGuild } = discordPackage;
  const viewMods = { liveView, momentView, momentCutoff, hiddenLater };
  const splitMods = args.split
    ? {
        ...(await load('behavior/split.js')),
        ...(await load('behavior/prompt.js')),
        ...(await load('llm/roles.js')),
        ...(await load('llm/openrouter.js')),
      }
    : null;
  const recallMods = args.recall ? await loadRecallMods(load) : null;
  // --skills: the operations register themselves and the command tree the skills derive from (src/ops/index.js).
  let skillMods = null;
  if (loopWanted) {
    await load('ops/index.js');
    const { skillRegistry } = await load('skills/registry.js');
    const { expandPersonaGrant } = await load('ops/access.js');
    const { requesterOf: turnRequesterOf, callViewOf } = await load('behavior/turn.js');
    const requesterOf = requesterOfChannel(turnRequesterOf);
    const { createImageGen } = await load('llm/images.js');
    const { grantedSkillNames } = await load('skills/discovery.js');
    // The errands' budget (every scenario: a task.run is checked as live) and the handles of an errand's files.
    const { createTaskStore, parseFileHandle } = await load('errands/store.js');
    skillMods = {
      answerSkillScenario,
      skillScenarioRequest,
      scenarioInventory,
      simulateCall,
      personaGrantsConfig,
      replayMedia,
      fetchHistoryWindow,
      requesterOf,
      callViewOf,
      skillRegistry,
      expandPersonaGrant,
      createImageGen,
      grantedSkillNames,
      createTaskStore,
      parseFileHandle,
      // Only a multi-step scenario carries a turn into the next one, and plays its bursts as the live queue does.
      ...(scenarios?.some((scenario) => scenario.steps) ? { afterScenarioTurn, burstTurns } : {}),
      // Only a scenario that seeds a line of hers needs it.
      ...(scenarios?.some((scenario) =>
        scenario.steps?.some((step) => step.messages.some((message) => message.self === true))
      )
        ? { seededSelfLine }
        : {}),
      // --pair-transport and --loop-triggers read the recorded turn's mode and kind as --pair does.
      ...(args.pairTransport || args.loopTriggers ? { momentMode, momentKind, isSpontaneous, situationHistory } : {}),
    };
    for (const [name, fn] of Object.entries(skillMods)) {
      if (typeof fn !== 'function') throw new CliError(`replay-cli: the engine has no ${name} (--skills needs it)`);
    }
  }
  // --split reads the same context the splitter reads; --recall the live turn's whole history
  // (the trigger included: context.channelMessages lines); the reply mode its own window.
  const before =
    args.before ??
    (args.split
      ? splitMods.splitSettings(hot.config).contextMessages
      : args.recall
        ? Math.min(MAX_BEFORE, Math.max(0, Math.floor(Number(hot.config.context?.channelMessages) || 1) - 1))
        : DEFAULT_BEFORE);
  if (args.split && !hot.prompts?.split)
    throw new CliError('replay-cli: prompts.split is missing (prompts/split.md or prompts.local/split.md)');
  if (args.recall && !hot.prompts?.lookup)
    throw new CliError('replay-cli: prompts.lookup is missing (prompts/lookup.md or prompts.local/lookup.md)');

  let client = null;
  const sides = [];
  try {
    const discord = createRequire(path.join(root, 'package.json'))('discord.js');
    const connection = await connectDiscord({
      discord,
      token: discordToken,
      configuredGuildId: hot.config.bot?.guildId || '',
      resolveGuild,
      log,
    });
    client = connection.client;
    const { guild, guildId, self } = connection;
    const config = hot.config;
    // `<channel_directory>`: the guild's readable text channels, as a live turn lists them.
    const channelDirectory = channelDirectoryOf(guild, hot.config.bot);

    const realStore = createStore({ dataDir, memoryDb: memoryFor(dataDir) });
    const store = readOnlyStore(realStore, SANDBOX_STORE_READS);
    const stateData = store.state.data;
    const calibrator = createCalibrator(stateData.calibration);
    const llmState = { data: { llmDay: stateData.llmDay, llmCount: stateData.llmCount }, markDirty() {} };
    const realLlm = openrouterKey
      ? createLlm({ apiKey: openrouterKey, getConfig: () => hot.config, calibrator, state: llmState })
      : null;
    // Every request is marked as this tool's own. One sample or the splitter: no cache marker
    // (a skill scenario's runs share their request: the sandbox marks it when it has several).
    const noCache = replayWithoutCache(args, Boolean(scenarios));
    const llm = {
      complete: (messages, options) =>
        realLlm.complete(messages, {
          ...options,
          origin: 'replay',
          countAgainstDailyCap: false,
          skipCalibration: true,
          ...(noCache ? { cache: false } : {}),
        }),
    };
    const mediaCache = typeof store.getMediaCache === 'function' ? (store.getMediaCache(guildId) ?? null) : null;
    const gifs =
      hot.config.features?.gifs !== false && typeof store.getGifs === 'function'
        ? (store.getGifs(guildId) ?? null)
        : null;
    const customEmoji = createEmojiIndex(client, guildId).list();
    // Her tools that only read (web.search, memory.search) run for real over this guild, read only (createReplayTools).
    const loopDeps = loopWanted
      ? await loopDepsOf({
          load,
          hot,
          store,
          guild,
          guildId,
          self,
          dataDir,
          mediaCache,
          openrouterKey,
          turnMod,
          coreOn,
          log,
        })
      : null;
    // The live journal's records, read once on first need: the mode and trigger kind each turn recorded at its start.
    let journalCache = null;
    const journalOf = () =>
      (journalCache ??= journalRecords(path.join(liveData, 'guilds', String(guildId), 'journal')));
    const momentOf = (channelId, triggerId) =>
      readMoment({
        client,
        guild,
        guildId,
        self,
        channelId,
        triggerId,
        before,
        config,
        fetchHistoryWindow,
        fetchMessage,
        log,
      });
    const channelOf = (channel) => ({
      id: channel.id,
      name: channel.name ?? null,
      category: channel.parent?.name ?? null,
      topic: channel.topic ?? null,
    });

    if (args.pairTransport || args.loopTriggers) {
      return await runTriggerLoops({
        single: args.loopTriggers,
        args,
        root,
        liveData,
        pairTriggers,
        rng,
        hot,
        store,
        guild,
        guildId,
        client,
        self,
        llm,
        calibrator,
        mediaCache,
        gifs,
        customEmoji,
        searchAvailable,
        channelDirectory,
        signal,
        budget: spendBudget,
        mods: skillMods,
        loopDeps,
        viewMods,
        momentOf,
        journalOf,
        channelOf,
        dataDir,
        log,
      });
    }

    if (args.pair) {
      // Each side: the bot's config and tracked prompts with its own directory as prompts.local/.
      for (const dir of args.pair) sides.push(promptLayersHot(createHot, root, [dir]));
      const journalDir = path.join(liveData, 'guilds', String(guildId), 'journal');
      const turnIds = new Set(pairTriggers.map((t) => t.turnId).filter(Boolean));
      const actions =
        turnIds.size > 0 ? journalRecords(journalDir).filter((r) => r?.kind === 'action' && turnIds.has(r.turnId)) : [];
      const order = pairOrder(pairTriggers.length, rng);
      const outDir = path.resolve(root, args.outDir ?? `replay-pair-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      if (outDir === liveData || outDir.startsWith(`${liveData}${path.sep}`))
        throw new CliError('replay-cli: --out may not be under data/');
      if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0)
        throw new CliError(`replay-cli: ${outDir} is not empty`);
      let usage = { requests: 0, promptTokens: 0, completionTokens: 0 };
      const onUsage = (u) => {
        usage = {
          requests: usage.requests + 1,
          promptTokens: usage.promptTokens + (Number(u?.prompt_tokens) || 0),
          completionTokens: usage.completionTokens + (Number(u?.completion_tokens) || 0),
        };
      };
      const sheet = [];
      const key = {
        a: path.resolve(root, args.pair[0]),
        b: path.resolve(root, args.pair[1]),
        asOfMoment: args.asOfMoment,
        snapshot: args.snapshot !== null ? dataDir : null,
        pairs: {},
      };
      const failed = [];
      for (const [index, trigger] of pairTriggers.entries()) {
        if (signal?.aborted) break;
        const id = `p${index + 1}`;
        let moment;
        try {
          moment = await momentOf(trigger.channelId, trigger.triggerId);
        } catch (err) {
          failed.push({
            id,
            triggerId: trigger.triggerId,
            error: err instanceof CliError ? err.message : `${err?.name ?? 'Error'}`,
          });
          continue;
        }
        const { channel, history, triggerLine, at } = moment;
        const recorded = turnStartForTrigger(journalOf(), trigger.triggerId);
        const recordedMode = recorded ? momentMode(recorded.mode) : null;
        const mode = recordedMode && !isSpontaneous(recordedMode) ? recordedMode : 'reply';
        const kind = recorded ? momentKind(recorded.trigger?.kind) : null;
        const situation = { history, triggerId: trigger.triggerId, kind, mode };
        const media = replayMedia(history, { cache: mediaCache, sites: hot.config.media?.video?.sites, before: null });
        const answers = {};
        for (const [side, { hot: sideHotView }] of [
          ['A', sides[0]],
          ['B', sides[1]],
        ]) {
          const hotLike = {
            get prompts() {
              return sideHotView.prompts;
            },
            get config() {
              return hot.config;
            },
          };
          const { view } = memoryViewFor({ hotLike, store, guildId, calibrator, situation, at, args, mods: viewMods });
          try {
            const result = await answerReply({
              view,
              situation,
              selfId: self.id,
              selfName: self.name,
              channel: channelOf(channel),
              llm,
              samples: 1,
              at,
              signal,
              onUsage,
              descriptions: media.descriptions,
              videos: media.videos,
              customEmoji,
              gifs,
              mediaCache,
              searchAvailable,
              channelDirectory,
            });
            answers[side] = answerOut(result.answers[0] ?? null);
          } catch (err) {
            answers[side] = null;
            failed.push({ id, side, error: err?.name ?? 'Error' });
          }
        }
        const first = order[index];
        const second = first === 'A' ? 'B' : 'A';
        sheet.push({
          id,
          context: history.map((line) => ({
            author: line.self ? self.name : (line.authorName ?? line.authorId),
            text: line.content ?? '',
          })),
          first: answers[first],
          second: answers[second],
        });
        key.pairs[id] = {
          first,
          channelId: trigger.channelId,
          triggerId: triggerLine.id,
          turnId: trigger.turnId,
          journalActions: trigger.turnId
            ? actions
                .filter((r) => r.turnId === trigger.turnId)
                .map((r) => ({
                  opId: r.opId ?? null,
                  name: r.name ?? null,
                  phase: r.phase ?? null,
                  by: r.by ?? null,
                  result: r.result ?? null,
                }))
            : null,
          answers: { A: answers.A, B: answers.B },
        };
      }
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'sheet.html'), renderSheet(sheet));
      fs.writeFileSync(path.join(outDir, 'key.json'), `${JSON.stringify(key, null, 1)}\n`);
      return {
        code: failed.length > 0 || signal?.aborted ? 1 : 0,
        result: {
          sheet: path.join(outDir, 'sheet.html'),
          key: path.join(outDir, 'key.json'),
          pairs: sheet.length,
          failed,
          stopped: Boolean(signal?.aborted),
          usage,
        },
      };
    }

    if (scenarios) {
      // The prompt layers the scenarios are answered under: the live ones, `--prompts` over a copy of
      // prompts.local/, or both sides of `--pair-prompts`; labels.json merged as src/hot.js merges it.
      const skillSides = [];
      const layerDirs = args.pairPrompts ?? (args.prompts !== null ? [args.prompts] : []);
      for (const [index, dir] of layerDirs.entries()) {
        const side = overlayPromptsHot(createHot, root, dir, { mergeJson: deepMerge });
        sides.push(side);
        skillSides.push({ label: args.pairPrompts ? PAIR_SIDES[index] : null, hot: side.hot });
      }
      if (skillSides.length === 0) skillSides.push({ label: null, hot });
      return await runSkills({
        args,
        scenarios,
        root,
        liveData,
        dataDir,
        mods: skillMods,
        hot,
        sides: skillSides,
        store,
        guild,
        guildId,
        client,
        self,
        llm,
        calibrator,
        mediaCache,
        gifs,
        customEmoji,
        searchAvailable,
        before,
        log,
        signal,
        budget: spendBudget,
        viewMods,
        channelOf,
        channelDirectory,
        loopDeps,
      });
    }

    const { channel, history, triggerLine, at } = await momentOf(args.channelId, args.triggerId);

    // The turn this trigger started: the journal's turn.start record (the one --show-request
    // names, else the newest whose trigger is this message), else the sandbox's guess.
    const recorded = turnStart ?? turnStartForTrigger(journalOf(), args.triggerId);
    const recordedMode = recorded ? momentMode(recorded.mode) : null;
    const mode = recordedMode && !isSpontaneous(recordedMode) ? recordedMode : 'reply';
    const kind = recorded ? momentKind(recorded.trigger?.kind) : null;
    const kindFrom = recorded ? 'journal' : 'guess';
    const situation = { history, triggerId: args.triggerId, kind, mode };

    if (args.split) {
      // The trigger kind as the sandbox reads it: the journal's, else 'reply' to the persona, else 'mention'.
      const { triggerKind } = situationHistory(situation);
      // The live splitter gets captions only when the describer runs (features.mediaDescriptions === true).
      const descriptions =
        hot.config.features?.mediaDescriptions === true
          ? replayMedia(history, { cache: mediaCache, sites: hot.config.media?.video?.sites, before: null })
              .descriptions
          : undefined;
      // --text: the same message (author, time, id) with the operator's text in place of its own.
      const trigger = args.text !== null ? { ...triggerLine, content: args.text } : triggerLine;
      return await runSplit({
        hot,
        mods: splitMods,
        llm,
        history,
        trigger,
        triggerKind,
        kindFrom: kind ? 'journal' : 'guess',
        selfName: self.name,
        descriptions,
        samples: args.samples,
        signal,
      });
    }

    if (args.recall) {
      // The trigger kind as the sandbox reads it (reported only: the live turn asks the search classifier on a direct call).
      const { triggerKind } = situationHistory(situation);
      // --text: the same message (author, time, id) with the operator's text in place of its own.
      const trigger = args.text !== null ? { ...triggerLine, content: args.text } : triggerLine;
      // `<recent>` as the reply mode shows it: no line the analyzer added at or after the trigger.
      const asOf = momentView(liveView({ hot, store, guildId, calibrator }), momentCutoff(situation) ?? at);
      return await runRecall({
        hot,
        mods: recallMods,
        llm,
        store,
        guild,
        guildId,
        channel,
        self,
        history,
        trigger,
        triggerKind,
        kindFrom: kind ? 'journal' : 'guess',
        mediaCache,
        recentAsOf: () => asOf.memory.getRecent(),
        replayMedia,
        budget: args.budget,
        showRequest: args.showRequest,
        at,
        signal,
      });
    }

    const { view, hiddenSelf, hidden } = memoryViewFor({
      hotLike: hot,
      store,
      guildId,
      calibrator,
      situation,
      at,
      args,
      mods: viewMods,
    });
    const media = replayMedia(history, { cache: mediaCache, sites: hot.config.media?.video?.sites, before: null });

    if (turnStart) {
      // The request rebuilt, never sent: what the sandbox would send for this turn now.
      const { buildRequest, userText } = await load('behavior/prompt.js');
      const request = buildRequest(
        sandboxRequestInput({
          view,
          situation,
          selfId: self.id,
          selfName: self.name,
          channel: channelOf(channel),
          at,
          descriptions: media.descriptions,
          videos: media.videos,
          customEmoji,
          gifs,
          mediaCache,
          searchAvailable,
          channelDirectory,
        })
      );
      const [systemMessage, userMessage] = request.messages;
      return {
        code: 0,
        result: {
          source: 'rebuilt',
          note:
            'no request dump of this turn is kept: this is the sandbox request rebuilt from its turn.start record, the chat fetched now and the memory of ' +
            `${dataDir}; it is not the request the live turn sent (no tool results, no pictures, no neighbouring channels)`,
          turnId: args.showRequestTurn,
          trigger: { id: triggerLine.id, at: new Date(at).toISOString(), kind: kind ?? null, kindFrom, mode },
          channel: { id: channel.id, name: channel.name ?? null },
          memory: args.asOfMoment ? 'as-of-moment' : 'live',
          ...(hidden ? { hidden } : {}),
          request: { system: textOfContent(systemMessage.content), user: userText(userMessage.content) },
        },
      };
    }

    let usage = { requests: 0, promptTokens: 0, completionTokens: 0 };
    const result = await answerReply({
      view,
      situation,
      selfId: self.id,
      selfName: self.name,
      channel: channelOf(channel),
      llm,
      samples: args.samples,
      at,
      signal,
      onUsage: (u) => {
        usage = {
          requests: usage.requests + 1,
          promptTokens: usage.promptTokens + (Number(u?.prompt_tokens) || 0),
          completionTokens: usage.completionTokens + (Number(u?.completion_tokens) || 0),
        };
      },
      descriptions: media.descriptions,
      videos: media.videos,
      customEmoji,
      gifs,
      mediaCache,
      searchAvailable,
      channelDirectory,
    });

    const out = {
      trigger: {
        id: triggerLine.id,
        author: triggerLine.authorName ?? null,
        at: new Date(at).toISOString(),
        kind: kind ?? null,
        kindFrom,
        mode,
      },
      channel: { id: channel.id, name: channel.name ?? null },
      lines: history.length,
      memory: args.asOfMoment ? 'as-of-moment' : 'live',
      ...(args.snapshot !== null ? { snapshot: dataDir } : {}),
      ...(hidden ? { hidden } : {}),
      hiddenSelf,
      peopleBlock: blockOf(result.request.user, 'people'),
      answers: result.answers.map((answer) => ({
        think: answer.think,
        messages: answer.messages.map((m) => m.text),
        ...mentionsOf(answer),
        skip: answer.skip,
        reactions: answer.reactions,
        gif: answer.gif,
      })),
      stopped: result.stopped,
      usage,
    };
    if (args.showRequest) out.request = { system: result.request.system, user: result.request.user };
    return { code: result.stopped ? 1 : 0, result: out };
  } finally {
    hot.close();
    for (const side of sides) {
      side.hot.close();
      fs.rmSync(side.dir, { recursive: true, force: true });
    }
    if (client && typeof client.destroy === 'function') await Promise.resolve(client.destroy()).catch(() => {});
  }
}

// ---- entry point -------------------------------------------------------------

/** Whether this file is the script node was started with (symlinks and drive-letter case allowed for). */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    return norm(fs.realpathSync(process.argv[1])) === norm(fs.realpathSync(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // Every log line, the engine's included, goes to stderr; stdout keeps only the final JSON object.
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, callback) => process.stderr.write(chunk, encoding, callback);
  const finish = (code, result) => stdoutWrite(`${JSON.stringify(result)}\n`, () => process.exit(code));

  const controller = new AbortController();
  process.on('SIGINT', () => {
    if (!controller.signal.aborted) {
      process.stderr.write('replay-cli: stopping (Ctrl-C again to exit at once)\n');
      controller.abort();
      return;
    }
    process.exit(130);
  });
  process.on('unhandledRejection', (err) =>
    process.stderr.write(`replay-cli: unhandled rejection: ${err?.name ?? 'Error'}: ${err?.message ?? err}\n`)
  );

  main(process.argv.slice(2), { signal: controller.signal }).then(
    ({ code, result }) => finish(code, result),
    (err) => {
      const message =
        err instanceof CliError ? err.message : `replay-cli: ${err?.name ?? 'Error'}: ${err?.message ?? err}`;
      process.stderr.write(`${message}\n`);
      process.exit(err instanceof CliError ? err.exitCode : 1);
    }
  );
}
