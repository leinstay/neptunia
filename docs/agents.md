# Errand agents

The engine can hand a task to a separate errand agent: a standalone process that does one job (search the web, read the local filesystem) and reports back. Each agent is an [OpenCode](https://opencode.ai) worker driven by the runner code in `src/agent-runner/`. It never imports the bot and runs on its own OpenRouter key, not the persona's. Two worker profiles ship with the engine:

| Profile | What it does | What it can reach | Tools |
|---|---|---|---|
| `web` | internet errands (search, read pages, look at images, download a file) | the public internet through a proxy; its own output folder | OpenCode `websearch`, `webfetch`, `read`, and a `bash` limited to `curl`/`wget`/`yt-dlp`/`ffmpeg`/`ffprobe`/`file`/`ls`/`mkdir` for downloads (yt-dlp only as `yt-dlp --ignore-config ...`, so a `yt-dlp.conf` written into its folder is never loaded; no yt-dlp option that runs another program or names a config file: `--exec`, `--netrc-cmd`, `--config-locations`, `--plugin-dirs`) |
| `server` | read-only questions about this machine | the local filesystem (read-only); network only to the model API | OpenCode `read`, `grep`, `glob`, `list`, and a `bash` limited to read-only commands (`ls`, `cat`, `head`, `tail`, `grep`, `find`, `ps`, `systemctl status`, `journalctl`, `df`, `du`, `stat`, `git log`, ...) |

Both run one task at a time; further requests queue. Each task has per-task caps (`agents.<profile>.limits`: model steps, estimated USD, wall-clock seconds) and the engine enforces per-day caps (`agents.<profile>.daily`). The USD cap is a soft cap on OpenCode's own cost estimate; the hard spending limit is the credit limit on the runner's OpenRouter key.

## The agents folder

Each agent lives in its own folder under `agents/` at the engine root: `agents/web/` and `agents/server/` are the two workers, `agents/advice/` a consultation. A folder holds the agent's tracked prompt (`prompt.md`) and its description (`profile.json`). The runner builds its profiles from this folder when it starts (`src/agent-runner/profiles.js#loadProfiles`); the bot reads the same folder for the defaults it needs (socket, output dir, limits, daily caps). `listAgents` returns every agent, workers and consultations alike.

There are two kinds. A worker runs as its own process (`bin/agent-runner.mjs --profile <id>`) and takes tasks on a Unix socket. A consultation has no process: tools call its model role directly. The runner skips consultations.

## Profile keys

`profile.json` describes what an agent asks for; it never authorizes anything. Every key is required:

| Key | What it holds |
|---|---|
| `id` | the folder name (`web`) |
| `kind` | `worker` (runs under the agent runner on a socket) or `consultation` (a model role that tools call directly; no process, skipped by the runner) |
| `role` | the model role in `src/llm/roles.js` (`agent.web`, `agent.server`, `agent.advice`) |
| `prompt` | the prompt file inside the folder (`prompt.md`); `null` for a consultation without one |
| `override` | the name a deployment may put under `prompts.local/` to replace the prompt (`agent-web.md`); `null` when there is no prompt |
| `description` | one sentence saying what the agent does |
| `tools` | worker only: the OpenCode tools it asks for, at most the ones its shell class allows |
| `shell` | worker only: the name of a shell class the runner defines in code (`server-read-only`, `web-download`) |
| `limits` | worker only: default per-task caps `{ steps, usd, seconds }`, overridden by `agents.<id>.limits` in config |
| `daily` | worker only: default per-day caps `{ tasks, usd }`, overridden by `agents.<id>.daily` |
| `searchProvider` | worker only: the default web search provider (`exa`), or `null` |
| `socket`, `out` | worker only: the default socket path and output folder, overridden by `agents.<id>.socket` / `.out` |
| `env` | worker only: the environment variable names the runner falls back on when a task brings no key |

A profile with a missing key, an unknown key, a tool its shell class does not allow, or a shell class the runner does not know stops the runner (and the bot, which reads the same folder) at start, with one error line naming the agent and the key.

## What is never in a profile

Permissions and security stay in the code (`src/agent-runner/profiles.js`, `src/agent-runner/policy.js`), and no profile key can change them:

- the permission ceiling: which tools a shell class may grant and which shell commands it allows;
- the shell deny patterns, and the tools denied to every agent (`edit`, `write`, `patch`, `task`, `question`); `external_directory` (paths outside the agent's own folder) is denied too, except to the server agent, which gets it under the same withheld-path rules as its path tools;
- the scope filters, the withheld paths and the redaction of results;
- any command to run, and any path outside the folder (`socket` and `out` are only defaults the config overrides).

A profile can only narrow what the code allows: a tool the profile leaves out is denied. A tool its shell class does not allow, or a shell class the code does not define, is refused at start.

## The two services

Each worker runs as its own systemd service and Unix user (`deploy/neptunia-agent-web.service`, `deploy/neptunia-agent-server.service`; install instructions are in the unit headers):

- `neptunia-agent-web`: has network; egress to localhost and private ranges is refused by the unit (`IPAddressDeny=`) and in code. The filesystem is read-only except its state dir (`ProtectSystem=strict`, `ProtectHome=yes`, `InaccessiblePaths=` for `/srv`, the bot's data and `.env`, `/var/www`, nginx and Let's Encrypt).
- `neptunia-agent-server`: network only to the local resolver and the model API (`IPAddressDeny=any` plus `IPAddressAllow=` for Cloudflare's ranges, where OpenRouter lives; the shell also denies `find -exec`, `awk` network paths and `gawk` on top of the allow-list). The whole system is read-only (`ProtectSystem=strict`, no write paths but its state dir and a private `/tmp`); its one writing command, `cp`, can therefore only copy a file into its task folder, where it comes back as a result file, and in a filtered scope a withheld path is refused for `cp` as for `cat`. It has `CAP_DAC_READ_SEARCH` so it can read any file without being root. The read-only guarantee comes from the unit, not from the command filter.

Both are launched by `bin/agent-runner.mjs --profile <name>`. They read their caps, model price and socket from `agents.<profile>` in the config, and their model from the model roles `agent.web` and `agent.server` (set with `/nep model set`, read again at each task; a `run` may carry its own `model`). Settings are in [Configuration: `agents`](configuration.md#agents).

## Keys

Every key lives in the core, in the bot's `.env`, which the runners (unprivileged, with the file made inaccessible to them) cannot read. The core sends the keys with each task, in the `secrets` of the `run` message.

The OpenRouter key is the one of the task's model role, resolved the same way the bot resolves any role's key (`llm.keyByRole`): `agent.web` and `agent.server` use `OPENROUTER_AGENT_KEY`; without that variable, no secrets are sent. The bot never sends a request of its own on the agent keys. The `web` agent also gets the proxy (`MEDIA_VIDEO_PROXY`, sent as an `http://` URL the proxy also serves), and `OPENCODE_WEBSEARCH_KEY` when set. The runner passes the OpenCode child the key as `OPENROUTER_API_KEY`, the proxy as `HTTPS_PROXY` / `HTTP_PROXY` (and their lowercase forms, the ones curl reads), and the search key to the search provider.

The unit's `EnvironmentFile` (`/etc/neptunia/agent-<profile>.env`, root-owned, 0600) is optional: its `OPENROUTER_AGENT_KEY`, `OPENCODE_WEBSEARCH_KEY` and `PROXY_URL` are used only for what a task does not bring. A task with no key from either source fails `no-key`, with one warning per runner. No secret is ever logged, journaled or sent back in an event.

The owner's `/nep status` card shows the agents' key as the `agents` key and the coding worker's `OPENROUTER_DEV_KEY` (role `agent.dev`) as the `development` key. A fourth agent role, `agent.advice`, names the model of the consultation tools outside the bot (a bare OpenRouter id, on the simulator's `OPENROUTER_SIM_KEY`); no errand agent and no request of the bot uses it.

## The protocol

The core connects to the runner's Unix socket (`agents.<profile>.socket`, group `neptunia-discord-interface`, mode 0660) and exchanges JSON, one object per line (`src/agent-runner/protocol.js`).

Core to runner:

- `{ "op": "run", "id", "goal", "context": { "scope", "channel", "asker", "recent", ... }, "limits": { "steps", "usd", "seconds" }, "tools": [...], "model"?, "cost"?, "searchProvider"?, "secrets"?: { "openrouterKey", "proxy"?, "searchKey"? }, "preamble"? }` (`secrets`: non-empty strings, no other key; a refused `run` is answered with its error code alone, never a value; `preamble`: the shared preamble below, a string of at most 8000 characters after trimming, else the run is refused `bad-preamble` or `preamble-too-long`; `context.recent`: the last `agents.recentLines` lines of the channel the task was asked in, `[{ "author", "text" }]`, each string cut to 200 characters, at most 20 kept (the latest), `[]` for a task asked in a private chat; a malformed line refuses the run `bad-recent`. The runner shows the context to the agent as data, inside `<context>`)
- `{ "op": "cancel", "id" }`
- `{ "op": "ping", "ids": [...] }`

Runner to core:

- `{ "id", "event": "progress", "step", "tool", "note" }` as the task works;
- one `{ "id", "event": "end", "status": "done" | "failed" | "cancelled", "result": { "text", "sources": [url...], "files": [{ "path", "name", "contentType", "bytes" }], "withheld"?: [path...], "filesDropped"?: [{ "name", "reason" }] }, "usage": { "input", "output", "usd", "steps", "seconds", "costUnknown"? }, "error"? }` (`withheld`: the paths the agent was refused in a filtered scope, at most 50; `filesDropped`: the saved files the runner did not deliver, reason `withheld` when a filtered-scope run reached a withheld path (then no file is delivered) or `secret` when a text file of at most 2 MB carries a secret, in every scope);
- `{ "event": "pong", "profile", "busy", "queued" }` for a `ping`.

A runner that has restarted answers `end` with `status: "failed", error: "restarted"` for any id in a `ping` it no longer knows, so the core stops waiting. On `SIGTERM` the runner ends every open task the same way and exits. Output files land in `<out>/<id>/`. The runner deletes them, since the directory belongs to its own user and the core can only read it: at start and then once an hour it removes each task directory whose newest file is older than `agents.keepFilesHours` (read from its own config at each sweep, like its caps; never the directory of a task it is running or has queued), and logs one `agent-runner: swept` line with counts. A finished task whose directory is gone has its files marked expired in the core: its file handles name nothing any more, `<tasks>` and `<task_result>` show its state as expired, and `task.status` says `files-expired`.

## Scope and redaction

A `run` carries `context.scope`, one of `core`, `dm`, `group` (`src/agent-runner/policy.js`). In `core` nothing is withheld. In `dm` and `group`:

- the `server` agent's file tools deny the content of sensitive paths (`/var/www`, any `.git`/`.local.git`, `.secrets`, `.env`, `.ssh`, `/etc/shadow`, nginx htpasswd, Let's Encrypt, `/etc/neptunia`, `/srv/neptunia-backups`, `config.local.json`, the persona's own `data/` and any `.agents/scratch`), and its `bash` denies content commands (`cat`, `head`, `tail`, `grep`, `egrep`, `fgrep`, `sed`, `awk`, `cut`, `sort`, `uniq`, `wc`, `file`, `git`) on any argument naming one of those paths. Listing names (`ls`, `find`, `stat`, `du`, `readlink`, `realpath`) is still allowed. The refusal happens per step: OpenCode refuses that one tool call, the agent sees the refusal and continues, and the result's `withheld` lists the paths it was refused;
- every result the runner returns passes a redaction pass that replaces key-, token- and password-looking strings, private-key blocks, SSH key material and URL credentials with `[redacted]`.

A command that reaches a withheld path despite these rules (a `bash -c`, a pipe into a reader) is caught after the fact: the runner does not keep that output (its progress event says `withheld` and the path), the path joins the result's `withheld`, and the task continues. The agent has seen the output, so the final redaction pass is what keeps a secret out of the answer.

## How a task runs

One task is one `opencode run` child process in a fresh working directory under the profile's output dir, with project/`.claude` config, auto-update and the price-catalog fetch disabled so nothing of this server leaks into the worker. The engine builds the OpenCode config (the agent's prompt from `agents/<profile>/prompt.md`, or the deployment's `prompts.local/agent-<profile>.md` when present, the step cap, the permission ruleset for the scope, the model and its cost) and passes it through `OPENCODE_CONFIG_CONTENT`. The child prints a JSON event stream; the runner sums the per-step cost and tokens, forwards progress, takes the final assistant text as the result, lists the files the agent saved, and stops the child when a cap is hit. Built against OpenCode v1.19.3.

A deployment may give every errand agent one shared preamble: the optional file `prompts.local/agents.md` (there is no tracked default; without the file, or with an empty one, nothing changes). The core reads it through the live prompt loader, so an edit reaches the next task without a restart, and sends its text with each task as the `preamble` of the `run` message. The runner puts it first in the agent's system prompt, followed by a blank line and the agent's own prompt. The runners never read `prompts.local/` for it: the core is the only process that reads the file, so a runner whose unit keeps the private directory out of its reach still gets the preamble. The preamble is never logged; the core's `errands: sent` line carries only its length.

## The persona's side

The core (`src/errands/`) keeps the persona's tasks per server in `data/guilds/<id>/tasks.json` (the open ones and the latest finished) and `tasks.jsonl` (one line per transition), and journals every transition as one `task` operation (counts only, never the goal or the result). `/nep memory forget` removes the tasks a member asked for and their lines (a running one is cancelled at its runner first), copying them into the vault; `/nep memory wipe` deletes both files. A task is `queued`, `running`, then `done`, `failed` or `cancelled`.

- Operations (also her skills, closed until granted to her; see [Commands](owner-commands.md#member-commands)): `task.run` (`agent`, `goal`; paid), `task.status` (`id` optional), `task.cancel` (`id`), `task.list`. Any member may ask for `web`; only an owner may ask for `server`, through her or not. `task.run` answers at once with the id and `queued`, and the task runs in the background with the limits of `agents.<profile>.limits`. A task asked in a private chat runs in the `dm` scope, any other in `group`. The caps are `agents.maxOpen` open tasks and `agents.<profile>.daily` per UTC day.
- `<tasks>`: in the tail of every request while she has an open task or a finished one she has not seen, one line each (id, agent, state, age in minutes, the goal cut to 120 characters). A private chat's tasks show only in that chat. A finished task counts as seen after a turn of hers showed it.
- `<task_result>`: when a task ends, the persona gets her own turn in the conversation it was asked in, replying to the message that started it (an interjection when there is none). The turn follows the same attention as every turn and observes `agents.resultCooldownSeconds` between two such turns in one conversation. The block carries the id, agent, goal and state, the result text cut to `agents.resultMaxChars`, the sources as a numbered list, each file as a handle, and, when the runner withheld paths in a filtered scope, one line naming them (`labels.tasks.result.withheld`, `{paths}` joined by `, `; left out without the label). The persona may answer or stay silent; the task is then seen. A cancelled task opens no turn; a task a restart of the core left open fails with `restarted`.
- File handles: `file:<task id>/<name>` names a file a task saved. `message.create` takes it as its `file` attribute and attaches the file from `<agents.<profile>.out>/<task id>/<name>`. A handle that names no file of her tasks (or a private chat's file outside that chat) is refused `unknown-file`; a file larger than the interface accepts is refused `attachment-too-large`.

## The ledger mirror

Every errand is also mirrored into the ledger, the task service of the development side (`src/errands/ledger.js`), so its operators see the persona's errands next to the development tasks (`task list --lane errand`), with the same statuses, attempts and results. The core is the ledger's `core` principal. It talks to the ledger over the socket set in `agents.ledger.socket` (for example `/run/neptunia-ledger/core.sock`), exchanging one JSON object per line: `{ "id", "op", "args", "idempotency" }`, answered with `{ "id", "ok", "result" | "error" }`. While the key is `null` (the default), the mirror is off: nothing is queued and nothing connects.

What is mirrored, as a task of the `errand` lane:

- queued: `task.add` (no project; the title is the goal cut to 120 characters, the description is the goal, the requester is `persona:<user id>` of the asker, the role is the agent, the subscriber is `core:<guild id>:<channel id>`, the metadata is `{ coreId, scope, agent }`), then `task.transition` to `triaged` (setting the agent as `role`, `limits.usd` as `budget_usd`, `limits.steps` as `step_cap` and `limits.seconds` in minutes as `estimate_minutes`), then to `approved` (the ledger's machine has no `proposed -> approved`);
- started: `task.claim` (lease of `limits.seconds` plus 60 s) and `attempt.start` (principal `core`, the agent as role, the model of its role, no worktree);
- the runner's progress: `task.heartbeat`, at most once a minute;
- ended: `attempt.end` (steps, cost, outcome), `task.result` (a `summary` with the result text cut to `agents.resultMaxChars` and the withheld paths as metadata; one `file` per output file, its handle as `uri`), then `task.transition` to `done`, `failed` or `cancelled` (`close_reason` is the error code);
- cancelled in the core: the attempt ended, then `task.transition` to `cancelled` with `close_reason: cancelled-by-<owner|requester|persona|forget>`. A forget closes the member's open tasks this way before it removes them.

Every call carries the idempotency key `errand:<core id>:<op>`, so a replay or a restart never creates a second row. The ledger's id is stored on the core's task as `ledgerId` (in `tasks.json` and the later `tasks.jsonl` lines; `task.status` shows it as `ledger: <id>`).

The core's store remains the system of record: the `<tasks>` block, the result turn, the caps and the rights read only the core's store. A ledger that refuses connections or does not answer never affects an errand. Calls wait in memory (at most 200, in order) while the connection is retried with a growing backoff, and are replayed once the ledger answers. `errands: ledger unavailable` is logged at most once a minute, with codes only. A call the ledger refuses is logged with its code and dropped; the later calls of the task are still sent, and only the first refused or dropped call of a task is logged. At start, the open tasks of `tasks.json` that have no `ledgerId` are mirrored before they fail as `restarted`.

## Adding an agent

1. Create `agents/<id>/` with a `profile.json` (copy one of the existing ones) and, for a worker, a `prompt.md`.
2. If it needs a model role that does not exist yet, add it to `src/llm/roles.js`.
3. For a worker: add an `agents.<id>` block to `config.json`, a systemd unit like `deploy/neptunia-agent-web.service`, and, for the persona to reach it, its name in `TASK_AGENTS` (`src/ops/catalog.js`) and who may ask for it in `src/ops/task.js`.
4. If no existing shell class fits, that is a code change in `src/agent-runner/profiles.js`, not a profile key.
5. Run `tests/agent-runner-profiles.test.js`.
