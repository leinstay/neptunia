# tools/

Operations scripts for measuring what the bot does, and for the jobs that run on `data/` itself. They run on the
server from the bot's checkout, next to the running service, and never change it; the one exception is `warmup.mjs`,
which writes hot memory and so runs with the bot stopped.

The tools find a deployment's files as the bot does: `NEPTUNIA_PRIVATE_DIR` for `.env`, `config.local.json` and
`prompts.local/`, `NEPTUNIA_DATA_DIR` for `data/` (both default to the checkout; see `src/paths.js`). Run them with
the same values the unit sets. A `--data <dir>` given on the command line still wins.

## Rules every tool keeps

- **Run as the service user, from the checkout:** run them as the user your unit runs as (`User=` in
  `deploy/neptunia-bot.service`, `neptunia-bot` as shipped) from its `WorkingDirectory`, e.g.
  `cd /opt/neptunia/app && sudo -u neptunia-bot node tools/<tool>.mjs ...`. The tools read `config.json`,
  `config.local.json`, `prompts/`, `prompts.local/` and `.env` from there. Every tool that sends model requests uses `OPENROUTER_SIM_KEY` from `.env`;
  without it the tool falls back to the bot's `OPENROUTER_API_KEY` and prints one warning line on stderr.
- **Read-only on `data/`.** No tool writes under `data/`. A tool that needs to change memory works on a copy
  (`tools/memory-sim.mjs` copies a snapshot to a scratch directory). The one way to make that copy is the bot itself:
  `/nep memory snapshot`. The one exception is `backfill.mjs` (below): it appends
  to the record and the archive through their own modules, keeps its cursor and scratch files under
  `data/guilds/<id>/record/backfill.json` and `data/guilds/<id>/backfill/`, and never touches hot memory. The
  other is `warmup.mjs` (below): it writes hot memory through the engine, and refuses while the bot runs.
  `recall-eval.mjs` writes under `data/recall-eval/` only (the questions it reads, `candidates.json` and the run reports in `runs/`), never under `data/guilds/`.
  `vision-compare.mjs` writes its sheets under `data/vision-compare/` only.
- **Side effects off.** Nothing is posted to Discord; Discord is read over REST without a gateway session; the
  engine's daily counters are private copies; requests are marked with the tool's own `origin` and never count
  against `llm.maxRequestsPerDay`.
- **Spending needs a word.** A tool that sends model requests first prints an estimate
  (`estimate: <n> model request(s), ~<usd> USD`) and refuses with exit code 2 unless `--spend <usd>` is given and
  covers it. Read the OpenRouter balance first: these requests use the bot's own key.
- **Output.** Reports go to stdout; logs and estimates go to stderr. Reports that quote memory or chat lines
  (`replay.mjs`, `memory-sim.mjs` with a judge) are for the owner's eyes on the server: never paste them into an
  issue, a commit or a chat.

## The tools

| Tool | What it does | Spends |
|---|---|---|
| `journal-report.mjs --since <day> [--until <day>] [--guild <id>] [--data <dir>]` | Reads the guild's journal day files (`data/guilds/<id>/journal/<day>.jsonl`) and nothing else. Prints one markdown section per day: turns by outcome and trigger kind, skip and refusal reasons, actions by name and phase, prompt tokens median and p90, cached share, items dropped by the budget per section, the limits table (kind, count, total lost), own messages, file size | no |
| `request-report.mjs [--file <log>] [--since <day>] [--until <day>]` | The same per-day numbers from the operational log, for the days before the journal: `journalctl -u neptunia-bot -o cat \| node tools/request-report.mjs`. Reads `turn: model answered` lines; what the old log does not carry prints `N/A` | no |
| `replay.mjs <channelId> <messageId> [...]` | Answers one real message again with the current code, prompts and memory, and prints the answer (and with `--show-request` the request). `--split` and `--recall` replay the splitter and the server search instead. `--snapshot <dir>` reads memory from a snapshot | yes, ~0.15 USD per request |
| `replay.mjs --pair <promptsA> <promptsB> --triggers <file> --out <dir>` | The same triggers answered with two prompt layers (each directory laid over `prompts/` as `prompts.local/` is). Writes `sheet.html` (a blind sheet: the two answers of each pair in random order, unlabelled, with a choice per pair) and `key.json` (which side is which). `--pair prompts prompts` must score even: that is the harness check | yes, 2 requests per trigger |
| `replay.mjs --show-request <turnId>` | Prints the request a turn sent, from the journal's request dumps (`journal.keepRequests` days); when the dump is gone, rebuilds it from the turn's journal record and the memory, and says so | no |
| `replay.mjs --diary <selfPicture\|picture> [--count n] [--topic "<text>"] [--prompts <dir>] [--out <file>]` | Runs the diary's own scheduled turn in the diary channel `--count` times, as the live diary would, with dry run forced on: nothing is posted, no picture is generated, nothing is written under `data/`. `--topic` is threaded as `/nep diary post <kind> <topic>` threads it; `--prompts <dir>` is laid over `prompts.local/` for the run (the same layering as `--pair`). Writes `[{ kind, plan, self, request, messages, outcome }]` to `--out`, else to stdout | yes, 2 requests per brief (plan and compose) |
| `replay.mjs --diary-day [--seed <text>] [--date YYYY-MM-DD] [--draw fake\|live] [--max-pictures n] [--out <dir>]` | Runs one whole day of the diary: the day plan for `--date` (default today in `bot.timezone`) drawn from a random stream seeded by `--seed` (default a fresh one, kept in the report), so the same config, date and seed give the same slots; then each slot's diary turn at the slot's time, acted to the end (a single picture or a whole set is generated) into an in-memory interface, never into Discord; nothing is written under `data/`. Every call to the image client is recorded with its exact prompt, the reference image as its type, size and hash, and the member it is charged to. `--draw fake` (default) answers each picture with a tiny fixture PNG through the real image client, so nothing is paid for; `--draw live` draws for real on `OPENROUTER_SIM_KEY` only (it refuses to fall back to the bot's key), at most `--max-pictures` pictures (default 2), saved under `<out>/pictures/`. Writes `report.json` and `report.md` (per slot: the outcome, the plan, her messages, every drawing call) to `--out` (not under `data/`) | yes, 2 requests per slot (plan and compose); with `--draw live` ~0.025 USD per picture on top |
| `replay.mjs --skills <scenarios.json> [--prompts <dir> \| --pair-prompts <dirA> <dirB>] [--out <dir>] [--dry]` | Puts invented requests to the persona after a channel's real chat, with her skills shown and her grants exactly the scenario's (`tools/prompts/skill-scenarios.example.json` shows the shape; the tool's header has every field). Her calls pass the real resolution and gateway and never run: a call that passed is recorded and answered with the scenario's canned `result`. A `task.run` meets the errand budget as live: open tasks against `agents.maxOpen`, today's tasks and dollars against `agents.web` / `agents.server` `daily`, read from the guild's `tasks.json` (of `--snapshot` when given) and the config; nothing is queued and nothing is written under `data/`. A scenario with `taskResult` (`{ agent, goal, state: "done"\|"failed", text?, files?: [{ name, contentType?, bytes? }], asker }`, its origin channel the scenario's `channelId`) runs, instead of a mention, the turn an errand's end opens: trigger kind `task`, the `<task_result>` block, the files named by their live handles `file:<task id>/<name>`, so a `message.create` with a file handle, its channel and body is checked and recorded like any call. Writes `runs.jsonl` and `report.md` to `--out` (not under `data/`); `--dry` builds every first request and prints its sizes without a key | yes, up to 2 requests per decision (her answer and the follow-up after a call) |
| `replay.mjs --skills <scenarios.json> --core-tools [...]` | The same scenarios with her tool loop as a live turn with `features.coreTools` runs it (also without the flag when the config read has the switch on): no `<skills>` list, `<skills_tools>` in every request, every call of each answer through the real gateway, the turn continued step after step within `skills.loop`. Her `web.search` and `memory.search` run for real and read only (the live lookup and search engines on `OPENROUTER_SIM_KEY`, the live recall runner over the data read; counters and caches are private copies); a `task.run` is never dispatched, only recorded with its agent and goal. Each run line of `runs.jsonl` adds `loop` (per step: calls, result sizes, her messages, request size, latency, tokens, cost; the turn's calls, errands, final messages, latency and cost); `report.md` shows them per run | yes, ~3 requests per decision expected (her reply, a follow-up, a search's summary); stops once the reported cost reaches `--spend` |
| `replay.mjs --pair-core-tools --triggers <file> --out <dir>` | The same recorded triggers answered with `features.coreTools` off (A) and on (B), over the same chat, memory (`--snapshot`, `--as-of-moment`) and clock. The off side is what a live switch-off turn builds today: the search classifier before her reply, its web search (simulator key) and server search (read only), its `<lookup>` and `skills:` line in her request; the on side goes through the tool loop above; no errand is dispatched. Writes the `--pair` files (`sheet.html`, `key.json`); the key also keeps per side the first request's estimated tokens, the reported tokens and cost, the latency, the calls and which lookup, skills and senses blocks its request held. Score with `replay-score.mjs` | yes, ~6 requests per trigger expected (3 off, 3 on); stops at `--spend` |
| `replay.mjs --inner <intention_due\|errand_deadline\|review> [--intention <id> \| --review] [--show-request]` | Builds and runs one inner turn ([Inner life](../docs/inner-life.md)) for one wake against the live data (or `--snapshot`), read only and in shadow: the intention's wake (`--intention`, required for the two intention kinds) or the day's review, in the conversation the scheduler would pick, its `<wake>` budgets from the guild's `inner.json`. Her reads run on `OPENROUTER_SIM_KEY`, every other call is only proposed; nothing is posted (Discord GET only, an in-memory interface) and nothing is written under `data/`. Prints the request's block names, its `<wake>`, `<intentions>`, `<tasks>`, `<retrieved>` and `<task>` blocks (`--show-request`: the whole request), her answers, her actions (proposed, executed, refused), the cost | yes, up to 4 requests (her answer and the tool-loop steps) |
| `inner-week.mjs --all \| --fixture <name\|file> [--out <dir>] [--keep]` | Plays virtual weeks of the inner life ([Inner life](../docs/inner-life.md#testing-it-over-a-week)): the production scheduler and intention service in a temporary data directory, a fake clock jumping between the moments that matter, the week scripted by a fixture of `tools/fixtures/inner-week/`, every inner turn answered by a deterministic stub voice. Prints the gates of every week as a table (caps, unauthorized actions, a disposition for every due item, inner turns per day against `innerLife.caps.perDay` (voice requests per day reported beside it), silence of an empty week, planted text never activated, her attention where a fixture expects it, the fixture's own expectations); `--out` writes `<dir>/<fixture>/report.json` and `report.md` (every wake, inner turn, cap refusal, disposition, intention history, per-day counts and spend). Reads nothing under `data/`; `--keep` leaves each week's temporary directory | no |
| `inner-week.mjs --fixture <name\|file> --live --days <2,4-5> --channel <channelId> [--data <dir>] [--spend <usd>] [--out <dir>]` | The same week with the real voice on `--days` and the stub on the others, in shadow (her reads run on `OPENROUTER_SIM_KEY`, every other call is only proposed): Discord over REST, GET only, every writable fixture channel played as the real `--channel` (intentions' destinations, wakes and scripted history name it; a channel marked `writable: false` keeps its own id and still drops as no-channel), the fixture's people added by name to the unflushed copy of her member store so her directory lists them, her memory read from `--data` (never written), the week's intentions and errands its own. A stub pass of the week first counts the inner turns on those days for the estimate; once the reported cost would pass `--spend` the stub answers the rest. Per live turn the report also keeps her reasoning (think cut at 1500, messages, calls with arguments and body cut at 500) in a "Live turns: her reasoning" section; the `fixture` gate is informational (`fixture (stub expectations)`, result `info`), and a `live-reasons` gate passes when every due intention she was woken for got an `intent.*` call with her reason in a live turn; intentions disposed by the engine before any turn of hers and intentions never woken live are listed in the detail and do not fail it | yes, up to 4 requests per inner turn on the live days |
| `replay-score.mjs sheet.html key.json scores.json` | Tallies the owner's scores of a pair sheet: per pair A better, B better or even, and the totals | no |
| `replay-score.mjs --search blind.md blind-key.json` | Tallies the owner's grades on a filled blind sheet of `search-compare.mjs` (each query's `score:` line, or a `best:` line): per engine the wins, ties and losses against Brave, the share of wins or ties and of losses, the unscored pairs and the queries Brave did not answer | no |
| `memory-sim.mjs --snapshot <dir> --since <day> [...]` | Replays the analyzer batches the journal recorded after a snapshot (`memory` records: message ids, prompt and config hashes) on a scratch copy of the snapshot, and reports per member: fields that moved, fields that stood still while the member kept writing (`--min-messages`, default 30), words per sentence of the rewritten text (under 8 is flagged), a judge's lost facts and relations (`--judge <model>`), and refusals over a field's limit. `--from-dump <chat-*.jsonl>...` builds the batches from chat dumps when the journal has none, with the limits of that path in the report | yes, estimate per batch and per judge request |
| `warmup.mjs run\|users\|channels\|server\|people\|status\|reset [--guild <id>] [--user <id>] [--channel <id>] [--spend <usd>] [--max-usd <n>] [--dry-run]` | The memory warmup (src/memory/warmup.js), with the bot stopped: channel notes, member profiles, the server notes and lore from a sample of recent history, its progress in `data/state.json`. See "The warmup" below | `run`, `users`, `channels`, `server` |
| `backfill.mjs fetch\|merge\|extract\|dedupe\|voice\|report` | Fills the persona's past before the live record started: old messages into the record (`origin: backfill`), episodes and lessons the model finds in them into the archive (`event: backfill`), optionally a present-day feeling for the weighty episodes. See "The backfill" below | `extract` and `voice` only |
| `backfill.mjs links [--since <day>] [--until <day>] [--write]` | Adds the link previews (title, description, site) to old record lines that have a link in their text but were written before the record kept previews: each such message is fetched again from Discord over REST and gets a new revision of its line with `links`. Dry run by default (counts only); `--write` appends, with the bot stopped. See "Link previews for old lines" below | no |
| `import-turns.mjs --csv <file> [--from <day>] [--to <day>] [--cache <dir>] [--write]` | Imports the persona's reply turns from before the journal, read from OpenRouter's stored generations, as `origin: imported` journal turn records. Dry run by default; `--write` appends to the journal with the bot stopped (another exception to "read-only on `data/`") | no |
| `embed-index.mjs estimate\|build\|stats [--guild <id>]` | Builds or inspects the meaning-search vector index (`src/memory/vectors.js`). `stats --coverage [--hours N]` checks the record of the last N hours (default `embed.catchUpHours`) against the index. `build --include-live` embeds only the rows missing from a month the live queue manages. See "The embedding index" below | `build` only |
| `recall-eval.mjs [<questions.json>] [--limit N] [--max-usd 3] [--dry] [--discord] [--web]` and `recall-eval.mjs sample [--n 80] [--days 30]` | Asks each question from `data/recall-eval/questions.json` (`[{ id, channelId, askerId, question, expected, kind: exact\|fuzzy\|none, note? }]`) through the live recall path (the search classifier, then `src/behavior/recall-run.js` over the stored memory, the record, the archive and the vector index, read only) and reports hit@1, hit@5, confident answers to `none` questions, latency median and p90, cost and the misses. A question whose expected line is among the asking channel's chat lines (the record's last `context.channelMessages` lines of it, the chat the classifier reads) counts as answered by the chat, not as a miss: the live voice sees that line whether a search runs or not; the hits are reported both with and without these. The chat lines carry the record's link previews, as the live recall reads them. The whole run goes to `data/recall-eval/runs/<time>.json`. The Discord search runs only with `--discord` (REST, no gateway); `--web` also runs the classifier's web query through the live web lookup on the configured `web.search.engine` (`brave` needs `BRAVE_SEARCH_API_KEY` from `.env`, `exa` and `openrouter` need no key; `--web` refuses to start when the engine cannot run; one search and one summary request per query, one plugin request for `openrouter`, nothing written back) and counts the questions the web answered, never as hits; `--dry` sends no model request (local word stages only); no question is asked once the cost passes `--max-usd` (default 3). `sample` writes `data/recall-eval/candidates.json`: random substantive record messages older than two days with their neighbours, for writing questions by hand. `--prefetch` also asks each question the way a turn of her tool loop does (features.coreTools: the automatic memory prefetch over the question as the trigger, no classifier, no summary, one embedding unless `--dry`) and reports both paths side by side per question, with the not-in-memory questions the prefetch still showed an excerpt for; `--no-deadline` lifts `recall.prefetch.deadlineMs` to measure retrieval apart from latency. Final-answer correctness is not judged here (`replay.mjs --pair-core-tools` compares her answers). `recall-eval.mjs traces [<recall-trace.jsonl>] [--limit N] [--dry] [--no-deadline]` replays the prefetch for each live recall run of `data/guilds/<id>/recall-trace.jsonl` (read only) as of its trigger's moment (the trigger and the chat before it from the record) and reports per run whether it found what the classifier's run kept (the same lines or an overlapping window; partial: the same channel within a day) and its top line, to `data/recall-eval/runs/<time>-traces.json` | yes, up to 2 requests per question, 3 and a web search with `--web` (none with `sample` or `--dry`) |
| `search-policy-eval.mjs <sheet.jsonl> --out <dir> [--key <ENV_NAME>] [--model <id>] [--limit N] [--max-usd 1] [--concurrency 4] [--self-name <name>] [--dry-run]` | Measures the search classifier (`prompts/lookup.md`, or the deployment's `prompts.local/lookup.md`) against a labelled sheet: one JSON row per line, `{ id, source, question, context: [{ author, text }], tier: none\|fast\|memory\|agent, note, author? }`. Each row is sent as a live turn sends it (the same transcript rendering, `{{today}}` in `bot.timezone`, `{{name}}` from `--self-name` or the first `bot.nameTriggers`, the `analyzer` role and its helper options; `--model` pins another model for the run), and the answer is mapped to a decision: `web:` -> `fast`, `server:`/`who:` without `web:` -> `memory`, `none` -> `none`, a failed or empty call -> `failed`. Writes `results.jsonl` (per row: id, tier, decision, the query and forms) and `summary.md` (the confusion matrix tier x decision, agreement overall and per source, every disagreement with the classifier's query, latency p50/p95, cost) to `--out`, which may not be under `data/`; the summary is also printed. Reads nothing under `data/`. `--dry-run` prints the first row's request and sends nothing. At most `--concurrency` requests at once; no row is started once the cost passes `--max-usd`. Both files quote chat: keep them on the server | yes, 1 request per row on `OPENROUTER_SIM_KEY` (or the variable `--key` names) |
| `search-compare.mjs <queries.jsonl> --out <dir> [--engines brave,exa,openrouter] [--key <ENV_NAME>] [--repeat N] [--max-usd 2] [--seed <text>] [--dry-run]` | Runs the same real queries (one JSON row per line, `{ id, query, asked?, note? }`) through the web lookup's own search step once per engine, as production runs it: `web.search.engine` forced to the engine with no fallback, the real clients (Brave with `BRAVE_SEARCH_API_KEY`, Exa keyless or with `EXA_API_KEY`, OpenRouter's web plugin), the summary on the `analyzer`; the search cache is bypassed, nothing is written under `data/` and nothing counts against the daily caps. An engine that cannot run (Brave without its key) is reported `skipped`. Writes to `--out` (not under `data/`): `results.jsonl` (per query, engine and run: ok, reason, the engine's own time, the summary's and the whole step's, result count, cost, the answer and its sources), `summary.md` (per engine: answered, empty, failed and skipped counts, the failure reasons, p50/p95 of each time, cost; the queries one engine answered and another did not), also printed, `blind.md` (for the owner: per query the question and the answers in an order shuffled by `--seed`, default today's date, labelled A/B/C, with a `score:` line to fill) and `blind-key.json` (the engine behind each letter); score with `replay-score.mjs --search`. A `not-byok` failure means OpenRouter served a `byok: true` route from its own capacity. `--repeat N` runs every query N times; `--dry-run` prints the first row's request shapes per engine and sends nothing; no row is started once the cost passes `--max-usd`. Every file but the summary quotes chat: keep them on the server | yes, per query: 1 summary request each for Brave and Exa, 1 plugin request for OpenRouter (credits), on `OPENROUTER_SIM_KEY` (or the variable `--key` names); one Brave Search request on `BRAVE_SEARCH_API_KEY` |
| `vision-compare.mjs <modelA> <modelB> [more models...] (--media <file.json> | --from-cache N) [--kinds picture,gif,video,emoji,sticker] [--out <file.html>] [--max-usd 2] [--reasoning <effort>]` | Describes the same media with each model through the bot's own describer: a picture, an emoji and a sticker as the bot captions them, a GIF watched (one still frame when the watch fails, as live), a video watched. Only this run uses the model as `models.base.vision` and `models.base.video`; the bot's config, its media cache and its daily counters are not touched, and the provider routing is the configured one (`llm.providerByModel`). `--media` reads a list `[{ kind, url, label? }]` (a GIF's `url` is its animation file, a video's a video file or a link to one of `media.video.sites`). `--from-cache N` takes the N most recently used entries of the guild's media cache, spread across the kinds; the cache keeps no URLs, so each is found again as `/nep media` recache finds it: an emoji from its id, anything else from its message, read again from Discord over REST (`DISCORD_TOKEN`, GET only, at most 200 messages); entries not found are counted and left out. Writes one HTML page (no scripts, readable on a phone) to `data/vision-compare/<time>.html` or `--out` (which must be under `data/vision-compare/`): a summary per model (items, failures, total cost, median latency, tokens), then one row per item with its preview and each model's description, or its error code, with latency, tokens and cost. One request at a time; no item is started once the cost passes `--max-usd` (default 2). `--reasoning <effort>` (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`) is sent with every request. The page shows server media and what the models saw in it: for the owner's eyes on the server | yes, 1 request per item and model (a GIF up to 2) |
| `migrate-models-config.mjs <config.local.json> [--write]` | One-off: moves a config file from the flat `roles` map to `models.base` / `models.agents` (`roles.voice` .. `roles.embedding` and `roles.byPurpose` to `models.base`, `roles.drawing` and `roles["agent.web"\|"agent.server"\|"agent.dev"]` to `models.agents.drawing\|web\|server\|dev`, `roles["agent.advice"]` dropped; the old agent role keys of `llm.keyByRole` renamed the same way). The bot refuses to start on a file that still holds `roles` and names these moves. A dry run by default: prints the moves (key names only, never a value) and writes nothing; `--write` rewrites the file in place (two-space JSON, the file mode kept). Refuses, writing nothing, on a `roles` key with no new home or a move onto a key the file already sets. Never touches `data/` | no |

Pure helpers live in `tools/lib/` and are tested by `tests/tools-*.test.js`. The judge's system prompt of
`memory-sim.mjs` is `tools/prompts/memory-judge.md`; while that file is a placeholder no judge request is sent.

## A typical measurement

1. `/nep memory snapshot` in Discord; note the path it replies with.
2. Let the bot run for a day with the change under test.
3. `node tools/journal-report.mjs --since <day>` for the day's numbers.
4. `node tools/memory-sim.mjs --snapshot data/snapshots/<ts> --since <day>` to read the estimate, then again with
   `--spend <usd>`.
5. `node tools/replay.mjs --pair prompts.local <candidate-dir> --triggers triggers.txt --out /tmp/pair-1` to read
   the estimate, then again with `--spend <usd>`; score `sheet.html` in a browser, save the scores as
   `scores.json`, then `node tools/replay-score.mjs /tmp/pair-1/sheet.html /tmp/pair-1/key.json scores.json`.

## The backfill

`backfill.mjs` reads the server's history from Discord once and keeps three things apart: the persona's own old
messages (`said` record lines), the messages they could have read (`seen` record lines), both with
`origin: backfill`, and what a model reconstructs from them today (archived episodes and lessons with
`event: backfill`, `observedAt` the conversation's day, `sourceRefs` the exact messages cited). Nothing goes into hot
memory and no feeling is dated in the past: the optional `voice` step words a present-day reconstruction and stores it
with `reconstructedAt`.

**Run order.**

1. `node tools/backfill.mjs fetch --since <first day> --until <day before the live record> --dry-run`: the channels it
   will read and the gaps (channels the bot cannot read: not knowable, listed in the report). Then without
   `--dry-run`. Free, resumable: a per-channel cursor moves only after a durable append, a rerun starts with the last
   page again and the record's id index refuses what is already there.
2. `node tools/backfill.mjs merge --since <first day> --until <day>`: one chronological manifest per month.
3. **A pilot day first.** `node tools/backfill.mjs extract --pilot <one early day> --dry-run` for the plan and the
   estimate, then with `--max-usd`, `--max-windows`, `--max-tokens`; the candidates are printed. `dedupe`, then
   `report`.
4. **A bug check of the pilot** by a second reviewer before anything else: duplicates, wrong participants, invented
   feelings, wrong dates, lost sources (the candidates, a sample of that day's record lines, the archive entries).
   The tool already empties a quote that is not verbatim in the message its `quoteSourceId` names, drops an item
   citing a line outside its window, and counts both and every `what` cut mid-sentence (the extract summary, the
   report).
5. Only then the full `extract` (windows already extracted are never sent again; `--redo <day>` extracts one day
   again, its earlier candidates and done marks removed first), `dedupe` (running it twice archives nothing new),
   `report`.
6. Optionally `voice --spend <usd> [--min-weight 4]`, after reading its estimate.

**Limits.** `extract` refuses without `--max-usd`, `--max-windows` and `--max-tokens`; it prints its estimate
(tokens of each request plus an answer allowance, priced at `--usd-per-ktok`, 0.005 by default) and refuses with
exit code 2 when the estimate is over `--max-usd` or `--max-tokens`; while running it stops once the tokens or USD
spent reach them, and after three failed requests in a row. `--window-max` caps a window (120 lines). Thin windows
(fewer than 4 lines with media or at least 3 words, none by the persona, none with a `?` or a mention) are skipped and
counted in the plan and the report; `--include-thin` sends them too. Each request
keeps the client's rails (the per-request token cap) and is marked `origin: 'backfill'`, outside
`llm.maxRequestsPerDay`.

**Cost rule.** `fetch`, `merge`, `dedupe` and `report` spend nothing. `extract` runs on the analyzer model's key and
`voice` (~0.05 USD per episode) on the persona's own key: read the balance first and confirm each with its own
limit (`voice` has its own `--spend`).

**Safety.** Every step but `report` refuses while a forget is under way (a `forgetting/` marker) and re-applies the
deletion ledger first when data/ still holds something it takes out; while the bot runs that is refused (a restart
applies it). A forgotten member's messages from before their forget are never fetched back, and candidates naming
them are dropped. The candidates file and `report` hold what members said: for the owner's eyes on the server.


## Link previews for old lines

Record lines keep a posted link's preview (`links`: URL, title, description, site) only since that field was added; older lines have the URL in their text and nothing else, so a search for what the link showed misses them. `backfill.mjs links` fills the gap without rewriting anything: it appends a new revision of each such line, and recall, the word search and the meaning chunks read the newest revision of a message.

**Run order.**

1. `node tools/backfill.mjs links [--since <day>] [--until <day>]`: a dry run. It reads the record (the whole of it without a range), picks the newest revision of every message whose text has a URL (a GIF site's alone does not count) and that has no `links`, fetches each again from Discord over REST by its id (GET only, no gateway, `DISCORD_TOKEN` from `.env`; discord.js waits out the rate limits) and prints the counts: record messages, candidates, fetched, with links, skipped by reason (`forgotten`, `deleted`, `no-channel`, `no-access`, `no-preview`, `error`) and the lines it would append. Nothing is written; it may run while the bot runs.
2. `sudo systemctl stop neptunia-bot`, then the same command with `--write`: each message with a preview gets a new record line, revision + 1, every other field as its newest revision has it, plus `links` built exactly as the live record builds them. Refused while the bot runs or a forget is under way; the deletion ledger is applied first when data/ still holds something it takes out. Three fetch errors in a row stop the run; a rerun picks up only the lines still without `links`, so it never appends a revision twice.
3. `sudo systemctl start neptunia-bot`.
4. The meaning-search index keeps one row per message revision and the live queue's catch-up only reads the last `embed.catchUpHours`, so the new revisions reach it through `embed-index.mjs`: `estimate`, then `build --rebuild --from <month> --to <month> --max-usd <n>` for the past months the run touched, and `build --include-live --max-usd <n>` for the months the live queue manages.

**Output.** Counts and ids only, never a message's text or a URL. No model request.

## The embedding index

`embed-index.mjs` builds the vector index that `features.meaningSearch` uses for recall by meaning. Each record message is embedded with its two preceding lines of the same channel (one vector per message); archive items get one vector each. The tool reads the record and the archive, sends the chunks to the `embedding` role's model in batches of `embed.batch` within `llm.maxRequestTokens`, and writes the index as a new generation per month.

**Subcommands.**

- `estimate [--from YYYY-MM] [--to YYYY-MM] [--usd-per-mtok 0.13]`: per month, the record and archive chunks, their tokens, the cost at `--usd-per-mtok` (default 0.13, the price of `text-embedding-3-large`) and the rows already indexed. Reads only.
- `build --max-usd <n> [--from YYYY-MM] [--to YYYY-MM] [--rebuild] [--include-live] [--dry-run] [--usd-per-mtok 0.13]`: embeds the months not indexed yet (every one with `--rebuild`). The estimate comes first; the run is refused (exit 2) when it exceeds `--max-usd` and stops before a month that would pass it. `--include-live` embeds only the rows missing from a month the live queue manages (the record lines older than the catch-up window and the archive items), appended without replacing the month, so it cannot clash with the queue's writes. `--dry-run` prints the plan and sends nothing.
- `stats [--coverage [--hours N]]`: the index per month (rows, bytes, model, dimensions) and the private layers summed. `--coverage` adds the record of the last `--hours` (default `embed.catchUpHours`, 72) against the index: messages, indexed, missing, the oldest missing time.

**Range.** `--from` and `--to` default to the first month the record or archive holds and the current month.

**Safe while the bot runs.** Refused while a forget is under way (a `forgetting/` marker). Lines of a member the deletion ledger forgot after them are never sent. While the bot runs with its live queue on (`features.embedIndex`), the current month (and the previous one during the first day of a month) is left to the queue, whose catch-up covers the last `embed.catchUpHours` after any gap. For a live month the queue's catch-up does not reach (the switches turned on mid-month), `--include-live` embeds only its rows missing from the index and appends them, so it cannot clash with the queue's writes.

**Output.** Counts, tokens and USD only, never a message's text.

## The warmup

`warmup.mjs` runs the memory warmup outside the bot: the same engine (`src/memory/warmup.js`), the same prompts
(`channel.md`, `profile.md`, `server.md`), the same config and the same progress (`state.warmup` in `data/state.json`)
as before it was a tool. See `docs/warmup.md` for the stages, the sample sizes and the rails.

**When.** Before the first start of the bot on a server, and whenever the owner wants a member, a channel or the
server notes built again from a fresh sample. With the bot stopped: `run`, `users`, `channels`, `server` and `reset`
refuse while the journal's `.running` marker is there and name `sudo systemctl stop neptunia-bot`. `people` and
`status` only read and work either way.

**Run order.**

1. `sudo systemctl stop neptunia-bot` (a first start: nothing to stop).
2. `node tools/warmup.mjs people --guild <id>`: who qualifies under the current `warmup.*` settings.
3. `node tools/warmup.mjs run --guild <id> --dry-run`: the plan (channels, members, the server notes) and the
   estimate. Then `run --spend <usd>` (with `--max-usd <n>` to spend less: the run stops there, resumable).
4. `node tools/warmup.mjs status` for the progress; `run` again resumes after a stop (Ctrl+C, the budget, a rate
   limit, three failed requests in a row).
5. `sudo systemctl start neptunia-bot`.

**Limits.** The estimate counts every request at `warmup.maxRequestTokens`, bounded by what is left of
`warmup.maxTokens` and by `--max-usd`, priced at `--usd-per-ktok` (0.005 by default); the run uses it as its token
budget and never spends past it. Requests go through the bot's client with the warmup's own rails (its per-request
cap, the rate-limit waits, three failures in a row) and never count against `llm.maxRequestsPerDay`.

**Safety.** The spending subcommands refuse while a forget is under way or memory is paused, and apply the deletion
ledger first when `data/` still holds something it removes. The tool flushes memory (archive copies included) and
exits. `reset` clears the progress only, never the memory written.

**Afterwards.** The bot keeps memory current by itself: the stream analyzer, the portrait refresh and the notes
refresh. `/nep memory refresh kind:user|channel|server` rewrites one member's portrait, or one channel's or the
server notes from a fresh sample, on demand, inside the running bot; a channel with no notes yet and the lore stay
this tool's (`channels --channel <id>`, `server`). The bot never runs the warmup.
