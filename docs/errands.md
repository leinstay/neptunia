# Errands

The persona can hand a goal to an errand agent with `errand.run`. She writes the goal in her own words, says so in the conversation, and the turn ends. The errand runs in the background as a separate process. When it finishes, its result comes back as a turn of hers in the conversation that started it, with any files posted where she asks.

## Errand agents

Two errand agents ship with the engine. Each is a worker: a standalone process driven by the agent runner (`src/agent-runner/`), connected to the core over a Unix socket. A worker runs on the backend of the [subharness](#the-subharness). The shell and tool lists below, and the permission map of [Sandbox users and the policy](#sandbox-users-and-the-policy), are the profile's definition of what the agent is meant to do (`buildConfig` in `src/agent-runner/profiles.ts`). No backend reads them: `opencode` runs through the plain `opencode run` command like the other two, and the mode of the agent and the systemd unit are what bound it.

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

## The subharness

The subharness is the set of agent backends of the deployment. Errands (scout and server), development and the watcher all run through it, and it is off in a fresh install. `subharness.backends` of `keys.json` lists the connected backends in the order they were connected, none, one or several of `codex`, `claude` and `opencode`. An agent runs through the backend `subharness.uses.<agent>` names, else through the first connected one. The watcher step of `neptunia setup` writes `uses.watcher`. The owner connects and disconnects backends from the chat or in the subharness step of `neptunia setup` ([Setup](setup.md)), and the state lives in the `subharness` section of `keys.json` (`src/subharness/control.ts`), read again at each run, so a change needs no restart. A store written with the single `subharness.backend` reads as a list of that one, and the next write leaves only the list.

| Command | What it does |
|---|---|
| `/subharness enable codex` or `claude` | Checks that the binary installed in the private layer runs and answers one word, then adds the backend to the list. The backends connected before stay. Fails with `not-installed`, `binary-missing` or `no-reply`. |
| `/subharness enable opencode --key <name>` | Checks that the extra key answers `/auth/key`, then adds opencode to the list and stores the key's name. The one key OpenCode ever gets. Fails with `not-installed`, `key-needed`, `key-unknown`, `key-rejected` or `key-unreachable`. |
| `/subharness model <agent> <model>` | Sets the model of one agent after one reply from it, through the agent's backend. |
| `/subharness disable <backend>` | Removes one backend from the list. Removing opencode clears its key's name, removing the last one turns the subharness off, and the modes stay. A backend that is not connected changes nothing, and a name that is no backend is `unknown-backend`. |
| `/subharness status` | Every connected backend with opencode's key name and who holds the sandbox under it, and the mode of every agent. |

Each backend lives in `<private>/subharness/<backend>/` with its binary and its home (`src/subharness/place.ts`), and a run never looks for a backend on `PATH`, so the installing user's own CLIs and their logins are never the persona's. `neptunia setup subharness codex` or `claude` runs `npm install --prefix` of `@openai/codex` or `@anthropic-ai/claude-code` into that folder (`src/subharness/install.ts`), with `PATH`, `HOME`, `TMPDIR` and the locale as npm's whole environment. `neptunia setup subharness opencode` copies one executable there, the one `--from <path>` names or else `errands.opencodePath` (default `/opt/opencode/bin/opencode`). A backend that is there already is left as it is.

The home is the variable each CLI reads it from: `CODEX_HOME` for `codex`, `CLAUDE_CONFIG_DIR` for `claude`, and `XDG_CONFIG_HOME` and `XDG_DATA_HOME` for OpenCode, each a folder under `<private>/subharness/<backend>/home`. After installing `codex` or `claude`, setup prints the login line for the owner to type at the terminal, the home set before the binary: `codex login --device-auth`, and `claude login`, or `claude auth login` when the installed binary's `--help` lists `auth` and no `login`. OpenCode takes a key instead of a login.

After the check, `enable` asks which model each of the four agents runs on. The list is OpenRouter's `/models` on the named key for `opencode`, and the names `codex exec -m` and `claude -p --model` accept for the other two (`FIXED_MODELS` in `src/subharness/models.ts`), and any other name may be typed. Each answer gets one reply check, a model that fails is asked again, and nothing is stored until the fourth answer. The models go into `subharness.models` of `keys.json`, and the runner passes each agent's model flag at its next run. An agent with no stored model runs on the backend's own default. A failed check stores nothing and keeps the backends connected before. `codex` and `claude` bring their own login and take no key (`key-not-allowed`). While no backend is connected, every agent task fails with `subharness-off`. So does the task of an agent whose named backend is not connected, which never falls back to another backend, and a task of an OpenCode that runs on a key that has left the store.

`src/subharness/run.ts` is the one seam. `runAgent` reads `keys.json`, picks the agent's backend, looks up the agent's mode, and starts the backend installed in the private layer (`createInstalledBackend` in `src/agent-runner/backend.ts`) with the matching sandbox and the backend's home laid over its environment. `codex` starts `codex exec`, `claude` starts `claude -p`, and `opencode` starts `opencode run`, which gets the named extra key as `OPENROUTER_API_KEY` and nothing else key-like. The brief goes on stdin where the backend reads it there, and the agent works in the task's own folder under the out directory. The final message is read from the file `-o` names for `codex`, and the token count from its `tokens used` line. A task's `secrets` are not passed on.

The child's environment is `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL` and `LC_CTYPE`, plus what the seam adds, and nothing else from the runner's. The child starts as its own process group. When the seconds cap passes (the task's `limits.seconds`, else the profile's), the whole group gets SIGTERM and, five seconds later, SIGKILL, and the task fails with `time-cap`. A backend that is not in its folder fails the task with `not-installed` and nothing starts, a binary that cannot start fails it with `backend-missing`, and a blank brief with `empty-brief`.

Every run logs one `agent-runner: backend run` line with `backend`, `exitCode`, `durationMs`, `tokens` when known and `error` when set. It never holds the brief or the text.

### Modes

Each agent has a mode, set with `/subharness mode <agent> <mode>`. Only the owner's chat changes a mode, never an agent whatever its report asks. The agents are `scout`, `server`, `dev` and `watcher`, and an agent with no mode set runs in its default. An agent the table does not list runs in `read`.

| Mode | The agent may | Codex flags | Default for |
|---|---|---|---|
| `read` | read and run commands that write nothing | `-s read-only` | `server`, `watcher` |
| `write` | write in its working directory | `-s workspace-write` | `scout`, `dev` |
| `full` | write anywhere, no sandbox | `--dangerously-bypass-approvals-and-sandbox` | nobody |
| `sudo` | as `full`, and `sudo` is not stripped from its environment | the same flag | nobody |

In `read`, `write` and `full` the child's `PATH` starts with a folder whose `sudo` is a stand-in that prints one line and exits non-zero. The seam writes it into a folder of its own in the temporary directory. In `sudo` the host `PATH` passes as it is. A run in `full` or `sudo` writes one `subharness: run without a sandbox` line with the agent and the mode before it starts, never the brief.

`claude` has no sandbox flags and OpenCode has no sandbox of its own. Under them `read` and `write` are held by the systemd unit alone, and `/subharness status` says so in one line. The unit of an agent follows its mode: see [the sandbox of an agent unit](../deploy/README.md#the-sandbox-of-an-agent-unit).

## How a task runs

### Enabling a worker

Both workers are disabled by default (`enabled: false` in the profile, `agents/<name>/profile.json`). A deployment enables them with `agents.<profile>.enabled: true` in `config.local/config.json`, turns the [subharness](#the-subharness) on and starts their systemd services.

### Queuing

`errand.run` accepts `agent` (one of `scout`, `server`) and `goal`. The errand service (`src/errands/service.ts`) queues the task in the guild's store, a task of the board's errand lane in `memory.db` (see [Where errands are kept](#where-errands-are-kept)), and answers at once with the id and `queued`. Nobody waits for the errand.

An idempotency key ties the task to the turn and the call's index within it: the same call made twice returns the task already queued, never a second errand.

Caps enforced at queuing:
- `errands.maxOpen` (default 3): open tasks across all agents.
- `daily.tasks` of the profile (default 40 for scout and server, overridable under `agents.<profile>.daily.tasks`): tasks per UTC day per agent. A task counts on the day it was queued.

### The runner

Each worker runs as a systemd service (`deploy/neptunia-agent-scout.service`, `deploy/neptunia-agent-server.service`), as the user that installed the engine, so the core reaches the socket. The service starts `neptunia errand-runner --profile <name>` (see [The neptunia command](cli.md#the-errand-runner)). The runner listens on a Unix socket (the profile's `socket`, overridable under `agents.<profile>.socket`); the core connects and sends tasks as JSON, one object per line.

One task is one run of the subharness's backend in a fresh working directory under the profile's output folder: the profile's prompt, the preamble, the goal and the context make the brief, and the files the agent leaves there are the result's files.

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

Both services see the home of `neptunia` as an empty tmpfs with `~/.local` read-only. The folder of every backend connected in `keys.json`, `<private>/subharness/<backend>/` with its sessions, logs and login, is bound writable into both, and nothing else of the private layer is. `neptunia setup units` renders those binds from the stored list, so it runs again after `/subharness enable` connects another backend. Codex sandboxes its own commands with bubblewrap, which works under `NoNewPrivileges`, `ProtectSystem=strict` and `PrivateTmp`.

The **scout** service has network access to the public internet. Egress to localhost and private ranges is refused by `IPAddressDeny` in the unit and in code. The filesystem is read-only except its state directory and the backend's folder. Paths to the bot's data, `.env`, `/var/www`, nginx and Let's Encrypt configs are inaccessible.

The **server** service has network access only to the local DNS resolver and the model API (Cloudflare's ranges, where OpenRouter, `chatgpt.com`, `api.openai.com` and `auth.openai.com` sit). Its capability bounding set is `CAP_DAC_READ_SEARCH` and it holds no ambient capability, because bubblewrap refuses to start with one, so it reads what the user `neptunia` can read. `AF_NETLINK` is allowed beside the IP families because bubblewrap opens a netlink socket for loopback. The whole system is read-only except its state directory, the backend's folder and a private `/tmp`.

Neither shell runs an interpreter or command runner (`python`, `node`, `perl`, `sh -c`, `bash -c`, `eval`, `xargs`, `env`). Neither shell can read its own environment (where the agent's API key lives): `echo` with any `$` is refused, and `jq` naming `env` or `$ENV` is refused.

## What the persona sees

### `<errands>` block

While she has an open task or a finished one she has not read, the tail of every request includes an `<errands>` block. Each task is one line: the id, the agent, the state, the age in minutes, and the goal cut to 120 characters. Open tasks come first, then unread finished ones (oldest first, at most five by `DEFAULT_UNREAD_SHOWN` of `src/errands/blocks.ts`, the rest counted). The task of an `<errand_result>` turn is not listed again. A private chat's tasks show only in that chat.

### `<errand_result>` block

When a task finishes, the persona gets her own turn in the conversation it was asked in, replying to the message that started it. The turn follows the same attention as every other turn and waits at least `DEFAULT_COOLDOWN_SECONDS` (60) of `src/errands/turns.ts` between two such turns in one conversation. The block carries the id, agent, goal, state, the result text cut to `errands.resultMaxChars` (default 3000), the sources as a numbered list, each file as a handle, and (when the runner withheld paths) a line naming them.

When the result turn fails (`error`, `refused`), it is retried every `errands.resultRetrySeconds` (default 30), at most 20 times. After that, the task stays unread in `<errands>` with a note that the turn never ran. A restart re-opens result turns for finished tasks still unread.

### File handles

A task's saved files are named `file:<task id>/<name>`. The persona uses this handle as the `file` argument of `message.create` to attach the file. A handle for a file she does not own (or a private chat's file outside that chat) is refused `unknown-file`. A file whose task directory the runner has cleaned up is refused `file-expired`. The runner removes directories older than `errands.keepFilesHours` (default 24).

## Where errands are kept

Each errand is a task of the task board's errand lane in `memory.db` (`src/board/errands.ts` and `src/board/archive.ts`). The task keeps the errand's id, its agent as `role`, its goal as `title`, and `persona` as requester and subscriber. Its status follows the errand: `queued` is `approved`, `running` is `in_progress`, and `done`, `failed` and `cancelled` keep their names. The errand's error is the task's `close_reason` and its result text the task's `handoff` result. Every other field of the errand sits in the task's `metadata`, with the guild it belongs to. The errand store (`src/errands/store.ts`) loads every errand of its guild from the board when it is created and keeps the open errands and the latest 50 finished ones in memory.

Every change of an errand is one write of the whole errand through the memory writer, as the board principal `core`. Writes of one errand that wait together go out as the latest of them, and a write that fails is sent again at the next change or flush. At shutdown the writes that still fail are kept in `memory-pending/` and replayed at the next start.

The end of an errand is one transaction of the writer: the move to `done`, `failed` or `cancelled`, the board's outbox row to `persona`, and the closing line of her journal. When any of the three fails, none of them is written. The core submits the end as an `errand.done` event with the id `errand-done:<errand id>` and marks the end delivered once the door took it (`markDelivered`). `pendingEnds` lists the ends the board holds that were never marked delivered, oldest first. An `errand.done` for an errand whose result she has read already opens no second result turn (`src/errands/turns.ts`).

Each journal line of an errand references its task through the `day` row's `work_id`, so her memory of the work leads to the task and its goal. The goal itself never enters the journal.

A principal whose only board role is `errand-runner` sees the errand tasks of its own name and nothing else: `task.list` leaves the others out, and `task.show` of any other task answers `not-found`.

Board version 3 moves the errands of the `work` table onto the board with their ids, and `scripts/memory-db.ts board verify-errands --db <file>` compares each archived errand with its task field by field (see [Memory](memory.md#the-task-boards-tables)).

## Task operations

These are her tools, closed until the owner grants them to her. A member asks her for them. The owner's chat runs `errand.list`, `errand.status` and `errand.cancel` as `/errands`.

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
2. If it needs a new model role, add it to `src/llm/roles.ts` and to `models.errands` in `config/config.json`.
3. For a worker: fill in the profile's `enabled`, `cost`, `limits`, `daily`, `socket` and `out`, add a systemd unit like `deploy/neptunia-agent-scout.service`, and the agent's name in `TASK_AGENTS` (`src/tools/impl/catalog.ts`) and who may ask for it in `src/tools/impl/errand.ts`.
4. If no existing shell class fits, that is a code change in `src/agent-runner/profiles.ts`.
5. Run `tests/agent-runner-profiles.test.ts`.
