# tools/

Scripts for measuring what the bot does and for jobs that run on `data/` itself. They run on the server from the bot's checkout, next to the running service.

## How to run

Run as the service user, from the checkout:

```
cd /opt/neptunia/app && sudo -u neptunia-bot node tools/<tool>.mjs ...
```

The tools find files as the bot does: `NEPTUNIA_PRIVATE_DIR` for `.env`, `config.local.json` and `prompts.local/`, `NEPTUNIA_DATA_DIR` for `data/` (both default to the checkout). `--data <dir>` overrides the data path.

Every tool that sends model requests uses `OPENROUTER_SIM_KEY` from `.env`; without it the tool stops with an error and never spends the bot's key.

## Rules

- **Read-only on `data/`.** No tool writes under `data/guilds/`. A tool that needs to change memory works on a copy made by `/nep memory snapshot`. `recall-eval.mjs` writes under `data/recall-eval/` only. `vision-compare.mjs` writes under `data/vision-compare/` only.
- **Side effects off.** Nothing is posted to Discord. Discord is read over REST without a gateway session. The engine's daily counters are private copies. Requests are marked with the tool's own `origin` and never count against `llm.maxRequestsPerDay`.
- **Spending needs a word.** A tool that sends model requests prints an estimate and refuses with exit code 2 unless `--spend <usd>` covers it.
- **Output.** Reports go to stdout, logs and estimates to stderr. Reports that quote memory or chat are for the owner's eyes on the server: never paste them into an issue, a commit or a chat.

## The tools

| Tool | What it does | Writes under `data/` | Needs bot stopped | Spends model credit |
|---|---|---|---|---|
| `labels-catalogue.mjs` | Compares the code catalogue (`src/skills/codes.js`) with `prompts/labels.json` and the reason-codes table in `docs/prompt-contract.md`. `--check` is a CI step (`npm run check:codes`); `--write` regenerates the table | no | no | no |
| `journal-report.mjs` | Reads the journal day files and prints one markdown section per day: turns by outcome, actions, prompt tokens, cached share, items dropped, limits, message count, file size | no | no | no |
| `type-baseline.mjs` | Runs `tsc --noEmit` and compares the error counts per file and code with `type-baseline.json`. A growing count fails, and so does a shrinking one until `--update` records it. `npm run typecheck` and `npm run typecheck:update` call it | no | no | no |
| `code-health.mjs` | Parses the tracked `.js`, `.mjs` and `.ts` files and compares file length, function length, nesting and complexity, and the manifest `structure.json` (unmatched files, import rules, required tests), with `code-health-baseline.json`. A worse value fails, and so does a better one until `--update` records it. `--docs` writes `docs/structure.md`. `npm run health` and `npm run health:update` call it | no | no | no |
| `eslint-test-rules.mjs` | The ESLint plugin `tests` that `eslint.config.js` applies to `tests/**`: `assertion-in-test`, `no-presence-assertion` and `no-wide-deep-equal`. `npm run lint` runs it, nothing calls it directly | no | no | no |
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
| `memory-session.mjs` | Runs her memory session once, on a copy, in shadow. Says what she proposed | no | no | yes |

Pure helpers live in `tools/lib/` and are tested by `tests/tools-*.test.js`.

## A typical measurement

1. `/nep memory snapshot` in Discord; note the path.
2. Let the bot run for a day with the change under test.
3. `node tools/journal-report.mjs --since <day>` for the day's numbers.
4. `node tools/replay.mjs --pair prompts.local <candidate-dir> --triggers triggers.txt --out /tmp/pair-1` to read the estimate, then again with `--spend <usd>`.
5. Score `sheet.html` in a browser, save as `scores.json`, then `node tools/replay-score.mjs /tmp/pair-1/sheet.html /tmp/pair-1/key.json scores.json`.
