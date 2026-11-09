# scripts/

Scripts for measuring what the bot does and for jobs that run on `data/` itself. They run on the server from the bot's checkout, next to the running service.

## How to run

Run as the service user, from the checkout:

```
cd /opt/neptunia/app && sudo -u neptunia-bot node scripts/<tool>.ts ...
```

The scripts find files as the bot does: `NEPTUNIA_DATA_DIR` names the persona folder, `data/` in the checkout by default. `--data <dir>` overrides the data path.

Every script that sends model requests spends the simulation's key, read from `keys.json` in the persona folder (`simulation enable --key <name>` in the chat names it). While the simulation is off the script stops with one line and never spends a core key.

## Rules

- **Read-only on `data/`.** No script writes under `data/guilds/`. A script that needs to change memory works on a copy made by `/nep memory snapshot`. `recall-eval.ts` writes under `data/recall-eval/` only. `vision-compare.ts` writes under `data/vision-compare/` only.
- **Side effects off.** Nothing is posted to Discord. Discord is read over REST without a gateway session. The engine's daily counters are private copies. Requests are marked with the tool's own `origin` and never count against `llm.maxRequestsPerDay`.
- **Spending needs a word.** A script that sends model requests prints an estimate and refuses with exit code 2 unless `--spend <usd>` covers it.
- **Output.** Reports go to stdout, logs and estimates to stderr. Reports that quote memory or chat are for the owner's eyes on the server: never paste them into an issue, a commit or a chat.

## The scripts

| Script | What it does | Writes under `data/` | Needs bot stopped | Spends model credit |
|---|---|---|---|---|
| `labels-catalogue.ts` | Compares the code catalogue (`src/tools/codes.ts`) with `config/labels.json` and the reason-codes table in `docs/prompt-contract.md`. `--check` is a CI step (`npm run check:codes`); `--write` regenerates the table | no | no | no |
| `config-migrate.ts` | Writes the config keys that moved when the skills became tools (`skills.*`, `features.skills`, `features.skillsDiscovery`, the grant on `skills.describe`) into the private settings file (`config.local/config.json`, or `config.local.json` of a layer not yet moved), or into the file of `--file`. `--dry-run` prints each move, `--apply` writes. The engine applies the same moves on load, so the file works unmigrated and logs one warning. After the moves it takes out the keys of the config cut (`src/config/cut.ts`), prints each live value that differs from the constant that replaced it, and `--apply` writes the Discord package's keys into `config.local/interfaces/discord.json` | no (writes the config file) | no | no |
| `config-doc.ts` | Prints `docs/configuration.md` from the settings schema (`src/config/schema.ts`) and the prose of `scripts/config-doc.template.md`: `node scripts/config-doc.ts > docs/configuration.md`. `tests/config-doc.test.ts` fails while the committed file differs | no | no | no |
| `cache-report.ts` | Reads `model_requests` of `<data>/memory.db` read-only for `--from` to `--to` (UTC days) and prints her prompt tokens, cached tokens, the share of turns whose first request read nothing from the cache and the median gap between turns of one place | no | no | no |
| `replay.ts` | Answers one real message again with the current code, prompts and memory. `--split` and `--recall` replay the splitter and the server search. `--snapshot <dir>` reads memory from a snapshot. `--show-request` prints the request. `--show-request <turnId>` prints a journal turn's request | no | no | yes, ~0.15 USD per request |
| `replay.ts --pair` | Two prompt layers answer the same triggers. Writes `sheet.html` (a blind sheet) and `key.json`. Score with `replay-score.ts` | no | no | yes, 2 requests per trigger |
| `replay.ts --selfreflection` | Runs the selfreflection's scheduled turn in dry run. Nothing is posted or written under `data/` | no | no | yes, 2 requests per brief |
| `replay.ts --selfreflection-day` | One whole day of the selfreflection. `--draw live` draws for real on the simulation's key. Nothing written under `data/` | no | no | yes, 2 requests per slot; with `--draw live` ~0.025 USD per picture |
| `replay.ts --skills` | Puts invented requests with skills and tools, runs the step engine. A write or paid call is answered canned; reading tools run for real. Nothing written under `data/` | no | no | yes, ~3 requests per decision |
| `replay.ts --pair-transport` | Same triggers on the native and text transports. Writes the `--pair` files | no | no | yes, ~6 requests per trigger |
| `replay.ts --loop-triggers` | Same triggers on one side, every turn recorded. Writes `runs.jsonl` and `report.md` | no | no | yes, ~3 requests per trigger |
| `replay.ts --inner` | One inner turn for one wake against the live data, read only, in shadow. Nothing written under `data/` | no | no | yes, up to 5 requests per sample |
| `replay-compare.ts` | Compares an old replay run with a `--loop-triggers` run on a blind sheet. Writes `sheet.html`, `key.json`, `metrics.md` | no | no | no |
| `replay-score.ts` | Tallies the owner's scores of a pair sheet. `--search` tallies a search comparison's blind sheet | no | no | no |
| `inner-week.ts` | Plays virtual weeks of the inner life with a fake clock and stub voice. Reads nothing under `data/`. `--live --days` runs selected days with the real voice in shadow | no | no | stub: no; `--live` days: yes, up to 4 requests per inner turn |
| `fault-run.ts` | Counts every side effect of the real core over a scripted model and the fake interface (repeated events, a raced edit and delete, a call cut off by its timeout, a core stopped mid-turn) and of the simulated weeks of `inner-week.ts`, each under its effect key. Exits 1 when a key repeats or an expected effect did not happen once. `--short` is the plan of `tests/fault-run.test.ts`. See [Tests](../docs/getting-started.md#the-second-instance-and-the-fault-run) | no | no | no |
| `recall-eval.ts` | Measures recall against questions with known answers. Reports hit@1, hit@5, latency, cost. `sample` writes `data/recall-eval/candidates.json` | `data/recall-eval/` only | no | yes, up to 2 requests per question (3 with `--web`) |
| `search-policy-eval.ts` | Measures the search classifier against a labelled sheet. Writes `results.jsonl` and `summary.md` (not under `data/`) | no | no | yes, 1 request per row |
| `search-compare.ts` | Runs the same queries through multiple search engines. Writes results, a blind sheet and a key (not under `data/`) | no | no | yes, 1 summary per query per engine |
| `graph-retrieval-bench.ts` | Builds identical synthetic graphs in temporary databases (`--sizes`, `--shapes` uniform, zipf, star) and reads them with source-only recall and with graph-enabled retrieval, idle and under a concurrent ingest. Prints p50 and p95 latency, peak RSS, WAL size, pages stopped on a bound, write latency and the query plans | no (temporary folder only) | no | no |
| `vision-compare.ts` | Describes the same media with each model. `--from-cache` reads from the guild's media cache via Discord REST. Writes one HTML page | `data/vision-compare/` only | no | yes, 1 request per item and model |
| `memory-db.ts` | The memory database: `stats`, `hash`, `reproject`, `rebuild`, `media-check`, `index-policy`, `restore-tables`, `board`. Opens the database read-only | no | no | no |
| `memory-repair-dm-vectors.ts` | Rebuilds the months of the meaning index that disagree with their manifest: a DM's rows go back to their own place and audience, a repeated record is retired, the manifest is counted again. A dry run unless `--apply`, which needs a stopped core. `--dm-only` leaves group months alone. Prints counts | `vectors` and `operational` rows of `memory.db`, with `--apply` | yes, with `--apply` | no |
| `memory-session.ts` | Runs her memory session once, on a copy, in shadow. Says what she proposed | no | no | yes |

Pure helpers live in `scripts/lib/` and are tested by `tests/tools-*.test.js`.

## A typical measurement

1. `/nep memory snapshot` in Discord; note the path.
2. Let the bot run for a day with the change under test.
3. `node scripts/cache-report.ts --from <day> --to <day>` for the day's cache numbers.
4. `node scripts/replay.ts --pair data/prompts <candidate-dir> --triggers triggers.txt --out /tmp/pair-1` to read the estimate, then again with `--spend <usd>`.
5. Score `sheet.html` in a browser, save as `scores.json`, then `node scripts/replay-score.ts /tmp/pair-1/sheet.html /tmp/pair-1/key.json scores.json`.
