# Errand agents

The engine can hand a task off to a separate **errand agent**: a standalone process that does one job (read the web, or read this server) and reports back. Each agent is an [OpenCode](https://opencode.ai) worker driven by the runner code in `src/agent-runner/`; it never imports the bot and runs on the agents' own OpenRouter key, never the persona's. Two profiles ship:

| Profile | Does | Reaches | Tools |
|---|---|---|---|
| `web` | internet errands (search, read pages, look at images, download a file) | the public internet, through a proxy; its own output folder | OpenCode `websearch`, `webfetch`, `read`, and a `bash` limited to `curl`/`wget`/`ffmpeg`/`ffprobe`/`file`/`ls`/`mkdir` for downloads |
| `server` | read-only questions about this machine | the local filesystem (read-only); network only to the model API | OpenCode `read`, `grep`, `glob`, `list`, and a `bash` limited to read-only commands (`ls`, `cat`, `head`, `tail`, `grep`, `find`, `ps`, `systemctl status`, `journalctl`, `df`, `du`, `stat`, `git log`, ...) |

Both run one task at a time; further requests queue. Each task has per-task caps (`agents.<profile>.limits`: model steps, estimated USD, wall-clock seconds) and the engine applies per-day caps (`agents.<profile>.daily`). The USD cap is a **soft** cap on OpenCode's own cost estimate; the hard spend cap is the credit limit on the runner's OpenRouter key.

## The two services

Each profile runs as its own systemd service and Unix user (`deploy/neptunia-agent-web.service`, `deploy/neptunia-agent-server.service`; install instructions are in the unit headers):

- **web** (`neptunia-agent-web`): has network, egress to localhost and private ranges refused by the unit (`IPAddressDeny=`) and in code; the filesystem is read-only except its state dir (`ProtectSystem=strict`, `ProtectHome=yes`, `InaccessiblePaths=` for `/srv`, the bot's data and `.env`, `/var/www`, nginx and Let's Encrypt).
- **server** (`neptunia-agent-server`): network only to the local resolver and the model API (`IPAddressDeny=any` plus `IPAddressAllow=` for Cloudflare's ranges, where OpenRouter lives; the shell's `find -exec`, `awk` network paths and `gawk` are denied on top of the allow-list); the whole system is read-only (`ProtectSystem=strict`, no write paths but its state dir). It is granted `CAP_DAC_READ_SEARCH` so it can read any file like root without being root. The read-only guarantee is the unit, not a command filter.

Both are launched by `bin/agent-runner.mjs --profile <name>`, read their caps, model price and socket from `agents.<profile>` in the config and their model from the model roles `agent.web` and `agent.server` (set with `/nep model set`, read again at each task; a `run` may carry its own `model`). Settings are in [Configuration: `agents`](configuration.md#agents).

Every key lives in the core, in the bot's `.env`, which the runners (unprivileged, with the file made inaccessible to them) cannot read: the core sends the keys with each task, in the `secrets` of the `run` message. The OpenRouter key is the one of the task's model role, resolved as the bot resolves any role's key (`llm.keyByRole`: `agent.web` and `agent.server` on `OPENROUTER_AGENT_KEY`; never the persona's main key: without that variable no secrets are sent). The `web` agent also gets the proxy, `MEDIA_VIDEO_PROXY` (the residential proxy serves the video fetches and this agent alike; a `socks5h://` URL is sent as the `http://` URL with the same host and port, which the proxy also serves), and `OPENCODE_WEBSEARCH_KEY` when set. The runner gives the OpenCode child the key as `OPENROUTER_API_KEY`, the proxy as `HTTPS_PROXY` / `HTTP_PROXY` (and their lowercase forms, the ones curl reads) and the search key to the search provider. The unit's `EnvironmentFile` (`/etc/neptunia/agent-<profile>.env`, root-owned, 0600) is optional: its `OPENROUTER_AGENT_KEY`, `OPENCODE_WEBSEARCH_KEY` and `PROXY_URL` are used only for what a task does not bring; a task with no key from either fails `no-key`, with one warning per runner. No secret is ever logged, journaled or sent back in an event. The owner's `/nep status` card shows the agents' key as the `agents` key and the coding worker's `OPENROUTER_DEV_KEY` (role `agent.dev`) as the `development` key; the bot never sends a request of its own with either. A fourth agent role, `agent.advice`, names the model of the consultation tools outside the bot (a bare OpenRouter id, on the simulator's `OPENROUTER_SIM_KEY`); no errand agent and no request of the bot uses it.

## The protocol

The core connects to the runner's Unix socket (`agents.<profile>.socket`, group `neptunia-discord-interface`, mode 0660) and exchanges JSON, one object per line (`src/agent-runner/protocol.js`).

Core to runner:

- `{ "op": "run", "id", "goal", "context": { "scope", "channel", "asker", ... }, "limits": { "steps", "usd", "seconds" }, "tools": [...], "model"?, "cost"?, "searchProvider"?, "secrets"?: { "openrouterKey", "proxy"?, "searchKey"? } }` (`secrets`: non-empty strings, no other key; a refused `run` is answered with its error code alone, never a value)
- `{ "op": "cancel", "id" }`
- `{ "op": "ping", "ids": [...] }`

Runner to core:

- `{ "id", "event": "progress", "step", "tool", "note" }` as the task works;
- one `{ "id", "event": "end", "status": "done" | "failed" | "cancelled", "result": { "text", "sources": [url...], "files": [{ "path", "name", "contentType", "bytes" }], "withheld"?: [path...] }, "usage": { "input", "output", "usd", "steps", "seconds", "costUnknown"? }, "error"? }` (`withheld`: the withheld paths the agent was refused in a filtered scope, at most 50);
- `{ "event": "pong", "profile", "busy", "queued" }` for a `ping`.

A runner that restarted answers `end` with `status: "failed", error: "restarted"` for any id in a `ping` it no longer knows, so the core stops waiting. On `SIGTERM` the runner ends every open task the same way and exits. Output files land in `<out>/<id>/` and the core deletes them after `agents.keepFilesHours`.

## Scope and redaction

A `run` carries `context.scope`, one of `core`, `dm`, `group` (`src/agent-runner/policy.js`). In `core` nothing is withheld. In `dm` and `group`:

- the `server` agent's file tools deny the content of sensitive paths (`/var/www`, `/srv/git`, any `.git`/`.local.git`, `.secrets`, `.env`, `.ssh`, `/etc/shadow`, nginx htpasswd, Let's Encrypt, `/etc/neptunia`, `/srv/neptunia-backups`, `config.local.json`, the persona's own `data/` (memory about real people) and any `.agents/scratch`), and its `bash` denies the content commands (`cat`, `head`, `tail`, `grep`, `egrep`, `fgrep`, `sed`, `awk`, `cut`, `sort`, `uniq`, `wc`, `file`, `git`) on any argument naming one of them; listing names (`ls`, `find`, `stat`, `du`, `readlink`, `realpath`) is still allowed. The refusal is per step: OpenCode refuses that one tool call, the agent gets the refusal and goes on with the task (visible by name, not readable in this scope), and the result's `withheld` lists the paths it was refused;
- every result the runner returns passes a redaction pass that replaces key-, token- and password-looking strings, private-key blocks, SSH key material and URL credentials with `[redacted]`.

A command that reaches a withheld path past those rules (a `bash -c`, a pipe into a reader) is caught after the fact: its output is not kept by the runner (its progress event says `withheld` and the path), the path joins the result's `withheld`, and the task goes on; the agent has seen that output, so the final text passing the redaction is what keeps a secret in it out of the answer.

## How a task runs

One task is one `opencode run` child process in a fresh working directory under the profile's out dir, with project/`.claude` config, auto-update and the price-catalog fetch disabled so nothing of this server leaks into the worker. The engine builds the OpenCode config (the agent's prompt from `prompts/agent-<profile>.md`, the step cap, the permission ruleset for the scope, the model and its cost) and passes it through `OPENCODE_CONFIG_CONTENT`. The child prints a JSON event stream; the runner sums the per-step cost and tokens, forwards progress, takes the final assistant text as the result, lists the files the agent saved, and stops the child when a cap is passed. Built against OpenCode v1.19.3.

## The persona's side

The core (`src/errands/`) keeps the persona's tasks per server in `data/guilds/<id>/tasks.json` (the open ones and the latest finished) and `tasks.jsonl` (one line per transition), and journals every transition as one `task` operation (counts only, never the goal or the result). A task is `queued`, `running`, then `done`, `failed` or `cancelled`.

- **Operations** (also her skills, closed until granted to her; see [Commands](owner-commands.md#member-commands)): `task.run` (`agent`, `goal`; paid), `task.status` (`id` optional), `task.cancel` (`id`), `task.list`. Any member may ask for `web`; only an owner may ask for `server`, through her or not. `task.run` answers at once with the id and `queued`, and the task runs in the background with the limits of `agents.<profile>.limits`. A task asked in a private chat runs in the `dm` scope, any other in `group`. The caps are `agents.maxOpen` open tasks and `agents.<profile>.daily` per UTC day.
- **`<tasks>`**: in the tail of every request while she has an open task or a finished one she has not seen, one line each (id, agent, state, age in minutes, the goal cut to 120 characters). A private chat's tasks show only in that chat. A finished task counts as seen after a turn of hers showed it.
- **`<task_result>`**: when a task ends, she gets her own turn in the conversation it was asked in, replying to the message that asked (an interjection when there is none), through the same one attention as every turn and `agents.resultCooldownSeconds` between two such turns in one conversation. The block carries the id, agent, goal and state, the result text cut to `agents.resultMaxChars`, the sources as a numbered list and each file as a handle. She may answer or stay silent; the task is then seen. A cancelled task opens no turn; a task a restart of the core left open fails with `restarted`.
- **File handles**: `file:<task id>/<name>` names a file a task saved. `message.create` takes it as its `file` attribute and attaches the file from `<agents.<profile>.out>/<task id>/<name>`. A handle that names no file of her tasks (or a private chat's file outside that chat) is refused `unknown-file`; a file larger than the interface takes is refused `attachment-too-large`.
