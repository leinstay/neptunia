# Errand agents

The engine can hand a task off to a separate **errand agent**: a standalone process that does one job (read the web, or read this server) and reports back. Each agent is an [OpenCode](https://opencode.ai) worker driven by the runner code in `src/agent-runner/`; it never imports the bot and holds its own OpenRouter key, never the persona's. Two profiles ship:

| Profile | Does | Reaches | Tools |
|---|---|---|---|
| `web` | internet errands (search, read pages, look at images, download a file) | the public internet, through a proxy; its own output folder | OpenCode `websearch`, `webfetch`, `read`, and a `bash` limited to `curl`/`wget`/`ffmpeg`/`ffprobe`/`file`/`ls`/`mkdir` for downloads |
| `server` | read-only questions about this machine | the local filesystem (read-only), no network | OpenCode `read`, `grep`, `glob`, `list`, and a `bash` limited to read-only commands (`ls`, `cat`, `head`, `tail`, `grep`, `find`, `ps`, `systemctl status`, `journalctl`, `df`, `du`, `stat`, `git log`, ...) |

Both run one task at a time; further requests queue. Each task has per-task caps (`agents.<profile>.limits`: model steps, estimated USD, wall-clock seconds) and the engine applies per-day caps (`agents.<profile>.daily`). The USD cap is a **soft** cap on OpenCode's own cost estimate; the hard spend cap is the credit limit on the runner's OpenRouter key.

## The two services

Each profile runs as its own systemd service and Unix user (`deploy/neptunia-agent-web.service`, `deploy/neptunia-agent-server.service`; install instructions are in the unit headers):

- **web** (`neptunia-agent-web`): has network, egress to localhost and private ranges refused by the unit (`IPAddressDeny=`) and in code; the filesystem is read-only except its state dir (`ProtectSystem=strict`, `ProtectHome=yes`, `InaccessiblePaths=` for `/srv`, the bot's data and `.env`, `/var/www`, nginx and Let's Encrypt).
- **server** (`neptunia-agent-server`): no network (`PrivateNetwork=yes`); the whole system is read-only (`ProtectSystem=strict`, no write paths but its state dir). It is granted `CAP_DAC_READ_SEARCH` so it can read any file like root without being root. The read-only guarantee is the unit, not a command filter.

Both are launched by `bin/agent-runner.mjs --profile <name>`, read their caps, model and socket from `agents.<profile>` in the config, and take their keys from the unit's `EnvironmentFile` (`/etc/neptunia/agent-<profile>.env`, root-owned, 0600): `OPENROUTER_AGENT_KEY` for both, plus `OPENCODE_WEBSEARCH_KEY` and `PROXY_URL` for `web`. Settings are in [Configuration: `agents`](configuration.md#agents).

## The protocol

The core connects to the runner's Unix socket (`agents.<profile>.socket`, group `neptunia-discord-interface`, mode 0660) and exchanges JSON, one object per line (`src/agent-runner/protocol.js`).

Core to runner:

- `{ "op": "run", "id", "goal", "context": { "scope", "channel", "asker", ... }, "limits": { "steps", "usd", "seconds" }, "tools": [...], "model"?, "cost"?, "searchProvider"? }`
- `{ "op": "cancel", "id" }`
- `{ "op": "ping", "ids": [...] }`

Runner to core:

- `{ "id", "event": "progress", "step", "tool", "note" }` as the task works;
- one `{ "id", "event": "end", "status": "done" | "failed" | "cancelled", "result": { "text", "sources": [url...], "files": [{ "path", "name", "contentType", "bytes" }] }, "usage": { "input", "output", "usd", "steps", "seconds", "costUnknown"? }, "error"? }`;
- `{ "event": "pong", "profile", "busy", "queued" }` for a `ping`.

A runner that restarted answers `end` with `status: "failed", error: "restarted"` for any id in a `ping` it no longer knows, so the core stops waiting. On `SIGTERM` the runner ends every open task the same way and exits. Output files land in `<out>/<id>/` and the core deletes them after `agents.keepFilesHours`.

## Scope and redaction

A `run` carries `context.scope`, one of `core`, `dm`, `group` (`src/agent-runner/policy.js`). In `core` nothing is withheld. In `dm` and `group`:

- the `server` agent's file tools deny the content of sensitive paths (`/var/www`, `/srv/git`, any `.git`/`.local.git`, `.secrets`, `.env`, `.ssh`, `/etc/shadow`, nginx htpasswd, Let's Encrypt, `/etc/neptunia`, `/srv/neptunia-backups`, `config.local.json`); listing names is still allowed. A task whose command would open such a path is stopped and ends `failed`, `error: "withheld-path"` (visible by name, not readable in this scope);
- every result the runner returns passes a redaction pass that replaces key-, token- and password-looking strings, private-key blocks, SSH key material and URL credentials with `[redacted]`.

A command that reads a withheld path through `bash` (rather than a file tool) is caught after the fact and the task fails; its output is redacted either way.

## How a task runs

One task is one `opencode run` child process in a fresh working directory under the profile's out dir, with project/`.claude` config, auto-update and the price-catalog fetch disabled so nothing of this server leaks into the worker. The engine builds the OpenCode config (the agent's prompt from `prompts/agent-<profile>.md`, the step cap, the permission ruleset for the scope, the model and its cost) and passes it through `OPENCODE_CONFIG_CONTENT`. The child prints a JSON event stream; the runner sums the per-step cost and tokens, forwards progress, takes the final assistant text as the result, lists the files the agent saved, and stops the child when a cap is passed. Built against OpenCode v1.19.3.
