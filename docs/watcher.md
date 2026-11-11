# Watcher

The watcher is an agent that reads project and persona evidence and writes a report for the owner, who decides what to do about it. It files no task, implements no fix and deploys nothing. This guide is for an owner who runs it or changes how it runs.

Its shared definition lives in `agents/watcher/`. Customize the prompt and supported profile fields under `data/agents/watcher/`, just like the [other agents](development-agents.md). Reports live under `data/agents/watcher/reports/`.

## Run and read

The watcher runs only when the owner asks. `/doctor watcher run` goes to the core, which claims one run and starts `neptunia worker watcher` (`bin/neptunia-watcher.ts`) in its own process group with no terminal (`workerStarter` in `src/watcher/doctor.ts`), and answers at once with the report's number and start time. Closing the chat or the terminal stops nothing. A run already going is answered instead, and nothing more starts. With no core up the command is refused and nothing is claimed. The worker invokes the agent and can spend model allowance. `neptunia setup` asks for the watcher's backend and model, and nothing else of it.

The other four forms read the files, with the core up or down, and ask no model. `/doctor watcher stop` asks the running run to stop. `/doctor watcher list` shows every report, the newest first, each with its number, its start and finish to the minute in UTC, and its state, with the code of a failure. `/doctor watcher read` opens the newest committed report and `/doctor watcher <n>` opens report `n`, each under its number and dates. A number is the place of a run in the order of the starts, the oldest first, so a later run never changes it. A report written before run records has no start time, goes by its day and keeps its place among the others.

## Accepted findings

The owner keeps a list of findings he knows and chose to leave in `data/agents/watcher/accepted.md`, one `- <text>` line per finding. `src/watcher/accepted.ts` is the only writer, through `acceptLine` and `unacceptLine`, each by a temp file and a rename. The watcher never writes the file, and a missing file is an empty list. A text with a line break is kept as one line, and an empty text or one already on the list is refused.

Three leaves of `/doctor` work on it from the files, with the core up or down: `/doctor watcher accepted` prints the lines with a number from 1, `/doctor watcher accept <text>` adds a line at the end and answers with its number, and `/doctor watcher unaccept <number>` removes a line and answers with its text. Removing a line renumbers the lines after it. Their answers are the labels `labels.watcher.accepted`.

A run reads the list once at its start (`accepted` of `InspectionDeps`) and `buildBrief` carries it as `<accepted>`, each line numbered. The prompt has the agent leave out every finding a line covers and count them in the `accepted` field of the `coverage` block by the line's number. `checkCoverage` is given the length of the list read at the start, so a first and a second attempt check against the same list. A finding that grew past its line stays in the report with the line it outgrew named.

## One run

`src/watcher/lifecycle.ts` keeps every inspection as one record under `data/agents/watcher/runs/`, with an identity and one of the states `running`, `stopping`, `succeeded`, `failed` and `cancelled`. Every start takes the same claim under one lock, so a start during a run answers that run and spawns nothing. The core claims with no owner, and the worker adopts the claim and keeps its identity. A worker that cannot be started fails the run at once with the code `start-failed`. A claim records the pid and the start identity of its process. A claim whose process is gone, or whose pid now belongs to another process, reads as finished, and so does a claim no worker took within `WATCHER_RUN_TIMEOUT_MS`. Recovery signals nothing, and it ends as `succeeded` when the run had already committed its report and otherwise as `failed` with the code `holder-gone`. The worker is a child of the core, so a restart of the core's unit ends it. The core's next start ends that run as `failed` with the code `core-restarted`, or as `succeeded` when its report was already committed (`failRunOfLastCore` in `src/watcher/lifecycle.ts`), and `/doctor watcher list` shows it.

`/doctor watcher stop` writes `stopping` into the record, and `src/watcher/inspection.ts` reads it once a second. The abort signal reaches the backend, which kills the agent's process group. The run checks again between its phases, so a stop ends the validation and the commit. Once the report is committed the run ends as `succeeded`, whatever a late stop said. Output of an interrupted agent is kept nowhere. A stop before the worker adopted the claim leaves it in `stopping`, and the worker that comes ends it as `cancelled` without asking the agent.

`WATCHER_RUN_TIMEOUT_MS` is 60 minutes and bounds the agent. A run past it fails with the code `timeout`. The worker exits `0` for a committed report and for a cancelled run, and `1` for a failed run.

## Reports and versions

Every report is one Markdown file in one template. `checkTemplate` in `src/watcher/report.ts` checks the title, the metadata rows, the twelve sections, the four subheadings of each, `Decisions needed` ahead of them in `For the owner`, and the `coverage` block at the end, and `checkCoverage` reads the block as data. [The prompt contract](prompt-contract.md#watcher-answer) holds the template and the codes.

The runner checks the answer before it saves anything, and a refusal's detail never quotes the agent. An answer refused by the template, the coverage block or the key check earns one more attempt on the same run. `src/watcher/inspection.ts` counts it in `attempts` on the run's record before it starts. Its brief holds the first brief whole, `agents/watcher/retry.md`, the code and detail, and the refused answer. The second attempt gets what is left of `WATCHER_RUN_TIMEOUT_MS`, a run with no time left fails with `timeout`, and a retry prompt that cannot be read ends the run with the refusal. A second refusal fails the run with its own code, and the last successful view stays. An exit code, a timeout or the engine's own check after stamping earns no attempt. Each refused answer stays in `reports/refused/<run id>-<attempt>.md`, mode 600 and invisible to the report readers, with a string shaped like a key masked there and in the second brief. The engine then replaces the metadata rows it knows: the observation interval, the run id, the selected backend, the model, the effort, the risk and both counts. It stamps `observation` and `backend` of the `coverage` block with the same facts, so the block and the rows cannot disagree. The rows `Effective account` and `Available sources` and the block's other fields stay the agent's.

Each successful run commits an immutable file `reports/runs/<day>_<commit ms>_<run id>.md`, and `reports/<day>.md` is a link swapped atomically to the newest of its day, so a failed or interrupted attempt replaces nothing. A plain `<day>.md` from an older installation reads as before, with no run identity, and stays readable as the run `legacy-<day>` once a run commits over it. The day of a report is the UTC day of its claim.

The persona's `watcher.read` tool takes `day` or `run` and uses stored reports rather than launching another inspection. The brief in `src/watcher/brief.ts` carries the observation interval, the facts of the install, the [money](#money-and-limits) and the last seven reports: the newest of each earlier day as `<report day="...">`, then every kept report of the run's own day as `<report day="..." run="...">`.

## Finding risk

Each finding line carries a level the agent chose. `applyRiskRules` in `src/watcher/risk.ts` decides from the earlier successful reports whether the finding repeats. `evidenceFingerprint` reduces its text to the paths with their lines, the `snake_case` and `kebab-case` codes and the errno names it holds, and drops timestamps, dates, clock times, uuids, hex ids, long numbers and bare counts. Equal evidence is the same finding under any key, and with no evidence to compare the key decides. A repeat is saved as `- [low] <key>: <text> (repeat <n>, first <day>)`, and its model level is ignored. Evidence that changed under a key brings the agent's level back, and the count starts from the change. `Risk` in the metadata is the highest level among new findings, `none` with no new one. `Open findings` counts every finding standing in this report per level, a repeat at the level of its first sighting (`openCounts`), and a finding the report omits is closed. A line of `Decisions needed` is no finding: it is not counted and never repeats.

## Service runs

`neptunia services watcher evidence` is the agent's read of what the services asked and answered. It reads `model_requests` over a read-only connection (`readRecordedRuns` in `src/watcher/requests.ts`) and the session files of `<data>/subharness/claude/home/projects/` (`readTranscriptRuns` in `src/watcher/transcripts.ts`), writes nothing and spawns nothing. Each record holds the effective system text, the messages, the tool definitions and calls, the answer, the usage, the `outcome` and its `gaps`. The `outcome` of a turn's last request is a `skip`, a `delivery` confirmed by its receipt or failed, or the `entry` a selfreflection turn recorded, named by its id. A request with no outcome reads as `unlinked`, and [memory.md](memory.md) describes how each is written. Strings shaped like a key are masked, with the gap `credential-masked`.

The window opens at the last successful inspection, or at the start of the UTC day, and closes now (`observationInterval`). A run belongs to the window its last step finished in, so a run crossing midnight or an inspection is read once, and a run still in flight is counted apart in `inFlightRuns`. Sessions go by the window their last request falls in. One page holds at most `WATCHER_EVIDENCE_MAX_CHARS` (50,000) characters of runs, a larger run comes alone and whole, and `nextCursor` walks the records and then the sessions with the end of the window pinned. The inspection in progress and its session are left out. The first page also carries what is read once per walk: `trash`, `routes`, `mirrors`, `selfreflection`, `standards`, `audit` and `analyzer`. `mirrors` gives each selfreflection mirror its `place`, `enabled`, `lastSentAt`, `queued`, `failed`, `uncertain` and `backfill`, and `selfreflection` the last entry's id and time with the same three counts, `uncertain` being the states `unknown` and `incomplete`. These hold ids, times and counts, no word of the selfreflection, and each is null when the database cannot be read. `standards` holds the counts of [the output standards](prompt-contract.md#standards-of-output-and-stored-text) in the window, from `standardFacts`: `thinkMissing`, `thinkLeaked`, `leakEnded`, `tagInOutgoing`, `thinkOffScript`, `descriptionsRedescribed` and `descriptionsMarked`. `audit` holds [the memory audit](memory.md#the-memory-audit) of the whole database, `{ findings, checks }`, counts only, and `analyzer` holds [the analyzer's work](#the-analyzers-work). A memory database that cannot be read gives the gap `memory-unavailable`, and the transcripts still come.

`src/subharness/run.ts` gives a claude whose `--help` lists `--session-id` a fresh id on each run, and `src/subharness/sessions.ts` appends the id, the agent, the backend and the run to `<data>/subharness/sessions.jsonl`. That map names each session's service, and a session it does not hold carries the gap `unattributed-session`. Writing the map can fail without stopping a run: the result carries `session-map-write-failed`, and a watcher run saves it under `Unavailable checks` of `Service runs`. Development tasks and errands are board tasks, so their sessions take the `outcome` from `board_tasks`.

`neptunia services watcher select --sql <statement>` is the agent's read of the live database, `watcherSelect` in `src/service/watcher.ts`. It takes one statement that opens with `SELECT` or `WITH`, over a read-only connection to `memory.db`, with no copy and no work folder. It answers `{ rows, truncated }`, at most 500 rows and `WATCHER_EVIDENCE_MAX_CHARS` characters, a cell cut at 4,000 characters, a binary cell as its length and a string shaped like a key masked. A write fails, a missing database fails and makes no file, and the agent keeps what a row shows of a direct message out of the report by the rule of its prompt.

## The running install

`Project` and `Modules and structure` work from the install the worker runs in. `installFacts` in `src/watcher/install.ts` gives the brief its revision, its `ahead` and `behind` counts against the `origin/main` it last fetched, its modules, the dependencies of its packages and its active skills, and fetches nothing. What it cannot learn is named in `unavailable`: `no-git`, `git-unreadable`, `no-remote`, `no-package-json` or `skills-unreadable`. The agent reports those, and GitHub access it lacks, under `Unavailable checks`. The watcher reads no other checkout, runs no `gh` and reads no CI.

## The analyzer's work

`analyzerFacts` in `src/watcher/analyzer-facts.ts` reads what the analyzer did in the observation window from the memory database, with no model call. Each entry of `functions` is one `purpose` of the `model_requests` rows with role `analyzer`: `address`, `split`, `merge`, `missed`, `media-pick`, `query-builder` and `selfreflection-planner`. It holds `enabled`, `requests` with the `total`, the counts `byStatus` and the `errorCodes`, and `decisions`. A function is enabled when its prompt file is not empty, read from both prompt layers as the core loads them.

Each recorded answer is read by the function's own parser, so `decisions` counts what the engine acted on.

| Function | Decisions | Read by |
|---|---|---|
| `address` | `yes`, `overheard`, `no` | `parseAddressAnswer` |
| `split` | `one`, `several` | `parseSplitAnswer`, an answer it refuses counting as `one` |
| `merge` | `joined`, `new` | `parseMergeAnswer`, against the items of the request's `<waiting>` |
| `missed` | each verdict, and `unchecked` | `parseMissedAnswer`, against the request's `<candidates>` |
| `media-pick` | `none`, `gif`, `emoji`, `replace` | `parseMediaPick`, against the handles and names the request offered |
| `query-builder` | `web`, `history`, `none` | `parseQueryPlan` |
| `selfreflection-planner` | the plan's `kind`, `no-kind` or `unparsed` | `parseJsonObject` |

`effects` counts what reached the chat in the window. `gifReplies` and `emojiReactions` are her `gif` and `react` actions that succeeded, from the journal's `day` rows. `emojiInText` is the `emoji` and `replace` answers of the media pick whose turn delivered its reply, `splitReplies` the turns that ended `split`, and `mergedMessages` the merge answers that joined a waiting item.

`zeros` lists each enabled function that had inputs in the window and did nothing with them, with its `reason` and its `inputs`. The inputs of `address` are the lines of others in group places, `groupLines`, and those of `media-pick` her own lines, `herReplies`. The reason is `no-requests` for a function nobody asked and `no-decision` when no answer chose to act, which is `yes` or `overheard` for `address` and a GIF or an emoji for `media-pick`. It is `no-effect` when the media pick chose and nothing of it reached the chat. A disabled function and one without inputs are never listed. The prompt has the agent treat every zero as a likely fault and find out why.

## Money and limits

`moneyFacts` in `src/watcher/money.ts` gives the brief its `<money>` block. The worker gathers it before the agent starts, over a read-only connection to `memory.db`, and a read that fails leaves the block out. Every key is named by its slot, and no key value reaches the block, a log line or the report.

`moneyKeysOf` takes the keys from `keys.json`. Every named key goes by its name, and each paid service of `services` goes by its name. `chainKeyNames` in `src/llm/route-chain.ts` names the key each role spends on, the first key of its chain in `models.routes`, and a role with none spends on `none`.

`spend` covers the 24 hours before the run, from `model_requests.usage`. `byKey` holds it by key slot, `byRole` by role and `byModel` by model, each row with `requests`, `tokens`, `credits` and `byok`. A BYOK answer adds its `cost_details.upstream_inference_cost` to `byok`, and any other answer adds its `usage.cost` to `credits`. Runs on the `claude` and `codex` backends cost no dollars per request, and `subscription` counts them by requests and tokens alone.

Each OpenRouter key is read with `GET https://openrouter.ai/api/v1/key`, and the key goes to that endpoint alone. An entry of `keys` keeps OpenRouter's own fields `limit`, `limit_remaining`, `limit_reset`, `usage`, `usage_daily`, `usage_weekly`, `usage_monthly` and `is_free_tier`, and adds `resetAt`, `spent24h` and `runway`. OpenRouter resets a `daily` limit at midnight UTC, a `weekly` one on Monday and a `monthly` one on the first of the month. Each key of the core pool is measured against the credits of the whole pool, since a request does not record which key of the pool carried it. When a read fails, `unavailable` gets a row with the slot, the service and a code: `http_<status>`, `timeout`, `unreachable` or `bad-answer`. Any paid service whose balance the engine cannot read is listed there with `no-balance-read`.

The rail `requestsPerDay` of `rails` holds the cap `llm.maxRequestsPerDay`, today's count, what is left and its runway to midnight UTC, when the engine's counter starts again. Its rate is the API requests of the 24 hours. `maxRequestTokens` is `llm.maxRequestTokens`. `subscriptionRefusals` counts by backend the subscription runs refused with `subscription-exhausted` and names the last. The request log holds no reset time for a subscription window.

`runwayOf` sets a remaining amount against the 24-hour spend. The runway is `{ state: 'enough', margin }` when the amount lasts past its reset, `margin` being how many times over it covers the spend until then, and `{ state: 'short', runsOutAt }` with the moment it runs out when it does not. With nothing spent the margin is null, and a limit that never resets is short as soon as anything is spent on it.

## Leftovers

`collectTrash` in `src/watcher/trash.ts` gives the `Trash` section its evidence, through `trash` on the first page of `services watcher evidence`. Each item has a `name`, a `category`, a `reason` and a `where` of `install` or `system`. Every command is a read through the injected `run`, nothing is deleted, and no leftover is opened. A name shaped like a key is masked.

| Category | What it lists |
|---|---|
| `units` | A `neptunia-*` unit whose binary or script is gone, or that is disabled with nothing referencing it. An entry that cannot be read as a file, such as a `.service.d` drop-in folder, is left out and the others are still judged |
| `identities` | A `neptunia-*` user or group that owns no process and no file under `/home`, `/var/lib`, `/srv`, `/opt` and `/etc`, searched to depth 4 |
| `state-folders` | A `neptunia-*` folder of `/var/lib` that no unit names |
| `stray-files` | An untracked file, from `git status --porcelain` |
| `dangling-symlinks` | A link whose target is gone, outside `node_modules`, `.git`, `.worktrees` and `.claude` |
| `unloaded-files` | A file of `prompts/` that `src/` never names, or a file of an agent's folder its profile does not name |

What cannot be read is a row of `unavailable` with its category, its `where` and a reason, so an empty category means it was looked at. Each category in each place holds at most `TRASH_ITEM_LIMIT` (50) items, and a cut is named there too. A leftover the agent reports is a finding like any other: it repeats and turns `low`.

## Degraded routes

`readRouteFacts` in `src/watcher/routes.ts` gives the first page its `routes`, read from the core's journal with `journalctl -u neptunia-core.service`, filtered to six messages of the last 14 days. A route is down from its first failure after its last success, and a restart in between does not end the outage.

| Route | Down from | Up again at |
|---|---|---|
| `proxy` | `proxy: switch` with `proxy-down` | `proxy: switch` with `proxy-back`, or `proxy: route` with `proxy` |
| `youtube` | `youtube-check: status` with `page` or `blocked` | `youtube-check: status` with `ytdlp` or `api` |
| `harness-login`, named by its backend | `subscription: run failed` with `subscription-login` or `not-logged-in` | `subscription: step` of the same backend |

`down` lists each route that has been down longer than `watcher.degradedAfterMinutes` (default `60`), with its `name`, `since` and `minutes`. The proxy is left out while `proxy.enabled` is not `true`, since `/proxy off` logs nothing. `llm: route switched` logs no recovery, so `switches` counts each role's switches from one route to another inside the observation window instead, with the time of the last. A journal the worker cannot read sets `unavailable` to `journal-permission`, `journalctl-exit-<code>` or `journalctl-<errno>`, and `down` stays empty. The core's unit holds the group `systemd-journal` in the system scope for this read, since the worker runs inside it as the core's user, and a user unit cannot hold it.

## What holds the agent

The worker runs inside the core's unit, `deploy/neptunia-core.service`, as the core's user and under its sandbox: `ProtectSystem=strict` with the data folder writable, `NoNewPrivileges=true` and `PrivateTmp=true`. It can read what the core reads, the memory database, `keys.json` and the clients' tokens among them. `workerStarter` gives it no `GH_TOKEN` or `GITHUB_TOKEN` and a `GH_CONFIG_DIR` of `data/agents/watcher/no-gh-login`, a folder that holds no login, so a `gh` it starts reads nothing. The network is open. The agent can write in the data folder, earlier reports and run records among them, and "immutable" for a report means no code path changes it. The backend's read-only mode and the prompt's ban on edits are the backend's and the model's.

## Judging a report

When evaluating a watcher, look for findings supported by file paths or recorded events, decisions the owner can act on, and repeated reports of an already tracked issue. A quiet report is useful only if the agent actually had access to the evidence it needed.

Read the implementation in [report validation](../src/watcher/report.ts), [finding risk](../src/watcher/risk.ts), [the run](../src/watcher/lifecycle.ts), [the doctor commands](../src/watcher/doctor.ts), [the inspection](../src/watcher/inspection.ts), [the recorded requests](../src/watcher/requests.ts), [the analyzer's work](../src/watcher/analyzer-facts.ts), [the money](../src/watcher/money.ts) and [the transcripts](../src/watcher/transcripts.ts).
