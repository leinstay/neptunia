<!-- Generated from structure.json by `node tools/code-health.mjs --docs`. Do not edit by hand. -->

# Repository structure

Every folder and file pattern of the tracked tree has a purpose, a layer, a list of what its files may import and a rule on whether its modules need a test. Anyone who adds a file or an import checks the row that covers it. `npm run health` fails when a tracked file matches no row, when an import falls outside its row, and when a module in a row marked `required` has no test. When two rows cover a file, the more specific one applies. Files in a `local` row exist only in a deployment and are never tracked.

| Path | Layer | Purpose | May import | Test |
|---|---|---|---|---|
| `README.md` | public | The project README for people who find the repository. | nothing | none |
| `*.md` | public | The root documents: agent rules, style guide, writing guide, contributing and security policy. | nothing | none |
| `LICENSE` | public | The license text. | nothing | none |
| `.github/` | public | The continuous integration workflow, the issue and pull request templates and the README images. | nothing | none |
| `.env.example` | public | The names of the environment keys a deployment sets, without values. | nothing | none |
| `.env` | local | The deployment keys, never committed. | nothing | none |
| `.agents/` | local | The working folder of the agents of one deployment. | nothing | none |
| `prompts.local/` | local | A deployment prompt layer that shadows the tracked prompts. | nothing | none |
| `config.local.json` | local | A deployment settings layer over config.json. | nothing | none |
| `config.local/` | local | A deployment's tool texts, laid over the tracked ones. | nothing | none |
| `data/` | local | A deployment memory, state and logs. | nothing | none |
| `config.json` | public | The tracked default settings. | nothing | none |
| `config/` | public | The tracked texts of the persona's tools. | nothing | none |
| `package.json` | public | The root package: scripts, workspaces and development dependencies. | nothing | none |
| `package-lock.json` | public | The locked dependency tree. | nothing | none |
| `tsconfig.json` | public | The TypeScript compiler options used for type checking. | nothing | none |
| `eslint.config.js` | public | The ESLint flat configuration. | `@eslint/js`, `globals`, `eslint-plugin-import-x`, `typescript-eslint`, `tools/eslint-test-rules.mjs` | none |
| `stryker.config.json` | public | The Stryker settings that stay the same on every mutation run. | nothing | none |
| `eslint-suppressions.json` | public | The recorded ESLint violations that may only shrink. | nothing | none |
| `type-baseline.json` | public | The recorded type errors that may only shrink. | nothing | none |
| `code-health-baseline.json` | public | The recorded size and structure breaches that may only shrink. | nothing | none |
| `prose-baseline.json` | public | The recorded prose violations that may only shrink. | nothing | none |
| `structure.json` | public | This manifest of the tracked tree. | nothing | none |
| `.prettierrc` | public | The Prettier options. | nothing | none |
| `.prettierignore` | public | The files Prettier never formats. | nothing | none |
| `.gitignore` | public | The paths git ignores. | nothing | none |
| `.gitattributes` | public | The git attributes of the tree. | nothing | none |
| `.nvmrc` | public | The Node version of the project. | nothing | none |
| `prompts/` | public | The tracked prompt files and labels the model reads. | nothing | none |
| `docs/` | public | How the engine works, one topic per file. | nothing | none |
| `agents/` | public | The profile and prompt of each errand and development agent. | nothing | none |
| `agents/scout/web-search.mjs` | public | The scout's web search command, run by its wrapper `agents/scout/bin/web-search` on the agent's PATH. Its logic is `src/web/web-search.js`, tested there. | `src/web/web-search.js` | none |
| `bin/` | public | Entry points that run as their own process. | `node:*`, `src/**` | none |
| `deploy/` | public | The systemd units and the install script. | nothing | none |
| `interfaces/README.md` | public | The overview of the interface packages. | nothing | none |
| `interfaces/discord/` | public | The Discord interface: the only code that imports discord.js, translating between the platform and the protocol. It reads the core's media classifier and video-site matcher, pure modules, and classifies Discord's embeds and media addresses itself. | `node:*`, `discord.js`, `src/media/classify.js`, `src/media/video-sites.js`, `src/protocol/**` | required |
| `interfaces/discord/setup.ts` | public | The setup of the Discord interface, which refuses until the neptunia CLI runs it. No behaviour to test. | nothing | none |
| `tests/` | public | The node:test files, one per module. | `discord.js`, `eslint`, `node:*`, `src/**`, `interfaces/**`, `tools/**`, `bin/**`, `tests/**` | none |
| `tests/fixtures/` | public | Fakes, harnesses and sample data the tests share. | `discord.js`, `node:*`, `src/**`, `interfaces/**`, `tools/**`, `bin/**`, `tests/**` | none |
| `tools/` | public | Scripts for development and measurement, never run by the engine. | `node:*`, `src/**`, `interfaces/**`, `tools/**`, `typescript`, `discord.js` | none |
| `tools/lib/` | public | What the scripts under tools share. | `node:*`, `src/**`, `interfaces/**`, `tools/**` | none |
| `tools/fixtures/` | public | Sample data for the virtual-week harness. | nothing | none |
| `tools/prompts/` | public | Example scenario files for the tools. | nothing | none |
| `src/*.js` | public | The small modules every part uses: settings, hot reload, logging, paths, time and text formatting. | `node:*`, `src/**` | required |
| `src/config-moves.ts` | public | The config keys of an earlier name and the new name each one is read under, applied to the local config before it is laid over config.json. | nothing | required |
| `src/index.js` | public | The entry point: reads the paths and the environment, reads where the interfaces run, loads the Discord package by path when it runs in this process, starts the core and owns the process signals and exit. It imports no Discord. | `node:*`, `src/*.js`, `src/interface/mode.ts` | none |
| `src/core.js` | public | The composition root: `startCore` builds the core over the paths, the environment and the interfaces it is given. Proved by the slice test. It imports no Discord. | `node:*`, `src/*.js`, `src/agent-runner/**`, `src/behavior/**`, `src/errands/**`, `src/intentions/**`, `src/llm/**`, `src/media/**`, `src/memory/**`, `src/protocol/**`, `src/speech/**`, `src/tools/**`, `src/web/**`, `src/interface/directory.ts`, `src/interface/door.js`, `src/interface/link.ts`, `src/interface/members.ts`, `src/interface/neptunia-cli.ts`, `src/interface/mode.ts`, `src/interface/principals.ts`, `src/interface/reads.ts`, `src/interface/socket.ts` | none |
| `src/agent-runner/` | public | The process that works errands: the socket server, the profiles, the OpenCode driver and the sweep. | `node:*`, `src/**` | required |
| `src/behavior/` | public | What a turn does: the pipeline, triggers, prefetch, prompt assembly, recall, the inner turn and the heartbeat. | `node:*`, `src/**` | required |
| `src/behavior/inner/types.ts` | public | The shapes the inner life modules share. Types only: nothing runs, so nothing is tested. | `node:*`, `src/**` | none |
| `src/behavior/inner/settings.ts` | public | The inner life's settings: the wake kinds, the `innerLife` defaults and `innerSettings`. Tested through the inner life tests. | `node:*`, `src/**` | none |
| `src/behavior/inner/queue.ts` | public | The inner life's wake queue and its state file `inner.json`: the door's handler of `inner.wake`, the wakes an intention gives and how queued wakes coalesce. Tested through the inner life tests. | `node:*`, `src/**` | none |
| `src/behavior/inner/places.ts` | public | Her attention and the places view of the inner life: the place index, the attend wakes and the places page. Tested through the inner life tests. | `node:*`, `src/**` | none |
| `src/behavior/inner/review.ts` | public | The inner life's day review: its drawn moment and the channels she spoke in lately. Tested through the inner life tests. | `node:*`, `src/**` | none |
| `src/behavior/inner/heartbeat.ts` | public | The heartbeat's schedule: its timer, its wake, its facts and the log line of its outcome. Tested through the inner life and heartbeat tests. | `node:*`, `src/**` | none |
| `src/behavior/inner/drain.ts` | public | The inner life's drain: one inner turn for the queue's first group, its wake run, its retries and its feedback facts. Tested through the inner life and fault-injection tests. | `node:*`, `src/**` | none |
| `src/behavior/inner/wake-store.ts` | public | The inner life's wake queue in the memory database: the state's view of `wakes`, the claim and completion of a turn's wakes, and the in-memory database without one. Tested through the inner life, inner wakes and fault-injection tests. | `node:*`, `src/**` | none |
| `src/behavior/inner/recovery.ts` | public | The inner life's start and sleep: a cut-off turn resolved and run again, the wakes that fell due while the core was down or paused slept, and the `core:alive` lease. Tested through the inner wakes and fault-injection tests. | `node:*`, `src/**` | none |
| `src/behavior/inner/facts.ts` | public | The inner life's facts: what did not go through in a turn, kept until a model answer carried them. Tested through the inner life and inner turn tests. | `node:*`, `src/**` | none |
| `src/behavior/inner/status.ts` | public | The owner's status of the inner life and its kill switch. Tested through the inner life and status tests. | `node:*`, `src/**` | none |
| `src/turn/` | public | A turn, one topic per module. The functions that stand on their own are its settings, timers, triggers, inputs, mentions, targets, media, history, routing, journal records and skill calls. The modules that `createTurnRunner` in `src/behavior/turn.js` builds once over a typed context are the facts, the inputs, participation, the journal notes, the diary's first step, the pictures and GIFs, the sends, the typing indicator, the dry act, the act, the pulls, the skill calls, the tool round, the in-turn tools, the second look, the lookup and the outcome. `src/behavior/turn.js` keeps their wiring, runs each attempt through the phases of `src/turn/phases/`, and re-exports what its importers read. | `node:*`, `src/**` | required |
| `src/turn/settings.ts` | public | The pace and tool loop settings a turn reads from the live config. Tested through the turn, config and inner turn tests. | `node:*`, `src/**` | none |
| `src/turn/timers.ts` | public | The stages, the bar signal, the typing refresh and the stage record of a turn's preparation. Tested through the turn tests. | `node:*`, `src/**` | none |
| `src/turn/triggers.ts` | public | The trigger kinds and what they say about a turn: plain posts, who waits, who asked, the attention. Tested through the turn and attention tests. | `node:*`, `src/**` | none |
| `src/turn/lookup-input.ts` | public | The transcript and trigger input of the re-watch and search classifiers. Tested through the turn and search policy eval tests. | `node:*`, `src/**` | none |
| `src/turn/mentions.ts` | public | The `@name` matching, the member directory, the stored names and profiles a request shows, and the untagged note. Tested through the turn and mention feedback tests. | `node:*`, `src/**` | none |
| `src/turn/targets.ts` | public | Where a post or a reaction lands, the link a post carries, a post's check arguments and the dry-run mirror's parts. Tested through the turn tests. | `node:*`, `src/**` | none |
| `src/turn/media.ts` | public | The re-watch classifier's tokens and the media of a history a turn's preparation works on. Tested through the turn tests. | `node:*`, `src/**` | none |
| `src/turn/history.ts` | public | The history a turn reads with its reply parents and continues after a skill call. Tested through the turn, prompt anchors and replay loop tests. | `node:*`, `src/**` | none |
| `src/turn/routing.ts` | public | The destination of words about a channel she cannot write in, the route of a routed call and the channel directory. Tested through the turn tests. | `node:*`, `src/**` | none |
| `src/turn/journal.ts` | public | The journal records of a turn: skip codes, operations, diagnostics, send hashes, usage and the turn record. Tested through the journal turn, skill result and failed-earlier tests. | `node:*`, `src/**` | none |
| `src/turn/calls.ts` | public | Her skill calls as a turn makes them: the requester, the call view, the search handles, the envelope, the answer split and the reply request's options. Tested through the replay skill, replay loop and turn tests. | `node:*`, `src/**` | none |
| `src/turn/task-input.ts` | public | The `tasks` input of a turn's request. Tested through the turn tests. | `node:*`, `src/**` | none |
| `src/turn/participation.ts` | public | Her participation in a server turn: whether the store applies, the channels its episodes come from, the live `<people_now>` input, the record of her lines and the `<recent>` input. Tested through the turn and participation tests. | `node:*`, `src/**` | none |
| `src/turn/journal-notes.ts` | public | What a turn notes as it runs: the facts for her next request, the text an attempt saw, the trigger and call marks, her previous think, and the journal's and the record's lines. Tested through the turn, journal turn and failed-earlier tests. | `node:*`, `src/**` | none |
| `src/turn/diary.ts` | public | A diary post's first step and its picture gate: the plan request with its seeds and topic, the plan's search and a set post's seeds. Tested through the diary turn and diary requests tests. | `node:*`, `src/**` | none |
| `src/turn/draw-gif.ts` | public | The pictures and GIFs of a turn: her `draw.create` tool, the image prompt the dry run shows, the day's GIF count, a `<gif>` resolved and posted, and the GIF picker. Tested through the turn, media draw, draw parity and gifs tests. | `node:*`, `src/**` | none |
| `src/turn/sends.ts` | public | How her words are rendered and timed before they go out: a post's mentions, emoji and links, the settle wait for the trigger's author, her diary's place name and the dry-run mirror. Tested through the turn, message links and channel links tests. | `node:*`, `src/**` | none |
| `src/turn/typing.ts` | public | The typing indicator of a turn while its tool loop runs and while it prepares. Tested through the turn tests. | `node:*`, `src/**` | none |
| `src/turn/dry-act.ts` | public | The dry run's stand-in for the act: every would-be reaction, message, GIF and diary picture logged, journaled and mirrored. Tested through the turn and journal turn tests. | `node:*`, `src/**` | none |
| `src/turn/act.ts` | public | The act of a turn: her reactions, messages and GIF posted, checked, typed out, journaled and recorded, and a diary post's speech held. Tested through the turn, journal turn, gifs and diary turn tests. | `node:*`, `src/**` | none |
| `src/turn/pulls.ts` | public | The other channels a turn shows in `<channel_view>`: which it pulls, their captions and last views, and the seen marks, lines in view and ring stamps a turn leaves. Tested through the turn, pull and pull seen tests. | `node:*`, `src/**` | none |
| `src/turn/facts.ts` | public | The facts kept for her next request in a conversation: the inner life's store while it is on, else the runner's own. Tested through the turn, inner turn and turn failed earlier tests. | `node:*`, `src/**` | none |
| `src/turn/inputs.ts` | public | The port references, the gateway's check of one effect, the memory context of an attempt, skills discovery for a classifier and the errands, intentions and places inputs of a request. Tested through the turn, turn errands and inner turn tests. | `node:*`, `src/**` | none |
| `src/turn/skill-calls.ts` | public | Her skill calls in a turn: what a call resolves against, the gateway's check, the plan of a call, an inner turn's gate, the call made with its journal lines and marks, and a step's calls in segments. Tested through the turn, inner turn, heartbeat intents and turn errands tests. | `node:*`, `src/**` | none |
| `src/turn/tool-round.ts` | public | The steps of a turn: her calls planned and made, her speech posted or held, one more request while something is left to read, and the history read, the think kept and the transcript of a step's note. Tested through the turn, inner turn, heartbeat intents and diary turn tests. | `node:*`, `src/**` | none |
| `src/turn/in-turn-tools.ts` | public | Her in-turn tools over a turn's own context: the web search and read, the second look, the media find, the memory search, the conversation read, the picture and a diary post's voice. Tested through the turn, turn conversation read and media draw tests. | `node:*`, `src/**` | none |
| `src/turn/rewatch.ts` | public | The second look on a question: the media list a re-watch classifier or the planner is offered, the classifier's request, the describer's look again, and the transcript input of a turn's classifiers. Tested through the turn tests. | `node:*`, `src/**` | none |
| `src/turn/lookup.ts` | public | What a turn looks up before its reply: the memory prefetch, the search classifier with its web and server searches, the turn planner, the splitter, and the directory and private partner. Tested through the turn and events tests. | `node:*`, `src/**` | none |
| `src/turn/outcome.ts` | public | How a turn ends: runTurn around its attempts, the chain of parts of a split message, the facts an addressed turn keeps, the end hook, the idle notifications and the selfreflection wake's inputs. Tested through the turn, turn attention, turn failed earlier and diary turn tests. | `node:*`, `src/**` | none |
| `src/turn/draft.ts` | public | The draft of one attempt of a turn: every field its phases and the topic modules note for the journal's turn record, the end of the turn and the tool loop. Tested through the turn and journal turn tests. | `node:*`, `src/**` | none |
| `src/turn/phases/context.ts` | public | What the phases of an attempt share: the runner's dependencies and topic functions, the attempt's arguments and lifecycle, its early result and the cancellation point at its bar. Tested through the turn tests. | `node:*`, `src/**` | none |
| `src/turn/phases/preflight.ts` | public | The first phase of an attempt: the pause and the attention, the conversation's info, the journal's start and the settle wait. Tested through the turn and turn attention tests. | `node:*`, `src/**` | none |
| `src/turn/phases/request.ts` | public | The second phase of an attempt: the steps of `src/turn/phases/request/` in order, up to the reply request. Tested through the turn tests. | `node:*`, `src/**` | none |
| `src/turn/phases/request/setup.ts` | public | The request's settings for the attempt, its bar and cancellation point, the typing while it prepares, the listing, the history, the memory prefetch and a diary post's plan. Tested through the turn tests. | `node:*`, `src/**` | none |
| `src/turn/phases/request/planner.ts` | public | Which searches a turn may run, and the turn planner with what it is sent and its route step. Tested through the turn tests. | `node:*`, `src/**` | none |
| `src/turn/phases/request/pulls.ts` | public | The channels a turn shows in `<channel_view>`, the chooser of a spontaneous turn and the source of a routed call. Tested through the turn tests. | `node:*`, `src/**` | none |
| `src/turn/phases/request/stages.ts` | public | The preparation's deadline and its first stages: the file previews, the captions, the splitter and the video watches. Tested through the turn tests. | `node:*`, `src/**` | none |
| `src/turn/phases/request/second-look.ts` | public | The second look at a video, a GIF or a picture the trigger asks about, the deadline's media extension and the video states a classifier shows. Tested through the turn tests. | `node:*`, `src/**` | none |
| `src/turn/phases/request/lookup.ts` | public | The link reads, the search classifier with its searches, and the planner's start when its route step did not start it. Tested through the turn tests. | `node:*`, `src/**` | none |
| `src/turn/phases/request/wait.ts` | public | The neighbours, the pulled channels and the participation pick, the one wait for the preparation, and what of it was late. Tested through the turn tests. | `node:*`, `src/**` | none |
| `src/turn/phases/request/gather.ts` | public | What the preparation brought, taken as the request shows it: deleted lines, late video states, reads, searches, neighbours, pulls, a diary plan, the drawing quota and `<recent>`. Tested through the turn tests. | `node:*`, `src/**` | none |
| `src/turn/phases/request/facts.ts` | public | What was kept for her in the conversation, the task input, the follow-up prompt's check, her time away and skills discovery. Tested through the turn and turn failed earlier tests. | `node:*`, `src/**` | none |
| `src/turn/phases/request/build.ts` | public | Her tools for the turn, the request input, the request built, the memory reads record and the lines the journal names as seen. Tested through the turn tests. | `node:*`, `src/**` | none |
| `src/turn/phases/response.ts` | public | The third phase of an attempt: the reply request under the bar, her answer read and shaped, the answer logged, the seen marks, and the cut-off and silence that end the turn. Tested through the turn tests. | `node:*`, `src/**` | none |
| `src/turn/phases/act.ts` | public | The fourth phase of an attempt: how her answer reaches the chat, the recovery turn's last check and the dry run. Tested through the turn and journal turn tests. | `node:*`, `src/**` | none |
| `src/turn/phases/tool-round.ts` | public | The fifth phase of an attempt: her calls under the turn's effect keys, her speech, the later steps, and the cut-off and short diary set that end the turn. Tested through the turn, turn tool steps and diary turn tests. | `node:*`, `src/**` | none |
| `src/turn/phases/outcome.ts` | public | The last phase of an attempt: what its steps posted, a diary entry recorded, the result, how an attempt that threw ends and what every attempt closes. Tested through the turn and diary turn tests. | `node:*`, `src/**` | none |
| `src/errands/` | public | The errand service: the ledger, the store, the client to the runner and the turns that bring results back. | `node:*`, `src/**` | required |
| `src/intentions/` | public | The persona intentions: model, store, sources and the service that wakes them. | `node:*`, `src/**` | required |
| `src/errands/types.ts` | public | The shapes the errand modules share. Types only: nothing runs, so nothing is tested. | `node:*`, `src/**` | none |
| `src/intentions/types.ts` | public | The shapes the intention modules share. Types only: nothing runs, so nothing is tested. | `node:*`, `src/**` | none |
| `src/interface/` | public | The core side of the interface port: the door that admits events, the link to an interface, the socket server, the fake interface and typing leases. | `node:*`, `src/**` | required |
| `src/llm/` | public | The language model calls: OpenRouter, roles, budgets, token counts, limits and output parsing. | `node:*`, `src/**` | required |
| `src/media/` | public | Pictures, video, audio, GIFs and drawing on the core side. | `node:*`, `src/**` | required |
| `src/memory/` | public | The memory modules above the database: records, lore, episodes, recall ranking, vectors and backfills. | `node:*`, `src/**` | required |
| `src/memory/db/` | public | The memory database: schema, the single writer, sessions, wakes and the read paths. | `node:*`, `src/**` | required |
| `src/memory/db/diary-past.ts` | public | Schema v15's data step that makes her past messages in a diary mirror's place entries. Tested through the v15 migration tests. | `node:*`, `src/**` | none |
| `src/memory/db/mirrors.ts` | public | The reads of the diary's mirrors over the memory database: the places her diary is posted to and whether a conversation is one. Tested through the mirror and diary mirror tests. | `node:*`, `src/**` | none |
| `src/memory/db/session-repair.ts` | public | Schema v17's data step that sets back the claims, descriptions and attitude reasons the unit sync wrote over her memory session's changes. Tested through the v17 migration tests. | `node:*`, `src/**` | none |
| `src/memory/db/session-rows.ts` | public | Her memory session's rows beside the store's files: what a member's profile reads of them and what a unit write leaves as she wrote it. Tested through the two-writers tests. | `node:*`, `src/**` | none |
| `src/memory/db/map/` | public | The mapping of memory rows to records and back. | `node:*`, `src/**` | required |
| `src/memory/db/readers/` | public | The read queries of the memory database. | `node:*`, `src/**` | required |
| `src/tools/impl/` | public | The owner operations behind the /nep commands. | `node:*`, `src/**` | required |
| `src/protocol/` | public | The neutral protocol of events, actions and envelopes between the core and its interfaces, and the serving side of the link. | `node:*`, `src/**` | required |
| `src/interface/legacy.ts` | public | The types of what the core reads from an interface's `legacy`, one field per seam stage 3 removes. Types only. | nothing | none |
| `src/protocol/host.ts` | public | The types of what the core hands an interface when it starts one and what the interface hands back. Types only. | `src/protocol/**` | none |
| `src/tools/` | public | The tools the persona can call: definitions, registry, executors and the gateway. | `node:*`, `src/**` | required |
| `src/speech/` | public | Voice messages: text preparation, synthesis and audio conversion. | `node:*`, `src/**` | required |
| `src/web/` | public | Web search, page fetching and link reading. | `node:*`, `src/**` | required |
