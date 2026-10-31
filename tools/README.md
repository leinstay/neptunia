# tools/

Scripts for measuring what the bot does and for jobs that run on `data/` itself. They run on the server from the bot's checkout, next to the running service.

## How to run

Run as the service user, from the checkout:

```
cd /opt/neptunia/app && sudo -u neptunia-bot node tools/<tool>.mjs ...
```

The tools find files as the bot does: `NEPTUNIA_PRIVATE_DIR` for `.env`, `config.local/` and `prompts.local/`, `NEPTUNIA_DATA_DIR` for `data/` (both default to the checkout). `--data <dir>` overrides the data path.

Every tool that sends model requests uses `OPENROUTER_SIM_KEY` from `.env`; without it the tool stops with an error and never spends the bot's key.

## Rules

- **Read-only on `data/`.** No tool writes under `data/guilds/`. A tool that needs to change memory works on a copy made by `/nep memory snapshot`. `recall-eval.mjs` writes under `data/recall-eval/` only. `vision-compare.mjs` writes under `data/vision-compare/` only.
- **Side effects off.** Nothing is posted to Discord. Discord is read over REST without a gateway session. The engine's daily counters are private copies. Requests are marked with the tool's own `origin` and never count against `llm.maxRequestsPerDay`.
- **Spending needs a word.** A tool that sends model requests prints an estimate and refuses with exit code 2 unless `--spend <usd>` covers it.
- **Output.** Reports go to stdout, logs and estimates to stderr. Reports that quote memory or chat are for the owner's eyes on the server: never paste them into an issue, a commit or a chat.

## The tools

| Tool | What it does | Writes under `data/` | Needs bot stopped | Spends model credit |
|---|---|---|---|---|
| `labels-catalogue.mjs` | Compares the code catalogue (`src/tools/codes.ts`) with `config/labels.json` and the reason-codes table in `docs/prompt-contract.md`. `--check` is a CI step (`npm run check:codes`); `--write` regenerates the table | no | no | no |
| `config-migrate.mjs` | Writes the config keys that moved when the skills became tools (`skills.*`, `features.skills`, `features.skillsDiscovery`, the grant on `skills.describe`) into the private settings file (`config.local/config.json`, or `config.local.json` of a layer not yet moved), or into the file of `--file`. `--dry-run` prints each move, `--apply` writes. The engine applies the same moves on load, so the file works unmigrated and logs one warning | no (writes the config file) | no | no |
| `tools-file-move.mjs` | Moves `prompts.local/skills.json` to `config.local/tools.json` (the entry `skills.describe` becomes `tools.describe`) and renames the `skills` section of `prompts.local/labels.json` to `tools`. `--dry-run` says what it would do, `--apply` does it, `--dir` names the private directory. Two files that differ refuse the whole run and change nothing | no (writes the private layer) | no | no |
| `config-files-move.mjs` | Moves a private layer's `config.local.json` to `config.local/config.json` byte for byte and its flat `prompts.local/labels.json` to `config.local/labels.json`, split into `model` and `owner` by the tracked `config/labels.json`. `--private <dir>` names the layer, and without `--apply` it only says what it would do. A file at both places with the same content loses its old copy, and with different content the run is refused and changes nothing | no (writes the private layer) | no | no |
| `config-doc.mjs` | Prints `docs/configuration.md` from the settings schema (`src/config/schema.ts`) and the prose of `tools/config-doc.template.md`: `node tools/config-doc.mjs > docs/configuration.md`. `tests/config-doc.test.ts` fails while the committed file differs | no | no | no |
| `journal-report.mjs` | Reads the journal day files and prints one markdown section per day: turns by outcome, actions, prompt tokens, cached share, items dropped, limits, message count, file size | no | no | no |
| `request-report.mjs` | The same per-day numbers from the operational log, for the days before the journal: pipe `journalctl -u neptunia-bot -o cat` into it | no | no | no |
| `replay.mjs` | Answers one real message again with the current code, prompts and memory. `--split` and `--recall` replay the splitter and the server search. `--snapshot <dir>` reads memory from a snapshot. `--show-request` prints the request. `--show-request <turnId>` prints a journal turn's request | no | no | yes, ~0.15 USD per request |
| `replay.mjs --pair` | Two prompt layers answer the same triggers. Writes `sheet.html` (a blind sheet) and `key.json`. Score with `replay-score.mjs` | no | no | yes, 2 requests per trigger |
| `replay.mjs --diary` | Runs the diary's scheduled turn in dry run. Nothing is posted or written under `data/` | no | no | yes, 2 requests per brief |
| `replay.mjs --diary-day` | One whole day of the diary. `--draw live` draws for real on `OPENROUTER_SIM_KEY`. Nothing written under `data/` | no | no | yes, 2 requests per slot; with `--draw live` ~0.025 USD per picture |
| `replay.mjs --skills` | Puts invented requests with skills and tools, runs the step engine. A write or paid call is answered canned; reading tools run for real. Nothing written under `data/` | no | no | yes, ~3 requests per decision |
| `replay.mjs --skills --core-tools` | Same with `features.coreTools` on: no search classifier, the memory prefetch in every request | no | no | yes |
| `replay.mjs --pair-transport` | Same triggers on the native and text transports. Writes the `--pair` files | no | no | yes, ~6 requests per trigger |
| `replay.mjs --loop-triggers` | Same triggers on one side, every turn recorded. Writes `runs.jsonl` and `report.md` | no | no | yes, ~3 requests per trigger |
| `replay.mjs --inner` | One inner turn for one wake against the live data, read only, in shadow. Nothing written under `data/` | no | no | yes, up to 5 requests per sample |
| `replay-compare.mjs` | Compares an old replay run with a `--loop-triggers` run on a blind sheet. Writes `sheet.html`, `key.json`, `metrics.md` | no | no | no |
| `replay-score.mjs` | Tallies the owner's scores of a pair sheet. `--search` tallies a search comparison's blind sheet | no | no | no |
| `inner-week.mjs` | Plays virtual weeks of the inner life with a fake clock and stub voice. Reads nothing under `data/`. `--live --days` runs selected days with the real voice in shadow | no | no | stub: no; `--live` days: yes, up to 4 requests per inner turn |
| `recall-eval.mjs` | Measures recall against questions with known answers. Reports hit@1, hit@5, latency, cost. `sample` writes `data/recall-eval/candidates.json` | `data/recall-eval/` only | no | yes, up to 2 requests per question (3 with `--web`) |
| `search-policy-eval.mjs` | Measures the search classifier against a labelled sheet. Writes `results.jsonl` and `summary.md` (not under `data/`) | no | no | yes, 1 request per row |
| `search-compare.mjs` | Runs the same queries through multiple search engines. Writes results, a blind sheet and a key (not under `data/`) | no | no | yes, 1 summary per query per engine |
| `vision-compare.mjs` | Describes the same media with each model. `--from-cache` reads from the guild's media cache via Discord REST. Writes one HTML page | `data/vision-compare/` only | no | yes, 1 request per item and model |
| `memory-db.mjs` | The memory database: `stats`, `hash`, `reproject`, `rebuild`, `backup`, `restore`, `restore-test`, `media-check`, `index-policy`. Opens the database read-only | no | no | no |
| `board-import.mjs` | Imports a ledger's development history onto the task board of a stopped core. `--dry-run` opens the database read-only and only counts. See [The task board](../docs/board.md) | the `board_*` tables of `memory.db` | yes | no |
| `memory-session.mjs` | Runs her memory session once, on a copy, in shadow. Says what she proposed | no | no | yes |

Pure helpers live in `tools/lib/` and are tested by `tests/tools-*.test.js`.

## A typical measurement

1. `/nep memory snapshot` in Discord; note the path.
2. Let the bot run for a day with the change under test.
3. `node tools/journal-report.mjs --since <day>` for the day's numbers.
4. `node tools/replay.mjs --pair prompts.local <candidate-dir> --triggers triggers.txt --out /tmp/pair-1` to read the estimate, then again with `--spend <usd>`.
5. Score `sheet.html` in a browser, save as `scores.json`, then `node tools/replay-score.mjs /tmp/pair-1/sheet.html /tmp/pair-1/key.json scores.json`.
