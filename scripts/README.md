# scripts/

Scripts for measuring what the bot does and for jobs that run on `data/` itself. They run on the server from the bot's checkout, next to the running service.

## How to run

Run as the service user, from the checkout:

```
cd /opt/neptunia/app && sudo -u neptunia-bot node scripts/<tool>.ts ...
```

The scripts find files as the bot does: `NEPTUNIA_DATA_DIR` names the persona folder, `data/` in the checkout by default. `--data <dir>` overrides the data path.

Every script that sends model requests runs on the setup production runs on: the keys of `keys.json` under the chains of routes of `config/config.json` (`models.routes`), through the builders the core uses (`scripts/lib/script-routes.ts`). At start it prints one line per role it spends, with the key name or the harness and the model, never a key value.

A flag `--<role> <route>` replaces one role for that run alone and writes nothing to any file. The roles are `core`, `memory`, `analyzer`, `vision`, `video`, `speech`, `drawing`, `embedding` and `search`. A route is `<key>/<model>[:<effort>]`, a key name of `keys.json`, a model id and an optional effort, as in `--core helpers/anthropic/claude-opus-5.5:medium`. `harness:<claude|codex>/<model>[:<effort>]` sends `core` or `memory` through a connected harness, as in `--core harness:claude/claude-opus-4-8:low`. An unknown key name, a harness that is not logged in or a malformed route stops the script with one line and a code (`key-unknown`, `harness-not-connected`, `route-malformed`, `route-unsupported`) before any request goes out. `replay.ts` and `memory-session.ts` take `--variant "<flags>"` any number of times: the same inputs run on each variant in one run, and the output shows the answers side by side per input.

## Rules

- **Read-only on `data/`.** No script writes under `data/guilds/`. A script that needs to change memory works on a copy of the memory database taken from a backup of `data/`, except `stable-names-rewrite.ts --apply`, which writes the one rewrite through the memory writer after a backup. `recall-eval.ts` writes under `data/recall-eval/` only. `vision-compare.ts` writes under `data/vision-compare/` only.
- **Side effects off.** Nothing is posted to Discord. Discord is read over REST without a gateway session. The engine's daily counters are private copies. Requests are marked with the tool's own `origin` and never count against `llm.maxRequestsPerDay`.
- **Spending needs a word.** A script that sends model requests prints an estimate and refuses with exit code 2 unless `--spend <usd>` covers it.
- **Output.** Reports go to stdout, logs and estimates to stderr. Reports that quote memory or chat are for the owner's eyes on the server: never paste them into an issue, a commit or a chat.

## The scripts

| Script | What it does | Writes under `data/` | Needs bot stopped | Spends model credit |
|---|---|---|---|---|
| `labels-catalogue.ts` | Compares the code catalogue (`src/tools/codes.ts`) with `config/labels.json` and the reason-codes table in `docs/prompt-contract.md`. `--check` is a CI step (`npm run check:codes`); `--write` regenerates the table | no | no | no |
| `config-doc.ts` | Prints `docs/configuration.md` from the settings schema (`src/config/schema.ts`) and the prose of `scripts/config-doc.template.md`: `node scripts/config-doc.ts > docs/configuration.md`. `tests/config-doc.test.ts` fails while the committed file differs | no | no | no |
| `cache-report.ts` | Reads `model_requests` of `<data>/memory.db` read-only for `--from` to `--to` (UTC days) and prints her prompt tokens, cached tokens, the share of turns whose first request read nothing from the cache and the median gap between turns of one place | no | no | no |
| `replay.ts` | Answers one real message again with the current code, prompts and memory. `--answers-dir <dir>` answers every request from files, so nothing reaches a provider or a harness. `--split` and `--recall` replay the splitter and the server search. `--snapshot <dir>` reads memory from a snapshot. `--show-request` prints the request. `--show-request <turnId>` prints a journal turn's request | no | no | yes, ~0.15 USD per request |
| `replay.ts --pair` | Two prompt layers answer the same triggers. Writes `sheet.html` (a blind sheet) and `key.json`. Score with `replay-score.ts` | no | no | yes, 2 requests per trigger |
| `diary-scenes.ts` | Runs the diary's scene helper on fresh seed sets and prints the scenes as JSON, `--out` as a Markdown report. `--prompts <dir>` tries a variant of `diary-scene.md`, `--diary.scene <route>` another model on a key or a harness. Nothing written under `data/` | no | no | yes, 1 request per scene |
| `replay.ts --diary-day` | One whole day of the diary. `--draw live` draws for real on the `drawing` role's key. Nothing written under `data/` | no | no | yes, 2 requests per slot; with `--draw live` ~0.025 USD per picture |
| `replay.ts --skills` | Puts invented requests with skills and tools, runs the step engine. A write or paid call is answered canned; reading tools run for real. Nothing written under `data/` | no | no | yes, ~3 requests per decision |
| `replay.ts --pair-transport` | Same triggers on the native and text transports. Writes the `--pair` files | no | no | yes, ~6 requests per trigger |
| `replay.ts --loop-triggers` | Same triggers on one side, every turn recorded. Writes `runs.jsonl` and `report.md` | no | no | yes, ~3 requests per trigger |
| `replay.ts --inner` | One inner turn for one wake against the live data, read only, in shadow. Nothing written under `data/` | no | no | yes, up to 5 requests per sample |
| `turn-replay.ts` | Runs one stored turn again with the engine's own turn runner over a copy of a data folder, every clock at the turn's start. `--cut <turnId> --into <dir>` writes a new copy whose memory is the one of the moment the turn started. `--turn <turnId>` replays it: her read tools run on the copy, every other tool and every send is kept and answered as done. A diary turn runs as the diary service runs it, and `--kind <kind>` pins its post's kind without forcing it. `--compare` builds the first request only and prints, part by part, whether it equals the request the live turn archived. For a diary turn it compares the planner's request too, answered with the live plan. A diary report holds the planner's answer and the post's messages. Without `--compare` it writes one private report per sample under `--out`, with each step's size, time, calls and results. `--answers-dir <dir>` answers every request from files, and `--embed live` then lets the embedding role alone reach its provider | no (`--cut` writes a new folder beside the copy) | no | with `--answers-dir`: only `--embed live` embeddings; without: yes, each step |
| `replay-compare.ts` | Compares an old replay run with a `--loop-triggers` run on a blind sheet. Writes `sheet.html`, `key.json`, `metrics.md` | no | no | no |
| `replay-score.ts` | Tallies the owner's scores of a pair sheet. `--search` tallies a search comparison's blind sheet | no | no | no |
| `inner-week.ts` | Plays virtual weeks of the inner life with a fake clock and stub voice. Reads nothing under `data/`. `--live --days` runs selected days with the real voice in shadow | no | no | stub: no; `--live` days: yes, up to 4 requests per inner turn |
| `fault-run.ts` | Counts every side effect of the real core over a scripted model and the fake interface (repeated events, a raced edit and delete, a call cut off by its timeout, a core stopped mid-turn) and of the simulated weeks of `inner-week.ts`, each under its effect key. Exits 1 when a key repeats or an expected effect did not happen once. `--short` is the plan of `tests/fault-run.test.ts`. See [Tests](../docs/getting-started.md#the-second-instance-and-the-fault-run) | no | no | no |
| `recall-eval.ts` | Measures recall against questions with known answers. Reports hit@1, hit@5, latency, cost. `sample` writes `data/recall-eval/candidates.json` | `data/recall-eval/` only | no | yes, up to 2 requests per question (3 with `--web`) |
| `search-policy-eval.ts` | Measures the search classifier against a labelled sheet. Writes `results.jsonl` and `summary.md` (not under `data/`) | no | no | yes, 1 request per row |
| `search-compare.ts` | Runs the same queries through multiple search engines. Writes results, a blind sheet and a key (not under `data/`) | no | no | yes, 1 summary per query per engine |
| `graph-retrieval-bench.ts` | Builds identical synthetic graphs in temporary databases (`--sizes`, `--shapes` uniform, zipf, star) and reads them with source-only recall and with graph-enabled retrieval, idle and under a concurrent ingest. Prints p50 and p95 latency, peak RSS, WAL size, pages stopped on a bound, write latency and the query plans | no (temporary folder only) | no | no |
| `vision-compare.ts` | Describes the same media with each model. `--from-cache` reads from the guild's media cache via Discord REST. Writes one HTML page | `data/vision-compare/` only | no | yes, 1 request per item and model |
| `memory-db.ts` | The memory database: `stats`, `hash`, `reproject`, `rebuild`, `media-check`, `index-policy`, `restore-tables`. Opens the database read-only | no | no | no |
| `stable-names-rewrite.ts` | Rewrites what memory stored before stable names to `:e23:`, gives its emoji and stickers their stable names and links each line to the emoji its text names, once per deployment after a backup. `--data <dir>` is required. Without `--apply` it prints counts only: lines and tokens to rewrite, media rows to rename, names to issue per interface and kind, lines not tied, rows to change per table and what is left. `--choose <platformName>=<platformId>`, repeatable, ties a name two emoji hold to one of them. `--markup-iface <interface>` names the interface of raw markup whose id no row holds, needed only when the counts show such markup left. `--rewritten <file>` names a file of line ids, one per line, whose text an earlier run rewrote while their vectors stayed of the old text, and the script prints their count; the write evicts and touches those vectors as it does for the lines it rewrites. `--apply` writes through the memory writer. After the main plan it rewrites `model_requests` and the recall traces in batches of 200 rows, each applied at once with `--apply`, and prints the batches read and the rows to change in each of the two tables, counts only. The core's start check refuses it while an engine holds the folder | with `--apply`: `memory.db` | yes | no |
| `memory-session.ts` | Runs her memory session once, on a copy, in shadow. Says what she proposed | no | no | yes |

Pure helpers live in `scripts/lib/` and are tested by `tests/tools-*.test.js`.

## A typical measurement

1. Copy the memory database from a backup of `data/` into a folder of its own, and note the folder.
2. Let the bot run for a day with the change under test.
3. `node scripts/cache-report.ts --from <day> --to <day>` for the day's cache numbers.
4. `node scripts/replay.ts --pair data/prompts <candidate-dir> --triggers triggers.txt --out /tmp/pair-1` to read the estimate, then again with `--spend <usd>`.
5. Score `sheet.html` in a browser, save as `scores.json`, then `node scripts/replay-score.ts /tmp/pair-1/sheet.html /tmp/pair-1/key.json scores.json`.
