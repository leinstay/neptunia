# agents/

This folder lists the engine's agents: helpers the persona or the tools can hand a job to. Each agent has one folder
named after it:

```
agents/
  web/       prompt.md + profile.json   worker: internet errands (search, read pages, download files)
  server/    prompt.md + profile.json   worker: read-only questions about this machine
  advice/    profile.json               consultation: the strongest model, asked directly by tools outside the bot
```

- `prompt.md` is the agent's system prompt. A deployment can replace it with its own file under `prompts.local/`
  (the name in `override`, for example `prompts.local/agent-web.md`); the private file wins when it exists.
- `profile.json` describes the agent. The agent runner (`src/agent-runner/profiles.js`) reads it at start; the bot
  reads it too for the defaults it needs.

There are two kinds of agent. A **worker** runs as its own process (`bin/agent-runner.mjs --profile <id>`) and
takes tasks on a socket. A **consultation** has no process: tools call its model role directly. The runner skips
consultations.

Full details: [`docs/en/agents.md`](../docs/en/agents.md).

## The keys of `profile.json`

Every key is required. A key that is missing, or one not in this list, stops the runner at start with an error naming
the agent and the key.

| Key | What it is |
|---|---|
| `id` | the folder name |
| `kind` | `worker` or `consultation` |
| `role` | the model role it runs on, from `src/llm/roles.js` (`agent.web`) |
| `prompt` | the prompt file in this folder (`prompt.md`), or `null` for a consultation without one |
| `override` | the file name a deployment may put under `prompts.local/` to replace the prompt, or `null` with no prompt |
| `description` | one sentence: what the agent does |
| `tools` | worker only: the OpenCode tools it asks for, never more than its shell class allows |
| `shell` | worker only: the name of a shell class defined in the code (`server-read-only`, `web-download`) |
| `limits` | worker only: default per-task caps `{ steps, usd, seconds }` (config: `agents.<id>.limits`) |
| `daily` | worker only: default per-day caps `{ tasks, usd }` (config: `agents.<id>.daily`) |
| `searchProvider` | worker only: default web search provider (`exa`), or `null` |
| `socket`, `out` | worker only: default socket path and output folder (config: `agents.<id>.socket`, `.out`) |
| `env` | worker only: environment variable names the runner falls back on when a task brings no key |

## What is never in a profile

A profile describes what an agent asks for; it never grants anything. These stay in the code
(`src/agent-runner/profiles.js`, `src/agent-runner/policy.js`) and no profile key can change them:

- the permission ceiling: which tools a shell class may grant and which shell commands it allows;
- the shell deny patterns, and the tools denied to every agent (`edit`, `write`, `patch`, `task`, `question`,
  `external_directory`);
- the scope filters, the withheld paths and the redaction of results;
- any command to run, and any path outside this folder (`socket` and `out` are only defaults the config overrides).

A profile can only narrow: a tool it leaves out is denied. A tool its shell class does not allow, or a shell class
the code does not define, is refused at start.

## Adding an agent

1. Create `agents/<id>/` with a `profile.json` (copy one of the existing ones) and, for a worker, a `prompt.md`.
2. If it needs a model role that does not exist yet, add it to `src/llm/roles.js`.
3. For a worker: add an `agents.<id>` block to `config.json`, a systemd unit like
   `deploy/neptunia-agent-web.service`, and, for the persona to reach it, its name in `TASK_AGENTS`
   (`src/discord/commands.js`) and who may ask for it in `src/ops/task.js`.
4. If no existing shell class fits, that is a code change in `src/agent-runner/profiles.js`, never a profile key.
5. Run `tests/agent-runner-profiles.test.js`.
