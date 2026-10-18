# agents/

Each agent has its own folder here. A folder holds `profile.json` (the agent's description) and, for a worker, `prompt.md` (its system prompt).

```
agents/
  web/       prompt.md + profile.json   worker: internet errands (search, read pages, download files)
  server/    prompt.md + profile.json   worker: read-only questions about this machine
```

There are two kinds. A worker runs as its own process and takes tasks on a socket. A consultation has no process: tools call its model role directly. The runner skips consultations.

A deployment can replace a worker's prompt with its own file under `prompts.local/` (the name in `override`, for example `prompts.local/agent-web.md`); the private file wins when it exists. The agent runner (`src/agent-runner/profiles.js`) reads these folders at start; the bot reads them too for the defaults it needs.

For the profile keys, the security model, the protocol and how to add an agent, see [`docs/agents.md`](../docs/agents.md).
