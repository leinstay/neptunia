# scripts/

Scripts for measuring what the bot does and for jobs that run on `data/` itself. They run on the server from the bot's checkout, next to the running service.

## How to run

Run as the service user, from the checkout:

```
cd /opt/neptunia/app && sudo -u neptunia-bot node scripts/<tool>.ts ...
```

The scripts find files as the bot does: `NEPTUNIA_DATA_DIR` names the persona folder, `data/` in the checkout by default. `--data <dir>` overrides the data path.

Every script that sends model requests runs on the setup production runs on: the keys of `keys.json` under the chains of routes of `config/config.json` (`models.routes`), through the builders the core uses (`scripts/lib/script-routes.ts`). At start it prints one line per role it spends, with the key name or the harness and the model, never a key value.

A flag `--<role> <route>` replaces one role for that run alone and writes nothing to any file. The roles are `core`, `memory`, `analyzer`, `vision`, `video`, `speech`, `drawing`, `embedding` and `search`. A route is `<key>/<model>[:<effort>]`, a key name of `keys.json`, a model id and an optional effort, as in `--core helpers/anthropic/claude-opus-5.5:medium`. `harness:<claude|codex>/<model>[:<effort>]` sends `core` or `memory` through a connected harness, as in `--core harness:claude/claude-opus-4-8:low`. An unknown key name, a harness that is not logged in or a malformed route stops the script with one line and a code (`key-unknown`, `harness-not-connected`, `route-malformed`, `route-unsupported`) before any request goes out. `replay.ts` takes `--variant "<flags>"` any number of times in every mode but the stored turn: the same inputs run on each variant in one run, and the output shows the answers side by side per input.

## Rules

- **Read-only on `data/`.** No script writes under `data/guilds/`. A script that needs to change memory works on a copy of the memory database taken from a backup of `data/`.
- **Side effects off.** Nothing is posted to Discord. Discord is read over REST without a gateway session. The engine's daily counters are private copies. Requests are marked with the tool's own `origin` and never count against `llm.maxRequestsPerDay`.
- **Spending needs a word.** A script that sends model requests prints an estimate and refuses with exit code 2 unless `--spend <usd>` covers it.
- **Output.** Reports go to stdout, logs and estimates to stderr. Reports that quote memory or chat are for the owner's eyes on the server: never paste them into an issue, a commit or a chat.

## The scripts

| Script | What it does | Writes under `data/` | Needs bot stopped | Spends model credit |
|---|---|---|---|---|
| `labels-catalogue.ts` | Compares the code catalogue (`src/tools/codes.ts`) with `config/labels.json` and the reason-codes table in `docs/prompt-contract.md`. `--check` is a CI step (`npm run check:codes`); `--write` regenerates the table | no | no | no |
| `config-doc.ts` | Prints `docs/configuration.md` from the settings schema (`src/config/schema.ts`) and the prose of `scripts/config-doc.template.md`: `node scripts/config-doc.ts > docs/configuration.md`. `tests/scripts/config-doc.test.ts` fails while the committed file differs | no | no | no |
| `replay.ts` | Answers one real message again on the engine's own turn runner at the message's moment, with the current code, prompts and memory. `--answers-dir <dir>` answers every request from files, so nothing reaches a provider or a harness. `--snapshot <dir>` reads memory from a snapshot. `--show-request` prints the first request. `--show-request <turnId>` prints a journal turn's stored request, or rebuilds its first request on the turn runner | no | no | yes, up to 5 requests per sample |
| `diary-scenes.ts` | Runs the diary's scene helper on fresh seed sets and prints the scenes as JSON, `--out` as a Markdown report. `--prompts <dir>` tries a variant of `diary/scene.md`, `--director <route>` another model on a key or a harness. Nothing written under `data/` | no | no | yes, 1 request per scene |
| `replay.ts --diary-day` | One whole day of the diary. `--draw live` draws for real on the `drawing` role's key. Nothing written under `data/` | no | no | yes, 2 requests per slot; with `--draw live` ~0.025 USD per picture |
| `replay.ts --skills` | Puts invented requests to the persona on the engine's own turn runner, after a channel's real chat, with the grants each scenario names. The persona's read tools run on the data folder; every other call is kept and answered as done. A multi-step scenario's report states that their earlier lines in it carry no link to the line that triggered them, because a live turn reads that link off memory and the replay writes none. Nothing written under `data/` | no | no | yes, up to 5 requests per turn |
| `replay.ts --loop-triggers` | Answers real triggers again on the engine's own turn runner, every turn recorded. Writes `runs.jsonl` and `report.md` | no | no | yes, up to 5 requests per trigger |
| `replay.ts --inner` | One inner turn for one wake against the live data, read only, in shadow. Nothing written under `data/` | no | no | yes, up to 5 requests per sample |
| `replay.ts --data <copy> --turn <turnId>` | Runs one stored turn again with the engine's own turn runner over a copy of a data folder, every clock at the turn's start. The copy gives the settings, the prompts, the keys, the memory and the stored lines. The persona's read tools run on the copy, every other tool and every send is kept and answered as done. A diary turn runs as the diary service runs it, and `--kind <kind>` pins its post's kind without forcing it. `--compare` builds the first request only and prints, part by part, whether it equals the request the live turn archived, the planner's request too for a diary turn. Without `--compare` it writes one private report per sample under `--out`, with each step's size, time, calls and results. `--answers-dir <dir>` answers every request from files, `--answers archive` from the copy's archive, offline, and `--embed live` lets the embedding role alone reach its provider then. `--cut <turnId> --into <dir>` writes a new copy whose memory is the one of the moment the turn started | no (`--cut` writes a new folder beside the copy) | no | with `--answers-dir` or `--answers archive`: only `--embed live` embeddings, up to 5 per sample behind `--spend`; without: yes, up to 5 requests and 5 embeddings per sample |
| `replay-stand.ts` | The identity replay on an invented data folder: `run --engine <checkout> --into <dir>` runs every mode of `replay.ts` at that checkout, offline, with the clock, the random UUIDs and `Math.random` fixed and every model request answered from `scripts/fixtures/replay-stand/answers.json`. A case whose turns run at a past moment reads the memory of that moment, the copy cut with that checkout's `--cut` and passed as `--snapshot`. `compare <dir> <dir>` compares two runs case by case, every request part by part (each block, the messages after it, the tool names, each schema and the tool choice) and every report, file, stdout and exit code byte for byte, and exits 1 when a case differs. `tests/scripts/lib/stand.test.ts` checks that a run repeats itself | no | no | no |

Pure helpers live in `scripts/lib/` and are tested by `tests/tools-*.test.js`.
