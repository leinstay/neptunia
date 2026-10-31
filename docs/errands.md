# Errands

The persona can hand a goal to an errand agent with `errand.run`. She writes the goal in her own words, says so in the conversation, and the turn ends. The errand runs in the background as a separate process. When it finishes, its result comes back as a turn of hers in the conversation that started it, with any files posted where she asks.

## Errand agents

Two errand agents ship with the engine. Each is a worker: a standalone [OpenCode](https://opencode.ai) process driven by the agent runner (`src/agent-runner/`), connected to the core over a Unix socket.

### scout

Internet errands: web searches, reading pages, looking at images, downloading files. Reaches the public internet through a residential proxy. Cannot touch the server's filesystem beyond its own output folder and a private `/tmp/opencode` where OpenCode saves fetched files.

The scout searches with `web-search <query> [--count N]` (`agents/scout/bin/web-search`), a wrapper that sends one OpenRouter request with the Exa web plugin. OpenCode's own `websearch` tool stays hidden.

**Shell.** The `bash` tool is limited to `web-search` for searches, `curl`/`wget`/`yt-dlp`/`ffmpeg`/`ffprobe` for downloads, and everyday text tools: `ls`, `cat`, `head`, `tail`, `grep`, `sed -n --sandbox`, `wc`, `sort`, `uniq`, `cut`, `tr`, `jq`, `file`, `stat`, `mkdir`, `pwd`, `which`, `echo`, `cp`/`mv`/`rm` (on its own folder and `/tmp/opencode` only, no recursive flag). `yt-dlp` runs only as `yt-dlp --ignore-config ...`, so a config file planted in its folder is never loaded; the options `--exec`, `--netrc-cmd`, `--config-locations` and `--plugin-dirs` are denied.

**Tools:** `websearch`, `webfetch`, `read`, `glob`, `list`, `bash`.

### server

Read-only questions about this machine: reads files and runs read-only shell commands. Network reaches only the local DNS resolver and the model API. No web access.

**Shell.** `bash` is limited to read-only commands: `ls`, `cat`, `head`, `tail`, `grep`, `rg`, `find`, `tree`, `jq`, `diff`, `sha256sum`, `ps`, `systemctl status`, `journalctl`, `df`, `du`, `stat`, `git log`/`show`/`status`/`diff` (including `git -C <path>`), `ip addr`/`route`/`link show`, `getent passwd`/`group`, `last`, `w`, `who`, `timedatectl status`, `hostnamectl status`, `tar` in list mode only, and several others. The one writing command is `cp`, which copies a file into the task folder so the agent can hand it back as a result file. The read-only guarantee comes from the systemd unit (`ProtectSystem=strict`), not from the command filter.

`sed` runs only as `sed -n --sandbox`. There is no `awk`. `rg --pre` and `sort --compress-program` are denied.

**Tools:** `read`, `grep`, `glob`, `list`, `bash`.

Drawing is not an errand. It is a built-in ability of the core, see [Media](media.md#drawings).

## How a task runs

### Enabling a worker

Both workers are disabled by default (`enabled: false` in the profile, `agents/<name>/profile.json`). A deployment enables them with `agents.<profile>.enabled: true` in `config.local/config.json` and starts their systemd services.

### Queuing

`errand.run` accepts `agent` (one of `scout`, `server`) and `goal`. The errand service (`src/errands/service.ts`) queues the task in the guild's store, a task of the board's errand lane in `memory.db` (see [Where errands are kept](#where-errands-are-kept)), and answers at once with the id and `queued`. Nobody waits for the errand.

An idempotency key ties the task to the turn and the call's index within it: the same call made twice returns the task already queued, never a second errand.

Caps enforced at queuing:
- `errands.maxOpen` (default 3): open tasks across all agents.
- `daily.tasks` of the profile (default 40 for scout and server, overridable under `agents.<profile>.daily.tasks`): tasks per UTC day per agent. A task counts on the day it was queued.

### The runner

Each worker runs as a systemd service under its own Unix user (`deploy/neptunia-agent-scout.service`, `deploy/neptunia-agent-server.service`), which starts `neptunia errand-runner --profile <name>` (see [The neptunia command](cli.md#the-errand-runner)). The runner listens on a Unix socket (the profile's `socket`, overridable under `agents.<profile>.socket`); the core connects and sends tasks as JSON, one object per line.

One task is one `opencode run` child process in a fresh working directory under the profile's output folder. The runner builds an OpenCode config from the profile (the prompt, the step cap, the permission map for the scope) and passes it through `OPENCODE_CONFIG_CONTENT`. Auto-update and the price-catalog fetch are disabled, so nothing of the server leaks into the worker. Built against OpenCode v1.19.3.

A runner works one task at a time. Further requests queue.

Per-task limits (the profile's `limits`, overridable under `agents.<profile>.limits`):

| Agent | Default steps | Default seconds |
|---|---|---|
| `scout` | 25 | 300 |
| `server` | 20 | 120 |

### Keys

Every key lives in the core's `.env`. The runners (unprivileged, with `.env` made inaccessible to them) cannot read it. The core sends the keys with each task in the `secrets` of the `run` message.

The OpenRouter key is the one of the task's model role, resolved the same way the bot resolves any role's key (`llm.keyByRole`): both `scout` and `server` use `OPENROUTER_ERRAND_KEY`. Without that variable, no secrets are sent. The `scout` agent also gets `MEDIA_VIDEO_PROXY` (as an `http://` URL) and `OPENCODE_WEBSEARCH_KEY` when set.

The systemd unit has an optional `EnvironmentFile` whose keys are used only for what a task does not bring. No secret is ever logged, journaled or sent back in an event.

### Preambles

A deployment can give its errand agents a per-model preamble from the optional folder `prompts.local/preambles/` (no tracked defaults). Each run's preamble is the matching files joined by a blank line, in this order:

| File | Read for |
|---|---|
| `all.md` | every run |
| `<agent>.md` | the runs of that agent |
| `@<model>.md` | the runs on that model |
| `<agent>@<model>.md` | the runs of that agent on that model |

`<model>` is the run's model id lowercased, with every character outside `[a-z0-9.]` replaced by `-`. An id with an `openrouter/` prefix also matches without it. An empty file is skipped. The composed text is capped at 8000 characters; files that fit are included whole and in order. The preamble reloads live: an edit, a new file, or a removal reaches the next task without a restart.

## Sandbox users and the policy

### Scope

A task asked in a private chat runs in `dm` scope. A task asked anywhere else runs in `group` scope. In a `core` scope (the owner's console) nothing is withheld. In `dm` and `group`:

The **server** agent's file tools deny the content of sensitive paths: `/var/www`, any `.git`/`.local.git`, `.secrets`, `.env`, `.ssh`, `/etc/shadow`, nginx htpasswd, Let's Encrypt, `/etc/neptunia`, `/srv/neptunia-backups`, `config.local.json` and `config.local/`, the persona's own `data/`, and any `.agents/scratch`. The `bash` tool denies content commands on the same paths. Listing names (`ls`, `find`, `stat`, `du`) is still allowed. The refusal happens per step: OpenCode refuses that one tool call, the agent sees it and continues, and the result's `withheld` field lists the paths it was refused.

Every result the runner returns passes a redaction pass that replaces key-looking strings, private-key blocks, SSH key material and URL credentials with `[redacted]`.

A command that reaches a withheld path despite these rules (a pipe into a reader, for example) is caught after the fact: the runner drops that output and adds the path to the result's `withheld`. The agent has seen the output, so the final redaction pass is the last line of defense.

### Systemd isolation

The **scout** service has network access to the public internet. Egress to localhost and private ranges is refused by `IPAddressDeny` in the unit and in code. The filesystem is read-only except its state directory. Paths to the bot's data, `.env`, `/var/www`, nginx and Let's Encrypt configs are inaccessible.

The **server** service has network access only to the local DNS resolver and the model API (Cloudflare's ranges, where OpenRouter sits). It has `CAP_DAC_READ_SEARCH`, so it can read any file without being root. The whole system is read-only except its state directory and a private `/tmp`.

Neither shell runs an interpreter or command runner (`python`, `node`, `perl`, `sh -c`, `bash -c`, `eval`, `xargs`, `env`). Neither shell can read its own environment (where the agent's API key lives): `echo` with any `$` is refused, and `jq` naming `env` or `$ENV` is refused.

## What the persona sees

### `<errands>` block

While she has an open task or a finished one she has not read, the tail of every request includes an `<errands>` block. Each task is one line: the id, the agent, the state, the age in minutes, and the goal cut to 120 characters. Open tasks come first, then unread finished ones (oldest first, at most `errands.unreadShown`, the rest counted). The task of an `<errand_result>` turn is not listed again. A private chat's tasks show only in that chat.

### `<errand_result>` block

When a task finishes, the persona gets her own turn in the conversation it was asked in, replying to the message that started it. The turn follows the same attention as every other turn and observes `errands.resultCooldownSeconds` (default 60) between two such turns in one conversation. The block carries the id, agent, goal, state, the result text cut to `errands.resultMaxChars` (default 3000), the sources as a numbered list, each file as a handle, and (when the runner withheld paths) a line naming them.

When the result turn fails (`error`, `refused`), it is retried every `errands.resultRetrySeconds` (default 30), at most 20 times. After that, the task stays unread in `<errands>` with a note that the turn never ran. A restart re-opens result turns for finished tasks still unread.

### File handles

A task's saved files are named `file:<task id>/<name>`. The persona uses this handle as the `file` argument of `message.create` to attach the file. A handle for a file she does not own (or a private chat's file outside that chat) is refused `unknown-file`. A file whose task directory the runner has cleaned up is refused `file-expired`. The runner removes directories older than `errands.keepFilesHours` (default 24).

## Where errands are kept

Each errand is a task of the task board's errand lane in `memory.db` (`src/board/errands.ts` and `src/board/archive.ts`). The task keeps the errand's id, its agent as `role`, its goal as `title`, and `persona` as requester and subscriber. Its status follows the errand: `queued` is `approved`, `running` is `in_progress`, and `done`, `failed` and `cancelled` keep their names. The errand's error is the task's `close_reason` and its result text the task's `handoff` result. Every other field of the errand sits in the task's `metadata`, with the guild it belongs to. The errand store (`src/errands/store.ts`) loads every errand of its guild from the board when it is created and keeps the open errands and the latest 50 finished ones in memory.

Every change of an errand is one write of the whole errand through the memory writer, as the board principal `core`. Writes of one errand that wait together go out as the latest of them, and a write that fails is sent again at the next change or flush. At shutdown the writes that still fail are kept in `memory-pending/` and replayed at the next start.

The end of an errand is one transaction of the writer: the move to `done`, `failed` or `cancelled`, the board's outbox row to `persona`, and the closing line of her journal. When any of the three fails, none of them is written. The core submits the end as an `errand.done` event with the id `errand-done:<errand id>` and marks the end delivered once the door took it (`markDelivered`). `pendingEnds` lists the ends the board holds that were never marked delivered, oldest first. An `errand.done` for an errand whose result she has read already opens no second result turn (`src/errands/turns.ts`).

Each journal line of an errand references its task through the `day` row's `work_id`, so her memory of the work leads to the task and its goal. The goal itself never enters the journal.

A principal whose only board role is `errand-runner` sees the errand tasks of its own name and nothing else: `task.list` leaves the others out, and `task.show` of any other task answers `not-found`.

Board version 3 moves the errands of the `work` table onto the board with their ids, and `tools/memory-db.mjs board verify-errands --db <file>` compares each archived errand with its task field by field (see [Memory](memory.md#the-task-boards-tables)).

## Task operations

These are her tools, closed until the owner grants them to her. A member asks her for them, and all of them require `features.memberCommands`. The owner's chat runs `errand.list`, `errand.status` and `errand.cancel` as `/errands`.

| Operation | What it does |
|---|---|
| `errand.run` | Queues a new errand. Arguments: `agent`, `goal`. Any member may ask for `scout`; only an owner may ask for `server`. |
| `errand.status` | Without an id: lists the open tasks and the finished ones not yet read. With an id: one task's details and usage. |
| `errand.list` | The latest 10 tasks, newest first. |
| `errand.read` | The whole result in pages of `errands.resultMaxChars`. Marks the task read when the last page is returned. Arguments: `id`, optional `from`. |
| `errand.cancel` | Cancels an open task. Only the requester of the task or an owner may cancel it. |
| `errand.resolve` | Closes a finished task and marks it read. |

## Failures

A task that cannot be queued gets a refusal code: `cap-open` (too many open), `cap-tasks` (daily cap reached), `not-configured` (the agent's runner is not set up), `runner-down` (the runner is unreachable), `unknown-agent`, `bad-goal`.

A running task can fail with the runner's error code. A task left open by a restart of the core fails with `restarted`. A cancelled task gets no result turn.

## Costs

The status card (`/status full`) shows errand agents' models in `models.errands` and their spend in `costs.errands`: runs queued today, the last 7 and the last 30 UTC days, input and output tokens, and the estimated dollars. The dollars are OpenCode's step-cost estimate (priced by the profile's `cost`, overridable under `agents.<profile>.cost`), not OpenRouter's billed figure. The spending limit is the credit limit on the runner's OpenRouter key.

## Adding an agent

1. Create `agents/<id>/` with a `profile.json` and, for a worker, a `prompt.md`.
2. If it needs a new model role, add it to `src/llm/roles.js` and to `models.errands` in `config/config.json`.
3. For a worker: fill in the profile's `enabled`, `cost`, `limits`, `daily`, `socket` and `out`, add a systemd unit like `deploy/neptunia-agent-scout.service`, and the agent's name in `TASK_AGENTS` (`src/tools/impl/catalog.ts`) and who may ask for it in `src/tools/impl/errand.ts`.
4. If no existing shell class fits, that is a code change in `src/agent-runner/profiles.js`.
5. Run `tests/agent-runner-profiles.test.js`.
