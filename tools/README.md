# tools/

Operations scripts for measuring what the bot does. They run on the server from the bot's checkout, next to the
running service, and never change it.

## Rules every tool keeps

- **Run as the service user, from the checkout:**
  `cd /opt/neptunia-bot && sudo -u neptunia-bot node tools/<tool>.mjs ...` (the user and directory of
  `deploy/neptunia-bot.service`). The tools read `config.json`, `config.local.json`, `prompts/`, `prompts.local/`
  and `.env` from there.
- **Read-only on `data/`.** No tool writes under `data/`. A tool that needs to change memory works on a copy
  (`tools/memory-sim.mjs` copies a snapshot to a scratch directory). The one way to make that copy is the bot itself:
  `/nep memory snapshot`. The one exception is `mentor-cli.mjs`, moved here as it was: like `/nep mentor` it writes
  its run records and case scores under `data/guilds/<id>/mentor/`.
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
| `replay-score.mjs sheet.html key.json scores.json` | Tallies the owner's scores of a pair sheet: per pair A better, B better or even, and the totals | no |
| `memory-sim.mjs --snapshot <dir> --since <day> [...]` | Replays the analyzer batches the journal recorded after a snapshot (`memory` records: message ids, prompt and config hashes) on a scratch copy of the snapshot, and reports per member: fields that moved, fields that stood still while the member kept writing (`--min-messages`, default 30), words per sentence of the rewritten text (under 8 is flagged), a judge's lost facts and relations (`--judge <model>` or `mentor.model`), and refusals over a field's limit. `--from-dump <chat-*.jsonl>...` builds the batches from chat dumps when the journal has none, with the limits of that path in the report | yes, estimate per batch and per judge request |
| `mentor-cli.mjs run\|check\|add\|list` | Starts a mentor run or check from the shell, adds or lists cases | yes (a run) |

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
