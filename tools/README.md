# tools/

Operations scripts for measuring what the bot does, and for the jobs that run on `data/` itself. They run on the
server from the bot's checkout, next to the running service, and never change it; the one exception is `warmup.mjs`,
which writes hot memory and so runs with the bot stopped.

## Rules every tool keeps

- **Run as the service user, from the checkout:**
  `cd /opt/neptunia-bot && sudo -u neptunia-bot node tools/<tool>.mjs ...` (the user and directory of
  `deploy/neptunia-bot.service`). The tools read `config.json`, `config.local.json`, `prompts/`, `prompts.local/`
  and `.env` from there.
- **Read-only on `data/`.** No tool writes under `data/`. A tool that needs to change memory works on a copy
  (`tools/memory-sim.mjs` copies a snapshot to a scratch directory). The one way to make that copy is the bot itself:
  `/nep memory snapshot`. The one exception is `backfill.mjs` (below): it appends
  to the record and the archive through their own modules, keeps its cursor and scratch files under
  `data/guilds/<id>/record/backfill.json` and `data/guilds/<id>/backfill/`, and never touches hot memory. The
  other is `warmup.mjs` (below): it writes hot memory through the engine, and refuses while the bot runs.
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
| `replay-score.mjs sheet.html key.json scores.json` | Tallies the owner's scores of a pair sheet: per pair A better, B better or even, and the totals | no |
| `memory-sim.mjs --snapshot <dir> --since <day> [...]` | Replays the analyzer batches the journal recorded after a snapshot (`memory` records: message ids, prompt and config hashes) on a scratch copy of the snapshot, and reports per member: fields that moved, fields that stood still while the member kept writing (`--min-messages`, default 30), words per sentence of the rewritten text (under 8 is flagged), a judge's lost facts and relations (`--judge <model>`), and refusals over a field's limit. `--from-dump <chat-*.jsonl>...` builds the batches from chat dumps when the journal has none, with the limits of that path in the report | yes, estimate per batch and per judge request |
| `warmup.mjs run\|users\|channels\|server\|people\|status\|reset [--guild <id>] [--user <id>] [--channel <id>] [--spend <usd>] [--max-usd <n>] [--dry-run]` | The memory warmup (src/memory/warmup.js), with the bot stopped: channel notes, member profiles, the server notes and lore from a sample of recent history, its progress in `data/state.json`. See "The warmup" below | `run`, `users`, `channels`, `server` |
| `backfill.mjs fetch\|merge\|extract\|dedupe\|voice\|report` | Fills the persona's past before the live record started: old messages into the record (`origin: backfill`), episodes and lessons the model finds in them into the archive (`event: backfill`), optionally a present-day feeling for the weighty episodes. See "The backfill" below | `extract` and `voice` only |
| `embed-index.mjs estimate\|build\|stats [--guild <id>]` | Builds or inspects the meaning-search vector index (`src/memory/vectors.js`). See "The embedding index" below | `build` only |

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


## The embedding index

`embed-index.mjs` builds the vector index that `features.meaningSearch` uses for recall by meaning. Each record message is embedded with its two preceding lines of the same channel (one vector per message); archive items get one vector each. The tool reads the record and the archive, sends the chunks to the `classifier.embed` model in batches of `embed.batch` within `llm.maxRequestTokens`, and writes the index as a new generation per month.

**Subcommands.**

- `estimate [--from YYYY-MM] [--to YYYY-MM] [--usd-per-mtok 0.13]`: per month, the record and archive chunks, their tokens, the cost at `--usd-per-mtok` (default 0.13, the price of `text-embedding-3-large`) and the rows already indexed. Reads only.
- `build --max-usd <n> [--from YYYY-MM] [--to YYYY-MM] [--rebuild] [--dry-run] [--usd-per-mtok 0.13]`: embeds the months not indexed yet (every one with `--rebuild`). The estimate comes first; the run is refused (exit 2) when it exceeds `--max-usd` and stops before a month that would pass it. `--dry-run` prints the plan and sends nothing.
- `stats`: the index per month (rows, bytes, model, dimensions) and the private layers summed.

**Range.** `--from` and `--to` default to the first month the record or archive holds and the current month.

**Safe while the bot runs.** Refused while a forget is under way (a `forgetting/` marker). Lines of a member the deletion ledger forgot after them are never sent. While the bot runs with its live queue on (`features.embedIndex`), the current month (and the previous one during the first day of a month) is left to the queue, so the tool and the queue never write the same month.

**Output.** Counts, tokens and USD only, never a message's text.

## The warmup

`warmup.mjs` runs the memory warmup outside the bot: the same engine (`src/memory/warmup.js`), the same prompts
(`channel.md`, `profile.md`, `server.md`), the same config and the same progress (`state.warmup` in `data/state.json`)
as before it was a tool. See `docs/en/warmup.md` for the stages, the sample sizes and the rails.

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
